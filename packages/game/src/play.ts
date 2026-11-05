// Keystone, played: the rules from @tb/keystone on a PhysicsEngine, drawn by
// @tb/render, with the game's aim, HUD, juice and audio. Physics only runs
// while a shot is in play, in a loop of its own (physics-loop.ts) at a pace the
// Pacer sets (hit-stop, slow motion, fast-forward, the valve, the tail skip),
// while the frames draw on their own; between shots the world is frozen, so a session is exactly
// (level, shots) and replays headless. The game page calls playKeystone with
// its own elements; the viewer calls it for rules=keystone, with hooks for its
// dev panels (docs/design/viewer-superset.md, step C).
import { type BodyDesc, type EngineHealth, limitsHit, type PhysicsEngine, type Vec3 } from '@tb/engine-api';
import { type RackItem, type CompiledLevel, compileLevel, Driver, Duel, type DuelDef, DEFAULT_TURN_SECONDS, type Feedback, type Goal, goalMet, type Player, type Grade, gradeOf, type LevelDef, type LevelScore, type LotSheet, type PerStep, rapidDue, roundFacts, runSession, selectGroups, type Shot, snapshotHash, TIER_NAMES } from '@tb/keystone';
import { clampPitch, eyeOf, type Orbit, rayThrough, viewProj } from '@tb/render/camera';
import type { PixelStats, Renderer, SnapshotSource } from '@tb/render';
import type { HostStats } from '@tb/audio';
import { type Aimed, azFromYaw, pick, previewBeads, pullFor, shotFor, SUBSTEPS } from './aim.ts';
import { Synth, type Voice, voicesFor } from './audio.ts';
import { CollapseSound, type CollapseStatus } from './collapse-sound.ts';
import type { GameSoundMode } from './sound-map.ts';
import { viewOf } from './view.ts';
export { viewOf } from './view.ts';
import { driverOptions, type EngineKind, gpuEngineOptions, makeEngine, roomAfter } from './engines.ts';
import { hudHtml, nextSelection, rackChips, resultHtml, starsText } from './hud.ts';
import { type GoalLine, goalsHudHtml, goalsResultHtml } from './lot-hud.ts';
import { duelHudHtml, duelResultHtml } from './duel-hud.ts';
import { FollowCam } from './follow.ts';
import { CameraJuice, contactJuice } from './juice.ts';
import { alphaAt, arrived, DEFAULT_FEEL, newArrivals, Pacer, type PaceFeel, SLOW_TAG_BELOW, slowTag, SpeedMeter, TailSkip } from './pacing.ts';
import { COST_WINDOW, runPhysics, wakeable } from './physics-loop.ts';
import { CLEAR_SHARE, FrameGovernor } from './frame-rate.ts';
import { beadOverlay, CROWN_GLOW, PULL_HOVER, regrowDuration, regrowScales, structureTints, TINT, tintOf, tintWordOf } from './scene.ts';

