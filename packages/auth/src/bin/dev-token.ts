#!/usr/bin/env node
import { join } from 'node:path';
import { devEnvironment, loadOrCreateDevIssuer } from '../dev-keys';

const USAGE = `Local development tokens (NOT for production).

  dev-token env                          print the AUTH_* exports a service needs
  dev-token mint --tenant <slug> [--user <id>] [--roles a,b] [--expires <seconds>]

Keys live in ./.dev-keys (override with GENAI_DEV_KEYS_DIR). Example:

  eval "$(npm run -s dev-token -w @genai/auth -- env)"
  TOKEN=$(npm run -s dev-token -w @genai/auth -- mint --tenant acme-bank --roles manager)
`;

function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined)
      throw new Error(`Bad arguments near "${name}"`);
    result[name.slice(2)] = value;
  }
  return result;
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  // npm runs workspace scripts from the package folder; INIT_CWD is where the user ran npm.
  const keysDir =
    process.env['GENAI_DEV_KEYS_DIR'] ??
    join(process.env['INIT_CWD'] ?? process.cwd(), '.dev-keys');
  const dev = loadOrCreateDevIssuer(keysDir);

  if (command === 'env') {
    for (const [name, value] of Object.entries(devEnvironment(dev))) {
      console.log(`export ${name}='${value}'`);
    }
    console.error('# development signing key: never use outside local development');
    return;
  }

  if (command === 'mint') {
    const f = flags(rest);
    if (!f['tenant']) throw new Error('--tenant is required');
    console.log(
      dev.issuer.mint({
        tenant: f['tenant'],
        ...(f['user'] && { userId: f['user'] }),
        ...(f['roles'] && {
          roles: f['roles']
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
        }),
        ...(f['expires'] && { expiresInSec: Number(f['expires']) }),
      }),
    );
    return;
  }

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
