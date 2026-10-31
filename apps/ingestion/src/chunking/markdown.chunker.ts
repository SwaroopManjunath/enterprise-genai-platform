import type { Chunk, ChunkOptions } from './types';
import { applyOverlap, packParts, splitParagraphs } from './text-utils';

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface Section {
  headingPath: string[];
  headingLine: string | undefined;
  lines: string[];
}

/** Splits into sections at headings (ignoring `#` lines inside code fences). */
function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { headingPath: [], headingLine: undefined, lines: [] };
  let inFence = false;

  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push(current);
      const level = (match[1] as string).length;
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) {
        stack.pop();
      }
      stack.push({ level, title: match[2] as string });
      current = { headingPath: stack.map((h) => h.title), headingLine: line, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Chunks along the document's own structure: a chunk never spans two sections, and records the
 * heading path it sits under so retrieval can show "Pricing > Refunds" as context. Sections too
 * big for one chunk are split by paragraph; continuation chunks repeat the section heading.
 * Heading-only sections (a title directly followed by a subheading) carry no content and are
 * skipped; their titles still appear in the path of their children.
 */
export function chunkMarkdown(text: string, options: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of parseSections(text)) {
    const body = section.headingLine === undefined ? section.lines : section.lines.slice(1);
    if (body.join('\n').trim() === '') continue;

    const packed = packParts(splitParagraphs(section.lines.join('\n').trim()), options.maxChars);
    const pieces = applyOverlap(packed, options.overlapChars);

    pieces.forEach((piece, i) => {
      const withHeading =
        i > 0 && section.headingLine !== undefined ? `${section.headingLine}\n\n${piece}` : piece;
      chunks.push({
        index: chunks.length,
        text: withHeading,
        metadata: section.headingPath.length > 0 ? { headingPath: section.headingPath } : {},
      });
    });
  }
  return chunks;
}
