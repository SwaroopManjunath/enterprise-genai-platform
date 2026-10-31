import {
  QUESTION_BLOCK_THRESHOLD,
  SOURCE_QUARANTINE_THRESHOLD,
  detectInjection,
} from './injection';
import { containsCanary, leaksInstructions, sanitizeOutput } from './output';
import { redactPii, type PiiFinding, type PiiType } from './pii';

/**
 * - `enforce`: block, quarantine and redact.
 * - `monitor`: shadow mode. Detect everything and report what WOULD have happened, but change
 *   nothing. The usual way to roll out a guardrail: watch real traffic for false positives before
 *   letting it block anyone.
 */
export type GuardrailMode = 'enforce' | 'monitor';

export interface GuardrailsOptions {
  mode: GuardrailMode;
  /** Kinds redacted from answers. Defaults to the high-risk ones; questions redact every kind. */
  outputPii?: readonly PiiType[];
  questionBlockThreshold?: number;
  sourceQuarantineThreshold?: number;
}

/** Shown instead of an answer that was blocked. Deliberately says nothing about why. */
export const BLOCKED_ANSWER = 'I cannot provide that response.';

export const DEFAULT_OUTPUT_PII: readonly PiiType[] = ['secret', 'card', 'iban'];

// Reports contain kinds, counts and signal names only: never the text they were about.
export interface QuestionReport {
  injectionScore: number;
  injectionSignals: string[];
  /** Sensitive data found in the question (redacted when enforcing). */
  redactions: PiiFinding[];
  blocked: boolean;
  wouldBlock: boolean;
}

export interface QuestionVerdict {
  blocked: boolean;
  /** The question to use from here on: redacted when enforcing, unchanged when monitoring. */
  text: string;
  report: QuestionReport;
}

export interface SourcesReport {
  scanned: number;
  quarantined: number;
  wouldQuarantine: number;
  signals: string[];
}

export interface OutputReport {
  blocked: boolean;
  wouldBlock: boolean;
  /** Why an answer was (or would be) blocked: `canary_leak` or `instruction_leak`. */
  reasons: string[];
  redactions: PiiFinding[];
  /** Images, HTML and link destinations removed from the answer. */
  sanitized: number;
}

export interface OutputVerdict {
  blocked: boolean;
  text: string;
  report: OutputReport;
}

export interface OutputContext {
  /** Random marker placed in the confidential part of the prompt for this request. */
  canary: string;
  /** The instruction part of the prompt only: no retrieved sources, no question. */
  instructionText: string;
}

/**
 * Applies the guardrail policy at the three points where untrusted text crosses a boundary: what
 * the user asks, what the documents say, and what the model answers.
 */
export class Guardrails {
  readonly mode: GuardrailMode;
  private readonly outputPii: readonly PiiType[];
  private readonly questionThreshold: number;
  private readonly sourceThreshold: number;

  constructor(options: GuardrailsOptions) {
    this.mode = options.mode;
    this.outputPii = options.outputPii ?? DEFAULT_OUTPUT_PII;
    this.questionThreshold = options.questionBlockThreshold ?? QUESTION_BLOCK_THRESHOLD;
    this.sourceThreshold = options.sourceQuarantineThreshold ?? SOURCE_QUARANTINE_THRESHOLD;
  }

  private get enforcing(): boolean {
    return this.mode === 'enforce';
  }

  /** A question may be odd, so only a combination of strong signals blocks it. PII is masked. */
  checkQuestion(question: string): QuestionVerdict {
    const injection = detectInjection(question);
    const pii = redactPii(question);
    const wouldBlock = injection.score >= this.questionThreshold;
    const blocked = this.enforcing && wouldBlock;

    return {
      blocked,
      text: this.enforcing ? pii.text : question,
      report: {
        injectionScore: injection.score,
        injectionSignals: injection.signals,
        redactions: pii.findings,
        blocked,
        wouldBlock,
      },
    };
  }

  /**
   * A retrieved document has no authority to instruct the assistant, so a passage that reads like
   * an instruction is quarantined: it never reaches the prompt.
   */
  screenSources<T extends { text: string }>(
    sources: readonly T[],
  ): { kept: T[]; report: SourcesReport } {
    const signals = new Set<string>();
    const kept: T[] = [];
    let wouldQuarantine = 0;

    for (const source of sources) {
      const assessment = detectInjection(source.text);
      const flagged = assessment.score >= this.sourceThreshold;
      if (flagged) {
        wouldQuarantine += 1;
        assessment.signals.forEach((s) => signals.add(s));
      }
      if (!(flagged && this.enforcing)) kept.push(source);
    }

    return {
      kept,
      report: {
        scanned: sources.length,
        quarantined: this.enforcing ? wouldQuarantine : 0,
        wouldQuarantine,
        signals: [...signals].sort(),
      },
    };
  }

  /** Blocks answers that leak the hidden instructions; redacts and sanitises the rest. */
  checkOutput(answer: string, context: OutputContext): OutputVerdict {
    const reasons: string[] = [];
    if (containsCanary(answer, context.canary)) reasons.push('canary_leak');
    if (leaksInstructions(answer, context.instructionText)) reasons.push('instruction_leak');

    const sanitized = sanitizeOutput(answer);
    const redacted = redactPii(sanitized.text, this.outputPii);
    const wouldBlock = reasons.length > 0;
    const blocked = this.enforcing && wouldBlock;

    return {
      blocked,
      text: blocked ? BLOCKED_ANSWER : this.enforcing ? redacted.text : answer,
      report: {
        blocked,
        wouldBlock,
        reasons,
        redactions: redacted.findings,
        sanitized: sanitized.removed,
      },
    };
  }

  /** For text shown next to an answer (citation excerpts): same redaction, same mode. */
  redactForOutput(text: string): string {
    return this.enforcing ? redactPii(text, this.outputPii).text : text;
  }
}
