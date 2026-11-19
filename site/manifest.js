// The scenarios. Adding one is a data + text change: record runs under
// results/<id>/<round>/, regenerate site/data, and add an entry here. A
// scenario is listed only when `ready` is true AND site/data has runs for it.
//
// Every number in the text comes from `ctx` (computed from site/data at render
// time). A sentence whose numbers are missing is dropped, never guessed.
//
// ctx.range(round, field)  "53–66%"-style string over that round's runs, or null
// ctx.count(round)         number of recorded runs
// ctx.sig                  signal analysis of the primary round (see app.js)
// fmt.pct / fmt.n / fmt.s  formatters

export const SOURCES = {
  alpaca28aug: { org: "Alpaca", date: "28 Aug 2026", url: "https://stspg.io/tdl12cgrzvrm",
    title: "Brief API latency and timeouts",
    summary: "Two short windows of Broker API latency and timeouts overnight (US Eastern). The posted cause: a scheduled overnight batch ran with more data than usual and reduced capacity for dependent API calls; a few order submissions timed out without a confirmation." },
  alpaca27jun: { org: "Alpaca", date: "27 Jun 2026", url: "https://stspg.io/h6zvs1kdv87n",
    title: "Elevated order request timeouts",
    summary: "About two hours of order request timeouts, attributed to temporary database connectivity issues caused by increased connection pressure." },
  alpaca24jun: { org: "Alpaca", date: "24 Jun 2026", url: "https://stspg.io/st34r0cg995k",
    title: "Intermittent API failures",
    summary: "A few minutes of intermittent failures when inbound connections exceeded capacity and part of the infrastructure restarted; retried requests succeeded." },
  aws2021: { org: "AWS", date: "7 Dec 2021", url: "https://aws.amazon.com/message/12721/",
    title: "Summary of the us-east-1 service event",
    summary: "Clients that did not back off kept retrying connections; the retries overloaded internal network devices and kept them overloaded after the initial trigger. Impact lasted roughly seven hours." },
  bronson: { org: "HotOS '21", date: "2021", url: "https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf",
    title: "Metastable Failures in Distributed Systems (Bronson et al.)",
    summary: "Defines the failure class: a trigger pushes a system into a bad state that persists after the trigger is removed, held there by a sustaining effect such as retries or extra work per request." },
  gocardless: { org: "GoCardless", date: "Late January (year not given)", url: "https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/",
    title: "Zero-downtime Postgres migrations: the hard parts",
    summary: "A fast DDL statement needed an ACCESS EXCLUSIVE lock on a hot table, queued behind a long-running read, and every later query queued behind the DDL: about 15 seconds of API timeouts." },
  railway: { org: "Railway", date: "28 Oct 2025", url: "https://blog.railway.com/p/incident-report-oct-28th-2025",
    title: "Incident report",
    summary: "A migration added a column and a non-concurrent index on a table of about a billion rows, locking it. Connections piled up until every slot, including the admin reserve, was taken; the build could not be cancelled and the API was degraded for about 40 minutes." },
  trigger: { org: "Trigger.dev", date: "15 Aug 2024", url: "https://trigger.dev/blog/stopping-xmin-horizon-blocking-postgres-vacuuming",
    title: "Stopping the xmin horizon blocking vacuuming",
    summary: "A held-back xmin horizon left hundreds of thousands of dead tuples on a hot table; CPU stayed above 95% for hours and simple upserts took tens of seconds until a failover cleared it." },
  sentry2015: { org: "Sentry", date: "20 Jul 2015", url: "https://blog.sentry.io/transaction-id-wraparound-in-postgres/",
    title: "Transaction ID wraparound in Postgres",
    summary: "Vacuum fell behind freezing old rows; Postgres stopped accepting writes to protect against transaction ID wraparound, taking the service down for most of a working day." },
  mandrill: { org: "Mailchimp / Mandrill", date: "Feb 2019", url: "https://mailchimp.com/what-we-learned-from-the-recent-mandrill-outage/",
    title: "What we learned from the Mandrill outage",
    summary: "One shard took more writes than the others and hit the transaction ID limit; the database went into safety shutdown and recovery took about 40 hours." },
  buildkite: { org: "Buildkite", date: "22 Jul 2023", url: "https://buildkitestatus.com/incidents/63zxhjsysszc",
    title: "Agents not receiving jobs",
    summary: "A bigint primary key was referenced by an int4 column, which overflowed at 2,147,483,647; new work stopped for about an hour and a half until a workaround shipped." },
  heroku2019: { org: "Heroku", date: "19 Dec 2019", url: "https://www.heroku.com/blog/curious-case-table-locking-update-query/",
    title: "The curious case of the table-locking UPDATE",
    summary: "Parallel UPDATEs on the same row queued on its lock; job processing dropped to almost nothing." },
  gitlab2017: { org: "GitLab", date: "31 Jan 2017", url: "https://about.gitlab.com/blog/2017/02/10/postmortem-of-database-outage-of-january-31/",
    title: "Postmortem of database outage of January 31",
    summary: "Replication lag under load, a deletion on the wrong host, and backups that turned out not to work; restored from a six-hour-old copy." },
  clerk2026: { org: "Clerk", date: "19 Feb 2026", url: "https://clerk.com/blog/2026-02-19-system-outage-postmortem",
    title: "System outage postmortem",
    summary: "Auto-ANALYZE sampled a skewed column badly, a hot query's plan flipped and consumed the database; a manual ANALYZE fixed it." },
};

// Signals the sampler records; scenarios can add their own columns.
export const SIGNALS = {
  longest_xact_s: { label: "Oldest open transaction", unit: "s" },
  pg_lock_wait: { label: "Sessions waiting on a lock", unit: "" },
  bouncer_cl_waiting: { label: "PgBouncer clients waiting", unit: "" },
  pool_empty_acquires: { label: "App requests that found no free connection", unit: "/s" },
  pool_acquired: { label: "App pool connections in use", unit: "" },
  pg_sessions_started: { label: "New PostgreSQL sessions", unit: "/s" },
  pg_idle_in_tx: { label: "Sessions idle in transaction", unit: "" },
  pg_active: { label: "Active PostgreSQL sessions", unit: "" },
  quotes_dead_tup: { label: "Dead row versions in quotes", unit: "" },
  quotes_bytes: { label: "Size of quotes", unit: "B" },
  oldest_xmin_age: { label: "Age of the oldest snapshot (xmin)", unit: "" },
  int4_ids_left: { label: "int4 ids left", unit: "" },
};

