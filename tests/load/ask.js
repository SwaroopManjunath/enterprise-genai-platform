// k6 script: asks questions through the assistant at a fixed arrival rate (an open model: new
// requests keep arriving whether or not earlier ones have finished, as real users do, so a slow
// system shows as queueing and latency rather than as the test politely slowing down).
//
//   RATE       requests per second (default 10)
//   DURATION   how long to hold it (default 30s)
//   TOKEN      a bearer token for the assistant
//   BASE_URL   the assistant (default http://assistant:3000)
//   NO_CACHE   "1" asks for a fresh answer every time
//   STREAM     "1" asks for streamed answers (the whole stream is read)
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const dataset = JSON.parse(open('/datasets/support-qa.json'));
// What an ordinary user asks: answerable questions, plus the ones with no answer. Attacks are left out
// so the numbers are about serving questions, not about refusing them.
const QUESTIONS = dataset.cases
  .filter(
    (c) =>
      c.caller === 'analyst' &&
      ['faq', 'paraphrase', 'multi-source', 'no-answer', 'pii'].includes(c.category),
  )
  .map((c) => c.question);

const rate = Number(__ENV.RATE || 10);
export const options = {
  scenarios: {
    ask: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: Math.max(20, rate),
      maxVUs: Math.max(200, rate * 8),
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const answerMs = new Trend('answer_ms', true);
const tokensUsed = new Counter('tokens_used');
const cacheHits = new Counter('cache_hits');
const grounded = new Counter('grounded_answers');
const refused = new Counter('limit_refusals');

export default function () {
  const question = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const body = {
    question,
    ...(__ENV.NO_CACHE === '1' && { noCache: true }),
    ...(__ENV.STREAM === '1' && { stream: true }),
  };
  const res = http.post(
    `${__ENV.BASE_URL || 'http://assistant:3000'}/v1/ask`,
    JSON.stringify(body),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.TOKEN}` },
      tags: { name: 'ask' },
    },
  );
  answerMs.add(res.timings.duration);
  check(res, { 'status is 200': (r) => r.status === 200 });
  if (res.status === 429) refused.add(1);
  if (res.status !== 200) return;
  if (__ENV.STREAM === '1') {
    // the last event is the authoritative answer
    grounded.add(res.body.includes('"grounded":true') ? 1 : 0);
    return;
  }
  const json = res.json();
  if (json.grounded) grounded.add(1);
  if (json.cache && json.cache.status === 'hit') cacheHits.add(1);
  if (json.usage) tokensUsed.add(json.usage.totalTokens);
}
