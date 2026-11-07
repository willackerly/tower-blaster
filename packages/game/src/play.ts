// Keystone, played: the rules from @tb/keystone on a PhysicsEngine, drawn by
// @tb/render, with the game's aim, HUD, juice and audio. Physics only runs
// while a shot is in play, in a loop of its own (physics-loop.ts) at a pace the
// Pacer sets (hit-stop, slow motion, fast-forward, the valve, the tail skip),
// while the frames draw on their own; between shots the world is frozen, so a session is exactly
// (level, shots) and replays headless. The game page calls playKeystone with
// its own elements; the viewer calls it for rules=keystone, with hooks for its
// dev panels (docs/design/viewer-superset.md, step C).
import { type BodyDesc, type EngineHealth, limitsHit, type PhysicsEngine, type Vec3 } from '@tb/engine-api';
import { armRefusal, type RackItem, type CompiledLevel, compileLevel, Driver, type DriverCheckpoint, Duel, type DuelDef, DEFAULT_TURN_SECONDS, type Feedback, type Footprint, type Goal, goalMet, type Player, type Grade, gradeOf, type LevelDef, type LevelScore, type LotSheet, type PerStep, playShots, rapidDue, roundFacts, RUBE_GO, runSession, selectFootprints, selectGroups, type Shot, isIcePiece, QUAKE, MasonTrial, masonWorlds, snapshotHash, TIER_NAMES } from '@tb/keystone';
import { DIAL_KEYS, type DialField, dialShot, dialStart, dialStep, type QuakeDial, quakePanelHtml, seismogram } from './quake-panel.ts';
import { clampPitch, eyeOf, type Orbit, rayThrough, viewProj } from '@tb/render/camera';
import type { EffectStats, Fx, FxOptions, PixelStats, Renderer, SnapshotSource } from '@tb/render';
import type { HostStats } from '@tb/audio';
import type { WeaponTier } from '@tb/weapons';
import { type Aimed, arcContact, azFromYaw, type Contact, launchHeight, launchStep, pick, previewBeads, pullFor, shotFor, SUBSTEPS } from './aim.ts';
import { Synth, type Voice, voicesFor } from './audio.ts';
import { CollapseSound, type CollapseStatus } from './collapse-sound.ts';
import { type GameSoundMode, soundSetOf } from './sound-map.ts';
import { openingInsets, viewOf } from './view.ts';
import { DOCK_PORTRAIT, DOCK_SIDEWAYS } from './ui.ts';
import { outlineAreas, pixelCounts, type ScreenRect } from './sightlines.ts';
import { ViewSun } from './light.ts';
export { viewOf } from './view.ts';
import { driverOptions, type EngineKind, gpuEngineOptions, makeEngine, makeMasonEngine, roomAfter } from './engines.ts';
import { type CardForward, hudHtml, meterTicks, trialText, type MeterTick, nextSelection, POWER_STEP, rackChips, resultHtml, starsText, tallyHtml } from './hud.ts';
import { hudInsets, type Layout, type ScreenInsets } from './layout.ts';
import { type GoalLine, goalsHudHtml, goalsResultHtml } from './lot-hud.ts';
import { duelHudHtml, duelResultHtml, handoffHtml, scoreFloatHtml } from './duel-hud.ts';
import { arcBeads, duelMarks, duelView, joinOverlays, type Overlay, turnCue, turnCueText, TurnSwing } from './duel-view.ts';
import { FollowCam } from './follow.ts';
import { CameraJuice, contactJuice } from './juice.ts';
import { alphaAt, arrived, DEFAULT_FEEL, newArrivals, Pacer, type PaceFeel, SLOW_TAG_BELOW, slowTag, SpeedMeter, TailSkip } from './pacing.ts';
import { COST_WINDOW, runPhysics, wakeable } from './physics-loop.ts';
import { CLEAR_SHARE, FrameGovernor } from './frame-rate.ts';
import { canvasSize, type QualityState } from './quality.ts';
import { UndoMarks } from './undo-marks.ts';
import { FusePanel } from './fuse-panel.ts';
import { lotBeads, panelTimeline, planBeads, timelineOverlay } from './fuse-timeline.ts';
import { BELL_FLASH, RING_REACH, startBeads, zoneBeads } from './rube-view.ts';
import { ballFx, beadOverlay, BOMB_FX, CROWN_GLOW, firedKind, PULL_HOVER, ramFx, regrowDuration, regrowScales, roleTint, rolePaint, SPENT_FADE, spentFx, structureCoats, duelCoats, duelTint, duelTints, structureMarks, structureTints, tintOf, tintWordOf, xrayOn } from './scene.ts';
import { easeGrade, FROZEN_LABEL, freezeFxOf } from './frozen-look.ts';
import { ghostOutline, PULL_SLIDE_STEPS, type PullAnim, pullAnimFor, withPulled } from './pull-anim.ts';
import { type GestureState, type TouchAction, TouchGestures, touchFace, type TouchMode } from './touch.ts';
import { EditController } from './edit.ts';
import { applyEditAction, type EditAction, mountEditPanel } from './edit-panel.ts';
import { EditView } from './edit-view.ts';

/** What a page (and its tests) can see and do while Keystone plays: window.__game on the game page. */
/**
 * The build phase (C9, docs/game/placement.md) as a test or the console drives it: what the Build panel and the
 * pointer do, by world rays. Only on a level with a build block, before its first shot.
 */
export interface GameEditHandle {
  /** Building now: time stopped, the level as built drawn at its authored poses. */
  readonly on: boolean;
  /** Enter the build phase (false when the level offers none, or a shot has gone in); Play; leave without the edits. */
  enter(): boolean;
  play(): void;
  cancel(): void;
  /** A key as the build phase takes it (Q / E turn, T tip, 1 to 9 items, B brush, X erase, Z undo); whether it was one. */
  key(k: string, shift?: boolean): boolean;
  /** The pointer as a world ray: hover (or a stroke's drag), press, release. */
  ray(kind: 'move' | 'down' | 'up', origin: [number, number, number], dir: [number, number, number], alt?: boolean): void;
  status(): string;
  /** The level as built (null when not building). */
  def(): LevelDef | null;
  /** The ghost's bodies drawn now. */
  ghosts(): number;
  /** The hash of the level the last Play started (compileLevel of the built definition); null before. */
  played: string | null;
}

export interface GameHandle {
  status: 'loading' | 'running' | 'error';
  error?: string;
  engine: EngineKind | '';
  level: string;
  phase: string;
  /** Aiming, and the Regrow animation has finished: a shot can be fired. (With rapid fire one can also go in while a shot runs.) */
  ready: boolean;
  /** Bullet Time: the physics is frozen mid-shot (key T); the world stands still to be aimed at, and a shot fired cuts in and resumes it. */
  frozen: boolean;
  frames: number;
  stepIndex: number;
  strokes: number;
  bodies: number;
  /** Outcome levels' live collapse fraction D (Session.liveCollapse): 0 until a shot runs. */
  collapse: number;
  /** Run the sim at fast-forward speed (as if Space were held). */
  fast: boolean;
  /**
   * Test hook (the agent playtest's captures, agent playtest PT12): while true no physics step runs, and
   * frames still draw, so a capture's picture and its HUD show the same step. Rapier steps on the CPU
   * while SwiftShader takes many frames to render, so round 1's "+25 steps" frames showed the scene at
   * step 25 under a HUD read 150 steps later (B1 Down 16% over a standing wall). Pacing only.
   */
  hold: boolean;
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
   * field-of-view punch (share of the field of view), 0 unless `?keystone.shake=1` (juice.ts). In a duel
   * (duel-view.ts): whether the turn view is swinging the camera to the next side, the HUD's turn cue (which way
   * to drag to reach the side to fire, null when the view is on it), how many arc beads the frame drew, whether it drew
   * the impact marker (PT14), and whether the objectives show through what hides them (keystone.xray).
   */
  view: { target: [number, number, number]; distance: number; yaw: number; pitch: number; following: boolean; jolt: number; turning: boolean; cue: 'left' | 'right' | null; arcBeads: number; impact: boolean; xray: boolean };
  /**
   * The player's controls now: whether the page shows its touch face (touch.ts touchFace: the HUD's
   * tap buttons and the touch help; body class kg-touch), the touch gesture under way and fingers down,
   * the shot aimed (by hover, a finger or handle.aim), the power, and the launcher height in 1/4 h (aim.ts
   * launchHeight for the level and PaceFeel.launch, moved by keys W and S: launchStep).
   */
  input: { touch: boolean; gesture: GestureState; fingers: number; aimed: Shot | null; power: number; launch: number };
  result: LevelScore | null;
  /** Feedback events seen this attempt, by type; blastDrawn counts the blasts handed to the renderer to draw, bomb the bodies drawn as bombs; undo counts undos (an undo keeps the counts). */
  counts: Record<string, number>;
  /** Pace juice in effect (`?keystone.hitstop=1`, `?keystone.slowmo=1`; both off by default). */
  feel: PaceFeel;
  /** Engine step at which this attempt's round-over notice first showed (the card, or the tallying banner that comes first when docked), or null. */
  resultShownAt: number | null;
  /**
   * The result card's placement (layout.ts: docked aside or centred) and wall times (performance.now, ms): when the round's
   * end settled (levelEnd) and when the card itself showed; null until then. Docked, the card waits Layout.cardDelay after the end.
   */
  card: { place: 'dock' | 'center'; endedMs: number | null; shownMs: number | null };
  /** The docked phone HUD's band the level's opening view kept clear of (screen shares, PT3b), or null when the HUD is not docked. */
  openingHud: ScreenInsets | null;
  /**
   * Wall time of this level's load (engine build and pre-settle), and of each live step since, in ms;
   * moving: each live step's structure bodies in motion (Reductions.nMoving, what settle v2 counts);
   * frameMs: the time between drawn frames while a shot runs (frame pacing; with keystone.frames=all,
   * every display frame); costMs: each step's cost as the valve reads it (a GPU step's own time on the
   * GPU, physics-loop.ts), in order of landing.
   */
  timing: { loadMs: number; load: LoadPhases; stepMs: number[]; moving: number[]; frameMs: number[]; costMs: number[] };
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
  /**
   * Bullet Time (key T): freeze a running shot (on true, or toggle when absent), on a level with a
   * freeze budget (LevelDef.freeze, keystone.freeze) and a freeze left; or resume it, which costs
   * nothing. A shot fired while frozen goes in as rapid fire at the frozen step and spends a freeze.
   * False when nothing changed.
   */
  freeze(on?: boolean): boolean;
  /**
   * Skip the rest of the running shot's settle (key K, the HUD's Skip button; agent playtest PT6): its
   * steps run up to SKIP_SCALE times real time until it settles. Pacing only: the same steps run, so the
   * outcome and a replay are as if it had been watched. False when no shot is running (or it is frozen).
   */
  skip(): boolean;
  /** Fire the level's pre-aimed opening shot (KeystoneEnv.opener; key F, the HUD's Fire button): false when there is none now. */
  fireOpener(): boolean;
  /** Mute or unmute every sound (as key M toggles). */
  setMuted(muted: boolean): void;
  /** The most device pixels per CSS pixel the canvas draws (2 by default; 1 is the front door's Fast sharpness; the quality tier caps it too, low at 0.5). */
  maxDpr: number;
  /** The quality tier in effect, why, and what the probe on load measured (quality.ts; null until the page has decided). */
  quality: QualityState | null;
  /** Aim at normalized device coords with the selected ammo, as hovering there would. */
  aim(ndcX: number, ndcY: number): Aimed | null;
  /** The aim preview's blast-reach zone (a one-blast weapon aimed: where it would go off and how far it reaches), or null. */
  reach: { centre: [number, number, number]; radius: number } | null;
  /**
   * Where the previewed shot first touches (aim.ts arcContact; PT14): the body (-1 the ground), the point and the face's normal,
   * and whether it is the pre-aimed opener's preview (shown before the player aims). Null with no preview. The marker is drawn
   * there unless the blast zone shows or keystone.impact is off.
   */
  impact: { body: number; point: [number, number, number]; normal: [number, number, number]; opener: boolean } | null;
  select(ammo: RackItem): boolean;
  /**
   * Aftershock's quake designer (quake-panel.ts): the dial now (null on a level without a quake), a dial field
   * moved one step (keys Q/E, A/D, Z/X, C/V while the Quake chip is selected), and Start (Enter): the dial's quake
   * fired, refused as a click is (false).
   */
  dial(): QuakeDial | null;
  dialStep(field: DialField, dir: -1 | 1): QuakeDial | null;
  startQuake(): boolean;
  load(id: string): Promise<void>;
  /** Restart the attempt (key R, the result card's Retry): the level as it loaded, exactly (the same state hash). */
  retry(): Promise<void>;
  /**
   * Undo the last shot (key U or Ctrl/Cmd+Z, the result card's Undo; docs/game/undo.md): the world goes
   * back to the moment that shot went in. Instantly, from the checkpoint taken as it went in
   * (Driver.checkpoint), while undo memory (PaceFeel.undoMB) still holds one; else the level is rebuilt
   * and the attempt's shots but the last replayed on it, out of sight, to their settle. A shot fired
   * from aiming went in at the last settle, so both give that state exactly; a rapid-fire shot that cut
   * the one before went in mid-flight, so its checkpoint puts the world back mid-flight with that one
   * running on (the replay plays it out to its settle, the same state the restored run settles at).
   * Works while a shot runs and after the round ended. Resolves false when there is no shot to undo.
   */
  undo(): Promise<boolean>;
  /** How the last undo went back (a checkpoint restored, or the shots replayed) and its wall time, ms; null before one. */
  undone: { mode: 'checkpoint' | 'replay'; ms: number } | null;
  /** The level being built ahead for Next (keystone.prefetch), and whether its pre-settle is done; null when none is. */
  spare: { level: string; settled: boolean } | null;
  /** The undo checkpoints held now: one per shot still kept (null where none was), and their bytes (PaceFeel.undoMB caps them). */
  undoMemory(): { marks: number; bytes: number };
  capture(keepPixels?: boolean): Promise<PixelStats | null>;
  /** Tests: pixels of the current view (the ID pass, Renderer.renderIds) that show body `body`. */
  coverage(body: number): Promise<number>;
  /** Tests: where body `body` shows in the current view (the ID pass): its pixels' indices, row-major, in a frame of this size. */
  pixelsOf(body: number): Promise<{ width: number; height: number; at: number[] }>;
  /** Tests: the last pull's slide as last drawn (pull-anim.ts): steps since the pull, the drawn centre and scale; null when none is drawn. */
  pullDrawn: { body: number; k: number; pos: [number, number, number]; scale: number } | null;
  /** Bullet Time's frozen look as last drawn (frozen-look.ts): the grade's amount, 0 none to 1 full, eased per frame. */
  frozenGrade: number;
  /**
   * Tests (PT1's gate): the renderer's ID pass at the camera's view now (no shake), as pixels per structure body,
   * leaving out pixels under `covered` (screen shares: the HUD's panels as the page lays them out), with each
   * body's unoccluded outline area at the same size (sightlines.ts outlineAreas) to measure them against.
   */
  sightlines(covered?: ScreenRect[]): Promise<{ width: number; height: number; px: number[]; solo: number[] } | null>;
  /**
   * How each fired body (the slots past the structure's, in spawn order) is drawn now: a bomb (a lit fuse and
   * BOMB_FX's matte iron), a ram (scene.ts ramFx: bronze, banded, no fuse), a painted ball (paint and band,
   * scene.ts ballFx), or plain (the look's). Checked against the renderer: a bomb's slot must hold BOMB_FX or a
   * fuse, a ram's or painted ball's its paint and band.
   */
  firedLooks(): ('bomb' | 'ram' | 'painted' | 'plain')[];
  /** Per fired body (as firedLooks), whether it is drawn spent (PaceFeel.spent: faded once its shot settled). */
  spentLooks(): boolean[];
  /** The renderer's transient effects now (@tb/render Renderer.effectStats: live particles, hot bodies, lit flashes, blasts, fuses). */
  effects(): Promise<EffectStats>;
  /** The mark carved on each structure body now, read back from the renderer (@tb/render MARK_NONE, MARK_HIT, MARK_SAVE). */
  marks(): number[];
  /** Slot i's fx record as the renderer holds it now (@tb/render Fx: tint, emissive, flash, coat, mark): what a body is drawn with. */
  fx(i: number): Fx | null;
  /** Carve or clear the stones again as feel.marks now says (the front door's Stone marks setting changed). */
  refreshMarks(): void;
  /** Physics state now: step, phase and a hash of every pose. */
  state(): SessionState;
  /**
   * The structure bodies asleep in the last snapshot (awake 0; on the GPU only with per-body sleep, the
   * level's physics.sleep or `?keystone.sleep=1`, and Rapier's own sleep), of how many structure bodies.
   */
  asleep(): { asleep: number; of: number };
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
  /** The renderer's ice slots (@tb/render IcePass.count) and the crack level drawn on each slot asked for: what the page paints as ice. */
  ice(slots?: number[]): { count: number; cracks: number[] };
  /** The level's lot sheet as shown (KeystoneEnv.lotSheet): each goal met as of the last settle, final once the round is over. */
  goals: GoalLine[];
  /** The grade the round reached on the level's cast cloud as of the last settle, or null (below E, or no grades). */
  grade: Grade | null;
  /** A duel's state (KeystoneEnv.duel) as of the last settle, or null outside one. */
  duel: DuelState | null;
  /** A duel's hand-over card is showing (PaceFeel.handoff): the next player has not tapped it yet. */
  handoff: boolean;
  /** The text of the last Heraldry score float (duel-hud.ts scoreFloatHtml), or '' before one. */
  scoreFloat: string;
  /**
   * Mason's Trial (keystone mason-trial.ts): the test running in world 0 as drawn, the judge's worlds beside it,
   * or null when no trial has started since the level loaded. `hero` is world 0's verdict once it is judged.
   */
  trial: { state: 'running' | 'judging' | 'done' | 'error'; hero: boolean | null; passes: number | null; of: number; error: string } | null;
  /** The build phase (levels with a build block): see GameEditHandle. */
  edit: GameEditHandle;
}
/**
 * Where a level load's wall time went, ms (GameHandle.timing.load): checking the round being left
 * (check), compiling the level and building its engine and driver (compile), the engine's init (init:
 * a GPU engine's pipelines and buffers), the pre-settle's `steps` and the snapshot that waits for them
 * (presettle), an undo's replay of the kept shots (replay), and swapping the new level in (swap).
 * A prefetched level's compile, init and presettle are when it was built ahead, not part of the load.
 */
