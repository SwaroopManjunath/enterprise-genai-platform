import { loadConfig } from './config';

describe('loadConfig', () => {
  it('defaults to the mock provider so the service runs with no cloud setup', () => {
    const config = loadConfig({});
    expect(config.provider).toBe('mock');
    expect(config.port).toBe(3000);
    expect(config.retry.maxAttempts).toBe(3);
  });

  it('parses ordered Azure deployments (first is primary)', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'azure',
      AZURE_OPENAI_DEPLOYMENTS: JSON.stringify([
        {
          name: 'primary',
          endpoint: 'https://a.openai.azure.com',
          deployment: 'gpt-4o',
          apiKey: 'k1',
        },
        {
          name: 'secondary',
          endpoint: 'https://b.openai.azure.com',
          deployment: 'gpt-4o',
          apiKey: 'k2',
        },
      ]),
    });
    expect(config.deployments.map((d) => d.name)).toEqual(['primary', 'secondary']);
    expect(config.deployments[0]?.apiVersion).toBe('2024-10-21');
  });

  it('fails fast when azure is selected without deployments', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'azure' })).toThrow(/at least one/);
  });

  it('fails fast on malformed deployment JSON', () => {
    expect(() => loadConfig({ AZURE_OPENAI_DEPLOYMENTS: '{nope' })).toThrow(/valid JSON/);
  });
});
