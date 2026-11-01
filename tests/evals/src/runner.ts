import { startStack, type Stack } from '../../e2e/src/stack';
import { byCategory, aggregate } from './aggregate';
import type { Caller, Corpus, Dataset, EvalCase } from './dataset';
import { evaluateCase, topK, type Observation } from './evaluate';
import { evaluateGate, type Baseline, type Thresholds } from './gate';
import type { Judge, Judgement } from './judge';
import { measureJudge, type MetaExample } from './judge-meta';
import type { EvalReport } from './report';
import type { Variant } from './variants';

export interface RunInput {
  dataset: Dataset;
  corpus: Corpus;
  variant: Variant;
  judge: Judge;
  judgeExamples: readonly MetaExample[];
  thresholds: Thresholds;
  baseline: Baseline | undefined;
}

/**
 * Runs the whole dataset through the real services (ingestion, retrieval, prompt registry, gateway,
 * assistant, over HTTP) and scores it. Retrieval is also asked directly, as the same user, so the
 * retrieval metrics are measured on retrieval itself and the judge sees the full text of every
 * chunk an answer was built from.
 */
export async function runEvaluation(input: RunInput): Promise<EvalReport> {
  // The point is to score the system, not to hit the gateway's per-minute limit for one tenant.
  process.env['DEFAULT_REQUESTS_PER_MINUTE'] ??= '100000';
  const { dataset, corpus, variant, judge, thresholds } = input;

  const stack = await startStack({ cacheMode: 'off', ...variant.stack });
  try {
    for (const doc of corpus.documents) {
      if (variant.skipDocuments?.includes(doc.documentId)) continue;
      const { status } = await stack.uploadAndWait(doc.tenant, {
        documentId: doc.documentId,
        filename: doc.filename,
        content: doc.content,
        ...(doc.allowedRoles && { allowedRoles: doc.allowedRoles }),
      });
      if (status !== 'succeeded')
        throw new Error(`could not index ${doc.tenant}/${doc.documentId}: ${status}`);
    }
    const tenants = [...new Set(Object.values(dataset.callers).map((c) => c.tenant))];
    await variant.setup?.(stack, tenants);

    const informational = thresholds.informationalCategories;
    const results = [];
    for (const c of dataset.cases) {
      const caller = dataset.callers[c.caller] as Caller;
      const seen = await observe(stack, caller, c);
      const judgement = await judgeAnswer(input.judge, seen);
      results.push(evaluateCase(c, seen, judgement, !(c.category in informational)));
    }

    const gatedResults = results.filter((r) => r.gated);
    const gated = aggregate(gatedResults);
    const categories = byCategory(gatedResults);
    const informationalResults = results.filter((r) => !r.gated);
    const informationalSummary = byCategory(informationalResults);

    const meta = await measureJudge(judge, input.judgeExamples);
    const gate = evaluateGate({
      aggregates: gated,
      categories,
      judgeAccuracy: meta.accuracy,
      thresholds,
      baseline: input.baseline,
    });

    return {
      variant: variant.name,
      dataset: dataset.name,
      judge: { name: judge.name, accuracy: meta.accuracy, knownMisses: meta.stillMissed },
      gate,
      gated,
      categories,
      informational: {
        ...(informationalResults.length > 0 && { aggregates: aggregate(informationalResults) }),
        categories: Object.fromEntries(
          Object.entries(informationalSummary).map(([name, s]) => [
            name,
            { ...s, reason: informational[name] ?? '' },
          ]),
        ),
      },
      results,
    };
  } finally {
    await stack.stop();
  }
}

/** Asks the question as the case's caller, and asks retrieval the same thing directly. */
async function observe(stack: Stack, caller: Caller, c: EvalCase): Promise<Observation> {
  const [search, ask] = [
    await stack.call('POST', 'retrieval', '/v1/search', {
      token: stack.token('retrieval', caller),
      body: { query: c.question, topK, mode: 'hybrid', rerank: true },
    }),
    await stack.ask(caller, c.question),
  ];
  const body = ask.body ?? {};
  return {
    httpStatus: ask.status,
    blocked: ask.status === 422 && body.error?.code === 'guardrail_blocked',
    ...(typeof body.answer === 'string' && { answer: body.answer }),
    retrieved: search.status === 200 ? search.body.results : [],
    cited: Array.isArray(body.citations)
      ? body.citations.map((x: { documentId: string; chunkId: string }) => ({
          documentId: x.documentId,
          chunkId: x.chunkId,
        }))
      : [],
    ...(body.usage?.totalTokens !== undefined && { tokens: body.usage.totalTokens }),
    ...(body.timings?.totalMs !== undefined && { totalMs: body.timings.totalMs }),
  };
}

/**
 * The judge reads the full text of the chunks an answer cites. An answer that cites nothing is
 * checked against everything retrieval returned, so an uncited answer cannot hide behind having no
 * source to compare with.
 */
async function judgeAnswer(judge: Judge, seen: Observation): Promise<Judgement | undefined> {
  if (seen.answer === undefined || seen.httpStatus !== 200) return undefined;
  const citedIds = new Set(seen.cited.map((x) => x.chunkId));
  const chunks = seen.retrieved.filter((r) => citedIds.has(r.chunkId));
  const sources = (chunks.length > 0 ? chunks : seen.retrieved).map((r) => r.text);
  return judge.groundedness(seen.answer, sources);
}