export interface LoadPhases {
  check: number; compile: number; init: number; presettle: number; steps: number; replay: number; swap: number;
  /** The level was built ahead (the result card's prefetch), and `wait` ms were spent waiting for it to finish settling. */
  prefetched: boolean; wait: number;
  /** A retry restored the level's start checkpoint in place: nothing was built or pre-settled. */
  restored: boolean;
}
const noPhases = (): LoadPhases => ({ check: 0, compile: 0, init: 0, presettle: 0, steps: 0, replay: 0, swap: 0, prefetched: false, wait: 0, restored: false });
/**
 * A load's pre-settle in batches of about a 120 Hz frame (keystone PresettlePace), so the frames of
 * the level on screen (or the front door over it) keep drawing while the next one settles, instead of
 * queueing behind all its steps. The state it leaves is the same as an unpaced reset's (a replay's).
 */
export const PRESETTLE_PACE = { batchMs: 8 } as const;
/** When the level Next opens is built ahead (KeystoneEnv.prefetch). */
export type PrefetchMode = 'aim' | 'card' | 'off';
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
/** The impact marker's least radius, h (a marble's marker would be a speck). */
export const IMPACT_MIN_RADIUS = 0.4;
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
    status: 'loading', engine: '', level: '', phase: 'loading', ready: false, frozen: false, frames: 0, stepIndex: 0, strokes: 0, bodies: 0, collapse: 0, fast: false, hold: false, pace: { timeScale: 1, speed: 1, tag: '', tailSkip: false, costMs: NaN }, view: { target: [0, 0, 0], distance: 0, yaw: 0, pitch: 0, following: false, jolt: 0, turning: false, cue: null, arcBeads: 0, impact: false, xray: false }, input: { touch: false, gesture: 'idle', fingers: 0, aimed: null, power: 100, launch: 0 }, result: null, counts: {}, feel: { ...DEFAULT_FEEL }, resultShownAt: null, card: { place: 'center', endedMs: null, shownMs: null }, openingHud: null, timing: { loadMs: 0, load: noPhases(), stepMs: [], moving: [], frameMs: [], costMs: [] }, draws: { drawn: 0, skipped: 0, decimating: false },
    fire: () => false, bank: () => false, skip: () => false, freeze: () => false, fireOpener: () => false, setMuted: () => {}, maxDpr: 2, quality: null, aim: () => null, reach: null, impact: null, select: () => false, dial: () => null, dialStep: () => null, startQuake: () => false, load: async () => {}, retry: async () => {}, undo: async () => false, undone: null, spare: null, undoMemory: () => ({ marks: 0, bytes: 0 }), capture: async () => null, sightlines: async () => null, coverage: async () => 0, pixelsOf: async () => ({ width: 0, height: 0, at: [] }), pullDrawn: null, frozenGrade: 0, firedLooks: () => [], spentLooks: () => [], effects: async () => ({ particles: 0, hot: 0, spawned: 0, flashes: 0, blasts: 0, fuses: 0 }), marks: () => [], fx: () => null, refreshMarks: () => {},
    state: none, asleep: () => ({ asleep: 0, of: 0 }), line: () => [], replay: async () => none(), health: async () => null, pairsPerBody: 0, limitsHit: [], goals: [], grade: null, duel: null, handoff: false, trial: null, scoreFloat: '',
    sound: () => ({ mode: 'collapse', status: 'off', error: '', posted: 0, stats: null }),
    ice: () => ({ count: 0, cracks: [] }),
    edit: { on: false, enter: () => false, play: () => {}, cancel: () => {}, key: () => false, ray: () => {}, status: () => '', def: () => null, ghosts: () => 0, played: null },
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
  /** A level was built, pre-settled and shown (also on retry, and on undo: then d.session already holds the shots kept). */
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
  /** Tests: the renderer draws offscreen (offscreenSize, 640x400 when absent), and only for a capture. */
  offscreen: boolean;
  offscreenSize?: [number, number];
  device: GPUDevice;
  renderer: Renderer;
  source: SnapshotSource;
  /** The game's HUD, banner and result card: kg-hud, kg-banner and kg-result elements (ui.ts; gameOverlays makes the last two). */
  hud: HTMLElement;
  banner: HTMLElement;
  result: HTMLElement;
  /**
   * Level starts (docs/game/level-start.md): the pre-settle's batch time in ms (keystone PresettlePace;
   * default PRESETTLE_PACE's, 0 runs it in one go as before), and when the level Next opens is built
   * ahead: from when this one loads, while the player aims ('aim', the default; held while a shot runs),
   * from when the result card shows ('card'), or not at all ('off'). Unpaced, 'aim' is 'card': an unpaced
   * pre-settle holds the frames. Offscreen (tests) the default is 'card'. URL keys keystone.loadpace and keystone.prefetch (params.ts loadOptions).
   */
  loadPaceMs?: number;
  prefetch?: PrefetchMode;
  /** How Retry restarts the level: from its start checkpoint, in place (default), or by building it again (keystone.retry). */
  retry?: 'checkpoint' | 'rebuild';
  /** Every level the page can load (handle.load), N, P and the result card's Next walking through them, and the one to start on. */
  levels: readonly LevelDef[];
  start: number;
  /**
   * Each level's series (index-aligned with `levels`): N, P and Next stay inside the loaded level's series,
   * so the last chamber level does not run on into the trials. Absent: one series.
   */
  series?: readonly number[];
  engine: EngineKind;
  feel: PaceFeel;
  /**
   * The device tier the rack's weapons must fit (keystone armRefusal: one over it is refused on fire,
   * with a banner saying which number and which tier fires it); absent: high. Asked at each fire.
   */
  weaponTier?(): WeaponTier;
  /** Shows an error; play stops (handle.status is 'error'). */
  fail(e: unknown): void;
  hooks?: KeystoneHooks;
  /**
   * Input decided from the observed state (the weapons runtime): a fresh hook per level load and
   * per replay, called after every step as runSession calls PlayOptions.perStep, so a replay
   * sees the same input.
   */
  perStep?(c: CompiledLevel): PerStep | null;
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
   * Where the HUD and the result card sit (layout.ts; read live, so the Layout setting applies from the next card).
   * Absent: classic, the card centred at once (the viewer).
   */
  layout?: Layout;
  /**
   * The result card's forward button at the end of a series (hud.ts CardForward): the next series' first level
   * (its index in `levels`) with a label, or null; absent or null, Levels (onLevels) when given.
   */
  seriesForward?(i: number): { index: number; label: string } | null;
  /** The result card's Levels button at the last level of a series with nothing after it: the page opens its level list (the front door). */
  onLevels?(): void;
  /**
   * The level's lot sheet (docs/game/lot-sheets.md), asked at each load and retry: the sheet, the goals to
   * show (proven ones unless ?keystone.goals=all) and the ids the player met on earlier plays; null for none.
   */
  lotSheet?(c: CompiledLevel): { sheet: LotSheet; goals: readonly Goal[]; before: readonly string[]; open?: boolean } | null;
  /**
   * A Siege Table duel (docs/game/siege-table.md): `levels` are then duelLevel(duel, 0) and duelLevel(duel, 1)
   * (who goes first), the duel referees every shot and settle, owned blocks wear their side's ink, and the
   * result card offers a rematch with the other side first.
   */
  duel?: DuelDef;
  /** Touch controls' face (?touch=auto|1|0, touch.ts): auto by default. The gestures work whatever it says. */
  touch?: TouchMode;
  /**
   * The build phase on levels with a build block (C9, docs/game/placement.md): on by default; false
   * (?keystone.build=0) plays them as authored, with no Build panel.
   */
  build?: boolean;
}

/** An orbiting drag of (dx, dy) pixels: turns, and tilts from looking down to looking up (past level the floor brings the eye in). */
export function orbitDrag(o: Orbit, dx: number, dy: number): void {
  o.yaw -= dx * 0.005;
  o.pitch = clampPitch(o.pitch + dy * 0.005);
}

/** The camera's nearest and farthest distance (m), for the wheel and a pinch alike. */
export const ZOOM_RANGE = [3, 200] as const;

/** Zoom by a factor of the distance (the wheel's exp(deltaY / 1000), a pinch's spread ratio), within ZOOM_RANGE. */
export function zoomBy(o: Orbit, ratio: number): void {
  o.distance = Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], o.distance * ratio));
}

/** Typing into a form field (the viewer's panels) is not a game key. */
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

/**
 * Loads env.levels[env.start] and plays it until the page closes, filling in
 * `handle`. Resolves once the first level is running; errors go to env.fail.
 */
