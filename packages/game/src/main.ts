// Keystone, playable: the rules from @tb/keystone on the GPU solver (or
// Rapier with ?engine=rapier), drawn by @tb/render. Physics only runs while a shot
// is in play, at a pace the Pacer sets (hit-stop, slow motion, fast-forward);
// between shots the world is frozen, so a session is exactly (level, shots)
// and replays headless.
import type { BodyDesc, PhysicsEngine, Vec3 } from '@tb/engine-api';
import { type AmmoKind, type CompiledLevel, compileLevel, Driver, type Feedback, LEVELS, type LevelScore, runSession, type Shot, shotToSpawn, snapshotHash, TIER_NAMES } from '@tb/keystone';
import { Window } from '@tb/metrics';
import { clampPitch, eyeOf, frame, type Orbit, rayThrough, viewProj } from '@tb/render/camera';
import { createDevice } from '@tb/gpu';
import { HAZY_DAY, lookByName, parseRealOptions, type PixelStats, Renderer, SnapshotSource } from '@tb/render';
import { type Aimed, azFromYaw, pick, previewBeads, shotFor, SUBSTEPS } from './aim.ts';
import { Synth, type Voice, voicesFor } from './audio.ts';
import { driverOptions, type EngineKind, engineKind, makeEngine } from './engines.ts';
import { hudHtml, nextSelection, rackChips, resultHtml } from './hud.ts';
import { CameraJuice, contactJuice } from './juice.ts';
import { Pacer } from './pacing.ts';
import { beadOverlay, regrowDuration, regrowScales, structureTints, TINT } from './scene.ts';

interface GameHandle {
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
const sum = (a: Uint8Array) => a.reduce((x, y) => x + y, 0);
interface SessionState { step: number; phase: string; strokes: number; heritageBroken: number; hash: string }
declare global { interface Window { __game: GameHandle } }

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('c') as HTMLCanvasElement, hudEl = $('hud'), bannerEl = $('banner'), resultEl = $('result'), errorEl = $('error');
const handle: GameHandle = {
  status: 'loading', engine: '', level: '', phase: 'loading', ready: false, frames: 0, stepIndex: 0, strokes: 0, bodies: 0, fast: false, result: null, counts: {}, timing: { loadMs: 0, stepMs: [] },
  fire: () => false, aim: () => null, select: () => false, load: async () => {}, retry: async () => {}, capture: async () => null,
  state: () => ({ step: 0, phase: 'loading', strokes: 0, heritageBroken: 0, hash: '' }), replay: async () => ({ step: 0, phase: 'loading', strokes: 0, heritageBroken: 0, hash: '' }),
};
window.__game = handle;

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  handle.status = 'error';
  handle.error = msg;
  errorEl.style.display = 'block';
  errorEl.textContent = `Error: ${msg}`;
  console.error(e);
}

function banner(text: string, cls = '') {
  bannerEl.textContent = text;
  bannerEl.className = cls;
  void bannerEl.offsetWidth; // restart the animation
  bannerEl.className = `show ${cls}`;
}

/** Frame the structure; face the par line's launcher when it has one. */
function viewOf(c: CompiledLevel): Orbit {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const o = frame(min, max);
  const first = c.def.solutions?.par?.[0];
  if (first && 'az' in first) o.yaw = ((90 - first.az / 2) * Math.PI) / 180;
  return o;
}

