import { authProviders } from '@genai/auth';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RetrievalController } from './api/retrieval.controller';
import { RetrievalExceptionFilter } from './api/retrieval-exception.filter';
import { RETRIEVAL_CONFIG, loadConfig, type RetrievalConfig } from './config/config';
import { EMBEDDER, type Embedder } from './embedding/embedder';
import { HashingEmbedder } from './embedding/hashing-embedder';
import { HealthController } from './health.controller';
import { InMemorySearchIndex } from './index/in-memory-search-index';
import { IndexingService } from './index/indexing.service';
import { SEARCH_INDEX, type SearchIndex } from './index/search-index';
import { OverlapReranker } from './rerank/overlap-reranker';
import { RERANKER, type Reranker } from './rerank/reranker';
import { SearchService } from './search/search.service';

@Module({
  controllers: [HealthController, RetrievalController],
  providers: [
    { provide: RETRIEVAL_CONFIG, useFactory: () => loadConfig() },
    { provide: SEARCH_INDEX, useFactory: () => new InMemorySearchIndex() },
    {
      provide: EMBEDDER,
      inject: [RETRIEVAL_CONFIG],
      useFactory: (c: RetrievalConfig) => new HashingEmbedder(c.vectorDimensions),
    },
    { provide: RERANKER, useFactory: () => new OverlapReranker() },
    {
      provide: IndexingService,
      inject: [SEARCH_INDEX, EMBEDDER],
      useFactory: (index: SearchIndex, embedder: Embedder) => new IndexingService(index, embedder),
    },
    {
      provide: SearchService,
      inject: [SEARCH_INDEX, EMBEDDER, RERANKER, RETRIEVAL_CONFIG],
      useFactory: (
        index: SearchIndex,
        embedder: Embedder,
        reranker: Reranker,
        c: RetrievalConfig,
      ) =>
        new SearchService(index, embedder, reranker, {
          candidatesPerRetriever: c.candidatesPerRetriever,
          rerankCandidates: c.rerankCandidates,
          rrfK: c.rrfK,
          minSimilarity: c.minSimilarity,
        }),
    },
    { provide: APP_FILTER, useClass: RetrievalExceptionFilter },
    ...authProviders(),
  ],
})
export class AppModule {}
