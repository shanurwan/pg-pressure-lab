# pg-pressure-lab

Reproducible drills for the ways a busy PostgreSQL behind an API gets into trouble without anything "breaking": an overnight batch job that slows live traffic, a slow query that soaks up the connection pool, a migration on a large table. Each drill measures the damage, then measures each fix, one change at a time.

The application is a small brokerage-style API in Go (pgx): account and position reads, order placement that locks the account row, and one deliberately expensive report. It runs behind PgBouncer in transaction mode, on PostgreSQL 17 seeded with 200,000 accounts, 2 million positions and 20 million orders.

**Interactive replays: <https://shanurwan.github.io/pg-pressure-lab/>**: every recorded run replayed in 3D, with a terminal to drive it and lessons built from the numbers below.

```
 load (open loop) ──► api (Go, pgx pools) ──► PgBouncer ──► PostgreSQL 17
                                                 ▲              ▲
 batch (end-of-day job) ─────────────────────────┘              │
 sampler: pg_stat_activity, SHOW POOLS, API pool stats, every second
```

## What the runs show

Every number below comes from `results/`, at 300 requests a second for 180 s with the trigger starting at 30 s, unless the rate column says otherwise. Each round ran at least twice; where two runs of the same round disagree, both are shown. The real incident each scenario is modelled on is linked at the top of its section.

### Batch job against live traffic

