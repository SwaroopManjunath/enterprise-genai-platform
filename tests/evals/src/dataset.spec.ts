import {
  checkDataset,
  corpusSchema,
  countByCategory,
  datasetSchema,
  loadCorpus,
  loadDataset,
  mayRead,
  type Corpus,
  type Dataset,
} from './dataset';

const corpus: Corpus = corpusSchema.parse({
  documents: [
    {
      tenant: 'acme',
      documentId: 'faq',
      filename: 'faq.md',
      content: '# Refunds\nRefunds take five working days.',
    },
    {
      tenant: 'acme',
      documentId: 'salary',
      filename: 's.md',
      content: '# Pay\nBands start at M1.',
      allowedRoles: ['manager'],
    },
    {
      tenant: 'globex',
      documentId: 'faq',
      filename: 'faq.md',
      content: '# Refunds\nTen working days.',
    },
  ],
});
const base: Dataset = datasetSchema.parse({
  name: 'test',
  callers: {
    analyst: { tenant: 'acme', userId: 'bob', roles: ['analyst'] },
    manager: { tenant: 'acme', userId: 'alice', roles: ['manager'] },
  },
  cases: [
    {
      id: 'ok',
      category: 'faq',
      caller: 'analyst',
      question: 'q',
      answerable: true,
      expectedDocuments: ['faq'],
      facts: ['five working days'],
    },
    {
      id: 'denied',
      category: 'denied',
      caller: 'analyst',
      question: 'q',
      answerable: false,
      forbidden: ['M1'],
      mustNotRetrieve: ['salary'],
    },
  ],
});
const withCase = (extra: object): Dataset =>
  datasetSchema.parse({
    ...base,
    cases: [
      ...base.cases,
      { id: 'x', category: 'faq', caller: 'analyst', question: 'q', answerable: true, ...extra },
    ],
  });

describe('checkDataset', () => {
  it('accepts a sound dataset', () => {
    expect(checkDataset(base, corpus)).toEqual([]);
  });

  it.each([
    [
      'an expected document that does not exist',
      { expectedDocuments: ['nope'], facts: ['x'] },
      /does not exist/,
    ],
    [
      'an expected document the caller may not read',
      { expectedDocuments: ['salary'], facts: ['M1'] },
      /may not read/,
    ],
    [
      'a fact that is not in the expected documents',
      { expectedDocuments: ['faq'], facts: ['one hour'] },
      /not in the expected documents/,
    ],
    ['an answerable case with no facts', { expectedDocuments: ['faq'] }, /needs facts/],
    [
      'an answerable case with no expected documents',
      { facts: ['five working days'] },
      /needs expectedDocuments/,
    ],
    [
      'a fact that is also forbidden',
      {
        expectedDocuments: ['faq'],
        facts: ['five working days'],
        forbidden: ['Five working days'],
      },
      /both a required fact and a forbidden/,
    ],
    [
      'a document of another tenant',
      { expectedDocuments: ['faq'], facts: ['ten working days'] },
      /not in the expected documents/,
    ],
  ])('rejects %s', (_label, extra, expected) => {
    expect(checkDataset(withCase(extra), corpus).join('\n')).toMatch(expected);
  });

  it('rejects a "must not see" document the caller can in fact read, since it could never leak', () => {
    const vacuous = datasetSchema.parse({
      ...base,
      cases: [
        {
          id: 'v',
          category: 'denied',
          caller: 'manager',
          question: 'q',
          answerable: false,
          mustNotRetrieve: ['salary'],
        },
      ],
    });

    expect(checkDataset(vacuous, corpus).join('\n')).toMatch(
      /may read "salary", so it cannot be a leak/,
    );
  });

  it('allows a "must not see" document that belongs to another tenant, and rejects one that exists nowhere', () => {
    const crossTenant = datasetSchema.parse({
      ...base,
      callers: { ...base.callers, other: { tenant: 'globex', userId: 'gina', roles: ['analyst'] } },
      cases: [
        {
          id: 'c',
          category: 'tenant',
          caller: 'other',
          question: 'q',
          answerable: false,
          mustNotRetrieve: ['salary'],
        },
        {
          id: 'd',
          category: 'tenant',
          caller: 'other',
          question: 'q',
          answerable: false,
          mustNotRetrieve: ['ghost'],
        },
      ],
    });

    const problems = checkDataset(crossTenant, corpus);

    expect(problems).toEqual(['d: mustNotRetrieve document "ghost" does not exist']);
  });

  it('rejects an unanswerable case that lists facts, an unknown caller, and a duplicate id', () => {
    const bad = datasetSchema.parse({
      ...base,
      cases: [
        {
          id: 'a',
          category: 'x',
          caller: 'analyst',
          question: 'q',
          answerable: false,
          facts: ['f'],
        },
        { id: 'a', category: 'x', caller: 'ghost', question: 'q', answerable: false },
      ],
    });

    const problems = checkDataset(bad, corpus).join('\n');
    expect(problems).toMatch(/must not list facts/);
    expect(problems).toMatch(/unknown caller "ghost"/);
    expect(problems).toMatch(/duplicate case id/);
  });
});

describe('mayRead', () => {
  it('follows the retrieval rule: same tenant, then an allowed role (or no restriction)', () => {
    const [open, restricted, other] = corpus.documents as [
      Corpus['documents'][number],
      Corpus['documents'][number],
      Corpus['documents'][number],
    ];
    const analyst = base.callers['analyst'] as Dataset['callers'][string];
    const manager = base.callers['manager'] as Dataset['callers'][string];

    expect(mayRead(open, analyst)).toBe(true);
    expect(mayRead(restricted, analyst)).toBe(false);
    expect(mayRead(restricted, manager)).toBe(true);
    expect(mayRead(other, analyst)).toBe(false);
  });
});

describe('the real dataset', () => {
  const dataset = loadDataset();
  const real = loadCorpus();

  it('is sound: every gold label is consistent with the corpus', () => {
    expect(checkDataset(dataset, real)).toEqual([]);
  });

  it('covers the behaviours that matter, each with enough cases to mean something', () => {
    const counts = countByCategory(dataset);

    expect(Object.keys(counts).sort()).toEqual([
      'faq',
      'injection',
      'known-gaps',
      'multi-source',
      'no-answer',
      'paraphrase',
      'pii',
      'restricted-allowed',
      'restricted-denied',
      'tenant',
    ]);
    for (const [category, n] of Object.entries(counts))
      expect({ category, n: n >= 2 }).toEqual({ category, n: true });
    expect(dataset.cases.length).toBeGreaterThanOrEqual(40);
  });

  it('includes a restricted document, a poisoned one, one with sensitive data and two tenants', () => {
    expect(real.documents.some((d) => (d.allowedRoles?.length ?? 0) > 0)).toBe(true);
    expect(real.documents.some((d) => /IGNORE ALL PREVIOUS INSTRUCTIONS/.test(d.content))).toBe(
      true,
    );
    expect(real.documents.some((d) => /DE89 3704/.test(d.content))).toBe(true);
    expect(new Set(real.documents.map((d) => d.tenant)).size).toBe(2);
  });
});
