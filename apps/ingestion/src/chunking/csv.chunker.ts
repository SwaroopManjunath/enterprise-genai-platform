import type { Chunk, ChunkOptions } from './types';

/** Splits CSV text into records; a newline inside a quoted field does not end the record. */
export function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === '\n' && !inQuotes) {
      records.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') records.push(current);
  return records.filter((r) => r.trim() !== '');
}

/**
 * Groups whole rows into chunks and repeats the header in each one, so a chunk is meaningful on
 * its own (a bare row of numbers says nothing without its column names). Rows are never split or
 * overlapped. A single row larger than maxChars still becomes its own chunk.
 */
export function chunkCsv(text: string, options: ChunkOptions): Chunk[] {
  const [header, ...rows] = splitCsvRecords(text);
  if (header === undefined || rows.length === 0) return [];

  const chunks: Chunk[] = [];
  let group: string[] = [];
  let size = header.length;
  let firstRow = 1;

  const flush = (): void => {
    if (group.length === 0) return;
    chunks.push({
      index: chunks.length,
      text: [header, ...group].join('\n'),
      metadata: { rowStart: firstRow, rowEnd: firstRow + group.length - 1 },
    });
    firstRow += group.length;
    group = [];
    size = header.length;
  };

  for (const row of rows) {
    if (group.length > 0 && size + 1 + row.length > options.maxChars) flush();
    group.push(row);
    size += 1 + row.length;
  }
  flush();
  return chunks;
}
