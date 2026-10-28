// Interactive viewer: any PhysicsEngine, rendered live. Physics runs on the
// main thread at a fixed 60 Hz. By default (loop=free) it steps in its own loop,
// back to back while steps are due, and every display frame renders the newest
// snapshots (a CPU engine blocks the thread while it steps, so its frames run
// between steps); loop=frame steps, reads back and renders in series, one step
// per frame (maxSteps allows catch-up). Slower engines fall into slow motion,
// shown as sim speed. rules=keystone hands the page to the game's loop (@tb/game
// playKeystone; keystoneMode below), with the panel kept.
import { makeEngine, parseSpec } from '@tb/bench';
import { type BodyDesc, type EngineInfo, type InputEvent, type PhysicsEngine, type Snapshot, spawnedBodies } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { DEFAULT_AVBD } from '@tb/physics-ref';
import { GAME_HELP, gameOverlays, playLine, type GameHandle, installGameStyles, newGameHandle, playKeystone, structureTints } from '@tb/game';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, type Driver, LEVELS, type Shot } from '@tb/keystone';
import { clampPitch, frame, rayThrough, viewProj, eyeOf, orbitAt, poseOf, type CameraPose, type Orbit } from './camera.ts';
import { alphaAt, newArrivals, newClock, newPacer, pauseLatch, runFree, stepsDue, taskYield, trackSimSpeed, Window } from './loop.ts';
import type { V3 } from './math.ts';
import { escapeHtml } from './html.ts';
import { bounceOn, engineSpec, firedBody, froudeSpeed, keystoneEngine, levelOf, parseViewerConfig, presetSearch, scenarioEngineSpec, sceneTitle, toSearch, type ViewerConfig, viewerScene, withOption, worldEngineSpec } from './params.ts';
import { projectileRadius, pushRadiusLimit, worldGrenade } from './projectile.ts';
import { Grenades } from '@tb/weapons';
import { mountControls } from './controls.ts';
import { type DevAction, mountDev } from './dev-panel.ts';
import { createDevice } from '@tb/gpu';
import { lookByName, Renderer, SnapshotSource, srgbToLinear, type PixelStats } from '@tb/render';

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

/** The AVBD settings Keystone plays and pins par lines at (@tb/keystone AVBD_ITERATIONS, AVBD_GAP_SLOP), one button away. */
const KEYSTONE_AVBD = { iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP } as const;
const keystoneAvbd = (spec: string) => withOption(withOption(spec, 'iterations', KEYSTONE_AVBD.iterations), 'gapSlop', KEYSTONE_AVBD.gapSlop);

const viewerEngine = (c: ViewerConfig): PhysicsEngine => makeEngine(worldEngineSpec(engineSpec(scenarioEngineSpec(c.engine, c.scenario), c.projectile, c.scale), c.scale));

