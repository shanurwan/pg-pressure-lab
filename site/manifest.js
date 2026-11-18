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
};

export const SCENARIOS = [
  {
    id: "batch", ready: true, minutes: 25, primary: "naive", fixes: ["chunked", "naive-cancelreq", "naive-failfast"],
    title: "The batch job finished. The outage didn't.",
    short: "Overnight batch vs live traffic",
    summary: "One end-of-day transaction locks every account while orders keep arriving. The pool drains, reads fail with it, and the API stays down after the job commits.",
    sources: ["alpaca28aug", "alpaca27jun", "aws2021"], reading: ["bronson"],
    practise: ["Read a lock-driven outage from pg_stat_activity and PgBouncer", "Explain what keeps a metastable failure going", "Compare three fixes by measured impact", "Pick alerts that fire before users notice"],
    rounds: {
      baseline: "No job. The reference: the same traffic with nothing else running.",
      naive: "The job as one transaction: snapshot positions, mark every account to market, roll up the day's orders. Every account row stays locked until it commits.",
      chunked: "Fix: 1,000 accounts per short transaction with lock_timeout = 100 ms (the job yields to orders and retries), its own two-connection pool, and the rollup outside any account lock.",
      "naive-cancelreq": "Fix: the same naive job. Only pgx changes: a cancelled request asks the server to cancel the query (CancelRequestContextWatcherHandler) instead of closing the connection.",
      "naive-failfast": "Fix: the same naive job. The API waits at most 250 ms for a connection and starts no query with less than 250 ms of its deadline left.",
    },
    incident(ctx) {
      return `<p>Alpaca's public status page describes two nights this year that this scenario is built around: an overnight batch with more data than usual that <strong>reduced capacity for the API</strong>, and order timeouts from <strong>database connection pressure</strong>. Their notes don't describe their internals, so this lab does not try to; it reproduces the <em>class</em> of failure on its own stack and measures it.</p>
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
    interview: [
      {
        q: "An overnight batch job finished, but the API kept failing for minutes afterwards. Walk me through how you'd diagnose it and what you'd change.",
        a(ctx) {
          return {
            detect: [ctx.sigLead("longest_xact_s", "Page on the age of the oldest open transaction"), "Error-rate SLO burn on every endpoint, not just writes: the blast radius is the pool, not the table.", "PgBouncer cl_waiting and the app pool's wait count rising together."].filter(Boolean),
            mitigate: ["Stop the trigger: find the job's backend in pg_stat_activity (oldest xact_start) and cancel or terminate it.", ctx.range("naive-failfast", "failed_pct", ctx.fmt.pct) && `Shed load fast instead of queueing: bounding the pool wait recovered within ${ctx.range("naive-failfast", "recovered_s", ctx.fmt.s)} in the lab.`, "If it still doesn't recover once the job is gone, the loop is self-sustaining: reduce in-flight requests or restart the callers to clear the queue."].filter(Boolean),
            root: [`One transaction locked every account row; order requests waited on those locks while holding pool connections, so reads failed too (${ctx.range("naive", "failed_pct", ctx.fmt.pct)} of all requests).`, `After it committed, cancellations kept closing connections (pgx default) and PgBouncer kept rebuilding them${ctx.range("naive", "max_sessions_per_s", ctx.fmt.n) ? ` (${ctx.range("naive", "max_sessions_per_s", ctx.fmt.n)} new sessions/s)` : ""}: a metastable state.`],
            prevent: [ctx.range("chunked", "failed_pct", ctx.fmt.pct) && `Chunk the job: short transactions, lock_timeout, its own small pool (${ctx.range("chunked", "failed_pct", ctx.fmt.pct)} failed).`, ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct) && `CancelRequestContextWatcherHandler in pgx (${ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct)} failed with the job unchanged).`, "Alert on transaction age; review batch jobs like schema changes."].filter(Boolean),
          };
        },
        followups: ["Why did reads fail when the job only locked account rows?", "Why did halving the traffic not help?", "What does lock_timeout cost the batch job, and is that acceptable?", "How would you prove the fix in production without waiting for the next bad night?"],
      },
      {
        q: "What would you alert on for this failure, and how much warning would it give you?",
        a(ctx) {
          return {
            detect: [ctx.sigLead("longest_xact_s", "Oldest open transaction age"), ctx.sigLead("pg_lock_wait", "Lock waiters"), ctx.sigLead("bouncer_cl_waiting", "PgBouncer clients waiting")].filter(Boolean),
            mitigate: ["Alert routes to the on-call with the job's pid and xact_start in the payload, so the first action is obvious."],
            root: ["Lock waits are a symptom that appears once callers are already queued; the long transaction is the cause and is visible from its first second."],
            prevent: ["A per-role max transaction age (batch role vs app role) instead of one global threshold.", "Error-budget burn-rate alerts as the user-facing backstop."],
          };
        },
        followups: ["What threshold would you pick, and how would you avoid paging on every legitimate long report?", "Which of these signals would you put on the service dashboard vs the database dashboard?"],
      },
      {
        q: "Your Go service uses pgx behind PgBouncer. What happens when a request's context is cancelled mid-query, and what would you change?",
        a(ctx) {
          return {
            detect: ["New sessions per second on PostgreSQL and PgBouncer 'client disconnect while server was not ready' in the logs are the fingerprint of cancellation churn."],
            mitigate: ["Bound the time spent waiting for a pool connection separately from the query budget, and refuse work that cannot finish."],
            root: ["The default DeadlineContextWatcherHandler sets an immediate deadline on the socket; the read fails, pgx closes the connection and the pool destroys it. Behind PgBouncer the server connection goes too."],
            prevent: [ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct) && `Use CancelRequestContextWatcherHandler so a cancelled query is cancelled on the server and the connection survives: in the lab the same incident went to ${ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct)} failed.`, "Load-test with deadlines and a lock storm, not just throughput."].filter(Boolean),
          };
        },
        followups: ["What's the risk of the cancel-request approach if the server never acknowledges the cancel?", "How does transaction pooling change what a session-level setting means?"],
      },
      {
        q: "How would you run an end-of-day job against a live trading database safely?",
        a(ctx) {
          return {
            detect: ["Instrument the job: chunk duration, lock-timeout retries, rows per second; alert if it stops making progress."],
            mitigate: ["A kill switch and a resumable checkpoint, so stopping it is cheap."],
            root: ["Long transactions hold locks and the xmin horizon; one big transaction is atomic but is also the largest possible blast radius."],
            prevent: [`Small transactions keyed by id range, lock_timeout so the job yields to live traffic, its own pool so it can't take the API's connections${ctx.range("chunked", "batch_seconds", ctx.fmt.s) ? ` (the job went to ${ctx.range("chunked", "batch_seconds", ctx.fmt.s)}, with 0 failed requests)` : ""}.`, "Separate heavy read-only rollups from the locking writes; consider a replica for the reads (not measured here)."],
          };
        },
        followups: ["How do you keep the result consistent if the job is now many transactions?", "When is one big transaction the right answer?"],
      },
    ],
    star(ctx) {
      return {
        Situation: `In a lab I built: a Go API on pgx → PgBouncer → PostgreSQL 17 under ${ctx.fmt.n(ctx.rate)} req/s of open-loop load, with an end-of-day job written as one transaction.`,
        Task: "Find out why the API stayed down after the job ended, and which fix to ship.",
        Action: "Recorded pg_stat_activity, PgBouncer pools and app pool waits every second; read the pgx source to confirm why cancellations closed connections; measured three fixes, one change at a time, at least twice each.",
        Result: [ctx.range("naive", "failed_pct", ctx.fmt.pct) && `The naive job failed ${ctx.range("naive", "failed_pct", ctx.fmt.pct)} of requests and never recovered`, ctx.range("chunked", "failed_pct", ctx.fmt.pct) && `chunking reached ${ctx.range("chunked", "failed_pct", ctx.fmt.pct)}`, ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct) && `one pgx setting brought it to ${ctx.range("naive-cancelreq", "failed_pct", ctx.fmt.pct)}`].filter(Boolean).join("; ") + ".",
      };
    },
  },

  {
    id: "migration", ready: true, minutes: 20, primary: "alter-naive", fixes: ["alter-locktimeout", "index-concurrently"],
    title: "A one-second ALTER that took the API down",
    short: "Schema change on a hot table",
    summary: "A schema change needs a brief exclusive lock. Queued behind one long read, it blocks every query behind it. Then: building an index on a 20-million-row table without CONCURRENTLY.",
    sources: ["gocardless", "railway"], reading: [],
    practise: ["Read the lock queue with pg_blocking_pids", "Use lock_timeout and retries for DDL", "Build indexes on big tables without blocking writes", "Explain why a 'fast' migration can still cause an outage"],
    rounds: {
      "alter-naive": "A long read transaction holds a lock on accounts; ALTER TABLE accounts ADD COLUMN waits for it, and every later query on accounts queues behind the ALTER.",
      "alter-locktimeout": "Fix: the same ALTER with lock_timeout = 1 s and retries with backoff, so it gives up its place in the queue instead of blocking everyone.",
      "index-plain": "CREATE INDEX on orders(symbol), 20 million rows: writes to orders wait for the whole build.",
      "index-concurrently": "Fix: CREATE INDEX CONCURRENTLY: slower, but writes keep flowing.",
    },
    incident() {
      return `<p>GoCardless describe a migration whose DDL itself took milliseconds but needed an <strong>ACCESS EXCLUSIVE</strong> lock on a busy table. It queued behind a long-running read, and every query that arrived after it queued behind the DDL: about fifteen seconds of API timeouts. Railway's October 2025 incident is the bigger cousin: a non-concurrent index on a table of about a billion rows, connections piling up until even the admin reserve was gone.</p>`;
    },
    reproduce(ctx) {
      const f = ctx.range("alter-naive", "failed_pct", ctx.fmt.pct);
      return `<p>The <strong>alter-naive</strong> round opens a long read on accounts, then runs an ALTER TABLE that needs a moment of exclusive access.</p>${f ? `<div class="callout bad"><p>Across ${ctx.count("alter-naive")} runs, <strong class="v-bad">${f}</strong> of requests failed while the ALTER waited in line.</p></div>` : ""}`;
    },
    diagnose() {
      return `<p>In a lock queue, a waiting ACCESS EXCLUSIVE request blocks every later request on the table, even plain reads that would not conflict with the long transaction. <code>pg_blocking_pids(pid)</code> shows the chain: readers blocked by the ALTER, the ALTER blocked by the long transaction.</p>`;
    },
    fix(ctx) {
      const lt = ctx.range("alter-locktimeout", "failed_pct", ctx.fmt.pct), ic = ctx.range("index-concurrently", "failed_pct", ctx.fmt.pct), ip = ctx.range("index-plain", "failed_pct", ctx.fmt.pct);
      return `<ul>${[lt && `<li><strong>lock_timeout + retry:</strong> ${lt} failed.</li>`, ip && ic && `<li><strong>CREATE INDEX CONCURRENTLY</strong> instead of a plain build: ${ic} failed, against ${ip}.</li>`].filter(Boolean).join("")}</ul>`;
    },
    alert(ctx) { return `<p>Watch for DDL waiting on a lock and for any transaction older than your migration budget before you start one.</p>${ctx.signalsSentence()}`; },
    interview: [
      {
        q: "How do you add a column and an index to a 1-billion-row table on a live database without downtime?",
        a(ctx) {
          return {
            detect: ["Before starting: check for long transactions and pending locks on the table; during: watch lock waiters and the age of the DDL's wait."],
            mitigate: ["If the DDL is queued and traffic is piling up behind it, cancel the DDL first: it is the one blocking everyone."],
            root: ["ALTER TABLE needs ACCESS EXCLUSIVE briefly; while it waits it blocks every later query. A plain CREATE INDEX blocks writes for the whole build."],
            prevent: ["SET lock_timeout (a few seconds) and retry with backoff.", "CREATE INDEX CONCURRENTLY (and check for INVALID indexes if it fails).", "Add constraints NOT VALID, then VALIDATE separately; add NOT NULL via a validated CHECK first.", ctx.range("alter-locktimeout", "failed_pct", ctx.fmt.pct) && `In the lab, lock_timeout + retry brought the ALTER round to ${ctx.range("alter-locktimeout", "failed_pct", ctx.fmt.pct)} failed.`].filter(Boolean),
          };
        },
        followups: ["What happens if CREATE INDEX CONCURRENTLY fails halfway?", "Why can a metadata-only ALTER still cause an outage?", "How do you make migrations safe by default for every team?"],
      },
      {
        q: "Requests on one table are all timing out, but CPU and I/O look normal. What do you check?",
        a() {
          return {
            detect: ["pg_stat_activity wait_event_type = 'Lock'; pg_blocking_pids() to find the head of the chain; pg_locks for the lock modes."],
            mitigate: ["Cancel the head of the chain if it is a migration or an idle-in-transaction session; otherwise wait or shed load."],
            root: ["Lock queues are FIFO: one waiting strong lock blocks weaker requests behind it."],
            prevent: ["lock_timeout on DDL, statement_timeout and idle_in_transaction_session_timeout on application roles."],
          };
        },
        followups: ["What's the difference between lock_timeout and statement_timeout?"],
      },
    ],
    star() {
      return { Situation: "Lab: a migration on a hot table under live load.", Task: "Show why a fast ALTER can cause an outage and make it safe.", Action: "Reproduced the lock queue, then lock_timeout + retry, and CONCURRENTLY for the index; measured each.", Result: "See the rounds table for the measured difference." };
    },
  },

  {
    id: "retry", ready: true, minutes: 20, primary: "retry-immediate", fixes: ["retry-backoff-budget", "no-retry"],
    title: "Retries that kept the outage alive",
    short: "Client retry storm",
    summary: "A short stall makes clients retry immediately. The retries multiply the load, and the system stays down after the stall is gone.",
    sources: ["aws2021", "alpaca24jun"], reading: ["bronson"],
    practise: ["Recognise work amplification from retries", "Design retry budgets and jittered backoff", "Explain metastability to a non-specialist"],
    rounds: {
      "no-retry": "Clients do not retry. The reference for the same short trigger.",
      "retry-immediate": "Clients retry failed requests immediately, several times.",
      "retry-backoff-budget": "Fix: jittered exponential backoff with a retry budget, so retries can never be more than a small share of traffic.",
    },
    incident() {
      return `<p>AWS's December 2021 us-east-1 event is the textbook case: clients that did not back off kept retrying connections, and the retries kept internal network devices overloaded long after the original trigger. Bronson et al. call this a <em>sustaining effect</em>: the work the system does because it is failing keeps it failing.</p>`;
    },
    reproduce(ctx) {
      const f = ctx.range("retry-immediate", "failed_pct", ctx.fmt.pct);
      return `<p>The trigger is short. The difference between rounds is only what clients do when a request fails.</p>${f ? `<div class="callout bad"><p>With immediate retries, <strong class="v-bad">${f}</strong> of requests failed across ${ctx.count("retry-immediate")} runs.</p></div>` : ""}`;
    },
    diagnose() { return "<p>Compare offered load to original load: when retries are a large share of what the server sees, the server spends its capacity on requests that are already doomed.</p>"; },
    fix(ctx) {
      const b = ctx.range("retry-backoff-budget", "failed_pct", ctx.fmt.pct), n = ctx.range("no-retry", "failed_pct", ctx.fmt.pct);
      return `<ul>${[b && `<li><strong>Backoff + retry budget:</strong> ${b} failed.</li>`, n && `<li><strong>No retries:</strong> ${n} failed.</li>`].filter(Boolean).join("")}</ul>`;
    },
    alert(ctx) { return `<p>Track the ratio of retried to original requests at the client and at the edge.</p>${ctx.signalsSentence()}`; },
    interview: [
      {
        q: "What's a metastable failure, and how would you design clients so they can't cause one?",
        a() {
          return {
            detect: ["The trigger is gone but error rate stays high; offered load is far above organic load; retry ratio climbing."],
            mitigate: ["Cut the sustaining effect: disable retries, shed load at the edge, or drain queues; capacity alone often doesn't help."],
            root: ["A trigger pushes the system past a point where the extra work it causes (retries, reconnects, cancelled work) keeps it overloaded."],
            prevent: ["Retry budgets (e.g. retries ≤ 10% of requests), jittered exponential backoff, deadlines propagated end to end, and admission control."],
          };
        },
        followups: ["Why does adding capacity sometimes not fix it?", "Where should the retry budget live: client, gateway, or both?"],
      },
    ],
    star() { return { Situation: "Lab: a short database stall under client retries.", Task: "Show how retries change recovery.", Action: "Ran the same trigger with three client policies.", Result: "See the rounds table." }; },
  },

  {
    id: "xmin", ready: true, minutes: 20, primary: "idle-tx", fixes: ["idle-tx-timeout"],
    title: "The idle transaction that slowed everything down",
    short: "xmin horizon and bloat",
    summary: "One session left idle in a transaction holds back vacuum. Dead rows pile up on a hot table and reads slow down for everyone.",
    sources: ["trigger", "sentry2015", "mandrill"], reading: [],
    practise: ["Find what is holding back the xmin horizon", "Explain MVCC, vacuum and dead tuples", "Set idle_in_transaction_session_timeout with confidence"],
    rounds: {
      baseline: "No idle transaction: vacuum keeps the hot table small.",
      "idle-tx": "A session opens a transaction and goes idle, holding the xmin horizon while the hot table keeps being updated.",
      "idle-tx-timeout": "Fix: idle_in_transaction_session_timeout ends the idle session, and vacuum can clean up again.",
    },
    incident() {
      return `<p>Trigger.dev saw a held-back xmin horizon leave hundreds of thousands of dead tuples on a hot table, with CPU pinned for hours. Taken to its limit, the same mechanism is how Sentry (2015) and Mandrill (2019) reached transaction ID wraparound protection and stopped taking writes.</p>`;
    },
    reproduce(ctx) {
      const f = ctx.range("idle-tx", "read_p99_ms", ctx.fmt.ms);
      return `<p>A hot table is updated continuously while one session sits idle in a transaction.</p>${f ? `<div class="callout bad"><p>Read p99 with the idle transaction: <strong>${f}</strong>.</p></div>` : ""}`;
    },
    diagnose() { return "<p>Look for the oldest <code>backend_xmin</code> in pg_stat_activity, replication slots and prepared transactions; compare dead tuples on the hot table to live ones.</p>"; },
    fix(ctx) { const t = ctx.range("idle-tx-timeout", "read_p99_ms", ctx.fmt.ms); return t ? `<p>With the timeout, read p99 was <strong>${t}</strong>.</p>` : "<p>See the rounds table.</p>"; },
    alert(ctx) { return `<p>Alert on the age of the oldest xmin and on dead tuples on the tables you care about.</p>${ctx.signalsSentence()}`; },
    interview: [
      {
        q: "A table that should be small keeps growing and queries on it get slower, but vacuum is running. What's going on?",
        a() {
          return {
            detect: ["n_dead_tup growing on the table; autovacuum logs 'dead row versions cannot be removed yet'; an old backend_xmin, replication slot or prepared transaction."],
            mitigate: ["Terminate the session holding the horizon (or drop the stale slot), then let vacuum catch up."],
            root: ["MVCC keeps old row versions until no transaction can see them; one old snapshot keeps every newer dead row alive."],
            prevent: ["idle_in_transaction_session_timeout for app roles, alerts on xmin age, monitoring of replication slots, and of age(datfrozenxid) for wraparound."],
          };
        },
        followups: ["How does this connect to transaction ID wraparound?", "Why does a replica with hot_standby_feedback matter here?"],
      },
    ],
    star() { return { Situation: "Lab: a hot table plus one idle transaction.", Task: "Show the cost and the fix.", Action: "Measured dead tuples and read latency with and without the timeout.", Result: "See the rounds table." }; },
  },

  {
    id: "overflow", ready: true, minutes: 15, primary: "overflow", fixes: [],
    title: "When an id ran out of integers",
    short: "int4 key overflow",
    summary: "A bigint primary key referenced by an int4 column works for years, then every insert fails at 2,147,483,647.",
    sources: ["buildkite"], reading: [],
    practise: ["Audit for int4 columns referencing bigint keys", "Alert on percent of id range used", "Plan the bigint migration before the cliff"],
    rounds: { overflow: "The sequence is close to 2^31; an int4 column that references the order id overflows mid-run." },
    incident() { return "<p>Buildkite's July 2023 incident: the primary key was already bigint, but a foreign key column was int4. It overflowed at 2,147,483,647 and new jobs stopped for about an hour and a half.</p>"; },
    reproduce() { return "<p>Orders are written at a steady rate; partway through the run the id passes the int4 limit.</p>"; },
    diagnose() { return "<p>The error is <code>integer out of range</code> on insert. The fix is not the sequence, it's the column type of everything that stores the id.</p>"; },
    fix() { return "<p>Convert referencing columns to bigint ahead of time (online, with a new column and backfill), or as an emergency workaround, move the sequence to negative values.</p>"; },
    alert(ctx) { return `<p>Alert at a fraction of the int4 range used, for every int4 column that stores an id.</p>${ctx.signalsSentence()}`; },
    interview: [
      {
        q: "How would you find and fix an id column that's about to overflow, before it does?",
        a() {
          return {
            detect: ["Query sequences and columns: last_value vs the column's type maximum; alert at, say, 50% and 75%."],
            mitigate: ["Emergency: restart the sequence in the negative range to buy time."],
            root: ["The key was bigint but a referencing column wasn't; overflow happens on the narrowest column that stores the value."],
            prevent: ["bigint for all ids by default; schema linting; a backfill-based online type change well before the cliff."],
          };
        },
        followups: ["Why is ALTER COLUMN TYPE bigint dangerous on a big table, and how do you do it online?"],
      },
    ],
    star() { return { Situation: "Lab: an int4 reference to a bigint key.", Task: "Reproduce and detect the overflow early.", Action: "Ran writes across the limit and measured when an alert would fire.", Result: "See the rounds table." }; },
  },

  {
    id: "hotrow", ready: true, minutes: 15, primary: "hot", fixes: [],
    title: "One account, every order",
    short: "Hot-row lock contention",
    summary: "When many writes hit the same row, they queue on its lock. Throughput collapses even though the database is otherwise idle.",
    sources: ["heroku2019"], reading: [],
    practise: ["Spot tuple-lock queues in pg_locks", "Redesign a hot counter as an append-only ledger", "Reason about SKIP LOCKED and sharded counters"],
    rounds: { hot: "A share of orders all update the same omnibus account row." },
    incident() { return "<p>Heroku describe parallel UPDATEs on the same row queuing on its lock, some for days, with job processing dropping to almost zero.</p>"; },
    reproduce() { return "<p>Orders keep arriving; a share of them update one shared account row.</p>"; },
    diagnose() { return "<p>Lock waits on a single tuple: <code>pg_locks</code> with locktype = 'tuple' or transactionid, many waiters, one holder at a time.</p>"; },
    fix() { return "<p>Stop updating the row: write an append-only ledger and aggregate, or shard the counter.</p>"; },
    alert(ctx) { return `<p>Lock waiters concentrated on one relation and one row.</p>${ctx.signalsSentence()}`; },
    interview: [
      {
        q: "Order throughput collapsed for one big customer account but not for others. What do you suspect and how do you fix it?",
        a() {
          return {
            detect: ["Lock waits concentrated on one row; p99 for that account only."],
            mitigate: ["Rate-limit that account's writers; move its work to a queue processed serially."],
            root: ["Every order updates the same balance row, so writes serialise on its lock."],
            prevent: ["Append-only ledger with periodic aggregation, sharded counters, or SELECT … FOR UPDATE SKIP LOCKED work queues."],
          };
        },
        followups: ["How do you keep a balance correct if it's computed from a ledger?"],
      },
    ],
    star() { return { Situation: "Lab: an omnibus account row under concurrent orders.", Task: "Show the contention and a design fix.", Action: "Measured the hot round against alternatives.", Result: "See the rounds table." }; },
  },

  {
    // Not ready: its recorded runs are being re-recorded with a report query
    // that can finish on its own. Flip `ready` once results/conn is redone.
    id: "conn", ready: false, minutes: 15, primary: "shared", fixes: ["bulkhead", "bulkhead-timeout"],
    title: "One slow report, every endpoint slow",
    short: "Shared pool exhaustion",
    summary: "A rare, slow query shares the connection pool with everything else. Under load it holds connections and every endpoint queues behind it.",
    sources: ["alpaca27jun", "railway"], reading: [],
    practise: ["Design bulkheads for connection pools", "Use per-role statement_timeout", "Read pool saturation from the app and from PgBouncer"],
    rounds: {
      baseline: "No report traffic.", shared: "1 request in 100 is a slow report on the shared pool.",
      bulkhead: "Fix: reports get their own three-connection pool.", "bulkhead-timeout": "Fix: plus statement_timeout for the report role.",
    },
    incident() { return "<p>Order timeouts from database connection pressure (Alpaca, 27 June 2026) and connection slots exhausted by long-running work (Railway, October 2025).</p>"; },
    reproduce() { return "<p>See the rounds.</p>"; }, diagnose() { return ""; }, fix() { return ""; },
    alert(ctx) { return ctx.signalsSentence(); },
    interview: [], star() { return { Situation: "", Task: "", Action: "", Result: "" }; },
  },
];

export const STEPS = [
  { id: "incident", label: "The incident" },
  { id: "reproduce", label: "Reproduce" },
  { id: "diagnose", label: "Diagnose" },
  { id: "fix", label: "Fix" },
  { id: "alert", label: "What to alert on" },
  { id: "drill", label: "Interview drill" },
];
