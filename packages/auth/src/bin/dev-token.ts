#!/usr/bin/env node
import { join } from 'node:path';
import { devEnvironment, loadOrCreateDevIssuer } from '../dev-keys';
import { readFileSync } from 'node:fs';
import { parseDevClients, startDevTokenEndpoint } from '../dev-token-endpoint';

const USAGE = `Local development tokens (NOT for production).

  dev-token env                          print the AUTH_* exports a service needs
  dev-token mint --tenant <slug> [--user <id>] [--roles a,b] [--expires <seconds>]
                 [--audience <api://app>]
  dev-token obo-server [--port 4000] [--client-id assistant] [--client-secret dev-secret]
                       [--audience api://assistant]
                                         stand-in for Entra's on-behalf-of token endpoint
  dev-token idp --clients-file <json> [--port 4000] [--host 0.0.0.0]
                                         the same stand-in for several services at once, listening
                                         on a container network (a clients file maps each client id
                                         to its secret, audience and optional roles)

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

async function main(argv: string[]): Promise<void> {
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
        ...(f['audience'] && { audience: f['audience'] }),
      }),
    );
    return;
  }

  if (command === 'obo-server') {
    const f = flags(rest);
    const clientId = f['client-id'] ?? 'assistant';
    const endpoint = await startDevTokenEndpoint(
      {
        issuer: dev.issuer,
        clients: {
          [clientId]: {
            secret: f['client-secret'] ?? 'dev-secret',
            audience: f['audience'] ?? 'api://assistant',
          },
        },
      },
      Number(f['port'] ?? 4000),
    );
    console.error(`dev OBO token endpoint for client "${clientId}": ${endpoint.url}`);
    console.error('development only; press Ctrl-C to stop');
    return;
  }

  if (command === 'idp') {
    const f = flags(rest);
    if (!f['clients-file']) throw new Error('--clients-file is required');
    const clients = parseDevClients(readFileSync(f['clients-file'], 'utf8'));
    const endpoint = await startDevTokenEndpoint(
      { issuer: dev.issuer, clients },
      Number(f['port'] ?? 4000),
      f['host'] ?? '127.0.0.1',
    );
    console.error(`dev token endpoint for ${Object.keys(clients).join(', ')}: ${endpoint.url}`);
    console.error(`public keys: ${dev.jwksPath}`);
    console.error('development only; press Ctrl-C to stop');
    return;
  }

  console.error(USAGE);
  process.exitCode = command ? 1 : 0;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
