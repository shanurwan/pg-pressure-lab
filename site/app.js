// pg-pressure-lab incident console. Static: every number replays recorded
// runs from site/data. Served by `scripts/lab live`, it follows the run in
// progress over /live/events instead.
import { SCENARIOS, SOURCES, SIGNALS } from "./manifest.js";
import { D, fmt, prep, totals, firstSignals, makeCtx, store } from "./data.js";
import { createScene } from "./scene.js";
import { drawStrip } from "./chart.js";
import { createTerminal } from "./terminal.js";
import * as G from "./game.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const params = () => new URLSearchParams(location.search);
const LIVE = params().has("live") || (["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "58090");
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const tickSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const icon = (d, w = 20) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

// ---------------- theme ----------------
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  store.set("pgpl-theme", next);
  if (player.run) paintMetrics(Math.floor(player.t));
});

// ---------------- player ----------------
const player = {
  run: null, t: 0, playing: false, speed: 10, follow: false, fns: [],
  on(fn) { this.fns.push(fn); },
  emit() { const s = Math.floor(this.t); for (const fn of this.fns) fn(s, this.run); },
  async loadRun(id, t = 0) {
    const r = id === "live" ? liveRun : await D.load(id);
    this.setRun(r, t);
    return r;
  },
  setRun(r, t = 0) {
    this.run = r; this.t = Math.max(0, Math.min(t, r?.maxT ?? 0)); this.follow = r?.id === "live"; this.playing = false;
    if (r) prepSeries(r);
    scene?.setRun(r); runLabel(); playBtn(); this.emit();
  },
  seek(t) { this.t = Math.max(0, Math.min(t, this.run?.maxT ?? 0)); this.follow = false; this.emit(); },
  play() { if (!this.run) return; if (this.t >= this.run.maxT) this.t = 0; this.playing = true; playBtn(); },
  pause() { this.playing = false; playBtn(); },
};
let lastTick = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  if (player.playing && player.run && !player.follow) {
    const before = Math.floor(player.t);
    player.t += dt * player.speed;
    if (player.t >= player.run.maxT) { player.t = player.run.maxT; if (player.run.id !== "live") player.pause(); }
    if (Math.floor(player.t) !== before) player.emit();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const playIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const pauseIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
function playBtn() { const b = $("#play"); b.innerHTML = player.playing ? pauseIcon : playIcon; b.setAttribute("aria-label", player.playing ? "Pause" : "Play"); }
$("#play").addEventListener("click", () => (player.playing ? player.pause() : player.play()));
$("#scrub").addEventListener("input", (e) => player.seek(Number(e.target.value)));
$("#speed").addEventListener("change", (e) => setSpeed(Number(e.target.value)));
function setSpeed(n) { player.speed = n; $("#speed").value = String(n); }

function runLabel() {
  const r = player.run;
  $("#run-label").textContent = !r ? "no run loaded" : r.id === "live" ? `live · ${r.scenario || ""} ${r.round || ""}` : `${r.scenario}/${r.round} · ${r.meta?.rate ?? ""} req/s · ${r.stamp}`;
  $("#scrub").max = String(r?.maxT ?? 0);
}

// ---------------- metrics ----------------
const KPIS = [
  { id: "ok", label: "Success", get: (f) => { const t = totals(f); return t.n ? (t.ok / t.n) * 100 : null; }, show: (v) => `${v.toFixed(1)}%`, tone: (v) => (v < 90 ? "bad" : v < 99 ? "warn" : "ok") },
  { id: "p99", label: "p99 latency", get: (f) => { const v = Math.max(0, ...Object.values(f?.ops || {}).map((o) => o.p99 || 0)); return f ? v : null; }, show: fmt.ms, tone: (v) => (v > 1500 ? "bad" : v > 500 ? "warn" : "ok") },
  { id: "pool", label: "pgx pool in use", get: (f) => f?.db?.pool_acquired, show: (v) => `${v}/40`, tone: (v) => (v >= 40 ? "bad" : v >= 30 ? "warn" : "ok"), flag: (v) => (v >= 40 ? "FULL" : "") },
  { id: "queue", label: "PgBouncer queue", get: (f) => f?.db?.bouncer_cl_waiting, show: fmt.n, tone: (v) => (v >= 20 ? "bad" : v > 0 ? "warn" : "ok") },
  { id: "locks", label: "Lock waiters", get: (f) => f?.db?.pg_lock_wait, show: fmt.n, tone: (v) => (v >= 10 ? "bad" : v > 0 ? "warn" : "ok") },
  { id: "xact", label: "Oldest transaction", get: (f) => f?.db?.longest_xact_s, show: (v) => `${Math.round(v)} s`, tone: (v) => (v > 30 ? "bad" : v > 5 ? "warn" : "ok") },
  { id: "sess", label: "New sessions/s", get: (f) => f?.db?.pg_sessions_started, show: fmt.n, tone: (v) => (v > 50 ? "bad" : v > 10 ? "warn" : "ok") },
  { id: "failed", label: "Failed so far", get: null, show: fmt.n, tone: (v) => (v > 0 ? "bad" : "ok") },
];
$("#kpis").innerHTML = KPIS.map((k) => `<div class="kpi ok" data-k="${k.id}"><div class="l"><span>${k.label}</span><span class="flag" hidden></span></div><div class="v">–</div><div class="spark"><canvas aria-hidden="true"></canvas></div></div>`).join("");

function prepSeries(r) {
  if (r.series && r.series.n === r.frames.length) return;
  const s = { n: r.frames.length };
  for (const k of KPIS) if (k.get) s[k.id] = new Map(r.frames.map((f) => [f.t, k.get(f)]));
  let cum = 0; s.failed = new Map();
  for (const f of r.frames) { const t = totals(f); cum += t.n - t.ok; s.failed.set(f.t, cum); }
  r.series = s;
}

function spark(canvas, run, map, t, color) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  let max = 0;
  for (const v of map.values()) if (v != null) max = Math.max(max, v);
  max = max || 1;
  // the canvas covers the whole tile: the job band spans its full height, the
  // line lives in the bottom 24 px
  const LH = 22;
  const X = (s) => (s / Math.max(1, run.maxT)) * W, Y = (v) => H - 3 - (v / max) * LH;
  const w = run.batch_window;
  // a very faint full-height band for the job, and a baseline across the
  // whole run so the x-axis reads as "the run", drawn up to now
  if (w) { c.fillStyle = "rgba(251,146,60,.055)"; c.fillRect(X(w.start_s), 0, Math.max(1, X(Math.min(w.end_s, run.maxT)) - X(w.start_s)), H); }
  c.fillStyle = "rgba(148,163,184,.14)"; c.fillRect(0, H - 2, W, 1);
  canvas.classList.add("drawn");
  c.strokeStyle = color; c.lineWidth = 1.5; c.beginPath();
  let started = false;
  for (const f of run.frames) {
    if (f.t > t) break;
    const v = map.get(f.t);
    if (v == null) { started = false; continue; }
    if (!started) { c.moveTo(X(f.t), Y(v)); started = true; } else c.lineTo(X(f.t), Y(v));
  }
  c.stroke();
  const v = map.get(t);
  if (v != null) { c.fillStyle = color; c.beginPath(); c.arc(X(t), Y(v), 2.4, 0, Math.PI * 2); c.fill(); }
}

