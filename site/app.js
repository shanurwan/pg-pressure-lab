// pg-pressure-lab interactive replays. Replays recorded runs from site/data, or in
// live mode follows frames streamed from /live/events (same frame format).
import { LESSONS, range } from "./lessons.js";
import { createScene } from "./scene.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmtN = (v) => Number(v).toLocaleString("en-US");

// ---------- theme ----------
const savedTheme = store.get("pgpl-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  store.set("pgpl-theme", next);
  drawChart();
  scene?.setTheme();
});

// ---------- data ----------
const cache = new Map();
const D = {
  index: [],
  run: null,
  runs(round, rate) { return this.index.filter((r) => r.round === round && (rate === undefined || r.rate === rate)); },
  pick(round, rate = 300, preferSessions = false) {
    let rs = this.runs(round, rate);
    if (preferSessions) {
      const withS = rs.filter((r) => r.headline.max_sessions_per_s !== null);
      if (withS.length) rs = withS;
    }
    return rs.length ? rs[rs.length - 1].id : this.index[0]?.id;
  },
  async load(id) {
    if (id === "live") return liveRun;
    if (!cache.has(id)) {
      cache.set(id, fetch(`data/runs/${id}.json`).then((r) => {
        if (!r.ok) throw new Error(`run ${id}: HTTP ${r.status}`);
        return r.json();
      }).then(prepRun));
    }
    return cache.get(id);
  },
};

function prepRun(run) {
  run.byT = new Map(run.frames.map((f) => [f.t, f]));
  run.maxT = run.frames.length ? run.frames[run.frames.length - 1].t : 0;
  return run;
}

// ---------- state ----------
const params = new URLSearchParams(location.search);
const state = { lesson: 0, t: 0, playing: false, speed: 10, follow: true };
let scene = null;
let lessonExtra = null;
let liveRun = null;

function frameAt(run, t) {
  if (!run) return null;
  const ti = Math.floor(t);
  if (run.byT.has(ti)) return run.byT.get(ti);
  for (let k = ti; k >= 0; k--) if (run.byT.has(k)) return run.byT.get(k);
  return run.frames[0] || null;
}

// ---------- hero ----------
function renderHero() {
  const nv = D.runs("naive", 300), ff = D.runs("naive-failfast", 300), ch = D.runs("chunked", 300);
  const sec = (v) => `${Math.round(v)} s`;
  $("hero-lede").innerHTML = `${D.index.length} recorded runs of a Go API on PostgreSQL. A
    <strong>${range(nv.map((x) => x.headline.batch_seconds), sec)}</strong> end-of-day job made
    <strong>${range(nv.map((x) => x.headline.failed_pct), (v) => v.toFixed(0) + "%")}</strong> of all requests fail,
    and the API kept failing long after the job had committed. Replay what happened, second by second,
    then watch two fixes: one takes failures to zero, the other brings the API back within a second.`;
  const stats = [
    ["bad", range(nv.map((x) => x.headline.failed_pct), (v) => v.toFixed(0) + "%"), "of all requests failed during a naive batch"],
    ["batch", range(nv.map((x) => x.headline.failed_after_batch), fmtN), "requests failed after the batch had already finished"],
    ["ok", range(ch.map((x) => x.headline.failed), fmtN), "failed requests with a chunked batch"],
    ["acc", ff.length ? "≤ " + Math.ceil(Math.max(...ff.map((x) => x.headline.recovered_s ?? 99))) + " s" : "—", "to recover once the API fails fast"],
  ];
  $("hero-stats").innerHTML = stats.map(([c, v, l]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join("");
}

// ---------- lessons ----------
function renderLessonList() {
  const done = new Set((store.get("pgpl-done") || "").split(",").filter(Boolean).map(Number));
  $("lesson-list").innerHTML = LESSONS.map((l, i) =>
    `<li><button type="button" data-i="${i}" class="${done.has(i) ? "done" : ""}" ${i === state.lesson ? 'aria-current="step"' : ""}>
      <span class="n">${String(i + 1).padStart(2, "0")}</span><span>${l.title}</span></button></li>`).join("");
  $("progress-bar").style.width = `${(100 * done.size) / LESSONS.length}%`;
}
$("lesson-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (b) gotoLesson(Number(b.dataset.i), { scroll: true });
});

function markDone(i) {
  const done = new Set((store.get("pgpl-done") || "").split(",").filter(Boolean).map(Number));
  done.add(i);
  store.set("pgpl-done", [...done].join(","));
}

async function gotoLesson(i, { runId = null, at = null, scroll = false } = {}) {
  state.lesson = Math.max(0, Math.min(LESSONS.length - 1, i));
  const L = LESSONS[state.lesson];
  markDone(state.lesson);
  renderLessonList();
  // The lesson text always reads a recorded run, even while the view follows a live one.
  const lessonRun = await D.load(runId && runId !== "live" ? runId : L.pick(D));
  const id = runId || (liveRun && state.follow ? "live" : lessonRun.id);
  D.run = lessonRun;
  lessonExtra = L.prepare ? await L.prepare(D) : null;
  const body = safeRender(() => L.render(D, lessonExtra));
  const startAt = at !== null ? at : safeRender(() => L.at(D), 0);
  await selectRun(id, { keepT: false });
  const prev = state.lesson > 0 ? `<button class="btn ghost" type="button" data-go="${state.lesson - 1}">← ${LESSONS[state.lesson - 1].title}</button>` : "";
  const next = state.lesson < LESSONS.length - 1 ? `<button class="btn primary" type="button" data-go="${state.lesson + 1}">Next: ${LESSONS[state.lesson + 1].title} →</button>` : "";
  $("lesson").innerHTML = `<p class="eyebrow">Lesson ${state.lesson + 1} of ${LESSONS.length}</p>
    <h2>${L.title}</h2>${body}<div class="lesson-nav">${prev}${next}</div>`;
  if (D.run.id !== "live") setT(startAt);
  renderChips(L.chips);
  drawChart();
  updateURL();
  if (scroll) document.getElementById("course").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
}
$("lesson").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) gotoLesson(Number(b.dataset.go), { scroll: true });
});

