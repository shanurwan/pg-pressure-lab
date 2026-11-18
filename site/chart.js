// Timeline chart (dark viewport) and the player's scrub strip. Bars: each
// second's requests split into succeeded / refused fast / failed. Lines: the
// signals, each scaled to its own maximum (the readout gives real values).
import { totals } from "./data.js";
import { SIGNALS } from "./manifest.js";

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// Signal lines get their own hues: never the semantic ones (ok, failed,
// refused fast, job), so a line can't be mistaken for an outcome.
const LINE_COLORS = ["#f472b6", "#a78bfa", "#38bdf8", "#e2e8f0", "#a3e635"];

export function defaultSeries(run) {
  const have = (k) => run.frames.some((f) => f.db && f.db[k] != null && f.db[k] > 0);
  const pref = ["longest_xact_s", "bouncer_cl_waiting", "pg_sessions_started", "pg_lock_wait", "pool_empty_acquires"];
  const extra = Object.keys(run.frames.find((f) => f.db)?.db || {}).filter((k) => !SIGNALS[k] && !k.startsWith("pg_sessions_abandoned"));
  return [...pref, ...extra].filter(have).slice(0, 4);
}

export function createChart(canvas, keysEl, readout) {
  let run = null, t = 0, series = [], hover = null;
  const ctx = canvas.getContext("2d");
  const pad = { l: 44, r: 12, t: 12, b: 26 };

  function setRun(r) { run = r; series = r ? defaultSeries(r) : []; legend(); draw(); }
  function setT(v) { t = v; draw(); }
  function legend() {
    if (!keysEl) return;
    const lines = series.map((k, i) => `<span><i style="background:${color(i)}"></i>${SIGNALS[k]?.label || k.replace(/_/g, " ")}</span>`).join("");
    keysEl.innerHTML = `<span><i style="background:${css("--vp-ok")}"></i>succeeded</span><span><i style="background:${css("--vp-shed")}"></i>refused fast</span><span><i style="background:${css("--vp-bad")}"></i>failed</span>${lines}<span><i style="background:${css("--vp-job")};opacity:.35;height:8px"></i>job running</span>`;
  }
  const color = (i) => { const c = LINE_COLORS[i % LINE_COLORS.length]; return c.startsWith("--") ? css(c) : c; };

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!run) return;
    const x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b;
    const maxT = Math.max(1, run.maxT);
    const X = (s) => x0 + (s / maxT) * (x1 - x0);
    const Y = (fr) => y1 - fr * (y1 - y0);
    ctx.font = "11px JetBrains Mono, monospace";
    // grid + axes
    ctx.strokeStyle = "rgba(143,154,179,.16)"; ctx.fillStyle = css("--vp-muted"); ctx.lineWidth = 1;
    for (const fr of [0, 0.5, 1]) {
      ctx.beginPath(); ctx.moveTo(x0, Y(fr) + 0.5); ctx.lineTo(x1, Y(fr) + 0.5); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(`${Math.round(fr * 100)}%`, x0 - 6, Y(fr));
    }
    const step = maxT > 120 ? 30 : maxT > 60 ? 15 : 10;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let s = 0; s <= maxT; s += step) ctx.fillText(`${s}s`, X(s), y1 + 7);
    // job window
    const w = run.batch_window;
    if (w) {
      ctx.fillStyle = "rgba(251,146,60,.13)";
      ctx.fillRect(X(w.start_s), y0, Math.max(1, X(Math.min(w.end_s, maxT)) - X(w.start_s)), y1 - y0);
      ctx.fillStyle = css("--vp-job"); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(run.job || "job", X(w.start_s) + 4, y0 + 2);
    }
    // bars
    const bw = Math.max(1, (x1 - x0) / (maxT + 1));
    for (const f of run.frames) {
      const tt = totals(f);
      if (!tt.n) continue;
      const x = X(f.t) - bw / 2;
      const ok = tt.ok / tt.n, shed = tt.shed / tt.n, bad = tt.bad / tt.n;
      ctx.fillStyle = css("--vp-ok"); ctx.globalAlpha = 0.55; ctx.fillRect(x, Y(ok), bw, y1 - Y(ok));
      ctx.fillStyle = css("--vp-shed"); ctx.globalAlpha = 0.8; ctx.fillRect(x, Y(ok + shed), bw, Y(ok) - Y(ok + shed));
      ctx.fillStyle = css("--vp-bad"); ctx.fillRect(x, Y(ok + shed + bad), bw, Y(ok + shed) - Y(ok + shed + bad));
      ctx.globalAlpha = 1;
    }
    // lines
    series.forEach((k, i) => {
      const vals = run.frames.map((f) => f.db?.[k]).filter((v) => v != null);
      const mx = Math.max(1e-9, ...vals);
      ctx.strokeStyle = color(i); ctx.lineWidth = 1.6; ctx.beginPath();
      let started = false;
      for (const f of run.frames) {
        const v = f.db?.[k];
        if (v == null) { started = false; continue; }
        const px = X(f.t), py = Y(v / mx);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    // cursor
    ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(t) + 0.5, y0); ctx.lineTo(X(t) + 0.5, y1); ctx.stroke();
    if (hover !== null) {
      ctx.strokeStyle = "rgba(165,180,252,.6)"; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(hover) + 0.5, y0); ctx.lineTo(X(hover) + 0.5, y1); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  canvas.addEventListener("mousemove", (e) => {
    if (!run) return;
    const r = canvas.getBoundingClientRect();
    const x0 = pad.l, x1 = r.width - pad.r;
    const s = Math.round(((e.clientX - r.left - x0) / (x1 - x0)) * run.maxT);
    if (s < 0 || s > run.maxT) { hover = null; readout.hidden = true; draw(); return; }
    hover = s; draw();
    const f = run.byT.get(s); const tt = totals(f);
    const lines = [`t = ${s} s`, `${tt.n} req · ${tt.n ? Math.round((tt.ok / tt.n) * 100) : 0}% ok`];
    for (const [c, n] of Object.entries(tt.errs)) lines.push(`${c}: ${n}`);
    for (const k of series) if (f?.db?.[k] != null) lines.push(`${SIGNALS[k]?.label || k}: ${Math.round(f.db[k] * 100) / 100}${SIGNALS[k]?.unit || ""}`);
    readout.innerHTML = lines.join("<br>");
    readout.hidden = false;
    const left = Math.min(e.clientX - r.left, r.width - 230);
    readout.style.left = `${left}px`; readout.style.top = `${e.clientY - r.top}px`;
  });
  canvas.addEventListener("mouseleave", () => { hover = null; readout.hidden = true; draw(); });
  new ResizeObserver(() => draw()).observe(canvas);
  return { setRun, setT, draw };
}

/** The player's scrub strip: success ratio per second, job window, cursor. */
export function drawStrip(canvas, run, t) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.05)";
  ctx.beginPath(); ctx.roundRect(0, 4, W, H - 8, 6); ctx.fill();
  if (!run || !run.maxT) return;
  const X = (s) => (s / run.maxT) * W;
  const w = run.batch_window;
  if (w) { ctx.fillStyle = "rgba(251,146,60,.22)"; ctx.fillRect(X(w.start_s), 4, X(Math.min(w.end_s, run.maxT)) - X(w.start_s), H - 8); }
  const bw = Math.max(1, W / (run.maxT + 1));
  for (const f of run.frames) {
    const tt = totals(f);
    if (!tt.n) continue;
    const bad = 1 - tt.ok / tt.n;
    ctx.fillStyle = bad > 0.01 ? css("--vp-bad") : css("--vp-ok");
    ctx.globalAlpha = bad > 0.01 ? 0.35 + 0.65 * bad : 0.35;
    const h = 6 + (H - 16) * (bad > 0.01 ? bad : 0.25);
    ctx.fillRect(X(f.t) - bw / 2, H - 4 - h, bw, h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#fff";
  ctx.fillRect(X(t) - 1, 2, 2, H - 4);
}
