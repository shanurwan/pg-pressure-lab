// The game layer: missions, objectives, XP, ranks, stars and badges. Progress
// lives in this browser only (localStorage), and every quiz answer that is a
// number or a "which one" comes from the recorded runs, never from text.
import { SCENARIOS, SIGNALS, OBJECTIVES } from "./manifest.js";
import { D, store } from "./data.js";

const KEY = "pgpl-game-v1";

export const RANKS = [
  { min: 0, name: "Trainee" },
  { min: 150, name: "On-call engineer" },
  { min: 400, name: "Incident commander" },
  { min: 800, name: "Database reliability lead" },
];

// Icons are 24x24 stroke paths, drawn in currentColor.
export const BADGES = [
  { id: "on-call", name: "On call", how: "Replay any recorded run from the terminal.", icon: "M4 17l6-5-6-5M12 19h8" },
  { id: "first-page", name: "First page", how: "Trigger a mission's incident round.", icon: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" },
  { id: "root-cause", name: "Root cause", how: "Answer a mission's 'why' question right first time.", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35" },
  { id: "early-warning", name: "Early warning", how: "Pick the signal that moved first, from the data.", icon: "M22 12h-4l-3 9L9 3l-3 9H2" },
  { id: "zero", name: "Zero failures", how: "Replay a fix round in which no request failed.", icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" },
  { id: "analyst", name: "Analyst", how: "Use both lab report and lab top.", icon: "M3 3v18h18M7 16v-4M12 16V8M17 16v-7" },
  { id: "mission", name: "Mission complete", how: "Finish every objective in a mission.", icon: "M4 22V4M4 4h12l-2 4 2 4H4" },
  { id: "three-stars", name: "Three stars", how: "Earn all three stars on a mission.", icon: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" },
];

const blank = () => ({ xp: 0, done: {}, quiz: {}, tried: {}, badges: [], used: {}, visited: {}, onboarded: false, runs: 0 });
export const state = Object.assign(blank(), store.get(KEY, {}) || {});
export function save() { store.set(KEY, state); }
export function reset() { Object.assign(state, blank()); save(); }

export function rankOf(xp = state.xp) {
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (xp >= RANKS[k].min) i = k;
  const cur = RANKS[i], next = RANKS[i + 1];
  const pct = next ? (xp - cur.min) / (next.min - cur.min) : 1;
  return { level: i + 1, name: cur.name, next, pct: Math.max(0, Math.min(1, pct)) };
}

/** Missions: scenarios that are ready and have recorded runs, in manifest order. */
export function missions() {
  return SCENARIOS.filter((s) => s.ready && D.runsOf(s.id).length > 0);
}

export const roundsOf = (sc) => [...new Set(D.runsOf(sc.id).map((r) => r.round))];

/**
 * Objectives for a mission: the manifest's list if it has one, otherwise a
 * standard set built from the mission's rounds. Objectives that need a round
 * with no recorded run are dropped.
 */
/** Objectives the data can't support (e.g. a quiz with no answer), as "mission:objective". */
export const unavailable = new Set();

export function objectivesOf(sc) {
  const have = new Set(roundsOf(sc));
  const list = OBJECTIVES[sc.id] || auto(sc, have);
  return list.filter((o) => {
    if (unavailable.has(`${sc.id}:${o.id}`)) return false;
    const rounds = o.match?.run;
    return !rounds || rounds.some((r) => have.has(r));
  }).map((o) => ({ ...o, match: o.match?.run ? { ...o.match, run: o.match.run.filter((r) => have.has(r)) } : o.match }));
}

function auto(sc, have) {
  const fixes = (sc.fixes || []).filter((r) => have.has(r));
  const out = [];
  if (have.has("baseline")) out.push({ id: "baseline", type: "command", xp: 50, text: "Run the baseline: the same traffic with nothing else going on", match: { run: ["baseline"] } });
  out.push({ id: "outage", type: "command", xp: 50, text: `Trigger the incident: the ${sc.primary} round`, match: { run: [sc.primary] } });
  out.push({ id: "signal", type: "quiz", quiz: "firstSignal", xp: 100 });
  if (fixes.length) out.push({ id: "fix", type: "command", xp: 100, text: `Ship a fix: replay ${fixes.join(" or ")}`, match: { run: fixes } });
  if (fixes.length > 1) out.push({ id: "best", type: "quiz", quiz: "bestFix", xp: 100 });
  out.push({ id: "report", type: "command", xp: 50, text: `Compare every round with lab report ${sc.id}`, match: { report: true } });
  return out;
}

export const isDone = (sc, o) => !!state.done[sc.id]?.[o.id];
export function progress(sc) {
  const obs = objectivesOf(sc);
  const n = obs.filter((o) => isDone(sc, o)).length;
  return { n, total: obs.length, done: obs.length > 0 && n === obs.length };
}

/** 1 star: every objective done. 2: every quiz right first time. 3: every round replayed. */
export function starsOf(sc) {
  const p = progress(sc);
  if (!p.done) return 0;
  let s = 1;
  const quizzes = objectivesOf(sc).filter((o) => o.type === "quiz");
  if (quizzes.every((o) => state.quiz[sc.id]?.[o.id]?.first)) s++;
  const tried = new Set(state.tried[sc.id] || []);
  if (roundsOf(sc).every((r) => tried.has(r))) s++;
  return s;
}

export function nextObjective(sc) {
  return objectivesOf(sc).find((o) => !isDone(sc, o)) || null;
}

/** Complete an objective; returns the XP awarded (0 if it was already done). */
export function complete(sc, o, xp = o.xp) {
  if (isDone(sc, o)) return 0;
  (state.done[sc.id] ||= {})[o.id] = true;
  state.xp += xp;
  save();
  return xp;
}

export function award(id) {
  if (state.badges.includes(id)) return null;
  state.badges.push(id);
  save();
  return BADGES.find((b) => b.id === id) || null;
}

export function signalLabel(k) { return SIGNALS[k]?.label || k.replace(/_/g, " "); }
