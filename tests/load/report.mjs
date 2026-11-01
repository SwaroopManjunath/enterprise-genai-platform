// Turns the k6 summaries, the container samples and what Prometheus saw into a report.
//   node tests/load/report.mjs <name> <rate>...
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const [name, ...rates] = process.argv.slice(2);
const dir = join(root, 'tests/load/results', name);
const PROM = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';

const num = (n, d = 1) => (n === undefined || Number.isNaN(n) ? 'n/a' : Number(n).toFixed(d));
const prom = async (query) => {
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`);
    return (await res.json()).data.result;
  } catch {
    return [];
  }
};
// A counter that never moved has no series; that is zero, not unknown.
const scalar = async (query) => Number((await prom(`(${query}) or vector(0)`))[0]?.value[1] ?? NaN);

const rows = rates.map((rate) => {
  const file = join(dir, `rate-${rate}.json`);
  if (!existsSync(file)) return { rate: Number(rate), missing: true };
  const m = JSON.parse(readFileSync(file, 'utf8')).metrics;
  const d = m.answer_ms ?? m.http_req_duration;
  return {
    rate: Number(rate),
    requests: m.http_reqs?.count,
    achieved: m.http_reqs?.rate,
    failedShare: m.http_req_failed?.value ?? m.http_req_failed?.rate ?? 0,
    refusals: m.limit_refusals?.count ?? 0,
    dropped: m.dropped_iterations?.count ?? 0,
    p50: d?.med,
    p95: d?.['p(95)'],
    p99: d?.['p(99)'],
    max: d?.max,
    avg: d?.avg,
    cacheHits: m.cache_hits?.count ?? 0,
    tokens: m.tokens_used?.count ?? 0,
    grounded: m.grounded_answers?.count ?? 0,
  };
});

// peak CPU and memory per service during each rate, from docker stats
const peaks = {};
if (existsSync(join(dir, 'stats.csv'))) {
  for (const line of readFileSync(join(dir, 'stats.csv'), 'utf8').split('\n').filter(Boolean)) {
    const [rate, container, cpu, mem] = line.split(',');
    const service = container.replace(/^genai-/, '').replace(/-\d+$/, '');
    if (!['assistant', 'llm-gateway', 'retrieval', 'prompt-registry'].includes(service)) continue;
    const used = mem.split('/')[0].trim();
    const mib = used.endsWith('GiB') ? parseFloat(used) * 1024 : parseFloat(used);
    const key = `${rate}|${service}`;
    peaks[key] = {
      cpu: Math.max(peaks[key]?.cpu ?? 0, parseFloat(cpu)),
      mem: Math.max(peaks[key]?.mem ?? 0, mib),
    };
  }
}

const SLOW_MS = 1000;
const ok = (r) => !r.missing && r.failedShare < 0.01 && r.dropped === 0 && r.p95 < SLOW_MS;
const sustained = rows.filter(ok).at(-1);

const totals = {
  calls: await scalar('sum(genai_llm_calls_total{outcome=~"ok|fallback_served"})'),
  fallbacks: await scalar('sum(genai_llm_calls_total{outcome="fallback_served"})'),
  errors: await scalar('sum(genai_llm_calls_total{outcome="error"})'),
  rejected: await scalar('sum(genai_llm_calls_total{outcome="rejected"})'),
  promptTokens: await scalar('sum(genai_llm_tokens_total{direction="prompt"})'),
  completionTokens: await scalar('sum(genai_llm_tokens_total{direction="completion"})'),
  microUsd: await scalar('sum(genai_llm_cost_total)'),
  cacheHit: await scalar('sum(genai_assistant_answers_total{outcome="cache_hit"})'),
  answers: await scalar('sum(genai_assistant_answers_total)'),
};
const alerts = (
  await (async () => {
    try {
      return (await (await fetch(`${PROM}/api/v1/alerts`)).json()).data.alerts;
    } catch {
      return [];
    }
  })()
)
  .filter((a) => a.state === 'firing' || a.state === 'pending')
  .map((a) => `${a.labels.alertname} (${a.state})`);

const lines = [
  `# Load test: ${name}`,
  '',
  `Model: ${process.env.MODEL ?? 'mock'}. Answer cache: ${process.env.CACHE_MODE ?? 'off'}. Each rate held for ${process.env.DURATION ?? '30s'}, ${process.env.STREAM === '1' ? 'streamed' : 'whole'} answers, arrivals at a fixed rate (open model).`,
  `Run on ${process.platform}/${process.arch}, containers in Docker Desktop (8 CPUs, 7.7 GiB shared with the load generator and the monitoring stack).`,
  '',
  '| Offered req/s | Achieved req/s | Failed | Dropped | p50 ms | p95 ms | p99 ms | max ms |',
  '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((r) =>
    r.missing
      ? `| ${r.rate} | no result | | | | | | |`
      : `| ${r.rate} | ${num(r.achieved)} | ${num(r.failedShare * 100, 2)}% | ${r.dropped} | ${num(r.p50, 0)} | ${num(r.p95, 0)} | ${num(r.p99, 0)} | ${num(r.max, 0)} |`,
  ),
  '',
  sustained
    ? `Highest rate that stayed healthy (under 1% failed, nothing dropped, p95 under ${SLOW_MS} ms): **${sustained.rate} req/s**.`
    : `No rate stayed healthy (under 1% failed, nothing dropped, p95 under ${SLOW_MS} ms).`,
  '',
  '"Dropped" are arrivals k6 could not start because every virtual user was busy: the system, or the machine, could not keep up.',
  '',
  '## Peak resource use during each rate',
  '',
  '| Offered req/s | assistant CPU / MiB | llm-gateway CPU / MiB | retrieval CPU / MiB | prompt-registry CPU / MiB |',
  '| ---: | --- | --- | --- | --- |',
  ...rates.map((rate) => {
    const cell = (s) =>
      peaks[`${rate}|${s}`]
        ? `${num(peaks[`${rate}|${s}`].cpu, 0)}% / ${num(peaks[`${rate}|${s}`].mem, 0)}`
        : 'n/a';
    return `| ${rate} | ${cell('assistant')} | ${cell('llm-gateway')} | ${cell('retrieval')} | ${cell('prompt-registry')} |`;
  }),
  '',
  '(100% is one CPU core.)',
  '',
  '## What the platform recorded',
  '',
  `- Model calls: ${num(totals.calls, 0)} served, ${num(totals.fallbacks, 0)} by the fallback, ${num(totals.errors, 0)} failed, ${num(totals.rejected, 0)} refused by a limit.`,
  `- Answers: ${num(totals.answers, 0)}, of which ${num(totals.cacheHit, 0)} came from the cache.`,
  `- Tokens: ${num(totals.promptTokens, 0)} prompt, ${num(totals.completionTokens, 0)} completion.`,
  totals.microUsd > 0
    ? `- Spend: $${num(totals.microUsd / 1e6, 4)} at the configured prices.`
    : '- Spend: not priced (the stand-in model has no price).',
  `- Alerts pending or firing at the end: ${alerts.length > 0 ? alerts.join(', ') : 'none'}.`,
  '',
];

mkdirSync(join(root, 'docs/proof'), { recursive: true });
writeFileSync(join(root, 'docs/proof', `load-${name}.md`), `${lines.join('\n')}\n`);
writeFileSync(
  join(root, 'docs/proof', `load-${name}.json`),
  `${JSON.stringify({ name, rows, totals, alerts, peaks }, null, 2)}\n`,
);
console.log(lines.join('\n'));