export const SCENARIOS = [
  {
    id: "batch", ready: true, minutes: 25, primary: "naive", fixes: ["chunked", "naive-cancelreq", "naive-failfast"],
    title: "The batch job finished. The outage didn't.",
    short: "Overnight batch vs live traffic",
    summary: "One end-of-day transaction locks every account while orders keep arriving. The pool drains, reads fail with it, and the API stays down after the job commits.",
    sources: ["railway", "aws2021", "alpaca28aug"], reading: ["bronson"],
    practise: ["Read a lock-driven outage from pg_stat_activity and PgBouncer", "Explain what keeps a metastable failure going", "Compare three fixes by measured impact", "Pick alerts that fire before users notice"],
    rounds: {
      baseline: "No job. The reference: the same traffic with nothing else running.",
      naive: "The job as one transaction: snapshot positions, mark every account to market, roll up the day's orders. Every account row stays locked until it commits.",
      chunked: "Fix: 1,000 accounts per short transaction with lock_timeout = 100 ms (the job yields to orders and retries), its own two-connection pool, and the rollup outside any account lock.",
      "naive-cancelreq": "Fix: the same naive job. Only pgx changes: a cancelled request asks the server to cancel the query (CancelRequestContextWatcherHandler) instead of closing the connection.",
      "naive-failfast": "Fix: the same naive job. The API waits at most 250 ms for a connection and starts no query with less than 250 ms of its deadline left.",
    },
    incident(ctx) {
      return `<p>A long-running job and live traffic share one database. The job holds row locks for its whole transaction; requests that need those rows wait while holding connections, the pool runs dry, and endpoints that never touch the locked rows start failing too. Railway's October 2025 incident is the pattern at scale: a migration locked a table of about a billion rows and connections piled up until every slot was taken, degrading the API for about 40 minutes. It gets worse when the failure outlives its trigger: in AWS's December 2021 us-east-1 event, clients that kept retrying held network devices overloaded long after the original cause, a <strong>metastable failure</strong>. Alpaca's status page, linked below, describes a similar night: an overnight batch with more data than usual that reduced capacity for its API. This lab does not model anyone's internals; it reproduces the <em>class</em> of failure on its own stack and measures it.</p>
      <p>The stack: a Go API (pgx pool of 40) → PgBouncer in transaction mode (20 server connections) → PostgreSQL 17 with 200,000 accounts, 2 million positions and 20 million orders, under a steady ${ctx.fmt.n(ctx.rate)} requests a second that keep arriving whether or not the API keeps up.</p>`;
    },
    reproduce(ctx) {
      const p = ["<p>In the <strong>naive</strong> round the end-of-day job runs as a single transaction. It updates every account early, then holds those row locks through a slow rollup of the day's orders.</p>"];
      const f = ctx.range("naive", "failed_pct", ctx.fmt.pct), d = ctx.range("naive", "batch_seconds", ctx.fmt.s);
      if (f && d) p.push(`<div class="callout bad"><p>Across ${ctx.count("naive")} runs the job took <strong>${d}</strong> and <strong class="v-bad">${f}</strong> of <em>all</em> requests failed, reads included.</p></div>`);
      p.push("<p>Press play in the workspace. Watch the order requests queue on the locked rows while holding their pool connections; the pool fills, and requests that never touch an account (positions, order history) start timing out too.</p>");
      return p.join("");
    },
    diagnose(ctx) {
      const out = [];
      const after = ctx.range("naive", "failed_after_batch", ctx.fmt.n);
      const never = ctx.countWhere("naive", (h) => h.recovered_s === null);
      if (after) out.push(`<p><strong>The job committed and nothing recovered.</strong> ${after} requests failed <em>after</em> it had finished; in ${never} of ${ctx.count("naive")} runs the API never got back to ten healthy seconds before the run ended.</p>`);
      out.push(`<p>The loop that keeps it down: a request waits almost its whole 2 s budget for a connection, gets one with milliseconds left, starts a query and is cancelled. pgx's default (<code>DeadlineContextWatcherHandler</code>) closes a connection whose query is cancelled, so PgBouncer has to drop its server connection too:</p>
      <div class="quote-log">pgbouncer: closing because: client disconnect while server was not ready (age=0s)</div>`);
      const sess = ctx.range("naive", "max_sessions_per_s", ctx.fmt.n);
      if (sess) out.push(`<p>PostgreSQL started up to <strong>${sess} new sessions a second</strong> while it was stuck. The trigger is gone; the failure sustains itself. That is a <a href="${SOURCES.bronson.url}" target="_blank" rel="noopener">metastable failure</a>.</p>`);
      const half = ctx.range("naive", "failed_pct", ctx.fmt.pct, 150);
      if (half) out.push(`<div class="callout accent"><p><strong>More headroom does not save it.</strong> At half the load (150 req/s) ${half} failed and it did not recover either.</p></div>`);
      return out.join("");
    },
    fix(ctx) {
      const ch = ctx.range("chunked", "failed_pct", ctx.fmt.pct), chd = ctx.range("chunked", "batch_seconds", ctx.fmt.s);
      const cr = ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct), crr = ctx.range("naive-cancelreq", "recovered_s", ctx.fmt.s);
      const ff = ctx.range("naive-failfast", "failed_pct", ctx.fmt.pct), ffr = ctx.range("naive-failfast", "recovered_s", ctx.fmt.s);
      const items = [];
      if (ch) items.push(`<li><strong>Fix the job.</strong> Short transactions that yield to orders: <span class="v-ok">${ch}</span> failed${chd ? `; the job takes ${chd} instead of ${ctx.range("naive", "batch_seconds", ctx.fmt.s)}` : ""}. The only round that reaches zero.</li>`);
      if (cr) items.push(`<li><strong>Change one pgx setting.</strong> Ask the server to cancel instead of closing the connection: ${cr} failed, healthy again ${crr ? `within ${crr}` : "quickly"} of the job ending.</li>`);
      if (ff) items.push(`<li><strong>Fail fast in the API.</strong> Refuse work that cannot finish: ${ff} failed, all inside the lock window, healthy ${ffr ? `within ${ffr}` : "quickly"} of the job ending.</li>`);
      return `<p>Three fixes, each one change from the naive round. Click a row to replay it.</p><ul>${items.join("")}</ul>`;
    },
    alert(ctx) {
      return `<p>A caller only sees trouble once a request fails. The question is which signal moved before that, on every run, by enough to page someone.</p>${ctx.signalsSentence()}`;
    },
  },

  {
    id: "migration", ready: true, minutes: 20, primary: "alter-naive", fixes: ["alter-locktimeout", "index-concurrently"],
    title: "A one-second ALTER that took the API down",
    short: "Schema change on a hot table",
    summary: "A schema change needs a brief exclusive lock. Queued behind one long read, it blocks every query behind it. Then: building an index on a 20-million-row table without CONCURRENTLY.",
    sources: ["gocardless", "railway"], reading: [],
    practise: ["Read a lock queue: who waits on whom", "Use lock_timeout and retries for DDL", "Build indexes on big tables without blocking writes", "Explain why a 'fast' migration can still cause an outage"],
    rounds: {
      "alter-naive": "A long read transaction is open on accounts; ALTER TABLE accounts ADD COLUMN waits for it, and every later query on accounts queues behind the ALTER.",
      "alter-locktimeout": "Fix: the same ALTER with lock_timeout = 1 s, retried with backoff, so it never holds the head of the queue for long.",
      "index-plain": "CREATE INDEX on orders, 20 million rows, without CONCURRENTLY: writes to orders wait for the whole build.",
      "index-concurrently": "Fix: CREATE INDEX CONCURRENTLY. Slower to build, but writes keep flowing.",
    },
    incident(ctx) {
      return `<p>GoCardless describe a migration whose DDL took milliseconds but needed an <strong>ACCESS EXCLUSIVE</strong> lock on a busy table. It queued behind a long-running read, and every query that arrived after it queued behind the DDL: about fifteen seconds of API timeouts. Railway's October 2025 incident is the bigger cousin: a non-concurrent index on a table of about a billion rows, with connections piling up until even the admin reserve was gone.</p>
      <p>The stack is the same as the batch mission: a Go API (pgx pool of 40) → PgBouncer (20 server connections) → PostgreSQL 17, under ${ctx.fmt.n(ctx.rate)} requests a second.</p>
      ${CANCEL_NOTE}`;
    },
    reproduce(ctx) {
      const f = ctx.range("alter-naive", "failed_pct", ctx.fmt.pct), d = ctx.range("alter-naive", "batch_seconds", ctx.fmt.s);
      return `<p>In <strong>alter-naive</strong> a read transaction on accounts stays open, then the migration runs <code>ALTER TABLE accounts ADD COLUMN</code>.</p>${f ? `<div class="callout bad"><p>Across ${ctx.count("alter-naive")} runs the migration window lasted ${d} and <strong class="v-bad">${f}</strong> of all requests failed, reads included.</p></div>` : ""}`;
    },
    diagnose(ctx) {
      const ip = ctx.range("index-plain", "failed_pct", ctx.fmt.pct), ipd = ctx.range("index-plain", "batch_seconds", ctx.fmt.s);
      const late = ctx.countWhere("index-plain", (h) => h.failed_after_batch > 0), lateN = ctx.range("index-plain", (h) => (h.failed_after_batch > 0 ? h.failed_after_batch : null), ctx.fmt.n);
      return `<p><strong>The ALTER itself is fast; its place in the queue is not.</strong> A waiting ACCESS EXCLUSIVE request blocks every later request on the table, even plain reads that would not conflict with the long transaction. <code>pg_blocking_pids(pid)</code> shows the chain: readers blocked by the ALTER, the ALTER blocked by the long read.</p>
      ${ip ? `<p><strong>A plain index build is the same problem, held for longer.</strong> <code>CREATE INDEX</code> blocks writes for the whole build: ${ipd} of building here, and ${ip} of all requests failed.${late ? ` In ${late} of ${ctx.count("index-plain")} runs failures carried on after the build finished (${lateN} requests).` : ""}</p>` : ""}`;
    },
    fix(ctx) {
      const lt = ctx.range("alter-locktimeout", "failed_pct", ctx.fmt.pct), ltp = ctx.range("alter-locktimeout", "order_p99_ms", ctx.fmt.ms);
      const ic = ctx.range("index-concurrently", "failed_pct", ctx.fmt.pct), icp = ctx.range("index-concurrently", "order_p99_ms", ctx.fmt.ms), icd = ctx.range("index-concurrently", "batch_seconds", ctx.fmt.s);
      return `<ul>${[
        lt && `<li><strong>lock_timeout + retries for DDL:</strong> <span class="v-ok">${lt}</span> failed. The cost was an order p99 of ${ltp} while the ALTER kept trying.</li>`,
        ic && `<li><strong>CREATE INDEX CONCURRENTLY:</strong> <span class="v-ok">${ic}</span> failed and order p99 ${icp}, for a build of ${icd}.</li>`,
      ].filter(Boolean).join("")}</ul>`;
    },
    alert(ctx) { return `<p>Before a migration, check for transactions older than its lock budget. During one, alert on sessions waiting on a lock.</p>${ctx.signalsSentence()}`; },
  },

  {
    id: "retry", ready: true, minutes: 20, primary: "retry-immediate", fixes: ["retry-backoff-budget", "no-retry"],
    title: "Retries that kept the outage alive",
    short: "Client retry storm",
    summary: "A 15-second lock makes requests fail. Clients that retry at once multiply the load, and the API can stay down after the lock is gone.",
    sources: ["aws2021", "alpaca24jun"], reading: ["bronson"],
    practise: ["Recognise work amplification from retries", "Design retry budgets and backoff", "Explain metastability to a non-specialist"],
    tiles: ["ok", "p99", "retries", "refused", "pool", "queue", "locks", "failed"],
    rounds: {
      "no-retry": "Clients do not retry. The reference for the same 15 s lock on accounts.",
      "retry-immediate": "Clients retry a failed request immediately, up to three times.",
      "retry-backoff-budget": "Fix: up to three retries with exponential backoff, and a retry budget of 10% of traffic.",
    },
    incident(ctx) {
      // the lock transaction's own age, not the job's start-to-end events
      const d = ctx.range("no-retry", "max_longest_xact_s", ctx.fmt.s);
      return `<p>AWS's December 2021 us-east-1 event is the textbook case: clients that did not back off kept retrying, and the retries kept internal network devices overloaded long after the original trigger. Bronson et al. call this a <em>sustaining effect</em>: work the system does because it is failing keeps it failing. Alpaca's 24 June 2026 status note, linked below, describes inbound connections exceeding capacity.</p>
      <p>Every round here has the same trigger: an exclusive lock on accounts${d ? ` held for ${d}` : ""}. The only difference is what clients do when a request fails.</p>
      ${CANCEL_NOTE}`;
    },
    reproduce(ctx) {
      const f = ctx.range("retry-immediate", "failed_pct", ctx.fmt.pct), n = ctx.range("no-retry", "failed_pct", ctx.fmt.pct);
      const never = ctx.countWhere("retry-immediate", (h) => h.batch_seconds != null && h.failed > 0 && h.recovered_s === null);
      return `<p>Without retries, <strong>${n}</strong> of requests failed. With immediate retries, <strong class="v-bad">${f}</strong> failed across ${ctx.count("retry-immediate")} runs${never ? `, and in ${never} of them the API never got back to ten healthy seconds before the run ended` : ""}.</p>`;
    },
    diagnose(ctx) {
      const sent = ctx.range("retry-immediate", "retries_sent", ctx.fmt.n), after = ctx.range("retry-immediate", "failed_after_batch", ctx.fmt.n);
      return `<p><strong>Retries are extra work sent to a system that is already failing.</strong> Immediate retries added ${sent} requests on top of the original traffic. Each lands while the backlog is still draining, waits out its deadline and fails, and so triggers another retry.</p>${after ? `<p>${after} requests failed <em>after</em> the lock was gone. Same trigger, same API: the only difference is the clients.</p>` : ""}`;
    },
    fix(ctx) {
      const b = ctx.range("retry-backoff-budget", "failed_pct", ctx.fmt.pct), bs = ctx.range("retry-backoff-budget", "retries_sent", ctx.fmt.n), bd = ctx.range("retry-backoff-budget", "retries_denied", ctx.fmt.n), br = ctx.range("retry-backoff-budget", "recovered_s", ctx.fmt.s);
      const n = ctx.range("no-retry", "failed_pct", ctx.fmt.pct);
      return `<ul>${[
        b && `<li><strong>Backoff with a retry budget</strong> behaves like no retries at all, which is the point: the budget allowed ${bs} retries and refused ${bd}; ${b} failed, healthy within ${br} of the lock ending.</li>`,
        n && `<li><strong>No retries:</strong> ${n} failed, all of them during the lock.</li>`,
      ].filter(Boolean).join("")}</ul>`;
    },
    alert(ctx) { return `<p>Track retries as a share of original requests, at the client and at the edge. A budget makes that share a hard limit instead of a graph.</p>${ctx.signalsSentence()}`; },
  },

  {
    id: "conn", ready: true, minutes: 15, primary: "shared", fixes: ["bulkhead", "bulkhead-timeout"],
    title: "One slow report, every endpoint slow",
    short: "Slow query in a shared pool",
    summary: "A few slow report queries share the connection pool with everything else. Every endpoint queues behind them.",
    sources: ["railway", "alpaca27jun"], reading: [],
    practise: ["Design bulkheads for connection pools", "Use per-role statement_timeout", "Read pool saturation from the app and from PgBouncer"],
    rounds: {
      baseline: "No report traffic.",
      shared: "3 requests in 100 are a slow report that shares the API's connection pool.",
      bulkhead: "Fix: reports get their own pool of three connections.",
      "bulkhead-timeout": "Fix: the bulkhead plus statement_timeout = 1 s for reports.",
    },
    incident(ctx) {
      return `<p>Railway's October 2025 incident shows the extreme: long-running work took connection slots until nothing else could get one. Alpaca's 27 June 2026 status note (linked below) attributes order timeouts to database connection pressure.</p>
      <p>Here a slow report shares the API's pool of 40 connections with orders and reads, under ${ctx.fmt.n(ctx.rate)} requests a second.</p>`;
    },
    reproduce(ctx) {
      const bo = ctx.range("baseline", "order_p99_ms", ctx.fmt.ms), so = ctx.range("shared", "order_p99_ms", ctx.fmt.ms), sr = ctx.range("shared", "read_p99_ms", ctx.fmt.ms);
      return `<p>Replay <strong>baseline</strong>, then <strong>shared</strong>, and compare the p99 tile.</p>${so ? `<div class="callout bad"><p>Order p99 went from ${bo} to <strong class="v-bad">${so}</strong> with reports sharing the pool; read p99 ${sr}.</p></div>` : ""}`;
    },
    diagnose() {
      return `<p>A pool is a queue. A slow query holds its connection for its whole runtime, so a small share of slow requests takes a large share of the connections, and every fast request waits behind them. The pool tile and the PgBouncer queue show it; the database itself is not busy.</p>`;
    },
    fix(ctx) {
      const bo = ctx.range("bulkhead", "order_p99_ms", ctx.fmt.ms), br = ctx.range("bulkhead", "read_p99_ms", ctx.fmt.ms), bf = ctx.range("bulkhead", "failed_pct", ctx.fmt.pct), sf = ctx.range("shared", "failed_pct", ctx.fmt.pct);
      const to = ctx.range("bulkhead-timeout", "order_p99_ms", ctx.fmt.ms), tf = ctx.range("bulkhead-timeout", "failed_pct", ctx.fmt.pct);
      return `<ul>${[
        bo && `<li><strong>A bulkhead</strong> gives the other endpoints their latency back: order p99 ${bo}, reads ${br}. The price is paid by the reports, which now queue among themselves: ${bf} of requests failed, against ${sf} when shared. The per-endpoint summary at the end of <code>lab run conn bulkhead</code> shows which ones.</li>`,
        to && `<li><strong>statement_timeout on top</strong> changed little here (order p99 ${to}, ${tf} failed): it guards against the report that suddenly takes a minute, it does not fix queueing.</li>`,
      ].filter(Boolean).join("")}</ul>`;
    },
    alert(ctx) { return `<p>Alert on pool wait time per endpoint, not just pool usage: a full pool with fast queries is fine, a full pool with one slow class of query is not.</p>${ctx.signalsSentence()}`; },
  },

  {
    id: "xmin", ready: true, minutes: 20, primary: "idle-tx", fixes: ["idle-tx-timeout"],
    title: "The idle transaction that bloated a table",
    short: "xmin horizon and bloat",
    summary: "One session left idle in a transaction holds back VACUUM. Dead rows pile up on a hot table. Nothing fails; it is slow damage.",
    sources: ["trigger", "sentry2015", "mandrill"], reading: [],
    practise: ["Find what is holding back the xmin horizon", "Explain MVCC, VACUUM and dead tuples", "Set idle_in_transaction_session_timeout with confidence"],
    tiles: ["ok", "p99", "xact", "dead", "tblmb", "xminage", "locks", "sess"],
    rounds: {
      baseline: "A churn job keeps updating a 2,000-row quotes table while the API reads it. No idle transaction.",
      "idle-tx": "The same, plus a session that opens a transaction and sits idle, holding its snapshot.",
      "idle-tx-timeout": "Fix: idle_in_transaction_session_timeout = 10 s. PostgreSQL ends the idle session; the job that opened it keeps its own timer, so the shaded window is longer than the transaction (watch Oldest transaction).",
    },
    incident() {
      return `<p>Trigger.dev saw a held-back xmin horizon leave hundreds of thousands of dead tuples on a hot table, with CPU pinned for hours, until a failover cleared it. Taken to its limit, the same mechanism is how Sentry (2015) and Mandrill (2019) reached transaction ID wraparound protection and stopped taking writes.</p>
      <p>Nothing fails in this mission. Watch the tables tiles: dead row versions, the size of quotes, and the age of the oldest snapshot.</p>`;
    },
    reproduce(ctx) {
      const dt = ctx.range("idle-tx", "max_dead_tup", ctx.fmt.n), mb = ctx.range("idle-tx", "max_table_bytes", fmtMB), bdt = ctx.range("baseline", "max_dead_tup", ctx.fmt.n), bmb = ctx.range("baseline", "max_table_bytes", fmtMB);
      return `<p>A churn job updates quotes continuously while one session sits idle in a transaction.</p>${dt ? `<div class="callout bad"><p>With the idle session, quotes reached <strong class="v-bad">${dt}</strong> dead row versions and ${mb}, against ${bdt} and ${bmb} without it.</p></div>` : ""}`;
    },
    diagnose(ctx) {
      const age = ctx.range("idle-tx", "max_xmin_age", ctx.fmt.n);
      return `<p>VACUUM can only remove a row version that no open snapshot can still see. An idle transaction keeps its snapshot, so every update to quotes leaves a dead version that has to stay. <code>age(backend_xmin)</code> in <code>pg_stat_activity</code> shows who is holding the horizon${age ? `; here it reached ${age} transactions` : ""}. Reads of quotes get slower as they step over the dead versions.</p>`;
    },
    fix(ctx) {
      const x = ctx.range("idle-tx-timeout", "max_longest_xact_s", ctx.fmt.s), dt = ctx.range("idle-tx-timeout", "max_dead_tup", ctx.fmt.n), mb = ctx.range("idle-tx-timeout", "max_table_bytes", fmtMB);
      return x ? `<p><strong>idle_in_transaction_session_timeout</strong> caps the damage: the idle session was ended after ${x}, dead rows peaked at ${dt} and were reclaimed, and quotes stayed at ${mb}.</p>` : "";
    },
    alert(ctx) {
      const age = ctx.range("idle-tx", "max_xmin_age", ctx.fmt.n);
      return `<p>Alert on the age of the oldest <code>backend_xmin</code>${age ? ` (it reached ${age} here in under three minutes)` : ""} and on <code>n_dead_tup</code> for the tables you care about. Both are cheap to sample.</p>`;
    },
  },

  {
    id: "overflow", ready: true, minutes: 15, primary: "int4", fixes: ["bigint"],
    title: "When an id ran out of integers",
    short: "int4 key overflow",
    summary: "A bigint primary key referenced by an int4 column works for years, then every insert fails at 2,147,483,647.",
    sources: ["buildkite"], reading: [],
    practise: ["Audit for int4 columns that store bigint keys", "Turn ids-left into a date", "Plan the bigint migration before the cliff"],
    tiles: ["ok", "p99", "int4", "failed", "pool", "queue", "locks", "sess"],
    rounds: {
      int4: "Order ids start a few thousand below 2,147,483,647, and a column that stores the order id is int4.",
      bigint: "Fix: the same, with that column as bigint.",
    },
    incident() {
      return `<p>Buildkite's July 2023 incident: the primary key was already bigint, but a column that referenced it was int4. It overflowed at 2,147,483,647 and new jobs stopped for about an hour and a half until a workaround shipped.</p>
      <p>Watch the <strong>int4 ids left</strong> tile: it counts down with every order.</p>`;
    },
    reproduce(ctx) {
      const ff = ctx.range("int4", "first_failure_s", (v) => `second ${v}`), f = ctx.range("int4", "failed_pct", ctx.fmt.pct);
      return `<p>Orders are written at a steady rate until the id passes the int4 limit.</p>${ff ? `<div class="callout bad"><p>The first failure came at ${ff}, and every order after it failed: <strong class="v-bad">${f}</strong> of all requests.</p></div>` : ""}`;
    },
    diagnose() {
      return `<p>The error is <code>integer out of range</code> on insert. The sequence is fine; the problem is the type of every column that <em>stores</em> the id. Nothing degrades beforehand: the API is healthy until the second it is not.</p>`;
    },
    fix(ctx) {
      const b = ctx.range("bigint", "failed_pct", ctx.fmt.pct);
      return `<p>${b ? `With the column as <strong>bigint</strong>: <span class="v-ok">${b}</span> failed. ` : ""}Convert referencing columns ahead of time (new column, backfill, swap). In an emergency, a sequence can be moved to negative values to buy time.</p>`;
    },
    alert() {
      return `<p>The warning is a subtraction: <code>2147483647 - last_value</code> divided by the insert rate is the date this happens. In production that number is months, which is why it gets forgotten. Alert on it for every int4 column that stores an id.</p>`;
    },
  },

  {
    id: "hotrow", ready: true, minutes: 15, primary: "hot", fixes: ["hot-locklast"],
    title: "Every order on one account row",
    short: "Hot-row tipping point",
    summary: "When most writes lock the same row, they queue on it. Sometimes the API absorbs it; sometimes it tips over. This mission was recorded twice and it went both ways.",
    sources: ["heroku2019"], reading: [],
    practise: ["Spot a single-row lock queue", "Recognise a system near its tipping point", "Take a hot lock last, not first"],
    rounds: {
      baseline: "Orders spread across accounts.",
      hot: "Every order (60% of the traffic) updates the same account row, locking it first.",
      "hot-locklast": "Fix: record the order first and reserve buying power with one conditional UPDATE just before COMMIT, so the row is locked for the shortest time.",
    },
    incident() {
      return `<p>Heroku describe parallel UPDATEs on the same row queuing on its lock, with job processing dropping to almost nothing.</p>
      <p><strong>A note on this mission:</strong> it only half reproduced. The <em>hot</em> round was recorded twice and the two runs disagree. Treat it as a picture of a tipping point, not a stable result.</p>`;
    },
    reproduce(ctx) {
      const hs = ctx.list("hot");
      const ok = hs.filter((h) => h.failed_pct === 0), bad = hs.filter((h) => h.failed_pct > 0);
      const okTxt = ok.map((h) => `order p99 ${ctx.fmt.ms(h.order_p99_ms)} with ${h.max_lock_wait} sessions waiting on the row`).join("; ");
      const badTxt = bad.map((h) => `${ctx.fmt.pct(h.failed_pct)} of all requests failed`).join("; ");
      return `<p>Of ${hs.length} recorded runs of <strong>hot</strong>, ${ok.length} absorbed the load (${okTxt || "none"}) and ${bad.length} tipped over (${badTxt || "none"}).</p><p class="faint"><code>lab run hotrow hot</code> replays the newest run. To see the other, list them with <code>lab runs hotrow</code> and replay one with <code>lab run hotrow hot --stamp &lt;stamp&gt;</code>.</p>`;
    },
    diagnose() {
      return `<p>One row, one lock holder at a time: every other order waits on it while holding a pool connection. When the queue stays short, latency rises and nothing fails. When it doesn't, requests reach their deadline, connections are torn down, and the API falls into the same reconnect loop as the batch mission. The difference between the two runs is small timing, which is what a tipping point looks like.</p>`;
    },
    fix(ctx) {
      const f = ctx.range("hot-locklast", "failed_pct", ctx.fmt.pct), p = ctx.range("hot-locklast", "order_p99_ms", ctx.fmt.ms);
      return f ? `<p><strong>Take the hot lock last.</strong> Across ${ctx.count("hot-locklast")} runs: <span class="v-ok">${f}</span> failed, order p99 ${p}. Less time holding the lock means a shorter queue behind it.</p>` : "";
    },
    alert() { return `<p>Lock waiters concentrated on one relation and one row. The useful signal is the queue length, before latency turns into failures.</p>`; },
  },
];

