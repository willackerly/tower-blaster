// Interactive viewer: any PhysicsEngine, rendered live. Physics runs on the
// main thread at a fixed 60 Hz (one step per frame by default, maxSteps in the
// URL allows catch-up; slower engines fall into slow motion, shown as sim speed).
import { makeEngine, parseSpec } from '@tb/bench';
import { type BodyDesc, type InputEvent, type PhysicsEngine, type SceneDesc } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { DEFAULT_AVBD } from '@tb/physics-ref';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import { clampPitch, frame, rayThrough, viewProj, eyeOf, type Orbit } from './camera.ts';
import { newClock, stepsDue, Window } from './loop.ts';
import type { V3 } from './math.ts';
import { escapeHtml } from './html.ts';
import { engineSpec, parseViewerConfig, presetSearch, toSearch, type ViewerConfig, withOption } from './params.ts';
import { projectileBody, projectileShape, pushRadiusLimit } from './projectile.ts';
import { mountControls } from './controls.ts';
import { createDevice } from '@tb/gpu';
import { CANDY_NIGHT, LOOKS, Renderer, SnapshotSource, type PixelStats } from '@tb/render';

const PRESETS: Array<{ label: string; search: string }> = [
  { label: 'Tower 8×8×30', search: '?scenario=S1&param.gap=0.02' },
  { label: 'City 2k', search: '?scenario=S4&param.N=2000&param.F=4&param.H=12' },
  { label: 'City 5k', search: '?scenario=S4&param.N=5000&param.F=5&param.H=16' },
  { label: 'City 10k', search: '?scenario=S4&param.N=10000&param.F=6&param.H=20' },
  { label: 'Wall 50×20', search: '?scenario=S3' },
  { label: 'Pyramid', search: '?scenario=S2&param.C=20' },
  { label: 'Slabs and rods', search: '?scenario=S8&param.floors=15' },
  { label: 'Cube rain 3k', search: '?scenario=S6&param.N=3000' },
  { label: 'Wall with a hole', search: '?scenario=S12' },
  { label: 'Leaning column', search: '?scenario=S13' },
  { label: 'Buildings', search: '?scenario=S14&param.vary=0.5' },
];

const ENGINES: Array<{ label: string; spec: string }> = [
  { label: 'GPU AVBD', spec: 'avbd-gpu' },
  { label: 'Rapier (CPU)', spec: 'rapier' },
  { label: 'Tiered (CPU)', spec: 'tiered' },
];

// Solver iterations for the GPU engine: a tall column flexes and topples
// early at the default 10; 20 cubes are rigid from 13 (physics-ref/test/collapse.test.ts).
const GPU_ITERATIONS = [10, 20, 40];

const viewerEngine = (c: ViewerConfig): PhysicsEngine => makeEngine(engineSpec(c.engine, c.projectile));

interface ViewerHandle {
  status: 'loading' | 'running' | 'error';
  error?: string;
  frames: number;
  bodies: number;
  /** Bodies the last snapshot reports awake (dormant and frozen ones are not). */
  awake: number;
  stepIndex: number;
  /** Scene loads so far: 1 after start, one more per R. */
  resets: number;
  /** Fire a ball through normalized device coords (0, 0 = centre). */
  fire(ndcX?: number, ndcY?: number): void;
  capture(keepPixels?: boolean): Promise<PixelStats | null>;
  inputs: InputEvent[];
}
declare global { interface Window { __viewer: ViewerHandle } }

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const errorBox = document.getElementById('error')!;
const handle: ViewerHandle = { status: 'loading', frames: 0, bodies: 0, awake: 0, stepIndex: 0, resets: 0, fire: () => {}, capture: async () => null, inputs: [] };
window.__viewer = handle;

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  handle.status = 'error';
  handle.error = msg;
  errorBox.style.display = 'block';
  errorBox.textContent = `Error: ${msg}`;
  console.error(e);
}

