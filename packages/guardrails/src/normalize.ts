const ch = (codePoint: number): string => String.fromCodePoint(codePoint);

/**
 * Code point ranges that are invisible to a reader but readable by a model or a script: soft
 * hyphen, joiners, zero-width and bidirectional controls, variation selectors, invisible fillers.
 * Written as numbers rather than a character class so the source stays readable and reviewable.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
];

const rangeSource = (ranges: ReadonlyArray<readonly [number, number]>): string =>
  ranges.map(([from, to]) => (from === to ? ch(from) : `${ch(from)}-${ch(to)}`)).join('');

const INVISIBLE = new RegExp(`[${rangeSource(INVISIBLE_RANGES)}]`, 'gu');

/** The Unicode "tag" block: unused in ordinary text, but can smuggle invisible ASCII. */
const TAG_CHARACTERS = new RegExp(`[${rangeSource([[0xe0000, 0xe007f]])}]`, 'gu');

/**
 * Letters from other scripts that look identical to Latin ones, used to dodge keyword checks.
 * Keyed by code point so a reader can see exactly which letters are meant.
 */
const HOMOGLYPHS: ReadonlyMap<number, string> = new Map([
  [0x0430, 'a'], // Cyrillic a
  [0x0435, 'e'], // Cyrillic ie
  [0x043e, 'o'], // Cyrillic o
  [0x0440, 'p'], // Cyrillic er
  [0x0441, 'c'], // Cyrillic es
  [0x0445, 'x'], // Cyrillic ha
  [0x0456, 'i'], // Cyrillic Ukrainian i
  [0x0455, 's'], // Cyrillic dze
  [0x0458, 'j'], // Cyrillic je
  [0x0501, 'd'], // Cyrillic komi de
  [0x051b, 'q'], // Cyrillic qa
  [0x03bf, 'o'], // Greek omicron
  [0x03b9, 'i'], // Greek iota
  [0x03bd, 'v'], // Greek nu
  [0x03b1, 'a'], // Greek alpha
  [0x03b5, 'e'], // Greek epsilon
]);

export const countInvisible = (text: string): number => (text.match(INVISIBLE) ?? []).length;
export const countTagCharacters = (text: string): number =>
  (text.match(TAG_CHARACTERS) ?? []).length;

/**
 * Canonical form for pattern matching: compatibility-normalised (full-width letters become plain
 * ones), invisible characters removed, look-alike letters mapped to Latin, lowercased, and runs of
 * spaces collapsed. Newlines are kept because some patterns are line-anchored.
 */
export function normalizeForDetection(text: string): string {
  const folded = text
    .normalize('NFKC')
    .replace(TAG_CHARACTERS, '')
    .replace(INVISIBLE, '')
    .toLowerCase();

  let mapped = '';
  for (const char of folded) {
    mapped += HOMOGLYPHS.get(char.codePointAt(0) as number) ?? char;
  }
  return mapped.replace(/[ \t\f\v]+/g, ' ');
}