function paintMetrics(t) {
  const r = player.run;
  const f = r?.byT.get(t);
  const toneColor = { ok: css("--accent-2"), warn: css("--warn"), bad: css("--bad") };
  for (const k of KPIS) {
    const el = $(`.kpi[data-k="${k.id}"]`);
    const map = r?.series?.[k.id];
    const v = map ? map.get(t) : null;
    const tone = v == null ? "ok" : k.tone(v);
    el.className = `kpi ${tone}`;
    $(".v", el).textContent = v == null ? "–" : k.show(v);
    const fl = $(".flag", el), flag = v != null && k.flag ? k.flag(v) : "";
    fl.hidden = !flag; fl.textContent = flag;
    if (r && map) spark($("canvas", el), r, map, t, toneColor[tone]);
  }
  if (r) drawStrip($("#strip"), r, t);
  $("#scrub").value = String(t);
  // time and job state live in the panel header, so nothing sits on the 3D labels
  const w = r?.batch_window;
  const job = r?.job || "job";
  const state = !r ? "" : !w ? "no job" : t < w.start_s ? `${job} at ${Math.round(w.start_s)} s` : t < w.end_s ? `<span class="jb">${job} running ${Math.round(t - w.start_s)} s</span>` : `${job} done at ${Math.round(w.end_s)} s`;
  $("#clock").innerHTML = r ? `${state} · <b>${t}</b>/${r.maxT} s` : "0 s";
}
new ResizeObserver(() => { if (player.run) paintMetrics(Math.floor(player.t)); }).observe($("#metrics-panel"));

let scene = null;
player.on((t, r) => {
  if (!r) return;
  scene?.setFrame(r.byT.get(t), t);
  paintMetrics(t);
  checkObserve(t, r);
});

$("#expand").addEventListener("click", () => {
  const on = $("#topo").classList.toggle("expanded");
  $("#scrim").hidden = !on;
  $("#expand").setAttribute("aria-label", on ? "Close the expanded 3D view" : "Expand the 3D view");
  scene?.resize();
});

// ---------------- signals and quizzes ----------------
const sigCache = new Map();
function topRate(sc) { return Math.max(...D.runsOf(sc.id).map((r) => r.rate)); }
function primaryRound(sc) {
  const rs = D.runsOf(sc.id);
  if (rs.some((r) => r.round === sc.primary)) return sc.primary;
  return rs.slice().sort((a, b) => b.headline.failed_pct - a.headline.failed_pct)[0]?.round;
}
function bestRun(sc, round) {
  const rs = D.runsOf(sc.id).filter((r) => r.round === round);
  if (!rs.length) return null;
  const rate = Math.max(...rs.map((r) => r.rate));
  const at = rs.filter((r) => r.rate === rate);
  return (at.filter((r) => r.headline.max_sessions_per_s !== null).at(-1) || at.at(-1))?.id;
}
function signalsFor(sc) {
  if (!sigCache.has(sc.id)) {
    sigCache.set(sc.id, (async () => {
      const rate = topRate(sc), prim = primaryRound(sc);
      const ids = D.runsOf(sc.id).filter((r) => r.round === prim && r.rate === rate).map((r) => r.id);
      const runs = await Promise.all(ids.map((id) => D.load(id)));
      return runs.map((r) => {
        const keys = new Set(Object.keys(SIGNALS));
        for (const f of r.frames) if (f.db) for (const k of Object.keys(f.db)) keys.add(k);
        for (const k of ["pg_sessions_abandoned", "pg_total", "bouncer_maxwait_ms"]) keys.delete(k);
        return firstSignals(r, [...keys]);
      }).filter(Boolean);
    })());
  }
  return sigCache.get(sc.id);
}

