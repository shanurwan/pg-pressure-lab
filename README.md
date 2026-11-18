# pg-pressure-lab

Reproducible drills for the ways a busy PostgreSQL behind an API gets into trouble without anything "breaking": an overnight batch job that slows live traffic, a slow query that soaks up the connection pool, a migration on a large table. Each drill measures the damage, then measures each fix, one change at a time.

The application is a small brokerage-style API in Go (pgx): account and position reads, order placement that locks the account row, and one deliberately expensive report. It runs behind PgBouncer in transaction mode, on PostgreSQL 17 seeded with 200,000 accounts, 2 million positions and 20 million orders.

**Course site: <https://shanurwan.github.io/pg-pressure-lab/>**: every recorded run replayed in 3D, with a terminal to drive it and lessons built from the numbers below.

```
 load (open loop) ──► api (Go, pgx pools) ──► PgBouncer ──► PostgreSQL 17
                                                 ▲              ▲
 batch (end-of-day job) ─────────────────────────┘              │
 sampler: pg_stat_activity, SHOW POOLS, API pool stats, every second
```

## What the runs show

All numbers are from `results/batch/`, 300 requests a second for 180 s, with the batch starting at 30 s unless the rate column says otherwise.

- **One long transaction takes down every endpoint, not just the ones it locks.** The naive batch locks account rows; order requests wait on those locks while holding pool connections, the pool empties, and reads fail too. 53 to 66% of all requests failed.
- **It does not come back when the batch ends.** In every naive run the API was still failing when the run ended, 21,600 to 30,000 requests after the batch had committed. A request waits almost its whole 2 s budget for a connection, starts a query with milliseconds left and is cancelled; pgx closes a connection whose query is cancelled (its default `DeadlineContextWatcherHandler`), so PgBouncer drops its server connection too (`client disconnect while server was not ready`) and PostgreSQL starts a new session: 112 to 121 new sessions a second, against 0 to 8 when healthy. The trigger is gone and the failure sustains itself, a [metastable failure](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf).
- **More headroom does not save it.** At half the load (150 requests a second) it failed the same way and never recovered either.
- **Fix the job:** short transactions with a `lock_timeout`, its own small pool. No failed requests in either run; the batch takes about 100 s instead of 47 to 76 s.
- **Or fix the caller:** wait at most 250 ms for a connection and start no query with less than 250 ms left. The same naive batch now costs about 7.7% of requests, all inside the lock window, and the API is healthy within a second of the batch ending.
- **Alert on transaction age.** The age of the oldest open transaction rose above its normal range 26 to 47 s before the first failed request. Lock waits rose only after callers were already failing.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Batch | Failed after batch ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| baseline | 20261118T034857Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 658 ms | 502 ms | none | none | 0 | - | 0 | 29 | 0.6 s | 0 |
| baseline | 20261118T035835Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 529 ms | 375 ms | none | none | 0 | - | 0 | 16 | 0.3 s | 0 |
| baseline | 20261118T043131Z | 150/s | 27001 | 0 (0.00%) | 0 | 100% ok | 87 ms | 66 ms | none | none | 0 | - | 0 | 0 | 0.1 s | 8 |
| naive | 20261118T035209Z | 300/s | 54001 | 35490 (65.72%) | 121 | 0% ok | 405 ms | 1236 ms | deadline 35490 | 47 s | 30000 | not within the run | 20 | 40 | 46.1 s | 0 |
| naive | 20261118T040144Z | 300/s | 54001 | 29124 (53.93%) | 101 | 0% ok | 658 ms | 1567 ms | deadline 29124 | 72 s | 22800 | not within the run | 19 | 40 | 71.5 s | 0 |
| naive | 20261118T041152Z | 300/s | 54001 | 28699 (53.15%) | 102 | 0% ok | 1886 ms | 1937 ms | deadline 28699 | 76 s | 21600 | not within the run | 19 | 40 | 75.9 s | 0 |
| naive | 20261118T041821Z | 300/s | 54001 | 30540 (56.55%) | 104 | 0% ok | 324 ms | 1486 ms | deadline 30540 | 64 s | 25200 | not within the run | 20 | 40 | 63.4 s | 0 |
| naive | 20261118T042500Z | 300/s | 54001 | 31452 (58.24%) | 108 | 0% ok | 532 ms | 1011 ms | deadline 31452 | 62 s | 26100 | not within the run | 20 | 40 | 61.6 s | 121 |
| naive | 20261118T042815Z | 150/s | 27001 | 17032 (63.08%) | 117 | 0% ok | 397 ms | 1295 ms | deadline 17032 | 55 s | 13950 | not within the run | 20 | 40 | 54.4 s | 112 |
| naive-failfast | 20261118T041508Z | 300/s | 54001 | 4243 (7.86%) | 20 | 5% ok | 294 ms | 582 ms | deadline 224, pool_exhausted 4019 | 65 s | 0 | 1 s | 20 | 20 | 65.0 s | 0 |
| naive-failfast | 20261118T042133Z | 300/s | 54001 | 4148 (7.68%) | 19 | 7% ok | 238 ms | 473 ms | deadline 206, pool_exhausted 3942 | 55 s | 0 | 0 s | 20 | 23 | 54.2 s | 33 |
| chunked | 20261118T035522Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 222 ms | 128 ms | none | 100 s | 0 | 0 s | 0 | 1 | 13.3 s | 0 |
| chunked | 20261118T040458Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 279 ms | 163 ms | none | 102 s | 0 | 0 s | 1 | 17 | 10.8 s | 0 |

