// pg-pressure-lab interactive replays. Static: replays recorded runs from
// site/data, or (served by `scripts/lab live`) follows the run in progress
// over /live/events. Views: home, a scenario (?scenario=), interview practice
// (?view=practice).
import { SCENARIOS, SOURCES, STEPS, SIGNALS } from "./manifest.js";
import { D, fmt, prep, totals, firstSignals, makeCtx, liveScenarios, store } from "./data.js";
import { createScene } from "./scene.js";
import { createChart, drawStrip } from "./chart.js";
import { createTerminal } from "./terminal.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const params = () => new URLSearchParams(location.search);
const LIVE = params().has("live") || (["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "58090");

// ---------------- chrome ----------------
$("#theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("pgpl-theme", next);
  chart?.draw();
});
$("#menu").addEventListener("click", () => {
  const open = $("#nav-links").classList.toggle("open");
  $("#menu").setAttribute("aria-expanded", String(open));
});
fetch("https://api.github.com/repos/shanurwan/pg-pressure-lab").then((r) => (r.ok ? r.json() : null)).then((j) => {
  if (j && typeof j.stargazers_count === "number" && j.stargazers_count > 0) { const s = $("#stars"); s.textContent = `★ ${j.stargazers_count}`; s.hidden = false; }
}).catch(() => {});

// ---------------- player ----------------
const player = {
  run: null, t: 0, playing: false, speed: 10, follow: false, fns: [],
  on(fn) { this.fns.push(fn); },
  emit() { const s = Math.floor(this.t); for (const fn of this.fns) fn(s, this.run); },
  async loadRun(id, t) {
    const r = id === "live" ? liveRun : await D.load(id);
    this.setRun(r, t);
    return r;
  },
  setRun(r, t = 0) {
    this.run = r; this.t = Math.max(0, Math.min(t, r?.maxT ?? 0)); this.follow = r?.id === "live";
    scene?.setRun(r); chart?.setRun(r); syncRunSelect(); updateMode(); this.emit();
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

// ---------------- workspace ----------------
const ws = $("#workspace-tpl").content.firstElementChild.cloneNode(true);
let scene = null, chart = null, term = null;
const playIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const pauseIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
function playBtn() { const b = $("#ws-play", ws); b.innerHTML = player.playing ? pauseIcon : playIcon; b.setAttribute("aria-label", player.playing ? "Pause" : "Play"); }

function setTab(name) {
  for (const b of $$(".tabs button", ws)) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of $$(".pane", ws)) p.hidden = p.dataset.pane !== name;
  if (name === "timeline") chart?.draw();
  if (name === "3d") scene?.resize();
}
for (const b of $$(".tabs button", ws)) b.addEventListener("click", () => setTab(b.dataset.tab));
$("#ws-play", ws).addEventListener("click", () => (player.playing ? player.pause() : player.play()));
$("#ws-range", ws).addEventListener("input", (e) => player.seek(Number(e.target.value)));
$("#ws-speed", ws).addEventListener("change", (e) => (player.speed = Number(e.target.value)));
$("#ws-run", ws).addEventListener("change", async (e) => {
  const id = e.target.value;
  await player.loadRun(id, player.run?.batch_window ? Math.max(0, player.run.batch_window.start_s - 3) : 0);
  const p = params(); if (id !== "live") { p.set("run", id); history.replaceState(null, "", `?${p}`); }
});

let runScope = "batch";
function syncRunSelect() {
  const sel = $("#ws-run", ws);
  const list = D.index.filter((r) => r.scenario === (player.run?.scenario || runScope));
  const opts = list.map((r) => `<option value="${r.id}">${esc(r.round)} · ${r.rate}/s · ${r.stamp.slice(9, 11)}:${r.stamp.slice(11, 13)} UTC${r.headline.failed_pct ? ` · ${fmt.pct(r.headline.failed_pct)} failed` : ""}</option>`);
  if (liveRun) opts.unshift(`<option value="live">LIVE · ${esc(liveRun.scenario || "")} ${esc(liveRun.round || "")}</option>`);
  sel.innerHTML = opts.join("");
  if (player.run) sel.value = player.run.id;
}
function updateMode() {
  const r = player.run;
  $("#ws-badge", ws).textContent = r?.id === "live" ? "LIVE" : "REPLAY";
  $("#ws-badge", ws).classList.toggle("live", r?.id === "live");
  $("#ws-mode", ws).textContent = r ? (r.id === "live" ? `${r.scenario || ""} · ${r.round || ""} · following your run` : `${r.date} · ${r.scenario}/${r.round} · ${r.meta?.rate ?? ""} req/s`) : "";
  const range = $("#ws-range", ws); range.max = String(r?.maxT ?? 0);
}

player.on((t, r) => {
  if (!r) return;
  const f = r.byT.get(t);
  scene?.setFrame(f, t);
  chart?.setT(t);
  drawStrip($("#ws-strip", ws), r, t);
  $("#ws-range", ws).value = String(t);
  $("#ws-time", ws).textContent = `${t} / ${r.maxT} s`;
  const tt = totals(f);
  const okp = tt.n ? (tt.ok / tt.n) * 100 : 100;
  const p99 = Math.max(0, ...Object.values(f?.ops || {}).map((o) => o.p99 || 0));
  const w = r.batch_window;
  const state = w ? (t < w.start_s ? `${r.job || "job"} starts at ${Math.round(w.start_s)} s` : t < w.end_s ? `<span class="job">${r.job || "job"} running · ${Math.round(t - w.start_s)} s</span>` : `${r.job || "job"} finished at ${Math.round(w.end_s)} s`) : "no job";
  $("#ws-hud", ws).innerHTML = `t = ${t} s · ${state}<div class="big ${okp < 99 ? "bad" : ""}">${okp.toFixed(1)}% ok</div>${tt.n} req this second · p99 ${fmt.ms(p99)}`;
});

async function initWorkspace() {
  chart = createChart($("#ws-chart", ws), $("#ws-keys", ws), $("#ws-readout", ws));
  new ResizeObserver(() => { if (player.run) drawStrip($("#ws-strip", ws), player.run, Math.floor(player.t)); }).observe($("#ws-strip", ws));
  term = createTerminal($("#ws-term", ws), { player, onOpenScenario: (id) => go(`?scenario=${encodeURIComponent(id)}`) });
  // mount before creating the scene so the canvas has a size
  document.body.appendChild(ws); ws.style.display = "none";
  createScene($("#ws-canvas", ws), $("#ws-labels", ws), {
    reduceMotion, onLost: (lost) => { $("#ws-nogl", ws).hidden = !lost; },
  }).then((s) => {
    scene = s;
    if (!s) $("#ws-nogl", ws).hidden = false;
    else if (player.run) { s.setRun(player.run); s.setFrame(player.run.byT.get(Math.floor(player.t)), Math.floor(player.t)); }
  });
}
function mountWorkspace(slot) { if (!slot) return; slot.appendChild(ws); ws.style.display = ""; scene?.resize(); chart?.draw(); }

// ---------------- live mode ----------------
let liveRun = null;
function startLive() {
  const es = new EventSource("/live/events");
  const newRun = (meta) => {
    liveRun = prep({ id: "live", scenario: meta.scenario || meta.meta?.scenario || "", round: meta.round || meta.meta?.round || "", meta: meta.meta || {}, frames: [], batch_window: null, job: "", headline: {}, summary: null, date: "live" });
    player.setRun(liveRun, 0); player.follow = true; player.playing = true;
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
    if (player.run === liveRun) { chart?.setRun(liveRun); if (player.follow) { player.t = f.t; player.emit(); } }
    updateMode();
  });
  es.onerror = () => { $("#ws-mode", ws).textContent = "live stream unavailable — start it with scripts/lab live"; };
}

// ---------------- signals ----------------
const sigCache = new Map();
async function signalsFor(sc) {
  if (sigCache.has(sc.id)) return sigCache.get(sc.id);
  const p = (async () => {
    const rs = D.runsOf(sc.id);
    const rate = Math.max(...rs.map((r) => r.rate));
    const prim = primaryRound(sc);
    const ids = rs.filter((r) => r.round === prim && r.rate === rate).map((r) => r.id);
    const runs = await Promise.all(ids.map((id) => D.load(id)));
    return runs.map((r) => {
      const keys = new Set(Object.keys(SIGNALS));
      for (const f of r.frames) if (f.db) for (const k of Object.keys(f.db)) keys.add(k);
      keys.delete("pg_sessions_abandoned"); keys.delete("pg_total"); keys.delete("bouncer_maxwait_ms");
      return firstSignals(r, [...keys]);
    }).filter(Boolean);
  })();
  sigCache.set(sc.id, p);
  return p;
}
function primaryRound(sc) {
  const rs = D.runsOf(sc.id);
  if (rs.some((r) => r.round === sc.primary)) return sc.primary;
  return rs.slice().sort((a, b) => b.headline.failed_pct - a.headline.failed_pct)[0]?.round;
}
function bestRun(sc, round) {
  const rs = D.runsOf(sc.id).filter((r) => r.round === round);
  const rate = Math.max(...rs.map((r) => r.rate));
  const at = rs.filter((r) => r.rate === rate);
  return (at.filter((r) => r.headline.max_sessions_per_s !== null).at(-1) || at.at(-1))?.id;
}

// ---------------- router ----------------
function go(href) { history.pushState(null, "", href); render(); }
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname) return;
  if (url.search === location.search && url.hash) return; // in-page anchor
  e.preventDefault();
  history.pushState(null, "", url.search + url.hash || "./");
  render().then(() => { if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); else window.scrollTo(0, 0); });
  $("#nav-links").classList.remove("open");
});
addEventListener("popstate", () => render());