const quizCache = new Map();
async function quizFor(sc, o, ctx) {
  const key = `${sc.id}:${o.id}`;
  if (quizCache.has(key)) return quizCache.get(key);
  let q = null;
  if (o.quiz === "firstSignal") {
    const sig = await signalsFor(sc);
    const firsts = sig.map((s) => s.signals[0]?.key).filter(Boolean);
    if (firsts.length) {
      const count = {};
      for (const k of firsts) count[k] = (count[k] || 0) + 1;
      const correct = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
      const seen = new Set(sig.flatMap((s) => s.signals.map((x) => x.key)));
      const pref = ["pg_lock_wait", "bouncer_cl_waiting", "pool_empty_acquires", "pg_sessions_started", "pool_acquired", "pg_active", "pg_idle_in_tx", "longest_xact_s"];
      const distract = pref.filter((k) => k !== correct && (seen.has(k) || SIGNALS[k])).slice(0, 3);
      const keys = [correct, ...distract].sort((a, b) => G.signalLabel(a).localeCompare(G.signalLabel(b)));
      const job = sc.id === "batch" ? "batch" : "job";
      const lead = ctx.sigLead(correct, G.signalLabel(correct));
      const lock = correct !== "pg_lock_wait" ? ctx.sigLead("pg_lock_wait", "Lock waits") : null;
      q = {
        q: `The ${job} starts. Which signal rose above its normal range first, in ${firsts.length > 1 ? "most recorded runs" : "the recorded run"}?`,
        options: keys.map(G.signalLabel), answer: keys.indexOf(correct),
        explain: [lead, lock, "That is the one to alert on: it moves while callers are still fine."].filter(Boolean).join(" "),
      };
    }
  } else if (o.quiz === "bestFix") {
    const rate = topRate(sc);
    const fixes = (sc.fixes || []).filter((r) => D.runsOf(sc.id).some((x) => x.round === r && x.rate === rate));
    if (fixes.length > 1) {
      const worst = (r) => Math.max(...D.runsOf(sc.id).filter((x) => x.round === r && x.rate === rate).map((x) => x.headline.failed_pct));
      const ranked = fixes.slice().sort((a, b) => worst(a) - worst(b));
      const zero = fixes.filter((r) => worst(r) === 0);
      const correct = ranked[0];
      const desc = (r) => (sc.rounds?.[r] || "").replace(/^Fix:\s*/, "").split(/(?<=\.)\s/)[0];
      q = {
        q: zero.length === 1 ? "Which fix reached zero failed requests?" : "Which fix had the fewest failed requests?",
        options: fixes.map((r) => `${r}: ${desc(r)}`), answer: fixes.indexOf(correct),
        explain: fixes.map((r) => `${r}: ${ctx.range(r, "failed_pct", fmt.pct) ?? "–"} failed`).join(" · ") + ".",
      };
    }
  } else if (o.q) {
    q = { q: o.q, options: o.options, answer: o.answer, explain: o.explain ? o.explain(ctx) : "" };
  }
  quizCache.set(key, q);
  return q;
}

// ---------------- missions ----------------
let mission = null, ctx = null, quizzes = {};
const missionById = (id) => G.missions().find((s) => s.id === id);

async function openMission(id, { quiet = false, keepRun = false } = {}) {
  const sc = missionById(id);
  if (!sc) { term?.line(`no mission called ${esc(id)}. type missions`, "bad"); return; }
  mission = sc;
  ctx = makeCtx(sc, await signalsFor(sc));
  quizzes = {};
  for (const o of G.objectivesOf(sc)) {
    if (o.type !== "quiz") continue;
    quizzes[o.id] = await quizFor(sc, o, ctx);
    // a question the data can't answer is dropped, so the mission stays finishable
    if (!quizzes[o.id]) G.unavailable.add(`${sc.id}:${o.id}`);
  }
  $("#mission-title").textContent = sc.short;
  document.title = `${sc.short} · pg-pressure-lab`;
  const p = params(); p.set("mission", sc.id); p.delete("scenario");
  if (!keepRun) { p.delete("run"); p.delete("at"); }
  history.replaceState(null, "", `?${p}`);
  renderSidebar(); renderObjectives(); renderXP();
  if (!keepRun && player.run?.id !== "live") {
    const first = G.roundsOf(sc).includes("baseline") ? "baseline" : primaryRound(sc);
    const id0 = bestRun(sc, first);
    if (id0) await player.loadRun(id0, 0);
  }
  if (!quiet) term?.line(`<span class="acc">mission</span> ${esc(sc.short)} <span class="c">· ${G.progress(sc).n}/${G.progress(sc).total} objectives · type</span> <span class="k">briefing</span> <span class="c">or</span> <span class="k">hint</span>`);
  updateChips();
  if (!G.state.visited[sc.id] && G.state.onboarded) { G.state.visited[sc.id] = true; G.save(); openDrawer("briefing"); }
}

function starsHtml(n, total = 3, pop = -1) {
  let s = "";
  for (let i = 0; i < total; i++) s += `<span class="${i < n ? "on" : ""} ${i === pop ? "pop" : ""}">★</span>`;
  return s;
}

function renderSidebar() {
  const ms = G.missions();
  const rec = ms.find((s) => !G.progress(s).done);
  $("#missions").innerHTML = ms.map((s, i) => {
    const p = G.progress(s), st = G.starsOf(s);
    const cls = p.done ? "done" : p.n ? "active" : "";
    const sub = p.done ? "Complete" : p.n ? `${p.n}/${p.total} objectives` : `${s.minutes} min · not started`;
    return `<li><button type="button" class="mission ${cls}" data-id="${s.id}" aria-current="${s.id === mission?.id}">
      <span class="num">${p.done ? tickSvg : i + 1}</span>
      <span><span class="t">${esc(s.short)}</span><span class="s">${sub}</span>${rec && rec.id === s.id && s.id !== mission?.id ? '<span class="rec">Recommended next</span>' : ""}</span>
      <span class="mstars" aria-label="${st} of 3 stars">${starsHtml(st)}</span></button></li>`;
  }).join("");
  for (const b of $$(".mission")) b.addEventListener("click", () => openMission(b.dataset.id));
  $("#mission-select").innerHTML = ms.map((s, i) => `<option value="${s.id}" ${s.id === mission?.id ? "selected" : ""}>${i + 1}. ${esc(s.short)} ${"★".repeat(G.starsOf(s))}</option>`).join("");
  $("#badges").innerHTML = G.BADGES.map((b) => {
    const on = G.state.badges.includes(b.id);
    return `<div class="bdg ${on ? "on" : ""}" tabindex="0" aria-label="${esc(b.name)}: ${on ? "earned" : esc(b.how)}">${icon(b.icon)}<span class="tip"><b>${esc(b.name)}</b>${on ? "Earned." : esc(b.how)}</span></div>`;
  }).join("");
  $("#badge-count").textContent = `${G.state.badges.length}/${G.BADGES.length}`;
}
$("#mission-select").addEventListener("change", (e) => openMission(e.target.value));

