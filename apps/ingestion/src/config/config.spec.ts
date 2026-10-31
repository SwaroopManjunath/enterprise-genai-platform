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
});
