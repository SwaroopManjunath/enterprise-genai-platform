import { startDevTokenEndpoint, SERVICE_TENANT } from '../dev-token-endpoint';
import { EnvSecretProvider } from '../secrets/env-secret-provider';
import { TestIssuer } from '../test-issuer';
import { ClientCredentialsError, EntraClientCredentialsClient } from './client-credentials-client';

const SECRET = 'service-secret-value';
const SCOPE = 'api://retrieval/.default';
const ok = (token = 'app-token', expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 });

const rejection = (promise: Promise<unknown>): Promise<ClientCredentialsError> =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error as ClientCredentialsError,
  );

function setup(fetchImpl: jest.Mock) {
  const clock = { now: 0 };
  const client = new EntraClientCredentialsClient({
    tokenEndpoint: 'https://login.test/t/oauth2/v2.0/token',
    clientId: 'ingestion-app',
    clientSecretName: 'ingestion-secret',
    secrets: new EnvSecretProvider({ SECRET_INGESTION_SECRET: SECRET }),
    fetchImpl,
    now: () => clock.now,
  });
  return { client, clock };
}

describe('EntraClientCredentialsClient', () => {
  it('sends the client_credentials request and returns the token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok('the-token'));

    expect(await setup(fetchImpl).client.getToken(SCOPE)).toBe('the-token');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://login.test/t/oauth2/v2.0/token');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'ingestion-app',
      client_secret: SECRET,
      scope: SCOPE,
    });
  });

  it('caches per API until shortly before expiry', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => Promise.resolve(ok('t', 3600)));
    const { client, clock } = setup(fetchImpl);

    await client.getToken(SCOPE);
    clock.now = 3_539_000;
    await client.getToken(SCOPE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await client.getToken('api://other/.default'); // a different API needs its own token
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock.now = 3_541_000;
    await client.getToken(SCOPE);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('shares one request between concurrent callers and does not cache failures', async () => {
    const slow = jest
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(ok('shared')), 10)),
      );
    const shared = setup(slow);
    expect(
      await Promise.all([shared.client.getToken(SCOPE), shared.client.getToken(SCOPE)]),
    ).toEqual(['shared', 'shared']);
    expect(slow).toHaveBeenCalledTimes(1);

    const flaky = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }),
      )
      .mockResolvedValueOnce(ok('recovered'));
    const retrying = setup(flaky);
    await expect(retrying.client.getToken(SCOPE)).rejects.toBeInstanceOf(ClientCredentialsError);
    expect(await retrying.client.getToken(SCOPE)).toBe('recovered');
  });

  it('maps provider errors to codes without leaking the secret', async () => {
    const refused = setup(
      jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
        ),
    );
    const error = await rejection(refused.client.getToken(SCOPE));
    expect(error).toMatchObject({ code: 'invalid_client', status: 401 });
    expect(error.message).not.toContain(SECRET);

    const down = setup(jest.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect((await rejection(down.client.getToken(SCOPE))).code).toBe(
      'identity_provider_unreachable',
    );

    const garbage = setup(jest.fn().mockResolvedValue(new Response('nope', { status: 200 })));
    expect((await rejection(garbage.client.getToken(SCOPE))).code).toBe('malformed_response');
  });
});

describe('client-credentials against the dev token endpoint', () => {
  const issuer = new TestIssuer();
  let endpoint: Awaited<ReturnType<typeof startDevTokenEndpoint>>;

  beforeAll(async () => {
    endpoint = await startDevTokenEndpoint({
      issuer,
      clients: {
        'ingestion-app': { secret: SECRET, audience: 'api://ingestion', roles: ['indexer'] },
      },
    });
  });
  afterAll(async () => {
    await endpoint.close();
  });

  const clientWith = (secret: string) =>
    new EntraClientCredentialsClient({
      tokenEndpoint: endpoint.url,
      clientId: 'ingestion-app',
      clientSecretName: 'ingestion-secret',
      secrets: new EnvSecretProvider({ SECRET_INGESTION_SECRET: secret }),
    });

  it('issues an app-only token with the granted roles, bound to the requested API', async () => {
    const token = await clientWith(SECRET).getToken(SCOPE);

    const principal = await issuer.verifier(30, 'api://retrieval').verify(token);

    expect(principal).toMatchObject({
      tenantId: SERVICE_TENANT,
      userId: 'ingestion-app',
      roles: ['indexer'],
      scopes: [],
    });
    await expect(issuer.verifier(30, 'api://gateway').verify(token)).rejects.toBeDefined();
  });

  it('refuses a wrong secret and a malformed scope', async () => {
    expect((await rejection(clientWith('wrong').getToken(SCOPE))).code).toBe('invalid_client');
    expect((await rejection(clientWith(SECRET).getToken('https://evil/.default'))).code).toBe(
      'invalid_scope',
    );
  });
});
