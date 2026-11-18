# pg-pressure-lab

Reproducible drills for the ways a busy PostgreSQL behind an API gets into trouble without anything "breaking": an overnight batch job that slows live traffic, a slow query that soaks up the connection pool, a migration on a large table. Each drill measures the damage, then measures each fix, one change at a time.

The application is a small brokerage-style API in Go (pgx): account and position reads, order placement that locks the account row, and one deliberately expensive report. It runs behind PgBouncer in transaction mode, on PostgreSQL 17 seeded with 200,000 accounts, 2 million positions and 20 million orders.

```
 load (open loop) ──► api (Go, pgx pools) ──► PgBouncer ──► PostgreSQL 17
                                                 ▲              ▲
 batch (end-of-day job) ─────────────────────────┘              │
 sampler: pg_stat_activity, SHOW POOLS, API pool stats, every second
```

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
deploy/       compose file, schema, seed, PgBouncer config
scripts/lab   the driver: rounds are defined at the top
results/      recorded runs
```

## License

Apache-2.0