let lastStars = {};
function renderObjectives() {
  const sc = mission;
  const obs = G.objectivesOf(sc), nxt = G.nextObjective(sc), p = G.progress(sc), st = G.starsOf(sc);
  $("#obj-title").textContent = sc.title;
  const prev = lastStars[sc.id] ?? st;
  $("#obj-stars").innerHTML = starsHtml(st, 3, st > prev ? st - 1 : -1);
  $("#obj-stars").setAttribute("aria-label", `${st} of 3 stars`);
  lastStars[sc.id] = st;
  $("#obj-ring").style.setProperty("--p", String(p.total ? Math.round((p.n / p.total) * 100) : 0));
  $("#obj-count").textContent = `${p.n}/${p.total}`;
  $("#debrief-btn").classList.toggle("accent", p.done);
  $("#obj-list").innerHTML = obs.map((o) => {
    const done = G.isDone(sc, o), cur = nxt && nxt.id === o.id;
    const qs = G.state.quiz[sc.id]?.[o.id];
    let body = "", kind = "";
    if (o.type === "quiz") {
      kind = "Question";
      const q = quizzes[o.id];
      if (!q) return "";
      const answered = done ? q.answer : -1;
      body = `<span class="q">${esc(q.q)}</span>`;
      if (cur || done) {
        const wrong = new Set(qs?.wrong || []);
        body = `<div class="quiz"><span class="q">${esc(q.q)}</span><div class="opts">${q.options.map((t, i) => `<button type="button" class="opt ${answered === i ? "right" : ""} ${!done && wrong.has(i) ? "wrong-was" : ""}" data-o="${o.id}" data-i="${i}" ${done || wrong.has(i) ? "disabled" : ""}>${esc(t)}</button>`).join("")}</div>${done ? `<div class="explain">${esc(q.explain)}</div>` : qs?.tries ? `<div class="explain try">Not quite. Look at the metrics, or type <code>lab explain diagnose</code>.</div>` : ""}</div>`;
      }
    } else if (o.type === "command") {
      kind = "Command";
      const cmds = o.match.run ? o.match.run.map((r) => `lab run ${sc.id} ${r}`) : [`lab report ${sc.id}`];
      body = `<span class="text">${esc(o.text)}</span>${cmds.map((c) => `<button type="button" class="cmd" data-cmd="${esc(c)}" title="Run in the terminal">$ ${esc(c)}</button>`).join("")}`;
    } else {
      kind = "Observe";
      body = `<span class="text">${esc(o.text)}</span><button type="button" class="cmd" data-cmd="lab run ${sc.id} ${esc(o.observe.round)}">$ lab run ${sc.id} ${esc(o.observe.round)}</button>`;
    }
    const xpv = done ? `+${qs && !qs.first && o.type === "quiz" ? Math.round(o.xp / 2) : o.xp} XP` : `${o.xp} XP`;
    const inner = o.type === "quiz" && (cur || done) ? `<div><span class="kind">${kind}</span></div>` : `<div><span class="kind">${kind}</span>${body}</div>`;
    return `<li class="obj ${done ? "done" : ""} ${cur ? "current" : ""}" data-id="${o.id}"><span class="box">${done ? tickSvg : ""}</span>${inner}<span class="xpv">${xpv}</span>${o.type === "quiz" && (cur || done) ? body : ""}</li>`;
  }).join("");
  for (const b of $$("#obj-list .cmd")) b.addEventListener("click", () => term.exec(b.dataset.cmd));
  for (const b of $$("#obj-list .opt:not(:disabled)")) b.addEventListener("click", () => answer(b.dataset.o, Number(b.dataset.i), b));
  // keep the current objective at the top of the list, with a sliver of the
  // last finished one above it; scroll only the list, never the page
  const list = $("#obj-list"), curEl = $("#obj-list .obj.current");
  if (curEl) requestAnimationFrame(() => {
    const top = list.scrollTop + curEl.getBoundingClientRect().top - list.getBoundingClientRect().top - 14;
    list.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? "auto" : "smooth" });
  });
}

function answer(oid, i, btn) {
  const sc = mission, o = G.objectivesOf(sc).find((x) => x.id === oid), q = quizzes[oid];
  const qs = ((G.state.quiz[sc.id] ||= {})[oid] ||= { tries: 0, first: false });
  if (i === q.answer) {
    qs.first = qs.tries === 0;
    G.save();
    const xp = G.complete(sc, o, qs.first ? o.xp : Math.round(o.xp / 2));
    gained(xp, qs.first ? "Right first time" : "Correct", qs.first ? `+${xp} XP` : `+${xp} XP (half: second try)`);
    // "Root cause" needs the right answer first time; the others just the right answer.
    if (o.badge && (o.badge !== "root-cause" || qs.first)) badge(o.badge);
    if (o.quiz === "firstSignal") badge("early-warning");
    term.line(`<span class="ok">✓</span> <span class="c">${esc(q.explain)}</span>`, "prose");
    afterProgress();
  } else {
    qs.tries++;
    (qs.wrong ||= []).push(i);
    G.save();
    btn.classList.add("wrong"); btn.disabled = true;
    setTimeout(renderObjectives, 450);
  }
}

// ---------------- progress, XP, badges ----------------
function renderXP(bump = false) {
  const r = G.rankOf();
  $("#xp-level").textContent = String(r.level);
  $("#xp-rank").textContent = r.name;
  $("#xp-num").textContent = fmt.n(G.state.xp);
  $("#xp-bar").style.width = `${Math.round(r.pct * 100)}%`;
  $("#xp").title = r.next ? `${fmt.n(G.state.xp)} XP · ${fmt.n(r.next.min - G.state.xp)} to ${r.next.name}` : `${fmt.n(G.state.xp)} XP · top rank`;
  if (bump) { const x = $("#xp"); x.classList.remove("bump"); void x.offsetWidth; x.classList.add("bump"); }
}
function gained(xp, title, sub) {
  if (!xp) return;
  const before = G.rankOf(G.state.xp - xp);
  toast({ icon: `+${xp}`, title, sub });
  renderXP(true);
  const after = G.rankOf();
  if (after.level > before.level) toast({ icon: `L${after.level}`, title: `Promoted: ${after.name}`, sub: "New rank unlocked", kind: "badge" });
}
function badge(id) {
  const b = G.award(id);
  if (!b) return;
  toast({ svg: icon(b.icon, 18), title: `Badge: ${b.name}`, sub: b.how, kind: "badge" });
  renderSidebar();
}
function afterProgress() {
  const sc = mission;
  renderObjectives(); renderSidebar(); updateChips();
  if (G.state.used.report && G.state.used.top) badge("analyst");
  const p = G.progress(sc);
  if (p.done && !G.state.done[sc.id]?.__celebrated) {
    G.state.done[sc.id].__celebrated = true; G.save();
    badge("mission");
    if (G.starsOf(sc) === 3) badge("three-stars");
    toast({ icon: "★", title: "Mission complete", sub: "The debrief is unlocked", kind: "badge" });
    setTimeout(() => openDrawer("debrief"), 900);
  } else if (p.done && G.starsOf(sc) === 3) badge("three-stars");
}