function safeRender(fn, fallback = "<p>This lesson needs data that is not in this build.</p>") {
  try { return fn(); } catch (err) { console.warn(err); return fallback; }
}

// ---------- run selection ----------
function runTitle(r) {
  const s = r.stamp;
  return `${r.round} · ${r.rate}/s · ${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)} UTC`;
}
function fillRunSelect() {
  const rounds = [...new Set(D.index.map((r) => r.round))];
  const opts = rounds.map((round) => `<optgroup label="${round}">` +
    D.index.filter((r) => r.round === round).map((r) => `<option value="${r.id}">${runTitle(r)}</option>`).join("") + "</optgroup>");
  if (liveRun) opts.unshift('<option value="live">Live run (streaming)</option>');
  $("run-select").innerHTML = opts.join("");
}
$("run-select").addEventListener("change", async (e) => {
  state.follow = e.target.value === "live";
  await selectRun(e.target.value, { keepT: true });
  drawChart();
  updateURL();
});

async function selectRun(id, { keepT }) {
  const run = await D.load(id);
  D.run = run;
  $("run-select").value = id;
  $("scrub").max = Math.max(1, run.maxT);
  const live = id === "live";
  $("mode-badge").textContent = live ? "LIVE" : "REPLAY";
  $("mode-badge").classList.toggle("live", live);
  $("run-desc").textContent = live
    ? `following your run${run.meta?.round ? ` · ${run.meta.round}` : ""}`
    : `replay of a recorded run on ${run.date} · ${run.round} · ${run.meta.rate} req/s`;
  scene?.setRun(run);
  if (!keepT) setT(0); else setT(Math.min(state.t, run.maxT));
}

// ---------- time ----------
function setT(t) {
  state.t = Math.max(0, Math.min(t, D.run?.maxT ?? 0));
  $("scrub").value = Math.floor(state.t);
  $("clock").textContent = `${Math.floor(state.t)} s`;
  const f = frameAt(D.run, state.t);
  renderHud(f);
  scene?.setFrame(f, state.t);
  drawChart();
}
$("scrub").addEventListener("input", (e) => { state.follow = false; setT(Number(e.target.value)); });
$("speed").addEventListener("change", (e) => { state.speed = Number(e.target.value); });
$("play").addEventListener("click", () => togglePlay());
function togglePlay(force) {
  state.playing = force ?? !state.playing;
  if (state.playing && state.t >= D.run.maxT && D.run.id !== "live") setT(0);
  $("play").textContent = state.playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  if (!state.playing) updateURL();
}
let lastTs = null;
function tick(ts) {
  if (lastTs !== null && state.playing && D.run && D.run.id !== "live") {
    const prev = state.t;
    const next = Math.min(D.run.maxT, state.t + ((ts - lastTs) / 1000) * state.speed);
    setT(next);
    term.onAdvance(prev, next);
    if (next >= D.run.maxT) { togglePlay(false); term.onEnd(); }
  }
  lastTs = ts;
  requestAnimationFrame(tick);
}

