import { randomBytes } from 'node:crypto';
import type { AuthenticatedPrincipal, OboTokenClient } from '@genai/auth';
import {
  BLOCKED_ANSWER,
  type GuardrailMode,
  type Guardrails,
  type OutputReport,
  type QuestionReport,
  type SourcesReport,
} from '@genai/guardrails';
import { DownstreamError } from '@genai/shared';
import { Logger } from '@nestjs/common';
import type { AssistantConfig } from '../config/config';
import type {
  GatewayClient,
  PromptClient,
  RetrievalClient,
  SearchRequest,
} from '../clients/service-clients';
import type { CacheLayer } from '../cache/cache-layer';
import { normalize } from '../cache/question-features';
import { checkCitations, type Citation } from './citations';
import { GuardrailBlockedError } from './errors';
import { BUILTIN_PROMPT_TEMPLATE, fillTemplate } from './prompt';
import { formatSources, toSources } from './sources';

export interface AskInput {
  question: string;
  /** Ask for a freshly generated answer, skipping the answer cache. */
  noCache?: boolean;
  topK?: number;
  filter?: SearchRequest['filter'];
}

export interface PromptInfo {
  name: string;
  /** Registry version number, or "builtin" when the default template was used. */
  version: number | 'builtin';
  source: 'registry' | 'builtin';
}

/** What the guardrails saw and did. Kinds, counts and signal names only, never the text itself. */
export interface GuardrailsReport {
  mode: GuardrailMode;
  question: QuestionReport;
  sources: SourcesReport;
  /** Absent when no answer was generated (nothing permitted to retrieve). */
  output?: OutputReport;
}

/** What the answer cache did for this request. */
export interface CacheInfo {
  status: 'hit' | 'miss' | 'bypass' | 'shadow';
  /** For a hit: an exact repeat of an earlier question, or a close one. */
  kind?: 'exact' | 'semantic';
  similarity?: number;
  /** Shadow mode only: a cached answer existed, and whether it matched the fresh one. */
  wouldHit?: boolean;
  agreed?: boolean;
  /** For a hit: the model call this saved. */
  savedTokens?: number;
  savedMicroUsd?: number;
}

/** Where the time went, in milliseconds. `modelMs` is absent when no model was called. */
export interface Timings {
  totalMs: number;
  retrievalMs: number;
  modelMs?: number;
}

export interface AskResult {
  requestId: string;
  answer: string;
  citations: Citation[];
  /** True only when the answer carries at least one citation that maps to a retrieved source. */
  grounded: boolean;
  sourcesRetrieved: number;
  /** Citation markers the model produced that matched no retrieved source (removed from the answer). */
  droppedCitations: number[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: { provider: string; fallbackUsed: boolean };
  prompt?: PromptInfo;
  guardrails: GuardrailsReport;
  /** Absent when the answer cache is off. */
  cache?: CacheInfo;
  timings: Timings;
}

export const NO_SOURCES_ANSWER =
  'I could not find anything about that in the documents available to you.';

type Clients = {
  retrieval: RetrievalClient;
  prompts: PromptClient;
  gateway: GatewayClient;
  obo: OboTokenClient;
};

/**
 * Answers a question **as the calling user**, in four steps (with guardrails at each boundary where
 * untrusted text crosses: the question in, the documents in, the answer out):
 *
 *  1. Retrieve: exchange the user's token for a retrieval token (on-behalf-of) and search. Access
 *     trimming happens there, by the user's tenant and roles, so only permitted chunks come back.
 *  2. Prompt: resolve the tenant's prompt from the registry (or use the built-in default).
 *  3. Generate: call the LLM gateway, again as the user, for limits, retries and fallback.
 *  4. Verify: keep only citations that point at chunks that were really retrieved.
 *
 * Guardrails: a question that looks like an attack is refused and sensitive data in it is masked
 * before it reaches search or the model; a retrieved passage that reads like an instruction is
 * quarantined (a document has no authority to instruct the assistant); a per-request canary in the
 * confidential prompt exposes a model that repeats its instructions; and the answer is redacted
 * and stripped of image/HTML exfiltration before the user sees it.
 *
 * If nothing is retrieved the model is never called: it cannot hallucinate from nothing, the call
 * costs nothing, and the reply does not reveal whether a restricted document exists.
 */
export class AskService {
  private readonly logger = new Logger(AskService.name);

