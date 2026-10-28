// Keystone, played: the rules from @tb/keystone on a PhysicsEngine, drawn by
// @tb/render, with the game's aim, HUD, juice and audio. Physics only runs
// while a shot is in play, at a pace the Pacer sets (hit-stop, slow motion,
// fast-forward); between shots the world is frozen, so a session is exactly
// (level, shots) and replays headless. The game page calls playKeystone with
// its own elements; the viewer calls it for rules=keystone, with hooks for its
// dev panels (docs/design/viewer-superset.md, step C).
import { type BodyDesc, type InputEvent, type PhysicsEngine, spawnedBodies, type Vec3 } from '@tb/engine-api';
import { type AmmoKind, type CompiledLevel, compileLevel, Driver, type Feedback, type LevelDef, type LevelScore, type PerStep, runSession, type Shot, shotToSpawn, snapshotHash, TIER_NAMES } from '@tb/keystone';
import { Window } from '@tb/metrics';
import { clampPitch, EYE_ABOVE_GROUND, eyeOf, frame, type Orbit, rayThrough, viewProj } from '@tb/render/camera';
import type { PixelStats, Renderer, SnapshotSource } from '@tb/render';
import { type Aimed, azFromYaw, pick, previewBeads, shotFor, SUBSTEPS } from './aim.ts';
import { Synth, type Voice, voicesFor } from './audio.ts';
import { driverOptions, type EngineKind, makeEngine } from './engines.ts';
import { hudHtml, nextSelection, rackChips, resultHtml, starsText } from './hud.ts';
import { CameraJuice, contactJuice } from './juice.ts';
import { Pacer, type PaceFeel } from './pacing.ts';
import { beadOverlay, regrowDuration, regrowScales, structureTints, TINT } from './scene.ts';

/** What a page (and its tests) can see and do while Keystone plays: window.__game on the game page. */
export interface GameHandle {
  status: 'loading' | 'running' | 'error';
  error?: string;
  engine: EngineKind | '';
  level: string;
  phase: string;
  /** Aiming, and the Regrow animation has finished: a shot can be fired. */
  ready: boolean;
  frames: number;
  stepIndex: number;
  strokes: number;
  bodies: number;
  /** Run the sim at fast-forward speed (as if Space were held). */
  fast: boolean;
  result: LevelScore | null;
  /** Feedback events seen this attempt, by type. */
  counts: Record<string, number>;
  /** Pace juice in effect (`?keystone.hitstop=1`, `?keystone.slowmo=1`; both off by default). */
  feel: PaceFeel;
  /** Engine step at which this attempt's round-over card first showed, or null. */
  resultShownAt: number | null;
  /** Wall time of this level's load (engine build and pre-settle), and of each live step since, in ms. */
  timing: { loadMs: number; stepMs: number[] };
  fire(shot: Shot): boolean;
  /** Aim at normalized device coords with the selected ammo, as hovering there would. */
  aim(ndcX: number, ndcY: number): Aimed | null;
  select(ammo: AmmoKind): boolean;
  load(id: string): Promise<void>;
  retry(): Promise<void>;
  capture(keepPixels?: boolean): Promise<PixelStats | null>;
  /** Physics state now: step, phase and a hash of every pose. */
  state(): SessionState;
  /** The same shots from the same level on a fresh engine, built as the live one, on this device. */
  replay(shots: Shot[]): Promise<SessionState>;
}
export interface SessionState { step: number; phase: string; strokes: number; heritageBroken: number; hash: string }

const sum = (a: Uint8Array) => a.reduce((x, y) => x + y, 0);

/** A handle with nothing loaded yet, for a page to publish before playKeystone fills it in. */
export function newGameHandle(): GameHandle {
  const none = (): SessionState => ({ step: 0, phase: 'loading', strokes: 0, heritageBroken: 0, hash: '' });
  return {
    status: 'loading', engine: '', level: '', phase: 'loading', ready: false, frames: 0, stepIndex: 0, strokes: 0, bodies: 0, fast: false, result: null, counts: {}, feel: { hitStop: false, slowMo: false }, resultShownAt: null, timing: { loadMs: 0, stepMs: [] },
    fire: () => false, aim: () => null, select: () => false, load: async () => {}, retry: async () => {}, capture: async () => null,
    state: none, replay: async () => none(),
  };
}

/** What playLine did: ok when every shot was fired and the last has settled; else why it stopped. */
export interface LineResult { ok: boolean; fired: number; message: string }

