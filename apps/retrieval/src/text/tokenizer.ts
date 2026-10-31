const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have how i in is it of on or that the this to was ' +
    'were what when where which who will with you your'
  ).split(' '),
);

export interface TokenizeOptions {
  /** Drop very common words ("the", "of") that carry no search signal. Default true. */
  removeStopwords?: boolean;
}

/**
 * Lowercases, strips accents and splits into letter/digit runs, so "Café-Menü 2024" becomes
 * ["cafe", "menu", "2024"]. Identifiers such as "XK-9921" split into "xk" and "9921"; the number
 * part is rare, so it scores highly and an exact code lookup ranks the right chunk first.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const removeStopwords = options.removeStopwords ?? true;
  const folded = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  const tokens = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
  return removeStopwords ? tokens.filter((t) => !STOPWORDS.has(t)) : tokens;
}

export function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
}
