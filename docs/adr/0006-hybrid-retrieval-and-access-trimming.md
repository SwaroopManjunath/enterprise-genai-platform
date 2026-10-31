# ADR 0006: Hybrid retrieval with security trimming

- Status: Accepted
- Date: 2026-10-31

## Context

The assistant answers from enterprise documents, so retrieval quality decides answer quality, and
retrieval access control decides whether the assistant leaks something it should not. Users ask in
varied wording ("how long do refunds take") and also with exact terms ("XK-9921", "IBAN"). Documents
differ in who may read them (everyone, managers only, finance only).

## Decisions

### 1. Hybrid search (keyword + vector) instead of pure vector search

| Query type                              | Keyword (BM25)          | Vector (embeddings)        |
| --------------------------------------- | ----------------------- | -------------------------- |
| Exact code, name, rare term             | Strong                  | Can blur                   |
| Different wording, word forms, synonyms | Misses unless stemmed   | Strong (with a real model) |
| Explainability                          | Clear (which terms hit) | Opaque                     |

Each retriever catches what the other misses, so we run both. In tests, a query for "refunding"
finds nothing by keyword but is found by vector search, while an exact code is found by keyword.

### 2. Reciprocal Rank Fusion to combine them

BM25 scores and cosine similarities are on unrelated scales. Weighted score blending needs tuning
that drifts as the corpus changes. RRF combines **ranks** (`sum 1/(k+rank)`, k=60): no
normalisation, no weights, and a chunk found by only one retriever still gets a fair score.

_Alternative:_ weighted sum of normalised scores. Rejected for the tuning burden.

### 3. A reranking second stage on a small pool

First stage is cheap and recall-oriented (scan everything, keep ~50 per retriever). The reranker is
precision-oriented and costly, so it only sees the top 20 fused candidates. It rewards chunks that
cover the whole query, match the section heading and keep word order, which raw BM25 can miss when a
single term is simply repeated. Locally this is a heuristic; in production it is a cross-encoder or
Azure AI Search's semantic ranker behind the same `Reranker` interface.

The reranker initially matched words exactly and scored a vector-found "refunds" chunk 0 for the
query "refunding", undoing the vector retriever's recall. It now matches close word forms.

### 4. Security trimming as a pre-filter, at the lowest layer

`SearchIndex.candidates()` returns only chunks from the caller's tenant that the caller's roles may
see, **before** any scoring. Because trimming sits in the storage port's contract:

- No later stage can forget it: BM25, vector search, reranking and ordering never see forbidden data.
- Scores cannot leak content. BM25 uses document-frequency statistics, so computing them over the
  full corpus would let a hidden document shift the score or rank of visible ones, revealing it
  exists. A test asserts identical scores with and without a hidden document.
- It maps to Azure AI Search's `$filter` applied at query time (pre-filter), not result post-filtering,
  which would leak through counts and paging and waste top-K slots on documents the user cannot see.

Rule: a document with no `allowedRoles` is visible to its tenant; otherwise the caller needs at least
one matching role. Tenant is also a hard boundary (never crossed, even for the same document id).

### 5. Explainable results

Each hit returns its signals (keyword rank/score, vector rank/score, fused score, rerank score).
Relevance bugs are otherwise guesswork; the "refunding" reranker bug above was found by reading them.

## Consequences

- Better recall and precision than either retriever alone, with debuggable ranking.
- The local embedder (`HashingEmbedder`) captures spelling overlap, not meaning ("reimbursement"
  does not match "refund"; a test documents this). A real embedding model removes the limit behind
  the same `Embedder` interface; fusion, reranking and access control stay unchanged.
- In-memory search recomputes BM25 statistics per query over the visible candidates, which is fine
  at demo scale; a real engine precomputes them.
- Roles currently come from an `x-roles` header (interim). Step 6 reads them from validated Entra ID
  token claims, and the on-behalf-of flow makes "the AI only sees what the user may see" end to end.
- Ingestion and retrieval keep separate in-memory indexes locally. In production both point at the
  same Azure AI Search index; retrieval exposes an index endpoint so it is usable standalone.

> **Update (ADR 0009):** ingestion now writes to retrieval's index through tenant-scoped routes
> (`/v1/tenants/:tenant/index/documents/:id`, `indexer` role) instead of keeping a separate index.
