import type { Aggregates, CategorySummary } from './aggregate';
import type { CaseResult } from './evaluate';
import type { GateResult } from './gate';

export interface EvalReport {
  variant: string;
  dataset: string;
  judge: { name: string; accuracy: number; knownMisses: string[] };
  gate: GateResult;
  gated: Aggregates;
  categories: Record<string, CategorySummary>;
  informational: {
    aggregates?: Aggregates;
    categories: Record<string, CategorySummary & { reason: string }>;
  };
  results: CaseResult[];
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const mark = (passed: boolean): string => (passed ? 'pass' : 'FAIL');

/** The full report, for a person to read: the verdict, every check, the categories, the failures. */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const failedChecks = report.gate.checks.filter((c) => !c.passed);

  lines.push(`## Evaluation: ${report.gate.passed ? 'PASSED' : 'FAILED'}`, '');
  lines.push(
    `Variant \`${report.variant}\`, dataset \`${report.dataset}\`, ${report.gated.cases} gated cases (${report.gated.passed} fully correct), judge \`${report.judge.name}\`.`,
    '',
  );

  if (failedChecks.length > 0) {
    lines.push('### Why it failed', '');
    for (const check of failedChecks) lines.push(`- **${check.name}**: ${check.message}`);
    lines.push('');
  }

  lines.push('### Checks', '', '| Check | Kind | Result | Detail |', '| --- | --- | --- | --- |');
  for (const c of report.gate.checks) {
    lines.push(`| ${c.name} | ${c.kind} | ${mark(c.passed)} | ${c.message} |`);
  }
  lines.push('');

  lines.push('### By category', '', '| Category | Cases | Fully correct |', '| --- | --- | --- |');
  for (const [name, s] of Object.entries(report.categories))
    lines.push(`| ${name} | ${s.cases} | ${s.passed} |`);
  lines.push('');

  const informational = Object.entries(report.informational.categories);
  if (informational.length > 0) {
    lines.push(
      '### Reported, not gated',
      '',
      '| Category | Cases | Fully correct | Why it is not gated |',
      '| --- | --- | --- | --- |',
    );
    for (const [name, s] of informational)
      lines.push(`| ${name} | ${s.cases} | ${s.passed} | ${s.reason} |`);
    lines.push('');
  }

  const failed = report.results.filter((r) => r.failures.length > 0);
  if (failed.length > 0) {
    lines.push(`### Cases that went wrong (${failed.length})`, '');
    for (const r of failed) {
      lines.push(
        `- \`${r.id}\` (${r.category}${r.gated ? '' : ', not gated'}): ${r.failures.join('; ')}`,
      );
    }
    lines.push('');
  }

  lines.push(
    '### The judge',
    '',
    `Agrees with the labelled examples on ${pct(report.judge.accuracy)} of the ones it is expected to get right. Known to get wrong: ${report.judge.knownMisses.join(', ') || 'none'}.`,
    '',
  );
  return lines.join('\n');
}

/** A short version for a terminal. */
export function renderConsole(report: EvalReport): string {
  const out: string[] = [];
  out.push(
    `Evaluation of variant "${report.variant}" on ${report.gated.cases} gated cases (${report.gated.passed} fully correct)`,
  );
  out.push('');
  for (const c of report.gate.checks.filter((x) => x.kind === 'threshold' || x.kind === 'judge')) {
    out.push(`  ${mark(c.passed).padEnd(4)}  ${c.message}`);
  }
  const regressions = report.gate.checks.filter((c) => c.kind === 'regression' && !c.passed);
  for (const c of regressions) out.push(`  FAIL  regression: ${c.message}`);
  const sample = report.gate.checks.filter((c) => c.kind === 'sample' && !c.passed);
  for (const c of sample) out.push(`  FAIL  ${c.message}`);
  const failed = report.results.filter((r) => r.failures.length > 0 && r.gated);
  if (failed.length > 0) {
    out.push('', `  ${failed.length} case(s) went wrong:`);
    for (const r of failed.slice(0, 12)) out.push(`    ${r.id}: ${r.failures[0]}`);
    if (failed.length > 12) out.push(`    ... and ${failed.length - 12} more (see the report)`);
  }
  out.push('', report.gate.passed ? 'GATE: PASSED' : 'GATE: FAILED');
  return out.join('\n');
}
