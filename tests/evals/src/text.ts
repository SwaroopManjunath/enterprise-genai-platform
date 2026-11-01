/**
 * Text handling for the evaluation. It is deliberately its own code, not shared with the services:
 * a judge that tokenises the way the system under test does would share its blind spots, and a
 * change to the assistant could then change the measurement.
 */
const STOPWORDS = new Set(
  (
    'a an the is are was were be been am do does did have has had i me my we our you your it its ' +
    'of to in on at for with from by as and or if this that these those there then than so ' +
    'what which who whom whose when where why how can could would should will shall may might ' +
    'please tell about into over under up down out any some all also within after before ' +
    'der die das ein eine und oder ist sind war wie was wer wann wo warum kann ich mein wir sie'
  ).split(' '),
);

/** Words that flip a statement. A claim and its source must agree on them. */
export const NEGATIONS = new Set(
  (
    'not no never none nothing nobody neither nor without cannot cant dont doesnt didnt isnt arent ' +
    'wont wasnt werent kein keine keinen keiner nicht nie niemals ohne'
  ).split(' '),
);

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
};

/** Lowercase words; apostrophes dropped ("can't" is "cant"); decimals like 4.50 stay whole. */
export function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/(\d),(\d{3})/g, '$1$2') // 1,000 -> 1000
      .match(/\d+(?:\.\d+)?|[\p{L}]+(?:-[\p{L}\d]+)*/gu) ?? []
  );
}

/** Crude word-form folding, so refund/refunds/refunded compare equal. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Number words become digits, in the text and the sources alike, so "five" matches "5". */
const normalizeNumberWords = (list: string[]): string[] => list.map((w) => NUMBER_WORDS[w] ?? w);

export function contentWords(text: string): string[] {
  return normalizeNumberWords(words(text))
    .filter((w) => !STOPWORDS.has(w) && !NEGATIONS.has(w))
    .map(stem);
}

export function numbersIn(text: string): string[] {
  return normalizeNumberWords(words(text)).filter((w) => /^\d/.test(w));
}

/**
 * Each number with the word after it ("5 working", "2500 euro"), so a right number with the wrong
 * unit does not pass. A number followed by nothing worth comparing is skipped.
 */
export function numberUnits(text: string): string[] {
  const list = normalizeNumberWords(words(text));
  const pairs: string[] = [];
  list.forEach((w, i) => {
    const next = list[i + 1];
    if (/^\d/.test(w) && next !== undefined && !/^\d/.test(next) && !STOPWORDS.has(next)) {
      pairs.push(`${w} ${stem(next)}`);
    }
  });
  return pairs;
}

export function negationsIn(text: string): string[] {
  return [...new Set(words(text).filter((w) => NEGATIONS.has(w)))].sort();
}

/** Citation markers like [1] or [1, 2] are not part of what was claimed. */
export const stripMarkers = (text: string): string =>
  text
    .replace(/\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Sentences, without their citation markers. */
export function sentences(text: string): string[] {
  return stripMarkers(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Lowercase, punctuation-light, spaces collapsed: how facts are looked for in an answer. */
export const normalizeForMatch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[^\p{L}\p{N}.%]+/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
