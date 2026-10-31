/**
 * `npm run demo -w @genai/e2e`: starts the real services in one process and walks through the
 * login-to-cited-answer path, so the behaviour can be watched instead of taken on trust.
 */
import { seedDocuments, startStack, type Caller, type Stack } from './stack';

const bob: Caller = { tenant: 'acme-bank', userId: 'bob', roles: ['analyst'] };
const alice: Caller = { tenant: 'acme-bank', userId: 'alice', roles: ['manager'] };
const gina: Caller = { tenant: 'globex', userId: 'gina', roles: ['analyst'] };

const describeCaller = (name: string, c: Caller): string =>
  `${name} (${c.tenant}, roles: ${c.roles?.join(', ') || 'none'})`;

async function show(
  stack: Stack,
  who: string,
  caller: Caller,
  question: string,
  extra?: Parameters<Stack['ask']>[2],
): Promise<void> {
  const res = await stack.ask(caller, question, extra);
  console.log(`\n${describeCaller(who, caller)} asks: "${question}"`);
  if (extra?.headers)
    console.log(`  (also sends spoofed headers: ${JSON.stringify(extra.headers)})`);

  if (res.status !== 200) {
    console.log(`  -> HTTP ${res.status} ${res.body?.error?.code ?? ''}`);
    return;
  }
  const b = res.body;
  console.log(`  answer:    ${b.answer}`);
  console.log(`  grounded:  ${b.grounded}   sources retrieved: ${b.sourcesRetrieved}`);
  for (const c of b.citations) {
    console.log(
      `  citation:  [${c.marker}] ${c.documentId} > ${c.headingPath.join(' > ')}  (${c.chunkId})`,
    );
  }
  if (b.prompt)
    console.log(
      `  prompt:    ${b.prompt.source} (${b.prompt.version}), model: ${b.model.provider}`,
    );
  else console.log('  (no sources the caller may see, so the model was never called)');
}

async function main(): Promise<void> {
  const stack = await startStack();
  try {
    await seedDocuments(stack);
    console.log('Services started: retrieval, prompt registry, gateway, assistant + OBO endpoint.');
    console.log(
      "Documents: an open handbook, a manager-only salary document, and Globex's handbook.",
    );

    const refunds = 'How long do refunds take?';
    const salary = 'What are the salary bands for managers?';

    await show(stack, 'Bob', bob, refunds);
    await show(stack, 'Bob', bob, salary);
    await show(stack, 'Alice', alice, salary);
    await show(stack, 'Gina', gina, refunds);
    await show(stack, 'Bob', bob, salary, {
      headers: { 'x-roles': 'manager' },
      body: { roles: ['manager'] },
    });

    const wrong = await stack.call('POST', 'assistant', '/v1/ask', {
      token: stack.token('retrieval', alice),
      body: { question: salary },
    });
    console.log(`\nAlice presents a token issued for the retrieval API to the assistant`);
    console.log(
      `  -> HTTP ${wrong.status} ${wrong.body.error.code} (tokens are bound to one service)`,
    );
  } finally {
    await stack.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