function setNav(name) {
  for (const a of $$("[data-nav]")) {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

async function render() {
  const p = params();
  const view = $("#view");
  if (p.get("view") === "practice") { setNav("practice"); await renderPractice(view, p); }
  else if (p.get("scenario")) { setNav(""); await renderScenario(view, p); }
  else { setNav(""); await renderHome(view); }
  document.title = p.get("scenario") ? `${SCENARIOS.find((s) => s.id === p.get("scenario"))?.short || "Scenario"} · pg-pressure-lab` : p.get("view") === "practice" ? "Interview practice · pg-pressure-lab" : "pg-pressure-lab · Real PostgreSQL incidents, replayed";
}

// ---------------- home ----------------
async function renderHome(view) {
  const scs = liveScenarios();
  const batch = SCENARIOS.find((s) => s.id === "batch");
  const ctx = makeCtx(batch, await signalsFor(batch).catch(() => []));
  const totalReq = D.index.reduce((a, r) => a + r.headline.requests, 0);
  const kpis = [
    [ctx.range("naive", "failed_pct", fmt.pct), "bad", "of all requests failed when the end-of-day job ran as one transaction"],
    [ctx.range("naive", "failed_after_batch", fmt.n), "bad", "requests failed after the job had already finished"],
    [ctx.range("chunked", "failed_pct", fmt.pct), "ok", "failed once the job used short transactions"],
    [ctx.range("naive-cancelreq", "failed_pct", fmt.pct), "", "failed with the job unchanged and one pgx setting changed"],
  ].filter((k) => k[0]);
  view.innerHTML = `
  <section class="hero">
    <div class="wrap hero-grid">
      <div>
        <span class="eyebrow">Interactive replays · PostgreSQL · PgBouncer · Go</span>
        <h1>Real PostgreSQL incidents, <span class="hl">replayed second by second.</span></h1>
        <p class="lede">Each scenario starts from a public postmortem, reproduces the failure on a real Go + PgBouncer + PostgreSQL stack under load, and measures every fix. Watch which signal moved first, then practise explaining it.</p>
        <div class="ctas">
          <a class="btn primary" href="?scenario=batch">Start with the batch outage <span aria-hidden="true">→</span></a>
          <a class="btn" href="?view=practice">Interview practice</a>
        </div>
        <div class="proof">
          <span><i class="dot ok"></i>${D.index.length} recorded runs</span>
          <span><i class="dot wait"></i>${fmt.n(totalReq)} requests replayed</span>
          <span><i class="dot job"></i>${scs.length} ${scs.length === 1 ? "scenario" : "scenarios"}</span>
          <span><i class="dot busy"></i>open source</span>
        </div>
      </div>
      <div class="ws-slot"></div>
    </div>
    <div class="wrap"><div class="kpis" style="margin-top:40px">${kpis.map(([v, c, l]) => `<div class="kpi"><div class="v ${c}">${v}</div><div class="l">${l}</div></div>`).join("")}</div></div>
  </section>

  <section class="block alt" id="scenarios">
    <div class="wrap">
      <div class="section-head"><div><span class="eyebrow">Scenarios</span><h2 style="margin-top:10px">Failures that happened to real teams</h2><p>Every scenario links the public incident it is based on. The lab reproduces the class of failure on its own stack; it does not claim to know anyone's internals.</p></div></div>
      <div class="cards ${scs.length === 1 ? "one" : ""}">${scs.map(card).join("")}</div>
    </div>
  </section>

  <section class="block">
    <div class="wrap">
      <div class="section-head"><div><span class="eyebrow">How it works</span><h2 style="margin-top:10px">Learn it the way you'd debug it</h2></div></div>
      <div class="features">
        <div class="feature"><div class="ic">01</div><h3>Reproduce</h3><p>Open-loop load keeps arriving whether or not the API keeps up, the way customers do. Every second of every run is recorded: callers, the app's pool, PgBouncer and PostgreSQL.</p></div>
        <div class="feature"><div class="ic">02</div><h3>Diagnose and fix</h3><p>Replay a run in 3D, on a timeline or from a terminal. Each fix is one change from the failing round, measured at least twice.</p></div>
        <div class="feature"><div class="ic">03</div><h3>Practise</h3><p>Interview questions for every scenario, with a timer, model answers built from the measured numbers, and spaced repetition so you remember them.</p></div>
      </div>
    </div>
  </section>

  ${devSection()}`;
  mountWorkspace($(".ws-slot", view));
  runScope = "batch";
  const id = params().get("run") || bestRun(batch, "naive");
  if (!player.run || player.run.scenario !== "batch" || params().get("run")) {
    const r = await player.loadRun(id, Number(params().get("at")) || 0);
    const w = r.batch_window;
    if (!params().get("at") && w) player.seek(Math.max(0, w.start_s - 4));
  }
  setTab("3d");
  term?.setChips(["lab run batch naive", "lab run batch chunked", "lab report batch", "help"]);
  if (!reduceMotion && !player.playing) { player.speed = 8; $("#ws-speed", ws).value = "10"; player.play(); }
  wireCopy(view);
}

function card(sc) {
  const ctx = makeCtx(sc, null);
  const prim = primaryRound(sc);
  const f = ctx.range(prim, "failed_pct", fmt.pct);
  const done = (store.get("pgpl-steps", {})[sc.id] || []).length;
  return `<article class="card link">
    <div class="top"><span class="chip accent">${esc(sc.short)}</span>${f ? `<span class="chip bad">${f} failed</span>` : ""}<span class="chip">${sc.minutes} min</span></div>
    <h3><a href="?scenario=${sc.id}">${esc(sc.title)}</a></h3>
    <p class="desc">${esc(sc.summary)}</p>
    <ul>${sc.practise.slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <div class="sources">${sc.sources.map((k) => SOURCES[k]).map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.org)} · ${esc(s.date)} <span aria-hidden="true">↗</span></a><p class="src-sum">${esc(s.title)}</p>`).join("")}</div>
    <div class="foot"><span>${D.runsOf(sc.id).length} recorded runs</span><span class="progress"><span class="ring" style="--p:${Math.round((done / STEPS.length) * 100)}"></span>${done}/${STEPS.length}</span></div>
  </article>`;
}

// ---------------- scenario ----------------
async function renderScenario(view, p) {
  const sc = SCENARIOS.find((s) => s.id === p.get("scenario"));
  if (!sc || !D.runsOf(sc.id).length || !sc.ready) {
    view.innerHTML = `<div class="wrap" style="padding:80px 0"><h1>Scenario not found</h1><p class="muted">It may not have recorded runs yet. <a href="./#scenarios">See all scenarios</a>.</p></div>`;
    return;
  }
  const stepId = STEPS.some((s) => s.id === p.get("step")) ? p.get("step") : "incident";
  const sig = await signalsFor(sc).catch(() => []);
  const ctx = makeCtx(sc, sig);
  const doneAll = store.get("pgpl-steps", {});
  const done = new Set(doneAll[sc.id] || []);
  done.add(stepId); doneAll[sc.id] = [...done]; store.set("pgpl-steps", doneAll);
  const idx = STEPS.findIndex((s) => s.id === stepId);
  const prev = STEPS[idx - 1], next = STEPS[idx + 1];
  const prim = primaryRound(sc);

  view.innerHTML = `
  <div class="wrap">
    <div class="crumbs"><a href="./#scenarios">Scenarios</a><span>/</span><span>${esc(sc.short)}</span></div>
    <div class="sc-head">
      <span class="eyebrow">${esc(sc.short)}</span>
      <h1>${esc(sc.title)}</h1>
      <p class="lede">${esc(sc.summary)}</p>
      <div class="meta"><span class="chip">${sc.minutes} min</span><span class="chip">${D.runsOf(sc.id).length} recorded runs</span><span class="chip">${sc.sources.length} public ${sc.sources.length === 1 ? "incident" : "incidents"}</span>${ctx.range(prim, "failed_pct", fmt.pct) ? `<span class="chip bad">${ctx.range(prim, "failed_pct", fmt.pct)} failed in ${esc(prim)}</span>` : ""}</div>
    </div>
    <div class="sc-grid">
      <nav class="rail" aria-label="Steps">${STEPS.map((s, i) => `<a href="?scenario=${sc.id}&step=${s.id}" ${s.id === stepId ? 'aria-current="step"' : ""} class="${done.has(s.id) && s.id !== stepId ? "done" : ""}"><span class="n">${done.has(s.id) && s.id !== stepId ? "✓" : i + 1}</span>${s.label}</a>`).join("")}</nav>
      <article class="step-body">
        <span class="eyebrow kicker">Step ${idx + 1} of ${STEPS.length}</span>
        <h2>${STEPS[idx].label}</h2>
        ${stepHtml(sc, stepId, ctx)}
        <div class="step-nav">${prev ? `<a class="btn" href="?scenario=${sc.id}&step=${prev.id}">← ${prev.label}</a>` : "<span></span>"}${next ? `<a class="btn primary" href="?scenario=${sc.id}&step=${next.id}">${next.label} →</a>` : `<a class="btn primary" href="?view=practice&scenario=${sc.id}">Practise this scenario →</a>`}</div>
      </article>
      <div class="sc-work"><div class="ws-slot"></div></div>
    </div>
  </div>`;
  mountWorkspace($(".ws-slot", view));
  runScope = sc.id;

  // drive the workspace for this step
  const want = p.get("run") || (stepId === "fix" ? bestRun(sc, sc.fixes.find((f) => D.runsOf(sc.id).some((r) => r.round === f)) || prim) : bestRun(sc, prim));
  if (!player.run || player.run.id !== want) await player.loadRun(want, 0);
  const w = player.run.batch_window;
  const at = Number(p.get("at"));
  if (p.has("at")) player.seek(at);
  else if (stepId === "reproduce" && w) player.seek(Math.max(0, w.start_s - 5));
  else if (stepId === "diagnose" && w) player.seek(Math.min(player.run.maxT, Math.ceil(w.end_s) + 5));
  else if (w && player.t === 0) player.seek(Math.max(0, w.start_s - 3));
  setTab(stepId === "drill" ? "terminal" : ["diagnose", "alert", "fix"].includes(stepId) ? "timeline" : "3d");
  const rounds = [...new Set(D.runsOf(sc.id).map((r) => r.round))];
  term?.setChips([`lab run ${sc.id} ${prim}`, ...sc.fixes.filter((f) => rounds.includes(f)).slice(0, 2).map((f) => `lab run ${sc.id} ${f}`), `lab report ${sc.id}`]);
  if (stepId === "reproduce" && !reduceMotion) player.play();

  for (const tr of $$("tr[data-run]", view)) tr.addEventListener("click", async () => {
    $$("tr[data-run]", view).forEach((x) => x.classList.toggle("sel", x === tr));
    await player.loadRun(tr.dataset.run, 0);
    const bw = player.run.batch_window; if (bw) player.seek(Math.max(0, bw.start_s - 3));
    setTab("timeline");
  });
  wirePracticeInline(view, sc, ctx);
}

function stepHtml(sc, step, ctx) {
  switch (step) {
    case "incident": return `${sc.incident(ctx)}
      <h3>The public record</h3><div class="src-cards">${sc.sources.map((k) => srcCard(SOURCES[k])).join("")}</div>
      ${sc.reading.length ? `<h3>Background reading</h3><div class="src-cards">${sc.reading.map((k) => srcCard(SOURCES[k])).join("")}</div>` : ""}
      <h3>What you'll practise</h3><ul>${sc.practise.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    case "reproduce": return sc.reproduce(ctx) + roundsNote(sc);
    case "diagnose": return sc.diagnose(ctx) + statementsTable(sc);
    case "fix": return sc.fix(ctx) + roundsTable(sc, ctx);
    case "alert": return sc.alert(ctx);
    case "drill": return drillInline(sc);
    default: return "";
  }
}
const srcCard = (s) => `<a class="src" href="${s.url}" target="_blank" rel="noopener"><span class="mono">${esc(s.org[0])}</span><span><span class="t">${esc(s.org)} · ${esc(s.title)}</span><span class="d">${esc(s.date)}. ${esc(s.summary)}</span><span class="u">${esc(s.url.replace(/^https?:\/\//, ""))} ↗</span></span></a>`;
function roundsNote(sc) {
  const r = primaryRound(sc);
  return `<div class="callout accent"><p><strong>Round <code>${esc(r)}</code>:</strong> ${esc(sc.rounds[r] || "")}</p><p class="faint" style="font-size:13px;margin:0">Replay of a recorded run. Switch runs from the menu under the viewport, or type <code>lab run ${esc(sc.id)} ${esc(r)}</code> in the Terminal tab.</p></div>`;
}
function statementsTable(sc) {
  const id = bestRun(sc, primaryRound(sc));
  const idx = D.index.find((x) => x.id === id);
  return `<h3>Where the database spent its time</h3><div id="stmts" data-run="${id}"><p class="faint">Loading pg_stat_statements for ${esc(idx?.stamp || "")}…</p></div>`;
}
function roundsTable(sc, ctx) {
  const rs = D.runsOf(sc.id);
  const rate = ctx.rate;
  const order = [...Object.keys(sc.rounds), ...new Set(rs.map((r) => r.round))].filter((v, i, a) => a.indexOf(v) === i && rs.some((r) => r.round === v && r.rate === rate));
  const rec = (round) => {
    const xs = rs.filter((r) => r.round === round && r.rate === rate).map((r) => r.headline.recovered_s);
    if (!xs.some((v) => v !== null)) return xs.length && rs.find((r) => r.round === round)?.headline.batch_seconds ? '<span class="v-bad">not within the run</span>' : "–";
    const never = xs.filter((v) => v === null).length;
    const ok = xs.filter((v) => v !== null);
    return `${ok.length === 1 || Math.min(...ok) === Math.max(...ok) ? fmt.s(ok[0]) : `${fmt.s(Math.min(...ok)).replace(" s", "")}–${fmt.s(Math.max(...ok))}`}${never ? ` <span class="v-bad">(${never} never)</span>` : ""}`;
  };
  return `<h3>All rounds at ${rate} req/s</h3><div class="tablewrap"><table class="data"><thead><tr><th>Round</th><th class="n">Failed</th><th class="n">After the job</th><th>Recovered</th></tr></thead><tbody>${order.map((round) => {
    const f = ctx.range(round, "failed_pct", fmt.pct);
    const hiF = Math.max(...rs.filter((r) => r.round === round && r.rate === rate).map((r) => r.headline.failed_pct));
    return `<tr data-run="${bestRun(sc, round)}"><td><strong>${esc(round)}</strong> <span class="faint">· ${ctx.count(round)} ${ctx.count(round) === 1 ? "run" : "runs"}</span></td><td class="n ${hiF > 1 ? "v-bad" : "v-ok"}">${f ?? "–"}</td><td class="n">${ctx.range(round, "failed_after_batch", fmt.n) ?? "–"}</td><td>${rec(round)}</td></tr>`;
  }).join("")}</tbody></table></div><p class="faint" style="font-size:13px">Ranges cover every recorded run of a round; round descriptions are in the Terminal (<code>lab rounds ${esc(sc.id)}</code>). Click a row to replay it.</p>`;
}

