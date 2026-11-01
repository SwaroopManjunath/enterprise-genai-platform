/**
 * `npm run azure:check -w @genai/e2e`: one cheap round trip to the configured deployment, before
 * anything is spent on a real run. It says what the deployment is, how fast it answers, whether it
 * streams, and, when it fails, what the usual cause is. The key is never printed.
 */
import { azureFromEnv } from './azure-model';

const HINTS: Record<string, string> = {
  '401': 'The key or the endpoint is wrong, or the key belongs to a different resource.',
  '403': 'The key is valid but may not use this deployment (check the resource firewall).',
  '404':
    'The deployment name is wrong: it is the name you gave the deployment, not the model name.',
  '400':
    'The deployment refused the request. Newer models reject a temperature setting: try AZURE_OPENAI_NO_TEMPERATURE=1. If the message mentions max_tokens, tell me: the gateway needs max_completion_tokens for that model.',
  '429': 'The deployment is out of quota for now. Wait a minute, or raise its tokens per minute.',
};

function explain(error: unknown): string {
  const text = String((error as Error).message ?? error);
  const status = /returned (\d{3})/.exec(text)?.[1];
  return `${text}${status && HINTS[status] ? `\n  -> ${HINTS[status]}` : ''}`;
}

async function main(): Promise<number> {
  const model = azureFromEnv();
  console.log(`Deployment "${model.deployment}" (judge: "${model.judgeDeployment}")`);
  console.log(`Endpoint ${new URL(process.env['AZURE_OPENAI_ENDPOINT'] as string).host}`);
  const price = model.prices[model.name];
  console.log(
    price
      ? `Prices: $${price.inputPerMTok} in / $${price.outputPerMTok} out per million tokens`
      : 'Prices not set: costs will be reported as unpriced (MODEL_INPUT_USD_PER_MTOK / MODEL_OUTPUT_USD_PER_MTOK)',
  );

  try {
    const started = performance.now();
    const reply = await model.provider.chat({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    console.log(
      `\nChat: "${reply.message.content.trim().slice(0, 40)}" in ${Math.round(performance.now() - started)} ms, ` +
        `${reply.usage.promptTokens} prompt + ${reply.usage.completionTokens} completion tokens, finish "${reply.finishReason}"`,
    );

    const streamStarted = performance.now();
    let firstMs: number | undefined;
    let pieces = 0;
    for await (const event of model.provider.chatStream!({
      messages: [{ role: 'user', content: 'Count from one to five in words.' }],
    })) {
      if (event.type === 'delta') {
        firstMs ??= performance.now() - streamStarted;
        pieces += 1;
      }
    }
    console.log(`Stream: first text after ${Math.round(firstMs ?? NaN)} ms, ${pieces} pieces`);

    const judged = await model.judge(
      'Reply with ONLY a JSON array of booleans, one per claim.\n<claims>\n1. Paris is in France.\n2. Paris is in Peru.\n</claims>',
    );
    console.log(`Judge: ${judged.trim().slice(0, 60)} (expected [true,false])`);
  } catch (error) {
    console.error(`\nFAILED: ${explain(error)}`);
    return 1;
  }
  console.log('\nThe deployment works with the platform. Run tests/proof/azure.sh.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(explain(error));
    process.exit(1);
  },
);