function sceneFor(c: ViewerConfig): SceneDesc {
  const s = buildScenario(c.scenario, c.params, c.seed);
  return c.sleep === null ? s : { ...s, sleep: c.sleep };
}

function bounds(bodies: BodyDesc[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, 0, Infinity], max: V3 = [-Infinity, 1, -Infinity];
  for (const b of bodies) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k]!, b.pos[k]! - 1);
    max[k] = Math.max(max[k]!, b.pos[k]! + 1);
  }
  return { min, max };
}

function presets(current: string) {
  const box = document.getElementById('presets')!;
  box.replaceChildren();
  const config = parseViewerConfig(current);
  for (const e of ENGINES) {
    const b = document.createElement('button');
    b.textContent = e.label;
    if (parseSpec(config.engine).name === e.spec) b.className = 'on';
    b.onclick = () => { location.search = toSearch({ ...parseViewerConfig(location.search), engine: e.spec }); };
    box.appendChild(b);
  }
  const { name, options } = parseSpec(config.engine);
  if (name === 'avbd-gpu') {
    for (const n of GPU_ITERATIONS) {
      const b = document.createElement('button');
      b.textContent = `${n} iterations`;
      if ((options.iterations ?? DEFAULT_AVBD.iterations) === n) b.className = 'on';
      b.onclick = () => {
        const c = parseViewerConfig(location.search);
        location.search = toSearch({ ...c, engine: withOption(c.engine, 'iterations', n === DEFAULT_AVBD.iterations ? undefined : n) });
      };
      box.appendChild(b);
    }
  }
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.textContent = p.label;
    if (presetSearch(p.search, config.engine, config.projectile) === toSearch(config)) b.className = 'on';
    b.onclick = () => {
      const c = parseViewerConfig(location.search);
      location.search = presetSearch(p.search, c.engine, c.projectile);
    };
    box.appendChild(b);
  }
}

