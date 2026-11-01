import { randomBytes } from 'node:crypto';
import type { AuthenticatedPrincipal, OboTokenClient } from '@genai/auth';
import {
  BLOCKED_ANSWER,
  type GuardrailMode,
  type Guardrails,
  type OutputContext,
  type OutputReport,
  type QuestionReport,
  type SourcesReport,
} from '@genai/guardrails';
import { DownstreamError } from '@genai/shared';
import { Logger } from '@nestjs/common';
import type { AssistantConfig } from '../config/config';
import type {
  GatewayClient,
  GatewayStreamEvent,
  PromptClient,
  RetrievalClient,
  SearchRequest,
} from '../clients/service-clients';
import type { CacheLayer } from '../cache/cache-layer';
import { normalize } from '../cache/question-features';
import { checkCitations, type Citation } from './citations';
import { StreamGuard } from './stream-guard';
import { GuardrailBlockedError } from './errors';
import { BUILTIN_PROMPT_TEMPLATE, fillTemplate } from './prompt';
import { formatSources, toSources, type Source } from './sources';

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
  /** Streaming only: time until the first piece of the answer was sent to the caller. */
  firstTokenMs?: number;
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

/** What a streaming caller receives. The `done` event is authoritative; see `askStream`. */
export type AskStreamEvent =
  | {
      type: 'meta';
      requestId: string;
      sourcesRetrieved: number;
      prompt?: PromptInfo;
      cache?: CacheInfo;
    }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: AskResult; replace: boolean }
  | { type: 'error'; code: string };

/** Everything needed to generate an answer, once the question and documents have been checked. */
interface Prepared {
  caller: AuthenticatedPrincipal;
  requestId: string;
  startedAt: number;
  retrievalMs: number;
  question: { text: string; report: QuestionReport };
  sourcesReport: SourcesReport;
  sources: Source[];
  info: PromptInfo;
  messages: { role: 'system' | 'user'; content: string }[];
  outputContext: OutputContext;
  cacheScope?: ReturnType<CacheLayer['scope']>;
  cached?: ReturnType<CacheLayer['lookup']>;
}

/** What the model produced, however it was delivered. */
interface Completion {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  fallbackUsed: boolean;
  cost?: { microUsd: number; priced: boolean };
  modelMs: number;
  firstTokenMs?: number;
}

/** Milliseconds to one decimal place: precise enough to compare, short enough to read. */
const ms = (value: number): number => Math.round(value * 10) / 10;

