import { loadConfig } from './config';

describe('loadConfig', () => {
  it('has sensible defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3003,
      vectorDimensions: 256,
      candidatesPerRetriever: 50,
      rerankCandidates: 20,
      rrfK: 60,
      minSimilarity: 0.1,
    });
  });

  it('fails fast on out-of-range values', () => {
    expect(() => loadConfig({ MIN_SIMILARITY: '2' })).toThrow();
    expect(() => loadConfig({ VECTOR_DIMENSIONS: '4' })).toThrow();
  });
});