const until = (ok: () => boolean) => new Promise<void>((res) => { const t = () => (ok() ? res() : setTimeout(t, 50)); t(); });
const shotsText = (n: number) => `${n} shot${n === 1 ? '' : 's'}`;

/**
 * Plays a line of shots on a running page: from a fresh attempt (handle.retry) unless `fresh`
 * (the load's own attempt), each fired through handle.fire, the path a click takes, once the game
 * is ready. Stops when the level changes, is retried or ends before the line does, or the rack
 * cannot fire a shot; resolves once the last shot has settled. `fired` reports each shot as it goes.
 */
export async function playLine(handle: GameHandle, shots: readonly Shot[], fresh = false, fired?: (n: number) => void): Promise<LineResult> {
  const id = handle.level;
  const stop = (n: number, message: string): LineResult => ({ ok: false, fired: n, message });
  if (!fresh) await handle.retry();
  for (let i = 0; i < shots.length; i++) {
    await until(() => handle.ready || handle.result !== null || handle.level !== id || handle.status === 'error');
    if (handle.level !== id || handle.status === 'error') return stop(i, `stopped after ${i} of ${shotsText(shots.length)}: the level changed`);
    if (handle.result) return stop(i, `the level ended after ${i} of ${shotsText(shots.length)}`);
    // Retry (R) mid-line starts a fresh attempt: the rest of the line was not made for it.
    if (handle.strokes !== i) return stop(i, `stopped after ${i} of ${shotsText(shots.length)}: the attempt was restarted`);
    if (!handle.fire(shots[i]!)) return stop(i, `shot ${i + 1} (${shots[i]!.ammo}) could not be fired`);
    fired?.(i + 1);
  }
  await until(() => handle.result !== null || handle.level !== id || handle.status === 'error' || (handle.ready && handle.strokes === shots.length));
  if (handle.level !== id || handle.status === 'error') return stop(shots.length, `stopped after ${shotsText(shots.length)}: the level changed`);
  const r = handle.result;
  return { ok: true, fired: shots.length, message: r ? `played ${shotsText(shots.length)}: ${r.stamp}, ${starsText(r.stars)}` : `played ${shotsText(shots.length)}; the level is still open` };
}

/**
 * Called by playKeystone so a page can watch play without changing it. A hook
 * sees the driver as it stands; it must not step it or push to its engine (a
 * replay would not see that).
 */
export interface KeystoneHooks {
  /** A level was built, pre-settled and shown (also on retry). */
  loaded?(c: CompiledLevel, d: Driver): void;
  /** A shot was fired: the spawn applies at the next step. */
  fired?(shot: Shot, feedback: Feedback[], d: Driver): void;
  /** One driver step ran; d.snapshot is of engine step d.snapshotStep. */
  stepped?(feedback: Feedback[], d: Driver): void;
}

export interface KeystoneEnv {
  /** Takes the pointer (aim, fire, orbit, zoom); sized to its CSS box each frame unless offscreen. */
  canvas: HTMLCanvasElement;
  /** Tests: the renderer draws 640x400 offscreen, and only for a capture. */
  offscreen: boolean;
  device: GPUDevice;
  renderer: Renderer;
  source: SnapshotSource;
  /** The game's HUD, banner and result card: kg-hud, kg-banner and kg-result elements (ui.ts; gameOverlays makes the last two). */
  hud: HTMLElement;
  banner: HTMLElement;
  result: HTMLElement;
  /** The levels N, P and the result card's Next walk through, and the one to start on. */
  levels: readonly LevelDef[];
  start: number;
  engine: EngineKind;
  feel: PaceFeel;
  /** Shows an error; play stops (handle.status is 'error'). */
  fail(e: unknown): void;
  hooks?: KeystoneHooks;
  /**
   * Input decided from the observed state (the weapons runtime): a fresh hook per level load and
   * per replay, called after every step as runSession calls PlayOptions.perStep, so a replay
   * sees the same input.
   */
  perStep?(c: CompiledLevel): PerStep;
}

/** Frame the structure; face the par line's launcher when it has one. The eye stays EYE_ABOVE_GROUND over the ground (y 0), as in the viewer. */
export function viewOf(c: CompiledLevel): Orbit {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const o = frame(min, max);
  const first = c.def.solutions?.par?.[0];
  if (first && 'az' in first) o.yaw = ((90 - first.az / 2) * Math.PI) / 180;
  return { ...o, floor: EYE_ABOVE_GROUND };
}

