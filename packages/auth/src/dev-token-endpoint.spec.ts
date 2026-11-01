import { EnvSecretProvider } from './secrets/env-secret-provider';
import { EntraOboClient, type OboExchangeError } from './obo/obo-client';
import {
  parseDevClients,
  startDevTokenEndpoint,
  type RunningDevTokenEndpoint,
} from './dev-token-endpoint';
import { AuthenticationError } from './principal';
import { TestIssuer } from './test-issuer';

const issuer = new TestIssuer();
const ASSISTANT_AUDIENCE = 'api://assistant';

describe('dev token endpoint with the real OBO client', () => {
  let endpoint: RunningDevTokenEndpoint;

  beforeAll(async () => {
    endpoint = await startDevTokenEndpoint({
      issuer,
      clients: { assistant: { secret: 'dev-secret', audience: ASSISTANT_AUDIENCE } },
    });
  });
  afterAll(async () => {
    await endpoint.close();
  });

  const clientWith = (secret: string) =>
    new EntraOboClient({
      tokenEndpoint: endpoint.url,
      clientId: 'assistant',
      clientSecretName: 'assistant-secret',
      secrets: new EnvSecretProvider({ SECRET_ASSISTANT_SECRET: secret }),
    });

  const userToken = (overrides: Parameters<TestIssuer['mint']>[0] = { tenant: 'acme-bank' }) =>
    issuer.mint({
      audience: ASSISTANT_AUDIENCE,
      userId: 'alice',
      roles: ['manager'],
      ...overrides,
    });

  const rejection = (promise: Promise<unknown>): Promise<OboExchangeError> =>
    promise.then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error as OboExchangeError,
    );

  it('issues a downstream token that still names the same user, tenant and roles', async () => {
    const token = await clientWith('dev-secret').exchange(userToken(), 'api://retrieval/.default');

    const principal = await issuer.verifier(30, 'api://retrieval').verify(token);

    expect(principal).toMatchObject({
      tenantId: 'acme-bank',
      userId: 'alice',
      roles: ['manager'],
    });
  });

  it('binds the new token to the downstream API: other services reject it', async () => {
    const token = await clientWith('dev-secret').exchange(userToken(), 'api://retrieval/.default');

    await expect(issuer.verifier(30, 'api://gateway').verify(token)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(issuer.verifier(30, ASSISTANT_AUDIENCE).verify(token)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('refuses an unknown client or a wrong secret', async () => {
    const error = await rejection(
      clientWith('wrong').exchange(userToken(), 'api://retrieval/.default'),
    );
    expect(error.code).toBe('invalid_client');
  });

  it('refuses a user token that is expired, forged, or meant for another API', async () => {
    const client = clientWith('dev-secret');
    const scope = 'api://retrieval/.default';

    for (const bad of [
      userToken({ tenant: 'acme', expiresInSec: -999 }),
      issuer.forge.otherKey({ tenant: 'acme', audience: ASSISTANT_AUDIENCE }),
      issuer.mint({ tenant: 'acme', audience: 'api://retrieval' }), // not for the assistant
    ]) {
      expect((await rejection(client.exchange(bad, scope))).code).toBe('invalid_grant');
    }
  });

  it('refuses a malformed scope', async () => {
    const error = await rejection(
      clientWith('dev-secret').exchange(userToken(), 'https://evil.example/.default'),
    );
    expect(error.code).toBe('invalid_scope');
  });
});

describe('parseDevClients', () => {
  it('reads several services with their secrets, audiences and roles', () => {
    expect(
      parseDevClients(
        JSON.stringify({
          assistant: { secret: 's1', audience: 'api://assistant' },
          ingestion: { secret: 's2', audience: 'api://ingestion', roles: ['indexer'] },
        }),
      ),
    ).toEqual({
      assistant: { secret: 's1', audience: 'api://assistant' },
      ingestion: { secret: 's2', audience: 'api://ingestion', roles: ['indexer'] },
    });
  });

  it.each([
    ['not an object', '[]'],
    ['a client with no secret', '{"a":{"audience":"api://a"}}'],
    ['a client with an empty secret', '{"a":{"secret":"","audience":"api://a"}}'],
    ['a client with no audience', '{"a":{"secret":"s"}}'],
    ['roles that are not strings', '{"a":{"secret":"s","audience":"api://a","roles":[1]}}'],
  ])('refuses %s', (_label, text) => {
    expect(() => parseDevClients(text)).toThrow();
  });

  it('can listen on another address, for use inside a container network', async () => {
    const endpoint = await startDevTokenEndpoint({ issuer, clients: {} }, 0, '0.0.0.0');
    try {
      const response = await fetch(endpoint.url, {
        method: 'GET',
      });
      expect(response.status).toBe(405);
    } finally {
      await endpoint.close();
    }
  });
});
