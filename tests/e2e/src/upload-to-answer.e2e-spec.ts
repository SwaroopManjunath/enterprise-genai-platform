import { seedDocuments, startStack, type Stack } from './stack';

const analyst = { tenant: 'acme-bank', userId: 'bob', roles: ['analyst'] };
const manager = { tenant: 'acme-bank', userId: 'alice', roles: ['manager'] };

const TRAVEL_QUESTION = 'What is the hotel limit for business travel?';
const travelPolicy = (limit: string) => ({
  documentId: 'travel-policy',
  filename: 'travel-policy.md',
  content: `# Business travel\nThe hotel limit for business travel is ${limit} euros per night.`,
});

describe('upload -> ingest -> index -> ask, across the real services', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await startStack();
    await seedDocuments(stack);
  });
  afterEach(async () => {
    await stack.stop();
  });

  it('makes an uploaded document answerable, with a citation back to it', async () => {
    expect((await stack.ask(analyst, TRAVEL_QUESTION)).body.grounded).toBe(false);

    const { status } = await stack.uploadAndWait('acme-bank', travelPolicy('150'));
    expect(status).toBe('succeeded');

    const res = await stack.ask(analyst, TRAVEL_QUESTION);
    expect(res.body.grounded).toBe(true);
    expect(res.body.answer).toMatch(/150 euros/);
    expect(res.body.citations[0]).toMatchObject({
      documentId: 'travel-policy',
      headingPath: ['Business travel'],
    });
  });

  it('keeps a restricted upload restricted: only the right role gets the answer', async () => {
    await stack.uploadAndWait('acme-bank', { ...travelPolicy('400'), allowedRoles: ['manager'] });

    const asAnalyst = await stack.ask(analyst, TRAVEL_QUESTION);
    const asManager = await stack.ask(manager, TRAVEL_QUESTION);

    expect(asAnalyst.body).toMatchObject({ grounded: false, sourcesRetrieved: 0 });
    expect(JSON.stringify(asAnalyst.body)).not.toMatch(/400|travel-policy/);
    expect(asManager.body.grounded).toBe(true);
    expect(asManager.body.answer).toMatch(/400 euros/);
  });

  it('replaces an edited document: the new text is answered and the old text is gone', async () => {
    await stack.uploadAndWait('acme-bank', travelPolicy('150'));
    await stack.uploadAndWait('acme-bank', travelPolicy('200'));

    const res = await stack.ask(analyst, TRAVEL_QUESTION);

    expect(res.body.answer).toMatch(/200 euros/);
    expect(JSON.stringify(res.body)).not.toMatch(/150 euros/);
  });

  it('skips a re-upload of identical content as unchanged', async () => {
    await stack.uploadAndWait('acme-bank', travelPolicy('150'));
    const again = await stack.uploadAndWait('acme-bank', travelPolicy('150'));
    expect(again.status).toBe('unchanged');
  });

  it('applies a TIGHTER access list even when the text is identical (never skipped as unchanged)', async () => {
    await stack.uploadAndWait('acme-bank', travelPolicy('150'));
    expect((await stack.ask(analyst, TRAVEL_QUESTION)).body.grounded).toBe(true);

    const tightened = await stack.uploadAndWait('acme-bank', {
      ...travelPolicy('150'),
      allowedRoles: ['manager'],
    });

    expect(tightened.status).toBe('succeeded'); // not 'unchanged'
    expect((await stack.ask(analyst, TRAVEL_QUESTION)).body.grounded).toBe(false);
    expect((await stack.ask(manager, TRAVEL_QUESTION)).body.grounded).toBe(true);
  });

  it('does not mix tenants: the same document id uploaded by two tenants stays separate', async () => {
    await stack.uploadAndWait('acme-bank', travelPolicy('150'));
    await stack.uploadAndWait('globex', travelPolicy('90'));

    const acme = await stack.ask(analyst, TRAVEL_QUESTION);
    const globex = await stack.ask(
      { tenant: 'globex', userId: 'gina', roles: ['analyst'] },
      TRAVEL_QUESTION,
    );

    expect(acme.body.answer).toMatch(/150 euros/);
    expect(globex.body.answer).toMatch(/90 euros/);
    expect(JSON.stringify(globex.body)).not.toMatch(/150/);
  });

  describe('who may do what', () => {
    it('lets only document-admins upload', async () => {
      const asMember = await stack.upload('acme-bank', travelPolicy('150'), ['analyst', 'manager']);
      expect(asMember.status).toBe(403);

      const noToken = await stack.call('POST', 'ingestion', '/v1/documents', {
        body: travelPolicy('150'),
      });
      expect(noToken.status).toBe(401);

      // Nothing was indexed by either attempt.
      expect((await stack.ask(analyst, TRAVEL_QUESTION)).body.grounded).toBe(false);
    });

    it('refuses a token minted for another service', async () => {
      const res = await stack.call('POST', 'ingestion', '/v1/documents', {
        token: stack.token('assistant', { tenant: 'acme-bank', roles: ['document-admin'] }),
        body: travelPolicy('150'),
      });
      expect(res.status).toBe(401);
    });

    it('serves no document content from ingestion: only retrieval does, trimmed by role', async () => {
      await stack.uploadAndWait('acme-bank', { ...travelPolicy('400'), allowedRoles: ['manager'] });
      const admin = stack.token('ingestion', { tenant: 'acme-bank', roles: ['document-admin'] });

      const chunks = await stack.call('GET', 'ingestion', '/v1/documents/travel-policy/chunks', {
        token: admin,
      });
      const info = await stack.call('GET', 'ingestion', '/v1/documents/travel-policy', {
        token: admin,
      });

      expect(chunks.status).toBe(404);
      expect(JSON.stringify(info.body)).not.toMatch(/hotel limit|400 euros/);
    });

    it('gives the ingestion service identity no way to READ customer documents', async () => {
      await stack.uploadAndWait('acme-bank', travelPolicy('150'));
      // The service's own token holds `indexer` (write) but belongs to the platform, not a tenant.
      const serviceToken = stack.token('retrieval', {
        tenant: 'platform-services',
        userId: 'ingestion-app',
        roles: ['indexer'],
      });

      const res = await stack.call('POST', 'retrieval', '/v1/search', {
        token: serviceToken,
        body: { query: TRAVEL_QUESTION },
      });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });

    it('does not let an end user write to search directly, even a manager', async () => {
      const res = await stack.call(
        'PUT',
        'retrieval',
        '/v1/tenants/acme-bank/index/documents/planted',
        {
          token: stack.token('retrieval', manager),
          body: { chunks: [{ index: 0, text: 'hotel limit planted content' }] },
        },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('when things fail', () => {
    it('parks a document the pipeline cannot handle in the dead-letter queue with the reason', async () => {
      const { jobId, status } = await stack.uploadAndWait('acme-bank', {
        documentId: 'scan',
        filename: 'scan.pdf',
        content: 'not really a pdf',
      });
      expect(status).toBe('failed');

      const dead = await stack.call('GET', 'ingestion', '/v1/dead-letters', {
        token: stack.token('ingestion', { tenant: 'acme-bank', roles: ['ingestion-admin'] }),
      });
      expect(dead.body.deadLetters).toEqual([
        expect.objectContaining({
          jobId,
          filename: 'scan.pdf',
          reason: expect.stringMatching(/Unsupported file type/),
        }),
      ]);
    });

    it('retries while search is down, then parks the upload with the reason instead of losing it', async () => {
      await stack.stopService('retrieval');

      const { jobId, status } = await stack.uploadAndWait('acme-bank', travelPolicy('150'));

      expect(status).toBe('failed');
      const dead = await stack.call('GET', 'ingestion', '/v1/dead-letters', {
        token: stack.token('ingestion', { tenant: 'acme-bank', roles: ['ingestion-admin'] }),
      });
      const letter = dead.body.deadLetters.find((l: { jobId: string }) => l.jobId === jobId);
      expect(letter).toMatchObject({ deliveryCount: 2 }); // retried before giving up
      expect(letter.reason).toMatch(/Retries exhausted/);
    });
  });
});