Regenerate with `go run ./cmd/report -scenario batch -rounds baseline,naive,naive-failfast,chunked`.

## Run it

Needs Docker with Compose v2.

```sh
scripts/lab up                  # build and start
scripts/lab seed                # ~10 minutes for the default size; ORDERS=1000000 for a quick try
scripts/lab rounds batch        # list a scenario's rounds
scripts/lab run batch naive     # one recorded run
scripts/lab down                # delete everything, data included
```

Each run writes `results/<scenario>/<round>/<UTC time>/`:

| File | What it holds |
|---|---|
| `summary.json` | per operation: requests, success ratio, p50/p95/p99/max latency, errors by code |
| `load.csv` | the same, per second, so you can see when trouble starts and ends |
| `sampler.csv` | per second: active and lock-waiting backends, longest transaction, PgBouncer clients waiting, API pool waits |
| `batch.json` | the batch job's duration, chunks and lock-timeout retries |
| `pg_stat_statements.tsv` | the top statements by total time during the run |
| `pg_log_excerpt.txt` | lock waits and slow statements from the server log |
| `meta.json` | the exact round settings and the git commit |

## Scenarios

### `batch`: an end-of-day job against live traffic

The job snapshots every position at the closing price, marks every account to market, and rolls up the day's orders. Live traffic keeps arriving at a fixed rate the whole time.

| Round | What changes |
|---|---|
| `baseline` | no batch: the reference |
| `naive` | the whole job in one transaction. It updates every account early, then holds those row locks through the slow rollup, so every order for any account waits |
| `chunked` | 1,000 accounts per short transaction with `lock_timeout = 100ms` (the job yields to orders, retries the chunk), a pause between chunks, its own two-connection PgBouncer pool, and the rollup outside any account lock |

### `conn`: one slow query in a shared pool

One request in a hundred asks for a report that scans the orders table. Alone it is merely slow; under load it holds pool connections, and everything else queues behind it.

| Round | What changes |
|---|---|
| `baseline` | no report traffic |
| `shared` | report traffic on the same pool as everything else |
| `bulkhead` | reports get their own three-connection pool, in the API and in PgBouncer |
| `bulkhead-timeout` | plus `statement_timeout = 1s` for the report role |

## Live mode

`scripts/lab live` serves the course site at <http://localhost:58090> and streams whatever run is in progress into it, one frame a second over Server-Sent Events (`/live/events`), in the same format the site replays. Start a run in another terminal and watch it.

## MCP server

`cmd/mcp` lets Claude or any MCP client read the runs: `list_rounds`, `list_runs`, `get_timeline` (second by second, every layer), `first_signals` (which signal rose first, and how far ahead of the first failure), and `run_drill`, which runs a round on your local lab only when the server is started with `-allow-run`.

```sh
claude mcp add pg-pressure-lab -- go run ./cmd/mcp -repo "$PWD"
```

## How the measurements are made

- **Open-loop load.** Requests are sent on a fixed schedule whether or not earlier ones have returned, as real customers do. A closed-loop tool slows down with the server and hides the problem. If the generator cannot keep up it records the request as `dropped`, never skips it silently.
- **Failures are counted, not timed.** Latency percentiles cover successful requests only; a burst of fast errors cannot make latency look better. Errors are reported by cause: `deadline` (the API's 2 s budget ran out, usually waiting for a connection or a lock), `lock_timeout`, `statement_timeout`, `client_timeout`.
- **One change per round,** all other settings recorded in `meta.json`, and the role settings reset before every run.
- **Settings live on roles** (`ALTER ROLE report SET statement_timeout = ...`). Under PgBouncer transaction pooling, settings sent at connect time are dropped; this lab's PgBouncer config ignores them on purpose, which is also what happens by default in many real setups.
- **Memory is capped per container; CPU is not** (the reference host does not support CPU quotas for containers). Compare rounds run on the same host, not absolute numbers across machines.

## Layout

```
cmd/api       the API under test
cmd/load      open-loop load generator
cmd/batch     the end-of-day job (naive | chunked)
cmd/sampler   per-second view of PostgreSQL, PgBouncer and the API pool
cmd/report    the comparison tables
cmd/live      live mode: the site plus a stream of the run in progress
cmd/mcp       MCP server over the recorded runs
cmd/sitedata  builds site/data from results/
internal/runs reading runs: tables, timelines, first signals
site/         the course site (GitHub Pages)
deploy/       compose file, schema, seed, PgBouncer config
scripts/lab   the driver: rounds are defined at the top
results/      recorded runs
```

## License

Apache-2.0
