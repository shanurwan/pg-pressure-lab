// The lessons. Every number in the text is computed from site/data (written by
// cmd/sitedata from the recorded runs), so the prose cannot drift from what
// was measured. Each lesson picks a run to replay, a moment to start at, the
// chart signals to draw, and terminal suggestions.

export const PAPER = "https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf";

const n = (v) => Number(v).toLocaleString("en-US");
const pct = (v, d = 1) => `${Number(v).toFixed(d)}%`;
const sec = (v) => `${Math.round(v)} s`;

export function range(values, fmt = (v) => v) {
  const vs = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!vs.length) return "—";
  const lo = Math.min(...vs), hi = Math.max(...vs);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

function stmt(run, prefix) {
  return (run.top_statements || []).find((s) => s.query.startsWith(prefix));
}

function firstSecond(frames, from, pred) {
  for (const f of frames) if (f.t >= from && pred(f)) return f.t;
  return null;
}

// lead formats "seconds before the first failure" as one phrase: "26–47 s before".
function lead(vals) {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo > 0) return `${range(vals)} s before`;
  if (hi < 0) return `${range(vals.map((v) => -v))} s after`;
  return `${-lo} s after to ${hi} s before`;
}

const failed = (f) => Object.values(f.ops).some((o) => o.ok < o.n);

const SIGNALS = [
  { key: "longest_xact_s", label: "Oldest open transaction (s)" },
  { key: "pg_lock_wait", label: "Backends waiting on a lock" },
  { key: "bouncer_cl_waiting", label: "Clients queued in PgBouncer" },
  { key: "pool_empty_acquires", label: "App pool: waits for a connection /s" },
  { key: "pg_sessions_started", label: "New PostgreSQL sessions /s" },
];

