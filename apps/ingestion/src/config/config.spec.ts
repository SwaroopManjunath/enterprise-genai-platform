import { loadConfig } from './config';

describe('loadConfig', () => {
  it('has sensible defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3002);
    expect(config.maxDeliveries).toBe(3);
    expect(config.chunking).toEqual({ maxChars: 1000, overlapChars: 100 });
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() => loadConfig({ CHUNK_MAX_CHARS: '200', CHUNK_OVERLAP_CHARS: '200' })).toThrow(
      /smaller than/,
    );
  });

  it('allows disabling the poller', () => {
    expect(loadConfig({ POLL_INTERVAL_MS: '0' }).pollIntervalMs).toBe(0);
  });

  describe('index sink', () => {
    const retrieval = {
      INDEX_SINK: 'retrieval',
      RETRIEVAL_URL: 'http://retrieval.test',
      TOKEN_ENDPOINT: 'https://login.test/t/oauth2/v2.0/token',
      CLIENT_ID: 'ingestion-app',
    };

    it('defaults to the in-memory sink', () => {
      expect(loadConfig({}).index).toEqual({ sink: 'memory' });
    });

    it('configures the retrieval sink, holding only the NAME of the client secret', () => {
      expect(loadConfig(retrieval).index).toEqual({
        sink: 'retrieval',
        url: 'http://retrieval.test',
        scope: 'api://retrieval/.default',
        timeoutMs: 10_000,
        tokenEndpoint: 'https://login.test/t/oauth2/v2.0/token',
        clientId: 'ingestion-app',
        clientSecretName: 'ingestion-client-secret',
      });
    });

    it.each(['RETRIEVAL_URL', 'TOKEN_ENDPOINT', 'CLIENT_ID'])(
      'fails fast when the retrieval sink is chosen without %s',
      (missing) => {
        const env: Record<string, string> = { ...retrieval };
        delete env[missing];
        expect(() => loadConfig(env)).toThrow(/INDEX_SINK=retrieval requires/);
      },
    );
  });
});