/** What a page (and its tests) can see and do while Keystone plays: window.__game on the game page. */
export interface GameHandle {
  status: 'loading' | 'running' | 'error';
  error?: string;
  engine: EngineKind | '';
  level: string;
  phase: string;
  /** Aiming, and the Regrow animation has finished: a shot can be fired. (With rapid fire one can also go in while a shot runs.) */
  ready: boolean;
  frames: number;
  stepIndex: number;
  strokes: number;
  bodies: number;
  /** Outcome levels' live collapse fraction D (Session.liveCollapse): 0 until a shot runs. */
  collapse: number;
  /** Run the sim at fast-forward speed (as if Space were held). */
  fast: boolean;
  /**
   * Pacing now: the valve's time scale (budget / step cost, in [0.25, 1]; up to 4 at fast-forward),
   * the sim speed reached (sim time per real time, measured), the HUD's slow-motion tag ('' at real
   * time), whether the tail skip is on, and the median step cost the valve read when it set that time scale
   * (ms; a cost that lands after it waits for the next step's read, so the two always agree).
   */
  pace: { timeScale: number; speed: number; tag: string; tailSkip: boolean; costMs: number };
  /**
   * The camera's orbit target and distance (m) now, whether the follow camera is moving it (follow.ts; off unless
   * `?keystone.follow=1`), and the jolt the last drawn frame added to the player's view: its largest shake (rad) or
   * field-of-view punch (share of the field of view), 0 unless `?keystone.shake=1` (juice.ts).
   */
  view: { target: [number, number, number]; distance: number; following: boolean; jolt: number };
  result: LevelScore | null;
  /** Feedback events seen this attempt, by type; blastDrawn counts the blasts handed to the renderer to draw. */
  counts: Record<string, number>;
  /** Pace juice in effect (`?keystone.hitstop=1`, `?keystone.slowmo=1`; both off by default). */
  feel: PaceFeel;
  /** Engine step at which this attempt's round-over card first showed, or null. */
  resultShownAt: number | null;
  /**
   * Wall time of this level's load (engine build and pre-settle), and of each live step since, in ms;
   * moving: each live step's structure bodies in motion (Reductions.nMoving, what settle v2 counts);
   * frameMs: the time between drawn frames while a shot runs (frame pacing; with keystone.frames=all,
   * every display frame); costMs: each step's cost as the valve reads it (a GPU step's own time on the
   * GPU, physics-loop.ts), in order of landing.
   */
  timing: { loadMs: number; stepMs: number[]; moving: number[]; frameMs: number[]; costMs: number[] };
  /** Display frames drawn and skipped (keystone.frames, frame-rate.ts), and whether decimation is on now (wanted, and a display of 110 Hz or more). */
  draws: { drawn: number; skipped: number; decimating: boolean };
  /**
   * Fire as a click does: while aiming, or with rapid fire (PaceFeel.rapid) while a shot runs, cutting
   * it; a click during a physics step goes in right after that step. A shot with `after` (a line's
   * rapid-fire shot, Shot.after) goes in that many steps after the shot before, or once it settles if
   * sooner, whatever PaceFeel.rapid says, so a line replays as it was played. False when it cannot.
   */
  fire(shot: Shot): boolean;
  /** Outcome levels: end the level now, keeping the rack left (key B, the HUD's Bank button); false when it cannot. */
  bank(): boolean;
  /** Fire the level's pre-aimed opening shot (KeystoneEnv.opener; key F, the HUD's Fire button): false when there is none now. */
  fireOpener(): boolean;
  /** Mute or unmute every sound (as key M toggles). */
  setMuted(muted: boolean): void;
  /** The most device pixels per CSS pixel the canvas draws (2 by default; 1 is the front door's Fast sharpness). */
  maxDpr: number;
  /** Aim at normalized device coords with the selected ammo, as hovering there would. */
  aim(ndcX: number, ndcY: number): Aimed | null;
  select(ammo: RackItem): boolean;
  load(id: string): Promise<void>;
  retry(): Promise<void>;
  capture(keepPixels?: boolean): Promise<PixelStats | null>;
  /** Physics state now: step, phase and a hash of every pose. */
  state(): SessionState;
  /** This attempt's shots as the session recorded them, a rapid-fire one with `after` (Shot.after): what replay() and a session file replay. */
  line(): Shot[];
  /** The same shots from the same level on a fresh engine, built as the live one, on this device. */
  replay(shots: Shot[]): Promise<SessionState>;
  /**
   * The live engine's limits since this level loaded (PhysicsEngine.health), such as the GPU pair
   * buffer's, or null for an engine without them (Rapier). Read between steps, so it changes no step.
   */
  health(): Promise<EngineHealth | null>;
  /** The live GPU engine's pair room per body (gpuEngineOptions; 0 on Rapier). */
  pairsPerBody: number;
  /**
   * What the last round that hit an engine limit said (EngineLimit.message per limit), empty while
   * none has. Each round is checked once it is over (the round-over card, or a load or retry that
   * ends it), and a round that dropped pairs builds the level's later rounds with room (roomAfter).
   */
  limitsHit: string[];
  /** The collision sound (off until the first click or key; 'off' for good under keystone.sound=synth). */
  sound(): SoundState;
  /** The level's lot sheet as shown (KeystoneEnv.lotSheet): each goal met as of the last settle, final once the round is over. */
  goals: GoalLine[];
  /** The grade the round reached on the level's cast cloud as of the last settle, or null (below E, or no grades). */
  grade: Grade | null;
  /** A duel's state (KeystoneEnv.duel) as of the last settle, or null outside one. */
  duel: DuelState | null;
}
/** What a page and its tests see of a duel. */
export interface DuelState { turn: Player; first: Player; sides: { name: string; share: number; points: number; shotsLeft: number; kingDown: boolean }[]; over: boolean; winner: Player | null; why: string; log: Player[] }
export interface SoundState { mode: GameSoundMode; status: CollapseStatus; error: string; posted: number; stats: HostStats | null }
export interface SessionState { step: number; phase: string; strokes: number; heritageBroken: number; hash: string }

const sum = (a: Uint8Array) => a.reduce((x, y) => x + y, 0);
/** A goal judged; one that cannot be read (a sheet out of step with its level) counts as not met, with a warning. */
function goalMetSafe(g: Goal, f: Parameters<typeof goalMet>[1]): boolean {
  try { return goalMet(g.when, f); } catch (e) { console.warn(`goal ${g.id}: ${(e as Error).message}`); return false; }
}
/** A pull's dust puff (Renderer.burst strength, m/s): a soft one, about a slow contact's. */
export const PULL_PUFF = 2;
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

/** The page's last stage: a fast compressor at -1 dBFS, so the cues and the collision sound (each limited) never clip together. */
function safetyLimiter(ctx: AudioContext): AudioNode {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -1; c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001; c.release.value = 0.1;
  c.connect(ctx.destination);
  return c;
}

