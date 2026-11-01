import { createHash } from 'node:crypto';

/** JSON with sorted keys, so equal values always produce the same string. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 of the stable form. For pinning a definition: any change at all changes the hash. */
export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

/** A short fingerprint for audit: shows which arguments ran without storing them. */
export const digest = (value: unknown): string => fingerprint(value).slice(0, 16);
