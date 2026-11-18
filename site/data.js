// Data: the run index, run files, and the per-scenario context the text uses.
import { SCENARIOS, SIGNALS } from "./manifest.js";

export const fmt = {
  n: (v) => Number(v).toLocaleString("en-US"),
  pct: (v) => (v === 0 ? "0%" : v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`),
  pct2: (v) => `${v.toFixed(2)}%`,
  s: (v) => `${Math.round(v)} s`,
  ms: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`),
};

const cache = new Map();
export const D = {
  index: [],
  async init() {
    const r = await fetch("data/index.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`index: HTTP ${r.status}`);
    // Only scenarios that are listed: a scenario being re-recorded (ready:
    // false) must not count towards totals or appear in run pickers.
    D.index = (await r.json()).runs.filter((x) => SCENARIOS.find((s) => s.id === x.scenario)?.ready);
  },
  runsOf(scenario) { return D.index.filter((r) => r.scenario === scenario); },
  async load(id) {
    if (!cache.has(id)) {
      cache.set(id, fetch(`data/runs/${id}.json`, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`run ${id}: HTTP ${r.status}`);
        return r.json();
      }).then(prep));
    }
    return cache.get(id);
  },
};

export function prep(run) {
  run.byT = new Map(run.frames.map((f) => [f.t, f]));
  run.maxT = run.frames.length ? run.frames[run.frames.length - 1].t : 0;
  return run;
}

/** Scenarios that are ready and have data, in manifest order. */
export function liveScenarios() {
  return SCENARIOS.filter((s) => s.ready && D.runsOf(s.id).length > 0);
}

// a range string over values: "53–66%" or "66%" or null
function rangeOf(vals, f) {
  vals = vals.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!vals.length) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const a = f(lo), b = f(hi);
  if (a === b) return a;
  const suf = a.match(/[^\d.,]+$/)?.[0];
  return suf && b.endsWith(suf) ? `${a.slice(0, -suf.length)}–${b}` : `${a} – ${b}`;
}

/** Frame totals across operations. */
export function totals(f) {
  let n = 0, ok = 0, shed = 0;
  const errs = {};
  for (const o of Object.values(f?.ops || {})) {
    n += o.n; ok += o.ok;
    for (const [k, v] of Object.entries(o.errors || {})) {
      errs[k] = (errs[k] || 0) + v;
      if (k === "pool_exhausted" || k === "budget_exhausted") shed += v;
    }
  }
  return { n, ok, shed, bad: n - ok - shed, errs };
}

/**
 * Which signals rose above their pre-job maximum first, and how far ahead of
 * the first failed request. Same method as internal/runs.FirstSignals.
 */
export function firstSignals(run, keys) {
  const w = run.batch_window;
  if (!w) return null;
  const start = Math.floor(w.start_s);
  const fr = run.frames;
  let firstFail = -1;
  for (const f of fr) { if (f.t >= start) { const t = totals(f); if (t.ok < t.n) { firstFail = f.t; break; } } }
  const lo = start > 5 ? 5 : 0;
  const out = [];
  for (const k of keys) {
    let base = 0, seen = false;
    for (const f of fr) if (f.t >= lo && f.t < start && f.db && f.db[k] != null) { base = Math.max(base, f.db[k]); seen = true; }
    for (const f of fr) {
      if (f.t < start || !f.db || f.db[k] == null) continue;
      seen = true;
      if (f.db[k] > base) { out.push({ key: k, base, at: f.t, value: f.db[k], lead: firstFail >= 0 ? firstFail - f.t : null }); break; }
    }
    if (!seen) continue;
  }
  out.sort((a, b) => a.at - b.at);
  return { firstFail, start, signals: out };
}

/** Context object the manifest text functions read. */
export function makeCtx(sc, sig) {
  const rs = D.runsOf(sc.id);
  const rate = rs.length ? Math.max(...rs.map((r) => r.rate)) : 300;
  const pick = (round, r = rate) => rs.filter((x) => x.round === round && x.rate === r);
  const field = (h, k) => (typeof k === "function" ? k(h) : h[k]);
  const ctx = {
    rate, fmt, sig,
    count: (round, r) => pick(round, r).length,
    has: (round) => pick(round).length > 0,
    range: (round, k, f = String, r) => rangeOf(pick(round, r).map((x) => field(x.headline, k)), f),
    countWhere: (round, pred, r) => pick(round, r).filter((x) => pred(x.headline)).length,
    /** "Oldest open transaction rose 26–47 s before the first failed request" or null */
    sigLead(key, label) {
      const leads = (sig || []).map((s) => s.signals.find((x) => x.key === key)?.lead).filter((v) => v !== undefined && v !== null);
      if (!leads.length) return null;
      const lo = Math.min(...leads), hi = Math.max(...leads);
      const r = lo === hi ? `${lo} s` : `${lo}–${hi} s`;
      if (hi <= 0) return `${label}: rose only ${lo === hi ? `${-lo} s` : `${-hi}–${-lo} s`} after callers were already failing.`;
      if (lo < 0) return `${label}: between ${-lo} s after and ${hi} s before the first failed request.`;
      return `${label}: rose ${r} before the first failed request.`;
    },
    signalsSentence() {
      if (!sig || !sig.length) return "";
      const keys = [...new Set(sig.flatMap((s) => s.signals.map((x) => x.key)))];
      const rows = keys.map((k) => {
        const leads = sig.map((s) => s.signals.find((x) => x.key === k)?.lead).filter((v) => v !== null && v !== undefined);
        if (!leads.length) return null;
        const lo = Math.min(...leads), hi = Math.max(...leads);
        return { k, lo, hi };
      }).filter(Boolean).sort((a, b) => b.hi - a.hi);
      const label = (k) => SIGNALS[k]?.label || k.replace(/_/g, " ");
      const cell = (lo, hi) => {
        const one = (v) => (v > 0 ? `${v} s before` : v < 0 ? `${-v} s after` : "same second");
        return lo === hi ? one(lo) : `${one(hi)} … ${one(lo)}`;
      };
      return `<div class="tablewrap"><table class="data"><thead><tr><th>Signal</th><th class="n">Moved, relative to the first failed request</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${label(r.k)}</td><td class="n ${r.hi > 0 ? "v-ok" : "v-bad"}">${cell(r.lo, r.hi)}</td></tr>`).join("")}</tbody></table></div><p class="faint" style="font-size:13px">Across ${sig.length} recorded ${sig.length === 1 ? "run" : "runs"} of the primary round. "Moved" means it first rose above the highest value it showed before the job started.</p>`;
    },
  };
  return ctx;
}

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