/** An orbiting drag of (dx, dy) pixels: turns, and tilts from looking down to looking up (past level the floor brings the eye in). */
export function orbitDrag(o: Orbit, dx: number, dy: number): void {
  o.yaw -= dx * 0.005;
  o.pitch = clampPitch(o.pitch + dy * 0.005);
}

/** Typing into a form field (the viewer's panels) is not a game key. */
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

/**
 * Loads env.levels[env.start] and plays it until the page closes, filling in
 * `handle`. Resolves once the first level is running; errors go to env.fail.
 */
export async function playKeystone(env: KeystoneEnv, handle: GameHandle = newGameHandle()): Promise<GameHandle> {
  const { canvas, offscreen, device, renderer, source, levels, engine: kind, feel, fail } = env;
  const hooks = env.hooks ?? {};
  const levelIndex = (id: string) => {
    const i = levels.findIndex((l) => l.id.toUpperCase() === id.toUpperCase());
    if (i < 0) throw new Error(`unknown level ${id}; known: ${levels.map((l) => l.id).join(', ')}`);
    return i;
  };
  let levelIdx = env.start;
  handle.feel = feel;
  handle.engine = kind;

  // One engine per level load: the GPU engine sizes its buffers for the level's rack at init.
  let engine: PhysicsEngine | null = null;
  // The arc preview integrates as the engine does, so it is exact on any engine.
  let substeps = SUBSTEPS;
  // Level loads and physics steps take turns: a load disposes the engine, and
  // a GPU step may still be awaiting its readback.
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };
  const pacer = new Pacer(), juice = new CameraJuice(), stepMs = new Window(60);
  let synth: Synth | null = null;
  let muted = false;
  const voices: Voice[] = [];

  let c!: CompiledLevel, driver!: Driver, orbit!: Orbit;
  let perStep: PerStep | null = null;
  // Body descriptions in slot order: the structure, then what was spawned (ammo as fired, and the
  // input hook's), in the order the engine applies spawns: by step, then push order.
  let descs: BodyDesc[] = [];
  let spawns: InputEvent[] = [];
  const spawned = (evs: InputEvent[]) => {
    for (const ev of evs) {
      let i = spawns.length;
      while (i > 0 && spawns[i - 1]!.step > ev.step) i--;
      spawns.splice(i, 0, ev);
    }
    descs = [...c.scene.bodies, ...spawnedBodies(spawns)];
    fxSlots = descs.length;
  };
  let fxSlots = 0;
  let regrowBuf = new Float32Array(0);
  let selected: AmmoKind | null = null;
  let power = 100;
  let aimed: Aimed | null = null, beads: Float64Array | null = null, aimDirty = false;
  let pointer: [number, number] | null = null;
  let regrowT: number | null = null;
  let fastHeld = false;
  let lastHud = '', crownsShown = 0;
  /** Every crown is down: the round is known to be over, the card shows, and the rest of the settle runs at fast-forward. */
  let ending = false;

  const aspect = () => (offscreen ? 640 / 400 : canvas.width / Math.max(1, canvas.height));
  const courses = () => Math.ceil(c.height / c.frame.unit);

  /** Loads queued or in flight: the frame loop stops stepping the outgoing level and keeps drawing it. */
  let loading = 0;
  function load(i: number, retry = false): Promise<void> {
    loading++;
    return exclusive(() => loadNow(i, retry)).finally(() => { loading--; });
  }

  async function loadNow(i: number, retry: boolean) {
    const t0 = performance.now();
    // Build and pre-settle the new level aside: the GPU's pre-settle spans many
    // frames, and every frame reads the current level, so it swaps in whole.
    const next = compileLevel(levels[i]!);
    const nextEngine = makeEngine(kind, next, device);
    const nextDriver = new Driver(nextEngine, next, driverOptions(kind));
    try {
      await nextDriver.reset();
    } catch (e) {
      nextEngine.dispose();
      throw e;
    }
    engine?.dispose();
    levelIdx = i;
    c = next;
    engine = nextEngine;
    driver = nextDriver;
    substeps = engine.info.integrator?.substeps ?? SUBSTEPS;
    handle.timing = { loadMs: performance.now() - t0, stepMs: [] };
    descs = [...c.scene.bodies];
    spawns = [];
    perStep = env.perStep?.(c) ?? null;
    source.reset(c.scene.bodies);
    source.update(driver.snapshot, descs);
    // Fresh effects: role tints, and every body at scale 0 for Regrow.
    if (fxSlots) renderer.clearFx(0, fxSlots);
    regrowBuf = regrowScales(c, 0, new Float32Array(c.meta.n));
    renderer.setFx(0, structureTints(c), regrowBuf, true);
    fxSlots = c.meta.n;
    pacer.reset();
    juice.reset();
    handle.result = null;
    handle.counts = {};
    handle.level = c.def.id;
    ending = false;
    handle.resultShownAt = null;
    env.result.classList.remove('show');
    document.body.classList.remove('ended');
    selected = nextSelection(c.def.rack, driver.session.rackLeft, retry ? selected : null);
    if (!retry) {
      orbit = viewOf(c);
      power = 100;
      // The play area: the lot (where debris counts), grown a little, up to the structure's top.
      const half: Vec3 = [(c.lot.max[0] - c.lot.min[0]) / 2 + 2, c.height / 2 + 2, (c.lot.max[1] - c.lot.min[1]) / 2 + 2];
      renderer.setShadowBounds([(c.lot.min[0] + c.lot.max[0]) / 2, c.height / 2, (c.lot.min[1] + c.lot.max[1]) / 2], Math.hypot(...half), half);
    }
    regrowT = 0;
    aimed = null;
    beads = null;
    aimDirty = true;
    crownsShown = 0;
    sync();
    hooks.loaded?.(c, driver);
  }

  function banner(text: string, cls = '') {
    env.banner.textContent = text;
    env.banner.classList.remove('show', 'crack');
    if (cls) env.banner.classList.add(cls);
    void env.banner.offsetWidth; // restart the animation
    env.banner.classList.add('show');
  }

  function updateAim() {
    aimDirty = false;
    aimed = null;
    beads = null;
    if (!pointer || !selected || driver.session.phase !== 'aiming' || regrowT !== null) return;
    const hit = pick(rayThrough(orbit, aspect(), pointer[0], pointer[1]), driver.snapshot, c);
    if (!hit) return;
    aimed = shotFor(c, selected, azFromYaw(orbit.yaw), power, hit.point, substeps);
    if (aimed) beads = previewBeads(c, aimed.shot, hit.point, substeps);
  }

  function onFeedback(fb: Feedback[]) {
    for (const f of fb) {
      handle.counts[f.t] = (handle.counts[f.t] ?? 0) + 1;
      voices.push(...voicesFor(f));
      switch (f.t) {
        case 'fired': juice.kick(f.ammo === 'cannonball' ? 0.05 : 0.03); break;
        case 'contact': {
          const j = contactJuice(f.impulse), s = driver.snapshot, b = f.body;
          if (b < s.count) {
            const v: Vec3 = [s.linVel[3 * b]!, s.linVel[3 * b + 1]!, s.linVel[3 * b + 2]!], l = Math.hypot(...v) || 1;
            renderer.burst([s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], [v[0] / l, v[1] / l, v[2] / l], f.dv);
          }
          if (feel.hitStop) pacer.hitStop(j.frames);
          juice.shake(j.trauma);
          juice.kick(0.05);
          break;
        }
        case 'crownDown':
          juice.shake(0.08);
          // A felled crown flashes once and stops glowing.
          renderer.setFx(f.body, { tint: TINT.crown, emissive: 0.9, flash: 0.5 });
          if (c.def.objective.kind === 'crowns' && f.ordinal + 1 === c.meta.crowns.length && driver.session.phase === 'running') {
            ending = true;
            pacer.release();
            showResult(null);
          }
          break;
        case 'slowMo': if (feel.slowMo && !fastHeld && !handle.fast) pacer.slowMo(); break;
        case 'heritageCrack':
          juice.shake(0.3);
          banner('Heritage cracked', 'crack');
          renderer.setFx(f.body, { tint: TINT.heritage, emissive: 1, flash: 0.8 });
          break;
        case 'tier': banner(`${TIER_NAMES[f.tier]}!`); break;
        case 'settled':
          pacer.release();
          // A crown back above the line (rare: a catapult) means the round goes on after all.
          if (ending && driver.session.phase === 'aiming') { ending = false; hideResult(); }
          selected = nextSelection(c.def.rack, driver.session.rackLeft, selected);
          aimDirty = true;
          break;
        case 'levelEnd':
          handle.result = f.score;
          ending = false;
          showResult(f.score);
          break;
      }
    }
  }

  function showResult(score: LevelScore | null) {
    env.result.innerHTML = resultHtml(c.def, score, driver.session.strokes, levelIdx + 1 < levels.length);
    env.result.classList.add('show');
    document.body.classList.add('ended');
    handle.resultShownAt ??= driver.engine.stepIndex;
  }

  function hideResult() {
    env.result.classList.remove('show');
    document.body.classList.remove('ended');
    handle.resultShownAt = null;
  }

  /** Mirror state onto the handle; called each frame and right after anything that changes it. */
  function sync() {
    const s = driver.session;
    Object.assign(handle, { phase: s.phase, ready: s.phase === 'aiming' && regrowT === null, stepIndex: driver.engine.stepIndex, strokes: s.strokes, bodies: driver.snapshot.count });
  }

  function fire(shot: Shot): boolean {
    if (regrowT !== null || !driver.session.canFire(shot.ammo)) return false;
    const step = driver.engine.stepIndex;
    const fb = driver.fire(shot);
    onFeedback(fb);
    spawned([shotToSpawn(c.frame, shot, step)]);
    aimed = null;
    beads = null;
    sync();
    hooks.fired?.(shot, fb, driver);
    return true;
  }

  function select(a: AmmoKind): boolean {
    if (!driver.session.rackLeft.includes(a)) return false;
    selected = a;
    aimDirty = true;
    return true;
  }

  handle.fire = fire;
  handle.select = select;
  handle.aim = (x, y) => { pointer = [x, y]; updateAim(); return aimed; };
  handle.load = (id) => load(levelIndex(id)).catch(fail);
  handle.retry = () => load(levelIdx, true).catch(fail);
  handle.state = () => ({ step: driver.engine.stepIndex, phase: driver.session.phase, strokes: driver.session.strokes, heritageBroken: sum(driver.session.heritageBroken), hash: snapshotHash(driver.snapshot) });
  handle.replay = async (shots) => {
    const e = makeEngine(kind, c, device);
    try {
      const r = await runSession(e, c, shots, { ...driverOptions(kind), perStep: env.perStep?.(c) });
      return { step: r.steps, phase: r.session.phase, strokes: r.session.strokes, heritageBroken: sum(r.session.heritageBroken), hash: snapshotHash(r.snapshot) };
    } finally { e.dispose(); }
  };

  // Audio needs a user gesture before it may start.
  const wakeAudio = () => {
    if (!synth) { try { synth = new Synth(new AudioContext()); synth.muted = muted; } catch { return; } }
    if (synth.ctx.state === 'suspended') void synth.ctx.resume();
  };

  // Pointer: hover aims, a click without drag fires, drag orbits (right or shift: pan).
  let drag: { x: number; y: number; moved: number; pan: boolean } | null = null;
  const ndc = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
  };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    wakeAudio();
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey };
  });
  canvas.addEventListener('pointermove', (e) => {
    pointer = ndc(e);
    aimDirty = true;
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) {
      const s = orbit.distance * 0.0015, cy = Math.cos(orbit.yaw), sy = Math.sin(orbit.yaw);
      orbit.target = [orbit.target[0] - dx * cy * s, orbit.target[1] + dy * s, orbit.target[2] + dx * sy * s];
    } else {
      orbitDrag(orbit, dx, dy);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && drag.moved < 5 && e.button === 0 && !e.shiftKey) {
      pointer = ndc(e);
      updateAim();
      if (aimed) fire(aimed.shot);
    }
    drag = null;
  });
  canvas.addEventListener('pointerleave', () => { pointer = null; aimDirty = true; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.distance = Math.min(200, Math.max(3, orbit.distance * Math.exp(e.deltaY * 0.001)));
    aimDirty = true;
  }, { passive: false });
  env.result.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'retry') void handle.retry();
    if (act === 'next' && levelIdx + 1 < levels.length) void load(levelIdx + 1).catch(fail);
  });
  addEventListener('keydown', (e) => {
    if (typing(e)) return;
    wakeAudio();
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); fastHeld = true; pacer.release(); }
    const chip = rackChips(c.def.rack, driver.session.rackLeft, selected).find((x) => x.key === e.key);
    if (chip) select(chip.ammo);
    if (k === 'q' || k === 'e') { power = Math.max(0, Math.min(100, power + (k === 'e' ? 10 : -10))); aimDirty = true; }
    if (k === 'r') void handle.retry();
    if (k === 'n' && levelIdx + 1 < levels.length) void load(levelIdx + 1).catch(fail);
    if (k === 'p' && levelIdx > 0) void load(levelIdx - 1).catch(fail);
    if (k === 'm') { muted = !muted; if (synth) synth.muted = muted; }
  });
  addEventListener('keyup', (e) => { if (e.key === ' ') fastHeld = false; });

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function drawHud() {
    const s = driver.session;
    const crownsDown = s.crownLive.reduce((a, x) => a + x, 0);
    let html = hudHtml({
      level: c.def, strokes: s.strokes, crownsDown, crownsTotal: c.meta.crowns.length,
      heritageBroken: s.heritageBroken.reduce((a, x) => a + x, 0), heritageTotal: c.meta.heritage.length,
      chips: rackChips(c.def.rack, s.rackLeft, selected), power, liveLeverage: s.liveLeverage, phase: s.phase,
      reachable: s.phase === 'aiming' && aimed ? aimed.reachable : null,
    });
    if (crownsDown > crownsShown) html = html.replace('class="crowns"', 'class="crowns pop"');
    crownsShown = crownsDown;
    if (html !== lastHud) { env.hud.innerHTML = html; lastHud = html; }
  }

  await load(levelIdx);
  handle.status = 'running';
  let last = performance.now();
  let pendingCapture: { resolve: (s: PixelStats | null) => void; keep: boolean } | null = null;
  handle.capture = (keep = false) => new Promise((resolve) => { pendingCapture = { resolve, keep }; });

  const tick = async () => {
    const now = performance.now(), frameMs = now - last;
    last = now;
    const dt = Math.min(frameMs / 1000, 0.1);
    resize();
    if (regrowT !== null) {
      regrowT += dt;
      const done = regrowT >= regrowDuration(courses());
      renderer.setFx(0, null, regrowScales(c, done ? Infinity : regrowT, regrowBuf), !done);
      if (done) { regrowT = null; aimDirty = true; }
    }
    const running = !loading && driver.session.phase === 'running';
    if (running) await exclusive(async () => {
      if (driver.session.phase !== 'running') return; // a load got in first
      const n = pacer.stepsThisFrame(frameMs, c.scene.dt, { fastForward: fastHeld || handle.fast || ending, stepMs: stepMs.quantile(0.5), budgetMs: ending ? 14 : 10 });
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const fb = await driver.step();
        const ms = performance.now() - t0;
        stepMs.push(ms);
        handle.timing.stepMs.push(ms);
        onFeedback(fb);
        hooks.stepped?.(fb, driver);
        const input = perStep?.(driver);
        if (input?.length) {
          driver.push(input);
          spawned(input);
        }
        if (pacer.frozen || driver.session.phase !== 'running') break;
      }
      if (n > 0) source.update(driver.snapshot, descs);
    });
    if (aimDirty) updateAim();
    sync();

    const shake = juice.update(dt);
    const view: Orbit = { ...orbit, yaw: orbit.yaw + shake.yaw, pitch: orbit.pitch + shake.pitch, fovY: orbit.fovY * shake.fovScale };
    const o = beads ? beadOverlay(beads, aimed?.reachable ?? true) : null;
    renderer.setOverlay(o?.xyzr ?? new Float32Array(0), o?.colours);
    const want = pendingCapture;
    pendingCapture = null;
    const fp = { viewProj: viewProj(view, aspect()), eye: eyeOf(view), focus: orbit.target, time: now / 1000, groundY: 0, alpha: running ? pacer.alpha(c.scene.dt) : 1 };
    // Offscreen (tests), nobody sees a frame and nothing throttles requestAnimationFrame
    // to the GPU: on SwiftShader a frame takes up to a second, so frames would queue
    // without bound and every readback (a step's, a replay's) wait behind them.
    // There, draw only for a capture.
    if (!offscreen || want) {
      const stats = await renderer.render(fp, !!want, want?.keep);
      if (want) want.resolve(stats);
    }
    if (voices.length) { synth?.play(voices); voices.length = 0; }
    drawHud();
    handle.frames++;
    if (handle.status === 'running') requestAnimationFrame(() => void tick().catch(fail));
  };
  requestAnimationFrame(() => void tick().catch(fail));
  return handle;
}