// ---------------- interview practice ----------------
const SRS_KEY = "pgpl-srs";
const qid = (sc, i) => `${sc.id}:${i}`;
function srs() { return store.get(SRS_KEY, {}); }
function progressOf(sc) {
  const s = srs(); const n = sc.interview.length; if (!n) return 0;
  return sc.interview.filter((_, i) => s[qid(sc, i)] && s[qid(sc, i)].last !== "again").length / n;
}
function nextQuestion(sc) {
  const s = srs();
  return sc.interview.map((_, i) => ({ i, due: s[qid(sc, i)]?.due ?? 0 })).sort((a, b) => a.due - b.due || a.i - b.i)[0]?.i ?? 0;
}
function drillInline(sc) {
  if (!sc.interview.length) return "<p>No questions yet for this scenario.</p>";
  return `<p>The question an interviewer is most likely to ask about this scenario. Answer it in your own words before you look.</p><div id="inline-q"></div><p style="margin-top:16px"><a class="btn" href="?view=practice&scenario=${sc.id}">All ${sc.interview.length} questions, with spaced repetition →</a></p>`;
}
function wirePracticeInline(view, sc, ctx) {
  const slot = $("#inline-q", view);
  if (slot) mountQuestion(slot, sc, ctx, nextQuestion(sc), { inline: true });
  const st = $("#stmts", view);
  if (st) D.load(st.dataset.run).then((r) => {
    const rows = (r.top_statements || []).slice(0, 6);
    st.innerHTML = rows.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Statement</th><th class="n">Calls</th><th class="n">Total</th><th class="n">Max</th></tr></thead><tbody>${rows.map((s) => `<tr><td><code style="font-size:12px;white-space:normal">${esc(s.query.slice(0, 110))}${s.query.length > 110 ? "…" : ""}</code></td><td class="n">${fmt.n(s.calls)}</td><td class="n">${fmt.ms(s.total_ms)}</td><td class="n">${fmt.ms(s.max_ms)}</td></tr>`).join("")}</tbody></table></div><p class="faint" style="font-size:13px">From pg_stat_statements for run ${esc(r.stamp)}.</p>` : "<p class='faint'>No statements recorded for this run.</p>";
  });
}

let timerHandle = null;
function mountQuestion(slot, sc, ctx, i, { inline = false } = {}) {
  const q = sc.interview[i];
  const draftKey = `pgpl-draft-${qid(sc, i)}`;
  const limit = 150;
  slot.innerHTML = `<div class="qcard">
    <div class="qh"><div class="row"><span class="chip accent">${esc(sc.short)} · Q${i + 1} of ${sc.interview.length}</span><span class="timer" id="timer"><span class="bar"><i></i></span><span class="tv">2:30</span></span></div>
      <p class="q">${esc(q.q)}</p></div>
    <div class="qb">
      <label class="sr" for="ans">Your answer</label>
      <textarea id="ans" placeholder="Answer out loud or type it: what you'd look at first, how you'd stop the bleeding, the root cause, and what you'd change.">${esc(store.get(draftKey, ""))}</textarea>
      <div class="actions"><button class="btn primary" id="reveal" type="button">Reveal model answer</button>${inline ? "" : '<button class="btn ghost" id="skip" type="button">Skip</button>'}<span class="faint" style="font-size:13px;margin-left:auto">Your draft is saved in this browser.</span></div>
      <div id="model" hidden></div>
    </div></div>`;
  const ta = $("#ans", slot);
  ta.addEventListener("input", () => store.set(draftKey, ta.value));
  clearInterval(timerHandle);
  let left = limit; const tv = $(".tv", slot), bar = $(".bar i", slot), tm = $("#timer", slot);
  const draw = () => { const m = Math.floor(Math.abs(left) / 60), s = String(Math.abs(left) % 60).padStart(2, "0"); tv.textContent = left >= 0 ? `${m}:${s}` : `+${m}:${s} over`; bar.style.width = `${Math.min(100, ((limit - left) / limit) * 100)}%`; tm.classList.toggle("over", left < 0); };
  draw(); timerHandle = setInterval(() => { left--; draw(); if (!slot.isConnected) clearInterval(timerHandle); }, 1000);
  $("#reveal", slot).addEventListener("click", () => {
    clearInterval(timerHandle);
    const a = q.a(ctx);
    const part = (k, label, dot) => `<div class="part"><h4><i class="dot ${dot}"></i>${label}</h4><ul>${(a[k] || []).map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
    const m = $("#model", slot);
    m.innerHTML = `<div class="answer">${part("detect", "Detect", "wait")}${part("mitigate", "Mitigate", "shed")}${part("root", "Root cause", "bad")}${part("prevent", "Prevent", "ok")}</div>
      ${q.followups?.length ? `<div class="followups"><h4>Likely follow-ups</h4><ul>${q.followups.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      <div class="grade"><span class="muted" style="font-size:14px">How did you do?</span><button class="btn sm" data-g="again" type="button">Again</button><button class="btn sm" data-g="good" type="button">Good</button><button class="btn sm" data-g="easy" type="button">Easy</button><span class="faint" id="graded" style="font-size:13px"></span></div>`;
    m.hidden = false;
    $("#reveal", slot).hidden = true;
    for (const b of $$("[data-g]", m)) b.addEventListener("click", () => {
      const s = srs(); const cur = s[qid(sc, i)] || { interval: 0, reps: 0 };
      const g = b.dataset.g; const day = 86400000;
      cur.interval = g === "again" ? 0 : g === "good" ? Math.max(1, cur.interval * 2 || 1) : Math.max(3, cur.interval * 3 || 3);
      cur.due = Date.now() + (g === "again" ? 60000 : cur.interval * day); cur.reps++; cur.last = g;
      s[qid(sc, i)] = cur; store.set(SRS_KEY, s);
      $("#graded", m).textContent = g === "again" ? "We'll ask again in a minute." : `Next review in ${cur.interval} day${cur.interval === 1 ? "" : "s"}.`;
      if (!inline) setTimeout(() => go(`?view=practice&scenario=${sc.id}`), 700);
      updateRings();
    });
  });
  $("#skip", slot)?.addEventListener("click", () => {
    const n = (i + 1) % sc.interview.length; mountQuestion(slot, sc, ctx, n);
  });
}
function updateRings() { for (const el of $$("[data-ring]")) { const sc = SCENARIOS.find((s) => s.id === el.dataset.ring); el.style.setProperty("--p", Math.round(progressOf(sc) * 100)); } }

async function renderPractice(view, p) {
  const scs = liveScenarios().filter((s) => s.interview.length);
  const sc = scs.find((s) => s.id === p.get("scenario")) || scs[0];
  if (!sc) { view.innerHTML = `<div class="wrap" style="padding:80px 0"><h1>No questions yet</h1></div>`; return; }
  const ctx = makeCtx(sc, await signalsFor(sc).catch(() => []));
  const star = sc.star(ctx);
  view.innerHTML = `<div class="wrap">
    <div class="sc-head" style="padding-top:36px">
      <span class="eyebrow">Interview practice</span>
      <h1>Explain it like you've debugged it</h1>
      <p class="lede">Questions an SRE or database interview loop asks about these failures. Answer against the clock, compare with a model answer built from the measured runs, and grade yourself: questions you miss come back sooner.</p>
    </div>
    <div class="prac-grid">
      <aside class="prac-side">${scs.map((s) => `<button class="prac-sc" type="button" data-sc="${s.id}" aria-pressed="${s.id === sc.id}"><span class="ring" data-ring="${s.id}" style="--p:${Math.round(progressOf(s) * 100)}"></span><span><strong style="font-size:14px">${esc(s.short)}</strong><small>${s.interview.length} questions</small></span></button>`).join("")}
        <a class="btn" href="?scenario=${sc.id}" style="justify-content:center">Open the ${esc(sc.short.toLowerCase())} replay</a>
      </aside>
      <div>
        <div id="q-slot"></div>
        <div class="card star"><h3>Your story for this scenario <span class="chip" style="margin-left:6px">STAR</span></h3><p class="faint" style="font-size:13px;margin:6px 0 0">Adapt it, and say plainly that this was a lab you built and measured, not a production incident you were paged for.</p>
          <dl>${Object.entries(star).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>
      </div>
    </div></div>`;
  for (const b of $$(".prac-sc", view)) b.addEventListener("click", () => go(`?view=practice&scenario=${b.dataset.sc}`));
  const qi = p.has("q") ? Math.min(sc.interview.length - 1, Math.max(0, Number(p.get("q")) - 1)) : nextQuestion(sc);
  mountQuestion($("#q-slot", view), sc, ctx, qi);
}

// ---------------- developers ----------------
function devSection() {
  const code = (s) => `<div style="position:relative"><button class="copy" type="button">Copy</button><pre class="code">${s}</pre></div>`;
  return `<section class="block alt" id="run"><div class="wrap">
    <div class="section-head"><div><span class="eyebrow">Run it yourself</span><h2 style="margin-top:10px">Replay mode here, live mode on your machine</h2><p>Everything on this site replays files in <code>results/</code>. Run the lab and the same viewport switches to <strong>live</strong>, following your run second by second.</p></div></div>
    <div class="dev-grid">
      <div class="dev-card"><span class="n">1</span><h3>Start the lab</h3><p>Docker with Compose v2, about 5 GB of free memory and 6 GB of disk.</p>${code(`git clone https://github.com/shanurwan/pg-pressure-lab
cd pg-pressure-lab
scripts/lab up
scripts/lab seed   <span class="c"># 200k accounts, 20M orders</span>`)}</div>
      <div class="dev-card"><span class="n">2</span><h3>Open live mode</h3><p>This site, served by the lab, streaming your run over Server-Sent Events.</p>${code(`scripts/lab live
<span class="c"># open http://localhost:58090</span>`)}</div>
      <div class="dev-card"><span class="n">3</span><h3>Break it, then fix it</h3><p>Each run writes per-second results under <code>results/</code>.</p>${code(`scripts/lab rounds batch
scripts/lab run batch naive
scripts/lab run batch chunked
go run ./cmd/report -scenario batch`)}</div>
    </div>
    <div class="dev-grid" style="margin-top:16px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <div class="dev-card"><span class="n">AI</span><h3>Ask an assistant about the runs (MCP)</h3><p>The lab ships an MCP server. Claude or any MCP client can compare rounds, zoom into the seconds around a failure, and ask which signal moved first; with <code>-allow-run</code> it can run a drill on your lab.</p>${code(`claude mcp add pg-pressure-lab -- \\
  go run ./cmd/mcp -repo "$PWD"`)}<p class="faint" style="font-size:13px">Tools: <code>list_rounds</code> <code>list_runs</code> <code>get_timeline</code> <code>first_signals</code> <code>run_drill</code></p></div>
      <div class="dev-card"><span class="n">{ }</span><h3>One frame per second</h3><p>Replay files and the live stream share one format.</p>${code(`{ "t": 42,
  "ops": { "order": { "n": 75, "ok": 75,
           "p50": 14.9, "p99": 210.0, "errors": {} } },
  "db":  { "pg_lock_wait": 0, "longest_xact_s": 12.0,
           "bouncer_cl_waiting": 0, "pool_acquired": 4,
           "pg_sessions_started": 0, ... },
  "events": ["batch_start"] }`)}</div>
    </div>
  </div></section>`;
}
function wireCopy(root) {
  for (const b of $$(".copy", root)) b.addEventListener("click", async () => {
    const txt = b.nextElementSibling.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; } catch { b.textContent = "Select and copy"; }
    setTimeout(() => (b.textContent = "Copy"), 1400);
  });
}

// ---------------- boot ----------------
(async () => {
  try {
    await D.init();
  } catch (e) {
    $("#view").innerHTML = `<div class="wrap" style="padding:80px 0"><h1>Couldn't load the recorded runs</h1><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  await initWorkspace();
  if (LIVE) startLive();
  await render();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
})();
