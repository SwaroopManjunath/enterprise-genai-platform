# Load test: capacity-mock

Model: mock. Answer cache: off. Each rate held for 30s, whole answers, arrivals at a fixed rate (open model).
Run on darwin/arm64, containers in Docker Desktop (8 CPUs, 7.7 GiB shared with the load generator and the monitoring stack).

| Offered req/s | Achieved req/s | Failed | Dropped | p50 ms | p95 ms | p99 ms | max ms |
| ------------: | -------------: | -----: | ------: | -----: | -----: | -----: | -----: |
|            10 |           10.0 |  0.00% |       0 |     17 |     66 |    358 |    572 |
|            25 |           25.0 |  0.00% |       0 |      8 |     15 |     26 |     65 |
|            50 |           50.0 |  0.00% |       0 |      5 |      9 |     13 |     18 |
|           100 |          100.0 |  0.00% |       0 |      4 |      8 |     16 |    157 |
|           200 |          200.0 |  0.00% |       0 |      3 |      8 |     15 |     31 |
|           400 |          400.0 |  0.00% |       0 |      3 |     24 |     74 |    225 |

Highest rate that stayed healthy (under 1% failed, nothing dropped, p95 under 1000 ms): **400 req/s**.

"Dropped" are arrivals k6 could not start because every virtual user was busy: the system, or the machine, could not keep up.

## Peak resource use during each rate

| Offered req/s | assistant CPU / MiB | llm-gateway CPU / MiB | retrieval CPU / MiB | prompt-registry CPU / MiB |
| ------------: | ------------------- | --------------------- | ------------------- | ------------------------- |
|            10 | 28% / 84            | 6% / 50               | 20% / 53            | 10% / 49                  |
|            25 | 20% / 90            | 14% / 74              | 11% / 75            | 17% / 58                  |
|            50 | 20% / 94            | 13% / 75              | 11% / 81            | 11% / 76                  |
|           100 | 49% / 133           | 25% / 78              | 15% / 88            | 12% / 83                  |
|           200 | 59% / 215           | 24% / 82              | 32% / 91            | 16% / 85                  |
|           400 | 91% / 232           | 33% / 93              | 34% / 110           | 26% / 88                  |

(100% is one CPU core.)

## What the platform recorded

- Model calls: 22765 served, n/a by the fallback, n/a failed, n/a refused by a limit.
- Answers: 23584, of which n/a came from the cache.
- Tokens: 5686837 prompt, 319263 completion.
- Spend: $0.0000 at the configured prices.
- Alerts pending or firing at the end: AnswerGroundingDripBurn (pending).
