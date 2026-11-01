import { annotate, metricsFor } from '@genai/observability';
import type { AskResult } from './ask.service';
import { isAbstention } from './abstention';
import { GuardrailBlockedError } from './errors';

const metrics = metricsFor('assistant');

/** How an answer ended, as one of a few values: what the on-call engineer and the SLOs both read. */
export function outcomeOf(result: AskResult): string {
  if (result.cache?.status === 'hit') return 'cache_hit';
  if (result.sourcesRetrieved === 0) return 'no_sources';
  if (result.guardrails.output?.blocked) return 'blocked';
  if (result.grounded) return 'grounded';
  // A correct "I do not know" is not an answer that failed to cite: counting it as one would make
  // every question the documents cannot answer spend the grounding budget.
  return isAbstention(result.answer) ? 'abstained' : 'ungrounded';
}

/**
 * Records a finished answer: its outcome, the guardrail decisions behind it and, when streamed,
 * how long the first words took. Only counts, labels and numbers: never the question or the answer.
 */
export function observeAnswer(result: AskResult, mode: 'sync' | 'stream'): void {
  const outcome = outcomeOf(result);
  const cache = result.cache?.status ?? 'off';
  metrics.count('answers', { outcome, cache });
  if (mode === 'stream' && result.timings.firstTokenMs !== undefined) {
    metrics.observe('firstToken', { mode }, result.timings.firstTokenMs);
  }

  const { question, sources, output } = result.guardrails;
  if (question.redactions.length > 0)
    metrics.count('guardrailEvents', { kind: 'question', action: 'masked' });
  if (question.wouldBlock && !question.blocked)
    metrics.count('guardrailEvents', { kind: 'question', action: 'flagged' });
  if (sources.quarantined > 0)
    metrics.count(
      'guardrailEvents',
      { kind: 'sources', action: 'quarantined' },
      sources.quarantined,
    );
  if (sources.wouldQuarantine > 0)
    metrics.count(
      'guardrailEvents',
      { kind: 'sources', action: 'flagged' },
      sources.wouldQuarantine,
    );
  if (output?.blocked) metrics.count('guardrailEvents', { kind: 'output', action: 'blocked' });
  if (output && output.wouldBlock && !output.blocked)
    metrics.count('guardrailEvents', { kind: 'output', action: 'flagged' });
  if (output && output.redactions.length > 0)
    metrics.count('guardrailEvents', { kind: 'output', action: 'masked' });

  annotate({
    'genai.outcome': outcome,
    'genai.grounded': result.grounded,
    'genai.sources.count': result.sourcesRetrieved,
    'genai.cache.status': cache,
    'genai.model.provider': result.model?.provider,
    'genai.model.fallback': result.model?.fallbackUsed,
    'genai.tokens.total': result.usage?.totalTokens,
    'genai.prompt.version': result.prompt ? String(result.prompt.version) : undefined,
  });
}

/** A request that produced no answer: refused by a guardrail (a decision, not a fault) or failed. */
export function observeFailure(error: unknown): void {
  if (error instanceof GuardrailBlockedError) {
    metrics.count('answers', { outcome: 'blocked', cache: 'off' });
    metrics.count('guardrailEvents', { kind: 'question', action: 'blocked' });
    annotate({ 'genai.outcome': 'blocked' });
    return;
  }
  metrics.count('answers', { outcome: 'error', cache: 'off' });
  annotate({ 'genai.outcome': 'error' });
}
