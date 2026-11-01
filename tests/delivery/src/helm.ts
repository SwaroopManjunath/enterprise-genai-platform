import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

export const ROOT = resolve(__dirname, '../../..');
const CHARTS = resolve(ROOT, 'deploy/helm');
const HELM_IMAGE = 'alpine/helm:3.18.6';

const works = (command: string, args: string[]): boolean =>
  spawnSync(command, args, { stdio: 'ignore' }).status === 0;

/**
 * How to run Helm here: the binary if it is installed (as in CI), otherwise the same version in a
 * container. `undefined` means neither is available.
 */
function runner(): ((args: string[]) => string) | undefined {
  if (works('helm', ['version', '--short'])) {
    return (args) =>
      execFileSync('helm', args, {
        cwd: CHARTS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  }
  if (works('docker', ['info'])) {
    return (args) =>
      execFileSync(
        'docker',
        ['run', '--rm', '-v', `${CHARTS}:/charts`, '-w', '/charts', HELM_IMAGE, ...args],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
  }
  return undefined;
}

export const helm = runner();

/** These tests need Helm. CI always has it; a laptop without Helm or Docker skips them, loudly. */
export const helmAvailable = (): boolean => {
  if (helm) return true;
  if (process.env['CI']) throw new Error('Helm is required in CI');
  console.warn('Skipping chart tests: neither helm nor docker is available');
  return false;
};

export interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [field: string]: any;
}

/** Renders the chart with the full test values, plus overrides (`--set a.b=c`), as parsed manifests. */
export function render(sets: string[] = [], files = ['genai-platform/ci/full.yaml']): Manifest[] {
  const args = ['template', 'genai', 'genai-platform', '--namespace', 'genai'];
  for (const f of files) args.push('-f', f);
  for (const s of sets) args.push('--set', s);
  const out = (helm as (a: string[]) => string)(args);
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Manifest | null)
    .filter((d): d is Manifest => d !== null);
}

/** The error message Helm gives for values that make the chart refuse to render. */
export function renderError(sets: string[], files = ['genai-platform/ci/full.yaml']): string {
  try {
    render(sets, files);
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return e.stderr ?? e.message;
  }
  throw new Error(`expected the chart not to render with ${sets.join(' ')}`);
}

export const ofKind = (docs: Manifest[], kind: string): Manifest[] =>
  docs.filter((d) => d.kind === kind);
export const named = (docs: Manifest[], kind: string, name: string): Manifest =>
  ofKind(docs, kind).find((d) => d.metadata.name === name) as Manifest;
