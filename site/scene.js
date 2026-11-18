// The 3D view. Requests flow left to right: clients → API → pgx pool (40
// slots) → PgBouncer (waiting queue + 20 server connections) → PostgreSQL. The
// job (batch, migration, idle transaction...) is the orange object above the
// database; while sessions wait on locks, lines tie them to it. Everything is
// driven by the current frame; only the particles are animated, and their
// colours follow that second's success and error counts.
//
// Colours come from the CSS tokens (--vp-*), so the legend, the charts and
// this view always agree.

const POOL = 40, SERVERS = 20, QUEUE_MAX = 40, BACKENDS = 24, PARTICLES = 480;
const X = { clients: -10.5, api: -6.4, pool: -3.0, queue: 0.6, bouncer: 3.2, pg: 8.0 };

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  return { ok: g("--vp-ok"), bad: g("--vp-bad"), shed: g("--vp-shed"), job: g("--vp-job"), wait: g("--vp-wait"), busy: g("--vp-busy"), idle: g("--vp-idle") };
}

export async function createScene(canvas, labelsEl, { reduceMotion, onLost }) {
  if (!window.WebGLRenderingContext) return null;
  let THREE;
  try { THREE = await import("three"); } catch { return null; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch { return null; }
  let lostTimer = null;
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lostTimer = setTimeout(() => onLost?.(true), 3000); });
  canvas.addEventListener("webglcontextrestored", () => { clearTimeout(lostTimer); onLost?.(false); });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue("--vp-bg").trim() || "#0a0e1a"), 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 2, 0.1, 200);
  const target = new THREE.Vector3((X.clients + X.pg) / 2 + 0.2, 0.4, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(4, 12, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0x818cf8, 24, 40);
  rim.position.set(-8, 6, -6);
  scene.add(rim);

  const T = tokens();
  const C = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, new THREE.Color(v || "#888")]));
  const dark = new THREE.Color(0);
  const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...opts });

  const grid = new THREE.GridHelper(36, 36, 0x26304d, 0x161d33);
  grid.position.y = -1.25;
  scene.add(grid);
  const track = new THREE.Mesh(new THREE.BoxGeometry(X.pg - X.clients, 0.04, 1.8), std(0x172036, { transparent: true, opacity: 0.8 }));
  track.position.set((X.pg + X.clients) / 2, -1.0, 0);
  scene.add(track);

  const clients = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.08, 12, 48), std(C.wait, { emissive: C.wait, emissiveIntensity: 0.5 }));
  clients.position.set(X.clients, 0, 0);
  clients.rotation.y = Math.PI / 2;
  scene.add(clients);

  const api = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.8, 1.8), std(0x243055, { transparent: true, opacity: 0.9 }));
  api.position.set(X.api, 0, 0);
  scene.add(api);

  const slotGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const m = new THREE.Mesh(slotGeo, std(C.idle.clone(), { emissive: dark.clone(), emissiveIntensity: 0.7 }));
    m.position.set(X.pool - 0.9 + (i % 5) * 0.45, -0.75 + Math.floor(i / 5) * 0.42, 0);
    scene.add(m);
    pool.push(m);
  }

  // PgBouncer's waiting clients: neutral "waiting" colour, never the amber
  // used for requests the API refused fast.
  const qGeo = new THREE.SphereGeometry(0.13, 12, 10);
  const queue = [];
  for (let i = 0; i < QUEUE_MAX; i++) {
    const m = new THREE.Mesh(qGeo, std(C.wait, { emissive: C.wait, emissiveIntensity: 0.55 }));
    m.position.set(X.queue - (i % 4) * 0.32, -0.8 + Math.floor(i / 4) * 0.3, 0.9);
    m.visible = false;
    scene.add(m);
    queue.push(m);
  }

  const srvGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.5, 16);
  const servers = [];
  for (let i = 0; i < SERVERS; i++) {
    const m = new THREE.Mesh(srvGeo, std(C.idle.clone(), { emissive: dark.clone(), emissiveIntensity: 0.8 }));
    m.position.set(X.bouncer - 0.8 + (i % 5) * 0.4, -0.7 + Math.floor(i / 5) * 0.6, 0);
    scene.add(m);
    servers.push(m);
  }

  const pg = new THREE.Group();
  pg.position.set(X.pg, 0, 0);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 2.2, 48), std(0x1f2a4f, { transparent: true, opacity: 0.92 }));
  pg.add(drum);
  for (const y of [-0.55, 0.15, 0.85]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.47, 0.03, 8, 64), std(C.wait, { emissive: C.wait, emissiveIntensity: 0.4 }));
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    pg.add(band);
  }
  const backends = [];
  const bGeo = new THREE.SphereGeometry(0.14, 14, 12);
  for (let i = 0; i < BACKENDS; i++) {
    const a = (i / BACKENDS) * Math.PI * 2;
    const m = new THREE.Mesh(bGeo, std(C.idle.clone(), { emissive: dark.clone(), emissiveIntensity: 1 }));
    m.position.set(Math.cos(a) * 1.9, -1.0, Math.sin(a) * 1.9);
    m.visible = false;
    pg.add(m);
    backends.push(m);
  }
  scene.add(pg);

  const job = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), std(C.job, { emissive: C.job, emissiveIntensity: 1.1, flatShading: true }));
  job.position.set(X.pg, 2.45, 0);
  job.visible = false;
  scene.add(job);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.85, 24, 18), new THREE.MeshBasicMaterial({ color: C.job, transparent: true, opacity: 0.12 }));
  job.add(halo);
  const chains = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: C.bad, transparent: true, opacity: 0.8 }));
  scene.add(chains);

  const parts = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), PARTICLES);
  parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  parts.count = 0;
  scene.add(parts);
  const P = Array.from({ length: PARTICLES }, () => ({ alive: false }));
  const dummy = new THREE.Object3D();

  // Labels alternate above and below the pipeline so neighbours never collide
  // in a narrow panel; data-k lets CSS hang the "below" ones from their anchor.
  const mk = (k) => { const d = document.createElement("div"); d.className = "lbl"; d.dataset.k = k; labelsEl.appendChild(d); return d; };
  const L = { clients: mk("clients"), api: mk("api"), pool: mk("pool"), bouncer: mk("bouncer"), pg: mk("pg"), job: mk("job") };
  const anchors = {
    clients: new THREE.Vector3(X.clients, 1.25, 0), api: new THREE.Vector3(X.api, -1.35, 0), pool: new THREE.Vector3(X.pool, 1.3, 0),
    bouncer: new THREE.Vector3(X.bouncer - 0.2, -1.35, 0), pg: new THREE.Vector3(X.pg, 1.5, 0), job: new THREE.Vector3((X.bouncer + X.pg) / 2, 2.7, 0),
  };

  // Fit the camera so the whole pipeline fills the frame at any aspect ratio.
  const span = { w: X.pg - X.clients + 4.6, h: 5.6 };
  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const vfov = (camera.fov * Math.PI) / 180;
    const distH = span.h / 2 / Math.tan(vfov / 2);
    const distW = span.w / 2 / (Math.tan(vfov / 2) * camera.aspect);
    const d = Math.max(distH, distW) * 1.02;
    const dir = new THREE.Vector3(0.0, 0.42, 1).normalize();
    camera.position.copy(target).addScaledVector(dir, d);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }

  let frame = null, run = null, mix = { ok: 1, bad: 0, shed: 0, rate: 0 }, spawnAcc = 0;

  function setRun(r) { run = r; for (const p of P) p.alive = false; }

  function setFrame(f, t) {
    frame = f;
    if (!f) return;
    let n = 0, ok = 0, shed = 0;
    for (const o of Object.values(f.ops || {})) {
      n += o.n; ok += o.ok;
      for (const [k, v] of Object.entries(o.errors || {})) if (k === "pool_exhausted" || k === "budget_exhausted") shed += v;
    }
    mix = n ? { ok: ok / n, shed: shed / n, bad: Math.max(0, (n - ok - shed) / n), rate: n } : { ok: 1, bad: 0, shed: 0, rate: 0 };
    const db = f.db || {};
    const acquired = Math.min(POOL, db.pool_acquired ?? 0), full = acquired >= POOL;
    pool.forEach((m, i) => {
      const on = i < acquired, c = on ? (full ? C.bad : C.busy) : C.idle;
      m.material.color.copy(c); m.material.emissive.copy(on ? c : dark); m.material.emissiveIntensity = on ? 0.55 : 0;
    });
    const waiting = Math.min(QUEUE_MAX, db.bouncer_cl_waiting ?? 0);
    queue.forEach((m, i) => (m.visible = i < waiting));
    const open = Math.min(SERVERS, db.pg_total ?? 0), busy = Math.min(open, db.pg_active ?? 0), lockw = Math.min(busy, db.pg_lock_wait ?? 0);
    servers.forEach((m, i) => {
      const c = i < lockw ? C.bad : i < busy ? C.busy : i < open ? C.wait : C.idle;
      m.material.color.copy(c); m.material.emissive.copy(i < busy ? c : dark); m.material.emissiveIntensity = i < busy ? 0.6 : 0;
      m.scale.y = i < open ? 1 : 0.35;
    });
    const nb = Math.min(BACKENDS, db.pg_total ?? 0), wb = Math.min(nb, db.pg_lock_wait ?? 0), ab = Math.min(nb, db.pg_active ?? 0);
    backends.forEach((m, i) => {
      m.visible = i < nb;
      const c = i < wb ? C.bad : i < ab ? C.busy : C.idle;
      m.material.color.copy(c); m.material.emissive.copy(i < ab ? c : dark);
    });
    const w = run && run.batch_window;
    const inJob = w && t >= w.start_s && t < w.end_s;
    job.visible = !!inJob;
    if (inJob) job.scale.setScalar(0.7 + Math.min(1.1, Math.log1p(t - w.start_s) / 3));
    const pts = [];
    if (inJob) for (let i = 0; i < wb; i++) {
      const p = backends[i].position.clone().add(pg.position);
      pts.push(job.position.x, job.position.y, job.position.z, p.x, p.y, p.z);
    }
    chains.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    chains.geometry.computeBoundingSphere();

    const jobName = run?.job || "job";
    L.clients.innerHTML = `clients<small>${mix.rate}/s</small>`;
    L.api.innerHTML = `API · Go<small>2 s deadline</small>`;
    L.pool.innerHTML = `pgx pool<small>${db.pool_acquired ?? "–"}/40 in use</small>`;
    L.pool.classList.toggle("hot", full);
    L.bouncer.innerHTML = `PgBouncer<small>${waiting ? `${waiting} waiting · ` : ""}${open}/20 conns</small>`;
    L.bouncer.classList.toggle("hot", waiting > 0);
    L.pg.innerHTML = `PostgreSQL 17<small>${db.pg_total ?? "–"} sessions${wb ? ` · ${wb} on locks` : ""}</small>`;
    L.pg.classList.toggle("hot", wb > 0);
    // the job's state rides on the PostgreSQL label: a separate floating
    // label collided with it in short panels
    if (inJob) L.pg.innerHTML += `<small class="jobline">${jobName} open ${Math.round(t - w.start_s)} s</small>`;
    L.job.innerHTML = "";
    L.job.style.display = "none";
    L.job.classList.add("job");
    if (reduceMotion) render();
  }

  function spawn(dt) {
    if (reduceMotion || !frame) return;
    spawnAcc += dt * Math.min(70, mix.rate / 7.5);
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const p = P.find((q) => !q.alive);
      if (!p) return;
      const r = Math.random();
      p.kind = r < mix.ok ? "ok" : r < mix.ok + mix.shed ? "shed" : "bad";
      Object.assign(p, { alive: true, x: X.clients, age: 0, z: (Math.random() - 0.5) * 1.2, y: (Math.random() - 0.5) * 0.8, v: 7 + Math.random() * 2, back: false, hold: 0 });
      p.stop = p.kind === "ok" ? X.pg - 1.4 : p.kind === "shed" ? X.pool - 0.9 : X.queue + 0.2;
    }
  }

  function step(dt) {
    let k = 0;
    for (const p of P) {
      if (!p.alive) continue;
      p.age += dt;
      if (!p.back) {
        p.x += p.v * dt;
        if (p.x >= p.stop) {
          p.x = p.stop;
          if (p.kind === "bad") { p.hold += dt; if (p.hold > 1.6) p.alive = false; } else p.back = true;
        }
      } else {
        p.x -= p.v * 1.3 * dt; p.y += 0.6 * dt;
        if (p.x <= X.clients) p.alive = false;
      }
      if (p.age > 8) p.alive = false;
      if (!p.alive) continue;
      dummy.position.set(p.x, p.y + (p.back ? 0.5 : 0), p.z + (p.back ? 0.35 : 0));
      dummy.scale.setScalar(p.kind === "bad" && p.hold ? 1 + p.hold * 0.6 : 1);
      dummy.updateMatrix();
      parts.setMatrixAt(k, dummy.matrix);
      parts.setColorAt(k, p.kind === "ok" ? C.ok : p.kind === "shed" ? C.shed : C.bad);
      k++;
    }
    parts.count = k;
    parts.instanceMatrix.needsUpdate = true;
    if (parts.instanceColor) parts.instanceColor.needsUpdate = true;
  }

  const v = new THREE.Vector3();
  function place() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const [k, a] of Object.entries(anchors)) {
      v.copy(a).project(camera);
      // keep every label fully inside the canvas: "above" labels hang up from
      // their anchor, "below" ones (api, bouncer) hang down
      const el = L[k], ow = el.offsetWidth, oh = el.offsetHeight, below = k === "api" || k === "bouncer";
      const x = Math.max(ow / 2 + 4, Math.min(w - ow / 2 - 4, ((v.x + 1) / 2) * w));
      const y0 = ((1 - v.y) / 2) * h;
      const y = below ? Math.min(h - oh - 4, y0) : Math.max(oh + 4, y0);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }
  // A lost or broken WebGL context makes three.js throw while rendering;
  // stop drawing and show the no-WebGL notice instead of throwing every frame.
  let dead = false;
  function render() {
    if (dead) return;
    try { renderer.render(scene, camera); place(); } catch { dead = true; onLost?.(true); }
  }

  let last = performance.now(), visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);
  new ResizeObserver(() => { fit(); render(); }).observe(canvas);
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (visible && canvas.clientWidth) {
      spawn(dt); step(dt);
      clients.rotation.x += dt * 0.6;
      if (job.visible) { job.rotation.y += dt * 0.8; job.rotation.x += dt * 0.3; halo.material.opacity = 0.1 + 0.06 * Math.sin(now / 300); }
      render();
    }
    requestAnimationFrame(loop);
  }
  fit();
  if (reduceMotion) render(); else requestAnimationFrame(loop);
  return { setRun, setFrame, resize() { fit(); render(); } };
}
