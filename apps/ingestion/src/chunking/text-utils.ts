/** Strips a BOM and normalises line endings so every chunker sees plain `\n` text. */
export function normalize(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, '\n');
}

/**
 * Splits on blank lines, but keeps fenced code blocks (```) whole: blank lines inside code are
 * part of the code, and cutting there would produce meaningless fragments.
 */
export function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current.join('\n'));
    current = [];
  };

  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current.push(line);
    } else if (!inFence && line.trim() === '') {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return paragraphs;
}

/** Breaks one over-long block on sentence ends, then hard-slices anything still too long. */
export function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current) parts.push(current);
    current = '';
  };

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > max) {
      flush();
      for (let i = 0; i < sentence.length; i += max) parts.push(sentence.slice(i, i + max));
    } else if (current && current.length + 1 + sentence.length > max) {
      flush();
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  flush();
  return parts;
}

/** Greedily joins blocks (splitting any that are too long) into pieces of at most `max` chars. */
export function packParts(parts: string[], max: number, separator = '\n\n'): string[] {
  const packed: string[] = [];
  let current = '';

  for (const part of parts.flatMap((p) => splitLong(p, max))) {
    if (current && current.length + separator.length + part.length > max) {
      packed.push(current);
      current = part;
    } else {
      current = current ? `${current}${separator}${part}` : part;
    }
  }
  if (current) packed.push(current);
  return packed;
}

/**
 * Prefixes each chunk (after the first) with the tail of the previous one, cut at a word
 * boundary. Overlap keeps a sentence that straddles a boundary retrievable from either side.
 */
export function applyOverlap(chunks: string[], overlapChars: number): string[] {
  if (overlapChars <= 0) return chunks;

  return chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const previous = chunks[i - 1] as string;
    let tail = previous.slice(-overlapChars);
    if (previous.length > overlapChars) {
      const firstSpace = tail.search(/\s/);
      tail = firstSpace >= 0 ? tail.slice(firstSpace).trim() : tail;
    }
    return tail ? `${tail}\n${chunk}` : chunk;
  });
}