export const STEPS = [
  { id: "incident", label: "The incident" },
  { id: "reproduce", label: "Reproduce" },
  { id: "diagnose", label: "Diagnose" },
  { id: "fix", label: "Fix" },
  { id: "alert", label: "What to alert on" },
];

// Mission objectives. A mission without an entry here gets a standard set
// (baseline, incident, first-signal quiz, fix, best-fix quiz, report) built
// from its rounds. Types:
//   command  completes when the terminal runs a matching command
//   observe  completes when the replay reaches a moment: { round, when:
//            "jobEnd" | "jobStart" | "failure" | "metric", offset (s),
//            needFailures, metric + gte }
//   quiz     multiple choice. Fixed: q, options, answer, explain(ctx).
//            From the data: build({ ctx, load }) returns the same shape,
//            where load(round) resolves that round's replayed run; or
//            `quiz: "firstSignal" | "bestFix"`
export const OBJECTIVES = {
  batch: [
    { id: "baseline", type: "command", xp: 50, text: "Run the baseline: the same traffic with no batch job", match: { run: ["baseline"] } },
    { id: "outage", type: "command", xp: 50, text: "Trigger the outage: replay the naive batch", match: { run: ["naive"] } },
    { id: "watch", type: "observe", xp: 50, text: "Watch the batch commit, and the errors carry on", observe: { round: "naive", afterJobEnd: 10, needFailures: true } },
    {
      id: "why", type: "quiz", xp: 100, badge: "root-cause",
      q: "The batch committed and released its locks. Why did requests keep failing?",
      options: [
        "PostgreSQL held the batch's row locks until autovacuum ran",
        "Requests waited out their deadline for a pool connection, were cancelled mid-query, and each cancellation closed a connection that PgBouncer and PostgreSQL had to rebuild",
        "The load generator sent more requests once errors started",
        "PgBouncer was restarted by its health check",
      ],
      answer: 1,
      explain(ctx) {
        const s = ctx.range("naive", "max_sessions_per_s", ctx.fmt.n);
        return `Locks are released at commit, and the load is open loop at a fixed rate. What sustains the outage is the loop: a request waits almost its whole 2 s budget for a connection, starts a query with milliseconds left and is cancelled; pgx's default closes that connection, so PgBouncer drops its server connection too${s ? `, and PostgreSQL started up to ${s} new sessions a second` : ""}. The trigger is gone; the failure keeps itself going.`;
      },
    },
    { id: "signal", type: "quiz", quiz: "firstSignal", xp: 100, badge: "early-warning" },
    { id: "fix", type: "command", xp: 100, text: "Ship a fix: replay chunked, naive-cancelreq or naive-failfast", match: { run: ["chunked", "naive-cancelreq", "naive-failfast"] } },
    { id: "best", type: "quiz", quiz: "bestFix", xp: 100 },
    { id: "report", type: "command", xp: 50, text: "Compare every round: lab report batch", match: { report: true } },
  ],
  migration: [
    { id: "outage", type: "command", xp: 50, text: "Run the migration: replay alter-naive", match: { run: ["alter-naive"] } },
    { id: "watch", type: "observe", xp: 50, text: "Watch reads fail while the ALTER waits in the queue", observe: { round: "alter-naive", when: "failure", offset: 3 }, hint: "Replay alter-naive and watch the Success tile once the migration starts." },
    {
      id: "why", type: "quiz", xp: 100, badge: "root-cause",
      q: "ADD COLUMN takes milliseconds, and the long read only reads. Why did reads on accounts fail?",
      options: [
        "ADD COLUMN rewrote the whole table",
        "The waiting ALTER queued for an ACCESS EXCLUSIVE lock, and every later query on the table queued behind it",
        "PgBouncer refused new clients during DDL",
        "The long read held an exclusive lock",
      ],
      answer: 1,
      explain: (ctx) => `Lock requests queue in order. The ALTER waits for the long read; reads that arrive after the ALTER wait for the ALTER, even though they would not conflict with the read. ${ctx.range("alter-naive", "failed_pct", ctx.fmt.pct) ?? ""} of requests failed in that queue.`,
    },
    { id: "fix", type: "command", xp: 100, text: "Ship the fix: replay alter-locktimeout", match: { run: ["alter-locktimeout"] } },
    { id: "index", type: "command", xp: 50, text: "Now the index: replay index-plain", match: { run: ["index-plain"] } },
    {
      id: "best", type: "quiz", xp: 100,
      async build({ ctx }) {
        const worst = (r) => Math.max(...ctx.list(r).map((h) => h.failed_pct));
        const p = worst("index-plain"), c = worst("index-concurrently");
        const opts = ["CREATE INDEX (plain)", "CREATE INDEX CONCURRENTLY", "Both", "Neither"];
        const answer = p === 0 && c === 0 ? 2 : c === 0 ? 1 : p === 0 ? 0 : 3;
        return {
          q: "Which index build kept every request succeeding, in every recorded run?", options: opts, answer,
          explain: `Plain build: ${ctx.range("index-plain", "failed_pct", ctx.fmt.pct)} failed. CONCURRENTLY: ${ctx.range("index-concurrently", "failed_pct", ctx.fmt.pct)} failed, with a build of ${ctx.range("index-concurrently", "batch_seconds", ctx.fmt.s)}.`,
        };
      },
    },
    { id: "fix2", type: "command", xp: 100, text: "Ship the fix: replay index-concurrently", match: { run: ["index-concurrently"] } },
    { id: "report", type: "command", xp: 50, text: "Compare every round: lab report migration", match: { report: true } },
  ],

  retry: [
    { id: "baseline", type: "command", xp: 50, text: "Run the reference: the same 15 s lock, no retries", match: { run: ["no-retry"] } },
    { id: "outage", type: "command", xp: 50, text: "Turn on immediate retries: replay retry-immediate", match: { run: ["retry-immediate"] } },
    { id: "watch", type: "observe", xp: 50, text: "Watch the lock end and the failures carry on", observe: { round: "retry-immediate", when: "jobEnd", offset: 8, needFailures: true }, hint: "Replay retry-immediate past the end of the lock. Watch Retries/s and Success." },
    {
      id: "never", type: "quiz", xp: 100, badge: "root-cause",
      async build({ ctx }) {
        const rounds = ["no-retry", "retry-immediate", "retry-backoff-budget"].filter((r) => ctx.has(r));
        const never = rounds.filter((r) => ctx.list(r).some((h) => h.batch_seconds != null && h.failed > 0 && h.recovered_s === null));
        const after = (r) => Math.max(...ctx.list(r).map((h) => h.failed_after_batch ?? 0));
        const correct = never.length === 1 ? never[0] : rounds.slice().sort((a, b) => after(b) - after(a))[0];
        return {
          q: never.length === 1 ? "Which client policy, in at least one run, never got the API back to healthy before the run ended?" : "Which client policy left the most failures after the lock ended?",
          options: rounds, answer: rounds.indexOf(correct),
          explain: rounds.map((r) => `${r}: ${ctx.range(r, "failed_after_batch", ctx.fmt.n) ?? "–"} failed after the lock`).join(" · ") + `. Immediate retries sent ${ctx.range("retry-immediate", "retries_sent", ctx.fmt.n)} extra requests into a system that was already behind.`,
        };
      },
    },
    { id: "fix", type: "command", xp: 100, text: "Ship the fix: replay retry-backoff-budget", match: { run: ["retry-backoff-budget"] } },
    { id: "report", type: "command", xp: 50, text: "Compare every round: lab report retry", match: { report: true } },
  ],

  conn: [
    { id: "baseline", type: "command", xp: 50, text: "Run the baseline: no reports", match: { run: ["baseline"] } },
    { id: "outage", type: "command", xp: 50, text: "Add slow reports to the shared pool: replay shared", match: { run: ["shared"] } },
    {
      id: "ratio", type: "quiz", xp: 100,
      async build({ ctx }) {
        const avg = (r) => { const v = ctx.list(r).map((h) => h.order_p99_ms); return v.reduce((a, b) => a + b, 0) / v.length; };
        const x = avg("shared") / avg("baseline");
        return bucket("With reports sharing the pool, how much higher was order p99 than in the baseline?", x,
          [{ lt: 1.5, label: "About the same" }, { lt: 5, label: "2 to 5 times" }, { lt: 40, label: "About 10 times" }, { lt: Infinity, label: "100 times or more" }],
          `Order p99: ${ctx.range("baseline", "order_p99_ms", ctx.fmt.ms)} in the baseline, ${ctx.range("shared", "order_p99_ms", ctx.fmt.ms)} with reports sharing the pool (${x.toFixed(1)}× on average). Orders never touch the report's tables; they wait for a connection.`);
      },
    },
    { id: "fix", type: "command", xp: 100, text: "Ship the fix: replay bulkhead", match: { run: ["bulkhead"] } },
    {
      id: "why", type: "quiz", xp: 100, badge: "root-cause",
      q: "The bulkhead round failed more requests than shared. Why is it still the fix?",
      options: [
        "It isn't: shared is better",
        "The failures moved to the reports, which now queue on their own connections, and every other endpoint got its latency back",
        "Fewer requests were sent in the bulkhead round",
        "statement_timeout cancelled the slow reports",
      ],
      answer: 1,
      explain: (ctx) => `Bulkhead: ${ctx.range("bulkhead", "failed_pct", ctx.fmt.pct)} failed against ${ctx.range("shared", "failed_pct", ctx.fmt.pct)} shared, but order p99 fell to ${ctx.range("bulkhead", "order_p99_ms", ctx.fmt.ms)}. The per-endpoint summary at the end of the replay shows the failures are the reports' own.`,
    },
    { id: "fix2", type: "command", xp: 50, text: "Add statement_timeout: replay bulkhead-timeout", match: { run: ["bulkhead-timeout"] } },
    { id: "report", type: "command", xp: 50, text: "Compare every round: lab report conn", match: { report: true } },
  ],

  xmin: [
    { id: "baseline", type: "command", xp: 50, text: "Run the baseline: the churn job, no idle transaction", match: { run: ["baseline"] } },
    { id: "outage", type: "command", xp: 50, text: "Leave a transaction idle: replay idle-tx", match: { run: ["idle-tx"] } },
    { id: "watch", type: "observe", xp: 50, text: "Watch dead row versions pass 100,000", observe: { round: "idle-tx", when: "metric", metric: "quotes_dead_tup", gte: 100000 }, hint: "Replay idle-tx and watch the Dead tuples tile climb while the session stays idle." },
    {
      id: "ratio", type: "quiz", xp: 100,
      async build({ ctx }) {
        const avg = (r) => { const v = ctx.list(r).map((h) => h.max_table_bytes || 0); return v.reduce((a, b) => a + b, 0) / v.length; };
        const x = avg("idle-tx") / avg("baseline");
        return bucket("How much bigger did the quotes table get with the idle transaction, compared with the baseline?", x,
          [{ lt: 3, label: "Under 3 times" }, { lt: 20, label: "3 to 20 times" }, { lt: 150, label: "20 to 150 times" }, { lt: Infinity, label: "Over 150 times" }],
          `quotes peaked at ${ctx.range("baseline", "max_table_bytes", fmtMB)} in the baseline and ${ctx.range("idle-tx", "max_table_bytes", fmtMB)} with the idle session (${x.toFixed(0)}× on average), in under three minutes, on a 2,000-row table.`);
      },
    },
    { id: "fix", type: "command", xp: 100, text: "Ship the fix: replay idle-tx-timeout", match: { run: ["idle-tx-timeout"] } },
    { id: "report", type: "command", xp: 50, text: "Compare every round: lab report xmin", match: { report: true } },
  ],

  overflow: [
    { id: "outage", type: "command", xp: 50, text: "Run it: replay int4", match: { run: ["int4"] } },
    { id: "watch", type: "observe", xp: 50, text: "Watch int4 ids left reach zero, and orders start failing", observe: { round: "int4", when: "failure", offset: 2 }, hint: "Replay int4 and watch the int4 ids left tile count down." },
    {
      id: "which", type: "quiz", xp: 100, badge: "early-warning",
      async build({ ctx, load }) {
        const r = await load("int4");
        const zero = r.frames.find((f) => f.db?.int4_ids_left != null && f.db.int4_ids_left <= 0)?.t;
        const fail = r.headline.first_failure_s;
        const keys = ["pool_acquired", "longest_xact_s", "int4_ids_left", "pg_lock_wait"];
        const label = { pool_acquired: "App pool connections in use", longest_xact_s: "Oldest open transaction", int4_ids_left: "int4 ids left", pg_lock_wait: "Sessions waiting on a lock" };
        const start = r.frames.find((f) => f.db?.int4_ids_left != null)?.db.int4_ids_left;
        return {
          q: "Which signal told you exactly when orders would start failing?",
          options: keys.map((k) => label[k]), answer: keys.indexOf("int4_ids_left"),
          explain: `In the replayed run int4 ids left started at ${ctx.fmt.n(start)} and reached zero at second ${zero}; the first failed order was at second ${fail}. Nothing else moved: no lock, no pool pressure, until the inserts failed.`,
        };
      },
    },
    { id: "fix", type: "command", xp: 100, text: "Ship the fix: replay bigint", match: { run: ["bigint"] } },
    { id: "report", type: "command", xp: 50, text: "Compare both rounds: lab report overflow", match: { report: true } },
  ],

  hotrow: [
    { id: "baseline", type: "command", xp: 50, text: "Run the baseline: orders spread across accounts", match: { run: ["baseline"] } },
    { id: "outage", type: "command", xp: 50, text: "Send every order to one row: replay hot", match: { run: ["hot"] } },
    { id: "watch", type: "observe", xp: 50, text: "Watch ten or more sessions queue on the one row", observe: { round: "hot", when: "metric", metric: "pg_lock_wait", gte: 10 }, hint: "Replay hot and watch the Lock waiters tile." },
    {
      id: "runs", type: "quiz", xp: 100,
      async build({ ctx }) {
        const hs = ctx.list("hot");
        const ok = hs.filter((h) => h.failed_pct === 0).length, bad = hs.length - ok;
        const opts = ["Every run absorbed it: no failures", "Every run collapsed", "The runs disagreed: some absorbed it, some collapsed"];
        return {
          q: `The hot round was recorded ${hs.length} times. What happened?`, options: opts,
          answer: bad === 0 ? 0 : ok === 0 ? 1 : 2,
          explain: `${ok} absorbed it and ${bad} collapsed (${ctx.range("hot", "failed_pct", ctx.fmt.pct)} failed across runs). With the same load and the same code, that is a system at a tipping point. One recording would have told either story.`,
        };
      },
    },
    { id: "fix", type: "command", xp: 100, text: "Ship the fix: replay hot-locklast", match: { run: ["hot-locklast"] } },
    { id: "report", type: "command", xp: 50, text: "Compare every round: lab report hotrow", match: { report: true } },
  ],
};

// Shared by the briefings of rounds recorded with pgx's cancel-request mode.
const CANCEL_NOTE = `<div class="callout accent"><p><strong>Recorded with <code>CANCEL_MODE=cancel_request</code>.</strong> A request that runs out of time asks PostgreSQL to cancel its query instead of closing the connection (the pgx fix from the batch mission), so what you see is this failure on its own, without the reconnect loop.</p></div>`;

function fmtMB(v) { return `${(v / 1048576).toFixed(1)} MB`; }

/** A quiz whose answer is the bucket a measured ratio falls in. */
function bucket(q, x, buckets, explain) {
  const i = buckets.findIndex((b) => x < b.lt);
  return { q, options: buckets.map((b) => b.label), answer: i < 0 ? buckets.length - 1 : i, explain };
}