  constructor(
    private readonly clients: Clients,
    private readonly config: Pick<
      AssistantConfig,
      'gateway' | 'prompts' | 'retrieval' | 'promptName' | 'defaultTopK'
    >,
    private readonly guardrails: Guardrails,
    private readonly cache?: CacheLayer,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  async ask(
    caller: AuthenticatedPrincipal,
    input: AskInput,
    requestId: string,
  ): Promise<AskResult> {
    const { retrieval, gateway, obo } = this.clients;
    const guardrails = this.guardrails;
    const startedAt = this.clock();

    // 1. The question in: refuse an attack, mask sensitive data before it travels any further.
    const question = guardrails.checkQuestion(input.question);
    if (question.blocked) throw new GuardrailBlockedError(question.report);

    const hits = await retrieval.search(
      await obo.exchange(caller.accessToken, this.config.retrieval.scope),
      {
        query: question.text,
        topK: input.topK ?? this.config.defaultTopK,
        ...(input.filter && { filter: input.filter }),
      },
      requestId,
    );
    const retrievalMs = this.clock() - startedAt;

    // 2. The documents in: a passage that reads like an instruction never reaches the prompt.
    const screened = guardrails.screenSources(hits);
    const sources = toSources(screened.kept);

    if (sources.length === 0) {
      return {
        requestId,
        answer: NO_SOURCES_ANSWER,
        citations: [],
        grounded: false,
        sourcesRetrieved: 0,
        droppedCitations: [],
        guardrails: { mode: guardrails.mode, question: question.report, sources: screened.report },
        timings: { totalMs: this.clock() - startedAt, retrievalMs },
      };
    }

    const sourcesText = formatSources(sources);
    const { rendered, info } = await this.resolvePrompt(
      caller,
      { sources: sourcesText, question: question.text },
      requestId,
    );

    // The answer cache. The scope is built from what THIS user's retrieval just returned, so an
    // answer made from documents one user can read can never be offered to someone who cannot.
    const cacheScope =
      this.cache && this.cache.mode !== 'off' && !input.noCache
        ? this.cache.scope(caller.tenantId, sources, info, guardrails.mode)
        : undefined;
    if (this.cache && this.cache.mode !== 'off' && !cacheScope) {
      this.cache.stats.record(caller.tenantId, { type: 'bypass' });
    }
    const cached = cacheScope ? this.cache?.lookup(cacheScope, question.text) : undefined;

    if (this.cache && cacheScope && cached && this.cache.mode === 'serve') {
      const { tokens, costMicroUsd } = cached.answer;
      this.cache.stats.record(caller.tenantId, {
        type: 'hit',
        kind: cached.kind,
        savedTokens: tokens,
        savedMicroUsd: costMicroUsd,
      });
      return {
        requestId,
        answer: cached.answer.answer,
        citations: cached.answer.citations,
        grounded: true,
        sourcesRetrieved: sources.length,
        droppedCitations: [],
        prompt: info,
        guardrails: { mode: guardrails.mode, question: question.report, sources: screened.report },
        cache: {
          status: 'hit',
          kind: cached.kind,
          similarity: cached.similarity,
          savedTokens: tokens,
          savedMicroUsd: costMicroUsd,
        },
        timings: { totalMs: this.clock() - startedAt, retrievalMs },
      };
    }

    // A random marker in the confidential part of the prompt: it has no reason to ever appear in an
    // answer, so seeing it proves the model repeated its hidden instructions.
    const canary = `cnry-${randomBytes(8).toString('hex')}`;
    const system = `${rendered}\n\nConfidential marker (never output it): ${canary}`;

    const modelStartedAt = this.clock();
    const completion = await gateway.chat(
      await obo.exchange(caller.accessToken, this.config.gateway.scope),
      [
        { role: 'system', content: system },
        { role: 'user', content: question.text },
      ],
      requestId,
    );

    const modelMs = this.clock() - modelStartedAt;

    // 3. The answer out: block a leak, redact sensitive data, strip image and HTML exfiltration.
    const instructionText = rendered.split(sourcesText).join('').split(question.text).join('');
    const output = guardrails.checkOutput(completion.message.content, {
      canary,
      instructionText: `${instructionText}\n${system.slice(rendered.length)}`,
    });

    const timings = (): Timings => ({
      totalMs: this.clock() - startedAt,
      retrievalMs,
      modelMs,
    });
    const common = {
      requestId,
      sourcesRetrieved: sources.length,
      usage: completion.usage,
      model: { provider: completion.provider, fallbackUsed: completion.fallbackUsed },
      prompt: info,
      guardrails: {
        mode: guardrails.mode,
        question: question.report,
        sources: screened.report,
        output: output.report,
      },
    };

    if (output.blocked) {
      return {
        ...common,
        answer: BLOCKED_ANSWER,
        citations: [],
        grounded: false,
        droppedCitations: [],
        ...this.afterGeneration(caller.tenantId, cacheScope, question.text, cached, {
          answer: BLOCKED_ANSWER,
          citations: [],
          cacheable: false,
          tokens: completion.usage.totalTokens,
          costMicroUsd: completion.cost?.microUsd ?? 0,
        }),
        timings: timings(),
      };
    }

    const checked = checkCitations(output.text, sources);
    const citations = checked.citations.map((c) => ({
      ...c,
      excerpt: guardrails.redactForOutput(c.excerpt),
    }));
    const grounded = checked.citations.length > 0;

    return {
      ...common,
      answer: checked.answer,
      citations,
      grounded,
      droppedCitations: checked.droppedMarkers,
      ...this.afterGeneration(caller.tenantId, cacheScope, question.text, cached, {
        answer: checked.answer,
        citations,
        // Only a clean, grounded answer is worth keeping: nothing blocked, nothing invented.
        cacheable:
          grounded &&
          checked.droppedMarkers.length === 0 &&
          !output.report.wouldBlock &&
          !output.blocked,
        tokens: completion.usage.totalTokens,
        costMicroUsd: completion.cost?.microUsd ?? 0,
      }),
      timings: timings(),
    };
  }

  /**
   * After a fresh answer exists: keep it for next time, and in shadow mode record whether the
   * cached one (had it been served) would have matched.
   */
  private afterGeneration(
    tenantId: string,
    scope: ReturnType<CacheLayer['scope']> | undefined,
    question: string,
    cached: ReturnType<CacheLayer['lookup']>,
    fresh: {
      answer: string;
      citations: Citation[];
      cacheable: boolean;
      tokens: number;
      costMicroUsd: number;
    },
  ): { cache?: CacheInfo } {
    const layer = this.cache;
    if (!layer || layer.mode === 'off') return {};
    if (!scope) return { cache: { status: 'bypass' } };

    if (fresh.cacheable) {
      layer.store(scope, question, {
        answer: fresh.answer,
        citations: fresh.citations,
        tokens: fresh.tokens,
        costMicroUsd: fresh.costMicroUsd,
      });
    }

    if (layer.mode === 'shadow') {
      const agreed =
        cached !== undefined && normalize(cached.answer.answer) === normalize(fresh.answer);
      layer.stats.record(tenantId, {
        type: 'shadow',
        wouldHit: cached !== undefined,
        ...(cached && {
          agreed,
          potentialSavedTokens: cached.answer.tokens,
          potentialSavedMicroUsd: cached.answer.costMicroUsd,
        }),
      });
      return {
        cache: {
          status: 'shadow',
          wouldHit: cached !== undefined,
          ...(cached && { kind: cached.kind, similarity: cached.similarity, agreed }),
        },
      };
    }

    layer.stats.record(tenantId, { type: 'miss' });
    return { cache: { status: 'miss' } };
  }

  /**
   * Prompts are configuration, not a hard dependency: if the tenant has not published one, or the
   * registry is down, the built-in default keeps the assistant answering.
   */
  private async resolvePrompt(
    caller: AuthenticatedPrincipal,
    variables: { sources: string; question: string },
    requestId: string,
  ): Promise<{ rendered: string; info: PromptInfo }> {
    const name = this.config.promptName;
    try {
      const token = await this.clients.obo.exchange(caller.accessToken, this.config.prompts.scope);
      const resolved = await this.clients.prompts.resolve(
        token,
        name,
        { variables, subjectKey: caller.userId },
        requestId,
      );
      return {
        rendered: resolved.rendered,
        info: { name, version: resolved.version, source: 'registry' },
      };
    } catch (error) {
      const notPublished =
        error instanceof DownstreamError && error.kind === 'http' && error.status === 404;
      if (!notPublished) {
        this.logger.warn(
          `prompt registry unavailable, using the built-in prompt: ${describe(error)}`,
        );
      }
      return {
        rendered: fillTemplate(BUILTIN_PROMPT_TEMPLATE, variables),
        info: { name, version: 'builtin', source: 'builtin' },
      };
    }
  }
}

/** Error text for logs that cannot contain a token: only our own error types are described. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
