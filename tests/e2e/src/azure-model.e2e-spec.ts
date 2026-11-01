import { azureAvailable, azureFromEnv } from './azure-model';
import { startFakeAzure, type FakeAzure } from './fake-azure';
import { seedDocuments, startStack, type Stack } from './stack';

const analyst = { tenant: 'acme-bank', userId: 'bob', roles: ['analyst'] };
const KEY = 'test-key-not-a-secret';

describe('a real Azure model, as the harnesses configure it', () => {
  let azure: FakeAzure;
  let stack: Stack;
  const env = () => ({
    AZURE_OPENAI_ENDPOINT: azure.url,
    AZURE_OPENAI_DEPLOYMENT: 'chat',
    AZURE_OPENAI_API_KEY: KEY,
    MODEL_INPUT_USD_PER_MTOK: '2.5',
    MODEL_OUTPUT_USD_PER_MTOK: '10',
  });

  beforeAll(async () => {
    azure = await startFakeAzure(KEY);
    const model = azureFromEnv(env());
    stack = await startStack({ providers: [model.provider], prices: model.prices });
    await seedDocuments(stack);
  });
  afterAll(async () => {
    await stack.stop();
    await azure.close();
  });

  it('is only used when its settings are all present, and says which are missing', () => {
    expect(azureAvailable({})).toBe(false);
    expect(azureAvailable(env())).toBe(true);
    expect(() => azureFromEnv({ AZURE_OPENAI_ENDPOINT: 'x' })).toThrow(
      /AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY/,
    );
  });

  it('never puts the key in an error message', () => {
    try {
      azureFromEnv({ AZURE_OPENAI_API_KEY: KEY });
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
  });

  it('answers through the whole platform, with the deployment’s own name and a priced cost', async () => {
    const res = await stack.ask(analyst, 'How long do refunds take?');

    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(true);
    expect(res.body.model.provider).toBe('azure-chat');
    const usage = (
      await stack.call('GET', 'gateway', '/v1/usage', {
        token: stack.token('gateway', { ...analyst, roles: ['cost-viewer'] }),
      })
    ).body;
    expect(JSON.stringify(usage)).toContain('azure-chat');
    expect(azure.requests.some((r) => r.deployment === 'chat' && !r.judge)).toBe(true);
  });

  it('streams through the platform as well', async () => {
    const streamed = await stack.askStream(analyst, 'How long do refunds take?');

    expect(streamed.status).toBe(200);
    expect(streamed.text).toMatch(/five working days/i);
    expect(azure.requests.some((r) => r.stream)).toBe(true);
  });

  it('grades claims on its own judge deployment when one is named', async () => {
    const model = azureFromEnv({ ...env(), AZURE_JUDGE_DEPLOYMENT: 'judge' });

    const reply = await model.judge('<claims>\n1. Refunds take five days.\n</claims>');

    expect(JSON.parse(reply)).toEqual([true]);
    expect(azure.requests.at(-1)).toMatchObject({ deployment: 'judge', judge: true });
  });

  it('is refused with a wrong key, as the real service would', async () => {
    const model = azureFromEnv({ ...env(), AZURE_OPENAI_API_KEY: 'wrong' });

    await expect(model.judge('hello')).rejects.toThrow(/401|upstream/);
  });
});
