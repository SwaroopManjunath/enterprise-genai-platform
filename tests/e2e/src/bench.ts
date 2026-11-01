/**
 * `npm run -s bench -w @genai/e2e`: runs the same stream of questions with the answer cache off, in
 * shadow mode and serving, against the real services, and prints what changed. The model is a
 * deterministic stand-in with illustrative prices, so what this measures is the platform's
 * behaviour (calls avoided, spend, how soon the reader sees an answer, wrong hits), not what a real
 * traffic mix or a real model would give. See ADR 0013.
 */
import { seedDocuments, startStack, type Caller, type Stack } from './stack';

const analyst: Caller = { tenant: 'acme-bank', userId: 'bob', roles: ['analyst'] };

/** Each group is one question asked in several ways that mean the same thing. */
const FAQ: string[][] = [
  [
    'How long do refunds take?',
    'how long does a refund take',
    'How long will refunds take??',
    'how long do refunds take',
  ],
  [
    'How can I block a lost card?',
    'how do i block a lost card',
    'How can a lost card be blocked?',
    'how can I block my lost card',
  ],
  [
    'What happens to a card that is blocked?',
    'what happens to a blocked card',
    'What happens to my blocked card?',
  ],
  ['How long do refunds take to reach the card?', 'how long does a refund take to reach the card'],
];

/** Pairs that are one word apart and mean different things: a cache must never treat them as one. */
const NOT_THE_SAME: [string, string][] = [
  ['Is the hotel limit 150 euros per night?', 'Is the hotel limit 200 euros per night?'],
  ['Can I block my lost card?', 'Can I not block my lost card?'],
  ['What happens before the card is blocked?', 'What happens after the card is blocked?'],
  ['Who can open an account?', 'Who can close an account?'],
  ['Look up customer C-7', 'Look up customer C-8'],
  ['Which limit is the maximum?', 'Which limit is the minimum?'],
  ['How long do refunds take?', 'How long do chargebacks take?'],
  ['What is the limit for managers?', 'What is the limit for analysts?'],
];

/** A small deterministic generator, so every run (and every mode) sees the same traffic. */
const random = (seed: number) => () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

