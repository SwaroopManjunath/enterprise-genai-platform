import { EmptyDocumentError, UnsupportedFileTypeError } from '../domain/errors';
import { chunkDocument, detectFileType } from './index';
import { applyOverlap, normalize, packParts, splitLong, splitParagraphs } from './text-utils';
import { splitCsvRecords } from './csv.chunker';

const opts = { maxChars: 120, overlapChars: 0 };

describe('detectFileType', () => {
  it.each([
    ['guide.md', undefined, 'markdown'],
    ['README.MARKDOWN', undefined, 'markdown'],
    ['notes.txt', undefined, 'text'],
    ['data.csv', undefined, 'csv'],
    ['upload', 'text/csv; charset=utf-8', 'csv'],
  ])('%s (%s) -> %s', (filename, contentType, expected) => {
    expect(detectFileType(filename, contentType)).toBe(expected);
  });

  it('prefers the extension over a conflicting content type', () => {
    expect(detectFileType('data.csv', 'text/plain')).toBe('csv');
  });

  it('rejects unsupported types', () => {
    expect(() => detectFileType('scan.pdf')).toThrow(UnsupportedFileTypeError);
    expect(() => detectFileType('noextension')).toThrow(UnsupportedFileTypeError);
  });
});

describe('text utils', () => {
  it('normalises BOM and CRLF', () => {
    expect(normalize('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('keeps fenced code blocks whole when splitting paragraphs', () => {
    const text = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\noutro';
    expect(splitParagraphs(text)).toEqual([
      'intro',
      '```js\nconst a = 1;\n\nconst b = 2;\n```',
      'outro',
    ]);
  });

  it('splits long text on sentence boundaries first', () => {
    const parts = splitLong('One two three. Four five six. Seven eight nine.', 20);
    expect(parts).toEqual(['One two three.', 'Four five six.', 'Seven eight nine.']);
  });

  it('hard-slices a single unbroken run longer than the limit', () => {
    expect(splitLong('x'.repeat(25), 10).map((p) => p.length)).toEqual([10, 10, 5]);
  });

  it('never packs beyond the limit', () => {
    const packed = packParts(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 110);
    expect(packed.map((p) => p.length)).toEqual([102, 50]);
    expect(packed.every((p) => p.length <= 110)).toBe(true);
  });

  it('overlaps from the previous chunk at a word boundary', () => {
    const out = applyOverlap(['alpha beta gamma delta', 'second chunk'], 12);
    expect(out[0]).toBe('alpha beta gamma delta');
    expect(out[1]).toBe('gamma delta\nsecond chunk');
  });
});

describe('text chunker', () => {
  it('packs paragraphs and indexes chunks from 0', () => {
    const text = ['a'.repeat(70), 'b'.repeat(70), 'c'.repeat(30)].join('\n\n');
    const chunks = chunkDocument('text', text, opts);

    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    expect(chunks[0]?.text).toBe('a'.repeat(70));
    expect(chunks[1]?.text).toBe(`${'b'.repeat(70)}\n\n${'c'.repeat(30)}`);
  });

  it('adds overlap between chunks when configured', () => {
    const text = `${'word '.repeat(30).trim()}\n\n${'next '.repeat(10).trim()}`;
    const chunks = chunkDocument('text', text, { maxChars: 150, overlapChars: 20 });

    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.text.startsWith('word')).toBe(true);
    expect(chunks[1]?.text.endsWith('next')).toBe(true);
  });

  it('rejects empty and whitespace-only documents', () => {
    expect(() => chunkDocument('text', '  \n\n ', opts, 'empty.txt')).toThrow(EmptyDocumentError);
  });
});

describe('markdown chunker', () => {
  const doc = [
    'Preface text.',
    '',
    '# Pricing',
    'Intro to pricing.',
    '',
    '## Refunds',
    'Refunds take 5 days.',
    '',
    '## Plans',
    'Two plans exist.',
    '',
    '# Support',
    'Call us.',
  ].join('\n');

  it('chunks per section and records the heading path', () => {
    const chunks = chunkDocument('markdown', doc, opts);

    expect(chunks.map((c) => c.metadata.headingPath)).toEqual([
      undefined,
      ['Pricing'],
      ['Pricing', 'Refunds'],
      ['Pricing', 'Plans'],
      ['Support'],
    ]);
    expect(chunks[2]?.text).toBe('## Refunds\nRefunds take 5 days.');
  });

  it('never merges across sections', () => {
    const chunks = chunkDocument('markdown', doc, { maxChars: 10_000, overlapChars: 0 });
    expect(chunks).toHaveLength(5);
  });

  it('skips heading-only sections but keeps their titles in child paths', () => {
    const chunks = chunkDocument('markdown', '# Top\n## Child\nBody here.', opts);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.metadata.headingPath).toEqual(['Top', 'Child']);
  });

  it('ignores # lines inside code fences', () => {
    const text = '# Real\nBefore.\n\n```bash\n# not a heading\necho hi\n```\n';
    const chunks = chunkDocument('markdown', text, { maxChars: 10_000, overlapChars: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('# not a heading');
  });

  it('repeats the heading on continuation chunks of a long section', () => {
    const text = `# Long\n${'a'.repeat(100)}\n\n${'b'.repeat(100)}`;
    const chunks = chunkDocument('markdown', text, opts);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]?.text.startsWith('# Long\n\n')).toBe(true);
    expect(chunks.every((c) => c.metadata.headingPath?.[0] === 'Long')).toBe(true);
  });
});

describe('csv chunker', () => {
  const csv = ['id,name', ...Array.from({ length: 10 }, (_, i) => `${i + 1},person-${i + 1}`)].join(
    '\n',
  );

  it('repeats the header in every chunk and tracks row ranges', () => {
    const chunks = chunkDocument('csv', csv, { maxChars: 50, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.startsWith('id,name\n'))).toBe(true);
    expect(chunks[0]?.metadata.rowStart).toBe(1);
    expect(chunks.at(-1)?.metadata.rowEnd).toBe(10);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.metadata.rowStart).toBe((chunks[i - 1]?.metadata.rowEnd as number) + 1);
    }
  });

  it('keeps a quoted multi-line field inside one record', () => {
    expect(splitCsvRecords('a,b\n1,"line1\nline2"\n2,x\n')).toEqual([
      'a,b',
      '1,"line1\nline2"',
      '2,x',
    ]);
  });

  it('puts an oversized row in its own chunk instead of splitting it', () => {
    const chunks = chunkDocument('csv', `h\n${'x'.repeat(200)}\nshort`, {
      maxChars: 50,
      overlapChars: 0,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe(`h\n${'x'.repeat(200)}`);
  });

  it('rejects a header-only file', () => {
    expect(() => chunkDocument('csv', 'id,name\n', opts)).toThrow(EmptyDocumentError);
  });
});