/** When a stream ended without the gateway's own count: about four characters to a token. */
function estimateUsage(
  messages: readonly { content: string }[],
  answer: string,
): Completion['usage'] {
  const promptTokens = Math.max(1, Math.ceil(messages.map((m) => m.content).join(' ').length / 4));
  const completionTokens = Math.max(1, Math.ceil(answer.length / 4));
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
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
    > &
      Partial<Pick<AssistantConfig, 'streamHoldbackChars'>>,
    private readonly guardrails: Guardrails,
    private readonly cache?: CacheLayer,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.holdbackChars = config.streamHoldbackChars ?? 120;
  }

  private readonly holdbackChars: number;

  async ask(
    caller: AuthenticatedPrincipal,
    input: AskInput,
    requestId: string,
  ): Promise<AskResult> {
    const prepared = await this.prepare(caller, input, requestId);
    if ('early' in prepared) return prepared.early;
    const p = prepared.ready;

    const modelStartedAt = this.clock();
    const completion = await this.clients.gateway.chat(
      await this.clients.obo.exchange(caller.accessToken, this.config.gateway.scope),
      p.messages,
      requestId,
    );
    return this.finish(p, {
      text: completion.message.content,
      usage: completion.usage,
      provider: completion.provider,
      fallbackUsed: completion.fallbackUsed,
      ...(completion.cost && { cost: completion.cost }),
      modelMs: this.clock() - modelStartedAt,
    });
  }

  /**
   * The same answer, delivered while it is generated. Every check still applies: the question and
   * documents are checked before the model is called, and the answer passes through a StreamGuard
   * that holds the tail back and re-runs the output checks on everything received so far, so
   * nothing is sent that the finished answer's checks would have removed. The final `done` event
   * is the authoritative answer, with citations verified; `replace` says whether it differs from
   * the text that was streamed.
   *
   * Anything that can refuse the request (a guardrail, a limit, a dependency that is down) is
   * raised before the first event, so those still arrive as ordinary errors.
   */
  async *askStream(
    caller: AuthenticatedPrincipal,
    input: AskInput,
    requestId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AskStreamEvent, void, void> {
    const prepared = await this.prepare(caller, input, requestId);
    if ('early' in prepared) {
      const r = prepared.early;
      yield {
        type: 'meta',
        requestId,
        sourcesRetrieved: r.sourcesRetrieved,
        ...(r.prompt && { prompt: r.prompt }),
        ...(r.cache && { cache: r.cache }),
      };
      yield { type: 'done', result: r, replace: false };
      return;
    }
    const p = prepared.ready;

    // Hang up on the model as soon as we stop wanting its answer (a leak, or the client leaving).
    const upstream = new AbortController();
    const hangUp = () => upstream.abort();
    signal?.addEventListener('abort', hangUp, { once: true });

    const modelStartedAt = this.clock();
    const gatewayEvents = this.clients.gateway.chatStream(
      await this.clients.obo.exchange(caller.accessToken, this.config.gateway.scope),
      p.messages,
      requestId,
      upstream.signal,
    );

    try {
      // Waiting for the first event means a refusal (quota, outage) is still a normal error.
      let next = await gatewayEvents.next();
      yield {
        type: 'meta',
        requestId,
        sourcesRetrieved: p.sources.length,
        prompt: p.info,
        ...(p.cacheScope && this.cache ? { cache: { status: 'miss' as const } } : {}),
      };

      const guard = new StreamGuard(this.guardrails, p.outputContext, this.holdbackChars);
      let firstTokenMs: number | undefined;
      let blocked = false;
      let done: Extract<GatewayStreamEvent, { type: 'done' }> | undefined;
      let provider = 'unknown';
      let fallbackUsed = false;

      try {
        while (!next.done) {
          const event = next.value;
          if (event.type === 'delta') {
            provider = event.provider;
            fallbackUsed = event.fallbackUsed;
            const step = guard.push(event.text);
            if (step.blocked) {
              blocked = true;
              upstream.abort(); // stop generating, and paying for, an answer we will not send
              break;
            }
            if (step.release) {
              firstTokenMs ??= this.clock() - p.startedAt;
              yield { type: 'delta', text: step.release };
            }
          } else {
            done = event;
          }
          next = await gatewayEvents.next();
        }
      } catch (error) {
        if (signal?.aborted) return; // the client left: nothing to send
        yield { type: 'error', code: 'generation_failed' };
        this.logger.warn(`generation failed mid-stream: ${describe(error)}`);
        return;
      }

      if (signal?.aborted) return; // the client left while we were reading: send nothing more

      if (!blocked) {
        const tail = guard.finish();
        if (tail.blocked) blocked = true;
        else if (tail.release) {
          firstTokenMs ??= this.clock() - p.startedAt;
          yield { type: 'delta', text: tail.release };
        }
      }

      const result = this.finish(p, {
        text: guard.received,
        usage: done?.usage ?? estimateUsage(p.messages, guard.received),
        provider: done?.provider ?? provider,
        fallbackUsed: done?.fallbackUsed ?? fallbackUsed,
        ...(done?.cost && { cost: done.cost }),
        modelMs: this.clock() - modelStartedAt,
        ...(firstTokenMs !== undefined && { firstTokenMs }),
      });
      yield {
        type: 'done',
        result,
        // True whenever the final answer is not exactly what was streamed: a blocked answer, a
        // dropped citation, or text a check changed after it was sent.
        replace: blocked || !guard.consistent || result.answer !== guard.released,
      };
    } finally {
      signal?.removeEventListener('abort', hangUp);
      upstream.abort();
      await gatewayEvents.return(undefined);
    }
  }

  /**
   * Everything before the model: the question and documents are checked, the prompt resolved, and
   * the answer cache consulted. Returns either a finished answer (nothing to retrieve, or a cache
   * hit) or what is needed to generate one.
   */
  private async prepare(
    caller: AuthenticatedPrincipal,
    input: AskInput,
    requestId: string,
  ): Promise<{ early: AskResult } | { ready: Prepared }> {
    const { retrieval, obo } = this.clients;
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
        early: {
          requestId,
          answer: NO_SOURCES_ANSWER,
          citations: [],
          grounded: false,
          sourcesRetrieved: 0,
          droppedCitations: [],
          guardrails: {
            mode: guardrails.mode,
            question: question.report,
            sources: screened.report,
          },
          timings: { totalMs: ms(this.clock() - startedAt), retrievalMs: ms(retrievalMs) },
        },
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
        early: {
          requestId,
          answer: cached.answer.answer,
          citations: cached.answer.citations,
          grounded: true,
          sourcesRetrieved: sources.length,
          droppedCitations: [],
          prompt: info,
          guardrails: {
            mode: guardrails.mode,
            question: question.report,
            sources: screened.report,
          },
          cache: {
            status: 'hit',
            kind: cached.kind,
            similarity: cached.similarity,
            savedTokens: tokens,
            savedMicroUsd: costMicroUsd,
          },
          timings: { totalMs: ms(this.clock() - startedAt), retrievalMs: ms(retrievalMs) },
        },
      };
    }

    // A random marker in the confidential part of the prompt: it has no reason to ever appear in an
    // answer, so seeing it proves the model repeated its hidden instructions.
    const canary = `cnry-${randomBytes(8).toString('hex')}`;
    const system = `${rendered}\n\nConfidential marker (never output it): ${canary}`;
    const instructionText = rendered.split(sourcesText).join('').split(question.text).join('');

    return {
      ready: {
        caller,
        requestId,
        startedAt,
        retrievalMs,
        question: { text: question.text, report: question.report },
        sourcesReport: screened.report,
        sources,
        info,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question.text },
        ],
        outputContext: {
          canary,
          instructionText: `${instructionText}\n${system.slice(rendered.length)}`,
        },
        ...(cacheScope && { cacheScope }),
        ...(cached && { cached }),
      },
    };
  }

  /**
   * After the model: the answer out is checked (block a leak, redact sensitive data, strip image
   * and HTML exfiltration), citations are verified against what was really retrieved, and a clean
   * grounded answer is kept in the cache.
   */
  private finish(p: Prepared, completion: Completion): AskResult {
    const guardrails = this.guardrails;
    const output = guardrails.checkOutput(completion.text, p.outputContext);

    const common = {
      requestId: p.requestId,
      sourcesRetrieved: p.sources.length,
      usage: completion.usage,
      model: { provider: completion.provider, fallbackUsed: completion.fallbackUsed },
      prompt: p.info,
      guardrails: {
        mode: guardrails.mode,
        question: p.question.report,
        sources: p.sourcesReport,
        output: output.report,
      },
    };
    const timings: Timings = {
      totalMs: ms(this.clock() - p.startedAt),
      retrievalMs: ms(p.retrievalMs),
      modelMs: ms(completion.modelMs),
      ...(completion.firstTokenMs !== undefined && { firstTokenMs: ms(completion.firstTokenMs) }),
    };
    const tokens = completion.usage.totalTokens;
    const costMicroUsd = completion.cost?.microUsd ?? 0;

    if (output.blocked) {
      return {
        ...common,
        answer: BLOCKED_ANSWER,
        citations: [],
        grounded: false,
        droppedCitations: [],
        ...this.afterGeneration(p.caller.tenantId, p.cacheScope, p.question.text, p.cached, {
          answer: BLOCKED_ANSWER,
          citations: [],
          cacheable: false,
          tokens,
          costMicroUsd,
        }),
        timings,
      };
    }

    const checked = checkCitations(output.text, p.sources);
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
      ...this.afterGeneration(p.caller.tenantId, p.cacheScope, p.question.text, p.cached, {
        answer: checked.answer,
        citations,
        // Only a clean, grounded answer is worth keeping: nothing blocked, nothing invented.
        cacheable:
          grounded &&
          checked.droppedMarkers.length === 0 &&
          !output.report.wouldBlock &&
          !output.blocked,
        tokens,
        costMicroUsd,
      }),
      timings,
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
