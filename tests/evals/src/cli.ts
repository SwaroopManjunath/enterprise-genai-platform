/**
 * `npm run eval`: runs the evaluation and exits non-zero if the gate fails.
 *
 *   --variant <name>     score a degraded variant instead of the system as it is
 *   --self-test          check that every degraded variant is caught by the gate
 *   --update-baseline    record the current scores as the baseline (a reviewed change)
 *   --model azure        answer with a real Azure OpenAI deployment (see docs/proof/README.md),
 *                        judged by the model-based judge, with its own thresholds and baseline
 *   --runs <n>           run each case n times; the gate then judges a confidence bound, not an average
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { azureFromEnv } from '../../e2e/src/azure-model';
import { checkDataset, loadCorpus, loadDataset } from './dataset';
import { loadBaseline, loadThresholds, type Baseline } from './gate';
import { LexicalJudge, LlmJudge, type Judge } from './judge';
import { loadMetaExamples } from './judge-meta';
import { renderConsole, renderMarkdown, type EvalReport } from './report';
import { runEvaluation } from './runner';
import { VARIANTS, variantNames, type Variant } from './variants';

const ROOT = join(__dirname, '..');
const azure =
  process.argv.includes('--model') && process.argv[process.argv.indexOf('--model') + 1] === 'azure';
// A real model is held to its own thresholds and baseline: the stand-in's perfect scores say nothing about it.
const BASELINE_FILE = join(ROOT, azure ? 'baseline.azure.json' : 'baseline.json');
const THRESHOLDS_FILE = join(ROOT, azure ? 'thresholds.azure.json' : 'thresholds.json');
const RESULTS_DIR = join(ROOT, 'results');

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function evaluate(variant: Variant, useBaseline = true): Promise<EvalReport> {
  const dataset = loadDataset();
  const corpus = loadCorpus();
  const problems = checkDataset(dataset, corpus);
  if (problems.length > 0) {
    console.error(`The dataset is not sound:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(2);
  }
  const model = azure ? azureFromEnv() : undefined;
  const judge: Judge = model ? new LlmJudge(model.judge) : new LexicalJudge();
  return runEvaluation({
    dataset,
    corpus,
    variant,
    judge,
    judgeExamples: loadMetaExamples(),
    thresholds: loadThresholds(THRESHOLDS_FILE),
    baseline: useBaseline ? loadBaseline(BASELINE_FILE) : undefined,
    runs: Number(option('runs') ?? 1),
    ...(model && {
      stack: { providers: [model.provider], prices: model.prices },
      model: { answers: model.deployment, judge: model.judgeDeployment },
    }),
  });
}

function save(report: EvalReport): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const markdown = renderMarkdown(report);
  const file = azure ? `${report.variant}.azure` : report.variant;
  writeFileSync(join(RESULTS_DIR, `${file}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(RESULTS_DIR, `${file}.md`), markdown);
  return markdown;
}

async function selfTest(): Promise<number> {
  console.log(
    'Self-test: each degraded variant must be caught by the gate, and the system as it is must pass.\n',
  );
  let wrong = 0;
  for (const name of variantNames) {
    const variant = VARIANTS[name] as Variant;
    const report = await evaluate(variant);
    // a metric can fail both its threshold and its regression check: name it once
    const failed = [...new Set(report.gate.checks.filter((c) => !c.passed).map((c) => c.name))];
    const expected = variant.expectedFailures;
    const handled =
      variant.expectGate === 'fail'
        ? !report.gate.passed && expected.every((m) => failed.includes(m))
        : report.gate.passed;
    if (!handled) wrong += 1;

    let detail: string;
    if (variant.expectGate === 'pass')
      detail = report.gate.passed ? 'passes' : `FAILED: ${failed.join(', ')}`;
    else if (report.gate.passed) detail = 'NOT CAUGHT';
    else detail = `caught by ${failed.join(', ')}`;
    console.log(`  ${handled ? 'ok ' : 'BAD'}  ${name.padEnd(20)} ${detail}`);
  }
  console.log(
    wrong === 0
      ? '\nSELF-TEST PASSED: the gate catches every regression it was shown.'
      : `\nSELF-TEST FAILED: ${wrong} variant(s) were not handled as expected.`,
  );
  return wrong === 0 ? 0 : 1;
}

async function updateBaseline(): Promise<number> {
  const report = await evaluate(VARIANTS['good'] as Variant, false);
  if (!report.gate.passed) {
    console.error(renderConsole(report));
    console.error('\nThe baseline is only recorded from a build that passes the thresholds.');
    return 1;
  }
  const baseline: Baseline = {
    cases: report.gated.cases,
    judgeAccuracy: report.judge.accuracy,
    metrics: report.gated.metrics as Baseline['metrics'],
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(renderConsole(report));
  console.log(
    `\nBaseline written to ${BASELINE_FILE}. Review and commit it: it is what quality may not fall below.`,
  );
  return 0;
}

async function main(): Promise<number> {
  if (flag('self-test')) return selfTest();
  if (flag('update-baseline')) return updateBaseline();

  const name = option('variant') ?? 'good';
  const variant = VARIANTS[name];
  if (!variant) {
    console.error(`Unknown variant "${name}". Choose one of: ${variantNames.join(', ')}`);
    return 2;
  }
  const report = await evaluate(variant);
  const markdown = save(report);
  console.log(renderConsole(report));
  console.log(`\nFull report: ${join(RESULTS_DIR, `${azure ? `${name}.azure` : name}.md`)}`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, `${markdown}\n`);
  return report.gate.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