Modelled on Railway's [28 Oct 2025 incident](https://blog.railway.com/p/incident-report-oct-28th-2025), where a long lock-holding operation piled up connections until every slot was taken, and the [AWS us-east-1 outage of 7 Dec 2021](https://aws.amazon.com/message/12721/), where the failure outlived its trigger. Alpaca's [28 Aug 2026 status note](https://stspg.io/tdl12cgrzvrm) describes a similar night: an overnight batch with more data than usual that reduced capacity for its API.

- **One long transaction takes down every endpoint, not just the ones it locks.** The naive batch locks account rows; order requests wait on those locks while holding pool connections, the pool empties, and reads fail too. 53 to 66% of all requests failed.
- **It does not come back when the batch ends.** In every naive run the API was still failing when the run ended, 21,600 to 30,000 requests after the batch had committed. A request waits almost its whole 2 s budget for a connection, starts a query with milliseconds left and is cancelled; pgx closes a connection whose query is cancelled (its default `DeadlineContextWatcherHandler`), so PgBouncer drops its server connection too (`client disconnect while server was not ready`) and PostgreSQL starts a new session: 112 to 121 new sessions a second, against 0 to 8 when healthy. The trigger is gone and the failure sustains itself, a [metastable failure](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf).
- **More headroom does not save it.** At half the load (150 requests a second) it failed the same way and never recovered either.
- **One pgx setting breaks the loop.** With only the context watcher changed to `CancelRequestContextWatcherHandler` (ask the server to cancel, keep the connection), the same naive batch cost 1.7 to 1.9% of requests, none after the batch, and the API was healthy within a second.
- **Fix the job:** short transactions with a `lock_timeout`, its own small pool. No failed requests in either run; the batch takes about 100 s instead of 47 to 76 s.
- **Or fix the caller:** wait at most 250 ms for a connection and start no query with less than 250 ms left. About 7.7% of requests failed, all inside the lock window, and the API was healthy within a second of the batch ending.
- **Alert on transaction age.** The age of the oldest open transaction rose above its normal range 26 to 47 s before the first failed request. Lock waits rose only after callers were already failing.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
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
| naive-cancelreq | 20261118T053246Z | 300/s | 54001 | 920 (1.70%) | 14 | 68% ok | 769 ms | 2104 ms | canceled 677, deadline 243 | 36 s | 0 | 1 s | 20 | 25 | 36.0 s | 86 |
| naive-cancelreq | 20261118T053552Z | 300/s | 54001 | 1033 (1.91%) | 14 | 55% ok | 918 ms | 2112 ms | canceled 598, deadline 435 | 39 s | 0 | 0 s | 20 | 35 | 37.8 s | 98 |
| chunked | 20261118T035522Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 222 ms | 128 ms | none | 100 s | 0 | 0 s | 0 | 1 | 13.3 s | 0 |
| chunked | 20261118T040458Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 279 ms | 163 ms | none | 102 s | 0 | 0 s | 1 | 17 | 10.8 s | 0 |

### Schema changes on hot tables

Modelled on GoCardless's [lock-queue outage](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/) and Railway's [28 Oct 2025 non-concurrent index](https://blog.railway.com/p/incident-report-oct-28th-2025).

- **A fast ALTER can stop the API for as long as the slowest reader.** `ADD COLUMN` itself takes milliseconds, but it waited 43 s behind a 45 s read transaction, and every query on `accounts` queued behind it: 21 to 22% of all requests failed, reads included, over 42 to 48 seconds.
- **`lock_timeout` plus retries turns that into nothing.** The same ALTER with `lock_timeout = 1s`, retried with backoff (12 attempts in the first run), never sat at the head of the queue for more than a second. No request failed in either run; the cost was a p99 of about 0.9 s while it kept trying.
- **A plain `CREATE INDEX` on a 20M-row table blocks writes for the whole build.** 71 to 88 s of builds failed 13 and 36% of all requests; in the second run failures continued 30 s after the build finished.
- **`CREATE INDEX CONCURRENTLY` cost nothing visible:** no failed request, order p99 52 to 105 ms, no lock waiters, for a build of 67 to 101 s.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| alter-naive | 20261118T061737Z | 300/s | 54001 | 11336 (20.99%) | 42 | 3% ok | 934 ms | 2691 ms | canceled 96, deadline 11240 | migration 45 s | 0 | 1 s | 21 | 20 | 45.0 s | 52 |
| alter-naive | 20261118T071807Z | 300/s | 54001 | 11930 (22.09%) | 48 | 3% ok | 976 ms | 2557 ms | canceled 33, deadline 11897 | migration 45 s | 258 | 4 s | 21 | 37 | 45.0 s | 77 |
| alter-locktimeout | 20261118T062045Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 885 ms | 860 ms | none | migration 46 s | 0 | 0 s | 21 | 20 | 44.5 s | 6 |
| alter-locktimeout | 20261118T072118Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 932 ms | 890 ms | none | migration 49 s | 0 | 0 s | 21 | 20 | 45.1 s | 8 |
| index-plain | 20261118T062353Z | 300/s | 54001 | 6943 (12.86%) | 70 | 38% ok | 1203 ms | 2229 ms | canceled 1641, deadline 5302 | migration 71 s | 0 | 1 s | 20 | 37 | 71.0 s | 84 |
| index-plain | 20261118T072430Z | 300/s | 54001 | 19282 (35.71%) | 119 | 27% ok | 1537 ms | 2361 ms | canceled 26, deadline 19256 | migration 88 s | 4560 | 30 s | 20 | 39 | 87.1 s | 62 |
| index-concurrently | 20261118T062717Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 52 ms | 26 ms | none | migration 67 s | 0 | 1 s | 0 | 0 | 66.6 s | 7 |
| index-concurrently | 20261118T072744Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 105 ms | 51 ms | none | migration 101 s | 0 | 0 s | 0 | 0 | 99.8 s | 10 |

### Clients retrying into a short outage

Modelled on the [AWS us-east-1 outage of 7 Dec 2021](https://aws.amazon.com/message/12721/) and Alpaca's [24 Jun 2026 incident](https://stspg.io/st34r0cg995k), where inbound connections exceeded capacity. Every round has the same 15 s exclusive lock on `accounts`.

- **Without retries the API is back the second the lock ends:** 6.6% of requests failed, all within 14 seconds.
- **Immediate retries made it longer, and once permanent.** Up to three retries at once sent 21,951 extra requests in one run and 98,912 in the other. The first run kept failing for 16 s after the lock ended (9.7% failed); the second never recovered (50.5% failed, 23,582 after the lock was gone). The same 15 s trigger, the same API: the only difference is the clients.
- **Backoff with a retry budget behaves like no retries at all,** which is the point: the budget allowed 494 and 495 retries and refused 3,518 and 3,547, and the API was healthy within a second of the lock ending.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| no-retry | 20261118T063026Z | 300/s | 54001 | 3578 (6.63%) | 14 | 5% ok | 650 ms | 2117 ms | canceled 58, deadline 3520 | lock 15 s | 0 | 0 s | 20 | 20 | 15.0 s | 33 |
| no-retry | 20261118T073056Z | 300/s | 54001 | 3552 (6.58%) | 14 | 5% ok | 707 ms | 2173 ms | canceled 36, deadline 3516 | lock 15 s | 0 | 0 s | 20 | 21 | 14.2 s | 30 |
| retry-immediate | 20261118T063333Z | 300/s | 54001 | 5223 (9.67%) | 32 | 8% ok | 7327 ms | 8111 ms | canceled 1, deadline 5222; 21951 retries sent, 0 refused by budget | lock 15 s | 1806 | 16 s | 20 | 36 | 14.5 s | 111 |
| retry-immediate | 20261118T073409Z | 300/s | 54001 | 27285 (50.53%) | 150 | 5% ok | 178 ms | 8316 ms | deadline 27285; 98912 retries sent, 0 refused by budget | lock 15 s | 23582 | not within the run | 20 | 39 | 14.2 s | 88 |
| retry-backoff-budget | 20261118T063642Z | 300/s | 54001 | 3519 (6.52%) | 14 | 4% ok | 1053 ms | 2129 ms | deadline 3519; 494 retries sent, 3518 refused by budget | lock 15 s | 0 | 0 s | 20 | 20 | 14.2 s | 27 |
| retry-backoff-budget | 20261118T073816Z | 300/s | 54001 | 3548 (6.57%) | 14 | 5% ok | 929 ms | 2301 ms | deadline 3548; 495 retries sent, 3547 refused by budget | lock 15 s | 0 | 1 s | 20 | 20 | 14.0 s | 30 |

### A forgotten transaction holds back VACUUM

Modelled on Trigger.dev's [stuck xmin horizon](https://trigger.dev/blog/stopping-xmin-horizon-blocking-postgres-vacuuming) and Sentry's [transaction ID wraparound](https://blog.sentry.io/transaction-id-wraparound-in-postgres/). Nothing fails here; it is slow damage.

- **One idle session made a 2,000-row table 40 to 60 times bigger in under three minutes.** While it held its snapshot, `quotes` reached 224,000 to 273,000 dead row versions and 15 to 18 MB, against 1,700 to 2,400 and 0.3 to 0.4 MB without it.
- **Every read of that table got slower:** the market summary's median rose about 4.5 times over the run (3.3 to 14.8 ms, 6.3 to 28.7 ms), and its p99 2 to 3 times.
- **`idle_in_transaction_session_timeout = 10s` caps the damage:** the session was ended after 10 s, dead rows peaked at 18,000 to 22,000 and were reclaimed, and the table stayed at 1.5 MB.
- **What to watch:** `age(backend_xmin)` in `pg_stat_activity` (it reached 231,000 to 279,000 transactions here) and `n_dead_tup`; the sampler records both.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| baseline | 20261118T063950Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 111 ms | 46 ms | none | none | 0 | - | 0 | 0 | 0.1 s | 12 |
| baseline | 20261118T074129Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 123 ms | 62 ms | none | none | 0 | - | 0 | 20 | 0.2 s | 17 |
| idle-tx | 20261118T064258Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 49 ms | 27 ms | none | idle_tx 140 s | 0 | not within the run | 1 | 0 | 139.3 s | 14 |
| idle-tx | 20261118T074527Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 180 ms | 74 ms | none | idle_tx 140 s | 0 | not within the run | 0 | 0 | 139.5 s | 15 |
| idle-tx-timeout | 20261118T064607Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 105 ms | 44 ms | none | idle_tx ended with an error after 140 s | 0 | not within the run | 0 | 14 | 9.8 s | 14 |
| idle-tx-timeout | 20261118T074925Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 162 ms | 86 ms | none | idle_tx ended with an error after 140 s | 0 | not within the run | 1 | 0 | 10.0 s | 14 |

### A 32-bit column pointing at a 64-bit key

Modelled on Buildkite's [22 Jul 2023 incident](https://buildkitestatus.com/incidents/63zxhjsysszc).

- **Everything works until the id passes 2,147,483,647, then every order fails.** Starting 4,500 ids below the limit at about 75 orders a second, the first failure came at second 60 and every order after it failed (`integer out of range`): 16.3 to 16.7% of all requests, all of them orders.
- **The same table with a `bigint` column: no failures.**
- **The warning is a subtraction.** `2147483647 - last_value` divided by the insert rate gives the date this happens; the sampler's `int4_ids_left` column showed 60 s of headroom at the start of the run. In production that number is months, which is why it is easy to forget.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| int4 | 20261118T071129Z | 300/s | 54001 | 8819 (16.33%) | 120 | 70% ok | 216 ms | 46 ms | integer_out_of_range 8819 | none | 0 | - | 0 | 1 | 0.1 s | 8 |
| int4 | 20261118T082314Z | 300/s | 54001 | 8989 (16.65%) | 120 | 69% ok | 175 ms | 38 ms | integer_out_of_range 8989 | none | 0 | - | 0 | 4 | 0.1 s | 8 |
| bigint | 20261118T071453Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 84 ms | 44 ms | none | none | 0 | - | 0 | 0 | 0.1 s | 9 |
| bigint | 20261118T082634Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 85 ms | 36 ms | none | none | 0 | - | 0 | 0 | 0.1 s | 7 |

### Every order on one account row

Modelled on Heroku's [table-locking UPDATE](https://www.heroku.com/blog/curious-case-table-locking-update-query/).

- **180 orders a second on one row puts the API at a tipping point.** Locking the row first, one run absorbed it (no failures, order p99 509 ms, 19 waiters on the row lock); the other tipped into the reconnect loop described above and 95.8% of all requests failed for the rest of the run.
- **Taking the row lock last removes the queue.** Recording the order first and reserving buying power in one conditional `UPDATE` just before `COMMIT`: no failures in either run, order p99 46 to 98 ms.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| baseline | 20261118T064916Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 37 ms | 23 ms | none | none | 0 | - | 0 | 0 | 0.1 s | 6 |
| baseline | 20261118T075252Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 102 ms | 47 ms | none | none | 0 | - | 0 | 18 | 0.2 s | 10 |
| hot | 20261118T065223Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 509 ms | 391 ms | none | none | 0 | - | 19 | 20 | 0.4 s | 14 |
| hot | 20261118T075604Z | 300/s | 54001 | 51747 (95.83%) | 173 | 0% ok | 1817 ms | 1727 ms | deadline 51747 | none | 0 | - | 19 | 40 | 0.4 s | 117 |
| hot-locklast | 20261118T065531Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 46 ms | 22 ms | none | none | 0 | - | 1 | 0 | 0.1 s | 5 |
| hot-locklast | 20261118T075918Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 98 ms | 45 ms | none | none | 0 | - | 14 | 8 | 0.4 s | 9 |

### One slow query in a shared pool

Modelled on Railway's [28 Oct 2025 incident](https://blog.railway.com/p/incident-report-oct-28th-2025), where long-running work took connection slots until nothing else could get one. Alpaca's [27 Jun 2026 incident](https://stspg.io/h6zvs1kdv87n) attributes order timeouts to database connection pressure.

- **Three slow reports in a hundred requests slow everything else down.** Sharing the pool, the order and read p99 rose from about 95 and 42 ms to 950 to 1,230 ms.
- **A bulkhead gives the other endpoints their latency back:** with reports on their own three connections, order p99 was 122 to 133 ms and reads 52 to 65 ms. The price is paid by the reports, which now queue among themselves: 2.2% of all requests failed, all of them reports, against 1.0 to 1.2% when shared.
- **A 1 s `statement_timeout` on top changed little here,** because a 300 ms report rarely reaches it; it is a guard for the report that suddenly takes a minute, not a fix for queueing.

| Round | Run (UTC) | Rate | Requests | Failed | Seconds with failures | Worst second | Order p99 | Read p99 | Errors | Trigger job | Failed after it ended | Recovered | Max lock waiters | Max PgBouncer queue | Longest transaction | Max new sessions/s |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|--:|---|--:|--:|--:|--:|
| baseline | 20261118T065840Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 96 ms | 42 ms | none | none | 0 | - | 0 | 0 | 0.2 s | 5 |
| baseline | 20261118T080333Z | 300/s | 54001 | 0 (0.00%) | 0 | 100% ok | 93 ms | 42 ms | none | none | 0 | - | 0 | 10 | 0.1 s | 6 |
| shared | 20261118T070150Z | 300/s | 54001 | 546 (1.01%) | 112 | 94% ok | 958 ms | 945 ms | deadline 546 | none | 0 | - | 0 | 20 | 2.0 s | 10 |
| shared | 20261118T080731Z | 300/s | 54001 | 625 (1.16%) | 110 | 95% ok | 1231 ms | 1211 ms | deadline 625 | none | 0 | - | 0 | 21 | 2.0 s | 14 |
| bulkhead | 20261118T070502Z | 300/s | 54001 | 1170 (2.17%) | 163 | 94% ok | 133 ms | 65 ms | deadline 1170 | none | 0 | - | 0 | 4 | 0.7 s | 8 |
| bulkhead | 20261118T081632Z | 300/s | 54001 | 1212 (2.24%) | 162 | 94% ok | 122 ms | 52 ms | deadline 1212 | none | 0 | - | 0 | 29 | 0.8 s | 9 |
| bulkhead-timeout | 20261118T070816Z | 300/s | 54001 | 1161 (2.15%) | 162 | 95% ok | 130 ms | 59 ms | deadline 1161 | none | 0 | - | 0 | 2 | 0.7 s | 10 |
| bulkhead-timeout | 20261118T082000Z | 300/s | 54001 | 1222 (2.26%) | 168 | 94% ok | 183 ms | 84 ms | deadline 1222 | none | 0 | - | 0 | 5 | 0.8 s | 11 |

Regenerate a table with `go run ./cmd/report -scenario <name> -rounds <round,...>`.

## Run it

Needs Docker with Compose v2.

```sh
scripts/lab up                  # build and start
scripts/lab seed                # ~10 minutes for the default size; ORDERS=1000000 for a quick try
scripts/lab scenarios           # batch, conn, migration, retry, xmin, overflow, hotrow
scripts/lab rounds batch        # list a scenario's rounds
scripts/lab run batch naive     # one recorded run
scripts/lab down                # delete everything, data included
```

Each run writes `results/<scenario>/<round>/<UTC time>/`:

| File | What it holds |
|---|---|
| `summary.json` | per operation: requests, success ratio, p50/p95/p99/max latency, errors by code |
| `load.csv` | the same, per second, so you can see when trouble starts and ends |
| `sampler.csv` | per second: active and lock-waiting backends, longest transaction, PgBouncer clients waiting, API pool waits, new and abandoned sessions, dead tuples and size of `quotes`, oldest xmin age, int4 ids left |
| `<job>.json`, `<job>.log` | each job's result: `batch.json` (duration, chunks, lock-timeout retries), `migration.json` (lock wait, attempts, build time), `lock.json`, `idle_tx.json`, `churn.json` |
| `attempts.csv` | with a retry policy: original requests, retries and retries refused by the budget, per second |
| `events.jsonl`, `live.jsonl` | when each job started and ended, and the per-second frames live mode streams |
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
| `naive-failfast` | the naive job, but the API waits at most 250 ms for a connection and starts no query with less than 250 ms of its deadline left |
| `naive-cancelreq` | the naive job, but pgx asks the server to cancel a timed-out query instead of closing the connection (`CancelRequestContextWatcherHandler`) |
| `chunked` | 1,000 accounts per short transaction with `lock_timeout = 100ms` (the job yields to orders, retries the chunk), a pause between chunks, its own two-connection PgBouncer pool, and the rollup outside any account lock |

### `conn`: one slow query in a shared pool

Three requests in a hundred ask for a report over a year of orders for 200 accounts: about 300 ms alone. Under load it holds pool connections, and everything else queues behind it. (Alpaca's [27 Jun 2026 incident](https://stspg.io/h6zvs1kdv87n): order timeouts from database connection pressure.)

| Round | What changes |
|---|---|
| `baseline` | no report traffic |
| `shared` | report traffic on the same pool as everything else |
| `bulkhead` | reports get their own three-connection pool, in the API and in PgBouncer |
| `bulkhead-timeout` | plus `statement_timeout = 1s` for the report role |

### `migration`: schema changes on hot tables

Based on GoCardless's [lock-queue outage](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/) (a fast DDL queued behind a long read and stopped the API) and Railway's [28 Oct 2025 incident](https://blog.railway.com/p/incident-report-oct-28th-2025) (a non-concurrent index on a huge table). The API cancels timed-out queries with a cancel request in every round, so what is measured is the lock queue itself.

| Round | What changes |
|---|---|
| `alter-naive` | a read transaction holds `accounts` for 45 s; `ALTER TABLE accounts ADD COLUMN` waits behind it with no `lock_timeout`, and every later query on `accounts` waits behind the ALTER |
| `alter-locktimeout` | the same, but the ALTER sets `lock_timeout = 1s` and retries with jittered backoff |
| `index-plain` | `CREATE INDEX` on `orders(symbol)` (20M rows): writes to `orders` wait for the whole build |
| `index-concurrently` | `CREATE INDEX CONCURRENTLY` |

### `retry`: clients retrying into a short outage

A 15 s exclusive lock on `accounts`, while clients retry failed requests. Based on the [AWS us-east-1 outage of 7 Dec 2021](https://aws.amazon.com/message/12721/), where retries kept internal networks overloaded after the trigger, and the [metastable failures paper](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf). The API cancels with a cancel request here: with pgx's default handling the 15 s lock alone keeps the API down for the rest of the run, retries or not (seen in probe runs), which would hide the effect of the retry policy.

| Round | What changes |
|---|---|
| `no-retry` | clients do not retry |
| `retry-immediate` | up to 3 retries at once on any server error or timeout |
| `retry-backoff-budget` | up to 3 retries with jittered exponential backoff (100 ms doubling, 2 s cap), and a retry budget: retries may be at most 10% of original requests |

### `xmin`: a forgotten transaction holds back VACUUM

A feed updates a 2,000-row `quotes` table 2,000 times a second; 15% of API requests read a market summary that scans it. Based on Trigger.dev's [stuck xmin horizon](https://trigger.dev/blog/stopping-xmin-horizon-blocking-postgres-vacuuming) (dead tuples piled up, CPU at 95% for hours) and, at its extreme, Sentry's [transaction ID wraparound](https://blog.sentry.io/transaction-id-wraparound-in-postgres/).

| Round | What changes |
|---|---|
| `baseline` | the feed and the reads, nothing else |
| `idle-tx` | a session opens a `REPEATABLE READ` transaction, reads one row and sits idle for 140 s |
| `idle-tx-timeout` | the same, with `idle_in_transaction_session_timeout = 10s` on that session's role |

### `overflow`: a 32-bit column pointing at a 64-bit key

Every order also records a fill whose `order_id` column is `integer`, while `orders.id` is `bigint`; the sequence starts 4,500 ids below 2,147,483,647, about 60 s of orders. Based on Buildkite's [22 Jul 2023 incident](https://buildkitestatus.com/incidents/63zxhjsysszc), where exactly this stopped jobs being dispatched.

| Round | What changes |
|---|---|
| `int4` | `order_fills.order_id` is `integer` |
| `bigint` | `order_fills.order_id` is `bigint` |

### `hotrow`: every order on one account row

60% of requests are orders and all of them go to account 1, like an omnibus account: 180 orders a second on one row. Based on Heroku's [table-locking UPDATE](https://www.heroku.com/blog/curious-case-table-locking-update-query/), where parallel updates queued on one row's lock.

| Round | What changes |
|---|---|
| `baseline` | the same mix, orders spread over all accounts |
| `hot` | every order on account 1; the order transaction locks the row first (`SELECT ... FOR UPDATE`), then checks, reserves and records |
| `hot-locklast` | records the order first and reserves buying power last, in one conditional `UPDATE`, so the row lock is held only until `COMMIT` |

## Live mode

`scripts/lab live` serves the interactive replays at <http://localhost:58090> and streams whatever run is in progress into it, one frame a second over Server-Sent Events (`/live/events`), in the same format the site replays. Start a run in another terminal and watch it.

## MCP server

`cmd/mcp` lets Claude or any MCP client read the runs: `list_rounds`, `list_runs`, `get_timeline` (second by second, every layer), `first_signals` (which signal rose first, and how far ahead of the first failure), and `run_drill`, which runs a round on your local lab only when the server is started with `-allow-run`.

```sh
claude mcp add pg-pressure-lab -- go run ./cmd/mcp -repo "$PWD"
```

## How the measurements are made

- **Open-loop load.** Requests are sent on a fixed schedule whether or not earlier ones have returned, as real customers do. A closed-loop tool slows down with the server and hides the problem. If the generator cannot keep up it records the request as `dropped`, never skips it silently.
- **Failures are counted, not timed.** Latency percentiles cover successful requests only; a burst of fast errors cannot make latency look better. Errors are reported by cause: `deadline` (the API's 2 s budget ran out, usually waiting for a connection or a lock), `canceled` (pgx's cancel request ended the query), `pool_exhausted` (fail-fast refused to wait), `lock_timeout`, `statement_timeout`, `integer_out_of_range`, `client_timeout`.
- **One change per round,** all other settings recorded in `meta.json`, and the role settings reset before every run. Rounds of a scenario are interleaved (all rounds once, then all again), so slow drift on the host does not land on one round.
- **Probe runs are not results.** Short runs used to tune a scenario, and runs disturbed by other work on the host, are kept out of `results/` and out of every table.
- **Settings live on roles** (`ALTER ROLE report SET statement_timeout = ...`). Under PgBouncer transaction pooling, settings sent at connect time are dropped; this lab's PgBouncer config ignores them on purpose, which is also what happens by default in many real setups.
- **Memory is capped per container; CPU is not** (the reference host does not support CPU quotas for containers). Compare rounds run on the same host, not absolute numbers across machines.

## Layout

```
cmd/api       the API under test
cmd/load      open-loop load generator
cmd/batch     the end-of-day job (naive | chunked)
cmd/migrate   schema changes, lock triggers, an idle transaction, cleanup
cmd/churn     a quotes feed at a fixed update rate
cmd/sampler   per-second view of PostgreSQL, PgBouncer and the API pool
cmd/report    the comparison tables
cmd/live      live mode: the site plus a stream of the run in progress
cmd/mcp       MCP server over the recorded runs
cmd/sitedata  builds site/data from results/
internal/runs reading runs: tables, timelines, first signals
site/         the interactive replays (GitHub Pages)
deploy/       compose file, schema, seed, PgBouncer config
scripts/lab   the driver: rounds are defined at the top
results/      recorded runs
```

## License

Apache-2.0