interface ViewerHandle {
  status: 'loading' | 'running' | 'error';
  error?: string;
  frames: number;
  bodies: number;
  /** Bodies the last snapshot reports awake (dormant and frozen ones are not). */
  awake: number;
  stepIndex: number;
  /** Median physics ms/step over the HUD's window (NaN before the first step); updated with the HUD. */
  msPerStep: number;
  /** Median snapshot read-back + upload ms over the HUD's window, as msPerStep. */
  snapMs: number;
  /** Scene loads so far: 1 after start, one more per R. */
  resets: number;
  /** Steps submitted before the step before reported done, so queued behind it (loop=free pipelining; see runFree). */
  overlapped: number;
  /** Body slots drawn with a tint (a level's roles and materials, as the game draws them); 0 for a scenario. */
  tinted: number;
  /** Fired real things (proj=<name>) painted their colour, in the current look's (sRGB 0xrrggbb), by body id; cleared on load. */
  painted: { id: number; colour: number }[];
  /** The running engine's EngineInfo.variant (its params as built: Bounce's restitution, a world scale's scaling). */
  variant: EngineInfo['variant'];
  /** Where the camera is now. */
  camera(): CameraPose;
  /** Fire a ball through normalized device coords (0, 0 = centre). */
  fire(ndcX?: number, ndcY?: number): void;
  capture(keepPixels?: boolean): Promise<PixelStats | null>;
  inputs: InputEvent[];
  /** Under rules=keystone, the game's handle (as window.__game on the game page); null in the sandbox. */
  game: GameHandle | null;
  /**
   * Input decided from the observed state (the weapons runtime hooks here): a factory, called for a
   * fresh hook on every load (and under Keystone's rules for every replay, so a replay sees the same
   * input). The hook gets each snapshot the page reads and the engine step it is of: in the sandbox
   * about one a frame, under Keystone's rules every step (@tb/keystone PlayOptions.perStep). The events
   * it returns are pushed; each must be due after that step (step + 1 at the soonest). Set it, then R.
   */
  inputHook: (() => InputHook) | null;
}
type InputHook = (s: Snapshot, step: number) => InputEvent[];
declare global { interface Window { __viewer: ViewerHandle } }
/** Steps of 1/60 s a proximity fuse predicts past each state the page reads (Grenades lookahead): a few frames. */
const GRENADE_LOOKAHEAD = 4;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const errorBox = document.getElementById('error')!;
const handle: ViewerHandle = { status: 'loading', frames: 0, bodies: 0, awake: 0, stepIndex: 0, msPerStep: NaN, snapMs: NaN, resets: 0, overlapped: 0, tinted: 0, painted: [], variant: {}, camera: () => ({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 1 }), fire: () => {}, capture: async () => null, inputs: [], game: null, inputHook: null };
window.__viewer = handle;

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  handle.status = 'error';
  handle.error = msg;
  errorBox.style.display = 'block';
  errorBox.textContent = `Error: ${msg}`;
  console.error(e);
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
  // Keystone's rules play on the game's two engines, at its own settings.
  const keystone = config.rules === 'keystone';
  for (const e of ENGINES) {
    if (keystone && e.spec !== 'avbd-gpu' && e.spec !== 'rapier') continue;
    const b = document.createElement('button');
    b.textContent = e.label;
    if (parseSpec(config.engine).name === e.spec) b.className = 'on';
    b.onclick = () => { location.search = toSearch({ ...parseViewerConfig(location.search), engine: e.spec }); };
    box.appendChild(b);
  }
  const { name } = parseSpec(config.engine);
  if (name === 'avbd-gpu' && !keystone) {
    // The scenario's own options (ScenarioDef.avbd) are its defaults: its count's button clears the option, and the buttons light up for what runs.
    const own = Number(parseSpec(scenarioEngineSpec('avbd-gpu', config.scenario)).options.iterations ?? DEFAULT_AVBD.iterations);
    const runs = parseSpec(scenarioEngineSpec(config.engine, config.scenario)).options;
    for (const n of GPU_ITERATIONS) {
      const b = document.createElement('button');
      b.textContent = `${n} iterations`;
      if ((runs.iterations ?? own) === n) b.className = 'on';
      b.onclick = () => {
        const c = parseViewerConfig(location.search);
        location.search = toSearch({ ...c, engine: withOption(c.engine, 'iterations', n === own ? undefined : n) });
      };
      box.appendChild(b);
    }
    const k = document.createElement('button');
    k.textContent = 'Keystone settings';
    k.title = `${KEYSTONE_AVBD.iterations} iterations and gapSlop ${KEYSTONE_AVBD.gapSlop}: what the game plays and pins par lines at`;
    if (Number(runs.iterations) === KEYSTONE_AVBD.iterations && Number(runs.gapSlop) === KEYSTONE_AVBD.gapSlop) k.className = 'on';
    k.onclick = () => {
      const c = parseViewerConfig(location.search);
      location.search = toSearch({ ...c, engine: keystoneAvbd(c.engine) });
    };
    box.appendChild(k);
  }
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.textContent = p.label;
    if (presetSearch(p.search, config) === toSearch(config)) b.className = 'on';
    b.onclick = () => { location.search = presetSearch(p.search, parseViewerConfig(location.search)); };
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
  renderer.look = lookByName(config.look, config.real);
  renderer.device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  renderer.device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));
  if (config.rules === 'keystone') return keystoneMode(config, device, renderer, source);

  let engine: PhysicsEngine = viewerEngine(config);
  let scene = viewerScene(config);
  // Engine body i has shape shapes[i]: initial bodies, then spawns in
  // (step, push order), the same order the engine applies them.
  let events: InputEvent[] = [];
  let shapes: BodyDesc[] = [];
  let orbit: Orbit;
  // The loaded scene's starting bodies' box, which the framing (config.view) fits.
  let box: { min: V3; max: V3 } = { min: [0, 0, 0], max: [0, 0, 0] };
  const clock = newClock();
  // 30 steps (half a second of sim): a longer window lags the scene, whose step cost changes within seconds.
  const stepMs = new Window(30);
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
  // Body slots with a tint set (a level's roles and materials), cleared on the next load.
  let fxSlots = 0;
  // This load's input hook (handle.inputHook), or none.
  let inputHook: InputHook | null = null;
  // This load's fired grenades, waiting on their fuses (proj.weapon=grenade).
  let grenades: Grenades | null = null;
  // This load's fired catalogue objects, painted their colours (the candy skin outside the real look).
  let painted: { id: number; colour: { natural: number; candy: number } }[] = [];
  const paint = (id: number, colour: { natural: number; candy: number }) => {
    const c = config.look === 'real' ? colour.natural : colour.candy;
    handle.painted = [...handle.painted.filter((p) => p.id !== id), { id, colour: c }];
    renderer.setFx(id, { tint: [c >> 16, (c >> 8) & 0xff, c & 0xff].map((x) => srgbToLinear(x / 255)) as V3, paint: true });
    fxSlots = Math.max(fxSlots, id + 1);
  };

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
    // Show the new scene's HUD and any notice now: with loop=free, frames (which redraw it
    // every 10) need not keep pace with steps.
    drawHud();
  }

  // With loop=free, frames keep drawing while a reset awaits, so everything a frame reads
  // (scene, camera, the source's bodies) switches in one synchronous block after the last
  // await: no frame sees an empty source or the new camera on the old scene.
  async function load(want: ViewerConfig) {
    const next = viewerScene(want); // throws on bad params before anything is torn down
    engine.dispose();
    engine = viewerEngine(want);
    pushLimit = pushRadiusLimit(engineSpec(want.engine, want.projectile, want.scale), next);
    await engine.init(next);
    // Settle before the scene shows (ViewerConfig.presettle); the steps are submitted back to back, then one read.
    for (let i = 0; i < want.presettle * want.substeps; i++) await engine.step();
    const t0 = performance.now();
    const s = await engine.snapshot();
    config = want;
    scene = next;
    handle.variant = engine.info.variant;
    events = [...scene.inputs];
    shapes = [...scene.bodies];
    source.reset(scene.bodies);
    // A level draws as the game draws it: crowns gold, heritage celadon, materials tinted (@tb/game structureTints).
    if (fxSlots) renderer.clearFx(0, fxSlots);
    const def = levelOf(want), tints = def ? structureTints(compileLevel(def)) : null;
    if (tints) renderer.setFx(0, tints);
    fxSlots = handle.tinted = tints?.length ?? 0;
    const b = bounds(scene.bodies);
    box = b;
    orbit = want.camera ? orbitAt(want.camera, want.view.fov) : frame(b.min, b.max, want.view);
    const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    renderer.setShadowBounds(c, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 + 2);
    handle.inputs = [];
    notice = '';
    inputHook = handle.inputHook?.() ?? null;
    // The page reads the state about once a frame, so a fuse predicts that far ahead (Grenades).
    painted = [];
    handle.painted = [];
    grenades = new Grenades({ dt: next.dt, substeps: engine.info.integrator?.substeps ?? 1, gravity: next.gravity, groundY: next.ground?.y ?? null }, GRENADE_LOOKAHEAD * want.substeps);
    apply(s, t0, engine.stepIndex);
  }

  const controls = mountControls(document.getElementById('controls')!, {
    config: () => config,
    rebuild(next) {
      // Keystone's rules run the game's loop in place of this one: a page load.
      if (next.rules === 'keystone') {
        location.search = toSearch(next);
        return;
      }
      nextConfig = next;
      resetAsked = true;
    },
    setLook(look, real) {
      // Shading only: live, nothing to rebuild. A queued rebuild keeps it too.
      config = { ...config, look, real };
      if (nextConfig) nextConfig = { ...nextConfig, look, real };
      renderer.look = lookByName(look, real);
      for (const f of painted) paint(f.id, f.colour);
      history.replaceState(null, '', toSearch(config));
      presets(location.search);
    },
    setProjectile(p) {
      // A rebuild already queued takes the projectile with it (and sizes its engine for it).
      if (nextConfig) {
        nextConfig = { ...nextConfig, projectile: p };
        return;
      }
      const next = { ...config, projectile: p };
      if (projectileRadius(p, config.scale) <= pushLimit) {
        config = next;
        history.replaceState(null, '', toSearch(config));
        return;
      }
      // The GPU engine sizes its broadphase grid for the largest body at init, so a bigger projectile needs a new engine.
      nextConfig = next;
      resetNote = 'Rebuilt the scene: the GPU engine sizes its grid for the largest body when it starts';
      resetAsked = true;
    },
    setView(view) {
      // Camera only: re-framed now (a start camera keeps its pose and takes the field of view).
      config = { ...config, view };
      if (nextConfig) nextConfig = { ...nextConfig, view };
      orbit = config.camera ? { ...orbit, fovY: frame(box.min, box.max, view).fovY } : frame(box.min, box.max, view);
      history.replaceState(null, '', toSearch(config));
      presets(location.search);
    },
    camera: () => poseOf(orbit),
    load(next, name) {
      const want = { ...next, offscreen: config.offscreen };
      // The loop (free or frame, or Keystone's) is chosen when the page starts, so another one needs a page load.
      if (want.loop !== config.loop || want.rules === 'keystone') {
        location.search = toSearch(want);
        return;
      }
      nextConfig = want;
      resetNote = `Loaded ${name}`;
      resetAsked = true;
    },
  });
  handle.camera = () => poseOf(orbit);

  function shapesFor(count: number): BodyDesc[] {
    if (shapes.length < count) {
      const spawned = spawnedBodies(events);
      while (shapes.length < count) shapes.push(spawned[shapes.length - scene.bodies.length]!);
    }
    return shapes;
  }

  // Snapshot read-back (from t0), then upload; snapMs times both. Pipelined reads overlap, so each keeps its own t0.
  // step: the engine step the snapshot is of, for the input hook.
  function apply(s: Snapshot, t0: number, step: number) {
    source.update(s, shapesFor(s.count));
    snapMs.push(performance.now() - t0);
    handle.bodies = s.count;
    awake = handle.awake = s.awake.reduce((a, x) => a + x, 0);
    const input = inputHook?.(s, step);
    if (input?.length) {
      const early = input.find((e) => e.step <= step);
      if (early) throw new Error(`input hook: an event for step ${early.step} is not after the observed step ${step}`);
      pushInput(input);
    }
    const blasts = grenades?.observe(s, step, shapesFor(s.count));
    if (blasts?.length) pushGrenade(() => blasts);
  }
  /** A grenade's blasts: an engine that refuses them (tiered) leaves a notice, not a stopped page. */
  function pushGrenade(blasts: () => InputEvent[]) {
    try {
      pushInput(blasts());
    } catch (e) {
      notice = `grenade: ${e instanceof Error ? e.message : String(e)}`;
      drawHud();
    }
  }
  /**
   * Read the newest state back and upload it; resolves with the time it landed. Pipelined, the read
   * waits behind its step on the GPU, so it is timed from when that step was done (done).
   */
  const refresh = async (done?: Promise<number>) => {
    const t0 = performance.now();
    // A snapshot holds exactly the steps submitted before it is asked for (PhysicsEngine.snapshot).
    const step = engine.stepIndex;
    const s = await engine.snapshot();
    apply(s, done ? Math.max(t0, await done) : t0, step);
    return performance.now();
  };
  /** Push input as a fired projectile is: into the engine, and in application order (stable by step) into events. */
  function pushInput(evs: InputEvent[]) {
    engine.push(evs);
    for (const ev of evs) {
      handle.inputs.push(ev);
      let i = events.length;
      while (i > 0 && events[i - 1]!.step > ev.step) i--;
      events.splice(i, 0, ev);
    }
  }
  let awake = 0;

  handle.fire = (x = 0, y = 0) => {
    if (resetting) return;
    const { origin, dir } = rayThrough(orbit, aspect(), x, y);
    const { body, colour } = firedBody(config, origin, dir);
    const ev: InputEvent = { step: engine.stepIndex, kind: 'spawn', body };
    try {
      pushInput([ev]);
    } catch (e) {
      // The GPU and tiered engines have room for GPU_SPARE fired projectiles (params.ts); R resets.
      notice = `${e instanceof Error ? e.message : String(e)} (press R to reset)`;
      drawHud();
      return;
    }
    const p = config.projectile;
    // Engines number spawns after the scene's bodies in (step, push order), the order of events. A spawn
    // another input pushes later for an earlier step would come first; nothing pushes one (#94's hooks could).
    const id = scene.bodies.length + events.filter((e) => e.kind === 'spawn').indexOf(ev);
    if (colour) {
      painted.push({ id, colour });
      paint(id, colour);
    }
    if (p.weapon === 'grenade' && p.grenade && grenades) {
      const [g, spec] = [grenades, worldGrenade(p.grenade, froudeSpeed(config.scale), config.substeps)];
      pushGrenade(() => g.launch(id, ev.step, spec, ev.body.shape));
    }
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
    handle.msPerStep = med;
    handle.snapMs = snapMs.quantile(0.5);
    const over = med > 7.5;
    hud.innerHTML = `
      <div class="big">${handle.bodies.toLocaleString()} bodies</div>
      <div class="muted">${escapeHtml(sceneTitle(config))} · ${escapeHtml(config.engine)} (${escapeHtml(engine.info.backend)})</div>
      <div class="row"><span>physics ms/step</span><span class="${over ? 'warn' : ''}">${fmt(med)} <span class="muted">p95 ${fmt(p95)}</span></span></div>
      <div class="row muted"><span>step</span><span>${handle.stepIndex.toLocaleString()} · loop ${config.loop}${config.loop === 'free' && !config.pipeline ? ' · pipeline off' : ''}</span></div>
      <div class="row"><span>awake</span><span>${awake.toLocaleString()}</span></div>
      <div class="row"><span>fps</span><span>${fmt(fps)}</span></div>
      <div class="row"><span>sim speed</span><span class="${clock.simSpeed < 0.95 ? 'warn' : ''}">${(clock.simSpeed * 100).toFixed(0)}%</span></div>
      <div class="row"><span>snapshot + upload</span><span>${fmt(handle.snapMs)} ms</span></div>
      <div class="row muted"><span>budget</span><span>7.5 ms/step</span></div>
      <div class="muted">${escapeHtml(adapter.info.vendor)} ${escapeHtml(adapter.info.architecture)}${paused ? ' · <b>paused</b>' : ''}</div>${notice ? `\n      <div class="warn">${escapeHtml(notice)}</div>` : ''}`;
  }

  await reset();
  handle.status = 'running';
  let last = performance.now();
  let pendingCapture: { resolve: (s: PixelStats | null) => void; keep: boolean } | null = null;
  handle.capture = (keep = false) => new Promise((resolve) => { pendingCapture = { resolve, keep }; });
  const dtMs = () => scene.dt * 1000;
  /** The engine step autofire fires at: autofire steps after the scene shows. */
  const autofireStep = () => (config.presettle + config.autofire) * config.substeps;

  /** Draw one frame at alpha, answer a pending capture, and update the frame counters. */
  async function draw(now: number, alpha: number) {
    const want = pendingCapture;
    pendingCapture = null;
    const stats = await renderer.render({ viewProj: viewProj(orbit, aspect()), eye: eyeOf(orbit), focus: orbit.target, time: now / 1000, groundY: scene.ground?.y ?? 0, alpha, metres: config.scale }, !!want, want?.keep);
    if (want) want.resolve(stats);
    handle.frames++;
    if (handle.frames % 10 === 1) drawHud();
  }

  /** Real time since the last frame, folded into the fps estimate. */
  function frameTime(now: number): number {
    const frameMs = now - last;
    last = now;
    fps = 0.9 * fps + 0.1 * (1000 / Math.max(frameMs, 1));
    return frameMs;
  }

  // loop=frame: step, wait, read back and render in series, once per display frame.
  const tick = async () => {
    const now = performance.now();
    const frameMs = frameTime(now);
    resize();
    if (resetAsked) { resetAsked = false; await reset(); }
    const n = paused ? 0 : stepsDue(clock, frameMs, scene.dt, config.maxSteps * config.substeps);
    // A GPU engine's step() only submits, so its steps are timed to completion with finish().
    // refresh() waits for the GPU anyway to read a snapshot back; the wait adds one
    // queue-completion round trip before that readback's copy is submitted.
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const ts = performance.now();
      await engine.step();
      if (!engine.finish) stepMs.push(performance.now() - ts);
      if (config.autofire && engine.stepIndex === autofireStep()) handle.fire(0, 0);
    }
    if (n > 0 && engine.finish) {
      await engine.finish();
      const per = (performance.now() - t0) / n;
      for (let i = 0; i < n; i++) stepMs.push(per);
    }
    handle.stepIndex = engine.stepIndex;
    if (n > 0) await refresh();
    await draw(now, paused ? 1 : clock.acc / scene.dt);
    if (handle.status === 'running') requestAnimationFrame(() => void tick().catch(fail));
  };

  // loop=free: physics owns the engine (steps, snapshots, resets) and runs back to back
  // while steps are due; the render loop below never waits for it.
  const pacer = newPacer();
  const arrivals = newArrivals();
  let stepsSinceFrame = 0;
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const tasks = taskYield();
  const latch = pauseLatch();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') latch.hidden(); });
  const physics = () => runFree({
    running: () => handle.status === 'running',
    // A hidden tab gets no frames, so it would show nothing for the GPU and power it spends.
    paused: () => latch.paused(paused, document.visibilityState === 'visible'),
    now: () => performance.now(),
    dtMs,
    resetAsked: () => resetAsked,
    async reset() {
      resetAsked = false;
      await reset();
    },
    async step() {
      await engine.step();
      stepsSinceFrame++;
      if (config.autofire && engine.stepIndex === autofireStep()) handle.fire(0, 0);
      handle.stepIndex = engine.stepIndex;
    },
    finish: async () => { await engine.finish?.(); },
    record(ms, overlapped) {
      stepMs.push(ms);
      if (overlapped) handle.overlapped++;
    },
    refresh,
    // A GPU engine's finish() and snapshot wait on the GPU; a CPU engine (no finish) steps synchronously.
    yields: () => !!engine.finish,
    pipeline: () => config.pipeline && !!engine.finish,
    nextFrame,
    nextTask: tasks.next,
  }, pacer, arrivals);
  let lastFrameDone: Promise<void> | null = null;
  // The first frame after the tab was hidden spans the time away, which is not slow motion.
  let wasHidden = false;
  document.addEventListener('visibilitychange', () => { wasHidden = true; });
  const frameLoop = async () => {
    const now = performance.now();
    const frameMs = frameTime(now);
    resize();
    if (!paused && !resetting && !wasHidden) trackSimSpeed(clock, stepsSinceFrame, frameMs, scene.dt);
    stepsSinceFrame = 0;
    wasHidden = false;
    await draw(now, paused || resetting ? 1 : alphaAt(arrivals, now, dtMs()));
    // At most two frames queued on the GPU. Nothing else holds this loop back: an offscreen
    // target gets no presentation backpressure, and on a slow GPU (SwiftShader) the queue was
    // 50 s behind after 12 s, starving physics and every readback.
    const done = renderer.device.queue.onSubmittedWorkDone();
    if (lastFrameDone) await lastFrameDone;
    lastFrameDone = done;
    if (handle.status === 'running') requestAnimationFrame(() => void frameLoop().catch(fail));
  };

  if (config.loop === 'frame') {
    requestAnimationFrame(() => void tick().catch(fail));
  } else {
    void physics().catch(fail);
    requestAnimationFrame(() => void frameLoop().catch(fail));
  }
}

