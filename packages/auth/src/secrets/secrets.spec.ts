import { EnvSecretProvider } from './env-secret-provider';
import { KeyVaultSecretProvider } from './key-vault-secret-provider';
import { SecretNotFoundError, SecretUnavailableError } from './secret-provider';

/** Awaits a promise that must reject and returns the error. */
const rejection = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error as Error,
  );

describe('EnvSecretProvider', () => {
  const provider = new EnvSecretProvider({ SECRET_AZURE_OPENAI_KEY: 's3cret', UNRELATED: 'x' });

  it('reads SECRET_<NAME> with dashes mapped to underscores', async () => {
    expect(await provider.get('azure-openai-key')).toBe('s3cret');
  });

  it('does not read variables without the SECRET_ prefix', async () => {
    await expect(provider.get('unrelated')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('reports a missing secret without echoing any value', async () => {
    const error = await rejection(provider.get('nope'));
    expect(error).toBeInstanceOf(SecretNotFoundError);
    expect(error.message).not.toContain('s3cret');
  });

  it('rejects names that could be path or injection tricks', async () => {
    await expect(provider.get('../etc/passwd')).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe('KeyVaultSecretProvider', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function setup(fetchImpl: jest.Mock, ttlMs = 1000) {
    const clock = { now: 0 };
    const getToken = jest.fn().mockResolvedValue('managed-identity-token');
    const provider = new KeyVaultSecretProvider({
      vaultUrl: 'https://my-vault.vault.azure.net/',
      getToken,
      fetchImpl,
      ttlMs,
      now: () => clock.now,
    });
    return { provider, clock, getToken };
  }

  it('calls the vault REST API with the managed-identity token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ value: 'the-key' }));
    const { provider } = setup(fetchImpl);

    expect(await provider.get('openai-key')).toBe('the-key');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://my-vault.vault.azure.net/secrets/openai-key?api-version=7.4');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer managed-identity-token',
    );
  });

  it('caches within the TTL and re-reads after it (so rotation is picked up)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json({ value: 'v1' }))
      .mockResolvedValueOnce(json({ value: 'v2' }));
    const { provider, clock } = setup(fetchImpl, 1000);

    expect(await provider.get('k')).toBe('v1');
    clock.now = 999;
    expect(await provider.get('k')).toBe('v1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.now = 1001;
    expect(await provider.get('k')).toBe('v2');
  });

  it('maps 404 to not found and other failures to unavailable', async () => {
    const notFound = setup(jest.fn().mockResolvedValue(json({}, 404)));
    await expect(notFound.provider.get('k')).rejects.toBeInstanceOf(SecretNotFoundError);

    const forbidden = setup(jest.fn().mockResolvedValue(json({}, 403)));
    await expect(forbidden.provider.get('k')).rejects.toBeInstanceOf(SecretUnavailableError);

    const down = setup(jest.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(down.provider.get('k')).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it('treats a malformed response as unavailable', async () => {
    const { provider } = setup(jest.fn().mockResolvedValue(json({ nope: true })));
    await expect(provider.get('k')).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it('refuses names that could alter the request path', async () => {
    const fetchImpl = jest.fn();
    const { provider } = setup(fetchImpl);

    await expect(provider.get('a/../b')).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(provider.get('a?x=1')).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never includes the token or the secret value in errors', async () => {
    const { provider } = setup(jest.fn().mockResolvedValue(json({ value: 123 })));
    const error = await rejection(provider.get('k'));
    expect(error.message).not.toContain('managed-identity-token');
  });
});