async function main() {
  const q = new URLSearchParams(location.search);
  const offscreen = q.get('offscreen') === '1';
  const levelOf = (id: string) => {
    const i = LEVELS.findIndex((l) => l.id === id.toUpperCase());
    if (i < 0) throw new Error(`unknown level ${id}; known: ${LEVELS.map((l) => l.id).join(', ')}`);
    return i;
  };
  let levelIdx = levelOf(q.get('level') ?? LEVELS[0]!.id);
  const kind = engineKind(q.get('engine'));
  handle.engine = kind;

  const { device } = await createDevice({ timestamps: false });
  const renderer = new Renderer(device, offscreen ? { size: [640, 400] } : { canvas });
  const source = new SnapshotSource(device);
  renderer.setSource(source);
  // The maquette look by default: tints read true on its pale albedo (?look=candy for the rainbow;
  // ?look=real with real.* knobs, parseRealOptions in @tb/render).
  renderer.look = lookByName(q.get('look') ?? '', parseRealOptions(q), HAZY_DAY);
  device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
  device.addEventListener('uncapturederror', (e) => fail((e as GPUUncapturedErrorEvent).error.message));
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
  // Body descriptions in slot order: the structure, then ammo as fired.
  let descs: BodyDesc[] = [];
  let fxSlots = 0;
  let regrowBuf = new Float32Array(0);
  let selected: AmmoKind | null = null;
  let power = 100;
  let aimed: Aimed | null = null, beads: Float64Array | null = null, aimDirty = false;
  let pointer: [number, number] | null = null;
  let regrowT: number | null = null;
  let fastHeld = false;
  let lastHud = '', crownsShown = 0;
  let resultTimer = 0;

  const aspect = () => (offscreen ? 640 / 400 : canvas.width / Math.max(1, canvas.height));
  const courses = () => Math.ceil(c.height / c.frame.unit);

  function load(i: number, retry = false): Promise<void> {
    return exclusive(() => loadNow(i, retry));
  }

  async function loadNow(i: number, retry: boolean) {
    levelIdx = i;
    const t0 = performance.now();
    c = compileLevel(LEVELS[i]!);
    engine?.dispose();
    engine = makeEngine(kind, c, device);
    substeps = engine.info.integrator?.substeps ?? SUBSTEPS;
    driver = new Driver(engine, c, driverOptions(kind));
    await driver.reset();
    handle.timing = { loadMs: performance.now() - t0, stepMs: [] };
    descs = [...c.scene.bodies];
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
    clearTimeout(resultTimer);
    resultEl.className = 'panel';
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
    if (!offscreen) history.replaceState(null, '', `?level=${c.def.id}`);
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
          pacer.hitStop(j.frames);
          juice.shake(j.trauma);
          juice.kick(0.05);
          break;
        }
        case 'crownDown':
          juice.shake(0.08);
          // A felled crown flashes once and stops glowing.
          renderer.setFx(f.body, { tint: TINT.crown, emissive: 0.9, flash: 0.5 });
          break;
        case 'slowMo': if (!fastHeld && !handle.fast) pacer.slowMo(); break;
        case 'heritageCrack':
          juice.shake(0.3);
          banner('Heritage cracked', 'crack');
          renderer.setFx(f.body, { tint: TINT.heritage, emissive: 1, flash: 0.8 });
          break;
        case 'tier': banner(`${TIER_NAMES[f.tier]}!`); break;
        case 'settled':
          pacer.release();
          selected = nextSelection(c.def.rack, driver.session.rackLeft, selected);
          aimDirty = true;
          break;
        case 'levelEnd': {
          handle.result = f.score;
          const show = () => {
            resultEl.innerHTML = resultHtml(c.def, f.score, driver.session.outcomes.length, levelIdx + 1 < LEVELS.length);
            resultEl.className = 'panel show';
            document.body.classList.add('ended');
          };
          resultTimer = window.setTimeout(show, f.cleared ? 700 : 300);
          break;
        }
      }
    }
  }

  /** Mirror state onto the test handle; called each frame and right after anything that changes it. */
  function sync() {
    const s = driver.session;
    Object.assign(handle, { phase: s.phase, ready: s.phase === 'aiming' && regrowT === null, stepIndex: driver.engine.stepIndex, strokes: s.strokes, bodies: driver.snapshot.count });
  }

  function fire(shot: Shot): boolean {
    if (regrowT !== null || !driver.session.canFire(shot.ammo)) return false;
    const step = driver.engine.stepIndex;
    onFeedback(driver.fire(shot));
    descs.push(shotToSpawn(c.frame, shot, step).body);
    fxSlots = descs.length;
    aimed = null;
    beads = null;
    sync();
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
  handle.load = (id) => load(levelOf(id)).catch(fail);
  handle.retry = () => load(levelIdx, true).catch(fail);
  handle.state = () => ({ step: driver.engine.stepIndex, phase: driver.session.phase, strokes: driver.session.strokes, heritageBroken: sum(driver.session.heritageBroken), hash: snapshotHash(driver.snapshot) });
  handle.replay = async (shots) => {
    const e = makeEngine(kind, c, device);
    try {
      const r = await runSession(e, c, shots, driverOptions(kind));
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
      orbit.yaw -= dx * 0.005;
      orbit.pitch = clampPitch(orbit.pitch + dy * 0.005);
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
  resultEl.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'retry') void handle.retry();
    if (act === 'next' && levelIdx + 1 < LEVELS.length) void load(levelIdx + 1).catch(fail);
  });
  addEventListener('keydown', (e) => {
    wakeAudio();
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); fastHeld = true; pacer.release(); }
    const chip = rackChips(c.def.rack, driver.session.rackLeft, selected).find((x) => x.key === e.key);
    if (chip) select(chip.ammo);
    if (k === 'q' || k === 'e') { power = Math.max(0, Math.min(100, power + (k === 'e' ? 10 : -10))); aimDirty = true; }
    if (k === 'r') void handle.retry();
    if (k === 'n' && levelIdx + 1 < LEVELS.length) void load(levelIdx + 1).catch(fail);
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
    if (html !== lastHud) { hudEl.innerHTML = html; lastHud = html; }
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
    const running = driver.session.phase === 'running';
    if (running) await exclusive(async () => {
      if (driver.session.phase !== 'running') return; // a load got in first
      const n = pacer.stepsThisFrame(frameMs, c.scene.dt, { fastForward: fastHeld || handle.fast, stepMs: stepMs.quantile(0.5), budgetMs: 10 });
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const fb = await driver.step();
        const ms = performance.now() - t0;
        stepMs.push(ms);
        handle.timing.stepMs.push(ms);
        onFeedback(fb);
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
}

main().catch(fail);
