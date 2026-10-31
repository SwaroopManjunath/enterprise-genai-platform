import type { QuestionReport } from '@genai/guardrails';

/**
 * The question itself looks like an attack on the assistant. The report is for server-side logs;
 * the caller gets a generic refusal that does not say which rule fired.
 */
export class GuardrailBlockedError extends Error {
  constructor(readonly report: QuestionReport) {
    super('Request blocked by guardrails');
    this.name = 'GuardrailBlockedError';
  }
}
