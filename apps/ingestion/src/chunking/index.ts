import { EmptyDocumentError, UnsupportedFileTypeError } from '../domain/errors';
import { chunkCsv } from './csv.chunker';
import { chunkMarkdown } from './markdown.chunker';
import { normalize } from './text-utils';
import { chunkText } from './text.chunker';
import type { Chunk, ChunkOptions, FileType } from './types';

export type { Chunk, ChunkOptions, FileType } from './types';

const BY_EXTENSION: Record<string, FileType> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  csv: 'csv',
};

const BY_CONTENT_TYPE: Record<string, FileType> = {
  'text/markdown': 'markdown',
  'text/plain': 'text',
  'text/csv': 'csv',
};

/** The filename extension wins; the declared content type is only a fallback. */
export function detectFileType(filename: string, contentType?: string): FileType {
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  const byExtension = extension ? BY_EXTENSION[extension] : undefined;
  if (byExtension) return byExtension;

  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  const byContentType = mime ? BY_CONTENT_TYPE[mime] : undefined;
  if (byContentType) return byContentType;

  throw new UnsupportedFileTypeError(filename);
}

const CHUNKERS: Record<FileType, (text: string, options: ChunkOptions) => Chunk[]> = {
  markdown: chunkMarkdown,
  text: chunkText,
  csv: chunkCsv,
};

/** Normalises the text, chunks it with the strategy for its type, and rejects empty results. */
export function chunkDocument(
  fileType: FileType,
  rawText: string,
  options: ChunkOptions,
  filename = 'document',
): Chunk[] {
  const chunks = CHUNKERS[fileType](normalize(rawText), options);
  if (chunks.length === 0) throw new EmptyDocumentError(filename);
  return chunks;
}
