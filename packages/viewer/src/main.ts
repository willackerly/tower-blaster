// Interactive viewer: any PhysicsEngine, rendered live. Physics runs on the
// main thread at a fixed 60 Hz (at most two steps per frame; slower engines
// fall into slow motion, shown as sim speed).
import { makeEngine } from '@tb/bench';
import { type BodyDesc, type InputEvent, type PhysicsEngine, type SceneDesc, TAG_BALL } from '@tb/engine-api';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import { clampPitch, frame, rayThrough, viewProj, eyeOf, type Orbit } from './camera.ts';
import { newClock, stepsDue, Window } from './loop.ts';
import type { V3 } from './math.ts';
import { parseViewerConfig, toSearch, type ViewerConfig } from './params.ts';
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
];

interface ViewerHandle {
  status: 'loading' | 'running' | 'error';
  error?: string;
  frames: number;
  bodies: number;
  stepIndex: number;
  /** Fire a ball through normalized device coords (0, 0 = centre). */
  fire(ndcX?: number, ndcY?: number): void;
  capture(keepPixels?: boolean): Promise<PixelStats | null>;
  inputs: InputEvent[];
}
declare global { interface Window { __viewer: ViewerHandle } }

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const errorBox = document.getElementById('error')!;
const handle: ViewerHandle = { status: 'loading', frames: 0, bodies: 0, stepIndex: 0, fire: () => {}, capture: async () => null, inputs: [] };
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
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.textContent = p.label;
    if (parseViewerConfig(p.search).scenario === parseViewerConfig(current).scenario && toSearch(parseViewerConfig(p.search)) === toSearch(parseViewerConfig(current))) b.className = 'on';
    b.onclick = () => { location.search = p.search; };
    box.appendChild(b);
  }
}

async function main() {
  const config = parseViewerConfig(location.search);
  presets(location.search);
  const { device, adapter } = await createDevice({ timestamps: false });
  const renderer = new Renderer(device, config.offscreen ? { size: [640, 400] } : { canvas });
  const source = new SnapshotSource(device);
  renderer.setSource(source);
  renderer.look = LOOKS[config.look] ?? CANDY_NIGHT;
  renderer.device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  renderer.device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));

  let engine: PhysicsEngine = makeEngine(config.engine);
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

  const ballDesc = (origin: V3, dir: V3): BodyDesc => ({
    shape: { kind: 'sphere', radius: 0.7 },
    pos: [origin[0] + dir[0] * 2, origin[1] + dir[1] * 2, origin[2] + dir[2] * 2],
    rot: [0, 0, 0, 1],
    linVel: [dir[0] * 40, dir[1] * 40, dir[2] * 40],
    angVel: [0, 0, 0],
    density: 8,
    friction: 0.5,
    restitution: 0.1,
    tag: TAG_BALL,
  });

  async function reset() {
    engine.dispose();
    engine = makeEngine(config.engine);
    scene = sceneFor(config);
    await engine.init(scene);
    events = [...scene.inputs];
    shapes = [...scene.bodies];
    source.reset(scene.bodies);
    const b = bounds(scene.bodies);
    orbit = frame(b.min, b.max);
    const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    renderer.setShadowBounds(c, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 + 2);
    handle.inputs = [];
    await refresh();
  }

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
    awake = s.awake.reduce((a, x) => a + x, 0);
  }
  let awake = 0;

  handle.fire = (x = 0, y = 0) => {
    const { origin, dir } = rayThrough(orbit, aspect(), x, y);
    const ev: InputEvent = { step: engine.stepIndex, kind: 'spawn', body: ballDesc(origin, dir) };
    engine.push([ev]);
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
    if (e.key === ' ') { e.preventDefault(); handle.fire(0, 0); }
    if (e.key === 'r' || e.key === 'R') void reset().catch(fail);
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
      <div class="muted">${SCENARIOS[config.scenario]!.title} · ${config.engine} (${engine.info.backend})</div>
      <div class="row"><span>physics ms/step</span><span class="${over ? 'warn' : ''}">${fmt(med)} <span class="muted">p95 ${fmt(p95)}</span></span></div>
      <div class="row"><span>awake</span><span>${awake.toLocaleString()}</span></div>
      <div class="row"><span>fps</span><span>${fmt(fps)}</span></div>
      <div class="row"><span>sim speed</span><span class="${clock.simSpeed < 0.95 ? 'warn' : ''}">${(clock.simSpeed * 100).toFixed(0)}%</span></div>
      <div class="row"><span>snapshot + upload</span><span>${fmt(snapMs.quantile(0.5))} ms</span></div>
      <div class="row muted"><span>budget</span><span>7.5 ms/step</span></div>
      <div class="muted">${adapter.info.vendor} ${adapter.info.architecture}${paused ? ' · <b>paused</b>' : ''}</div>`;
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
    const n = paused ? 0 : stepsDue(clock, frameMs, scene.dt);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await engine.step();
      stepMs.push(performance.now() - t0);
      if (config.autofire && engine.stepIndex === config.autofire) handle.fire(0, 0);
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
