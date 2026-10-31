import type { AuthenticatedPrincipal, OboTokenClient } from '@genai/auth';
import { Logger } from '@nestjs/common';
import type { AssistantConfig } from '../config/config';
import { DownstreamError } from '../clients/http-json-client';
import type {
  GatewayClient,
  PromptClient,
  RetrievalClient,
  SearchRequest,
} from '../clients/service-clients';
import { checkCitations, type Citation } from './citations';
import { BUILTIN_PROMPT_TEMPLATE, fillTemplate } from './prompt';
import { formatSources, toSources } from './sources';

export interface AskInput {
  question: string;
  topK?: number;
  filter?: SearchRequest['filter'];
}

export interface PromptInfo {
  name: string;
  /** Registry version number, or "builtin" when the default template was used. */
  version: number | 'builtin';
  source: 'registry' | 'builtin';
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
 * Answers a question **as the calling user**, in four steps:
 *
 *  1. Retrieve: exchange the user's token for a retrieval token (on-behalf-of) and search. Access
 *     trimming happens there, by the user's tenant and roles, so only permitted chunks come back.
 *  2. Prompt: resolve the tenant's prompt from the registry (or use the built-in default).
 *  3. Generate: call the LLM gateway, again as the user, for limits, retries and fallback.
 *  4. Verify: keep only citations that point at chunks that were really retrieved.
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
  ) {}

  async ask(
    caller: AuthenticatedPrincipal,
    input: AskInput,
    requestId: string,
  ): Promise<AskResult> {
    const { retrieval, gateway, obo } = this.clients;

    const hits = await retrieval.search(
      await obo.exchange(caller.accessToken, this.config.retrieval.scope),
      {
        query: input.question,
        topK: input.topK ?? this.config.defaultTopK,
        ...(input.filter && { filter: input.filter }),
      },
      requestId,
    );

    if (hits.length === 0) {
      return {
        requestId,
        answer: NO_SOURCES_ANSWER,
        citations: [],
        grounded: false,
        sourcesRetrieved: 0,
        droppedCitations: [],
      };
    }

    const sources = toSources(hits);
    const { rendered, info } = await this.resolvePrompt(
      caller,
      { sources: formatSources(sources), question: input.question },
      requestId,
    );

    const completion = await gateway.chat(
      await obo.exchange(caller.accessToken, this.config.gateway.scope),
      [
        { role: 'system', content: rendered },
        { role: 'user', content: input.question },
      ],
      requestId,
    );

    const checked = checkCitations(completion.message.content, sources);
    return {
      requestId,
      answer: checked.answer,
      citations: checked.citations,
      grounded: checked.citations.length > 0,
      sourcesRetrieved: sources.length,
      droppedCitations: checked.droppedMarkers,
      usage: completion.usage,
      model: { provider: completion.provider, fallbackUsed: completion.fallbackUsed },
      prompt: info,
    };
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