export async function playKeystone(env: KeystoneEnv, handle: GameHandle = newGameHandle()): Promise<GameHandle> {
  const { canvas, offscreen, device, renderer, source, engine: kind, feel, fail } = env;
  // The levels as the player has them: a build-phase level is replaced by the level as built when it is played
  // (Play), so Retry, Undo and coming back to it later start from what was built.
  const levels: LevelDef[] = [...env.levels];
  /** Whether level i + d exists and is in level i's series (N, P and Next walk only inside it). */
  const step = (i: number, d: 1 | -1) => i + d >= 0 && i + d < levels.length && (env.series?.[i + d] ?? 0) === (env.series?.[i] ?? 0);
  const hooks = env.hooks ?? {};
  const levelIndex = (id: string) => {
    const i = levels.findIndex((l) => l.id.toUpperCase() === id.toUpperCase());
    if (i < 0) throw new Error(`unknown level ${id}; known: ${levels.map((l) => l.id).join(', ')}`);
    return i;
  };
  let levelIdx = env.start;
  const paceMs = env.loadPaceMs ?? PRESETTLE_PACE.batchMs, retryMode = env.retry ?? 'checkpoint';
  const resetOptions = { now: () => performance.now(), ...(paceMs > 0 ? { pace: { batchMs: paceMs } } : {}) };
  // Offscreen pages (tests, probes) build ahead from the card unless asked: on SwiftShader every page
  // building a second level as it opens would be minutes of CPU across the suite.
  const prefetchMode: PrefetchMode = env.prefetch === 'off' ? 'off' : paceMs > 0 ? env.prefetch ?? (offscreen ? 'card' : 'aim') : 'card';
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
  const pacer = new Pacer(), juice = new CameraJuice(), speed = new SpeedMeter(), tail = new TailSkip(), follow = new FollowCam(), swing = new TurnSwing();
  /** What the last drawn frame added to the view (handle.view.jolt). */
  let jolt = 0;
  let arrivals = newArrivals();
  let synth: Synth | null = null;
  let muted = env.muted ?? false;
  const soundMode = env.sound ?? 'collapse';
  const collapse = soundMode !== 'synth' ? new CollapseSound(env.impactsDb ?? 0, soundSetOf(soundMode)) : null;
  handle.ice = (slots = []) => ({ count: renderer.ice.count, cracks: slots.map((i) => (renderer.surfaceOf(i).kind === 'ice' ? renderer.surfaceOf(i).crack : -1)) });
  handle.sound = () => ({ mode: soundMode, status: collapse?.status ?? 'off', error: collapse?.error ?? '', posted: collapse?.posted ?? 0, stats: collapse?.stats ?? null });
  const voices: Voice[] = [];

  let c!: CompiledLevel, driver!: Driver, orbit!: Orbit;
  const viewSun = new ViewSun();
  let perStep: PerStep | null = null;
  // Body descriptions in slot order: the driver's (the structure, then every spawn: ammo as fired,
  // a weapon's children, the input hook's, in the order the engine applies them).
  let descs: readonly BodyDesc[] = [];
  /**
   * Fired bodies' looks by slot (the slots past the structure's): a bomb's (BOMB_FX and a fuse), a ram's
   * (scene.ts ramFx), a painted ball's (ballFx) or a plain one's (fx null: as the look draws it), and whether it
   * is spent (faded once its shot settled, PaceFeel.spent); null for an ice piece (the ice pass draws it). Kept
   * so an undo can draw the kept shots' bodies as they were: a checkpoint's (UndoMark.looks) or, when the undo
   * replays, the slots the replay refills (the same shots in the same order spawn into the same slots); a fresh
   * attempt clears it. Entries are replaced, never changed in place (a checkpoint holds the array's old entries).
   */
  interface FiredLook { fx: FxOptions | null; fuse: boolean; kind: 'bomb' | 'ram' | 'painted' | 'plain'; spent: boolean }
  let firedLooks: (FiredLook | null)[] = [];
  /** Spent ammo fading now: slot, its live look, and when the fade began (ms). */
  let fading: { slot: number; look: FiredLook; t0: number }[] = [];
  const paintFired = (i: number, look: FiredLook | null) => {
    if (!look) return;
    if (look.spent) renderer.setFx(i, spentFx(look.fx, 1));
    else if (look.fx) renderer.setFx(i, look.fx);
    if (look.fuse && !look.spent) renderer.fuse(i);
  };
  /**
   * Fade every painted ball and ram not yet spent (a shot settled; PaceFeel.spent). Bombs are left as they are
   * (a live one still goes off), and so are plain balls (the plain style draws the look's own ball, whose colour
   * the game does not hold, so it has nothing to fade from).
   */
  const spendFired = () => {
    if (!feel.spent) return;
    const t0 = performance.now();
    for (let i = c.meta.n; i < descs.length; i++) {
      const L = firedLooks[i - c.meta.n];
      if (!L || L.spent || !L.fx || L.kind === 'bomb') continue;
      firedLooks[i - c.meta.n] = { ...L, spent: true };
      renderer.setFx(i, spentFx(L.fx, 0));
      fading.push({ slot: i, look: L, t0 });
    }
  };
  /** One frame of the spent fades (frame time now, ms). */
  const fadeSpent = (now: number) => {
    if (!fading.length) return;
    for (const f of fading) renderer.setFx(f.slot, spentFx(f.look.fx, (now - f.t0) / 1000 / SPENT_FADE));
    fading = fading.filter((f) => now - f.t0 < 1000 * SPENT_FADE);
  };
  /**
   * Take up new bodies; item: the rack item fired ('bomb' for bodies the step loop adds). A weapon's
   * are drawn as bombs (dark iron with a lit fuse, scene.ts BOMB_FX); a ball in its paint (ballFx, under
   * PaceFeel.balls). fire() passes its shot's item; the step loop passes 'bomb', because after the shots
   * due are fired the only bodies a step adds are a weapon's split children (the arsenal's spawns;
   * children carry tag 0, not TAG_BALL). Marked by spawn, not by the last shot, so rapid fire (a marble
   * after a cluster) cannot unmark bomblets that split later.
   */
  const spawned = (item: RackItem | 'bomb') => {
    if (driver.bodies.length === descs.length) return;
    const from = descs.length;
    descs = driver.bodies;
    fxSlots = descs.length;
    // A weapon that goes off is a bomb; one that never does is a ram (scene.ts firedKind; drawn as a bomb in the plain style, as before PT19).
    let kind = item === 'bomb' ? 'bomb' : firedKind(c.def, item);
    if (kind === 'ram' && feel.balls === 'plain') kind = 'bomb';
    const bomb = kind === 'bomb';
    const fx = bomb ? BOMB_FX : kind === 'ram' ? ramFx(feel.balls) : ballFx(item as RackItem, feel.balls);
    for (let i = from; i < descs.length; i++) {
      // A shattered ice block's pieces are drawn as ice (the 'shatter' feedback paints them), never as bombs.
      if (isIcePiece(descs[i]!)) { firedLooks[i - c.meta.n] = null; continue; }
      const look: FiredLook = { fx, fuse: bomb, kind: bomb ? 'bomb' : kind === 'ram' ? 'ram' : fx ? 'painted' : 'plain', spent: false };
      firedLooks[i - c.meta.n] = look;
      paintFired(i, look);
      if (bomb) handle.counts.bomb = (handle.counts.bomb ?? 0) + 1;
    }
  };
  let fxSlots = 0;
  /** Every ice body drawn as ice with its crack as the driver has it (a load, an undo); from then on the feedback keeps it. */
  const paintIce = () => {
    renderer.clearSurfaces();
    for (const s of driver.iceSurfaces) renderer.setSurface(s.body, { kind: 'ice', crack: s.level, at: s.at, seed: s.seed });
  };
  /** What the follow camera frames at most: the lot and a margin, up to half again the structure's height. */
  let followClip = new Float64Array(6);
  /** A physics step is in flight (physics-loop.ts): the session may already read aiming, but the step is not done. */
  let stepping = false;
  /** Shots waiting to go in between steps (fire): clicks during a step, and a line's rapid-fire shots (Shot.after) until their step. */
  let waiting: Shot[] = [];
  /** Bullet Time: the running shot's physics is frozen (freeze, key T); the physics loop holds until a shot or T resumes it. */
  let frozen = false;
  /** Bullet Time's frozen look (frozen-look.ts; PaceFeel.frozenLook): the grade's amount now, eased, and the label. */
  let frozenGrade = 0;
  const frozenLabel = document.createElement('div');
  frozenLabel.className = 'kg-frozen';
  frozenLabel.innerHTML = FROZEN_LABEL;
  (env.banner.parentElement ?? document.body).appendChild(frozenLabel);
  /** The last pull, drawn (pull-anim.ts; PaceFeel.pullAnim): its slide-out and ghost outline. Null on a load or undo. */
  let pullAnim: PullAnim | null = null;
  /** The engine step its pull went in at: the slide is drawn by steps since (pullPose). */
  let pullStep = 0;
  let regrowBuf = new Float32Array(0);
  let selected: RackItem | null = null;
  let opener: Shot | null = null;
  let power = 100;
  // The quake designer's dial (levels with a quake in the rack), kept over Retry and Undo so the player can iterate,
  // and its seismogram, recomputed only when the dial moves.
  let dial: QuakeDial | null = null, traceFor = '', trace: number[] = [];
  /**
   * The launcher height (1/4 h) and what it was set for: the level's hash and the launch mode. A new level
   * or mode starts again at launchHeight; a retry or an undo keeps the player's height (keys W and S).
   */
  let launchAt = 0, launchFor = '';
  let aimed: Aimed | null = null, beads: Float64Array | null = null, aimDirty = false;
  /** The point aimed at and the structure body under it (-1: the ground), for a duel's own-keep warning and its score float. */
  let aimHit: { body: number; point: Vec3 } | null = null, firedAt: Vec3 | null = null;
  /** The block a click or tap tried to pull and was refused (a crown, heritage): its hint shows red until the aim leaves it. */
  let refusedPull: number | null = null;
  /** The block a selected pull would take, lit (PULL_HOVER) until the cursor leaves it or it is pulled. */
  let hover: number | null = null;
  /** A one-blast weapon's blast radius around the aim point, for the aim preview's danger zone (Renderer.reach); null otherwise. */
  let ring: { centre: Vec3; radius: number } | null = null;
  /** Where the previewed shot first touches (the impact marker), and whether the preview is the opener's. */
  let contact: Contact | null = null, previewingOpener = false;
  let pointer: [number, number] | null = null;
  /**
   * The last spot aimed at on the canvas (NDC), kept when the pointer goes (the cursor off to the HUD, a finger lifted):
   * while frozen (Bullet Time, PT33) the aim holds there, or on a standing crown, so the frozen frame keeps its preview.
   */
  let heldAim: [number, number] | null = null;
  let regrowT: number | null = null;
  let fastHeld = false;
  /** Skip (key K, the HUD's Skip button; agent playtest PT6): the running shot's settle runs at SKIP_SCALE until it ends. */
  let skipping = false;
  let lastHud = '', crownsShown = 0;
  /** The level's lot sheet and its groups (selected once per load), or null. */
  let lot: { sheet: LotSheet; goals: readonly Goal[]; groups: Record<string, Int32Array>; footprints: Record<string, Footprint> } | null = null;
  /** The duel being played (env.duel), and when the turn in the air was fired (its pace: DuelDef.turnSeconds). */
  let duel: Duel | null = null, turnStart = 0;
  // Fuse & Fold's timeline panel (fuse-panel.ts), beside the HUD: shown on levels with plunger charges.
  const fuse = env.hud.parentElement ? new FusePanel(env.hud.parentElement, { fire: (shot) => handle.fire(shot) }) : null;
  /** The lot's chalk line on a fold level (fuse-timeline.ts lotBeads), else null. */
  let foldLot: Overlay | null = null;
  /** Rube Lab (rube-view.ts, PT26): a region bell's zone outline, and the ball's start marker (drawn until the release goes). */
  let bellZone: Overlay | null = null, ballStart: Overlay | null = null;
  /** A fold level's plan on the ground while the plunger can go (fuse-timeline.ts planBeads, PT24): the yard arrow and the compass. */
  let foldPlan: Overlay | null = null;
  /** Each side's arc on the ground (duel-view.ts arcBeads), made at load. */
  let arcs: Overlay[] = [], arcBeadsDrawn = 0, impactDrawn = false;
  let xrayMemo: { c: CompiledLevel; mode: PaceFeel['xray']; on: boolean } | null = null;
  /** Every crown is down: the round is known to be over, the card shows, and the rest of the settle runs at fast-forward. */
  let ending = false;
  // The docked layout's tallying banner (layout.ts, PT4): a small panel at the top, shown from the round's end
  // until the card, which waits for it (cardTimer). Beside the result card, in the same parent.
  const tally = document.createElement('div');
  tally.className = 'kg-panel kg-tally';
  tally.setAttribute('role', 'status');
  (env.result.parentElement ?? document.body).append(tally);
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  /** The HUD's lot sheet is listed (true) or only its count line; for the level of hash sheetFor; the round's objective was met (it opened then). */
  let sheetOpen = true, sheetFor = '', sheetCleared = false;

  // The build phase (C9, docs/game/placement.md): on a level with a build block, before its first shot, time stops and
  // the player places pieces and lays domino runs on the level as authored (EditController), drawn in place of the
  // engine's state (EditView). Play compiles the level as built and loads it in this level's place (levels[levelIdx]),
  // keeping the camera; Cancel restores the level as it loaded. A fresh load of such a level opens in it.
  let editing: EditController | null = null, buildAfterLoad = false, touchStroke = false;
  const editView = new EditView(renderer, source);
  const buildEl = document.createElement('details');
  buildEl.className = 'kg-panel kg-build';
  buildEl.hidden = true;
  (env.hud.parentElement ?? document.body).append(buildEl);
  const buildPanel = mountEditPanel(buildEl, (x) => editAct(x));
  /** The level loaded offers a build phase (and the page allows one). */
  const buildOffered = () => env.build !== false && !!c?.def.build && !env.duel;
  /** The build phase can start now: offered, and aiming before the attempt's first shot. */
  const canEdit = () => buildOffered() && !loading && !stepping && !ending && handle.result === null && handle.trial === null && driver.session.phase === 'aiming' && driver.session.inputs.length === 0;
  /** The Build panel: shown while building, or while the build phase can start; redrawn only when its HTML changes. */
  function showPanel() {
    buildEl.hidden = !(editing || canEdit());
    buildPanel.show(editing);
  }
  function showEdit() {
    if (editing) editView.show(editing, feel.marks, coatsOn());
    showPanel();
    syncState();
  }
  function enterEdit(): boolean {
    if (editing || !canEdit()) return false;
    editing = new EditController(levels[levelIdx]!, {});
    // No aim, arc, reach or hover while building; the grow-in stops (the world is drawn at its authored poses).
    pointer = null;
    aimed = beads = null;
    ring = handle.reach = null;
    setHover(null);
    regrowT = null;
    touchStroke = false;
    buildEl.open = true;
    document.body.classList.add('kg-building');
    showEdit();
    return true;
  }
  /** Ends the build phase without loading anything (a load follows, or is under way). */
  function leaveEdit() {
    editing = null;
    touchStroke = false;
    editView.forget();
    document.body.classList.remove('kg-building');
    showPanel();
  }
  function playEdit() {
    if (!editing) return;
    const def = editing.play();
    handle.edit.played = compileLevel(def).hash;
    if (JSON.stringify(def) !== JSON.stringify(levels[levelIdx])) levels[levelIdx] = def;
    leaveEdit();
    // Mason's Trial: Play is build, then test.
    trialAfterLoad = !!def.mason;
    void load(levelIdx, true).catch(fail);
  }
  function cancelEdit() {
    if (!editing) return;
    leaveEdit();
    // The level as it loaded: its start checkpoint, restored in place.
    void load(levelIdx, true).catch(fail);
  }
  function editAct(x: EditAction) {
    if (x.a === 'enter') { if (!enterEdit()) banner('Build before the first shot: Retry to build again', 'crack'); }
    else if (x.a === 'play') playEdit();
    else if (x.a === 'cancel') cancelEdit();
    else if (editing && applyEditAction(editing, x)) showEdit();
    else if (editing) showEdit(); // a refusal's reason, on the status line
  }
  const editRay = (kind: 'move' | 'down' | 'up', origin: Vec3, dir: Vec3, alt = false) => {
    if (!editing) return;
    const r = { origin, dir };
    if (kind === 'move') editing.move(r, { alt });
    else if (kind === 'down') editing.down(r);
    else editing.up(r, { alt });
    showEdit();
  };
  handle.edit = {
    get on() { return editing !== null; },
    enter: enterEdit,
    play: playEdit,
    cancel: cancelEdit,
    key(k, shift = false) {
      if (!editing) return false;
      const did = editing.key(k, { shift });
      if (did) showEdit();
      return did;
    },
    ray: editRay,
    status: () => editing?.status() ?? '',
    def: () => editing?.play() ?? null,
    ghosts: () => (editing ? editing.bodies().ghost.length : 0),
    played: null,
  };

  // Mason's Trial (keystone mason-trial.ts, docs/game/masons-trial.md): a Mason level has no rack. Its Test (the HUD's
  // opener slot, key F; right after Play from the build phase) runs the level's test in world 0 on the loaded driver,
  // stepped and drawn as a shot is, while the judge plays every world as islands on an engine of its own (paced a
  // frame at a time); the card shows the judge's count. A load (Retry, Next, the build phase's Play or Cancel) stops it.
  /** trialAfterLoad: the load under way is the build phase's Play; trialPending: it is in, and the test starts once it can (after the level grows back). */
  let trial: MasonTrial | null = null, trialAfterLoad = false, trialPending = false;
  /** A Test can start now: a Mason level, loaded, aiming, nothing built or tested on it since it loaded. */
  const trialReady = () => !!c?.def.mason && !trial && !loading && !editing && !stepping && handle.result === null && driver.session.phase === 'aiming' && regrowT === null;
  /** World 0's test is still to step. */
  const trialStepping = () => trial !== null && handle.trial?.state === 'running' && !trial.heroDone;
  function startTrial(): boolean {
    if (!trialReady()) return false;
    const lv = c, K = masonWorlds(lv.def.mason!);
    let t: MasonTrial;
    try {
      t = new MasonTrial(lv, driver, { judge: makeMasonEngine(kind, lv, K, device), pace: () => new Promise<void>((r) => requestAnimationFrame(() => r())) });
    } catch (e) {
      banner(`The test cannot start: ${(e as Error).message}`, 'crack');
      return false;
    }
    trial = t;
    handle.trial = { state: 'running', hero: null, passes: null, of: K, error: '' };
    // The probes are bodies now: drawn plain (the level's own material), from their spawn on.
    const from = descs.length;
    descs = driver.bodies;
    fxSlots = descs.length;
    for (let i = from; i < descs.length; i++) firedLooks[i - c.meta.n] = null;
    void t.judged.then(() => { if (trial === t) finishTrial(); });
    physicsIdle.kick();
    sync();
    return true;
  }
  /** After a step of world 0's test: world 0 judged, then the card once the judge is in too. */
  function stepTrial() {
    const t = trial;
    if (!t || !handle.trial) return;
    t.observe();
    if (t.heroDone && handle.trial.state === 'running') {
      handle.trial.state = 'judging';
      pacer.release();
      finishTrial();
    }
  }
  function finishTrial() {
    const t = trial, st = handle.trial;
    if (!t || !st || st.state === 'done' || st.state === 'error') return;
    if (t.error) {
      st.state = 'error';
      st.error = t.error instanceof Error ? t.error.message : String(t.error);
      banner(`The judge could not run: ${st.error}`, 'crack');
      sync();
      return;
    }
    const r = t.result();
    if (!r) { sync(); return; }
    st.state = 'done';
    st.hero = r.hero.pass;
    st.passes = r.verdict.passes;
    handle.result = r.score;
    showResult(r.score);
    hooks.ended?.(c, r.score, driver);
    prefetchNext();
    sync();
  }
  function stopTrial() {
    trial?.stop();
    trial = null;
    handle.trial = null;
  }

  const [offW, offH] = env.offscreenSize ?? [640, 400];
  const aspect = () => (offscreen ? offW / offH : canvas.width / Math.max(1, canvas.height));
  /** The aspect a view is framed for: a phone held upright frames the width too (the CSS box: the canvas may not be sized for it yet). */
  const viewAspect = () => (offscreen ? aspect() : canvas.clientWidth / Math.max(1, canvas.clientHeight));
  /** The player orbited, panned or zoomed: the follow camera lets go for this shot, the turn view's swing for this turn. */
  const grabCamera = () => { follow.grab(); swing.grab(); };
  /** The HUD's turn cue now: which way to drag to reach the side to fire, between shots in a duel (none while the turn view swings). */
  const cueNow = () => (duel && !duel.result.over && duel.shooter === null && !swing.active ? turnCue(duel.def.sides[duel.turn].arc, azFromYaw(orbit.yaw)) : null);
  const courses = () => Math.ceil(c.height / c.frame.unit);

  /** Loads queued or in flight: the frame loop stops stepping the outgoing level and keeps drawing it. */
  let loading = 0;
  function load(i: number, retry = false): Promise<void> {
    loading++;
    // A load ends the build phase (Play, Cancel, a level picked at the door), and a Mason test.
    if (editing) leaveEdit();
    stopTrial();
    trialPending = false;
    buildAfterLoad = false;
    const testAfter = trialAfterLoad;
    trialAfterLoad = false;
    // Not ready from now on (a load can take many frames), so nothing fires into the level being left.
    if (driver) syncState();
    return exclusive(() => { dropMarks(0); return loadNow(i, retry); }).finally(() => {
      loading--;
      if (buildAfterLoad && !loading) { buildAfterLoad = false; enterEdit(); }
      if (testAfter && !loading) trialPending = true;
    });
  }

  /**
   * Undo checkpoints, by shot (UndoMarks): the world just before each shot went in (Driver.checkpoint)
   * and what the page showed of it. Taken as each shot goes in (fireNow), the oldest dropped past
   * PaceFeel.undoMB; all dropped when a level loads (their engine goes).
   */
  interface UndoMark { cp: DriverCheckpoint; bytes: number; frozen: boolean; goals: GoalLine[]; grade: Grade | null; looks: typeof firedLooks; dispose(): void }
  const marks = new UndoMarks<UndoMark>();
  const dropMarks = (k: number) => marks.drop(k);

  /**
   * The world as shot k = session.inputs.length goes in, kept for undo: not in a duel (its turns are the
   * players'), nor with a page input hook (PerStep: its own state is a closure, which no copy can take),
   * nor on an engine without checkpoints, nor past the undo memory (the oldest go first).
   */
  function takeMark() {
    const budget = duel || perStep ? 0 : feel.undoMB * 2 ** 20;
    marks.take(driver.session.inputs.length, budget, () => {
      let cp: DriverCheckpoint | null = null;
      // A checkpoint that fails (a GPU error) only costs this shot its instant undo: undo replays instead.
      try { cp = driver.checkpoint(); } catch (e) { console.warn(`undo checkpoint: ${(e as Error).message}`); }
      return cp && { cp, bytes: cp.bytes, frozen, goals: handle.goals.map((g) => ({ ...g })), grade: handle.grade, looks: [...firedLooks], dispose: () => cp.dispose() };
    });
  }

  /** The star ticks on the HUD's Down bar, for the level loaded (meterTicks). */
  let ticks: MeterTick[] = [];

  /**
   * Undo: back to the moment the last shot went in, from its checkpoint, or else by rebuilding the level and
   * replaying this attempt's shots but the last (taken under the lock, so a shot clicked mid-step counts).
   */
  function undo(): Promise<boolean> {
    loading++;
    return exclusive(async () => {
      // Not in a duel: its turns are the two players'.
      if (!driver || duel || driver.session.inputs.length === 0) return false;
      const t0 = performance.now(), k = driver.session.inputs.length - 1, mark = marks.pop(k);
      if (mark) {
        restoreMark(mark);
        mark.dispose();
        handle.counts.undo = (handle.counts.undo ?? 0) + 1;
        handle.undone = { mode: 'checkpoint', ms: performance.now() - t0 };
        banner(k ? `Back to shot ${k}` : 'Back to the start');
        return true;
      }
      dropMarks(0);
      const keep = driver.session.inputs.slice(0, -1).map((x) => ({ ...x.shot }));
      env.banner.textContent = keep.length ? `Undo: replaying ${shotsText(keep.length)}…` : 'Undo';
      env.banner.classList.remove('show', 'crack');
      env.banner.classList.add('hold');
      try {
        await loadNow(levelIdx, true, keep);
      } finally {
        env.banner.classList.remove('hold');
      }
      handle.counts.undo = (handle.counts.undo ?? 0) + 1;
      handle.undone = { mode: 'replay', ms: performance.now() - t0 };
      banner(keep.length ? `Back to shot ${keep.length}` : 'Back to the start');
      return true;
    }).finally(() => { loading--; });
  }

  /**
   * Put the world back as `mark` holds it, in place: the engine and the driver (Driver.checkpoint), then
   * what the page shows, as a load after an undo would set it up (loadNow with a line), but with the page
   * state of that moment: Bullet Time's freeze, the goals as judged then, and the bombs still drawn as bombs.
   */
  /** Carve the structure's stones as feel.marks says (scene.ts structureMarks): after its tints at every load and restore, and when the setting changes. */
  function applyMarks() {
    // In a duel the player to fire's own king wears the shield, the rival's the crosshair (duel-view.ts duelMarks).
    renderer.setMarks(0, duel ? duelMarks(c, duel, feel.marks) : structureMarks(c, feel.marks));
    renderer.setCoats(0, duel ? duelCoats(c, feel.coats) : structureCoats(c, coatsOn()));
    // The x-ray's kinds are the marks' (1 a crown, 2 heritage) whether or not the stones are carved; Renderer.xray says whether it draws.
    renderer.setXray(0, structureMarks(c, true));
  }

  /**
   * A duel's hand-over card (PaceFeel.handoff; PT5): whose turn it is, over the turn view's swing, until a tap or a key.
   * A tap on it only dismisses it, so it never fires; a shot fired by other means (handle.fire, a line) dismisses it too.
   */
  let handoff: HTMLElement | null = null;
  function showHandoff() {
    if (!duel) return;
    handoff ??= Object.assign(document.createElement('div'), { className: 'duel-handoff' });
    if (!handoff.isConnected) {
      document.body.append(handoff);
      handoff.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      handoff.addEventListener('click', (e) => { e.stopPropagation(); hideHandoff(); });
    }
    handoff.innerHTML = handoffHtml(duel, handle.input.touch);
    handoff.classList.add('show');
    handle.handoff = true;
    aimDirty = true;
  }
  function hideHandoff() {
    handoff?.classList.remove('show');
    if (handle.handoff) aimDirty = true;
    handle.handoff = false;
  }

  /**
   * A Heraldry shot's points floated over where it landed (duel-hud.ts scoreFloatHtml; PT5): the aim point, else the
   * structure's middle. Not while the hand-over card shows them instead (it covers the middle of the screen), nor
   * once the duel is decided (the result card has the totals).
   */
  let float: HTMLElement | null = null;
  function floatScore() {
    const html = duel ? scoreFloatHtml(duel) : '';
    if (html) handle.scoreFloat = html.replace(/<[^>]+>/g, '');
    if (!html || feel.handoff || duel!.result.over) return;
    float ??= Object.assign(document.createElement('div'), { className: 'duel-float' });
    if (!float.isConnected) document.body.append(float);
    const at = firedAt ?? [0, c.height / 2, 0], m = viewProj(orbit, viewAspect()), r = canvas.getBoundingClientRect();
    const w = m[3]! * at[0] + m[7]! * at[1] + m[11]! * at[2] + m[15]!;
    const x = (m[0]! * at[0] + m[4]! * at[1] + m[8]! * at[2] + m[12]!) / w, y = (m[1]! * at[0] + m[5]! * at[1] + m[9]! * at[2] + m[13]!) / w;
    const inView = w > 0 && Math.abs(x) <= 0.95 && Math.abs(y) <= 0.95;
    float.style.left = `${r.left + (inView ? (x + 1) / 2 : 0.5) * r.width}px`;
    float.style.top = `${r.top + (inView ? (1 - y) / 2 : 0.4) * r.height}px`;
    float.innerHTML = html;
    float.classList.remove('show');
    void float.offsetWidth; // restart the animation
    float.classList.add('show');
  }
  /** Coats as feel.coats says, but never gilt or glaze in a duel, whose blocks wear their side's ink (painted, duelCoats). */
  const coatsOn = () => feel.coats && !duel;
  const inks = () => duel!.def.sides.map((s) => s.ink);
  /** The structure's tints at a load or restore: a duel's sides in their inks and its neutral blocks plain (scene.ts duelTints). */
  const baseTints = () => (duel ? duelTints(c, duel.owned, inks(), feel.coats) : structureTints(c, coatsOn()));
  /** Body b's own linear tint, for a felled crown's or cracked heritage's paint: in a duel its side's ink, never the other side's gold. */
  const ownTint = (b: number) => (duel ? duelTint(c, duel.owned, inks(), b, feel.coats) : roleTint(c, b, coatsOn()));

  function restoreMark(mark: UndoMark) {
    mark.cp.restore();
    reportedSteps = 0;
    descs = driver.bodies;
    collapse?.load(c);
    source.reset(c.scene.bodies);
    source.update(driver.snapshot, descs);
    if (fxSlots) renderer.clearFx(0, fxSlots);
    regrowBuf = regrowScales(c, Infinity, new Float32Array(c.meta.n));
    renderer.setFx(0, baseTints(), regrowBuf, false);
    applyMarks();
    paintIce();
    const s = driver.session, roles = rolePaint(feel.fx);
    s.crownLive.forEach((down, k) => { if (down) renderer.setFx(c.meta.crowns[k]!, { tint: ownTint(c.meta.crowns[k]!), ...roles.crownKept }); });
    s.heritageBroken.forEach((cracked, k) => { if (cracked) renderer.setFx(c.meta.heritage[k]!, { tint: ownTint(c.meta.heritage[k]!), ...roles.heritageKept }); });
    // No spark, heat, flash, blast or lit fuse of the undone shot carries over (PT2); the kept shots' fuses are lit again below.
    renderer.resetEffects();
    fading = [];
    firedLooks = [...mark.looks];
    for (let i = c.meta.n; i < descs.length; i++) paintFired(i, firedLooks[i - c.meta.n] ?? null);
    fxSlots = descs.length;
    pacer.reset();
    speed.reset();
    tail.reset();
    skipping = false;
    arrivals = newArrivals();
    juice.reset();
    follow.reset();
    handle.result = null;
    ending = false;
    hideResult();
    selected = nextSelection(c.def.rack, s.rackLeft, selected);
    regrowT = null;
    waiting = [];
    frozen = mark.frozen;
    pullAnim = null;
    handle.pullDrawn = null;
    aimed = null;
    beads = null;
    hover = null;
    aimDirty = true;
    crownsShown = s.crownLive.reduce((a, x) => a + x, 0);
    handle.goals = mark.goals.map((g) => ({ ...g }));
    handle.grade = mark.grade;
    // A shot running again (a rapid shot's checkpoint is mid-flight): the physics loop picks it up.
    physicsIdle.kick();
    sync();
    hooks.loaded?.(c, driver);
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

  /** A level built aside and pre-settled (build): its engine and driver, ready to swap in. */
  interface Built { def: LevelDef; pairs: number | undefined; c: CompiledLevel; engine: PhysicsEngine; driver: Driver; phases: LoadPhases }
  /**
   * Compile level i, build its engine and driver, and pre-settle it (paced, so frames keep drawing): the
   * GPU's pre-settle spans many frames, and every frame reads the current level, so a level is built
   * aside and swaps in whole. `cancelled`, checked once the reset is done, drops it (its engine disposed).
   */
  function build(i: number, cancelled: () => boolean = () => false, gate?: () => Promise<void>): { engine: PhysicsEngine; built: Promise<Built | null> } {
    const t0 = performance.now();
    const def = levels[i]!, pairs = room.get(def);
    const next = compileLevel(def);
    const nextEngine = makeEngine(kind, next, device, pairs);
    const nextDriver = new Driver(nextEngine, next, { ...driverOptions(kind), refereed: env.duel !== undefined });
    const phases: LoadPhases = { ...noPhases(), compile: performance.now() - t0 };
    const built = (async () => {
      try {
        await nextDriver.reset(gate && resetOptions.pace ? { ...resetOptions, pace: { ...resetOptions.pace, gate } } : resetOptions);
      } catch (e) {
        nextEngine.dispose();
        if (cancelled()) return null;
        throw e;
      }
      if (cancelled()) { nextEngine.dispose(); return null; }
      Object.assign(phases, nextDriver.resetMs);
      return { def, pairs, c: next, engine: nextEngine, driver: nextDriver, phases };
    })();
    return { engine: nextEngine, built };
  }

  /**
   * The next level built ahead (prefetch), while the result card shows: Next then swaps it in at once
   * instead of building and pre-settling it then. It is the level a load would build (the same def and
   * pair room, checked when it is taken), so the state is the same; a load of anything else drops it.
   */
  let spare: { i: number; def: LevelDef; pairs: number | undefined; engine: PhysicsEngine; built: Promise<Built | null>; dropped: boolean } | null = null;
  function prefetch(i: number): void {
    if (prefetchMode === 'off') return;
    if (i < 0 || i >= levels.length || i === levelIdx) return;
    const def = levels[i]!, pairs = room.get(def);
    if (spare && spare.i === i && spare.def === def && spare.pairs === pairs) return;
    dropSpare();
    const s = { i, def, pairs, dropped: false } as NonNullable<typeof spare>;
    const b = build(i, () => s.dropped, () => prefetchGate(s));
    s.engine = b.engine;
    // A failed prefetch is not the player's error: the load that wants the level builds it again and reports.
    s.built = b.built.catch((e) => { console.warn(`prefetch of ${def.id} failed: ${(e as Error).message}`); return null; });
    spare = s;
    handle.spare = { level: def.id, settled: false };
    // The next level's opening view is searched now too (view.ts remembers it), not at the swap (B2's takes ~0.2 s).
    void s.built.then((x) => { if (spare === s && x) { handle.spare = { level: def.id, settled: true }; if (!duel) viewOf(x.c, viewAspect(), undefined, undefined, undefined, { mode: feel.view, insets: openingInsets(viewAspect(), panelTimeline(x.c) !== null, innerWidth), hud: dockedHud() }); } });
    handle.counts.prefetch = (handle.counts.prefetch ?? 0) + 1;
  }
  /**
   * Holds a prefetch's next batch while the live level runs a shot (its steps and the prefetch's would share
   * the one GPU queue), until the round is ending (the card is up) or a load waits on the spare; a dropped
   * spare goes on at once, to its end (its engine is disposed).
   */
  async function prefetchGate(s: { dropped: boolean }): Promise<void> {
    const held = () => !s.dropped && loading === 0 && !ending && handle.result === null && driver.session.phase === 'running';
    if (!held()) return;
    handle.counts.prefetchHeld = (handle.counts.prefetchHeld ?? 0) + 1;
    while (held()) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  /** Build what Next opens (a duel's Rematch: its other level), if there is one. */
  function prefetchNext(): void {
    if (duel) prefetch(1 - levelIdx);
    else if (step(levelIdx, 1)) prefetch(levelIdx + 1);
  }
  function dropSpare(): void {
    if (!spare) return;
    spare.dropped = true;
    // Disposed now, so a pre-settle still running stops at its next step (it then resolves null).
    spare.engine.dispose();
    spare = null;
    handle.spare = null;
  }
  /**
   * The spare for level i if it is the one a load would build now, taken (awaited if still settling); else
   * null. A retry keeps a spare of another level for a later Next; a load of any other level drops it.
   */
  async function takeSpare(i: number): Promise<Built | null> {
    const s = spare;
    if (!s) return null;
    if (s.i !== i) { if (i !== levelIdx) dropSpare(); return null; }
    if (s.def !== levels[i] || s.pairs !== room.get(levels[i]!)) { dropSpare(); return null; }
    spare = null;
    handle.spare = null;
    return s.built;
  }

  /**
   * The level as it loaded (Driver.checkpoint right after its pre-settle), for an instant retry: Retry and
   * R put the same engine back to it in place instead of building and pre-settling the level again. Kept
   * while the level is loaded (it dies with its engine); taken unless keystone.retry=rebuild or the engine
   * has no checkpoints. Only for the level and pair room it was taken at: a round that dropped pairs
   * rebuilds with more room.
   */
  let start: { i: number; def: LevelDef; pairs: number | undefined; cp: DriverCheckpoint } | null = null;
  const dropStart = () => { start?.cp.dispose(); start = null; };

  /** Load level i; with `line` (undo), replay those shots on it out of sight and play on from their settle. */
  async function loadNow(i: number, retry: boolean, line?: Shot[]) {
    const t0 = performance.now();
    // The round being left is over: check what it hit before its engine goes.
    if (engine) await checkRound();
    const tc = performance.now();
    const def = levels[i]!;
    // A retry of the level as loaded: its start checkpoint, restored in place (the same engine and driver).
    const back = retry && !line && start && start.i === i && start.def === def && start.pairs === room.get(def) && i === levelIdx ? start : null;
    if (back) back.cp.restore();
    else dropStart();
    // An undo replays its line on a fresh build; a load takes the spare when it is this level's.
    const ahead = back || line ? null : await takeSpare(i);
    const b: Built | null = back ? { def, pairs: back.pairs, c, engine: engine!, driver, phases: { ...noPhases(), restored: true } } : ahead ?? await build(i).built;
    if (!b) throw new Error(`level ${def.id} was dropped while it loaded`);
    const { c: next, engine: nextEngine, driver: nextDriver, pairs: nextPairs } = b;
    // The input hook keeps state per session: the replay's goes on with the live play.
    const nextPerStep = env.perStep?.(next) ?? null;
    const counts: Record<string, number> = { ...(line ? handle.counts : {}) };
    const phases: LoadPhases = { ...b.phases, check: tc - t0, prefetched: ahead !== null };
    // Waited on a spare: the time it was still settling (its own phases are when it was built).
    if (ahead) phases.wait = performance.now() - tc;
    try {
      const tr = performance.now();
      // Undo: the kept shots as a session plays them (runSession's playShots), left aiming at their settle, not banked.
      if (line?.length) await playShots(nextDriver, line, 0, { bank: false, perStep: nextPerStep ?? undefined });
      phases.replay = performance.now() - tr;
    } catch (e) {
      if (nextEngine !== engine) nextEngine.dispose();
      throw e;
    }
    if (engine !== nextEngine) engine?.dispose();
    // The level as it loads, kept for an instant retry (not after an undo's replay: that is not the start).
    if (!back && !line && retryMode === 'checkpoint') {
      try {
        const cp = nextDriver.checkpoint();
        if (cp) start = { i, def, pairs: nextPairs, cp };
      } catch (e) { console.warn(`retry checkpoint: ${(e as Error).message}`); }
    }
    levelIdx = i;
    c = next;
    engine = nextEngine;
    driver = nextDriver;
    livePairs = nextPairs;
    reportedSteps = 0;
    handle.pairsPerBody = kind === 'gpu' ? gpuEngineOptions(c, livePairs).pairsPerBody! : 0;
    substeps = engine.info.integrator?.substeps ?? SUBSTEPS;
    const ts = performance.now();
    handle.timing = { loadMs: 0, load: phases, stepMs: [], moving: [], frameMs: [], costMs: [] };
    descs = driver.bodies;
    perStep = nextPerStep;
    ticks = meterTicks(c);
    collapse?.load(c);
    source.reset(c.scene.bodies);
    source.update(driver.snapshot, descs);
    // Fresh effects: role tints, and every body at scale 0 for Regrow (after an undo, at full size: the
    // world is where the kept shots left it, felled crowns and cracked heritage lit as play lit them).
    if (fxSlots) renderer.clearFx(0, fxSlots);
    regrowBuf = regrowScales(c, line ? Infinity : 0, new Float32Array(c.meta.n));
    duel = env.duel ? new Duel(env.duel, c, i as Player, driver.session.home) : null;
    hideHandoff();
    firedAt = null;
    // Owner ink: each side's blocks in its colour, its king glowing a little as crowns do; a duel's neutral blocks plain grey.
    const tints = baseTints();
    renderer.setFx(0, tints, regrowBuf, !line);
    applyMarks();
    paintIce();
    fuse?.level(c);
    // A fold level is judged on what stays in its lot: chalk the lot on the ground, the whole round.
    foldLot = c.def.objective.kind === 'fold' ? lotBeads(c) : null;
    bellZone = zoneBeads(c);
    ballStart = startBeads(c);
    foldPlan = planBeads(c);
    if (line) {
      const s = driver.session, roles = rolePaint(feel.fx);
      s.crownLive.forEach((down, k) => { if (down) renderer.setFx(c.meta.crowns[k]!, { tint: ownTint(c.meta.crowns[k]!), ...roles.crownKept }); });
      s.heritageBroken.forEach((cracked, k) => { if (cracked) renderer.setFx(c.meta.heritage[k]!, { tint: ownTint(c.meta.heritage[k]!), ...roles.heritageKept }); });
    }
    fxSlots = descs.length;
    pacer.reset();
    speed.reset();
    tail.reset();
    skipping = false;
    arrivals = newArrivals();
    juice.reset();
    follow.reset();
    swing.grab();
    // A load, retry or replayed undo starts with no spark, heat, flash, blast or lit fuse of the last attempt (PT2),
    // drawn in the effect style the feel asks for; the kept shots' fuses are lit again below.
    renderer.setEffectStyle(feel.fx);
    renderer.resetEffects();
    fading = [];
    // After an undo the kept shots' bodies are back in their slots: drawn as they were (bombs, painted balls). A fresh attempt starts with none.
    if (line) {
      firedLooks.length = Math.min(firedLooks.length, descs.length - c.meta.n);
      for (let i = c.meta.n; i < descs.length; i++) paintFired(i, firedLooks[i - c.meta.n] ?? null);
    } else firedLooks = [];
    const m = 4 * c.frame.unit;
    followClip = Float64Array.of(c.lot.min[0] - m, 0, c.lot.min[1] - m, c.lot.max[0] + m, 1.5 * c.height + m, c.lot.max[1] + m);
    handle.result = null;
    handle.counts = counts;
    handle.level = c.def.id;
    ending = false;
    hideResult();
    selected = nextSelection(c.def.rack, driver.session.rackLeft, retry ? selected : null);
    if (!c.def.rack.includes(QUAKE)) dial = null;
    else if (!retry || !dial) dial = dialStart(c);
    // Rube Lab levels open with their plunger (the trapdoor's release): the HUD's Go button and key F fire it.
    opener = env.opener?.(c) ?? (c.def.rube ? RUBE_GO : null);
    if (!retry) {
      setPower(100);
      // The play area: the lot (where debris counts), grown a little, up to the structure's top.
      const half: Vec3 = [(c.lot.max[0] - c.lot.min[0]) / 2 + 2, c.height / 2 + 2, (c.lot.max[1] - c.lot.min[1]) / 2 + 2];
      renderer.setShadowBounds([(c.lot.min[0] + c.lot.max[0]) / 2, c.height / 2, (c.lot.min[1] + c.lot.max[1]) / 2], Math.hypot(...half), half);
    }
    arcs = duel ? duel.def.sides.map((side) => arcBeads(c, side)) : [];
    regrowT = line ? null : 0;
    waiting = [];
    frozen = false;
    pullAnim = null;
    handle.pullDrawn = null;
    heldAim = null;
    aimed = null;
    beads = null;
    hover = null; // the new level's tints are fresh
    aimDirty = true;
    crownsShown = driver.session.crownLive.reduce((a, x) => a + x, 0);
    const ls = env.lotSheet?.(c) ?? null;
    lot = ls && { sheet: ls.sheet, goals: ls.goals, groups: selectGroups(c, ls.sheet.groups ?? {}), footprints: selectFootprints(c, ls.sheet) };
    handle.goals = (ls?.goals ?? []).map((g) => ({ id: g.id, text: g.text, met: false, before: ls!.before.includes(g.id) }));
    // The HUD's sheet listed or closed (lot-hud.ts sheetOpenAtLoad, PT18): set when a level comes in, kept through its
    // retries and undos, so the player's own toggle stands; it opens by itself at the round's first clear (drawHud).
    if (c.hash !== sheetFor) { sheetFor = c.hash; sheetOpen = ls?.open ?? true; }
    sheetCleared = false;
    handle.grade = null;
    // After an undo the goals stand as at the kept shots' settle, as play would have judged them there.
    if (line?.length) judgeGoals();
    if (!retry) {
      // The opening view, once the level's HUD is drawn (its lot sheet and rows set above): docked on a phone, the view
      // keeps clear of the HUD's measured band (PT3b), not the upright guess. A duel's sides are what its view is about
      // (duel-view.ts): it opens on the classic view, framed as before; the turn view (when on) then swings to the side to fire.
      // (A duel's HUD reads the view's yaw and is not measured: it keeps its framing.)
      const hud = duel ? undefined : (drawHud(), dockedHud());
      handle.openingHud = hud ?? null;
      orbit = viewOf(c, viewAspect(), undefined, undefined, undefined, { mode: duel ? 'classic' : feel.view, insets: openingInsets(viewAspect(), panelTimeline(c) !== null, innerWidth), hud });
    }
    // A duel opens (and Same start reopens) on the first player's side, as each turn after does (duel-view.ts).
    if (duel && feel.turnView) orbit = duelView(c, duel.def, duel.turn, viewAspect());
    // The real look's sun counts from the opening view (light.ts), set as a level loads and kept by a retry.
    if (!retry) viewSun.yaw = orbit.yaw;
    syncDuel();
    sync();
    phases.swap = performance.now() - ts;
    handle.timing.loadMs = performance.now() - t0;
    // Build what Next opens while the player aims at this one (it waits while a shot runs).
    if (prefetchMode === 'aim') prefetchNext();
    // A level with a build block opens in its build phase on a fresh load (not a retry, Play or Cancel, nor an undo).
    buildAfterLoad = !retry && !line && buildOffered();
    showPanel();
    hooks.loaded?.(c, driver);
  }

  function banner(text: string, cls = '') {
    env.banner.textContent = text;
    env.banner.classList.remove('show', 'crack');
    if (cls) env.banner.classList.add(cls);
    void env.banner.offsetWidth; // restart the animation
    env.banner.classList.add('show');
  }

  /**
   * The step's snapshot to the renderer: as it is, or with the last pull's block drawn where its slide-out has it
   * (pull-anim.ts withPulled: the snapshot is patched for the upload only), lit and shrinking; once the slide is
   * over, the slot's own tint and full scale back (it is a tombstone, drawn by no pass, until an undo restores it).
   */
  function uploadSnapshot(d: Driver) {
    const a = pullAnim, k = a ? d.engine.stepIndex - pullStep : 0;
    if (!a || k > PULL_SLIDE_STEPS + 1) { source.update(d.snapshot, descs); handle.pullDrawn = null; return; }
    const p = withPulled(d.snapshot, a, k, () => source.update(d.snapshot, descs));
    handle.pullDrawn = p ? { body: a.body, k, pos: p.pos, scale: p.scale } : null;
    if (p) renderer.setFx(a.body, Uint32Array.of(PULL_HOVER), Float32Array.of(p.scale));
    else if (k === PULL_SLIDE_STEPS + 1) renderer.setFx(a.body, Uint32Array.of(tintOf(c, a.body)), Float32Array.of(1));
  }

  /** Light the block a pull would take (null: none), putting the last one back to its own tint. */
  function setHover(b: number | null) {
    if (b === hover) return;
    if (hover !== null) renderer.setFx(hover, Uint32Array.of(tintOf(c, hover, coatsOn())));
    hover = b;
    if (b !== null) renderer.setFx(b, Uint32Array.of(PULL_HOVER));
  }

  /**
   * Where a frozen shot's aim holds with no pointer (PT33, PaceFeel.frozenAim): the last spot aimed at, else the standing
   * crown nearest the middle of the frame (so a freeze from the HUD or a key still shows what a shot would do), else the
   * middle of the frame (a level with no crowns: B1's wall), where the view looks.
   */
  function heldAimAt(): [number, number] | null {
    if (!frozen || !feel.frozenAim) return null;
    if (heldAim) return heldAim;
    const m = viewProj(orbit, aspect()), s = driver.snapshot, live = driver.session.crownLive;
    let best: [number, number] | null = null, bestD = Infinity;
    c.meta.crowns.forEach((b, k) => {
      if (live[k] || b >= s.count) return;
      const x0 = s.pos[3 * b]!, y0 = s.pos[3 * b + 1]!, z0 = s.pos[3 * b + 2]!;
      const w = m[3]! * x0 + m[7]! * y0 + m[11]! * z0 + m[15]!;
      if (w <= 0) return;
      const x = (m[0]! * x0 + m[4]! * y0 + m[8]! * z0 + m[12]!) / w, y = (m[1]! * x0 + m[5]! * y0 + m[9]! * z0 + m[13]!) / w;
      const d = Math.hypot(x, y);
      if (Math.abs(x) <= 0.95 && Math.abs(y) <= 0.95 && d < bestD) { best = [x, y]; bestD = d; }
    });
    return best ?? [0, 0];
  }

  function updateAim() {
    aimDirty = false;
    if (pointer) heldAim = [pointer[0], pointer[1]];
    const at = pointer ?? heldAimAt();
    aimed = null;
    aimHit = null;
    beads = null;
    let lit: number | null = null;
    ring = handle.reach = null;
    contact = null;
    previewingOpener = false;
    // No aim (nor its preview) under the hand-over card: the next player has not taken the device yet.
    if (at && selected && aimable() && regrowT === null && !handle.handoff) {
      const hit = pick(rayThrough(orbit, aspect(), at[0], at[1]), driver.snapshot, c);
      if (selected === 'pull') {
        // A pull takes the block under the cursor: lit when it can be taken, no arc.
        const p = pullFor(driver.session, hit);
        aimed = p;
        if (p?.reachable) lit = p.shot.body;
      } else if (hit) {
        aimHit = { body: hit.body, point: hit.point };
        aimed = shotFor(c, selected, azFromYaw(orbit.yaw), power, hit.point, substeps, launchNow());
        if (aimed) {
          contact = arcContact(c, driver.snapshot, aimed.shot, substeps);
          beads = previewBeads(c, aimed.shot, hit.point, substeps, 40, 2, contact);
        }
        // A weapon with one blast (the grenades): show how far it reaches, where it would go off.
        const blasts = aimed ? c.arms[selected]?.blasts : undefined;
        if (blasts?.length === 1 && blasts[0]!.count === 1) ring = handle.reach = { centre: [hit.point[0], hit.point[1], hit.point[2]], radius: blasts[0]!.blast.radius };
      }
    } else if (!at && aimable() && regrowT === null && !handle.handoff) {
      // Before the player aims (and while the cursor is off the canvas), the pre-aimed opener shows its flight and where
      // it lands (PT14): what F, or the HUD's Fire button, will do. Its blast zone too, for a bomb. Nothing is aimed.
      // Not under the hand-over card, like the aim.
      const op = openerNow();
      if (op && op.ammo !== 'pull' && op.ammo !== 'cue' && op.ammo !== 'plunger' && op.ammo !== 'quake') {
        contact = arcContact(c, driver.snapshot, op, substeps);
        if (contact) {
          previewingOpener = true;
          beads = previewBeads(c, op, contact.point, substeps, 40, 2, contact);
          const blasts = c.arms[op.ammo]?.blasts;
          if (blasts?.length === 1 && blasts[0]!.count === 1) ring = handle.reach = { centre: [contact.point[0], contact.point[1], contact.point[2]], radius: blasts[0]!.blast.radius };
        }
      }
    }
    handle.impact = contact ? { body: contact.body, point: [...contact.point], normal: [...contact.normal], opener: previewingOpener } : null;
    setHover(lit);
    // A refused pull's hint stays red only while the cursor stays on the block that was refused.
    if (aimed?.shot.ammo !== 'pull' || aimed.shot.body !== refusedPull) refusedPull = null;
    handle.input.aimed = aimed ? { ...aimed.shot } : null;
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
    const f = roundFacts(c, driver.session, driver.snapshot, lot.groups, lot.footprints);
    handle.goals = lot.goals.map((g, k) => ({ ...handle.goals[k]!, met: goalMetSafe(g, f) }));
    handle.grade = gradeOf(lot.sheet.grades, f);
  }

  /**
   * A bell rang (Rube Lab, PT26): it flashes in its gilt (BELL_FLASH), two ring waves run out from it (Renderer.ring),
   * and the banner says so; the chime is audio.ts's (voicesFor, bell). The bell itself was knocked by what hit it.
   */
  function ringBell(b: number, step: number) {
    const s = driver.snapshot;
    renderer.setFx(b, { ...BELL_FLASH, tint: ownTint(b) });
    if (b < s.count) renderer.ring([s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], RING_REACH * c.frame.unit);
    handle.counts.bellRung = (handle.counts.bellRung ?? 0) + 1;
    handle.counts.bellStep = step;
    banner('The bell rang!');
  }

  function onFeedback(fb: Feedback[]) {
    for (const f of fb) {
      handle.counts[f.t] = (handle.counts[f.t] ?? 0) + 1;
      voices.push(...voicesFor(f, { impacts: !collapse, bell: c.def.objective.kind === 'bell' }));
      switch (f.t) {
        case 'fired':
          juice.kick(f.ammo === 'cannonball' ? 0.05 : 0.03);
          if (f.ammo === 'pull') {
            // The block is gone (the renderer skips the tombstone): a puff of dust where it was, and
            // (PaceFeel.pullAnim) the block drawn sliding out toward the camera, with a ghost where it stood.
            const s = driver.snapshot, b = f.body, shape = descs[b]?.shape;
            if (b < s.count) renderer.burst([s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], [0, 1, 0], PULL_PUFF);
            if (feel.pullAnim && b < s.count && shape?.kind === 'box') {
              pullAnim = pullAnimFor(b, [s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], [s.rot[4 * b]!, s.rot[4 * b + 1]!, s.rot[4 * b + 2]!, s.rot[4 * b + 3]!], [...shape.half] as [number, number, number], eyeOf(orbit), performance.now());
              pullStep = driver.engine.stepIndex;
            }
          }
          break;
        case 'contact': {
          // Classic: a burst at the ball as hard as its own speed change. With effects that follow the damage (PT2) the
          // renderer's detector sparks the blocks the ball moves, and the ball's own hit only as a puff (SparkParams.ballSparks).
          const j = contactJuice(f.impulse), s = driver.snapshot, b = f.body;
          if (feel.fx === 'classic' && b < s.count) {
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
          if (c.def.objective.kind === 'bell') ringBell(f.body, f.step);
          // A felled crown flashes once and stops glowing.
          else renderer.setFx(f.body, { ...rolePaint(feel.fx).crownFlash, tint: ownTint(f.body) });
          // Only where the clear ends the level: par levels, and outcome levels with autobank.
          if (c.def.objective.kind === 'crowns' && f.ordinal + 1 === c.meta.crowns.length && driver.session.phase === 'running' && (driver.session.scoring === 'par' || c.def.autobank)) {
            ending = true;
            pacer.release();
            showResult(null);
            // The card is up while the settle finishes at fast-forward: start building what Next opens now.
            prefetchNext();
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
        case 'iceCrack':
          renderer.setSurface(f.body, { kind: 'ice', crack: f.level, at: f.at, seed: f.seed });
          break;
        case 'shatter': {
          // The block is gone (its tombstone is not drawn) and its pieces are ice; a burst of ice where it broke
          // (PT38: cold shards in the stylized looks, white and blue chips and frost powder in the real look).
          // Fragments (ice.ts) start crushed at the corner that faced the block's centre.
          for (const k of f.cracks) renderer.setSurface(k.body, { kind: 'ice', crack: k.level, at: k.at, seed: k.seed });
          const s = driver.snapshot, b = f.body;
          if (b < s.count) renderer.burst([s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], [0, 1, 0], f.dv, { ice: true });
          juice.shake(0.12);
          break;
        }
        case 'slowMo': if (feel.slowMo && !fastHeld && !handle.fast) pacer.slowMo(); break;
        case 'heritageCrack':
          juice.shake(0.3);
          banner('Heritage cracked', 'crack');
          // Damage style: a red flash, and the block stays painted the lost red (PT28; classic: to white).
          renderer.setFx(f.body, { tint: ownTint(f.body), ...rolePaint(feel.fx).heritageFlash });
          break;
        case 'tier': banner(`${TIER_NAMES[f.tier]}!`); break;
        case 'settled':
          judgeGoals();
          pacer.release();
          spendFired();
          // A crown back above the line (rare: a catapult) means the round goes on after all.
          if (ending && driver.session.phase === 'aiming') { ending = false; hideResult(); }
          selected = nextSelection(c.def.rack, driver.session.rackLeft, selected);
          if (duel && duel.shooter !== null) {
            const r = duel.settled(driver.snapshot), side = duel.def.sides[duel.turn];
            syncDuel();
            floatScore();
            // Decided before the racks are spent: end the round here (a bank, once this step's feedback is done).
            if (r.over) queueMicrotask(() => { if (driver.session.phase === 'aiming') bank(); });
            else {
              selected = nextSelection(side.rack, duel.left[duel.turn], null);
              // Pass the device: the hand-over card, or (without it) a banner.
              if (feel.handoff) showHandoff();
              else banner(`${side.name}'s turn`);
              // The turn view: swing to the next player's over-the-shoulder view (the follow camera, if on, lets go).
              if (feel.turnView) { follow.grab(); swing.start(orbit, duelView(c, duel.def, duel.turn, viewAspect())); }
              // The kings' marks: the shield goes to the king of the player to fire.
              applyMarks();
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
          // While the card shows, build what Next (a duel's Rematch) opens, so it swaps in at once (if not already).
          prefetchNext();
          break;
      }
    }
  }

  /**
   * The round is over (score null: every crown is down and the settle still runs at fast-forward; a score: it
   * settled and is scored). Classic (no delay), the card shows at once, tallying until the score. Docked
   * (layout.ts, PT4), a small tallying banner shows instead and the card waits Layout.cardDelay of wall time
   * after the settle, so the player sees the collapse land; then it docks aside, not over the middle.
   */
  function showResult(score: LevelScore | null) {
    if (duel && !score) return;
    let duelHtml = '';
    if (duel) {
      hideHandoff();
      // Only a decided duel has a card: never an empty one (the agent playtest's empty bar, PT5).
      duelHtml = duelResultHtml(duel);
      if (!duelHtml) return;
    }
    const lay = env.layout, delay = lay ? lay.cardDelay : 0;
    handle.resultShownAt ??= driver.engine.stepIndex;
    handle.card.place = lay?.card ?? 'center';
    env.result.classList.toggle('dock', handle.card.place === 'dock');
    if (duel) env.result.innerHTML = duelHtml;
    else {
      const sheet = score && lot ? goalsResultHtml(handle.goals, handle.grade, lot.sheet.grades !== undefined) : '';
      env.result.innerHTML = resultHtml(c.def, score, driver.session.strokes, cardForward(), Boolean(env.onSave), sheet, true);
    }
    if (score) handle.card.endedMs = performance.now();
    if (delay <= 0) { revealCard(); return; }
    tally.innerHTML = tallyHtml(c.def, score, duel ? 'Round over' : null);
    tally.classList.add('show');
    document.body.classList.add('kg-tallying');
    if (!score) return;
    if (cardTimer !== null) clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { cardTimer = null; tally.classList.remove('show'); document.body.classList.remove('kg-tallying'); revealCard(); }, 1000 * delay);
  }

  function revealCard() {
    env.result.classList.add('show');
    document.body.classList.add('ended');
    handle.card.shownMs = performance.now();
  }

  /** The card's forward button: Next inside the series, else the next series, else Levels (the page's level list). */
  function cardForward(): CardForward {
    if (step(levelIdx, 1)) return { act: 'next' };
    const f = env.seriesForward?.(levelIdx);
    if (f) return { act: 'series', label: f.label };
    return env.onLevels ? { act: 'levels' } : null;
  }

  function hideResult() {
    if (cardTimer !== null) { clearTimeout(cardTimer); cardTimer = null; }
    tally.classList.remove('show');
    document.body.classList.remove('kg-tallying');
    env.result.classList.remove('show');
    document.body.classList.remove('ended');
    handle.resultShownAt = null;
    handle.card = { place: handle.card.place, endedMs: null, shownMs: null };
  }

  /** Mirror the round's state onto the handle: each frame, and after each physics step (which runs between frames). */
  function syncState() {
    const s = driver.session;
    Object.assign(handle, { phase: stepping ? 'running' : s.phase, frozen, ready: !loading && !stepping && !editing && s.phase === 'aiming' && regrowT === null, stepIndex: driver.engine.stepIndex, strokes: s.strokes, bodies: driver.snapshot.count, collapse: s.liveCollapse });
  }

  /** Mirror state, pace and view onto the handle; called each frame and right after anything that changes it.
   * Pace and view are what the frame drew (the HUD tag, the camera), so only a frame mirrors them. */
  function sync() {
    syncState();
    const s = driver.session;
    const running = s.phase === 'running', v = running ? speed.speed(performance.now()) : 1, costs = handle.timing.costMs;
    handle.pace = { timeScale: running ? pacer.timeScale : 1, speed: v, tag: running && !fastHeld && !handle.fast && !ending && !tail.on && !skipping ? slowTag(v) : '', tailSkip: tail.on, costMs: running && !Number.isNaN(pacer.costMs) ? pacer.costMs : median(costs.slice(-60)) };
    handle.view = { target: [...orbit.target], distance: orbit.distance, yaw: orbit.yaw, pitch: orbit.pitch, following: follow.active, jolt, turning: swing.active, cue: cueNow(), arcBeads: arcBeadsDrawn, impact: impactDrawn, xray: renderer.xray };
  }

  /** The physics loop's idle wait: the next frame, or a fire, whichever comes first (physics-loop.ts wakeable). */
  const physicsIdle = wakeable(() => new Promise<void>((res) => requestAnimationFrame(() => res())));

  /** Whether the player can aim (and fire) now: while aiming, or with rapid fire or frozen while a shot runs, until the round is known to be over. */
  function aimable(): boolean {
    if (editing) return false;
    const p = driver.session.phase;
    return p === 'aiming' || (p === 'running' && (feel.rapid || frozen) && !ending);
  }

  /** Whether the running shot can be frozen now: the level gives freezes and one is left (a shot fired while frozen spends it). */
  function canFreeze(): boolean {
    const s = driver.session;
    return !loading && regrowT === null && !ending && handle.result === null && s.phase === 'running' && c.def.freeze !== undefined && s.freezesLeft > 0;
  }

  function freeze(on = !frozen): boolean {
    if (on === frozen || (on && !canFreeze())) return false;
    frozen = on;
    if (!on) {
      // Sim time stood still: the pace measures afresh, and the loop (restarted by the pacer) owes nothing for the pause.
      speed.reset();
      physicsIdle.kick();
    }
    aimDirty = true;
    sync();
    return true;
  }

  /** Whether `shot` may go in when its turn comes: the rack holds one more of it than the shots already waiting. */
  const inRack = (shot: Shot, queued: readonly Shot[]) =>
    driver.session.rackLeft.filter((a) => a === shot.ammo).length > queued.filter((q) => q.ammo === shot.ammo).length;

  function fire(shot: Shot): boolean {
    if (editing || loading || regrowT !== null || ending || handle.result !== null || !driver.session.canFire(shot.ammo) || !inRack(shot, waiting)) return false;
    // A duel takes one shot per turn from the current player's side and rack (the referee says why not).
    const refused = duel?.refuse(shot) ?? (duel && waiting.length ? { message: 'Wait for the last shot to settle' } : null);
    if (refused) {
      // From the wrong side: say which way to drag to reach the right one.
      const cue = duel && 'why' in refused && refused.why === 'arc' && 'az' in shot ? turnCue(duel.def.sides[duel.turn].arc, shot.az) : null;
      banner(cue ? turnCueText(duel!.def.sides[duel!.turn].name, cue, handle.input.touch) : refused.message, 'crack');
      return false;
    }
    // A weapon over the device's tier (a link's or keystone.rack's): refused, saying what fires it.
    const over = armRefusal(c, shot.ammo, env.weaponTier?.() ?? 'high');
    if (over) { banner(over, 'crack'); return false; }
    const timed = shot.after !== undefined && driver.session.strokes > 0;
    if (!timed && !aimable()) return false;
    if (shot.ammo === 'pull' && driver.session.pullRefusal(shot.body) !== null) { refusedPull = shot.body; return false; }
    if (shot.ammo === 'plunger' && driver.session.plungerRefusal(shot) !== null) return false;
    if (shot.ammo === 'quake' && driver.session.quakeRefusal(shot) !== null) return false;
    // Without rapid fire a click mid-step is refused, as before; with it, or for a line's timed shot, it waits for the step.
    if (stepping || timed || waiting.length) {
      if (stepping && !timed && !feel.rapid && !frozen) return false;
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
      if (!s.canFire(next.ammo) || (next.ammo === 'pull' && s.pullRefusal(next.body) !== null) || (next.ammo === 'plunger' && s.plungerRefusal(next) !== null) || (next.ammo === 'quake' && s.quakeRefusal(next) !== null) || duel?.refuse(next)) continue;
      fireNow(next);
    }
  }

  function fireNow(shot: Shot) {
    setHover(null);
    // The world as this shot goes in, for undo (before the fire: the shot is not in it yet).
    takeMark();
    const fb = driver.fire(shot);
    if (duel) { duel.fired(shot); turnStart = performance.now(); syncDuel(); swing.grab(); hideHandoff(); firedAt = aimHit && aimed && aimed.shot === shot ? aimHit.point : null; }
    // A shot fired while frozen (Bullet Time) has cut in at the frozen step: the world runs on with it.
    frozen = false;
    // A held aim (PT33) was only for the freeze: it goes with it, at the next frame.
    aimDirty = true;
    // The shot's first step goes in now, not at the next frame.
    physicsIdle.kick();
    // A shot's pace starts fresh: no tail yet, and at real time until its steps say otherwise.
    tail.reset();
    skipping = false;
    speed.reset();
    // A rapid shot keeps the follow camera's way home: where the player had it when the first went in.
    if (feel.follow && !follow.active) follow.start(orbit);
    onFeedback(fb);
    spawned(shot.ammo);
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
    // A Mason level's slot is its Test.
    if (c.def.mason) return startTrial();
    const o = openerNow();
    return o !== null && fire(o);
  }

  function setMuted(m: boolean) {
    muted = m;
    if (synth) synth.muted = muted;
    collapse?.setMuted(muted);
  }

  /** Whether Skip can go in now: a shot is running, not frozen, and not already skipping. */
  const canSkip = () => !loading && regrowT === null && driver.session.phase === 'running' && !frozen && !skipping;
  function skip(): boolean {
    if (!canSkip()) return false;
    skipping = true;
    pacer.release();
    physicsIdle.kick();
    return true;
  }

  function bank(): boolean {
    if (editing || stepping || regrowT !== null || !driver.session.canBank()) return false;
    // A duel ends by its referee: until it is decided there is nothing to bank (PT5: a bank mid-duel showed an empty card).
    if (duel && !duel.result.over) return false;
    hooks.banked?.(c, driver);
    onFeedback(driver.bank());
    aimed = null;
    beads = null;
    sync();
    return true;
  }

  /** The launcher height now (1/4 h): the player's, or the level's in this mode when the level or mode changed. */
  function launchNow(): number {
    const key = `${c.hash}|${feel.launch}`;
    if (key !== launchFor) { launchFor = key; launchAt = launchHeight(c, feel.launch); }
    handle.input.launch = launchAt;
    return launchAt;
  }

  /** Keys W (up) and S (down): the launcher `steps` h from where it is, kept to the level's range (launchStep). */
  function moveLauncher(steps: number) {
    launchAt = launchStep(c, launchNow(), steps);
    handle.input.launch = launchAt;
    aimDirty = true;
  }

  function setPower(p: number) {
    if (!Number.isFinite(p)) return;
    power = Math.max(0, Math.min(100, p));
    handle.input.power = power;
    aimDirty = true;
  }

  function select(a: RackItem): boolean {
    if (!driver.session.rackLeft.includes(a) || (duel && !duel.left[duel.turn].includes(a))) return false;
    selected = a;
    aimDirty = true;
    return true;
  }

  handle.fire = fire;
  handle.dial = () => (dial ? { ...dial } : null);
  handle.dialStep = (field, dir) => {
    if (!dial) return null;
    dial = dialStep(c, dial, field, dir);
    return { ...dial };
  };
  handle.startQuake = () => dial !== null && fire(dialShot(dial));
  handle.marks = () => Array.from({ length: c.meta.n }, (_, i) => renderer.fxOf(i).mark);
  handle.fx = (i) => renderer.fxOf(i);
  handle.refreshMarks = () => applyMarks();
  handle.firedLooks = () => {
    const fused = new Set(renderer.fuses.slots), out: ('bomb' | 'ram' | 'painted' | 'plain')[] = [];
    for (let i = c.meta.n; i < descs.length; i++) {
      const L = firedLooks[i - c.meta.n] ?? null, fx = renderer.fxOf(i);
      // What the renderer holds must be what the record says: a bomb is lit or matte iron, a ram or a painted ball
      // painted and banded, a spent body matte; a plain live one carries no paint.
      const drawn = !L ? !fx.paint : L.kind === 'bomb' ? fused.has(i) || fx.matte : L.kind === 'plain' ? !fx.paint : fx.paint && fx.band;
      if (!drawn) throw new Error(`fired body ${i}: recorded ${L?.kind ?? 'ice'}${L?.spent ? ' (spent)' : ''}, drawn ${JSON.stringify(fx)}`);
      out.push(L?.kind ?? 'plain');
    }
    return out;
  };
  // Spent and drawn so: matte once the fade has begun (its first frame), all the way grey once it is over.
  handle.spentLooks = () => Array.from({ length: descs.length - c.meta.n }, (_, k) => firedLooks[k]?.spent ?? false);
  handle.effects = () => renderer.effectStats();
  handle.bank = bank;
  handle.skip = skip;
  handle.freeze = freeze;
  handle.fireOpener = fireOpener;
  handle.setMuted = setMuted;
  handle.select = select;
  handle.aim = (x, y) => { pointer = [x, y]; updateAim(); return aimed; };
  handle.load = (id) => load(levelIndex(id)).catch(fail);
  handle.retry = () => load(levelIdx, true).catch(fail);
  handle.undo = () => undo().catch((e) => { fail(e); return false; });
  handle.undoMemory = () => marks.held;
  handle.line = () => driver.session.inputs.map((i) => ({ ...i.shot }));
  handle.asleep = () => {
    const s = driver.snapshot, n = Math.min(c.meta.n, s.count);
    let k = 0;
    for (let i = 0; i < n; i++) if (!s.awake[i]) k++;
    return { asleep: k, of: n };
  };
  handle.state = () => ({ step: driver.engine.stepIndex, phase: driver.session.phase, strokes: driver.session.strokes, heritageBroken: sum(driver.session.heritageBroken), hash: snapshotHash(driver.snapshot) });
  // Between steps and loads, so neither a step nor a load's dispose runs under the read.
  handle.health = () => exclusive(async () => (await driver.engine.health?.()) ?? null);
  handle.replay = async (shots) => {
    const e = makeEngine(kind, c, device, livePairs);
    try {
      const r = await runSession(e, c, shots, { ...driverOptions(kind), refereed: env.duel !== undefined, perStep: env.perStep?.(c) ?? undefined });
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

  // Mouse and pen: hover aims, a click without drag fires, drag orbits (right or shift: pan), the wheel zooms.
  // Touch (touch.ts): a finger aims and fires where it lifts, two fingers orbit and pinch to zoom.
  let drag: { x: number; y: number; moved: number; pan: boolean; brush: boolean } | null = null;
  const ndcAt = (x: number, y: number): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2];
  };
  const ndc = (e: PointerEvent) => ndcAt(e.clientX, e.clientY);
  const gestures = new TouchGestures(), touchModeNow = env.touch ?? 'auto';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  /** The pointer type last put down (or hovering, for a mouse or pen): what touchFace follows under auto. */
  let lastPointer: string | null = null;
  const face = () => {
    const on = touchFace(touchModeNow, coarse, lastPointer);
    if (on === handle.input.touch && document.body.classList.contains('kg-touch') === on) return;
    handle.input.touch = on;
    document.body.classList.toggle('kg-touch', on);
    lastHud = ''; // the HUD's opener hint reads differently by touch
  };
  face();
  const pointerSeen = (e: PointerEvent) => { if (e.pointerType !== lastPointer) { lastPointer = e.pointerType; face(); } };
  /** The world ray through a point on the page (client px). */
  const rayAtPx = (x: number, y: number) => { const [nx, ny] = ndcAt(x, y), r = rayThrough(orbit, aspect(), nx, ny); return { origin: r.origin as Vec3, dir: r.dir as Vec3 }; };
  /** A finger in the build phase: where it rests shows the ghost (or draws a brush stroke), where it lifts places or lays. */
  const touchedEdit = (e: EditController, a: TouchAction) => {
    if (a.t === 'aim') {
      const r = rayAtPx(a.x, a.y);
      if (e.tool === 'brush' && !touchStroke) touchStroke = e.down(r);
      else e.move(r);
    } else if (a.t === 'fire') {
      e.up(rayAtPx(a.x, a.y));
      touchStroke = false;
    } else if (a.t === 'cancel') {
      e.cancelStroke();
      touchStroke = false;
    } else return false;
    showEdit();
    return true;
  };
  const touched = (acts: TouchAction[]) => {
    for (const a of acts) {
      if (editing && touchedEdit(editing, a)) continue;
      switch (a.t) {
        case 'aim': pointer = ndcAt(a.x, a.y); aimDirty = true; break;
        case 'fire': {
          pointer = ndcAt(a.x, a.y);
          updateAim();
          const shot = aimed?.shot;
          // No hover on a touch screen: once the finger is up, nothing is aimed until the next one lands.
          pointer = null;
          updateAim();
          if (shot) fire(shot);
          break;
        }
        case 'cancel': pointer = null; updateAim(); break; // the arc goes at once, not at the next frame
        case 'orbit': grabCamera(); orbitDrag(orbit, a.dx, a.dy); aimDirty = true; break;
        case 'zoom': grabCamera(); zoomBy(orbit, a.ratio); aimDirty = true; break;
      }
    }
    handle.input.gesture = gestures.state;
    handle.input.fingers = gestures.fingers;
  };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    pointerSeen(e);
    wakeAudio();
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') { touched(gestures.start(e.pointerId, e.clientX, e.clientY)); return; }
    const pan = e.button === 2 || e.shiftKey;
    // Building: a left press with the domino brush starts a stroke, and its drag draws the run instead of orbiting.
    const brush = !!editing && e.button === 0 && !pan && editing.down(rayAtPx(e.clientX, e.clientY));
    if (brush) showEdit();
    drag = { x: e.clientX, y: e.clientY, moved: 0, pan, brush };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') { touched(gestures.move(e.pointerId, e.clientX, e.clientY)); return; }
    if (!drag) pointerSeen(e); // a mouse or pen hovering takes the face back from touch
    if (editing && (!drag || drag.brush)) {
      const r = rayAtPx(e.clientX, e.clientY);
      editing.move(r, { alt: e.altKey });
      showEdit();
      if (drag) Object.assign(drag, { moved: drag.moved + Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y), x: e.clientX, y: e.clientY });
      return;
    }
    pointer = ndc(e);
    aimDirty = true;
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.moved >= 5) grabCamera(); // the player has the camera: the follow lets go for this shot, the turn view for this turn
    if (drag.pan) {
      const s = orbit.distance * 0.0015, cy = Math.cos(orbit.yaw), sy = Math.sin(orbit.yaw);
      orbit.target = [orbit.target[0] - dx * cy * s, orbit.target[1] + dy * s, orbit.target[2] + dx * sy * s];
    } else {
      orbitDrag(orbit, dx, dy);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') {
      // A touch only activates the page (so audio may start) on its lift, not its press.
      wakeAudio();
      touched(gestures.end(e.pointerId, e.clientX, e.clientY));
      return;
    }
    if (editing) {
      // A brush stroke's release lays the run; a click without drag places (or erases).
      if (drag?.brush || (drag && drag.moved < 5 && e.button === 0 && !e.shiftKey)) { editing.up(rayAtPx(e.clientX, e.clientY), { alt: e.altKey }); showEdit(); }
      drag = null;
      return;
    }
    if (drag && drag.moved < 5 && e.button === 0 && !e.shiftKey) {
      pointer = ndc(e);
      updateAim();
      if (aimed) fire(aimed.shot);
    }
    drag = null;
  });
  canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch') touched(gestures.cancel(e.pointerId));
    else {
      if (drag?.brush && editing) { editing.cancelStroke(); showEdit(); }
      drag = null;
    }
  });
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; pointer = null; aimDirty = true; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    grabCamera();
    zoomBy(orbit, Math.exp(e.deltaY * 0.001));
    aimDirty = true;
  }, { passive: false });
  env.hud.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act) wakeAudio();
    if (act === 'bank') bank();
    if (act === 'skip') skip();
    if (act === 'freeze') freeze();
    if (act === 'opener') fireOpener();
    if (act === 'goals') { sheetOpen = !sheetOpen; drawHud(); }
    // Touch screens' Undo and Restart (hud.ts touchActs; keys U and R).
    if (act === 'undo') void handle.undo();
    if (act === 'restart' && !duel) void handle.retry();
    // The rack's chips and the power buttons: taps on a touch screen (keys 1-4, Q and E on a keyboard).
    const arg = (e.target as HTMLElement).closest('button')?.dataset.arg;
    if (act === 'ammo') { const chip = rackChips(c.def.rack, driver.session.rackLeft, selected).find((x) => x.key === arg); if (chip) select(chip.ammo); }
    if (act === 'power') setPower(power + Number(arg));
    if (act === 'qdial' && arg) { const [f, d] = arg.split(':'); handle.dialStep(f as DialField, Number(d) < 0 ? -1 : 1); }
    if (act === 'quake') handle.startQuake();
    if (act === 'launch') moveLauncher(Number(arg));
  });
  env.result.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'retry') void handle.retry();
    if (act === 'undo') void handle.undo();
    if (act === 'save') env.onSave?.();
    if (act === 'next' && step(levelIdx, 1)) void load(levelIdx + 1).catch(fail);
    if (act === 'series') { const f = env.seriesForward?.(levelIdx); if (f) void load(f.index).catch(fail); }
    if (act === 'levels') env.onLevels?.();
    // A duel: Rematch starts the other side first (the other of its two levels); Same start replays this one.
    if (act === 'rematch' && duel) void load(1 - levelIdx).catch(fail);
    if (act === 'again' && duel) void handle.retry();
  });
  addEventListener('keydown', (e) => {
    if (typing(e)) return;
    wakeAudio();
    const k = e.key.toLowerCase();
    // The hand-over card: Enter or Space starts the turn (and does nothing else).
    if (handle.handoff && (k === 'enter' || k === ' ')) { e.preventDefault(); hideHandoff(); return; }
    if (editing) {
      // Building: Enter plays, Esc leaves without the edits, Ctrl/Cmd+Z undoes, M mutes; the build keys go to the editor
      // (Q / E turn, T tip, 1 to 9 items, B brush, X erase, Z undo); the game's own keys wait until Play.
      if (e.key === 'Enter') playEdit();
      else if (e.key === 'Escape') cancelEdit();
      else if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); editing.undo(); showEdit(); }
      else if (k === 'm') setMuted(!muted);
      else if (!e.ctrlKey && !e.metaKey && editing.key(e.key, { shift: e.shiftKey })) showEdit();
      // N and P still walk the series (a load ends the build phase).
      if (k !== 'n' && k !== 'p') return;
    }
    // B: on a level with a build phase, before the first shot, build (else bank, as everywhere).
    if (k === 'b' && !e.ctrlKey && !e.metaKey && enterEdit()) return;
    if (k === ' ') { e.preventDefault(); fastHeld = true; pacer.release(); }
    const chip = chipsNow().find((x) => x.key === e.key);
    if (chip) select(chip.ammo);
    // The quake designer's keys while the Quake chip is selected (they stand in for power, Q and E, as its rows do).
    if (selected === QUAKE && dial && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const f = (Object.keys(DIAL_KEYS) as DialField[]).find((x) => DIAL_KEYS[x].includes(k));
      if (f) { handle.dialStep(f, DIAL_KEYS[f][1] === k ? 1 : -1); return; }
      if (e.key === 'Enter') { e.preventDefault(); handle.startQuake(); return; }
    }
    if (k === 'q' || k === 'e') setPower(power + (k === 'e' ? POWER_STEP : -POWER_STEP));
    if ((k === 'w' || k === 's') && !e.ctrlKey && !e.metaKey && !e.altKey) moveLauncher(k === 'w' ? 1 : -1);
    if (k === 'b') bank();
    if (k === 'k') skip();
    if (k === 't') freeze();
    if (k === 'f') fireOpener();
    // In a duel, R after the result is a rematch (the other side starts), as the card's first button says.
    if (k === 'r' && !e.ctrlKey && !e.metaKey) void (duel?.result.over ? load(1 - levelIdx).catch(fail) : handle.retry());
    // U, or the platform's undo chord (Ctrl+Z, Cmd+Z on a Mac); not in a duel, whose turns are the players'.
    if (!duel && ((k === 'u' && !e.ctrlKey && !e.metaKey) || (k === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey))) { e.preventDefault(); void handle.undo(); }
    if (!duel && k === 'n' && step(levelIdx, 1)) void load(levelIdx + 1).catch(fail);
    if (!duel && k === 'p' && step(levelIdx, -1)) void load(levelIdx - 1).catch(fail);
    if (k === 'm') setMuted(!muted);
    if (e.key === 'Enter' && fuse?.timeline) { e.preventDefault(); fuse.press(); }
  });
  addEventListener('keyup', (e) => { if (e.key === ' ') fastHeld = false; });

  function resize() {
    const [w, h] = canvasSize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio, handle.maxDpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  /** The quake designer's block: the seismogram recomputed only when the dial moves; Start live while a shot could go in. */
  function quakeHud(d: QuakeDial): string {
    const key = `${c.hash}|${d.peak}|${d.hz}|${d.sec}|${d.axis}`;
    if (key !== traceFor) { traceFor = key; trace = seismogram(c, dialShot(d)); }
    // No view yet on a first load's measuring draw (loadNow, PT3b): the compass only turns with it, the panel's size is the same.
    return quakePanelHtml(c, d, (orbit as Orbit | undefined)?.yaw ?? 0, trace, !loading && regrowT === null && !ending && aimable() && driver.session.canFire(QUAKE));
  }

  /**
   * The docked phone HUD's band, screen shares (docs/game/phone-hud.md, PT3b), or undefined when the HUD is not docked
   * (the desktop panel, Layout classic, a wide screen): upright the strip and the tray with what sits above it (the
   * touch and pull hints, `.above`, the tray's width); sideways the rail's two groups, and the hints right of it at
   * the top (ui.ts), a band down to their bottom. Boxes are picked by orientation so layout.ts hudInsets never reads
   * a hint as a rail.
   */
  function dockedHud(): ScreenInsets | undefined {
    if (!env.hud.classList.contains('kg-dock') || !document.body.classList.contains('kg-touch')) return undefined;
    const upright = matchMedia(DOCK_PORTRAIT).matches;
    if (!upright && !matchMedia(DOCK_SIDEWAYS).matches) return undefined;
    const boxOf = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const boxes = [...env.hud.querySelectorAll(upright ? ':scope > .st, :scope > .tray, :scope > .tray > .above' : ':scope > .st, :scope > .tray')].map(boxOf);
    // Fuse & Fold's panel is part of the band (PT21): upright it stands on the tray, sideways it runs down the right side.
    if (fuse?.timeline) { placeFuse(); boxes.push(boxOf(fuse.el)); }
    const out = hudInsets(boxes, innerWidth, innerHeight), above = env.hud.querySelector(':scope > .tray > .above');
    if (!upright && above) { const b = boxOf(above); if (b.w > 0 && b.h > 0) out.top = Math.max(out.top, Math.min(1, (b.y + b.h) / innerHeight)); }
    return out;
  }

  /**
   * Upright on a docked phone, Fuse & Fold's panel stands on the HUD's tray (and the hints over it) instead of
   * covering it (PT21); anywhere else it keeps the stylesheet's place. Every frame on a level with a timeline.
   */
  function placeFuse(): void {
    if (!fuse?.timeline) return;
    let bottom: number | null = null;
    if (env.hud.classList.contains('kg-dock') && document.body.classList.contains('kg-touch') && matchMedia(DOCK_PORTRAIT).matches) {
      const tops = [...env.hud.querySelectorAll(':scope > .tray, :scope > .tray > .above')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => r.top);
      if (tops.length) bottom = innerHeight - Math.min(...tops) + 8;
    }
    fuse.dock(bottom);
  }

  function drawHud() {
    const s = driver.session;
    if (s.objectiveDone && !sheetCleared) { sheetCleared = true; sheetOpen = true; }
    const crownsDown = s.crownLive.reduce((a, x) => a + x, 0);
    let html = hudHtml({
      level: c.def, strokes: s.strokes, crownsDown, crownsTotal: c.meta.crowns.length,
      heritageBroken: s.heritageBroken.reduce((a, x) => a + x, 0), heritageTotal: c.meta.heritage.length,
      chips: chipsNow(), power, launch: (launchNow() / 4) * c.frame.unit, leverage: { round: s.roundLeverageNow(), shot: s.liveLeverage }, phase: s.phase,
      reachable: aimed ? aimed.reachable : null,
      pullRefused: aimed?.shot.ammo === 'pull' && !aimed.reachable && (aimed.shot.body === refusedPull ? 'tapped' : true),
      collapse: s.liveCollapse, pulled: s.pulledShare(), met: s.objectiveDone, canBank: !stepping && regrowT === null && s.canBank(), canSkip: canSkip(), skipping, pace: handle.pace.tag,
      opener: !stepping && regrowT === null && s.phase === 'aiming' && (openerNow() !== null || trialReady()), ticks,
      ...(c.def.mason ? { trial: trialText(handle.trial, masonWorlds(c.def.mason)) } : {}),
      // While the turn view swings or the hand-over card shows, the aim is the old side's: no refusal, cue or warning (PT5's red line mid-swing).
      ...(duel ? { duel: swing.active || handle.handoff ? duelHudHtml(duel) : duelHudHtml(duel, s.phase === 'aiming' && aimed ? duel.refuse(aimed.shot) : null, azFromYaw(orbit.yaw), s.phase === 'aiming' && aimHit !== null && duel.owned[duel.turn].includes(aimHit.body)) } : {}),
      ...(selected === QUAKE && dial ? { quake: quakeHud(dial) } : {}),
      ...(c.def.freeze !== undefined ? { freezes: { left: s.freezesLeft, total: c.def.freeze, frozen, can: canFreeze() } } : {}),
    }, goalsHudHtml(handle.goals, sheetOpen));
    showPanel();
    // The touch hint line goes once the first shot is in (body.kg-shot; the game page's CSS hides #help on touch).
    document.body.classList.toggle('kg-shot', s.strokes > 0);
    // A Mason level's hint line (ui.ts MASON_HELP): nothing fires there.
    document.body.classList.toggle('kg-mason', !!c.def.mason);
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
  handle.sightlines = async (covered = []) => {
    const m = viewProj(orbit, aspect());
    const { width, height, ids } = await renderer.renderIds({ viewProj: m, eye: eyeOf(orbit), focus: orbit.target, time: performance.now() / 1000, groundY: 0, alpha: 1 });
    const px = pixelCounts({ width, height, ids, solo: new Float64Array(0) }, c.meta.n, covered);
    return { width, height, px: Array.from(px), solo: Array.from(outlineAreas(c, m, width, height)) };
  };
  handle.pixelsOf = (body) => exclusive(async () => {
    const r = await renderer.renderIds({ viewProj: viewProj(orbit, aspect()), eye: eyeOf(orbit), focus: orbit.target, groundY: 0, alpha: 1 });
    const at: number[] = [];
    r.ids.forEach((id, i) => { if (id === body + 1) at.push(i); });
    return { width: r.width, height: r.height, at };
  });
  handle.coverage = (body) => exclusive(async () => {
    const r = await renderer.renderIds({ viewProj: viewProj(orbit, aspect()), eye: eyeOf(orbit), focus: orbit.target, groundY: 0, alpha: 1 });
    let n = 0;
    for (const id of r.ids) if (id === body + 1) n++;
    return n;
  });

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
    // Mason's Trial: the test after the build phase's Play, once the level is in and has grown back.
    if (trialPending && trialReady()) { trialPending = false; startTrial(); }
    const running = !loading && driver.session.phase === 'running';
    // Physics is behind when the sim runs under the HUD's slow-motion speed without being asked to
    // (slow-motion juice, fast-forward); it has headroom when steps cost under CLEAR_SHARE of a step.
    const fast = fastHeld || handle.fast || ending || tail.on || turnUp(), costMs = median(handle.timing.costMs.slice(-COST_WINDOW));
    frames.mode = feel.frames; // read live: the quality tier sets it when the URL does not
    const draw = frames.frame(now, { idle: !running, behind: running && !fast && !pacer.slowing && speed.speed(now) < SLOW_TAG_BELOW, clear: costMs < CLEAR_SHARE * 1000 * c.scene.dt }, !!want);
    handle.draws = { drawn: frames.drawn, skipped: frames.skipped, decimating: frames.decimating };
    if (draw) {
      if (running && !Number.isNaN(lastDrawn)) handle.timing.frameMs.push(now - lastDrawn);
      lastDrawn = now;
    }
    if (!running || frozen) collapse?.pause(); // between shots: the next step's audio frame starts afresh
    // Aiming while a shot runs (rapid fire): the world moves under the pointer, so aim again each frame.
    if (running && pointer && aimable()) aimDirty = true;
    if (follow.active) {
      const red = loading ? undefined : driver.observed?.red;
      follow.update(orbit, dt, running, red?.movingBox ?? null, red?.nMoving ?? 0, c.frame.unit, followClip);
      aimDirty = true;
    }
    // The turn view's swing (a duel's turn passed): the aim follows the view, as under a drag.
    if (swing.active) { swing.update(orbit, dt); aimDirty = true; }
    if (aimDirty) updateAim();
    sync();

    // The juice runs either way, so switching shake on mid-shot picks up where it stands; the view takes it only when asked.
    const juiced = juice.update(dt), shake = feel.shake ? juiced : { yaw: 0, pitch: 0, fovScale: 1 };
    const view: Orbit = { ...orbit, yaw: orbit.yaw + shake.yaw, pitch: orbit.pitch + shake.pitch, fovY: orbit.fovY * shake.fovScale };
    handle.view.jolt = jolt = Math.max(Math.abs(shake.yaw), Math.abs(shake.pitch), 1 - shake.fovScale);
    // The player to fire's arc on the ground, between shots (and the aim's beads over it).
    const arc = duel && feel.arcs && !duel.result.over && duel.shooter === null ? arcs[duel.turn] ?? null : null;
    arcBeadsDrawn = arc?.colours.length ?? 0;
    // Fuse & Fold: the charges' markers, coloured by their delays, while the plunger can still go.
    const plungerReady = !!fuse?.timeline && handle.ready && driver.session.rackLeft.includes('plunger');
    fuse?.ready(plungerReady);
    if (fuse?.timeline) {
      fuse.heading(view.yaw, view.pitch);
      placeFuse();
      // The plan's tags in the scene (PT24) while the plunger can go: charge delays, N and Yard.
      fuse.world(plungerReady ? viewProj(view, viewAspect()) : null, canvas.getBoundingClientRect());
    }
    const ghost = pullAnim ? ghostOutline(pullAnim, now - pullAnim.at) : null;
    // Rube Lab's ball start shows until the release goes (the attempt's first input); its zone the whole round.
    const start = ballStart && driver.session.inputs.length === 0 ? ballStart : null;
    const o = joinOverlays(beads ? beadOverlay(beads, aimed?.reachable ?? true) : null, arc, ghost, plungerReady ? timelineOverlay(fuse!.timeline!) : null, plungerReady ? foldPlan : null, foldLot, bellZone, start);
    renderer.reach(ring?.centre ?? null, ring?.radius ?? 0);
    // The impact marker: where the previewed flight first touches, on that face, a little wider than the shot (none under a blast zone).
    const mark = feel.impact && beads && contact && !ring ? contact : null;
    impactDrawn = mark !== null;
    // The objectives through what hides them (feel.xray, read live: the setting can change mid-level; worked out once per level and mode).
    if (xrayMemo?.c !== c || xrayMemo.mode !== feel.xray) xrayMemo = { c, mode: feel.xray, on: xrayOn(c, feel.xray) };
    renderer.xray = xrayMemo.on;
    renderer.impact(mark?.point ?? null, mark?.normal, mark ? Math.max(1.6 * mark.radius, IMPACT_MIN_RADIUS * c.frame.unit) : 0);
    fadeSpent(now);
    renderer.setOverlay(o?.xyzr ?? new Float32Array(0), o?.colours);
    pendingCapture = null;
    // Bullet Time's frozen look: the grade eases in and out, the sparks dim and hang (dt 0) while frozen.
    const frozenLook = frozen && feel.frozenLook;
    frozenGrade = easeGrade(frozenGrade, frozenLook ? 1 : 0, dt);
    renderer.freezeFx = freezeFxOf(frozenGrade, feel.frozenAim);
    handle.frozenGrade = frozenGrade;
    frozenLabel.classList.toggle('on', frozenLook);
    const fp = { viewProj: viewProj(view, aspect()), eye: eyeOf(view), focus: orbit.target, time: now / 1000, groundY: 0, alpha: running ? alphaAt(arrivals, now, 1000 * c.scene.dt) : 1, ...(frozenLook ? { dt: 0 } : {}) };
    // Offscreen (tests), nobody sees a frame and nothing throttles requestAnimationFrame
    // to the GPU: on SwiftShader a frame takes up to a second, so frames would queue
    // without bound and every readback (a step's, a replay's) wait behind them.
    // There, draw only for a capture.
    viewSun.update(renderer, feel.sun);
    if ((!offscreen && draw) || want) {
      // Debug: blocks asleep in blue (keystone.sleeptint, the Scene panel), read live.
      renderer.toggles.sleepTint = feel.sleepTint;
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
  const fastNow = () => fastHeld || handle.fast || ending || tail.on || skipping || turnUp();
  void runPhysics({
    now: () => performance.now(),
    alive: () => handle.status === 'running',
    active: () => !loading && (driver.session.phase === 'running' || trialStepping()) && !frozen && !handle.hold,
    dtMs: () => 1000 * c.scene.dt,
    options: () => ({ fastForward: fastNow(), skip: skipping, budgetMs: feel.budgetMs }),
    idle: physicsIdle.wait,
    task,
    step: () => exclusive(async () => {
      // A load got in first, the shot (or world 0's test) ended, or it froze.
      if (loading || (driver.session.phase !== 'running' && !trialStepping()) || frozen) return null;
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
      stepTrial();
      hooks.stepped?.(fb, d);
      const input = perStep?.(d);
      if (input?.length) d.push(input);
      // Shots clicked during the step, and a line's timed shots now due, go in before the next (as playShots fires them).
      fireDue();
      spawned('bomb');
      if (red && feel.tailSkip && d.session.phase === 'running') tail.update(red.nMoving, c.meta.n, d.session.liveCollapse);
      uploadSnapshot(d);
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
