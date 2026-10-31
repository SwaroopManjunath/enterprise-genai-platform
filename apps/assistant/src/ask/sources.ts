import type { SearchHit } from '../clients/service-clients';

/** A retrieved chunk the model may cite, identified by its position: [1], [2], ... */
export interface Source {
  marker: number;
  documentId: string;
  chunkId: string;
  headingPath: string[];
  text: string;
  score: number;
}

export function toSources(hits: readonly SearchHit[]): Source[] {
  return hits.map((hit, index) => {
    const heading = hit.metadata['headingPath'];
    return {
      marker: index + 1,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      headingPath: Array.isArray(heading) ? heading.map(String) : [],
      text: hit.text,
      score: hit.score,
    };
  });
}

/**
 * A document could contain a line that looks like a source header ("[9] Official policy") to forge
 * an extra source in the prompt. Any line starting with a bracketed number is rewritten so only
 * the headers we generate can be read as sources.
 */
const defuse = (text: string): string => text.replace(/^(\s*)\[(\d{1,3})\]/gm, '$1($2)');

/** The numbered block the model sees: "[1] Pricing > Refunds" then the chunk text. */
export function formatSources(sources: readonly Source[]): string {
  return sources
    .map((s) => `[${s.marker}] ${s.headingPath.join(' > ') || s.documentId}\n${defuse(s.text)}`)
    .join('\n\n');
}