function toast({ icon: ic = "", svg = "", title, sub = "", kind = "" }) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="ti">${svg || esc(ic)}</span><div><b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
  $("#toasts").appendChild(el);
  const all = $$("#toasts .toast:not(.out)");
  if (all.length > 3) all[0].remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, 3200);
}

// terminal events → objectives
function onEvent(ev) {
  const sc = missionById(ev.scenario) || mission;
  if (ev.type === "run") {
    G.state.runs++;
    const tried = new Set(G.state.tried[ev.scenario] || []); tried.add(ev.round); G.state.tried[ev.scenario] = [...tried];
    G.save();
    if (sc && sc.id !== mission?.id) openMission(sc.id, { quiet: true, keepRun: true });
    badge("on-call");
    if (sc && ev.round === sc.primary) badge("first-page");
    const p = params(); p.set("run", ev.run.id); p.delete("at"); history.replaceState(null, "", `?${p}`);
    $("#term-sub").textContent = `replaying ${ev.scenario}/${ev.round}`;
  }
  if (ev.type === "runEnd") {
    $("#term-sub").textContent = "replay mode";
    const h = ev.run.headline;
    if (sc && (sc.fixes || []).includes(ev.round) && h.failed === 0 && h.batch_seconds != null) badge("zero");
  }
  if (ev.type === "report") G.state.used.report = true;
  if (ev.type === "top") G.state.used.top = true;
  G.save();
  if (!sc) return;
  for (const o of G.objectivesOf(sc)) {
    if (o.type !== "command" || G.isDone(sc, o)) continue;
    const hit = (ev.type === "run" && o.match.run?.includes(ev.round)) || (ev.type === "report" && o.match.report);
    if (hit) { const xp = G.complete(sc, o); gained(xp, o.text.split(":")[0], `+${xp} XP`); term.line(`<span class="xp-line">✓ objective · ${esc(o.text)} · +${xp} XP</span>`); }
  }
  if (sc.id === mission?.id) afterProgress();
}

function checkObserve(t, r) {
  const sc = mission;
  if (!sc || r.scenario !== sc.id) return;
  for (const o of G.objectivesOf(sc)) {
    if (o.type !== "observe" || G.isDone(sc, o) || r.round !== o.observe.round) continue;
    const w = r.batch_window;
    if (!w || t < w.end_s + (o.observe.afterJobEnd || 0)) continue;
    if (o.observe.needFailures) {
      let bad = 0;
      for (let k = Math.ceil(w.end_s); k <= t; k++) { const tt = totals(r.byT.get(k)); bad += tt.n - tt.ok; }
      if (!bad) continue;
    }
    const xp = G.complete(sc, o);
    gained(xp, "You saw it", `+${xp} XP · the job ended, the errors didn't`);
    term.line(`<span class="xp-line">✓ objective · ${esc(o.text)} · +${xp} XP</span>`);
    afterProgress();
  }
}

// ---------------- hints and suggestions ----------------
function hint() {
  const sc = mission, o = G.nextObjective(sc);
  if (!o) return { text: `Mission complete. Open the <span class="k">debrief</span>, or pick another mission: <span class="k">missions</span>.`, cmd: "debrief" };
  if (o.type === "command") {
    const cmd = o.match.run ? `lab run ${sc.id} ${o.match.run[0]}` : `lab report ${sc.id}`;
    return { text: `${esc(o.text)}. Press Enter to run it.`, cmd };
  }
  if (o.type === "observe") return { text: `Replay the ${esc(o.observe.round)} round and let it play past the end of the job. Watch the Success tile.`, cmd: `lab run ${sc.id} ${o.observe.round}` };
  return { text: "Answer the question in the Objectives panel. Stuck? The guide explains it.", cmd: "lab explain diagnose" };
}
$("#hint-btn").addEventListener("click", () => term.exec("hint"));

function updateChips() {
  if (!mission || !term) return;
  const sc = mission, o = G.nextObjective(sc);
  const list = [];
  if (o?.type === "command") (o.match.run || []).slice(0, 3).forEach((r, i) => list.push({ cmd: `lab run ${sc.id} ${r}`, primary: i === 0 }));
  if (o?.type === "command" && o.match.report) list.push({ cmd: `lab report ${sc.id}`, primary: true });
  if (o?.type === "observe") list.push({ cmd: `lab run ${sc.id} ${o.observe.round}`, primary: true });
  if (o?.type === "quiz") list.push({ cmd: "lab explain diagnose", primary: true });
  if (!o) list.push({ cmd: "debrief", primary: true });
  list.push({ cmd: `lab rounds ${sc.id}` }, { cmd: "lab top" }, { cmd: "help" });
  term.setChips(list);
}

// ---------------- the guide, as text ----------------
const strip = (html) => html.replace(/<\/?div[^>]*>/g, "").replace(/\s+\n/g, "\n");
function explain(step) {
  const sc = mission;
  const o = G.nextObjective(sc);
  const auto = !o ? "alert" : ["baseline", "outage"].includes(o.id) ? "reproduce" : o.type === "quiz" && o.quiz === "bestFix" ? "fix" : ["fix", "best"].includes(o.id) ? "fix" : o.id === "report" ? "alert" : "diagnose";
  const s = ["incident", "reproduce", "diagnose", "fix", "alert"].includes(step) ? step : auto;
  const html = sc[s] ? sc[s](ctx) : "";
  return `<p><span class="acc">${s}</span></p>${strip(html) || "<p>No guide text for this step yet.</p>"}`;
}