export const LESSONS = [
  {
    title: "The setup",
    pick: (D) => D.pick("baseline", 300),
    at: () => 60,
    chart: ["p99_order", "pool_acquired"],
    chips: ["lab run batch baseline", "lab rounds batch", "help"],
    render(D) {
      const r = D.run, m = r.meta, base = D.runs("baseline", 300);
      return `
      <p>A small brokerage-style API in Go answers account, position and order-history reads, and places
      orders: lock the account row, check buying power, insert the order. It talks to
      <strong>PostgreSQL 17</strong> through a <strong>pgx pool of 40</strong> connections and
      <strong>PgBouncer</strong> in transaction mode with <strong>20</strong> server connections.
      The database holds 200,000 accounts, 2 million positions and 20 million orders.</p>
      <p>Load is <strong>open loop</strong>: ${n(m.rate)} requests a second for ${m.duration}, arriving on
      schedule whether or not earlier ones came back, the way customers do. Mix: <code>${m.mix}</code>.
      Every request has a 2-second budget.</p>
      <p>With nothing else running, ${base.length} recorded baseline runs at this rate served
      <strong>${range(base.map((x) => x.headline.requests), n)}</strong> requests with
      <strong class="num-ok">${range(base.map((x) => x.headline.failed), n)}</strong> failures.
      Order p99: ${range(base.map((x) => x.headline.order_p99_ms), (v) => Math.round(v) + " ms")}.
      This is the calm before the job.</p>`;
    },
  },
  {
    title: "The overnight batch",
    pick: (D) => D.pick("naive", 300, true),
    at: (D) => Math.floor(D.run.batch_window.start_s) + 4,
    chart: ["longest_xact_s", "pg_lock_wait"],
    chips: ["lab run batch naive", "lab top", "help"],
    render(D) {
      const r = D.run, nv = D.runs("naive", 300);
      const snap = stmt(r, "INSERT INTO position_snapshots"), mark = stmt(r, "UPDATE accounts a"),
        roll = stmt(r, "INSERT INTO daily_activity");
      return `
      <p>At ${sec(r.batch_window.start_s)} an end-of-day job starts: snapshot every position at the closing
      price, mark every account to market, roll up the day's orders. The obvious way to write it is one
      transaction, so it is all-or-nothing:</p>
      <blockquote>BEGIN;<br>INSERT INTO position_snapshots … ${snap ? `<span class="m">-- ${n(Math.round(snap.mean_ms))} ms</span>` : ""}<br>
      UPDATE accounts SET equity = … <span class="m">-- every account row is now locked${mark ? `, ${n(Math.round(mark.mean_ms))} ms` : ""}</span><br>
      INSERT INTO daily_activity SELECT … FROM orders … ${roll ? `<span class="m">-- ${n(Math.round(roll.mean_ms))} ms, locks still held</span>` : ""}<br>COMMIT;</blockquote>
      <p>In this run the job took <strong class="num-batch">${sec(r.headline.batch_seconds)}</strong>
      (${range(nv.map((x) => x.headline.batch_seconds), sec)} over ${nv.length} runs). Watch the orange
      transaction above PostgreSQL grow. Nothing is wrong yet; the next lesson is what happens when the
      <code>UPDATE</code> lands.</p>
      <p class="try">Try it: type <code>lab run batch naive</code> in the terminal.</p>`;
    },
  },
  {
    title: "Blast radius",
    pick: (D) => D.pick("naive", 300, true),
    at: (D) => (firstSecond(D.run.frames, Math.floor(D.run.batch_window.start_s), (f) => f.db && f.db.pg_lock_wait > 0) ?? 60) + 2,
    chart: ["ok", "pool_acquired", "bouncer_cl_waiting"],
    chips: ["lab run batch naive", "lab report batch"],
    render(D) {
      const r = D.run, ops = JSON.parse(JSON.stringify(r.summary)).ops, nv = D.runs("naive", 300);
      const row = (op) => ops[op] ? `<tr><td>${op}</td><td>${n(ops[op].n)}</td><td>${pct(100 * ops[op].ok_ratio)}</td></tr>` : "";
      return `
      <p>The <code>UPDATE</code> locked every account row. Each order request now waits on a row lock,
      and <strong>while it waits it holds a pool connection</strong>. Twenty server connections fill with
      waiting orders, PgBouncer queues everyone else, the API's pool of 40 empties, and requests that never
      touch a locked row time out too.</p>
      <div class="tbl-wrap"><table class="mini"><thead><tr><th>Operation (this run)</th><th>Requests</th><th>Succeeded</th></tr></thead>
      <tbody>${["account", "positions", "orders", "order"].map(row).join("")}</tbody></table></div>
      <p>Reads of accounts and positions take no locks, yet they failed as often as orders. Over
      ${nv.length} naive runs, <strong class="num-bad">${range(nv.map((x) => x.headline.failed_pct), (v) => pct(v, 0))}</strong>
      of <em>all</em> requests failed. A lock problem on one table became a connection problem for every endpoint.</p>`;
    },
  },
  {
    title: "Why it didn't come back",
    pick: (D) => D.pick("naive", 300, true),
    at: (D) => Math.ceil(D.run.batch_window.end_s) + 15,
    chart: ["ok", "pg_sessions_started", "pool_empty_acquires"],
    chips: ["lab run batch naive", "lab report batch"],
    render(D) {
      const r = D.run, nv = D.runs("naive", 300), half = D.runs("naive", 150);
      const never = nv.filter((x) => x.headline.recovered_s === null).length;
      const end = Math.ceil(r.batch_window.end_s);
      const after = r.frames.filter((f) => f.t >= end && f.db && f.db.pg_sessions_started !== null);
      const before = r.frames.filter((f) => f.t < Math.floor(r.batch_window.start_s) && f.db && f.db.pg_sessions_started !== null);
      const avg = (fs) => fs.length ? fs.reduce((a, f) => a + f.db.pg_sessions_started, 0) / fs.length : null;
      const churn = avg(after), calm = avg(before);
      return `
      <p>The job committed at ${sec(r.batch_window.end_s)} and released every lock. The API did not recover:
      <strong class="num-bad">${n(r.headline.failed_after_batch)}</strong> requests failed
      <em>after</em> the batch had finished. In ${never} of ${nv.length} naive runs the API never got back
      to ten healthy seconds before the run ended (failures after the batch:
      ${range(nv.map((x) => x.headline.failed_after_batch), n)}).</p>
      <p>The loop that keeps it down: a request waits almost its whole 2 s budget for a connection, gets one
      with milliseconds left, starts a query and is cancelled. Cancelling mid-query costs the connection:</p>
      <blockquote>pgbouncer: closing because: client disconnect while server was not ready (age=0s)</blockquote>
      <p>So the next request waits longer, and capacity goes into work that has already expired.
      ${churn !== null ? `PostgreSQL saw <strong class="num-bad">${churn.toFixed(0)}</strong> new sessions a second after the batch, against ${calm !== null ? calm.toFixed(1) : "—"} before it.` : ""}
      The trigger is gone; the failure sustains itself. This is a
      <a href="${PAPER}">metastable failure</a> (Bronson et al., HotOS 2021).</p>
      ${half.length ? `<p>It is not just a busy system tipping over. At <strong>half the load</strong> (150 requests a second)
      ${half.map((x) => `${pct(x.headline.failed_pct, 0)} of requests failed, ${n(x.headline.failed_after_batch)} of them after the batch, ${x.headline.recovered_s === null ? "and it never recovered within the run" : `recovering after ${sec(x.headline.recovered_s)}`}`).join("; ")}.</p>` : ""}`;
    },
  },
  {
    title: "Fix 1: chunk the job",
    pick: (D) => D.pick("chunked", 300),
    at: (D) => Math.floor(D.run.batch_window.start_s) + 20,
    chart: ["ok", "pg_lock_wait", "longest_xact_s"],
    chips: ["lab run batch chunked", "lab report batch"],
    render(D) {
      const ch = D.runs("chunked", 300), nv = D.runs("naive", 300);
      return `
      <p>Same work, written for a live system: 1,000 accounts per transaction, each with
      <code>SET LOCAL lock_timeout = '100ms'</code> so the <em>job</em> backs off when it meets an order
      (and retries the chunk), a pause between chunks, its own two-connection PgBouncer pool, and the
      rollup outside any account lock.</p>
      <p>Result over ${ch.length} runs: <strong class="num-ok">${range(ch.map((x) => x.headline.failed), n)}</strong>
      failed requests, at most ${range(ch.map((x) => x.headline.max_lock_wait), n)} backend waiting on a lock.
      The price is time: the job took ${range(ch.map((x) => x.headline.batch_seconds), sec)} instead of
      ${range(nv.map((x) => x.headline.batch_seconds), sec)}. Overnight, that is a good trade.</p>`;
    },
  },
  {
    title: "Fix 2: fail fast",
    pick: (D) => D.pick("naive-failfast", 300, true),
    at: (D) => Math.ceil(D.run.batch_window.end_s) - 3,
    chart: ["ok", "pg_sessions_started", "pool_empty_acquires"],
    chips: ["lab run batch naive-failfast", "lab report batch"],
    render(D) {
      const ff = D.runs("naive-failfast", 300), nv = D.runs("naive", 300);
      const errs = {};
      ff.forEach((x) => Object.entries(x.headline.errors).forEach(([k, v]) => (errs[k] = (errs[k] || 0) + v)));
      const rows = [["naive", nv], ["naive-failfast", ff], ["chunked", D.runs("chunked", 300)]].map(([name, rs]) =>
        `<tr><td>${name}</td><td>${rs.length}</td><td>${range(rs.map((x) => x.headline.failed_pct), (v) => pct(v))}</td>
        <td>${range(rs.map((x) => x.headline.failed_after_batch), n)}</td>
        <td>${rs.every((x) => x.headline.recovered_s !== null) ? range(rs.map((x) => x.headline.recovered_s), (v) => v.toFixed(1) + " s") : "never, in " + rs.filter((x) => x.headline.recovered_s === null).length}</td></tr>`).join("");
      return `
      <p>Suppose you cannot change the job tonight. Change the API instead: wait at most
      <strong>250 ms</strong> for a pool connection, and never start a query with less than
      <strong>250 ms</strong> of the request's budget left. Refuse at once with a 503 instead.</p>
      <p>The naive batch still hurts while it holds its locks, but refused requests cost nothing, so the pool
      keeps doing useful work and the loop never forms. Errors across these runs:
      ${Object.entries(errs).map(([k, v]) => `<code>${k}</code> ${n(v)}`).join(", ")}.</p>
      <div class="tbl-wrap"><table class="mini"><thead><tr><th>Round (300 req/s)</th><th>Runs</th><th>Failed</th><th>Failed after batch</th><th>Recovered after batch</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p>Do both: chunk the job so it never takes the locks that hurt, and fail fast so the next thing you did not
      foresee cannot turn into an outage that outlives its cause.</p>`;
    },
  },
  {
    title: "What to alert on",
    pick: (D) => D.pick("naive", 300, true),
    at: (D) => Math.floor(D.run.batch_window.start_s) + 2,
    chart: ["ok", "longest_xact_s", "pg_lock_wait"],
    chips: ["lab run batch naive", "lab top"],
    async prepare(D) {
      const base = await Promise.all(D.runs("baseline", 300).map((x) => D.load(x.id)));
      const naive = await Promise.all(D.runs("naive", 300).map((x) => D.load(x.id)));
      const ceiling = {};
      for (const s of SIGNALS) {
        let mx = null;
        for (const r of base) for (const f of r.frames) {
          const v = f.db && f.db[s.key];
          if (v !== null && v !== undefined) mx = Math.max(mx ?? 0, v);
        }
        ceiling[s.key] = mx;
      }
      const leads = {};
      for (const s of SIGNALS) leads[s.key] = [];
      for (const r of naive) {
        const start = Math.floor(r.batch_window.start_s);
        const fail = firstSecond(r.frames, start, failed);
        if (fail === null) continue;
        for (const s of SIGNALS) {
          if (ceiling[s.key] === null) continue;
          const t = firstSecond(r.frames, start, (f) => f.db && f.db[s.key] !== null && f.db[s.key] > ceiling[s.key]);
          if (t !== null) leads[s.key].push(fail - t);
        }
      }
      return { ceiling, leads, runs: naive.length };
    },
    render(D, x) {
      const rows = SIGNALS.filter((s) => x.ceiling[s.key] !== null).map((s) => {
        const l = x.leads[s.key];
        return `<tr><td>${s.label}</td><td>${x.ceiling[s.key]}</td><td>${l.length ? lead(l) : "never crossed"}</td><td>${l.length}/${x.runs}</td></tr>`;
      }).join("");
      return `
      <p>Which signal would have paged you first? For each signal, the threshold below is the highest value
      seen in the baseline runs (no batch). The table shows when, in each naive run, the signal first went
      above it, relative to the first failed request.</p>
      <div class="tbl-wrap"><table class="mini"><thead><tr><th>Signal</th><th>Baseline max</th><th>Crossed, vs first failure</th><th>Runs</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p>Errors, lock waits and pool queues all arrive together: by the time they fire, customers are already
      failing. <strong>The age of the oldest open transaction</strong> rises from the moment the job begins.
      Alert on transaction age (<code>now() - xact_start</code> in <code>pg_stat_activity</code>), and on
      new sessions per second, the signature of the loop in lesson 4.</p>`;
    },
  },
  {
    title: "Run it yourself",
    pick: (D) => D.pick("naive-failfast", 300, true),
    at: () => 0,
    chart: ["ok", "p99_order"],
    chips: ["help", "lab runs", "lab report batch"],
    render(D) {
      return `
      <p>Everything above is a replay of ${D.index.length} recorded runs, all in the repository with the exact
      settings of each round. Clone it, run the same drills on your machine, and this page switches to
      <strong>live mode</strong> to follow your run as it happens.</p>
      <p>Change one thing and measure it: a smaller chunk, a shorter <code>lock_timeout</code>, a bigger
      pool (does it help, or just queue more?), a lower request budget.</p>
      <div class="lesson-nav"><a class="btn primary" href="#developers">Set it up</a>
      <a class="btn ghost" href="https://github.com/shanurwan/pg-pressure-lab">Read the code</a></div>`;
    },
  },
];
