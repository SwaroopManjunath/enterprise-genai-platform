import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderDashboard, renderRules } from '../slo';

/** Where each generated file lives, relative to the repository root. */
export const OUTPUTS: Record<string, () => string> = {
  'ops/prometheus/rules.yaml': renderRules,
  'ops/grafana/genai-platform.json': renderDashboard,
};

/**
 * `generate` writes the files; `--check` fails if what is committed differs from what the code
 * would produce now, so the SLO definitions and the rules Prometheus runs cannot drift apart.
 */
export function main(argv: string[], root = resolve(__dirname, '../../../..')): number {
  const check = argv.includes('--check');
  let stale = 0;
  for (const [path, render] of Object.entries(OUTPUTS)) {
    const file = resolve(root, path);
    const wanted = render();
    if (check) {
      const current = (() => {
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return undefined;
        }
      })();
      if (current !== wanted) {
        console.error(`stale: ${path} (run \`npm run ops:generate\`)`);
        stale++;
      }
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, wanted);
      console.log(`wrote ${path}`);
    }
  }
  return stale > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
