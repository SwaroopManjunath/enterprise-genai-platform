import { EnvSecretProvider, SecretNotFoundError } from '@genai/auth';
import { loadConfig } from '../config/config';
import { resolveDeployments } from './resolve-deployments';

const deployments = (entries: object[]) =>
  loadConfig({
    LLM_PROVIDER: 'azure',
    AZURE_OPENAI_DEPLOYMENTS: JSON.stringify(entries),
  }).deployments;

const base = { name: 'weu', endpoint: 'https://a.openai.azure.com', deployment: 'gpt-4o' };

describe('resolveDeployments', () => {
  const secrets = new EnvSecretProvider({ SECRET_WEU_KEY: 'from-vault' });

  it('looks up a named secret and drops the reference', async () => {
    const [resolved] = await resolveDeployments(
      deployments([{ ...base, apiKeySecret: 'weu-key' }]),
      secrets,
    );

    expect(resolved).toMatchObject({ name: 'weu', apiKey: 'from-vault' });
    expect(resolved).not.toHaveProperty('apiKeySecret');
  });

  it('keeps an inline key as is (local experiments)', async () => {
    const [resolved] = await resolveDeployments(
      deployments([{ ...base, apiKey: 'inline' }]),
      secrets,
    );
    expect(resolved?.apiKey).toBe('inline');
  });

  it('fails startup when a secret is missing', async () => {
    await expect(
      resolveDeployments(deployments([{ ...base, apiKeySecret: 'no-such-key' }]), secrets),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('config rejects a deployment with both or neither key source', () => {
    expect(() => deployments([{ ...base }])).toThrow(/exactly one of apiKey or apiKeySecret/);
    expect(() => deployments([{ ...base, apiKey: 'a', apiKeySecret: 'b' }])).toThrow(/exactly one/);
  });
});
