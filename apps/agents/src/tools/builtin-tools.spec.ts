import type { RetrievalClient } from '../clients/service-clients';
import { builtinTools } from './builtin-tools';
import { InMemoryMailer, InMemoryTicketSystem } from './fake-backends';
import { ToolError, type AnyTool, type ToolContext } from './tool';
import { ToolRegistry } from './tool-registry';

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  tenantId: 'acme',
  userId: 'alice',
  runId: 'r1',
  idempotencyKey: 'r1:c1',
  tokenFor: (scope) => Promise.resolve(`token-for-${scope}`),
  signal: new AbortController().signal,
  ...overrides,
});

function setup() {
  const tickets = new InMemoryTicketSystem();
  const mailer = new InMemoryMailer();
  const search = jest
    .fn()
    .mockResolvedValue([
      { chunkId: 'c', documentId: 'd1', text: 'Refunds take 5 days.', metadata: {}, score: 1 },
    ]);
  const registry = new ToolRegistry(
    builtinTools({
      retrieval: { search } as unknown as RetrievalClient,
      retrievalScope: 'api://retrieval/.default',
      tickets,
      mailer,
      emailAllowedDomains: ['acme-bank.example'],
    }),
  );
  const get = (name: string): AnyTool => registry.resolve(name, ['support-lead']) as AnyTool;
  const run = (name: string, args: unknown, c = ctx()) =>
    (get(name) as unknown as { execute(a: unknown, c: ToolContext): Promise<unknown> }).execute(
      args,
      c,
    );
  return { tickets, mailer, search, get, run };
}

describe('built-in tools', () => {
  it('search_documents asks retrieval with a token exchanged for the retrieval audience', async () => {
    const { run, search } = setup();

    const result = await run('search_documents', { query: 'refunds' });

    expect(search).toHaveBeenCalledWith(
      'token-for-api://retrieval/.default',
      { query: 'refunds', topK: 4 },
      'r1:c1',
    );
    expect(result).toEqual([{ documentId: 'd1', text: 'Refunds take 5 days.' }]);
  });

  it('classifies risk: reads fetch, writes need approval', () => {
    const { get } = setup();
    expect(['search_documents', 'get_ticket'].map((n) => get(n).risk)).toEqual(['read', 'read']);
    expect(['create_ticket', 'send_email'].map((n) => get(n).risk)).toEqual(['write', 'write']);
  });

  it('create_ticket is idempotent on the call key: a retry does not create a second ticket', async () => {
    const { run, tickets } = setup();

    const first = await run('create_ticket', { title: 'Card lost', body: 'details' });
    const retry = await run('create_ticket', { title: 'Card lost', body: 'details' });

    expect(retry).toEqual(first);
    expect(tickets.list('acme')).toHaveLength(1);
  });

  it('get_ticket never reveals another tenant’s ticket', async () => {
    const { run, tickets } = setup();
    tickets.seed({ id: 'T-1', tenantId: 'globex', title: 'secret', body: 'x', createdBy: 'bob' });

    await expect(run('get_ticket', { id: 'T-1' })).rejects.toBeInstanceOf(ToolError);
  });

  it('send_email delivers to an allowed domain, once per call key', async () => {
    const { run, mailer } = setup();
    const args = { to: 'jo@acme-bank.example', subject: 'Hi', body: 'Hello' };

    await run('send_email', args);
    await run('send_email', args);

    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]).toMatchObject({ to: 'jo@acme-bank.example', sentBy: 'alice' });
  });

  it('send_email refuses an outside domain even when called directly', async () => {
    const { run, mailer } = setup();

    await expect(
      run('send_email', { to: 'attacker@evil.example', subject: 'x', body: 'y' }),
    ).rejects.toThrow(/not allowed/);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('inputs are strict: unknown fields and malformed values are rejected', () => {
    const { get } = setup();
    const send = get('send_email') as unknown as {
      input: { safeParse(v: unknown): { success: boolean } };
    };

    expect(
      send.input.safeParse({ to: 'a@acme-bank.example', subject: 's', body: 'b', cc: 'x' }).success,
    ).toBe(false);
    expect(send.input.safeParse({ to: 'not-an-email', subject: 's', body: 'b' }).success).toBe(
      false,
    );
  });

  it('only support-lead sees send_email; support sees tickets; nobody-special sees search only', () => {
    const registry = new ToolRegistry(
      builtinTools({
        retrieval: {} as RetrievalClient,
        retrievalScope: 's',
        tickets: new InMemoryTicketSystem(),
        mailer: new InMemoryMailer(),
        emailAllowedDomains: [],
      }),
    );
    const names = (roles: string[]) => registry.visibleTo(roles).map((t) => t.name);

    expect(names([])).toEqual(['search_documents']);
    expect(names(['support'])).toEqual(['search_documents', 'get_ticket', 'create_ticket']);
    expect(names(['support-lead'])).toContain('send_email');
  });
});
