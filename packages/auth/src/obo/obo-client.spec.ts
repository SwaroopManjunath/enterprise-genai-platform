import { EnvSecretProvider } from '../secrets/env-secret-provider';
import { EntraOboClient, OboExchangeError, entraTokenEndpoint } from './obo-client';

const SECRET = 'super-secret-client-value';
const USER_TOKEN = 'user.access.token';
const SCOPE = 'api://retrieval/.default';

const ok = (token = 'downstream-token', expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 });

function setup(fetchImpl: jest.Mock) {
  const clock = { now: 0 };
  const client = new EntraOboClient({
    tokenEndpoint: 'https://login.test/tenant/oauth2/v2.0/token',
    clientId: 'assistant-app-id',
    clientSecretName: 'assistant-client-secret',
    secrets: new EnvSecretProvider({ SECRET_ASSISTANT_CLIENT_SECRET: SECRET }),
    fetchImpl,
    now: () => clock.now,
  });
  return { client, clock };
}

const rejection = (promise: Promise<unknown>): Promise<OboExchangeError> =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error as OboExchangeError,
  );

describe('EntraOboClient', () => {
  it('sends the jwt-bearer on_behalf_of request and returns the downstream token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok('downstream-token'));
    const { client } = setup(fetchImpl);

    expect(await client.exchange(USER_TOKEN, SCOPE)).toBe('downstream-token');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const form = init.body as URLSearchParams;
    expect(url).toBe('https://login.test/tenant/oauth2/v2.0/token');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: 'assistant-app-id',
      client_secret: SECRET,
      assertion: USER_TOKEN,
      scope: SCOPE,
      requested_token_use: 'on_behalf_of',
    });
  });

  it('reuses a cached token until shortly before it expires', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => Promise.resolve(ok('t', 3600)));
    const { client, clock } = setup(fetchImpl);

    await client.exchange(USER_TOKEN, SCOPE);
    clock.now = 3_539_000; // 61s left: still cached
    await client.exchange(USER_TOKEN, SCOPE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.now = 3_541_000; // 59s left: inside the refresh margin
    await client.exchange(USER_TOKEN, SCOPE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps different users and different scopes apart', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok('alice-retrieval'))
      .mockResolvedValueOnce(ok('bob-retrieval'))
      .mockResolvedValueOnce(ok('alice-gateway'));
    const { client } = setup(fetchImpl);

    expect(await client.exchange('alice', SCOPE)).toBe('alice-retrieval');
    expect(await client.exchange('bob', SCOPE)).toBe('bob-retrieval');
    expect(await client.exchange('alice', 'api://gateway/.default')).toBe('alice-gateway');
    expect(await client.exchange('alice', SCOPE)).toBe('alice-retrieval'); // from cache
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('shares one exchange between concurrent identical requests', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(ok('shared')), 10)),
      );
    const { client } = setup(fetchImpl);

    const results = await Promise.all([
      client.exchange(USER_TOKEN, SCOPE),
      client.exchange(USER_TOKEN, SCOPE),
      client.exchange(USER_TOKEN, SCOPE),
    ]);

    expect(results).toEqual(['shared', 'shared', 'shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }),
      )
      .mockResolvedValueOnce(ok('recovered'));
    const { client } = setup(fetchImpl);

    await expect(client.exchange(USER_TOKEN, SCOPE)).rejects.toBeInstanceOf(OboExchangeError);
    expect(await client.exchange(USER_TOKEN, SCOPE)).toBe('recovered');
  });

  it('surfaces the identity provider error code, including MFA or consent needs', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'interaction_required' }), { status: 400 }),
      );
    const { client } = setup(fetchImpl);

    const error = await rejection(client.exchange(USER_TOKEN, SCOPE));

    expect(error.code).toBe('interaction_required');
    expect(error.interactionRequired).toBe(true);
    expect(error.status).toBe(400);
  });

  it('maps network failures and malformed responses to clear codes', async () => {
    const down = setup(jest.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect((await rejection(down.client.exchange(USER_TOKEN, SCOPE))).code).toBe(
      'identity_provider_unreachable',
    );

    const garbage = setup(jest.fn().mockResolvedValue(new Response('not json', { status: 200 })));
    expect((await rejection(garbage.client.exchange(USER_TOKEN, SCOPE))).code).toBe(
      'malformed_response',
    );

    const weirdError = setup(
      jest
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: '<script>' }), { status: 400 })),
    );
    expect((await rejection(weirdError.client.exchange(USER_TOKEN, SCOPE))).code).toBe(
      'unknown_error',
    );
  });

  it('never leaks the client secret or the user token through errors', async () => {
    const { client } = setup(
      jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
        ),
    );

    const error = await rejection(client.exchange(USER_TOKEN, SCOPE));

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(USER_TOKEN);
  });

  it('bounds the cache so memory does not grow with the user count', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => Promise.resolve(ok('t')));
    const client = new EntraOboClient({
      tokenEndpoint: 'https://login.test/t',
      clientId: 'c',
      clientSecretName: 'assistant-client-secret',
      secrets: new EnvSecretProvider({ SECRET_ASSISTANT_CLIENT_SECRET: SECRET }),
      fetchImpl,
      maxCacheEntries: 2,
    });

    await client.exchange('u1', SCOPE);
    await client.exchange('u2', SCOPE);
    await client.exchange('u3', SCOPE); // evicts u1
    await client.exchange('u1', SCOPE);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('entraTokenEndpoint', () => {
  it('builds the v2 token URL', () => {
    expect(entraTokenEndpoint('contoso.onmicrosoft.com')).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    );
  });

  it('rejects a tenant that could alter the URL', () => {
    expect(() => entraTokenEndpoint('x/../evil')).toThrow(/Invalid directory tenant/);
    expect(() => entraTokenEndpoint('a?b=c')).toThrow();
  });
});
