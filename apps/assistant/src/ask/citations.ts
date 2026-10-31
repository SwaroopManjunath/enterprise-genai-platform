import type { Source } from './sources';

export interface Citation {
  marker: number;
  documentId: string;
  chunkId: string;
  headingPath: string[];
  /** The start of the cited chunk, so a reader can see what the answer rests on. */
  excerpt: string;
  score: number;
}

export interface CitationCheck {
  /** The answer with any marker that does not match a real source removed. */
  answer: string;
  /** Only sources the model actually cited and that were really retrieved, in citation order. */
  citations: Citation[];
  /** Markers the model used that do not exist (hallucinated), now removed from the answer. */
  droppedMarkers: number[];
}

const EXCERPT_CHARS = 240;
const MARKER_GROUP = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/**
 * Verifies the model's citations against what was actually retrieved.
 *
 * A model can cite "[7]" when only three sources exist, or cite nothing at all. Showing such a
 * citation would present an invented source as evidence, so markers that do not map to a real
 * source are removed from the answer and reported, and the returned citations only ever contain
 * sources that were retrieved for this user. `[1, 2]` groups are understood.
 */
export function checkCitations(answer: string, sources: readonly Source[]): CitationCheck {
  const byMarker = new Map(sources.map((s) => [s.marker, s]));
  const cited: number[] = [];
  const dropped: number[] = [];

  const cleaned = answer.replace(MARKER_GROUP, (_whole, group: string) => {
    const kept: number[] = [];
    for (const n of group.split(',').map((part) => Number(part.trim()))) {
      if (byMarker.has(n)) {
        kept.push(n);
        if (!cited.includes(n)) cited.push(n);
      } else if (!dropped.includes(n)) {
        dropped.push(n);
      }
    }
    return kept.length > 0 ? `[${kept.join(', ')}]` : '';
  });

  return {
    answer: cleaned
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .trim(),
    citations: cited.map((marker) => {
      const source = byMarker.get(marker) as Source;
      return {
        marker,
        documentId: source.documentId,
        chunkId: source.chunkId,
        headingPath: source.headingPath,
        excerpt: source.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
        score: source.score,
      };
    }),
    droppedMarkers: dropped,
  };
}
