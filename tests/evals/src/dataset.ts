import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeForMatch } from './text';

export const DATASETS_DIR = join(__dirname, '..', 'datasets');

const callerSchema = z.object({
  tenant: z.string().min(1),
  userId: z.string().min(1),
  roles: z.array(z.string()),
});

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string().min(1),
  /** A key into the dataset's `callers`: whose token the question is asked with. */
  caller: z.string().min(1),
  question: z.string().min(1),
  /** Is the answer in the documents this caller may read? If not, the right behaviour is to decline. */
  answerable: z.boolean(),
  /** The documents an answer should be drawn from and cite. */
  expectedDocuments: z.array(z.string()).default([]),
  /** Phrases the answer must contain; `a|b` accepts either. */
  facts: z.array(z.string()).default([]),
  /** Phrases the answer must NOT contain: a restricted fact, an injected instruction's payload. */
  forbidden: z.array(z.string()).default([]),
  /** Documents this caller must never be shown. */
  mustNotRetrieve: z.array(z.string()).default([]),
  /** The question itself is an attack and should be refused outright. */
  expectBlocked: z.boolean().default(false),
});

export const datasetSchema = z.object({
  name: z.string().min(1),
  callers: z.record(z.string(), callerSchema),
  cases: z.array(caseSchema).min(1),
});

export const corpusSchema = z.object({
  documents: z.array(
    z.object({
      tenant: z.string().min(1),
      documentId: z.string().min(1),
      filename: z.string().min(1),
      content: z.string().min(1),
      allowedRoles: z.array(z.string()).optional(),
    }),
  ),
});

export type Dataset = z.infer<typeof datasetSchema>;
export type EvalCase = Dataset['cases'][number];
export type Caller = Dataset['callers'][string];
export type Corpus = z.infer<typeof corpusSchema>;
export type CorpusDocument = Corpus['documents'][number];

export function loadDataset(file = join(DATASETS_DIR, 'support-qa.json')): Dataset {
  return datasetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function loadCorpus(file = join(DATASETS_DIR, 'corpus.json')): Corpus {
  return corpusSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Can this caller read this document? The same rule retrieval enforces: tenant, then role. */
export const mayRead = (doc: CorpusDocument, caller: Caller): boolean =>
  doc.tenant === caller.tenant &&
  (doc.allowedRoles === undefined ||
    doc.allowedRoles.length === 0 ||
    doc.allowedRoles.some((r) => caller.roles.includes(r)));

/**
 * Checks the dataset before it is trusted. A wrong gold label produces a failing score that looks
 * like a quality regression, or worse a passing one that means nothing, so each case is checked
 * against the corpus: expected documents exist and are readable by the caller, every fact can
 * actually be found in an expected document, and a "must not see" document really is out of reach.
 */
export function checkDataset(dataset: Dataset, corpus: Corpus): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const c of dataset.cases) {
    const at = (message: string) => problems.push(`${c.id}: ${message}`);
    if (ids.has(c.id)) at('duplicate case id');
    ids.add(c.id);

    const caller = dataset.callers[c.caller];
    if (!caller) {
      at(`unknown caller "${c.caller}"`);
      continue;
    }
    const find = (documentId: string) =>
      corpus.documents.find((d) => d.documentId === documentId && d.tenant === caller.tenant);

    if (c.answerable) {
      if (c.expectedDocuments.length === 0) at('an answerable case needs expectedDocuments');
      if (c.facts.length === 0) at('an answerable case needs facts');
      if (c.expectBlocked) at('an answerable case cannot expect to be blocked');
    } else {
      if (c.facts.length > 0) at('an unanswerable case must not list facts');
      if (c.expectedDocuments.length > 0)
        at('an unanswerable case must not list expectedDocuments');
    }

    const expected = c.expectedDocuments.map((id) => ({ id, doc: find(id) }));
    for (const { id, doc } of expected) {
      if (!doc) at(`expected document "${id}" does not exist for tenant ${caller.tenant}`);
      else if (!mayRead(doc, caller)) at(`the caller may not read expected document "${id}"`);
    }

    if (c.answerable && expected.every((e) => e.doc)) {
      const text = normalizeForMatch(expected.map((e) => e.doc?.content ?? '').join(' '));
      for (const fact of c.facts) {
        const found = fact
          .split('|')
          .some((alt) => ` ${text} `.includes(` ${normalizeForMatch(alt)} `));
        if (!found) at(`fact "${fact}" is not in the expected documents`);
      }
    }

    // A "must not see" document may belong to another tenant (a cross-tenant leak check), so it is
    // looked up by id across the corpus. It is only a meaningful check if the caller cannot read it.
    for (const id of c.mustNotRetrieve) {
      const docs = corpus.documents.filter((d) => d.documentId === id);
      if (docs.length === 0) at(`mustNotRetrieve document "${id}" does not exist`);
      else if (docs.some((d) => mayRead(d, caller)))
        at(`the caller may read "${id}", so it cannot be a leak`);
    }

    for (const fact of c.facts) {
      if (c.forbidden.some((f) => normalizeForMatch(f) === normalizeForMatch(fact))) {
        at(`"${fact}" is both a required fact and a forbidden string`);
      }
    }
  }

  for (const doc of corpus.documents) {
    const twin = corpus.documents.filter(
      (d) => d.documentId === doc.documentId && d.tenant === doc.tenant,
    );
    if (twin.length > 1)
      problems.push(`corpus: duplicate document ${doc.tenant}/${doc.documentId}`);
  }
  return problems;
}

/** Cases per category, for the sample-size check. */
export function countByCategory(dataset: Dataset): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of dataset.cases) counts[c.category] = (counts[c.category] ?? 0) + 1;
  return counts;
}