function workload(count: number): string[] {
  const next = random(2026);
  const hot = FAQ.flatMap((variants, i) => variants.map((q) => ({ q, weight: 1 / (i + 1) })));
  const totalWeight = hot.reduce((sum, h) => sum + h.weight, 0);
  const questions: string[] = [];
  for (let i = 0; i < count; i++) {
    if (next() < 0.7) {
      let pick = next() * totalWeight;
      questions.push((hot.find((h) => (pick -= h.weight) <= 0) ?? hot[0])!.q);
    } else {
      // the long tail: questions that are genuinely different, so there is nothing to reuse
      questions.push(`Is the card limit ${100 + Math.floor(next() * 900)} euros per day?`);
    }
  }
  return questions;
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

interface Run {
  mode: string;
  requests: number;
  modelCalls: number;
  tokens: number;
  costUsd: number;
  hits: number;
  medianMs: number;
  p95Ms: number;
  shadowAgreement?: number;
}

async function run(mode: 'off' | 'shadow' | 'serve', questions: string[]): Promise<Run> {
  const stack = await startStack({ cacheMode: mode, streamDelayMs: 4 });
  try {
    await seedDocuments(stack);
    const waits: number[] = [];
    let hits = 0;
    for (const question of questions) {
      const answer = await stack.askStream(analyst, question);
      // a refused request would flatter whichever mode it hit, so it must never go unnoticed
      if (answer.status !== 200)
        throw new Error(`request refused with ${answer.status}: ${JSON.stringify(answer.error)}`);
      // how soon the reader has an answer: the first text, or all of it at once from the cache
      waits.push(answer.firstDeltaMs ?? answer.totalMs);
      if (answer.done?.cache?.status === 'hit') hits += 1;
    }
    const usage = (await stack.usage('acme-bank')).body.days[0];
    const stats = (await stack.cacheStats('acme-bank')).body;
    return {
      mode,
      requests: questions.length,
      modelCalls: usage?.requests ?? 0,
      tokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
      costUsd: usage?.costUsd ?? 0,
      hits,
      medianMs: percentile(waits, 50),
      p95Ms: percentile(waits, 95),
      ...(stats.shadow.agreementRate !== undefined && {
        shadowAgreement: stats.shadow.agreementRate,
      }),
    };
  } finally {
    await stack.stop();
  }
}

async function wrongHits(
  stack: Stack,
): Promise<{ checked: number; wrong: number; rewordingsServed: number; rewordings: number }> {
  let wrong = 0;
  for (const [first, second] of NOT_THE_SAME) {
    await stack.ask(analyst, first);
    const answer = await stack.ask(analyst, second);
    if (answer.body.cache?.status === 'hit') wrong += 1;
  }
  let served = 0;
  let total = 0;
  for (const variants of FAQ) {
    await stack.ask(analyst, variants[0] as string);
    for (const variant of variants.slice(1)) {
      total += 1;
      if ((await stack.ask(analyst, variant)).body.cache?.status === 'hit') served += 1;
    }
  }
  return { checked: NOT_THE_SAME.length, wrong, rewordingsServed: served, rewordings: total };
}

const fmt = (n: number, digits = 0) => n.toFixed(digits);

async function main(): Promise<void> {
  // The point is to compare modes, not to hit the gateway's per-minute limit for one tenant.
  process.env['DEFAULT_REQUESTS_PER_MINUTE'] = '100000';
  const questions = workload(120);
  const distinct = new Set(questions.map((q) => q.toLowerCase().replace(/[^a-z0-9 ]/g, ''))).size;
  console.log(
    `Workload: ${questions.length} requests, ${distinct} distinct wordings (70% repeat questions in assorted wordings, 30% unique).`,
  );
  console.log(
    'Model: deterministic stand-in at illustrative prices ($2.50 in / $10 out per million tokens).\n',
  );

  const off = await run('off', questions);
  const shadow = await run('shadow', questions);
  const serve = await run('serve', questions);

  const row = (r: Run) =>
    `${r.mode.padEnd(7)} ${String(r.requests).padStart(8)} ${String(r.modelCalls).padStart(11)} ${String(r.tokens).padStart(8)} ` +
    `${('$' + fmt(r.costUsd, 4)).padStart(9)} ${String(r.hits).padStart(5)} ${(fmt(r.medianMs) + ' ms').padStart(9)} ${(fmt(r.p95Ms) + ' ms').padStart(9)}`;
  console.log('mode    requests  model calls   tokens      cost  hits    median       p95');
  for (const r of [off, shadow, serve]) console.log(row(r));
  console.log('        (median / p95: how soon the reader sees the first text of the answer)');

  const saved = (a: number, b: number) => (a === 0 ? 0 : ((a - b) / a) * 100);
  console.log(
    `\nServing the cache: ${fmt(saved(off.modelCalls, serve.modelCalls))}% fewer model calls, ${fmt(saved(off.tokens, serve.tokens))}% fewer tokens, ${fmt(saved(off.costUsd, serve.costUsd))}% less spend.`,
  );
  console.log(
    `Median wait for the first text: ${fmt(off.medianMs)} ms without the cache, ${fmt(serve.medianMs)} ms with it.`,
  );
  console.log(
    `Shadow mode (nothing served): ${fmt((shadow.shadowAgreement ?? 0) * 100)}% of the answers it would have served matched a fresh one.`,
  );

  const stack = await startStack({ cacheMode: 'serve' });
  try {
    await seedDocuments(stack);
    const check = await wrongHits(stack);
    console.log(
      `\nWrong hits: ${check.wrong} of ${check.checked} pairs that differ by one word and mean something else.`,
    );
    console.log(
      `Rewordings served from the cache: ${check.rewordingsServed} of ${check.rewordings}.`,
    );
  } finally {
    await stack.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