// ---------- HUD ----------
function renderHud(f) {
  if (!f) { $("hud").innerHTML = ""; return; }
  let n = 0, ok = 0, p99 = 0;
  for (const o of Object.values(f.ops)) { n += o.n; ok += o.ok; p99 = Math.max(p99, o.p99); }
  const r = n ? (100 * ok) / n : 100;
  const bw = D.run.batch_window;
  const inBatch = bw && f.t >= Math.floor(bw.start_s) && f.t < Math.ceil(bw.end_s);
  const afterBatch = bw && f.t >= Math.ceil(bw.end_s);
  $("hud").innerHTML = `<span>t = ${f.t} s ${inBatch ? '<span class="batchc">· batch running</span>' : afterBatch ? '<span class="m">· batch finished</span>' : ""}</span>
    <span class="big ${r >= 99 ? "okc" : "badc"}">${r.toFixed(1)}% ok</span>
    <span>${fmtN(n)} req this second · p99 ${Math.round(p99)} ms</span>`;
}

// ---------- chart ----------
const SIG = {
  ok: { label: "Requests succeeded (bars)", color: "--ok" },
  p99_order: { label: "Order p99 (ms)", color: "--accent-2", get: (f) => f.ops.order?.p99 ?? null },
  longest_xact_s: { label: "Oldest open transaction (s)", color: "--batch", get: (f) => f.db?.longest_xact_s ?? null },
  pg_lock_wait: { label: "Backends waiting on a lock", color: "--bad", get: (f) => f.db?.pg_lock_wait ?? null },
  pool_acquired: { label: "App pool in use (of 40)", color: "--accent", get: (f) => f.db?.pool_acquired ?? null },
  bouncer_cl_waiting: { label: "Queued in PgBouncer", color: "--shed", get: (f) => f.db?.bouncer_cl_waiting ?? null },
  pool_empty_acquires: { label: "Waits for a pool connection /s", color: "--shed", get: (f) => f.db?.pool_empty_acquires ?? null },
  pg_sessions_started: { label: "New PostgreSQL sessions /s", color: "--accent-2", get: (f) => f.db?.pg_sessions_started ?? null },
};
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawChart() {
  const run = D.run, c = $("chart");
  if (!run) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const maxT = Math.max(1, run.maxT), pad = 4, bw = Math.max(1, (w - 2 * pad) / (maxT + 1));
  const x = (t) => pad + (t / (maxT + 1)) * (w - 2 * pad);
  if (run.batch_window) {
    g.fillStyle = cssVar("--batch") + "26";
    g.fillRect(x(run.batch_window.start_s), 0, x(run.batch_window.end_s) - x(run.batch_window.start_s), h);
  }
  const okC = cssVar("--ok"), badC = cssVar("--bad");
  for (const f of run.frames) {
    let n = 0, ok = 0;
    for (const o of Object.values(f.ops)) { n += o.n; ok += o.ok; }
    if (!n) continue;
    const hOk = (h - 8) * (ok / n);
    g.fillStyle = okC + "55"; g.fillRect(x(f.t), h - hOk, bw, hOk);
    if (ok < n) { g.fillStyle = badC + "cc"; g.fillRect(x(f.t), 0, bw, h - 8 - hOk + 8); }
  }
  const lesson = LESSONS[state.lesson];
  const keys = (lesson?.chart || ["ok"]).filter((k) => k !== "ok");
  const keyHtml = ['<span><i style="background:' + okC + '"></i>succeeded / <i style="background:' + badC + '"></i>failed, per second</span>'];
  for (const k of keys) {
    const s = SIG[k];
    const vals = run.frames.map((f) => [f.t, s.get(f)]).filter(([, v]) => v !== null);
    if (!vals.length) continue;
    const mx = Math.max(1e-9, ...vals.map(([, v]) => v));
    g.strokeStyle = cssVar(s.color); g.lineWidth = 2; g.beginPath();
    vals.forEach(([t, v], i) => { const yy = h - 6 - (h - 14) * (v / mx); i ? g.lineTo(x(t) + bw / 2, yy) : g.moveTo(x(t) + bw / 2, yy); });
    g.stroke();
    keyHtml.push(`<span><i style="background:${cssVar(s.color)}"></i>${s.label} · max ${Math.round(mx * 10) / 10}</span>`);
  }
  if (run.batch_window) keyHtml.push(`<span><i style="background:${cssVar("--batch")}66"></i>batch running</span>`);
  g.fillStyle = cssVar("--faint"); g.font = "10px JetBrains Mono, monospace";
  for (let t = 30; t < maxT; t += 30) g.fillText(`${t}s`, x(t) + 2, h - 1);
  g.strokeStyle = cssVar("--text"); g.lineWidth = 1.5; g.beginPath();
  g.moveTo(x(state.t) + bw / 2, 0); g.lineTo(x(state.t) + bw / 2, h); g.stroke();
  $("chart-key").innerHTML = keyHtml.join("");
}
$("chart").addEventListener("click", (e) => {
  const r = e.target.getBoundingClientRect();
  state.follow = false;
  setT(((e.clientX - r.left) / r.width) * (D.run.maxT + 1));
});
addEventListener("resize", () => { drawChart(); scene?.resize(); });

