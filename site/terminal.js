// The terminal. Commands replay recorded runs: `lab run` drives the shared
// player and prints status lines as the replay passes through time. Every
// line is derived from the recorded run files; nothing here touches a database.
import { D, totals, fmt, jobLabel, jobEndVerb } from "./data.js";
import { SCENARIOS } from "./manifest.js";

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const PROMPT = "oncall@pg-pressure-lab:~$";

/**
 * api: { player, mission() -> scenario, openMission(id), drawer(kind),
 *        hint() -> {text, cmd}, explain(step) -> html, onEvent(evt),
 *        setSpeed(n), status() -> html }
 */
export function createTerminal(root, api) {
  const out = root.querySelector(".term-out"), input = root.querySelector(".term-input"), form = root.querySelector("form"), chips = root.querySelector(".term-chips");
  const hist = [];
  let hi = -1, follow = null;

  const line = (html, cls = "") => { const d = document.createElement("div"); d.className = `ln ${cls}`; d.innerHTML = html; out.appendChild(d); out.scrollTop = out.scrollHeight; return d; };
  const clear = () => { out.innerHTML = ""; };
  const scenarioIds = () => [...new Set(D.index.map((r) => r.scenario))];
  const runsOf = (sc, round, rate) => D.index.filter((r) => r.scenario === sc && (!round || r.round === round) && (!rate || r.rate === rate));
  const roundsOf = (sc) => [...new Set(runsOf(sc).map((r) => r.round))];
  const cur = () => api.mission()?.id || "batch";

  const COMMANDS = ["help", "clear", "missions", "mission", "status", "briefing", "debrief", "hint", "speed", "lab"];
  const LAB = ["scenarios", "rounds", "runs", "run", "report", "top", "explain", "stop"];

  function help() {
    // pad the plain text, then escape: entities must not count as characters
    const row = (c, d) => `  <span class="k">${esc(c.padEnd(28))}</span><span class="c">${esc(d)}</span>`;
    line([
      `<span class="acc">commands</span>  <span class="c">· Tab completes · ↑ ↓ history · / focuses</span>`,
      row("lab run <mission> <round>", "replay a recorded run"),
      row("  [--stamp S]", "one particular run (lab runs)"),
      row("lab rounds [mission]", "what each round changes"),
      row("lab runs [mission]", "recorded runs, headline numbers"),
      row("lab report [mission]", "compare every round"),
      row("lab top", "top statements of the run"),
      row("lab explain [step]", "the guide: incident, diagnose,"),
      row("", "  fix or alert"),
      row("lab stop", "pause the replay"),
      row("missions · mission <id>", "list or open a mission"),
      row("status · hint", "progress, or a nudge"),
      row("briefing · debrief", "the write-ups"),
      row("speed <1|5|10|20|40>", "replay speed"),
      row("clear", "clear the screen (Ctrl+L)"),
    ].join("\n"), "pre");
  }

  async function run(argv) {
    const [sc0, round] = argv;
    const sc = sc0 || cur();
    const ri = argv.indexOf("--rate");
    const rate = ri >= 0 ? Number(argv[ri + 1]) : undefined;
    if (!round) {
      line(`usage: lab run ${esc(sc)} &lt;round&gt;   rounds: ${roundsOf(sc).map(esc).join(", ") || "none"}`, "warn");
      return;
    }
    let rs = runsOf(sc, round, rate);
    if (!rs.length) rs = runsOf(sc, round);
    if (!rs.length) { line(`no recorded run for ${esc(sc)} ${esc(round)}. try: lab rounds ${esc(sc)}`, "bad"); return; }
    // --stamp picks one recorded run of the round (see lab runs)
    const si = argv.indexOf("--stamp");
    if (si >= 0) {
      rs = rs.filter((r) => r.stamp === argv[si + 1]);
      if (!rs.length) { line(`no run ${esc(argv[si + 1] || "")} for ${esc(sc)} ${esc(round)}. try: lab runs ${esc(sc)}`, "bad"); return; }
    }
    const top = Math.max(...rs.map((r) => r.rate));
    const pool = rate ? rs : rs.filter((r) => r.rate === top);
    const pick = pool.filter((r) => r.headline.max_sessions_per_s !== null).at(-1) || pool.at(-1);
    line(`<span class="c"># replay of results/${esc(sc)}/${esc(round)}/${esc(pick.stamp)} · ${pick.rate} req/s for ${esc(pick.duration)} · ${api.player.speed}× speed</span>`);
    const r = await api.player.loadRun(pick.id, 0);
    line(`<span class="c">sending ${pick.rate} req/s, open loop, 2 s deadline per request</span>`);
    follow = { r, next: 0, done: false, events: new Set() };
    api.player.play();
    api.onEvent({ type: "run", scenario: sc, round, run: r });
  }

  // a status line every 10 s of replay time, and on job start and end
  api.player.on((t, r) => {
    if (!follow || follow.done || r !== follow.r) return;
    while (follow.next <= t && follow.next <= r.maxT) {
      const s = follow.next;
      let n = 0, ok = 0; const errs = {};
      for (let k = s; k < s + 10 && k <= r.maxT; k++) {
        const tt = totals(r.byT.get(k)); n += tt.n; ok += tt.ok;
        for (const [c, v] of Object.entries(tt.errs)) errs[c] = (errs[c] || 0) + v;
      }
      const db = r.byT.get(s)?.db || {};
      const pct = n ? (ok / n) * 100 : 100;
      const e = Object.entries(errs).map(([c, v]) => `${c}:${v}`).join(" ");
      const okS = `<span class="${pct < 99 ? "bad" : "ok"}">${pct.toFixed(1).padStart(5)}% ok</span>`, er = e ? `  <span class="bad">${esc(e)}</span>` : "";
      if (out.clientWidth < 420) // phones: one line that fits, without the padding
        line(`<span class="c">${String(s).padStart(3)}s</span> ${okS} pool ${db.pool_acquired ?? "-"}/40 q ${db.bouncer_cl_waiting ?? "-"} lk ${db.pg_lock_wait ?? "-"} xact ${Math.round(db.longest_xact_s ?? 0)}s${er}`);
      else
        line(`<span class="c">t=${String(s).padStart(3)}s</span>  ${okS}  pool ${String(db.pool_acquired ?? "-").padStart(2)}/40  queue ${String(db.bouncer_cl_waiting ?? "-").padStart(2)}  locks ${String(db.pg_lock_wait ?? "-").padStart(2)}  xact ${String(Math.round(db.longest_xact_s ?? 0)).padStart(3)}s${er}`);
      follow.next += 10;
    }
    const w = r.batch_window;
    if (w && t >= w.start_s && !follow.events.has("s")) { follow.events.add("s"); line(`<span class="job">▶ ${esc(jobLabel(r))} started at ${w.start_s.toFixed(1)} s</span>`); }
    if (w && t >= w.end_s && !follow.events.has("e")) { follow.events.add("e"); line(`<span class="job">■ ${esc(jobLabel(r))} ${jobEndVerb(r)} at ${w.end_s.toFixed(1)} s, after ${(w.end_s - w.start_s).toFixed(0)} s</span>`); }
    // runs without a job window: mark the first failed second instead
    if (!w && r.headline?.first_failure_s != null && t >= r.headline.first_failure_s && !follow.events.has("f")) { follow.events.add("f"); line(`<span class="bad">✕ first failed request at ${r.headline.first_failure_s} s</span>`); }
    if (t >= r.maxT && !follow.done) {
      follow.done = true;
      for (const [op, s] of Object.entries(r.summary?.ops || {}).sort()) {
        const errs = Object.entries(s.errors || {}).map(([c, v]) => `${c}:${v}`).join(" ");
        line(`  ${op.padEnd(9)} n=${String(s.n).padEnd(6)} ok=${(s.ok_ratio ?? s.ok / s.n).toFixed(4)}  p99=${fmt.ms(s.p99_ms)}${errs ? `  <span class="bad">${esc(errs)}</span>` : ""}`);
      }
      const h = r.headline;
      const tone = h.failed_pct > 1 ? "bad" : "ok";
      if (h.retries_sent != null) line(`  retries  sent=${fmt.n(h.retries_sent)}  refused by budget=${fmt.n(h.retries_denied ?? 0)}`);
      // "recovered" only means something if requests failed; a null with no
      // failures just means the run ended less than 10 s after the job
      const rec = !h.failed ? "" : h.recovered_s === null ? " · not recovered within the run" : ` · recovered ${h.recovered_s} s after`;
      line(`<span class="${tone}">failed ${fmt.n(h.failed)} of ${fmt.n(h.requests)} (${fmt.pct2(h.failed_pct)})</span>${h.failed_after_batch != null ? ` · <span class="${h.failed_after_batch ? "bad" : "ok"}">${fmt.n(h.failed_after_batch)} after the ${esc(jobLabel(r))} ${jobEndVerb(r)}${rec}</span>` : ""}`);
      api.onEvent({ type: "runEnd", scenario: r.scenario, round: r.round, run: r });
    }
  });

  function report(sc) {
    const s = SCENARIOS.find((x) => x.id === sc);
    const rounds = [...Object.keys(s?.rounds || {}), ...roundsOf(sc)].filter((v, i, a) => a.indexOf(v) === i && runsOf(sc, v).length);
    if (!rounds.length) { line(`no runs for ${esc(sc)}`, "bad"); return false; }
    const top = Math.max(...runsOf(sc).map((r) => r.rate));
    line(`<span class="c">${"round".padEnd(20)}${"runs".padEnd(6)}${"failed".padEnd(16)}${"after job".padEnd(16)}recovered</span>`);
    for (const rd of rounds) {
      const rs = runsOf(sc, rd, top);
      if (!rs.length) continue;
      const f = rs.map((r) => r.headline.failed_pct), a = rs.map((r) => r.headline.failed_after_batch).filter((v) => v != null);
      const rec = [...new Set(rs.map((r) => (r.headline.batch_seconds == null || !r.headline.failed ? "–" : r.headline.recovered_s === null ? "never" : `${r.headline.recovered_s}s`)))];
      const rg = (v, fm) => (v.length ? (Math.min(...v) === Math.max(...v) ? fm(v[0]) : `${fm(Math.min(...v))}–${fm(Math.max(...v))}`) : "–");
      line(`${esc(rd).padEnd(20)}${String(rs.length).padEnd(6)}<span class="${Math.max(...f) > 1 ? "bad" : "ok"}">${rg(f, (v) => v.toFixed(2) + "%").padEnd(16)}</span>${rg(a, (v) => fmt.n(v)).padEnd(16)}${rec.join(", ")}`);
    }
    line(`<span class="c">at ${top} req/s · ranges cover every recorded run of a round</span>`);
    return true;
  }

  async function exec(raw) {
    const text = raw.trim();
    line(`<span class="p">${PROMPT}</span> ${esc(text)}`, "echo");
    const a = text.split(/\s+/).filter(Boolean);
    if (a[0] === "scripts/lab" || a[0] === "./scripts/lab") a[0] = "lab";
    const [cmd, sub, ...rest] = a;
    try {
      switch (cmd) {
        case undefined: break;
        case "help": help(); break;
        case "clear": clear(); break;
        case "missions": for (const id of scenarioIds()) { const s = SCENARIOS.find((x) => x.id === id); if (s?.ready) line(`  ${id.padEnd(12)}<span class="c">${esc(s.short)} · ${runsOf(id).length} runs</span>`); } break;
        case "mission": if (!sub) line("usage: mission &lt;id&gt;", "warn"); else api.openMission(sub); break;
        case "status": line(api.status(), "pre"); break;
        case "briefing": api.drawer("briefing"); break;
        case "debrief": api.drawer("debrief"); break;
        case "hint": { const h = api.hint(); line(`<span class="acc">hint</span> ${h.text}`); if (h.cmd) { input.value = h.cmd; input.focus(); } break; }
        case "speed": { const n = Number(sub); if (![1, 5, 10, 20, 40].includes(n)) line("usage: speed 1|5|10|20|40", "warn"); else { api.setSpeed(n); line(`<span class="c">replay speed ${n}×</span>`); } break; }
        case "lab":
          switch (sub) {
            case undefined: case "help": help(); break;
            case "scenarios": for (const id of scenarioIds()) line(`  ${id.padEnd(12)}<span class="c">${runsOf(id).length} runs</span>`); break;
            case "rounds": {
              const sc = rest[0] || cur(); const s = SCENARIOS.find((x) => x.id === sc);
              const rounds = roundsOf(sc);
              if (!rounds.length) { line(`unknown mission ${esc(sc)}`, "bad"); break; }
              for (const r of rounds) line(`  <span class="k">${esc(r).padEnd(20)}</span><span class="c">${esc(s?.rounds?.[r] || "")}</span>`, "wrap");
              break;
            }
            case "runs": {
              const sc = rest[0] || cur();
              for (const r of runsOf(sc)) line(`  ${esc(r.round).padEnd(18)} ${r.stamp}  ${String(r.rate).padStart(3)}/s  <span class="${r.headline.failed_pct > 1 ? "bad" : "ok"}">${fmt.pct2(r.headline.failed_pct).padStart(7)} failed</span>`);
              break;
            }
            case "run": await run(rest); break;
            case "report": { const sc = rest[0] || cur(); if (report(sc)) api.onEvent({ type: "report", scenario: sc }); break; }
            case "top": {
              const r = api.player.run;
              if (!r?.top_statements?.length) { line("no statements recorded for the run on screen; replay one first", "c"); break; }
              line(`<span class="c">pg_stat_statements · ${esc(r.scenario)}/${esc(r.round)}</span>`);
              for (const s of r.top_statements.slice(0, 6)) line(`  ${fmt.ms(s.total_ms).padStart(8)}  ${String(s.calls).padStart(6)} calls  <span class="c">${esc(s.query.slice(0, 86))}</span>`);
              api.onEvent({ type: "top" });
              break;
            }
            case "explain": { const html = api.explain(rest[0]); line(html, "prose"); break; }
            case "stop": api.player.pause(); line("<span class=\"c\">replay paused</span>"); break;
            default: line(`unknown: lab ${esc(sub)}. type help`, "bad");
          }
          break;
        default: line(`command not found: ${esc(cmd)} · type <span class="k">help</span>`, "bad");
      }
    } catch (e) { line(esc(e.message), "bad"); }
  }

  function complete() {
    const v = input.value;
    const parts = v.split(/\s+/);
    const last = parts.at(-1);
    let pool = [];
    if (parts.length === 1) pool = COMMANDS;
    else if (parts[0] === "lab" && parts.length === 2) pool = LAB;
    else if (parts[0] === "lab" && ["run", "rounds", "runs", "report"].includes(parts[1]) && parts.length === 3) pool = scenarioIds();
    else if (parts[0] === "lab" && parts[1] === "run" && parts.length === 4) pool = roundsOf(parts[2]);
    else if (parts[0] === "lab" && parts[1] === "explain" && parts.length === 3) pool = ["incident", "reproduce", "diagnose", "fix", "alert"];
    else if (parts[0] === "mission" && parts.length === 2) pool = scenarioIds();
    const m = pool.filter((x) => x.startsWith(last));
    if (m.length === 1) { parts[parts.length - 1] = m[0]; input.value = parts.join(" ") + " "; }
    else if (m.length > 1) {
      let p = m[0];
      for (const x of m) while (!x.startsWith(p)) p = p.slice(0, -1);
      if (p.length > last.length) { parts[parts.length - 1] = p; input.value = parts.join(" "); }
      else line(m.map(esc).join("   "), "c");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    input.value = "";
    if (!v) return;
    if (hist[0] !== v) hist.unshift(v);
    hi = -1;
    exec(v);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { hi = Math.min(hist.length - 1, hi + 1); if (hist[hi] !== undefined) input.value = hist[hi]; e.preventDefault(); }
    else if (e.key === "ArrowDown") { hi = Math.max(-1, hi - 1); input.value = hi >= 0 ? hist[hi] : ""; e.preventDefault(); }
    else if (e.key === "Tab") { e.preventDefault(); complete(); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); clear(); }
  });
  root.querySelector(".term-out").addEventListener("click", () => { if (!getSelection()?.toString()) input.focus({ preventScroll: true }); });

  function setChips(list) {
    chips.innerHTML = "";
    for (const c of list) {
      const b = document.createElement("button");
      b.type = "button"; b.className = c.primary ? "chip primary" : "chip"; b.textContent = c.cmd;
      b.title = c.title || `Run: ${c.cmd}`;
      b.addEventListener("click", () => { input.value = c.cmd; form.requestSubmit(); });
      chips.appendChild(b);
    }
  }

  line(`<span class="acc">pg-pressure-lab</span> <span class="c">· incident console · replays of recorded runs on PostgreSQL 17 + PgBouncer + Go</span>`);
  line(`<span class="c">type</span> <span class="k">help</span> <span class="c">for commands, or tap a suggestion below.</span>`);
  return { exec, line, setChips, focus: () => input.focus({ preventScroll: true }) };
}
