# Load test: capacity-mock

Model: mock. Answer cache: off. Each rate held for 30s, whole answers, arrivals at a fixed rate (open model).
Run on darwin/arm64, containers in Docker Desktop (8 CPUs, 7.7 GiB shared with the load generator and the monitoring stack).

| Offered req/s | Achieved req/s | Failed | Dropped | p50 ms | p95 ms | p99 ms | max ms |
| ------------: | -------------: | -----: | ------: | -----: | -----: | -----: | -----: |
|            10 |           10.0 |  0.00% |       0 |     16 |     22 |     28 |    118 |
|            50 |           50.0 |  0.00% |       0 |      5 |      8 |     12 |     25 |
|           100 |          100.0 |  0.00% |       0 |      4 |      7 |     13 |     64 |
|           200 |          200.0 |  0.00% |       0 |      3 |      6 |     12 |     28 |
|           400 |          380.8 |  0.00% |       0 |      3 |    118 |   1534 |   1744 |
|           600 |          385.3 |  0.28% |    2486 |    665 |   9003 |  24152 |  27189 |
|           800 |          441.2 |  1.01% |    4074 |   1069 |   1704 |  26800 |  29690 |
|          1000 |          300.0 |  7.91% |   12309 |   1031 |   5123 |  32804 |  52981 |

Highest rate that stayed healthy (under 1% failed, nothing dropped, p95 under 1000 ms): **400 req/s**.

"Dropped" are arrivals k6 could not start because every virtual user was busy: the system, or the machine, could not keep up.

## Peak resource use during each rate

| Offered req/s | assistant CPU / MiB | llm-gateway CPU / MiB | retrieval CPU / MiB | prompt-registry CPU / MiB |
| ------------: | ------------------- | --------------------- | ------------------- | ------------------------- |
|            10 | 16% / 83            | 3% / 47               | 10% / 52            | 13% / 51                  |
|            50 | 29% / 95            | 10% / 74              | 13% / 77            | 12% / 76                  |
|           100 | 31% / 122           | 23% / 74              | 16% / 84            | 22% / 79                  |
|           200 | 53% / 208           | 22% / 82              | 28% / 88            | 22% / 83                  |
|           400 | 118% / 253          | 35% / 87              | 40% / 102           | 37% / 85                  |
|           600 | 156% / 377          | 53% / 140             | 61% / 161           | 54% / 131                 |
|           800 | 149% / 436          | 44% / 144             | 51% / 162           | 39% / 131                 |
|          1000 | 149% / 431          | 42% / 158             | 49% / 162           | 63% / 157                 |

(100% is one CPU core.)

## What the platform recorded

- Model calls: 71683 served, 0 by the fallback, 0 failed, 0 refused by a limit.
- Answers: 74328, of which 0 came from the cache.
- Tokens: 17903324 prompt, 1007663 completion.
- Spend: not priced (the stand-in model has no price).
- Alerts pending or firing at the end: none.