// ---------- terminal ----------
const out = $("term-out");
function print(html = "", cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.innerHTML = html;
  out.appendChild(div);
  while (out.childNodes.length > 400) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const term = {
  session: false,
  onAdvance(prev, next) {
    if (!this.session) return;
    const run = D.run;
    for (let t = Math.floor(prev) + 1; t <= Math.floor(next); t++) {
      const f = run.byT.get(t);
      if (!f) continue;
      for (const ev of f.events || []) {
        if (ev === "batch_start") print(`<span class="o">[${t}s] batch started: ${esc(run.meta.batch_args.split(" -dsn")[0])}</span>`);
        if (ev === "batch_end") print(`<span class="o">[${t}s] batch committed after ${run.headline.batch_seconds} s</span>`);
      }
      if (t % 10 === 0) {
        let n = 0, ok = 0; const errs = {};
        for (const o of Object.values(f.ops)) { n += o.n; ok += o.ok; for (const [k, v] of Object.entries(o.errors)) errs[k] = (errs[k] || 0) + v; }
        const r = n ? (100 * ok) / n : 100;
        const db = f.db ? ` lock_wait=${f.db.pg_lock_wait} queue=${f.db.bouncer_cl_waiting} pool=${f.db.pool_acquired}/40` : "";
        const e = Object.keys(errs).length ? " " + Object.entries(errs).map(([k, v]) => `${k}:${v}`).join(" ") : "";
        print(`<span class="m">[${String(t).padStart(3)}s]</span> <span class="${r >= 99 ? "g" : "r"}">ok ${r.toFixed(1).padStart(5)}%</span>${db}<span class="r">${e}</span>`);
      }
    }
  },
  onEnd() {
    if (!this.session) return;
    this.session = false;
    const run = D.run, ops = run.summary.ops;
    for (const op of Object.keys(ops).sort()) {
      const s = ops[op];
      const errs = Object.entries(s.errors || {}).map(([k, v]) => `${k}:${v}`).join(" ");
      print(`${op.padEnd(9)} n=${String(s.n).padEnd(6)} ok=${s.ok_ratio.toFixed(4)} p50=${String(s.p50_ms).padEnd(7)} p99=${String(s.p99_ms).padEnd(7)} max=${String(s.max_ms).padEnd(7)} errors=map[${esc(errs)}]`, s.ok_ratio < 0.99 ? "r" : "");
    }
    print(`results: results/${run.scenario}/${run.round}/${run.stamp}`, "c");
    print("(from the recorded summary.json of this run)", "m");
  },
};

const HELP = [
  ["lab rounds batch", "list the rounds of the batch scenario"],
  ["lab run batch &lt;round&gt; [--rate 150]", "replay a recorded run of that round"],
  ["lab report batch", "every recorded run, side by side"],
  ["lab runs", "list recorded runs"],
  ["lab top", "top statements (pg_stat_statements) of the current run"],
  ["lesson &lt;n&gt;", "jump to a lesson"],
  ["clear", "clear the screen"],
];

async function runCommand(raw) {
  const line = raw.trim();
  if (!line) return;
  print(`<span class="c">$</span> ${esc(line)}`);
  const [cmd, ...args] = line.split(/\s+/);
  const a = cmd === "lab" || cmd === "scripts/lab" ? args : [cmd, ...args];
  const opt = (name) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : null; };
  switch (a[0]) {
    case "help": case "?":
      print("Everything here replays recorded files from results/. Commands:", "m");
      HELP.forEach(([c, d]) => print(`  <span class="c">${c.padEnd(34)}</span> <span class="m">${d}</span>`));
      return;
    case "clear": out.innerHTML = ""; return;
    case "lesson": return gotoLesson(Number(a[1]) - 1, { scroll: false });
    case "rounds": {
      const rounds = [...new Set(D.index.filter((r) => r.scenario === (a[1] || "batch")).map((r) => r.round))];
      rounds.forEach((r) => print(r));
      return;
    }
    case "runs":
      D.index.forEach((r) => print(`${r.id.padEnd(40)} <span class="m">${r.rate}/s failed ${r.headline.failed_pct}%</span>`));
      return;
    case "report": {
      print(`<span class="b">${"round".padEnd(16)}${"rate".padStart(6)}${"failed".padStart(10)}${"after batch".padStart(13)}${"recovered".padStart(12)}${"batch".padStart(8)}</span>`);
      for (const r of D.index.filter((x) => x.scenario === (a[1] || "batch"))) {
        const h = r.headline;
        const rec = h.batch_seconds === null ? "-" : h.recovered_s === null ? "never" : h.recovered_s + " s";
        print(`${r.round.padEnd(16)}${String(r.rate).padStart(6)}${(h.failed_pct + "%").padStart(10)}${String(h.failed_after_batch ?? "-").padStart(13)}${rec.padStart(12)}${(h.batch_seconds === null ? "-" : Math.round(h.batch_seconds) + " s").padStart(8)}`, h.failed_pct > 1 ? "r" : "g");
      }
      return;
    }
    case "top": {
      for (const s of (D.run.top_statements || []).slice(0, 8))
        print(`${String(s.calls).padStart(6)} calls ${String(Math.round(s.total_ms)).padStart(7)} ms total  <span class="m">${esc(s.query.slice(0, 90))}</span>`);
      return;
    }
    case "run": {
      const scenario = a[1], round = a[2];
      if (!scenario || !round) { print("usage: lab run batch &lt;round&gt; [--rate 150]", "y"); return; }
      const rate = Number(opt("--rate") || 300);
      const id = D.pick(round, rate, true);
      const r = D.index.find((x) => x.id === id && x.round === round && x.scenario === scenario);
      if (!r) { print(`no recorded run for ${esc(scenario)}/${esc(round)} at ${rate}/s. Try: lab rounds batch`, "y"); return; }
      state.follow = false;
      await selectRun(id, { keepT: false });
      drawChart(); updateURL();
      const m = D.run.meta;
      print(`replaying ${r.id} (recorded ${D.run.date})`, "m");
      print(`sending ${m.rate} req/s for ${m.duration}, mix ${esc(m.mix)}`);
      if (m.batch_args) print(`batch at +${m.batch_at_s}s: ${esc(m.batch_args.split(" -dsn")[0])}`, "o");
      if (m.api_acquire_timeout && m.api_acquire_timeout !== "0") print(`api: acquire timeout ${m.api_acquire_timeout}, min query budget ${m.api_min_query_budget}`, "b");
      term.session = true;
      togglePlay(true);
      return;
    }
    default:
      print(`unknown command: ${esc(line)}. Type <span class="c">help</span>.`, "y");
  }
}
$("term-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("term-input").value;
  $("term-input").value = "";
  runCommand(v);
});
function renderChips(chips) {
  $("chips").innerHTML = (chips || []).map((c) => `<button type="button" class="chip">${c}</button>`).join("");
}
$("chips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  typeCommand(b.textContent);
});
function typeCommand(cmd) {
  const input = $("term-input");
  if (reduceMotion) { runCommand(cmd); return; }
  let i = 0;
  input.value = "";
  const step = () => {
    input.value = cmd.slice(0, ++i);
    if (i < cmd.length) setTimeout(step, 28);
    else setTimeout(() => { input.value = ""; runCommand(cmd); }, 160);
  };
  step();
}

