import { AzureOpenAiProvider } from '../../../apps/llm-gateway/src/llm/azure-openai.provider';
import type { LlmProvider } from '../../../apps/llm-gateway/src/llm/types';

/**
 * A real Azure OpenAI deployment for the harnesses (evaluation, benchmark, load test), configured
 * from the environment so a key is never in a file or on a command line:
 *
 *   AZURE_OPENAI_ENDPOINT      https://<resource>.openai.azure.com
 *   AZURE_OPENAI_DEPLOYMENT    the deployment name
 *   AZURE_OPENAI_API_KEY       its key (read once, never printed)
 *   AZURE_OPENAI_API_VERSION   optional, default 2024-10-21
 *   AZURE_JUDGE_DEPLOYMENT     optional: a different deployment to judge answers
 *   MODEL_INPUT_USD_PER_MTOK / MODEL_OUTPUT_USD_PER_MTOK   the contract's prices, for cost numbers
 *   AZURE_OPENAI_NO_TEMPERATURE=1   for models that refuse a temperature setting
 */
export interface AzureModel {
  provider: LlmProvider;
  /** The provider name the gateway reports, which is also the key for prices. */
  name: string;
  deployment: string;
  judgeDeployment: string;
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  /** One completion on the judge deployment, for the model-based judge. */
  judge(prompt: string): Promise<string>;
}

const REQUIRED = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_KEY',
] as const;

export function azureAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED.every((name) => Boolean(env[name]));
}

export function azureFromEnv(env: NodeJS.ProcessEnv = process.env, timeoutMs = 60_000): AzureModel {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Set ${missing.join(', ')} to use a real model (see docs/proof/README.md).`);
  }
  const endpoint = env['AZURE_OPENAI_ENDPOINT'] as string;
  const apiKey = env['AZURE_OPENAI_API_KEY'] as string;
  const deployment = env['AZURE_OPENAI_DEPLOYMENT'] as string;
  const judgeDeployment = env['AZURE_JUDGE_DEPLOYMENT'] ?? deployment;
  const apiVersion = env['AZURE_OPENAI_API_VERSION'] ?? '2024-10-21';
  const name = `azure-${deployment}`;

  const make = (target: string, label: string) =>
    new AzureOpenAiProvider(
      { name: label, endpoint, deployment: target, apiVersion, apiKey },
      timeoutMs,
    );

  const input = Number(env['MODEL_INPUT_USD_PER_MTOK']);
  const output = Number(env['MODEL_OUTPUT_USD_PER_MTOK']);
  const priced =
    Number.isFinite(input) && Number.isFinite(output) && env['MODEL_INPUT_USD_PER_MTOK'];
  const judgeProvider = make(judgeDeployment, `judge-${judgeDeployment}`);

  return {
    provider: make(deployment, name),
    name,
    deployment,
    judgeDeployment,
    prices: priced ? { [name]: { inputPerMTok: input, outputPerMTok: output } } : {},
    judge: async (prompt) =>
      (
        await judgeProvider.chat({
          messages: [{ role: 'user', content: prompt }],
          ...(env['AZURE_OPENAI_NO_TEMPERATURE'] !== '1' && { temperature: 0 }),
        })
      ).message.content,
  };
}
