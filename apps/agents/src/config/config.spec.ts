import { loadConfig } from './config';

const required = {
  OBO_TOKEN_ENDPOINT: 'https://login.test/t/oauth2/v2.0/token',
  OBO_CLIENT_ID: 'agents-app',
};

describe('loadConfig', () => {
  it('has conservative defaults for every limit', () => {
    expect(loadConfig(required).limits).toEqual({
      defaultMaxSteps: 6,
      hardMaxSteps: 10,
      runTimeoutMs: 30_000,
      toolTimeoutMs: 10_000,
      modelTimeoutMs: 20_000,
      maxCallsPerStep: 3,
      loopRepeatLimit: 3,
      maxToolOutputChars: 4_000,
    });
  });

  it('fails fast without the on-behalf-of settings', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('refuses a default step budget above the hard ceiling', () => {
    expect(() =>
      loadConfig({ ...required, DEFAULT_MAX_STEPS: '12', HARD_MAX_STEPS: '10' }),
    ).toThrow(/must not exceed/);
  });

  it('parses the email domain allowlist, lowercased', () => {
    expect(
      loadConfig({ ...required, EMAIL_ALLOWED_DOMAINS: 'Acme.test, partner.test' })
        .emailAllowedDomains,
    ).toEqual(['acme.test', 'partner.test']);
  });

  it('enforces guardrails by default and rejects unknown modes or kinds', () => {
    expect(loadConfig(required).guardrails).toEqual({
      mode: 'enforce',
      outputPii: ['secret', 'card', 'iban'],
    });
    expect(() => loadConfig({ ...required, GUARDRAILS_MODE: 'off' })).toThrow();
    expect(() => loadConfig({ ...required, GUARDRAILS_OUTPUT_PII: 'passport' })).toThrow();
  });

  it('only ever holds the name of the client secret', () => {
    expect(loadConfig(required).obo.clientSecretName).toBe('agents-client-secret');
  });

  it('has no MCP gateway unless one is configured', () => {
    expect(loadConfig(required).mcp).toBeUndefined();
    expect(loadConfig({ ...required, MCP_GATEWAY_URL: 'http://mcp.test' }).mcp).toEqual({
      url: 'http://mcp.test',
      scope: 'api://mcp-gateway/.default',
    });
    expect(() => loadConfig({ ...required, MCP_GATEWAY_URL: 'not a url' })).toThrow();
  });
});