async function main() {
  let config = parseViewerConfig(location.search);
  presets(location.search);
  const { device, adapter } = await createDevice({ timestamps: false });
  const renderer = new Renderer(device, config.offscreen ? { size: [640, 400] } : { canvas });
  const source = new SnapshotSource(device);
  renderer.setSource(source);
  renderer.look = LOOKS[config.look] ?? CANDY_NIGHT;
  renderer.device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  renderer.device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));

  let engine: PhysicsEngine = viewerEngine(config);
  let scene = sceneFor(config);
  // Engine body i has shape shapes[i]: initial bodies, then spawns in
  // (step, push order), the same order the engine applies them.
  let events: InputEvent[] = [];
  let shapes: BodyDesc[] = [];
  let orbit: Orbit;
  const clock = newClock();
  const stepMs = new Window(120);
  const snapMs = new Window(60);
  let paused = false;
  let fps = 60;
  let notice = '';
  // R asks for a reset, which the frame loop runs between frames: the GPU
  // engine's init() takes longer than a frame, and no frame may step or read
  // an engine that is not ready (or that reset() has just disposed).
  let resetAsked = false;
  let resetting = false;
  // The control panel asks for a new config by setting nextConfig and resetAsked (never by calling
  // reset() itself), so a reset still runs only where the frame loop runs it. resetNote is shown after it.
  let nextConfig: ViewerConfig | null = null;
  let resetNote = '';
  // Largest projectile the engine accepts without a rebuild (pushRadiusLimit).
  let pushLimit = Infinity;

  async function reset() {
    resetting = true;
    const prev = config, want = nextConfig ?? config;
    nextConfig = null;
    try {
      await load(want);
      notice = resetNote;
    } catch (e) {
      if (want === prev) throw e;
      // An engine that can't hold the new scene (GPU storage limits, say): go back to the last one.
      await load(prev);
      notice = `Kept the previous scene: ${e instanceof Error ? e.message : String(e)}`;
    }
    resetNote = '';
    if (config !== prev) {
      history.replaceState(null, '', toSearch(config));
      presets(location.search);
    }
    controls.refresh();
    resetting = false;
    handle.stepIndex = engine.stepIndex;
    handle.resets++;
  }

  async function load(want: ViewerConfig) {
    const next = sceneFor(want); // throws on bad params before anything is torn down
    engine.dispose();
    engine = viewerEngine(want);
    config = want;
    scene = next;
    pushLimit = pushRadiusLimit(engineSpec(want.engine, want.projectile), scene);
    await engine.init(scene);
    events = [...scene.inputs];
    shapes = [...scene.bodies];
    source.reset(scene.bodies);
    const b = bounds(scene.bodies);
    orbit = frame(b.min, b.max);
    const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    renderer.setShadowBounds(c, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 + 2);
    handle.inputs = [];
    notice = '';
    await refresh();
  }

  const controls = mountControls(document.getElementById('controls')!, {
    config: () => config,
    rebuild(next) {
      nextConfig = next;
      resetAsked = true;
    },
    setProjectile(p) {
      // A rebuild already queued takes the projectile with it (and sizes its engine for it).
      if (nextConfig) {
        nextConfig = { ...nextConfig, projectile: p };
        return;
      }
      const next = { ...config, projectile: p };
      if (boundingRadius(projectileShape(p)) <= pushLimit) {
        config = next;
        history.replaceState(null, '', toSearch(config));
        return;
      }
      // The GPU engine sizes its broadphase grid for the largest body at init, so a bigger projectile needs a new engine.
      nextConfig = next;
      resetNote = 'Rebuilt the scene: the GPU engine sizes its grid for the largest body when it starts';
      resetAsked = true;
    },
  });

  function shapesFor(count: number): BodyDesc[] {
    while (shapes.length < count) shapes.push(events[shapes.length - scene.bodies.length]!.body);
    return shapes;
  }

  async function refresh() {
    const t0 = performance.now();
    const s = await engine.snapshot();
    source.update(s, shapesFor(s.count));
    snapMs.push(performance.now() - t0);
    handle.bodies = s.count;
    awake = handle.awake = s.awake.reduce((a, x) => a + x, 0);
  }
  let awake = 0;

  handle.fire = (x = 0, y = 0) => {
    if (resetting) return;
    const { origin, dir } = rayThrough(orbit, aspect(), x, y);
    const ev: InputEvent = { step: engine.stepIndex, kind: 'spawn', body: projectileBody(config.projectile, origin, dir) };
    try {
      engine.push([ev]);
    } catch (e) {
      // The GPU and tiered engines have room for GPU_SPARE fired projectiles (params.ts); R resets.
      notice = `${e instanceof Error ? e.message : String(e)} (press R to reset)`;
      drawHud();
      return;
    }
    handle.inputs.push(ev);
    // Keep events in engine application order: stable by step.
    let i = events.length;
    while (i > 0 && events[i - 1]!.step > ev.step) i--;
    events.splice(i, 0, ev);
  };

  // Pointer: drag orbits (right or shift: pan), a click without drag fires.
  let drag: { x: number; y: number; moved: number; pan: boolean } | null = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) {
      const s = orbit.distance * 0.0015;
      const cy = Math.cos(orbit.yaw), sy = Math.sin(orbit.yaw);
      orbit.target = [orbit.target[0] - (dx * cy) * s, orbit.target[1] + dy * s, orbit.target[2] + (dx * sy) * s];
    } else {
      orbit.yaw -= dx * 0.005;
      orbit.pitch = clampPitch(orbit.pitch + dy * 0.005);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && drag.moved < 5 && e.button === 0 && !e.shiftKey) {
      const r = canvas.getBoundingClientRect();
      handle.fire(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.distance = Math.min(800, Math.max(3, orbit.distance * Math.exp(e.deltaY * 0.001)));
  }, { passive: false });
  addEventListener('keydown', (e) => {
    // Typing in the control panel is not a command.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ') { e.preventDefault(); handle.fire(0, 0); }
    if (e.key === 'r' || e.key === 'R') resetAsked = true;
    if (e.key === 'p' || e.key === 'P') paused = !paused;
  });

  const aspect = () => (config.offscreen ? 640 / 400 : canvas.width / canvas.height);

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  const fmt = (x: number) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) : '–');
  function drawHud() {
    const med = stepMs.quantile(0.5), p95 = stepMs.quantile(0.95);
    const over = med > 7.5;
    hud.innerHTML = `
      <div class="big">${handle.bodies.toLocaleString()} bodies</div>
      <div class="muted">${SCENARIOS[config.scenario]!.title} · ${escapeHtml(config.engine)} (${escapeHtml(engine.info.backend)})</div>
      <div class="row"><span>physics ms/step</span><span class="${over ? 'warn' : ''}">${fmt(med)} <span class="muted">p95 ${fmt(p95)}</span></span></div>
      <div class="row"><span>awake</span><span>${awake.toLocaleString()}</span></div>
      <div class="row"><span>fps</span><span>${fmt(fps)}</span></div>
      <div class="row"><span>sim speed</span><span class="${clock.simSpeed < 0.95 ? 'warn' : ''}">${(clock.simSpeed * 100).toFixed(0)}%</span></div>
      <div class="row"><span>snapshot + upload</span><span>${fmt(snapMs.quantile(0.5))} ms</span></div>
      <div class="row muted"><span>budget</span><span>7.5 ms/step</span></div>
      <div class="muted">${escapeHtml(adapter.info.vendor)} ${escapeHtml(adapter.info.architecture)}${paused ? ' · <b>paused</b>' : ''}</div>${notice ? `\n      <div class="warn">${escapeHtml(notice)}</div>` : ''}`;
  }

  await reset();
  handle.status = 'running';
  let last = performance.now();
  let pendingCapture: { resolve: (s: PixelStats | null) => void; keep: boolean } | null = null;
  handle.capture = (keep = false) => new Promise((resolve) => { pendingCapture = { resolve, keep }; });

  const tick = async () => {
    const now = performance.now();
    const frameMs = now - last;
    last = now;
    fps = 0.9 * fps + 0.1 * (1000 / Math.max(frameMs, 1));
    resize();
    if (resetAsked) { resetAsked = false; await reset(); }
    const n = paused ? 0 : stepsDue(clock, frameMs, scene.dt, config.maxSteps);
    // A GPU engine's step() only submits, so its steps are timed to completion with finish().
    // refresh() waits for the GPU anyway to read a snapshot back; the wait adds one
    // queue-completion round trip before that readback's copy is submitted.
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const ts = performance.now();
      await engine.step();
      if (!engine.finish) stepMs.push(performance.now() - ts);
      if (config.autofire && engine.stepIndex === config.autofire) handle.fire(0, 0);
    }
    if (n > 0 && engine.finish) {
      await engine.finish();
      const per = (performance.now() - t0) / n;
      for (let i = 0; i < n; i++) stepMs.push(per);
    }
    handle.stepIndex = engine.stepIndex;
    if (n > 0) await refresh();
    const want = pendingCapture;
    pendingCapture = null;
    const stats = await renderer.render({ viewProj: viewProj(orbit, aspect()), eye: eyeOf(orbit), focus: orbit.target, time: now / 1000, groundY: scene.ground?.y ?? 0, alpha: paused ? 1 : clock.acc / scene.dt }, !!want, want?.keep);
    if (want) want.resolve(stats);
    handle.frames++;
    if (handle.frames % 10 === 1) drawHud();
    if (handle.status === 'running') requestAnimationFrame(() => void tick().catch(fail));
  };
  requestAnimationFrame(() => void tick().catch(fail));
}

main().catch(fail);
