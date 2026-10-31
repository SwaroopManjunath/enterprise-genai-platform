import { loadConfig } from './config';

const required = {
  OBO_TOKEN_ENDPOINT: 'https://login.test/tenant/oauth2/v2.0/token',
  OBO_CLIENT_ID: 'assistant-app',
};

describe('loadConfig', () => {
  it('has local defaults for downstream services and scopes', () => {
    const config = loadConfig(required);

    expect(config.retrieval).toEqual({
      url: 'http://localhost:3003',
      scope: 'api://retrieval/.default',
    });
    expect(config.gateway.url).toBe('http://localhost:3000');
    expect(config.prompts.url).toBe('http://localhost:3001');
    expect(config).toMatchObject({ promptName: 'rag-answer', defaultTopK: 4, port: 3004 });
  });

  it('fails fast without the on-behalf-of settings', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ OBO_TOKEN_ENDPOINT: required.OBO_TOKEN_ENDPOINT })).toThrow();
  });

  it('only ever holds the name of the client secret, not the secret', () => {
    expect(loadConfig(required).obo.clientSecretName).toBe('assistant-client-secret');
  });

  it('rejects an out-of-range top K', () => {
    expect(() => loadConfig({ ...required, DEFAULT_TOP_K: '50' })).toThrow();
  });
});
