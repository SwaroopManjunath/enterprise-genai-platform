/**
 * Sensitive data kinds, in priority order: where two matches overlap, the earlier kind wins (an
 * IBAN is not also reported as a phone number).
 */
export type PiiType = 'secret' | 'iban' | 'card' | 'email' | 'phone';

export const ALL_PII_TYPES: readonly PiiType[] = ['secret', 'iban', 'card', 'email', 'phone'];

/** Only the kind and the number of matches. Never the matched text: a report must not leak it. */
export interface PiiFinding {
  type: PiiType;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: PiiFinding[];
}

interface Match {
  type: PiiType;
  start: number;
  end: number;
}

/** Luhn checksum, used by payment card numbers. Rejects ordinary long numbers. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** ISO 13616 mod-97 check, so a random "DE12..." string is not mistaken for an IBAN. */
export function ibanValid(candidate: string): boolean {
  const iban = candidate.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' ? char.charCodeAt(0) - 55 : char.charCodeAt(0) - 48;
    remainder = Number(`${remainder}${value}`) % 97;
  }
  return remainder === 1;
}

const digitsOf = (text: string): string => text.replace(/\D/g, '');

const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub token
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // API secret key style
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JSON Web Token
  /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/g, // Azure storage connection string key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // "password: hunter2hunter2", "api_key = ..." : the value after a credential-looking label
  /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
];

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const PHONE_CANDIDATES: RegExp[] = [
  /(?<![\w+])(?:\+|00)\d{1,3}[\d\s().\-/]{7,18}\d/g, // international: +49 30 1234567
  /(?<![\w.+-])0\d{1,4}[\s/-]?\d{3,}[\d\s\-/]{0,8}\d/g, // national, leading zero: 030 1234567
];

function collect(
  text: string,
  pattern: RegExp,
  type: PiiType,
  accept: (m: string) => boolean,
): Match[] {
  const matches: Match[] = [];
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const value = m[0];
    if (accept(value))
      matches.push({ type, start: m.index ?? 0, end: (m.index ?? 0) + value.length });
  }
  return matches;
}

function findMatches(text: string, types: readonly PiiType[]): Match[] {
  const wanted = new Set(types);
  const all: Match[] = [];

  for (const type of ALL_PII_TYPES) {
    if (!wanted.has(type)) continue;
    switch (type) {
      case 'secret':
        for (const p of SECRET_PATTERNS) all.push(...collect(text, p, type, () => true));
        break;
      case 'iban':
        all.push(...collect(text, IBAN_CANDIDATE, type, ibanValid));
        break;
      case 'card':
        all.push(
          ...collect(text, CARD_CANDIDATE, type, (m) => {
            const d = digitsOf(m);
            return d.length >= 13 && d.length <= 19 && luhnValid(d);
          }),
        );
        break;
      case 'email':
        all.push(...collect(text, EMAIL, type, () => true));
        break;
      case 'phone':
        for (const p of PHONE_CANDIDATES) {
          all.push(
            ...collect(text, p, type, (m) => {
              const n = digitsOf(m).length;
              return n >= 9 && n <= 15;
            }),
          );
        }
        break;
    }
  }

  // Resolve overlaps: earlier kinds win, then the longer match, then the earlier position.
  const rank = (t: PiiType): number => ALL_PII_TYPES.indexOf(t);
  all.sort(
    (a, b) =>
      rank(a.type) - rank(b.type) || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: Match[] = [];
  for (const candidate of all) {
    if (!kept.some((k) => candidate.start < k.end && k.start < candidate.end)) kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}

const countBy = (matches: Match[]): PiiFinding[] =>
  ALL_PII_TYPES.map((type) => ({
    type,
    count: matches.filter((m) => m.type === type).length,
  })).filter((f) => f.count > 0);

/** What kinds of sensitive data are present, and how many, without exposing any of it. */
export function detectPii(text: string, types: readonly PiiType[] = ALL_PII_TYPES): PiiFinding[] {
  return countBy(findMatches(text, types));
}

/** Replaces each match with `[REDACTED:TYPE]`. Idempotent: redacting twice changes nothing more. */
export function redactPii(
  text: string,
  types: readonly PiiType[] = ALL_PII_TYPES,
): RedactionResult {
  const matches = findMatches(text, types);
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + `[REDACTED:${m.type.toUpperCase()}]`;
    cursor = m.end;
  }
  return { text: out + text.slice(cursor), findings: countBy(matches) };
}
