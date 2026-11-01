import { loadConfig } from './config';

const required = {
  OBO_TOKEN_ENDPOINT: 'https://login.test/t/oauth2/v2.0/token',
  OBO_CLIENT_ID: 'mcp-gateway',
};

describe('loadConfig', () => {
  it('is locked down by default: no allowed private hosts, enforcing guardrails', () => {
    const config = loadConfig(required);

    expect(config.allowedHosts).toEqual([]);
    expect(config.guardrails).toEqual({ mode: 'enforce', outputPii: ['secret', 'card', 'iban'] });
    expect(config).toMatchObject({
      upstreamTimeoutMs: 10_000,
      maxResultChars: 8_000,
      verifyTtlMs: 60_000,
      rateLimitPerMinute: 60,
    });
  });

  it('fails fast without the on-behalf-of settings', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('parses the allowed hosts lowercased', () => {
    expect(loadConfig({ ...required, ALLOWED_HOSTS: 'Localhost, 127.0.0.1' }).allowedHosts).toEqual(
      ['localhost', '127.0.0.1'],
    );
  });

  it('rejects an unknown guardrail mode or kind and silly limits', () => {
    expect(() => loadConfig({ ...required, GUARDRAILS_MODE: 'off' })).toThrow();
    expect(() => loadConfig({ ...required, GUARDRAILS_OUTPUT_PII: 'passport' })).toThrow();
    expect(() => loadConfig({ ...required, MAX_UPSTREAM_BYTES: '10' })).toThrow();
  });
});
