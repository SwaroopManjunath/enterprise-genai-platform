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

  describe('cost settings', () => {
    it('has no prices and no budget by default', () => {
      const config = loadConfig({});

      expect(config.prices).toEqual({});
      expect(config.dailyCostBudgetUsd).toBeUndefined();
    });

    it('reads prices per deployment and a daily budget', () => {
      const config = loadConfig({
        MODEL_PRICES: '{"aoai-primary":{"inputPerMTok":2.5,"outputPerMTok":10}}',
        DAILY_COST_BUDGET_USD: '25.5',
      });

      expect(config.prices['aoai-primary']).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10 });
      expect(config.dailyCostBudgetUsd).toBe(25.5);
    });

    it('rejects malformed prices and a non-positive budget', () => {
      expect(() => loadConfig({ MODEL_PRICES: 'not json' })).toThrow(/MODEL_PRICES/);
      expect(() =>
        loadConfig({ MODEL_PRICES: '{"x":{"inputPerMTok":-1,"outputPerMTok":1}}' }),
      ).toThrow();
      expect(() => loadConfig({ DAILY_COST_BUDGET_USD: '0' })).toThrow();
    });
  });
});