// ---------- deep links ----------
function updateURL() {
  if (!D.run) return;
  const p = new URLSearchParams();
  p.set("lesson", state.lesson + 1);
  if (D.run.id !== "live") { p.set("run", D.run.id); p.set("at", Math.floor(state.t)); }
  if (params.has("live")) p.set("live", "1");
  history.replaceState(null, "", `${location.pathname}?${p}${location.hash}`);
}
$("share").addEventListener("click", async () => {
  updateURL();
  try { await navigator.clipboard.writeText(location.href); toast("Link to this moment copied"); }
  catch { toast(location.href); }
});
function toast(msg) {
  const d = document.createElement("div");
  d.className = "toast"; d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

// ---------- copy buttons on code blocks ----------
document.querySelectorAll(".dev pre").forEach((pre) => {
  const b = document.createElement("button");
  b.className = "copy"; b.type = "button"; b.textContent = "copy";
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(pre.innerText.replace(/^copy$/m, "").trim()); b.textContent = "copied"; }
    catch { b.textContent = "select + copy"; }
    setTimeout(() => (b.textContent = "copy"), 1400);
  });
  pre.appendChild(b);
});

// ---------- live mode ----------
function wantLive() {
  return params.get("live") === "1" || (["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "58090");
}
function startLive() {
  liveRun = prepRun({ id: "live", scenario: "live", round: "live", meta: {}, summary: { ops: {} }, headline: {}, batch_window: null, frames: [], top_statements: [], date: "" });
  const es = new EventSource("/live/events");
  const onMeta = (e) => {
    try {
      const m = JSON.parse(e.data);
      liveRun.meta = { ...liveRun.meta, ...m };
      if (D.run === liveRun) $("run-desc").textContent = `following your run${m.round ? ` · ${m.round}` : ""}`;
      print(`live: ${esc(e.data)}`, "b");
    } catch { /* ignore */ }
  };
  es.addEventListener("meta", onMeta);
  es.addEventListener("run", onMeta);
  es.onopen = () => { $("mode-badge").textContent = "LIVE"; print("connected to /live/events", "g"); };
  es.onerror = () => { $("mode-badge").textContent = "LIVE · reconnecting"; };
  es.onmessage = (e) => {
    let f;
    try { f = JSON.parse(e.data); } catch { return; }
    if (typeof f.t !== "number" || !f.ops) { onMeta(e); return; }
    f.events = f.events || [];
    if (liveRun.frames.length && f.t < liveRun.maxT) { // a new run started
      liveRun.frames = []; liveRun.batch_window = null; liveRun.byT = new Map();
      print("live: new run", "b");
    }
    liveRun.frames.push(f);
    liveRun.byT.set(f.t, f);
    liveRun.maxT = f.t;
    if (f.events.includes("batch_start")) liveRun.batch_window = { start_s: f.t, end_s: f.t };
    if (liveRun.batch_window && !liveRun.frames.some((x) => x.events.includes("batch_end"))) liveRun.batch_window.end_s = f.t;
    for (const ev of f.events) print(`<span class="o">[${f.t}s] ${ev.replace("_", " ")}</span>`);
    if (D.run === liveRun) {
      $("scrub").max = Math.max(1, liveRun.maxT);
      if (state.follow) setT(f.t); else drawChart();
    }
  };
}

// ---------- boot ----------
async function boot() {
  try {
    const idx = await fetch("data/index.json").then((r) => r.json());
    D.index = idx.runs;
  } catch (err) {
    $("hero-lede").textContent = "Could not load the recorded runs (data/index.json).";
    console.error(err);
    return;
  }
  if (wantLive()) startLive();
  renderHero();
  fillRunSelect();
  try { scene = await createScene($("scene"), $("labels"), { reduceMotion }); }
  catch (err) { console.warn("3D disabled:", err.message); scene = null; }
  if (!scene) $("nogl").hidden = false;
  const lesson = Math.max(1, Math.min(LESSONS.length, Number(params.get("lesson")) || 1)) - 1;
  const runId = params.get("run");
  const known = runId && D.index.some((r) => r.id === runId);
  await gotoLesson(lesson, { runId: liveRun ? "live" : known ? runId : null, at: params.has("at") ? Number(params.get("at")) : null });
  print('Welcome. This terminal replays recorded runs. Type <span class="c">help</span>, or click a suggestion below.', "m");
  if (!reduceMotion && !params.has("at") && !liveRun) togglePlay(true);
  requestAnimationFrame(tick);
}
boot();
