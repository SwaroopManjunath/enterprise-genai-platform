import { createHash } from 'node:crypto';

/** JSON with sorted keys, so the same arguments always produce the same string. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** A short fingerprint for audit: proves which arguments ran without storing them. */
export const digest = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Matched by name, not instanceof: the check must survive module and test-runner realms. */
export const isTimeout = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === 'TimeoutError';

/** Rejects after `ms`. The underlying work is not cancelled; `onTimeout` is the chance to abort it. */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        onTimeout?.();
        reject(new TimeoutError(what, ms));
      },
      Math.max(ms, 1),
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * Every string inside a value, with its nesting limited. Used to screen structured tool output
 * leaf by leaf: JSON-encoding it first would turn a newline into a literal backslash-n and glue it
 * to the next word ("\\nIGNORE"), which hides an instruction from the detector.
 */
export function collectStrings(
  value: unknown,
  maxStrings = 200,
  depth = 0,
  out: string[] = [],
): string[] {
  if (out.length >= maxStrings || depth > 8) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value))
    value.forEach((v) => collectStrings(v, maxStrings, depth + 1, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectStrings(v, maxStrings, depth + 1, out));
  }
  return out;
}