function status() {
  const r = G.rankOf();
  const rows = G.missions().map((s) => { const p = G.progress(s); return `  ${s.short.padEnd(34)} ${String(p.n).padStart(2)}/${p.total}  ${"★".repeat(G.starsOf(s)).padEnd(3, "·")}`; });
  return [`<span class="acc">${esc(r.name)}</span> · level ${r.level} · ${fmt.n(G.state.xp)} XP${r.next ? ` · ${fmt.n(r.next.min - G.state.xp)} XP to ${esc(r.next.name)}` : ""}`, ...rows.map(esc), `  badges ${G.state.badges.length}/${G.BADGES.length}`].join("\n");
}

// ---------------- drawers ----------------
let drawerReturn = null;
function openDrawer(kind) {
  const sc = mission;
  const body = $("#drawer-body");
  let kicker = "", title = "";
  if (kind === "briefing") {
    kicker = `Briefing · ${sc.minutes} min`; title = sc.title;
    const rounds = G.roundsOf(sc);
    body.innerHTML = `<div class="callout accent"><p><strong>Your mission:</strong> reproduce it, find the signal that moved first, and ship a fix with a measured result. Every number here comes from recorded runs.</p></div>
      ${sc.incident(ctx)}
      <h3>The public record</h3><div class="src-cards">${sc.sources.map((k) => srcCard(SOURCES[k])).join("")}</div>
      ${sc.reading?.length ? `<h3>Background reading</h3><div class="src-cards">${sc.reading.map((k) => srcCard(SOURCES[k])).join("")}</div>` : ""}
      <h3>What you'll learn</h3><ul>${(sc.practise || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <h3>Rounds you can replay</h3><div class="kv">${rounds.map((r) => `<code>${esc(r)}</code><span>${esc(sc.rounds?.[r] || "")}</span>`).join("")}</div>
      <p style="margin-top:18px"><button class="btn accent" type="button" data-cmd="${esc(hint().cmd || "help")}">Start: ${esc(hint().cmd || "help")}</button></p>`;
  } else if (kind === "debrief") {
    kicker = "Debrief"; title = sc.title;
    const p = G.progress(sc);
    if (!p.done) {
      body.innerHTML = `<div class="locked"><p><strong>Locked.</strong> Finish the objectives to unlock the debrief (${p.n}/${p.total} done).</p><p style="margin:0">Next: ${hint().text}</p></div>`;
    } else {
      const st = G.starsOf(sc);
      const why = [st < 2 ? "answer every question right first time" : "", st < 3 ? "replay every round" : ""].filter(Boolean).join(" and ");
      body.innerHTML = `<div class="done-hero"><span class="big">${starsHtml(st)}</span><div><strong>Mission complete.</strong><br><span class="faint">${st === 3 ? "All three stars." : `For more stars: ${why}.`}</span></div></div>
        <h3>Why it happened</h3>${sc.diagnose(ctx)}
        <h3>The fixes</h3>${sc.fix(ctx)}${roundsTable(sc)}
        <h3>What to alert on</h3>${sc.alert(ctx)}
        ${nextMissionBtn(sc)}`;
    }
  } else if (kind === "about") {
    kicker = "About"; title = "An incident console for PostgreSQL";
    body.innerHTML = `<p>Each mission recreates a class of PostgreSQL failure that has been <strong>documented in public postmortems</strong>, on a real stack: a Go API (pgx pool of 40) → PgBouncer in transaction mode (20 server connections) → PostgreSQL 17 with 200,000 accounts and 20 million orders, under open-loop load.</p>
      <p>Nothing here runs against a database: the terminal, metrics and 3D view replay runs recorded second by second. To run them yourself, see <button class="linkish" type="button" data-drawer="run" style="color:var(--accent-2)">Run it yourself</button>.</p>
      <h3>How to play</h3><ul><li>Pick a mission, read the briefing, then work down the objectives.</li><li>Commands, observations and questions earn XP; stars come from finishing, answering first time, and replaying every round.</li><li><code>Tab</code> completes commands, <code>↑</code>/<code>↓</code> recall history, <code>/</code> focuses the terminal.</li></ul>
      <h3>Scope</h3><p>Every run was recorded on a single host. Numbers compare configurations on the same machine; they are not a benchmark of PostgreSQL or of any company's systems. Incident summaries paraphrase the linked public postmortems.</p>
      <h3>Progress</h3><p>XP, stars and badges are kept in this browser only.</p><p><button class="btn danger" type="button" id="reset-progress">Reset progress</button></p>
      <p class="faint">Code and raw results: <a href="https://github.com/shanurwan/pg-pressure-lab" target="_blank" rel="noopener">github.com/shanurwan/pg-pressure-lab</a> · Apache-2.0</p>`;
  } else if (kind === "run") {
    kicker = "Developers"; title = "Run it yourself, live";
    body.innerHTML = devHtml();
  }
  $("#drawer-kicker").textContent = kicker;
  $("#drawer-title").textContent = title;
  drawerReturn = document.activeElement;
  $("#drawer").hidden = false; $("#scrim").hidden = false;
  body.scrollTop = 0;
  $("#drawer-close").focus();
  for (const b of $$("[data-cmd]", body)) b.addEventListener("click", () => { closeDrawer(); term.exec(b.dataset.cmd); });
  for (const tr of $$("tr[data-round]", body)) tr.addEventListener("click", () => { closeDrawer(); term.exec(`lab run ${sc.id} ${tr.dataset.round}`); });
  for (const b of $$("[data-drawer]", body)) b.addEventListener("click", () => openDrawer(b.dataset.drawer));
  for (const b of $$("[data-mission]", body)) b.addEventListener("click", () => { closeDrawer(); openMission(b.dataset.mission); });
  $("#reset-progress")?.addEventListener("click", () => { G.reset(); lastStars = {}; closeDrawer(); renderSidebar(); renderObjectives(); renderXP(); updateChips(); toast({ icon: "↺", title: "Progress reset", sub: "Start again from mission 1" }); });
  wireCopy(body);
}
function closeDrawer() {
  $("#drawer").hidden = true;
  if (!$("#topo").classList.contains("expanded")) $("#scrim").hidden = true;
  (drawerReturn && drawerReturn !== document.body ? drawerReturn : $("#term-input")).focus({ preventScroll: true });
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", () => {
  if (!$("#drawer").hidden) closeDrawer();
  else if ($("#topo").classList.contains("expanded")) $("#expand").click();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#coach").hidden) endCoach();
    else if (!$("#drawer").hidden) closeDrawer();
    else if ($("#topo").classList.contains("expanded")) $("#expand").click();
  }
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) { e.preventDefault(); term.focus(); }
});
$("#obj-toggle").addEventListener("click", () => {
  const on = $("#objectives").classList.toggle("expanded");
  $("#obj-toggle").setAttribute("aria-expanded", String(on));
  $("#obj-toggle").textContent = on ? "Show less" : "Show all";
});
$("#briefing-btn").addEventListener("click", () => openDrawer("briefing"));
$("#debrief-btn").addEventListener("click", () => openDrawer("debrief"));
$("#help-btn").addEventListener("click", () => openDrawer("about"));
for (const b of $$(".side-foot [data-drawer]")) b.addEventListener("click", () => openDrawer(b.dataset.drawer));

