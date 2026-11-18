// The 3D view: requests flow left to right from clients through the API and its
// pgx pool (40 slots), PgBouncer (a waiting queue and 20 server connections),
// to PostgreSQL. The batch transaction is the orange object above the
// database; while it holds row locks, chains link it to the backends that wait.
// Everything is driven by the current frame; nothing is simulated beyond the
// particles, whose colours follow the frame's success and error counts.

const POOL = 40, SERVERS = 20, QUEUE_MAX = 40, BACKENDS = 24, PARTICLES = 520;
const X = { clients: -11, api: -6.6, pool: -3.2, queue: 0.4, bouncer: 3.0, pg: 8.2 };

export async function createScene(canvas, labelsEl, { reduceMotion }) {
  if (!window.WebGLRenderingContext) return null;
  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  // If the GPU drops the context and does not give it back, say so instead of
  // leaving an empty box.
  let lostTimer = null;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lostTimer = setTimeout(() => { const n = document.getElementById("nogl"); if (n) n.hidden = false; }, 3000);
  });
  canvas.addEventListener("webglcontextrestored", () => {
    clearTimeout(lostTimer);
    const n = document.getElementById("nogl"); if (n) n.hidden = true;
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 2, 0.1, 200);
  camera.position.set(-1.5, 9.5, 18.5);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(-0.8, 0, 0);
  controls.enableDamping = true;
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.35;
  controls.minAzimuthAngle = -0.9;
  controls.maxAzimuthAngle = 0.9;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(4, 12, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0x818cf8, 30, 40);
  rim.position.set(-8, 6, -6);
  scene.add(rim);

  const C = {
    ok: new THREE.Color("#34d399"), bad: new THREE.Color("#f43f5e"), shed: new THREE.Color("#fbbf24"),
    batch: new THREE.Color("#fb923c"), idle: new THREE.Color("#3b4670"), busy: new THREE.Color("#5eead4"),
    wait: new THREE.Color("#f43f5e"), accent2: new THREE.Color("#818cf8"),
  };
  const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...opts });

  // floor
  const grid = new THREE.GridHelper(40, 40, 0x334066, 0x1f2747);
  grid.position.y = -1.2;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  // track the requests travel along
  const track = new THREE.Mesh(new THREE.BoxGeometry(X.pg - X.clients, 0.04, 1.6), std(0x1b2448, { transparent: true, opacity: 0.6 }));
  track.position.set((X.pg + X.clients) / 2, -0.95, 0);
  scene.add(track);

  // clients
  const clients = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.08, 12, 48), std(C.accent2, { emissive: C.accent2, emissiveIntensity: 0.6 }));
  clients.position.set(X.clients, 0, 0);
  clients.rotation.y = Math.PI / 2;
  scene.add(clients);

  // API
  const api = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.8, 1.8), std(0x2a3563, { transparent: true, opacity: 0.85 }));
  api.position.set(X.api, 0, 0);
  scene.add(api);

  // pgx pool: 8 x 5 slots
  const slotGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const m = new THREE.Mesh(slotGeo, std(C.idle.clone(), { emissive: new THREE.Color(0), emissiveIntensity: 0.9 }));
    m.position.set(X.pool - 0.9 + (i % 5) * 0.45, -0.7 + Math.floor(i / 5) * 0.42, 0);
    scene.add(m);
    pool.push(m);
  }

  // PgBouncer queue (clients waiting for a server connection)
  const qGeo = new THREE.SphereGeometry(0.13, 12, 10);
  const queue = [];
  for (let i = 0; i < QUEUE_MAX; i++) {
    const m = new THREE.Mesh(qGeo, std(C.shed, { emissive: C.shed, emissiveIntensity: 0.6 }));
    m.position.set(X.queue - (i % 4) * 0.32, -0.75 + Math.floor(i / 4) * 0.3, 0.9);
    m.visible = false;
    scene.add(m);
    queue.push(m);
  }

  // PgBouncer server connections: 5 x 4 cylinders
  const srvGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.5, 16);
  const servers = [];
  for (let i = 0; i < SERVERS; i++) {
    const m = new THREE.Mesh(srvGeo, std(C.idle.clone(), { emissive: new THREE.Color(0), emissiveIntensity: 0.9 }));
    m.position.set(X.bouncer - 0.8 + (i % 5) * 0.4, -0.65 + Math.floor(i / 5) * 0.6, 0);
    scene.add(m);
    servers.push(m);
  }

  // PostgreSQL: a database drum with a ring of backends
  const pg = new THREE.Group();
  pg.position.set(X.pg, 0, 0);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 2.2, 48), std(0x24325f, { transparent: true, opacity: 0.9 }));
  pg.add(drum);
  for (const y of [-0.55, 0.15, 0.85]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.52, 0.03, 8, 64), std(C.accent2, { emissive: C.accent2, emissiveIntensity: 0.5 }));
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    pg.add(band);
  }
  const backends = [];
  const bGeo = new THREE.SphereGeometry(0.14, 14, 12);
  for (let i = 0; i < BACKENDS; i++) {
    const a = (i / BACKENDS) * Math.PI * 2;
    const m = new THREE.Mesh(bGeo, std(C.idle.clone(), { emissive: new THREE.Color(0), emissiveIntensity: 1 }));
    m.position.set(Math.cos(a) * 1.95, -1.0, Math.sin(a) * 1.95);
    m.visible = false;
    pg.add(m);
    backends.push(m);
  }
  scene.add(pg);

  // the batch transaction
  const batch = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), std(C.batch, { emissive: C.batch, emissiveIntensity: 1.2, flatShading: true }));
  batch.position.set(X.pg, 2.6, 0);
  batch.visible = false;
  scene.add(batch);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 18), new THREE.MeshBasicMaterial({ color: C.batch, transparent: true, opacity: 0.12 }));
  batch.add(halo);
  const chainMat = new THREE.LineBasicMaterial({ color: C.bad, transparent: true, opacity: 0.85 });
  const chains = new THREE.LineSegments(new THREE.BufferGeometry(), chainMat);
  scene.add(chains);

  // particles
  const pGeo = new THREE.SphereGeometry(0.075, 8, 6);
  const pMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const parts = new THREE.InstancedMesh(pGeo, pMat, PARTICLES);
  parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(parts);
  const P = Array.from({ length: PARTICLES }, () => ({ alive: false }));
  const dummy = new THREE.Object3D();

  // labels (HTML, projected)
  const mkLabel = () => { const d = document.createElement("div"); d.className = "lbl"; labelsEl.appendChild(d); return d; };
  const L = { api: mkLabel(), pool: mkLabel(), bouncer: mkLabel(), pg: mkLabel(), batch: mkLabel(), clients: mkLabel() };
  const anchors = {
    clients: new THREE.Vector3(X.clients, 1.3, 0), api: new THREE.Vector3(X.api, 1.3, 0), pool: new THREE.Vector3(X.pool, 1.4, 0),
    bouncer: new THREE.Vector3(X.bouncer - 0.3, 1.9, 0), pg: new THREE.Vector3(X.pg, 1.6, 0), batch: new THREE.Vector3(X.pg, 3.5, 0),
  };

  let frame = null, run = null, tNow = 0;
  let mix = { ok: 1, bad: 0, shed: 0, rate: 0 };
  let spawnAcc = 0;

  function setRun(r) { run = r; for (const p of P) p.alive = false; }

  function setFrame(f, t) {
    frame = f; tNow = t;
    if (!f) return;
    let n = 0, ok = 0, shed = 0;
    for (const o of Object.values(f.ops)) {
      n += o.n; ok += o.ok;
      for (const [k, v] of Object.entries(o.errors || {})) if (k === "pool_exhausted" || k === "budget_exhausted") shed += v;
    }
    mix = n ? { ok: ok / n, shed: shed / n, bad: Math.max(0, (n - ok - shed) / n), rate: n } : { ok: 1, bad: 0, shed: 0, rate: 0 };
    const db = f.db || {};
    const acquired = Math.min(POOL, db.pool_acquired ?? 0);
    const full = acquired >= POOL;
    pool.forEach((m, i) => {
      const on = i < acquired;
      m.material.color.copy(on ? (full ? C.bad : C.busy) : C.idle);
      m.material.emissive.copy(on ? (full ? C.bad : C.busy) : new THREE.Color(0));
      m.material.emissiveIntensity = on ? 0.55 : 0;
    });
    const waiting = Math.min(QUEUE_MAX, db.bouncer_cl_waiting ?? 0);
    queue.forEach((m, i) => (m.visible = i < waiting));
    const open = Math.min(SERVERS, db.pg_total ?? 0), busy = Math.min(open, db.pg_active ?? 0), lockw = Math.min(busy, db.pg_lock_wait ?? 0);
    servers.forEach((m, i) => {
      const c = i < lockw ? C.wait : i < busy ? C.busy : i < open ? C.accent2 : C.idle;
      m.material.color.copy(c);
      m.material.emissive.copy(i < busy ? c : new THREE.Color(0));
      m.material.emissiveIntensity = i < busy ? 0.6 : 0;
      m.scale.y = i < open ? 1 : 0.35;
    });
    const nb = Math.min(BACKENDS, db.pg_total ?? 0), wb = Math.min(nb, db.pg_lock_wait ?? 0), ab = Math.min(nb, db.pg_active ?? 0);
    backends.forEach((m, i) => {
      m.visible = i < nb;
      const c = i < wb ? C.wait : i < ab ? C.busy : C.idle;
      m.material.color.copy(c);
      m.material.emissive.copy(i < ab ? c : new THREE.Color(0));
    });
    const bw = run && run.batch_window;
    const inBatch = bw && t >= bw.start_s && t < bw.end_s;
    batch.visible = !!inBatch;
    if (inBatch) {
      const age = Math.max(0, t - bw.start_s);
      batch.scale.setScalar(0.7 + Math.min(1.1, Math.log1p(age) / 3));
    }
    // chains from the batch to lock-waiting backends
    const pts = [];
    if (inBatch && wb > 0) {
      for (let i = 0; i < wb; i++) {
        const w = backends[i].position.clone().add(pg.position);
        pts.push(batch.position.x, batch.position.y, batch.position.z, w.x, w.y, w.z);
      }
    }
    chains.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    chains.geometry.computeBoundingSphere();

    const sec = (v) => `${Math.round(v)} s`;
    L.clients.innerHTML = `clients<small>${mix.rate}/s</small>`;
    L.api.innerHTML = `API · Go<small>2 s budget</small>`;
    L.pool.innerHTML = `pgx pool<small>${db.pool_acquired ?? "–"}/40 in use</small>`;
    L.pool.classList.toggle("hot", full);
    L.bouncer.innerHTML = `PgBouncer<small>${waiting ? waiting + " queued · " : ""}${open}/20 conns</small>`;
    L.bouncer.classList.toggle("hot", waiting > 0);
    L.pg.innerHTML = `PostgreSQL 17<small>${db.pg_total ?? "–"} sessions${wb ? ` · ${wb} waiting on locks` : ""}</small>`;
    L.pg.classList.toggle("hot", wb > 0);
    L.batch.innerHTML = inBatch ? `batch transaction<small>open ${sec(t - bw.start_s)}</small>` : "";
    L.batch.style.display = inBatch ? "" : "none";
    if (reduceMotion) render();
  }

  function spawn(dt) {
    if (reduceMotion || !frame) return;
    // about 40 particles per second at 300 req/s, so the picture stays readable
    spawnAcc += dt * Math.min(70, mix.rate / 7.5);
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const p = P.find((q) => !q.alive);
      if (!p) return;
      const r = Math.random();
      p.kind = r < mix.ok ? "ok" : r < mix.ok + mix.shed ? "shed" : "bad";
      p.alive = true; p.x = X.clients; p.age = 0;
      p.z = (Math.random() - 0.5) * 1.2; p.y = (Math.random() - 0.5) * 0.8;
      p.v = 7 + Math.random() * 2;
      p.back = false;
      p.stop = p.kind === "ok" ? X.pg - 1.4 : p.kind === "shed" ? X.pool - 0.8 : X.queue + 0.2;
    }
  }

  function stepParticles(dt) {
    let k = 0;
    for (const p of P) {
      if (!p.alive) continue;
      p.age += dt;
      if (!p.back) {
        p.x += p.v * dt;
        if (p.x >= p.stop) {
          p.x = p.stop;
          if (p.kind === "bad") { p.hold = (p.hold ?? 0) + dt; if (p.hold > 1.6) p.alive = false; }
          else p.back = true;
        }
      } else {
        p.x -= p.v * 1.3 * dt;
        p.y += 0.6 * dt;
        if (p.x <= X.clients) p.alive = false;
      }
      if (p.age > 8) p.alive = false;
      if (!p.alive) { p.hold = 0; continue; }
      dummy.position.set(p.x, p.y + (p.back ? 0.5 : 0), p.z + (p.back ? 0.35 : 0));
      const s = p.kind === "bad" && p.hold ? 1 + p.hold * 0.6 : 1;
      dummy.scale.setScalar(s);
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
  function placeLabels() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const [k, a] of Object.entries(anchors)) {
      v.copy(a).project(camera);
      const el = L[k];
      el.style.left = `${((v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - v.y) / 2) * h}px`;
    }
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 640 ? 58 : 42;
    camera.updateProjectionMatrix();
  }
  function render() { controls.update(); renderer.render(scene, camera); placeLabels(); }

  let last = performance.now(), visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (visible) {
      if (!reduceMotion) {
        spawn(dt); stepParticles(dt);
        clients.rotation.x += dt * 0.6;
        if (batch.visible) { batch.rotation.y += dt * 0.8; batch.rotation.x += dt * 0.3; halo.material.opacity = 0.1 + 0.06 * Math.sin(now / 300); }
      }
      render();
    }
    requestAnimationFrame(loop);
  }
  resize();
  if (reduceMotion) { parts.count = 0; render(); controls.addEventListener("change", render); }
  else requestAnimationFrame(loop);

  return { setRun, setFrame, resize, setTheme() {} };
}
