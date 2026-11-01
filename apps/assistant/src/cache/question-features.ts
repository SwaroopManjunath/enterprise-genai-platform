/**
 * How two questions are compared. This is spelling and wording, not meaning: it catches the same
 * question asked with different case, punctuation, word forms or word order, which is most of the
 * repetition in a real help desk. It cannot know that two differently worded questions mean the
 * same thing; a real embedding model (through the gateway) would add that, behind the same
 * interface. See ADR 0013.
 */
const STOPWORDS = new Set(
  (
    'a an the is are was were be been am do does did have has had i me my we our you your it its ' +
    'of to in on at for with from by as and or if this that these those there then than so ' +
    'what which who whom whose when where why how can could would should will shall may might ' +
    'please tell about into over under up down out any some all ' +
    'der die das ein eine und oder ist sind war wie was wer wann wo warum kann ich mein wir sie'
  ).split(' '),
);

/**
 * Words that flip or redirect a question. Two questions that differ in any of these are never the
 * same question, however alike they otherwise look ("can I block my card" and "can I not block my
 * card" are one word apart and opposite). Matched exactly, so they are kept out of the stopwords.
 */
const MUST_MATCH = new Set(
  (
    'not no never none nothing nobody neither nor without cannot cant dont doesnt didnt isnt arent wont ' +
    'kein keine keinen keiner nicht nie niemals ohne ' +
    'before after earlier later first last open close opened closed add remove enable disable ' +
    'increase decrease raise lower allow forbid allowed forbidden ' +
    'cheaper cheapest more less most least max min maximum minimum above below under over'
  ).split(' '),
);

const DIMENSIONS = 256;

/** Lowercase words, apostrophes dropped (so "can't" is "cant"), punctuation gone. */
export function words(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

/** The question as one normalised string: what an exact repeat looks like. */
export const normalize = (question: string): string => words(question).join(' ');

/** Crude word-form folding: refunds/refunded, take/takes/taking, block/blocked/blocking. */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function contentStems(question: string): string[] {
  return words(question)
    .filter((w) => !STOPWORDS.has(w))
    .map(stem);
}

/** 32-bit FNV-1a. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A fixed-size, length-normalised vector of the question's content words and word pairs. */
export function embed(question: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const stems = contentStems(question);
  const add = (feature: string, weight: number) => {
    const h = hash(feature);
    const sign = (h >>> 16) & 1 ? 1 : -1; // signed hashing: collisions cancel instead of adding up
    vector[h % DIMENSIONS] = (vector[h % DIMENSIONS] ?? 0) + sign * weight;
  };
  stems.forEach((stem_, i) => {
    add(stem_, 1);
    const next = stems[i + 1];
    if (next !== undefined) add(`${stem_} ${next}`, 0.5);
  });

  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? vector : vector.map((x) => x / norm);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * What two questions must have in common, exactly, before they can be treated as one: every number
 * and identifier (a different amount or a different customer id is a different question), and every
 * word that flips or redirects the meaning. Similarity alone cannot be trusted with these: one word
 * changes the answer and barely changes the vector.
 */
export function mustMatch(question: string): string {
  const tokens = new Set<string>();
  for (const w of words(question)) {
    if (/\d/.test(w) || MUST_MATCH.has(w)) tokens.add(w);
  }
  return [...tokens].sort().join('|');
}