const srcCard = (s) => `<a class="src" href="${s.url}" target="_blank" rel="noopener"><span class="mono">${esc(s.org[0])}</span><span><span class="t">${esc(s.org)} · ${esc(s.title)}</span><span class="d">${esc(s.date)}. ${esc(s.summary)}</span><span class="u">${esc(s.url.replace(/^https?:\/\//, ""))} ↗</span></span></a>`;
function roundsTable(sc) {
  const rate = topRate(sc);
  const rs = D.runsOf(sc.id).filter((r) => r.rate === rate);
  const order = [...Object.keys(sc.rounds || {}), ...rs.map((r) => r.round)].filter((v, i, a) => a.indexOf(v) === i && rs.some((r) => r.round === v));
  const rec = (round) => {
    const xs = rs.filter((r) => r.round === round);
    if (xs.every((r) => r.headline.batch_seconds == null)) return "–";
    const ok = xs.map((r) => r.headline.recovered_s).filter((v) => v !== null), never = xs.length - ok.length;
    if (!ok.length) return '<span class="v-bad">not within the run</span>';
    const lo = Math.min(...ok), hi = Math.max(...ok);
    return `${lo === hi ? fmt.s(lo) : `${lo}–${hi} s`}${never ? ` <span class="v-bad">(${never} never)</span>` : ""}`;
  };
  return `<div class="tablewrap"><table class="data"><thead><tr><th>Round</th><th class="n">Failed</th><th class="n">After the job</th><th>Recovered</th></tr></thead><tbody>${order.map((round) => {
    const hi = Math.max(...rs.filter((r) => r.round === round).map((r) => r.headline.failed_pct));
    return `<tr data-round="${esc(round)}" title="Replay ${esc(round)}"><td><strong>${esc(round)}</strong> <span class="faint">· ${ctx.count(round)} ${ctx.count(round) === 1 ? "run" : "runs"}</span></td><td class="n ${hi > 1 ? "v-bad" : "v-ok"}">${ctx.range(round, "failed_pct", fmt.pct) ?? "–"}</td><td class="n">${ctx.range(round, "failed_after_batch", fmt.n) ?? "–"}</td><td>${rec(round)}</td></tr>`;
  }).join("")}</tbody></table></div><p class="faint" style="font-size:12.5px">At ${rate} req/s. Ranges cover every recorded run of a round. Click a row to replay it.</p>`;
}
function nextMissionBtn(sc) {
  const ms = G.missions();
  const nxt = ms.find((s) => s.id !== sc.id && !G.progress(s).done);
  return nxt ? `<p style="margin-top:20px"><button class="btn accent" type="button" data-mission="${nxt.id}">Next mission: ${esc(nxt.short)} →</button></p>` : `<p style="margin-top:20px" class="faint">More missions are being recorded. Replay any round to chase the remaining stars.</p>`;
}
function devHtml() {
  const code = (s) => `<div style="position:relative"><button class="btn small copy" type="button" style="position:absolute;right:8px;top:8px">Copy</button><pre class="code">${s}</pre></div>`;
  return `<p>Everything in the console replays files in <code>results/</code>. Run the lab on your own machine and the same console switches to <strong>live mode</strong>, following your run second by second.</p>
    <h3>1 · Start the lab</h3><p>Docker with Compose v2, about 5 GB of free memory and 6 GB of disk.</p>${code(`git clone https://github.com/shanurwan/pg-pressure-lab
cd pg-pressure-lab
scripts/lab up
scripts/lab seed   <span class="c"># 200k accounts, 20M orders</span>`)}
    <h3>2 · Open live mode</h3>${code(`scripts/lab live
<span class="c"># open http://localhost:58090</span>`)}
    <h3>3 · Break it, then fix it</h3>${code(`scripts/lab rounds batch
scripts/lab run batch naive
scripts/lab run batch chunked
go run ./cmd/report -scenario batch`)}
    <h3>Ask an assistant (MCP)</h3><p>The lab ships an MCP server: Claude or any MCP client can compare rounds, zoom into the seconds around a failure and ask which signal moved first. With <code>-allow-run</code> it can run a drill on your lab.</p>${code(`claude mcp add pg-pressure-lab -- \\
  go run ./cmd/mcp -repo "$PWD"`)}
    <h3>One frame per second</h3><p>Replay files and the live stream share one format.</p>${code(`{ "t": 42,
  "ops": { "order": { "n": 75, "ok": 75, "p50": 14.9, "p99": 210.0, "errors": {} } },
  "db":  { "pg_lock_wait": 0, "longest_xact_s": 12.0, "bouncer_cl_waiting": 0,
           "pool_acquired": 4, "pg_sessions_started": 0 },
  "events": ["batch_start"] }`)}`;
}
function wireCopy(root) {
  for (const b of $$(".copy", root)) b.addEventListener("click", async () => {
    const txt = b.nextElementSibling.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; } catch { b.textContent = "Select and copy"; }
    setTimeout(() => (b.textContent = "Copy"), 1400);
  });
}

// ---------------- onboarding ----------------
const COACH = [
  { sel: () => (matchMedia("(max-width: 900px)").matches ? ".mobilebar" : "#sidebar"), title: "Missions", text: "Each mission recreates a PostgreSQL failure documented in a real public postmortem. Start with the overnight batch." },
  { sel: () => "#objectives", title: "Objectives", text: "Work down the checklist. Commands, observations and questions earn XP and stars; every answer comes from the recorded runs." },
  { sel: () => "#term-panel", title: "The terminal drives everything", text: "Type a command, or tap a suggestion under the prompt. The metrics and the 3D view replay the run second by second." },
];
let coachI = 0;
function showCoach() {
  const step = COACH[coachI];
  const el = $(step.sel());
  $("#coach").hidden = false;
  const r = el.getBoundingClientRect(), pad = 6;
  Object.assign($("#coach-hole").style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  $("#coach-step").textContent = `Step ${coachI + 1} of ${COACH.length}`;
  $("#coach-title").textContent = step.title;
  $("#coach-text").textContent = step.text;
  $("#coach-next").textContent = coachI === COACH.length - 1 ? "Start" : "Next";
  const card = $("#coach-card"), cw = 320, ch = card.offsetHeight || 170, vw = innerWidth, vh = innerHeight;
  let left = r.right + 16, top = r.top;
  if (left + cw > vw - 12) { left = Math.max(12, Math.min(vw - cw - 12, r.left)); top = r.bottom + 14; }
  if (top + ch > vh - 12) top = Math.max(12, r.top - ch - 14);
  Object.assign(card.style, { left: `${left}px`, top: `${Math.max(12, top)}px` });
  $("#coach-next").focus();
}
function endCoach() {
  $("#coach").hidden = true;
  G.state.onboarded = true; G.save();
  if (mission && !G.state.visited[mission.id]) { G.state.visited[mission.id] = true; G.save(); openDrawer("briefing"); }
  else term.focus();
}
$("#coach-next").addEventListener("click", () => { if (++coachI >= COACH.length) endCoach(); else showCoach(); });
$("#coach-skip").addEventListener("click", endCoach);
addEventListener("resize", () => { if (!$("#coach").hidden) showCoach(); });

// ---------------- mobile tabs ----------------
for (const b of $$(".mtabs button")) b.addEventListener("click", () => {
  $("#work").dataset.pane = b.dataset.pane;
  for (const x of $$(".mtabs button")) x.setAttribute("aria-selected", String(x === b));
  requestAnimationFrame(() => { scene?.resize(); if (player.run) paintMetrics(Math.floor(player.t)); });
});

// ---------------- live mode ----------------
let liveRun = null;
function startLive() {
  $("#live-badge").hidden = false;
  $("#term-sub").textContent = "live · following your run";
  const es = new EventSource("/live/events");
  const newRun = (m) => {
    liveRun = prep({ id: "live", scenario: m.scenario || m.meta?.scenario || "", round: m.round || m.meta?.round || "", meta: m.meta || {}, frames: [], batch_window: null, job: "", headline: {}, summary: null, stamp: "live" });
    player.setRun(liveRun, 0); player.follow = true; player.playing = true;
    term.line(`<span class="bad">●</span> live run: ${esc(liveRun.scenario)} ${esc(liveRun.round)} <span class="c">· following your lab</span>`);
  };
  es.addEventListener("run", (e) => { try { newRun(JSON.parse(e.data)); } catch { /* ignore */ } });
  es.addEventListener("frame", (e) => {
    let f; try { f = JSON.parse(e.data); } catch { return; }
    if (!liveRun || (liveRun.frames.length && f.t < liveRun.maxT)) newRun({});
    liveRun.frames.push(f); liveRun.byT.set(f.t, f); liveRun.maxT = f.t;
    for (const ev of f.events || []) {
      if (ev.endsWith("_start")) { liveRun.job = ev.slice(0, -6); liveRun.batch_window = { start_s: f.t, end_s: f.t + 0.5 }; liveRun.open = true; }
      if (ev.endsWith("_end") && liveRun.batch_window) { liveRun.batch_window.end_s = f.t; liveRun.open = false; }
    }
    if (liveRun.open && liveRun.batch_window) liveRun.batch_window.end_s = f.t + 0.5;
    liveRun.series = null; prepSeries(liveRun);
    if (player.run === liveRun && player.follow) { player.t = f.t; runLabel(); player.emit(); }
  });
  es.onerror = () => { $("#term-sub").textContent = "live stream unavailable · start it with scripts/lab live"; };
}

// ---------------- boot ----------------
let term = null;
(async () => {
  try { await D.init(); } catch (e) {
    $("#obj-title").textContent = "Couldn't load the recorded runs";
    $("#obj-list").innerHTML = `<li class="obj"><span></span><span class="text">${esc(e.message)}</span></li>`;
    return;
  }
  renderXP();
  term = createTerminal($("#term-panel"), { player, mission: () => mission, openMission: (id) => openMission(id), drawer: openDrawer, hint, explain, onEvent, setSpeed, status });
  const noGL = (on) => { $("#nogl").hidden = !on; $("#topo").classList.toggle("nogl-on", on); };
  createScene($("#scene"), $("#labels"), { reduceMotion, onLost: noGL }).then((s) => {
    scene = s;
    if (!s) noGL(true);
    else if (player.run) { s.setRun(player.run); s.setFrame(player.run.byT.get(Math.floor(player.t)), Math.floor(player.t)); }
  });
  const ms = G.missions();
  if (!ms.length) { $("#obj-title").textContent = "No recorded runs yet"; return; }
  const p = params();
  const want = p.get("mission") || p.get("scenario");
  const runId = p.get("run"), at = Number(p.get("at") || 0);
  const first = (want && missionById(want)) || ms.find((s) => !G.progress(s).done) || ms[0];
  await openMission(first.id, { quiet: true, keepRun: !!runId });
  if (runId && D.index.some((r) => r.id === runId)) {
    await player.loadRun(runId, at);
    const ps = params(); ps.set("run", runId); if (at) ps.set("at", String(at)); history.replaceState(null, "", `?${ps}`);
  }
  if (LIVE) startLive();
  term.line(`<span class="acc">mission</span> ${esc(first.short)} <span class="c">· ${G.progress(first).n}/${G.progress(first).total} objectives done · the suggestions below run the next step</span>`);
  updateChips();
  if (!G.state.onboarded && !runId) { coachI = 0; setTimeout(showCoach, 350); }
  else term.focus();
})();