/**
 * rules=keystone: the level played by the game's loop (@tb/game playKeystone), exactly as the game page
 * plays it, so a session replays headless with runSession. The game's HUD takes the viewer's HUD panel,
 * its banner and result card float over the page, and the panel stays: the look, projectile and framing
 * change live (the last two are kept for the sandbox); a new scene, rules or engine reloads the page.
 */
async function keystoneMode(config: ViewerConfig, device: GPUDevice, renderer: Renderer, source: SnapshotSource) {
  installGameStyles();
  hud.classList.add('kg-hud');
  const help = document.getElementById('help')!;
  help.classList.add('kg-help');
  help.innerHTML = GAME_HELP;
  const game = handle.game = newGameHandle();
  const failGame = (e: unknown) => {
    game.status = 'error';
    game.error = e instanceof Error ? e.message : String(e);
    fail(e);
  };
  let cfg = config;
  const show = (next: ViewerConfig) => {
    cfg = next;
    history.replaceState(null, '', toSearch(cfg));
    presets(location.search);
  };
  const go = (next: ViewerConfig) => { location.search = toSearch({ ...next, offscreen: cfg.offscreen }); };
  const controls = mountControls(document.getElementById('controls')!, {
    config: () => cfg,
    rebuild: go,
    load: (next) => go(next),
    setLook(look, real) {
      renderer.look = lookByName(look, real);
      show({ ...cfg, look, real });
    },
    setProjectile: (projectile) => show({ ...cfg, projectile }),
    setView: (view) => show({ ...cfg, view }),
    camera: () => null,
  });
  // The par and dev panel: the attempt as the driver holds it, a line to play, a replay check.
  const devEl = document.createElement('details');
  devEl.id = 'dev';
  devEl.className = 'panel';
  devEl.open = true;
  document.getElementById('left')!.append(devEl);
  let driver: Driver | null = null, busy = false, status = '', warn = false;
  const attempt = (): Shot[] => driver?.session.inputs.map((i) => i.shot) ?? [];
  const dev = mountDev(devEl, (a) => { void devAction(a); });
  const showDev = () => {
    const level = driver?.level.def ?? levelOf(cfg)!;
    const par = level.solutions?.par;
    const s = driver?.session;
    dev.show({
      level, line: cfg.shots ? { from: 'link', shots: cfg.shots } : par?.length ? { from: 'par', shots: par } : null,
      attempt: attempt(), outcomes: s?.outcomes ?? [], score: s?.score ?? null, running: s?.phase === 'running', busy, status, warn,
    });
  };
  const report = (text: string, bad = false) => { status = text; warn = bad; showDev(); };
  /** Plays a line (playLine, @tb/game), saying how far it got. */
  async function playShots(shots: readonly Shot[], fresh: boolean) {
    const r = await playLine(game, shots, fresh, (n) => report(`playing: shot ${n} of ${shots.length} fired`));
    report(r.message, !r.ok);
  }
  async function devAction(a: DevAction) {
    if (busy) return;
    busy = true;
    try {
      if (a === 'play') {
        const line = cfg.shots ?? levelOf(cfg)!.solutions?.par;
        if (line) { report('playing the line'); await playShots(line, false); }
      } else if (a === 'check') {
        report('replaying the attempt on a fresh engine');
        const live = game.state(), again = await game.replay(attempt());
        const same = JSON.stringify(again) === JSON.stringify(live);
        const say = (s: typeof live) => `step ${s.step}, ${s.phase}, hash ${s.hash}`;
        report(same ? `replay matches: ${say(again)}` : `replay differs: live ${say(live)}; replay ${say(again)}`, !same);
      } else {
        const shots = attempt();
        show({ ...cfg, shots });
        report(`the link and Download now carry this attempt (${shots.length} shot${shots.length === 1 ? '' : 's'})`);
      }
    } catch (e) {
      report(e instanceof Error ? e.message : String(e), true);
    } finally {
      busy = false;
      showDev();
    }
  }
  // A built-in level walks the game's levels (N, P, Next); a level of your own is the only one.
  const def = levelOf(cfg)!;
  const levels = cfg.customLevel ? [def] : LEVELS;
  await playKeystone({
    canvas, offscreen: cfg.offscreen, device, renderer, source, hud, ...gameOverlays(),
    levels, start: levels.findIndex((l) => l.id === def.id), engine: keystoneEngine(cfg.engine), feel: cfg.feel, fail: failGame,
    // The page's input hook, every step (read when a level loads or a replay starts).
    perStep() {
      const hook = handle.inputHook?.();
      return hook ? (d) => hook(d.snapshot, d.snapshotStep) : () => [];
    },
    hooks: {
      loaded(c, d) {
        handle.tinted = c.meta.n;
        driver = d;
        if (c.def.id !== cfg.level) {
          // A line is the level's it was made on.
          show({ ...cfg, level: c.def.id, shots: null });
          controls.refresh();
          status = ''; warn = false;
        }
        showDev();
      },
      fired: showDev,
      stepped(feedback) { if (feedback.some((f) => f.t === 'settled')) showDev(); },
    },
  }, game);
  handle.capture = game.capture;
  handle.status = 'running';
  // A link with a line plays it once, on the attempt the page opened with.
  if (cfg.shots) {
    busy = true;
    report('playing the line from the link');
    playShots(cfg.shots, true).catch((e) => report(e instanceof Error ? e.message : String(e), true)).finally(() => { busy = false; showDev(); });
  }
}

main().catch(fail);