/** A handle with nothing loaded yet, for a page to publish before playKeystone fills it in. */
export function newGameHandle(): GameHandle {
  const none = (): SessionState => ({ step: 0, phase: 'loading', strokes: 0, heritageBroken: 0, hash: '' });
  return {
    status: 'loading', engine: '', level: '', phase: 'loading', ready: false, frames: 0, stepIndex: 0, strokes: 0, bodies: 0, collapse: 0, fast: false, pace: { timeScale: 1, speed: 1, tag: '', tailSkip: false, costMs: NaN }, view: { target: [0, 0, 0], distance: 0, following: false, jolt: 0 }, result: null, counts: {}, feel: { ...DEFAULT_FEEL }, resultShownAt: null, timing: { loadMs: 0, stepMs: [], moving: [], frameMs: [], costMs: [] }, draws: { drawn: 0, skipped: 0, decimating: false },
    fire: () => false, bank: () => false, fireOpener: () => false, setMuted: () => {}, maxDpr: 2, aim: () => null, select: () => false, load: async () => {}, retry: async () => {}, capture: async () => null,
    state: none, line: () => [], replay: async () => none(), health: async () => null, pairsPerBody: 0, limitsHit: [], goals: [], grade: null, duel: null,
    sound: () => ({ mode: 'collapse', status: 'off', error: '', posted: 0, stats: null }),
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
    // A rapid-fire shot (after) is handed over as soon as the one before is in: the game fires it at its step.
    const timed = shots[i]!.after !== undefined && i > 0;
    await until(() => (timed && handle.strokes >= i) || handle.ready || handle.result !== null || handle.level !== id || handle.status === 'error');
    if (handle.level !== id || handle.status === 'error') return stop(i, `stopped after ${i} of ${shotsText(shots.length)}: the level changed`);
    if (handle.result) return stop(i, `the level ended after ${i} of ${shotsText(shots.length)}`);
    // Retry (R) mid-line starts a fresh attempt: the rest of the line was not made for it.
    if (handle.strokes !== i) return stop(i, `stopped after ${i} of ${shotsText(shots.length)}: the attempt was restarted`);
    if (!handle.fire(shots[i]!)) return stop(i, `shot ${i + 1} (${shots[i]!.ammo}) could not be fired`);
    if (timed) await until(() => handle.strokes > i || handle.result !== null || handle.level !== id || handle.status === 'error');
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
  /** A shot was fired: the spawn applies at the next step. `shot` as the session recorded it (with `after` when it cut a running shot). */
  fired?(shot: Shot, feedback: Feedback[], d: Driver): void;
  /** One driver step ran; d.snapshot is of engine step d.snapshotStep. */
  stepped?(feedback: Feedback[], d: Driver): void;
  /** The player banked (key B, the HUD's button, GameHandle.bank): the round ends with the rack left. */
  banked?(c: CompiledLevel, d: Driver): void;
  /** The round is over and scored (the result card's tally): a page records progress here. */
  ended?(c: CompiledLevel, score: LevelScore, d: Driver): void;
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
  /** Impacts: @tb/audio's collapse synth (the default) or the old pentatonic voices ('synth'); the cues play either way. */
  sound?: GameSoundMode;
  /** The collapse sound's level, dB over the game's (GAME_SOUND_DB). */
  impactsDb?: number;
  /**
   * The level's pre-aimed opening shot, or null (asked at each load and retry): until the first shot
   * the HUD offers it as a Fire button (key F), so a first-time player's first collapse is one click
   * away (spectacle-mode.md section 11: the first-minute promise).
   */
  opener?(c: CompiledLevel): Shot | null;
  /** Start muted (the front door's Sound setting; key M toggles). */
  muted?: boolean;
  /** The result card's Save session button (shown when given): the page saves the round just ended. */
  onSave?(): void;
  /**
   * The level's lot sheet (docs/game/lot-sheets.md), asked at each load and retry: the sheet, the goals to
   * show (proven ones unless ?keystone.goals=all) and the ids the player met on earlier plays; null for none.
   */
  lotSheet?(c: CompiledLevel): { sheet: LotSheet; goals: readonly Goal[]; before: readonly string[] } | null;
  /**
   * A Siege Table duel (docs/game/siege-table.md): `levels` are then duelLevel(duel, 0) and duelLevel(duel, 1)
   * (who goes first), the duel referees every shot and settle, owned blocks wear their side's ink, and the
   * result card offers a rematch with the other side first.
   */
  duel?: DuelDef;
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
  // Pair room per body a level's later rounds are built with, once a round of it dropped pairs
  // (roomAfter); live play and replay() build with the live round's (livePairs).
  const room = new Map<LevelDef, number>();
  let livePairs: number | undefined;
  // Pair-buffer drops of the live round already reported, so a round checked twice warns once.
  let reportedSteps = 0;
  // The arc preview integrates as the engine does, so it is exact on any engine.
  let substeps = SUBSTEPS;
  // Level loads and physics steps take turns: a load disposes the engine, and
  // a GPU step may still be awaiting its readback.
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const r = lock.then(fn); lock = r.catch(() => {}); return r; };
  const pacer = new Pacer(), juice = new CameraJuice(), speed = new SpeedMeter(), tail = new TailSkip(), follow = new FollowCam();
  /** What the last drawn frame added to the view (handle.view.jolt). */
  let jolt = 0;
  let arrivals = newArrivals();
  let synth: Synth | null = null;
  let muted = env.muted ?? false;
  const soundMode = env.sound ?? 'collapse';
  const collapse = soundMode === 'collapse' ? new CollapseSound(env.impactsDb ?? 0) : null;
  handle.sound = () => ({ mode: soundMode, status: collapse?.status ?? 'off', error: collapse?.error ?? '', posted: collapse?.posted ?? 0, stats: collapse?.stats ?? null });
  const voices: Voice[] = [];

  let c!: CompiledLevel, driver!: Driver, orbit!: Orbit;
  let perStep: PerStep | null = null;
  // Body descriptions in slot order: the driver's (the structure, then every spawn: ammo as fired,
  // a weapon's children, the input hook's, in the order the engine applies them).
  let descs: readonly BodyDesc[] = [];
  const spawned = () => {
    if (driver.bodies.length === descs.length) return;
    descs = driver.bodies;
    fxSlots = descs.length;
  };
  let fxSlots = 0;
  /** What the follow camera frames at most: the lot and a margin, up to half again the structure's height. */
  let followClip = new Float64Array(6);
  /** A physics step is in flight (physics-loop.ts): the session may already read aiming, but the step is not done. */
  let stepping = false;
  /** Shots waiting to go in between steps (fire): clicks during a step, and a line's rapid-fire shots (Shot.after) until their step. */
  let waiting: Shot[] = [];
  let regrowBuf = new Float32Array(0);
  let selected: RackItem | null = null;
  let opener: Shot | null = null;
  let power = 100;
  let aimed: Aimed | null = null, beads: Float64Array | null = null, aimDirty = false;
  /** The block a selected pull would take, lit (PULL_HOVER) until the cursor leaves it or it is pulled. */
  let hover: number | null = null;
  let pointer: [number, number] | null = null;
  let regrowT: number | null = null;
  let fastHeld = false;
  let lastHud = '', crownsShown = 0;
  /** The level's lot sheet and its groups (selected once per load), or null. */
  let lot: { sheet: LotSheet; goals: readonly Goal[]; groups: Record<string, Int32Array> } | null = null;
  /** The duel being played (env.duel), and when the turn in the air was fired (its pace: DuelDef.turnSeconds). */
  let duel: Duel | null = null, turnStart = 0;
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

  /**
   * The live round's engine limits (PhysicsEngine.health) once it is over: a limit hit is reported
   * (handle.limitsHit, the console, a banner) and, for the pair buffer, the level's later rounds get
   * the room the engine names (roomAfter). Runs under the exclusive lock, between steps.
   */
  async function checkRound(): Promise<void> {
    const h = (await driver.engine.health?.()) ?? null;
    const hit = limitsHit(h);
    const steps = hit.reduce((a, l) => a + l.steps, 0);
    if (steps <= reportedSteps) return;
    reportedSteps = steps;
    handle.limitsHit = hit.map((l) => l.message);
    const before = gpuEngineOptions(c, livePairs).pairsPerBody!, after = roomAfter(before, h);
    if (after > before) room.set(c.def, after);
    console.warn(`${c.def.id}: engine limit hit (${handle.limitsHit.join('; ')}); later rounds of this level get pairsPerBody=${room.get(c.def) ?? before}`);
    banner(after > before ? 'Physics limit hit: next round gets more room' : 'Physics limit hit', 'crack');
  }

  async function loadNow(i: number, retry: boolean) {
    const t0 = performance.now();
    // The round being left is over: check what it hit before its engine goes.
    if (engine) await checkRound();
    // Build and pre-settle the new level aside: the GPU's pre-settle spans many
    // frames, and every frame reads the current level, so it swaps in whole.
    const next = compileLevel(levels[i]!);
    const nextPairs = room.get(levels[i]!);
    const nextEngine = makeEngine(kind, next, device, nextPairs);
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
    livePairs = nextPairs;
    reportedSteps = 0;
    handle.pairsPerBody = kind === 'gpu' ? gpuEngineOptions(c, livePairs).pairsPerBody! : 0;
    substeps = engine.info.integrator?.substeps ?? SUBSTEPS;
    handle.timing = { loadMs: performance.now() - t0, stepMs: [], moving: [], frameMs: [], costMs: [] };
    descs = driver.bodies;
    perStep = env.perStep?.(c) ?? null;
    collapse?.load(c);
    source.reset(c.scene.bodies);
    source.update(driver.snapshot, descs);
    // Fresh effects: role tints, and every body at scale 0 for Regrow.
    if (fxSlots) renderer.clearFx(0, fxSlots);
    regrowBuf = regrowScales(c, 0, new Float32Array(c.meta.n));
    duel = env.duel ? new Duel(env.duel, c, i as Player, driver.session.home) : null;
    const tints = structureTints(c);
    // Owner ink: each side's blocks in its colour, its king glowing a little as crowns do.
    if (duel) duel.owned.forEach((idx, k) => { for (const b of idx) tints[b] = tintWordOf(duel!.def.sides[k]!.ink, c.meta.role[b] === 1 ? CROWN_GLOW : 0); });
    renderer.setFx(0, tints, regrowBuf, true);
    fxSlots = c.meta.n;
    pacer.reset();
    speed.reset();
    tail.reset();
    arrivals = newArrivals();
    juice.reset();
    follow.reset();
    renderer.blasts.clear();
    const m = 4 * c.frame.unit;
    followClip = Float64Array.of(c.lot.min[0] - m, 0, c.lot.min[1] - m, c.lot.max[0] + m, 1.5 * c.height + m, c.lot.max[1] + m);
    handle.result = null;
    handle.counts = {};
    handle.level = c.def.id;
    ending = false;
    handle.resultShownAt = null;
    env.result.classList.remove('show');
    document.body.classList.remove('ended');
    selected = nextSelection(c.def.rack, driver.session.rackLeft, retry ? selected : null);
    opener = env.opener?.(c) ?? null;
    if (!retry) {
      orbit = viewOf(c);
      power = 100;
      // The play area: the lot (where debris counts), grown a little, up to the structure's top.
      const half: Vec3 = [(c.lot.max[0] - c.lot.min[0]) / 2 + 2, c.height / 2 + 2, (c.lot.max[1] - c.lot.min[1]) / 2 + 2];
      renderer.setShadowBounds([(c.lot.min[0] + c.lot.max[0]) / 2, c.height / 2, (c.lot.min[1] + c.lot.max[1]) / 2], Math.hypot(...half), half);
    }
    regrowT = 0;
    waiting = [];
    aimed = null;
    beads = null;
    hover = null; // the new level's tints are fresh
    aimDirty = true;
    crownsShown = 0;
    const ls = env.lotSheet?.(c) ?? null;
    lot = ls && { sheet: ls.sheet, goals: ls.goals, groups: selectGroups(c, ls.sheet.groups ?? {}) };
    handle.goals = (ls?.goals ?? []).map((g) => ({ id: g.id, text: g.text, met: false, before: ls!.before.includes(g.id) }));
    handle.grade = null;
    syncDuel();
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

  /** Light the block a pull would take (null: none), putting the last one back to its own tint. */
  function setHover(b: number | null) {
    if (b === hover) return;
    if (hover !== null) renderer.setFx(hover, Uint32Array.of(tintOf(c, hover)));
    hover = b;
    if (b !== null) renderer.setFx(b, Uint32Array.of(PULL_HOVER));
  }

  function updateAim() {
    aimDirty = false;
    aimed = null;
    beads = null;
    let lit: number | null = null;
    if (pointer && selected && aimable() && regrowT === null) {
      const hit = pick(rayThrough(orbit, aspect(), pointer[0], pointer[1]), driver.snapshot, c);
      if (selected === 'pull') {
        // A pull takes the block under the cursor: lit when it can be taken, no arc.
        const p = pullFor(driver.session, hit);
        aimed = p;
        if (p?.reachable) lit = p.shot.body;
      } else if (hit) {
        aimed = shotFor(c, selected, azFromYaw(orbit.yaw), power, hit.point, substeps);
        if (aimed) beads = previewBeads(c, aimed.shot, hit.point, substeps);
      }
    }
    setHover(lit);
  }

  /** Mirror the duel onto the handle. */
  function syncDuel() {
    if (!duel) { handle.duel = null; return; }
    const r = duel.result;
    handle.duel = {
      turn: duel.turn, first: duel.first, over: r.over, winner: r.over ? r.winner : null, why: r.over ? r.why : '', log: duel.log.map((x) => x.player),
      sides: duel.sides.map((st, k) => ({ name: duel!.def.sides[k]!.name, share: st.share, points: st.points, shotsLeft: st.shotsLeft, kingDown: st.kingDown })),
    };
  }

  /** The rack chips as the HUD shows them: in a duel, the player to fire's own rack. */
  function chipsNow() {
    if (duel) return rackChips(duel.def.sides[duel.turn].rack, duel.left[duel.turn], selected);
    return rackChips(c.def.rack, driver.session.rackLeft, selected);
  }

  /** The lot sheet's goals and grade judged on the round as it stands (after a settle, and at its end). */
  function judgeGoals() {
    if (!lot) return;
    const f = roundFacts(c, driver.session, driver.snapshot, lot.groups);
    handle.goals = lot.goals.map((g, k) => ({ ...handle.goals[k]!, met: goalMetSafe(g, f) }));
    handle.grade = gradeOf(lot.sheet.grades, f);
  }

  function onFeedback(fb: Feedback[]) {
    for (const f of fb) {
      handle.counts[f.t] = (handle.counts[f.t] ?? 0) + 1;
      voices.push(...voicesFor(f, { impacts: !collapse }));
      switch (f.t) {
        case 'fired':
          juice.kick(f.ammo === 'cannonball' ? 0.05 : 0.03);
          if (f.ammo === 'pull') {
            // The block is gone (the renderer skips the tombstone): a puff of dust where it was.
            const s = driver.snapshot, b = f.body;
            if (b < s.count) renderer.burst([s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], [0, 1, 0], PULL_PUFF);
          }
          break;
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
          // Only where the clear ends the level: par levels, and outcome levels with autobank.
          if (c.def.objective.kind === 'crowns' && f.ordinal + 1 === c.meta.crowns.length && driver.session.phase === 'running' && (driver.session.scoring === 'par' || c.def.autobank)) {
            ending = true;
            pacer.release();
            showResult(null);
          }
          break;
        case 'blast': {
          // A weapon went off: its fireball, shell (out to the blast's reach) and light (@tb/render blasts.ts),
          // where its spent shell was removed (a removed body stays put); a hard shake when shake is on.
          const s = driver.snapshot, b = f.body;
          if (b >= 0 && b < s.count) {
            renderer.blast([s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], f.radius);
            handle.counts.blastDrawn = (handle.counts.blastDrawn ?? 0) + 1;
          }
          juice.shake(Math.min(1, 0.15 * (f.radius / c.frame.unit)));
          juice.kick(0.08);
          break;
        }
        case 'slowMo': if (feel.slowMo && !fastHeld && !handle.fast) pacer.slowMo(); break;
        case 'heritageCrack':
          juice.shake(0.3);
          banner('Heritage cracked', 'crack');
          renderer.setFx(f.body, { tint: TINT.heritage, emissive: 1, flash: 0.8 });
          break;
        case 'tier': banner(`${TIER_NAMES[f.tier]}!`); break;
        case 'settled':
          judgeGoals();
          pacer.release();
          // A crown back above the line (rare: a catapult) means the round goes on after all.
          if (ending && driver.session.phase === 'aiming') { ending = false; hideResult(); }
          selected = nextSelection(c.def.rack, driver.session.rackLeft, selected);
          if (duel && duel.shooter !== null) {
            const r = duel.settled(driver.snapshot), side = duel.def.sides[duel.turn];
            syncDuel();
            // Decided before the racks are spent: end the round here (a bank, once this step's feedback is done).
            if (r.over) queueMicrotask(() => { if (driver.session.phase === 'aiming') bank(); });
            else {
              selected = nextSelection(side.rack, duel.left[duel.turn], null);
              banner(`${side.name}'s turn`);
            }
          }
          aimDirty = true;
          break;
        case 'levelEnd':
          judgeGoals();
          handle.result = f.score;
          ending = false;
          showResult(f.score);
          hooks.ended?.(c, f.score, driver);
          // The round is over: check its limits once this step is done (checkRound).
          void exclusive(checkRound).catch(fail);
          break;
      }
    }
  }

  function showResult(score: LevelScore | null) {
    if (duel) {
      if (!score) return;
      env.result.innerHTML = duelResultHtml(duel);
      env.result.classList.add('show');
      document.body.classList.add('ended');
      handle.resultShownAt ??= driver.engine.stepIndex;
      return;
    }
    const sheet = score && lot ? goalsResultHtml(handle.goals, handle.grade, lot.sheet.grades !== undefined) : '';
    env.result.innerHTML = resultHtml(c.def, score, driver.session.strokes, levelIdx + 1 < levels.length, Boolean(env.onSave), sheet);
    env.result.classList.add('show');
    document.body.classList.add('ended');
    handle.resultShownAt ??= driver.engine.stepIndex;
  }

  function hideResult() {
    env.result.classList.remove('show');
    document.body.classList.remove('ended');
    handle.resultShownAt = null;
  }

  /** Mirror the round's state onto the handle: each frame, and after each physics step (which runs between frames). */
  function syncState() {
    const s = driver.session;
    Object.assign(handle, { phase: stepping ? 'running' : s.phase, ready: !stepping && s.phase === 'aiming' && regrowT === null, stepIndex: driver.engine.stepIndex, strokes: s.strokes, bodies: driver.snapshot.count, collapse: s.liveCollapse });
  }

  /** Mirror state, pace and view onto the handle; called each frame and right after anything that changes it.
   * Pace and view are what the frame drew (the HUD tag, the camera), so only a frame mirrors them. */
  function sync() {
    syncState();
    const s = driver.session;
    const running = s.phase === 'running', v = running ? speed.speed(performance.now()) : 1, costs = handle.timing.costMs;
    handle.pace = { timeScale: running ? pacer.timeScale : 1, speed: v, tag: running && !fastHeld && !handle.fast && !ending && !tail.on ? slowTag(v) : '', tailSkip: tail.on, costMs: running && !Number.isNaN(pacer.costMs) ? pacer.costMs : median(costs.slice(-60)) };
    handle.view = { target: [...orbit.target], distance: orbit.distance, following: follow.active, jolt };
  }

  /** The physics loop's idle wait: the next frame, or a fire, whichever comes first (physics-loop.ts wakeable). */
  const physicsIdle = wakeable(() => new Promise<void>((res) => requestAnimationFrame(() => res())));

  /** Whether the player can aim (and fire) now: while aiming, or with rapid fire while a shot runs, until the round is known to be over. */
  function aimable(): boolean {
    const p = driver.session.phase;
    return p === 'aiming' || (p === 'running' && feel.rapid && !ending);
  }

  /** Whether `shot` may go in when its turn comes: the rack holds one more of it than the shots already waiting. */
  const inRack = (shot: Shot, queued: readonly Shot[]) =>
    driver.session.rackLeft.filter((a) => a === shot.ammo).length > queued.filter((q) => q.ammo === shot.ammo).length;

  function fire(shot: Shot): boolean {
    if (loading || regrowT !== null || ending || handle.result !== null || !driver.session.canFire(shot.ammo) || !inRack(shot, waiting)) return false;
    // A duel takes one shot per turn from the current player's side and rack (the referee says why not).
    const refused = duel?.refuse(shot) ?? (duel && waiting.length ? { message: 'Wait for the last shot to settle' } : null);
    if (refused) { banner(refused.message, 'crack'); return false; }
    const timed = shot.after !== undefined && driver.session.strokes > 0;
    if (!timed && !aimable()) return false;
    if (shot.ammo === 'pull' && driver.session.pullRefusal(shot.body) !== null) return false;
    // Without rapid fire a click mid-step is refused, as before; with it, or for a line's timed shot, it waits for the step.
    if (stepping || timed || waiting.length) {
      if (stepping && !timed && !feel.rapid) return false;
      waiting.push(shot);
      if (!stepping) fireDue();
      return true;
    }
    fireNow(shot);
    return true;
  }

  /** Between steps: the waiting shots whose time has come, in order (a timed one at its step, or at once once the shot before has settled). */
  function fireDue() {
    while (waiting.length) {
      const s = driver.session, next = waiting[0]!;
      if (s.phase !== 'aiming' && s.phase !== 'running') { waiting = []; return; }
      if (next.after !== undefined && s.phase === 'running' && !rapidDue(driver, next)) return;
      waiting.shift();
      if (!s.canFire(next.ammo) || (next.ammo === 'pull' && s.pullRefusal(next.body) !== null) || duel?.refuse(next)) continue;
      fireNow(next);
    }
  }

  function fireNow(shot: Shot) {
    setHover(null);
    const fb = driver.fire(shot);
    if (duel) { duel.fired(shot); turnStart = performance.now(); syncDuel(); }
    // The shot's first step goes in now, not at the next frame.
    physicsIdle.kick();
    // A shot's pace starts fresh: no tail yet, and at real time until its steps say otherwise.
    tail.reset();
    speed.reset();
    // A rapid shot keeps the follow camera's way home: where the player had it when the first went in.
    if (feel.follow && !follow.active) follow.start(orbit);
    onFeedback(fb);
    spawned();
    selected = nextSelection(c.def.rack, driver.session.rackLeft, selected);
    aimed = null;
    beads = null;
    aimDirty = true;
    sync();
    hooks.fired?.(driver.session.inputs[driver.session.inputs.length - 1]!.shot, fb, driver);
  }

  /** The opener while it can be fired: before the first shot, its ammo in the rack. */
  const openerNow = (): Shot | null => (opener && driver.session.strokes === 0 && driver.session.canFire(opener.ammo) ? opener : null);

  function fireOpener(): boolean {
    const o = openerNow();
    return o !== null && fire(o);
  }

  function setMuted(m: boolean) {
    muted = m;
    if (synth) synth.muted = muted;
    collapse?.setMuted(muted);
  }

  function bank(): boolean {
    if (stepping || regrowT !== null || !driver.session.canBank()) return false;
    hooks.banked?.(c, driver);
    onFeedback(driver.bank());
    aimed = null;
    beads = null;
    sync();
    return true;
  }

  function select(a: RackItem): boolean {
    if (!driver.session.rackLeft.includes(a) || (duel && !duel.left[duel.turn].includes(a))) return false;
    selected = a;
    aimDirty = true;
    return true;
  }

  handle.fire = fire;
  handle.bank = bank;
  handle.fireOpener = fireOpener;
  handle.setMuted = setMuted;
  handle.select = select;
  handle.aim = (x, y) => { pointer = [x, y]; updateAim(); return aimed; };
  handle.load = (id) => load(levelIndex(id)).catch(fail);
  handle.retry = () => load(levelIdx, true).catch(fail);
  handle.line = () => driver.session.inputs.map((i) => ({ ...i.shot }));
  handle.state = () => ({ step: driver.engine.stepIndex, phase: driver.session.phase, strokes: driver.session.strokes, heritageBroken: sum(driver.session.heritageBroken), hash: snapshotHash(driver.snapshot) });
  // Between steps and loads, so neither a step nor a load's dispose runs under the read.
  handle.health = () => exclusive(async () => (await driver.engine.health?.()) ?? null);
  handle.replay = async (shots) => {
    const e = makeEngine(kind, c, device, livePairs);
    try {
      const r = await runSession(e, c, shots, { ...driverOptions(kind), perStep: env.perStep?.(c) });
      return { step: r.steps, phase: r.session.phase, strokes: r.session.strokes, heritageBroken: sum(r.session.heritageBroken), hash: snapshotHash(r.snapshot) };
    } finally { e.dispose(); }
  };

  // Audio needs a user gesture before it may start.
  // One context for the cues (Synth) and the collision sound, summed into a last safety limiter.
  const wakeAudio = () => {
    if (!synth) {
      try {
        const ctx = new AudioContext({ latencyHint: 'interactive' }), master = safetyLimiter(ctx);
        synth = new Synth(ctx, master);
        synth.muted = muted;
        collapse?.setMuted(muted);
      } catch { return; }
    }
    if (synth.ctx.state === 'suspended') void synth.ctx.resume();
    collapse?.wake(synth.ctx, synth.master);
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
    if (drag.moved >= 5) follow.grab(); // the player has the camera: the follow lets go for this shot
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
    follow.grab();
    orbit.distance = Math.min(200, Math.max(3, orbit.distance * Math.exp(e.deltaY * 0.001)));
    aimDirty = true;
  }, { passive: false });
  env.hud.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act) wakeAudio();
    if (act === 'bank') bank();
    if (act === 'opener') fireOpener();
  });
  env.result.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'retry') void handle.retry();
    if (act === 'save') env.onSave?.();
    if (act === 'next' && levelIdx + 1 < levels.length) void load(levelIdx + 1).catch(fail);
    // A duel: Rematch starts the other side first (the other of its two levels); Same start replays this one.
    if (act === 'rematch' && duel) void load(1 - levelIdx).catch(fail);
    if (act === 'again' && duel) void handle.retry();
  });
  addEventListener('keydown', (e) => {
    if (typing(e)) return;
    wakeAudio();
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); fastHeld = true; pacer.release(); }
    const chip = chipsNow().find((x) => x.key === e.key);
    if (chip) select(chip.ammo);
    if (k === 'q' || k === 'e') { power = Math.max(0, Math.min(100, power + (k === 'e' ? 10 : -10))); aimDirty = true; }
    if (k === 'b') bank();
    if (k === 'f') fireOpener();
    // In a duel, R after the result is a rematch (the other side starts), as the card's first button says.
    if (k === 'r') void (duel?.result.over ? load(1 - levelIdx).catch(fail) : handle.retry());
    if (!duel && k === 'n' && levelIdx + 1 < levels.length) void load(levelIdx + 1).catch(fail);
    if (!duel && k === 'p' && levelIdx > 0) void load(levelIdx - 1).catch(fail);
    if (k === 'm') setMuted(!muted);
  });
  addEventListener('keyup', (e) => { if (e.key === ' ') fastHeld = false; });

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, handle.maxDpr);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function drawHud() {
    const s = driver.session;
    const crownsDown = s.crownLive.reduce((a, x) => a + x, 0);
    let html = hudHtml({
      level: c.def, strokes: s.strokes, crownsDown, crownsTotal: c.meta.crowns.length,
      heritageBroken: s.heritageBroken.reduce((a, x) => a + x, 0), heritageTotal: c.meta.heritage.length,
      chips: chipsNow(), power, liveLeverage: s.liveLeverage, phase: s.phase,
      reachable: aimed ? aimed.reachable : null,
      pullRefused: aimed?.shot.ammo === 'pull' && !aimed.reachable,
      collapse: s.liveCollapse, pulled: s.pulledShare(), met: s.objectiveDone, canBank: !stepping && regrowT === null && s.canBank(), pace: handle.pace.tag,
      opener: !stepping && regrowT === null && s.phase === 'aiming' && openerNow() !== null,
      ...(duel ? { duel: duelHudHtml(duel, s.phase === 'aiming' && aimed ? duel.refuse(aimed.shot) : null) } : {}),
    });
    html += goalsHudHtml(handle.goals);
    if (crownsDown > crownsShown) html = html.replace('class="crowns"', 'class="crowns pop"');
    crownsShown = crownsDown;
    if (html !== lastHud) { env.hud.innerHTML = html; lastHud = html; }
  }

  await load(levelIdx);
  handle.status = 'running';
  let last = performance.now(), lastDrawn = NaN;
  const frames = new FrameGovernor(feel.frames);
  let pendingCapture: { resolve: (s: PixelStats | null) => void; keep: boolean } | null = null;
  handle.capture = (keep = false) => new Promise((resolve) => { pendingCapture = { resolve, keep }; });

  const tick = async () => {
    const now = performance.now(), frameMs = now - last;
    last = now;
    const dt = Math.min(frameMs / 1000, 0.1);
    const want = pendingCapture;
    resize();
    if (regrowT !== null) {
      regrowT += dt;
      const done = regrowT >= regrowDuration(courses());
      renderer.setFx(0, null, regrowScales(c, done ? Infinity : regrowT, regrowBuf), !done);
      if (done) { regrowT = null; aimDirty = true; }
    }
    const running = !loading && driver.session.phase === 'running';
    // Physics is behind when the sim runs under the HUD's slow-motion speed without being asked to
    // (slow-motion juice, fast-forward); it has headroom when steps cost under CLEAR_SHARE of a step.
    const fast = fastHeld || handle.fast || ending || tail.on || turnUp(), costMs = median(handle.timing.costMs.slice(-COST_WINDOW));
    const draw = frames.frame(now, { idle: !running, behind: running && !fast && !pacer.slowing && speed.speed(now) < SLOW_TAG_BELOW, clear: costMs < CLEAR_SHARE * 1000 * c.scene.dt }, !!want);
    handle.draws = { drawn: frames.drawn, skipped: frames.skipped, decimating: frames.decimating };
    if (draw) {
      if (running && !Number.isNaN(lastDrawn)) handle.timing.frameMs.push(now - lastDrawn);
      lastDrawn = now;
    }
    if (!running) collapse?.pause(); // between shots: the next step's audio frame starts afresh
    // Aiming while a shot runs (rapid fire): the world moves under the pointer, so aim again each frame.
    if (running && pointer && aimable()) aimDirty = true;
    if (follow.active) {
      const red = loading ? undefined : driver.observed?.red;
      follow.update(orbit, dt, running, red?.movingBox ?? null, red?.nMoving ?? 0, c.frame.unit, followClip);
      aimDirty = true;
    }
    if (aimDirty) updateAim();
    sync();

    // The juice runs either way, so switching shake on mid-shot picks up where it stands; the view takes it only when asked.
    const juiced = juice.update(dt), shake = feel.shake ? juiced : { yaw: 0, pitch: 0, fovScale: 1 };
    const view: Orbit = { ...orbit, yaw: orbit.yaw + shake.yaw, pitch: orbit.pitch + shake.pitch, fovY: orbit.fovY * shake.fovScale };
    handle.view.jolt = jolt = Math.max(Math.abs(shake.yaw), Math.abs(shake.pitch), 1 - shake.fovScale);
    const o = beads ? beadOverlay(beads, aimed?.reachable ?? true) : null;
    renderer.setOverlay(o?.xyzr ?? new Float32Array(0), o?.colours);
    pendingCapture = null;
    const fp = { viewProj: viewProj(view, aspect()), eye: eyeOf(view), focus: orbit.target, time: now / 1000, groundY: 0, alpha: running ? alphaAt(arrivals, now, 1000 * c.scene.dt) : 1 };
    // Offscreen (tests), nobody sees a frame and nothing throttles requestAnimationFrame
    // to the GPU: on SwiftShader a frame takes up to a second, so frames would queue
    // without bound and every readback (a step's, a replay's) wait behind them.
    // There, draw only for a capture.
    if ((!offscreen && draw) || want) {
      const stats = await renderer.render(fp, !!want, want?.keep);
      if (want) want.resolve(stats);
    }
    if (voices.length) { synth?.play(voices); voices.length = 0; }
    drawHud();
    handle.frames++;
    if (handle.status === 'running') requestAnimationFrame(() => void tick().catch(fail));
  };
  requestAnimationFrame(() => void tick().catch(fail));

  // Physics, in its own loop: a step runs when one is due and never inside a frame (physics-loop.ts).
  const channel = new MessageChannel(), tasks: Array<() => void> = [];
  channel.port1.onmessage = () => tasks.shift()?.();
  const task = () => new Promise<void>((res) => { tasks.push(res); channel.port2.postMessage(null); });
  // A duel turn runs at its own pace for turnSeconds, then fast-forwards the rest of its settle.
  const turnUp = () => duel !== null && duel.shooter !== null && performance.now() - turnStart > 1000 * (duel.def.turnSeconds ?? DEFAULT_TURN_SECONDS);
  const fastNow = () => fastHeld || handle.fast || ending || tail.on || turnUp();
  void runPhysics({
    now: () => performance.now(),
    alive: () => handle.status === 'running',
    active: () => !loading && driver.session.phase === 'running',
    dtMs: () => 1000 * c.scene.dt,
    options: () => ({ fastForward: fastNow(), budgetMs: feel.budgetMs }),
    idle: physicsIdle.wait,
    task,
    step: () => exclusive(async () => {
      if (loading || driver.session.phase !== 'running') return null; // a load got in first, or the shot ended
      const d = driver, started = performance.now();
      // A step that ends the shot leaves the session aiming before it returns (the pipelined driver
      // still awaits the last read): until it has, no frame may show it ready, and no shot or bank may go in.
      stepping = true;
      let fb: Feedback[];
      try { fb = await d.step(); } finally { stepping = false; }
      const submitted = performance.now();
      handle.timing.stepMs.push(submitted - started);
      const red = d.observed?.red;
      handle.timing.moving.push(red?.nMoving ?? 0);
      speed.step(submitted, c.scene.dt);
      onFeedback(fb);
      hooks.stepped?.(fb, d);
      const input = perStep?.(d);
      if (input?.length) d.push(input);
      // Shots clicked during the step, and a line's timed shots now due, go in before the next (as playShots fires them).
      fireDue();
      spawned();
      if (red && feel.tailSkip && d.session.phase === 'running') tail.update(red.nMoving, c.meta.n, d.session.liveCollapse);
      source.update(d.snapshot, descs);
      collapse?.frame(d.snapshot, descs, eyeOf(orbit), orbit.target);
      arrived(arrivals, performance.now(), 1000 * c.scene.dt);
      // Steps run between frames: mirror what this one changed (phase, strokes) now, so the handle
      // never shows a step's result while still saying running until the next frame.
      syncState();
      // A GPU step only submits: its cost is read when the GPU reports it done.
      const done = d.engine.finish ? d.engine.finish().then(() => performance.now()) : undefined;
      return { started, submitted, done, yielded: !!d.engine.finish };
    }),
  }, pacer, undefined, (ms) => handle.timing.costMs.push(ms)).catch(fail);
  return handle;
}
