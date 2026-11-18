// The terminal: typed commands replay recorded data. `lab run` drives the
// shared player and prints status lines as the replay passes through time;
// every line is derived from the recorded run files.
import { D, totals, fmt } from "./data.js";
import { SCENARIOS } from "./manifest.js";

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function createTerminal(el, { player, onOpenScenario }) {
  const out = el.querySelector(".term-out"), input = el.querySelector("input"), chips = el.querySelector(".term-chips");
  const hist = [];
  let hi = -1, follow = null;

  const print = (html, cls = "") => { const d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = html; out.appendChild(d); out.scrollTop = out.scrollHeight; };
  const clear = () => { out.innerHTML = ""; };
  const scenarioIds = () => [...new Set(D.index.map((r) => r.scenario))];
  const runsOf = (sc, round, rate) => D.index.filter((r) => r.scenario === sc && (!round || r.round === round) && (!rate || r.rate === rate));

  function help() {
    print(`<span class="acc">pg-pressure-lab</span> <span class="c">· replays of recorded runs; nothing here touches a database</span>
  <span class="cmd">lab scenarios</span>                     <span class="c">list scenarios</span>
  <span class="cmd">lab rounds &lt;scenario&gt;</span>              <span class="c">what each round changes</span>
  <span class="cmd">lab run &lt;scenario&gt; &lt;round&gt; [--rate N]</span> <span class="c">replay a recorded run</span>
  <span class="cmd">lab report &lt;scenario&gt;</span>              <span class="c">compare rounds</span>
  <span class="cmd">lab top</span>                           <span class="c">top statements of the run on screen</span>
  <span class="cmd">open &lt;scenario&gt;</span>                   <span class="c">go to a scenario</span>
  <span class="cmd">clear</span>`);
  }

  async function run(argv) {
    const [sc, round] = argv;
    const ri = argv.indexOf("--rate");
    const rate = ri >= 0 ? Number(argv[ri + 1]) : undefined;
    let rs = runsOf(sc, round, rate);
    if (!rs.length) rs = runsOf(sc, round);
    if (!rs.length) return print(`no recorded run for ${esc(sc)} ${esc(round || "")}. try: lab rounds ${esc(sc || "batch")}`, "bad");
    const pick = rs.filter((r) => r.headline.max_sessions_per_s !== null).at(-1) || rs.at(-1);
    print(`<span class="c">$ scripts/lab run ${esc(sc)} ${esc(round)}   # replay of ${pick.stamp}, ${pick.rate} req/s for ${pick.duration}</span>`);
    const r = await player.loadRun(pick.id, 0);
    print(`<span class="c">sending ${pick.rate} req/s, open loop, 2 s deadline per request</span>`);
    follow = { r, next: 0, done: false, events: new Set() };
    player.play();
  }

  // print a line every 10 s of replay time, and on job start/end
  player.on((t, r) => {
    if (!follow || follow.done || r !== follow.r) return;
    while (follow.next <= t && follow.next <= r.maxT) {
      const s = follow.next;
      let n = 0, ok = 0; const errs = {};
      for (let k = s; k < s + 10 && k <= r.maxT; k++) {
        const tt = totals(r.byT.get(k)); n += tt.n; ok += tt.ok;
        for (const [c, v] of Object.entries(tt.errs)) errs[c] = (errs[c] || 0) + v;
      }
      const f = r.byT.get(s);
      const pct = n ? (ok / n) * 100 : 100;
      const db = f?.db || {};
      const e = Object.entries(errs).map(([c, v]) => `${c}:${v}`).join(" ");
      print(`t=${String(s).padStart(3)}s  <span class="${pct < 99 ? "bad" : "ok"}">${pct.toFixed(1).padStart(5)}% ok</span>  pool ${String(db.pool_acquired ?? "-").padStart(2)}/40  bouncer waiting ${String(db.bouncer_cl_waiting ?? "-").padStart(2)}  oldest xact ${(db.longest_xact_s ?? 0).toFixed(0).padStart(3)}s${e ? `  <span class="bad">${esc(e)}</span>` : ""}`);
      follow.next += 10;
    }
    const w = r.batch_window;
    if (w && t >= w.start_s && !follow.events.has("s")) { follow.events.add("s"); print(`<span class="job">▶ ${esc(r.job || "job")} started at ${w.start_s.toFixed(1)} s</span>`); }
    if (w && t >= w.end_s && !follow.events.has("e")) { follow.events.add("e"); print(`<span class="job">■ ${esc(r.job || "job")} finished at ${w.end_s.toFixed(1)} s (${(w.end_s - w.start_s).toFixed(0)} s)</span>`); }
    if (t >= r.maxT && !follow.done) {
      follow.done = true;
      const ops = r.summary?.ops || {};
      for (const [op, s] of Object.entries(ops).sort()) {
        const errs = Object.entries(s.errors || {}).map(([c, v]) => `${c}:${v}`).join(" ");
        print(`${op.padEnd(9)} n=${String(s.n).padEnd(6)} ok=${(s.ok_ratio ?? s.ok / s.n).toFixed(4)}  p99=${fmt.ms(s.p99_ms)}${errs ? `  <span class="bad">${esc(errs)}</span>` : ""}`);
      }
      const h = r.headline;
      if (h.failed_after_batch !== null && h.failed_after_batch !== undefined) print(`<span class="${h.failed_after_batch ? "bad" : "ok"}">failed after the job ended: ${fmt.n(h.failed_after_batch)} · recovered: ${h.recovered_s === null ? "not within the run" : `${h.recovered_s} s after`}</span>`);
      print(`<span class="c">results: results/${esc(r.scenario)}/${esc(r.round)}/${esc(r.stamp)}/</span>`);
    }
  });

  function report(sc) {
    const sm = SCENARIOS.find((s) => s.id === sc);
    const rounds = [...new Set(runsOf(sc).map((r) => r.round))];
    if (!rounds.length) return print(`no runs for ${esc(sc)}`, "bad");
    print(`<span class="c">round                 runs  failed            after job       recovered</span>`);
    for (const rd of rounds) {
      const rs = runsOf(sc, rd);
      const f = rs.map((r) => r.headline.failed_pct), a = rs.map((r) => r.headline.failed_after_batch).filter((v) => v !== null && v !== undefined);
      const rec = rs.map((r) => (r.headline.recovered_s === null ? "never" : `${r.headline.recovered_s}s`));
      const rg = (v, fm) => (v.length ? (Math.min(...v) === Math.max(...v) ? fm(v[0]) : `${fm(Math.min(...v))}–${fm(Math.max(...v))}`) : "-");
      print(`${rd.padEnd(22)}${String(rs.length).padEnd(6)}<span class="${Math.max(...f) > 1 ? "bad" : "ok"}">${rg(f, (v) => v.toFixed(2) + "%").padEnd(18)}</span>${rg(a, (v) => fmt.n(v)).padEnd(16)}${[...new Set(rec)].join(", ")}`);
    }
    if (sm) print(`<span class="c">${esc(sm.title)}</span>`);
  }

  async function exec(line) {
    print(`<span class="cmd">$ ${esc(line)}</span>`);
    const a = line.trim().split(/\s+/);
    if (a[0] === "lab") a.shift();
    else if (a[0] === "scripts/lab") a.shift();
    const [cmd, ...rest] = a;
    try {
      switch (cmd) {
        case "help": case undefined: case "": help(); break;
        case "clear": clear(); break;
        case "scenarios": for (const id of scenarioIds()) { const s = SCENARIOS.find((x) => x.id === id); print(`${id.padEnd(12)}<span class="c">${esc(s?.short || "")} · ${runsOf(id).length} runs</span>`); } break;
        case "rounds": {
          const sc = rest[0] || "batch"; const s = SCENARIOS.find((x) => x.id === sc);
          const rounds = [...new Set(runsOf(sc).map((r) => r.round))];
          if (!rounds.length) { print(`unknown scenario ${esc(sc)}`, "bad"); break; }
          for (const r of rounds) print(`${r.padEnd(20)}<span class="c">${esc(s?.rounds?.[r] || "")}</span>`);
          break;
        }
        case "run": await run(rest); break;
        case "report": report(rest[0] || player.run?.scenario || "batch"); break;
        case "top": {
          const r = player.run; if (!r?.top_statements?.length) { print("no statements recorded for this run", "c"); break; }
          for (const s of r.top_statements.slice(0, 6)) print(`${fmt.ms(s.total_ms).padStart(8)} total  ${String(s.calls).padStart(6)} calls  <span class="c">${esc(s.query.slice(0, 90))}</span>`);
          break;
        }
        case "open": onOpenScenario(rest[0]); break;
        default: print(`unknown command: ${esc(cmd)}. type help`, "bad");
      }
    } catch (e) { print(esc(e.message), "bad"); }
  }

  el.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim(); if (!v) return;
    hist.unshift(v); hi = -1; input.value = ""; exec(v);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { hi = Math.min(hist.length - 1, hi + 1); if (hist[hi]) input.value = hist[hi]; e.preventDefault(); }
    if (e.key === "ArrowDown") { hi = Math.max(-1, hi - 1); input.value = hi >= 0 ? hist[hi] : ""; e.preventDefault(); }
  });
  function setChips(list) {
    chips.innerHTML = "";
    for (const c of list) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = c;
      b.addEventListener("click", () => { input.value = c; el.querySelector("form").requestSubmit(); });
      chips.appendChild(b);
    }
  }
  print(`<span class="acc">pg-pressure-lab</span> <span class="c">replay terminal · type <span class="cmd">help</span> or tap a command below</span>`);
  return { exec, setChips, print };
}
