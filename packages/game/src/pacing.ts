// How many physics steps to run this frame. Hit-stop, slow motion and
// fast-forward all go through here and only change *when* steps run, never
// what a step does, so juice can't change an outcome or a replay.
import { LAUNCH_MODES, type LaunchMode } from './aim.ts';
import { type FrameMode, frameMode } from './frame-rate.ts';
import { BALL_STYLES, type BallStyle } from './scene.ts';
import { STEADY_D, STEADY_STEPS } from '@tb/keystone';
import { EFFECT_STYLES, type EffectStyle } from '@tb/render';

export const SLOWMO_SCALE = 0.3;
export const SLOWMO_IN = 0.12; // s to ramp down
export const SLOWMO_OUT = 0.3; // s to ramp back up
export const SLOWMO_MAX = 1.5; // s at most before ramping back on its own
export const FAST_SCALE = 4;
/**
 * The Skip control (K, or the HUD's Skip button) during a settle: sim time runs up to this many times real
 * time, past the valve (physics may take whole frames; the picture keeps drawing what arrives). Pacing only.
 */
export const SKIP_SCALE = 32;

/**
 * How the sim's pace may change, from the URL (both pages) and the viewer's scene file. Juice that
 * changes it on a collision is off unless asked for: `?keystone.hitstop=1` freezes a few frames on
 * the ammo's first contact, and `?keystone.slowmo=1` slows time while a crown falls fast. Load
 * changes it through the valve, on unless `?keystone.budget=0`, and the tail skip, on unless
 * `?keystone.tailskip=0`; which display frames are drawn (frame-rate.ts), `?keystone.frames=all|half|auto`. The camera
 * moves only when the player moves it unless asked (playtest feedback, 2026-11-02): `?keystone.follow=1` lets it follow
 * the collapse (follow.ts), and `?keystone.shake=1` shakes it and punches its field of view on hits (juice.ts). None of
 * them changes which steps run, so none is part of a level.
 */
export interface PaceFeel {
  hitStop: boolean;
  slowMo: boolean;
  /** The valve's physics budget, ms of step cost per 1/60 s (DEFAULT_BUDGET_MS); 0: no valve, physics runs as fast as it can up to real time. */
  budgetMs: number;
  /** Fast-forward the tail of a shot (TailSkip). */
  tailSkip: boolean;
  /** The camera follows the moving structure during a shot and eases back after (follow.ts). Off by default. */
  follow: boolean;
  /** The camera shakes and its field of view punches in on hits and blasts (juice.ts CameraJuice). Off by default. */
  shake: boolean;
  /** Which display frames are drawn (frame-rate.ts FrameGovernor): every one, half on a fast display, or half only while physics is behind. */
  frames: FrameMode;
  /**
   * Rapid fire: a shot may go in while the last is still running (it cuts that one: @tb/keystone
   * Session.fire). On by default (Will, 2026-11-05: waiting for things to settle felt too slow);
   * keystone.rapid=0 waits for each shot to settle, as before. A line's timed shots (Shot.after) play either way.
   */
  rapid: boolean;
  /**
   * A duel's turn view (duel-view.ts): when the turn passes, the camera swings to the middle of the next player's
   * side. On by default (Will, 2026-11-06), the one camera move the player does not make; keystone.turnview=0 (or
   * the door's Duel turns setting) leaves the camera where it is. Nothing outside a duel reads it.
   */
  turnView: boolean;
  /** A duel's arc on the ground: the player to fire's half of the launcher ring, dotted in their ink (keystone.arcs=0 hides it). */
  arcs: boolean;
  /**
   * A duel's hand-over card (PT5, agent playtest 1: no "pass the device" moment): when the turn passes, a band in
   * the next player's ink says whose turn it is, over the turn view's swing, until a tap. On by default;
   * keystone.handoff=0 (or the door's Hand-over setting) goes straight on with a banner, as before.
   */
  handoff: boolean;
  /**
   * Memory for instant undo, MB (keystone.undo): each shot keeps a checkpoint of the world as it went
   * in (play.ts, @tb/keystone Driver.checkpoint), the oldest dropped past this; an undo with no
   * checkpoint left replays the kept shots instead (docs/game/undo.md). 0: always replay.
   * About 85 MB a shot on a 10k level, under 1 MB on the small ones.
   */
  undoMB: number;
  /**
   * Where shots leave from (aim.ts LaunchMode): high over the structure's top (the default since Will's
   * 2026-11-06 playtest: shots from the level's own launcher ran into the rubble on the ground), or the
   * level's own launcher height (keystone.launch=level). A shot records its height, so this changes
   * only the shots aimed, never a replay.
   */
  launch: LaunchMode;
  /** How fired balls are drawn (scene.ts BallStyle): painted with a band (the default) or plain, the look's own (keystone.balls=plain). */
  balls: BallStyle;
  /**
   * Engraved stones (scene.ts structureMarks): a crosshair carved on every block to bring down, a shield on every
   * block to keep up (Will, 2026-11-06), so which is which reads without the colours. On by default; keystone.marks=0 off.
   */
  marks: boolean;
  /**
   * Undercut's pull drawn (pull-anim.ts, playtest PT17): the pulled block slides out toward the camera over a
   * quarter second and a dotted ghost of it stays a second where it stood. On by default; keystone.pullanim=0 off
   * (the block vanishes at the pull, with its dust puff).
   */
  pullAnim: boolean;
  /**
   * Bullet Time's frozen look (frozen-look.ts, playtest PT8): while a shot is frozen the scene is graded cold
   * and grey with a frosted blue edge, sparks hang and thin out, and a large label says what to do. On by default;
   * keystone.frozenlook=0 off (only the HUD's FROZEN tag says so).
   */
  frozenLook: boolean;
  /**
   * How impacts are drawn (@tb/render EffectStyle, PT2): 'damage' (the default since the agent playtest of
   * 2026-11-06) makes sparks, flashes and heat follow what a shot moved, so a shot that moves nothing gets a
   * puff, and draws felled crowns and cracked heritage in their colours rather than glowing white; 'classic'
   * (keystone.fx=classic) as before.
   */
  fx: EffectStyle;
  /** Spent ammo (PT19): a fired ball, ram or dud fades to a dull stone grey once its shot settles. On by default; keystone.spent=0 off. */
  spent: boolean;
}

/** keystone.fx: damage or classic (absent: damage). */
export function effectStyle(text: string | null): EffectStyle {
  if (text === null) return 'damage';
  if (!(EFFECT_STYLES as readonly string[]).includes(text)) throw new Error(`keystone.fx must be ${EFFECT_STYLES.join(' or ')}: ${text}`);
  return text as EffectStyle;
}

/** keystone.launch: high or level (absent: high). */
export function launchMode(text: string | null): LaunchMode {
  if (text === null) return 'high';
  if (!(LAUNCH_MODES as readonly string[]).includes(text)) throw new Error(`keystone.launch must be ${LAUNCH_MODES.join(' or ')}: ${text}`);
  return text as LaunchMode;
}

/** keystone.balls: painted or plain (absent: painted). */
export function ballStyle(text: string | null): BallStyle {
  if (text === null) return 'painted';
  if (!(BALL_STYLES as readonly string[]).includes(text)) throw new Error(`keystone.balls must be ${BALL_STYLES.join(' or ')}: ${text}`);
  return text as BallStyle;
}

/** The most keystone.undo takes, MB. */
export const MAX_UNDO_MB = 65536;
/** keystone.undo when the URL sets none: a dozen shots of a 10k level. */
export const DEFAULT_UNDO_MB = 1024;

/** The URL's keystone.hitstop, keystone.slowmo, keystone.tailskip, keystone.follow, keystone.shake, keystone.rapid, keystone.turnview, keystone.arcs, keystone.handoff, keystone.marks, keystone.pullanim, keystone.frozenlook (0 or 1 each), keystone.budget (ms, 0 to 1000), keystone.undo (MB, 0 to MAX_UNDO_MB), keystone.frames (all, half, auto), keystone.launch (high, level), keystone.balls (painted, plain), keystone.fx (damage, classic) and keystone.spent (0 or 1); any other value is refused. */
export function paceFeel(q: URLSearchParams): PaceFeel {
  const flag = (k: string, dflt: boolean) => {
    const v = q.get(k);
    if (v !== null && v !== '0' && v !== '1') throw new Error(`${k} must be 0 or 1: ${v}`);
    return v === null ? dflt : v === '1';
  };
  const b = q.get('keystone.budget'), budgetMs = b === null ? DEFAULT_BUDGET_MS : b.trim() === '' ? NaN : Number(b);
  if (!(budgetMs >= 0 && budgetMs <= 1000)) throw new Error(`keystone.budget must be from 0 to 1000 ms (0: no valve): ${b}`);
  const u = q.get('keystone.undo'), undoMB = u === null ? DEFAULT_UNDO_MB : u.trim() === '' ? NaN : Number(u);
  if (!(undoMB >= 0 && undoMB <= MAX_UNDO_MB)) throw new Error(`keystone.undo must be from 0 to ${MAX_UNDO_MB} MB (0: undo replays the shots): ${u}`);
  return { hitStop: flag('keystone.hitstop', false), slowMo: flag('keystone.slowmo', false), budgetMs, tailSkip: flag('keystone.tailskip', true), follow: flag('keystone.follow', false), shake: flag('keystone.shake', false), frames: frameMode(q.get('keystone.frames')), rapid: flag('keystone.rapid', true), turnView: flag('keystone.turnview', true), arcs: flag('keystone.arcs', true), handoff: flag('keystone.handoff', true), undoMB, launch: launchMode(q.get('keystone.launch')), balls: ballStyle(q.get('keystone.balls')), marks: flag('keystone.marks', true), fx: effectStyle(q.get('keystone.fx')), spent: flag('keystone.spent', true), pullAnim: flag('keystone.pullanim', true), frozenLook: flag('keystone.frozenlook', true) };
}

/** Throws unless f's budget is a number of ms from 0 to 1000 (the Scene panel's field can hold anything). */
export function checkPaceFeel(f: PaceFeel): PaceFeel {
  if (!(f.budgetMs >= 0 && f.budgetMs <= 1000)) throw new Error(`physics budget must be from 0 to 1000 ms (0: no valve): ${f.budgetMs}`);
  if (!(f.undoMB >= 0 && f.undoMB <= MAX_UNDO_MB)) throw new Error(`undo memory must be from 0 to ${MAX_UNDO_MB} MB (0: undo replays the shots): ${f.undoMB}`);
  frameMode(f.frames);
  launchMode(f.launch);
  ballStyle(f.balls);
  effectStyle(f.fx);
  return f;
}

/** The URL keys for f that differ from DEFAULT_FEEL, as paceFeel reads them back. */
export function writePaceFeel(f: PaceFeel, q: URLSearchParams): void {
  if (f.hitStop) q.set('keystone.hitstop', '1');
  if (f.slowMo) q.set('keystone.slowmo', '1');
  if (f.budgetMs !== DEFAULT_FEEL.budgetMs) q.set('keystone.budget', String(f.budgetMs));
  if (!f.tailSkip) q.set('keystone.tailskip', '0');
  if (f.follow) q.set('keystone.follow', '1');
  if (f.shake) q.set('keystone.shake', '1');
  if (f.frames !== DEFAULT_FEEL.frames) q.set('keystone.frames', f.frames);
  if (!f.rapid) q.set('keystone.rapid', '0');
  if (!f.turnView) q.set('keystone.turnview', '0');
  if (!f.arcs) q.set('keystone.arcs', '0');
  if (!f.handoff) q.set('keystone.handoff', '0');
  if (f.undoMB !== DEFAULT_FEEL.undoMB) q.set('keystone.undo', String(f.undoMB));
  if (f.launch !== DEFAULT_FEEL.launch) q.set('keystone.launch', f.launch);
  if (f.balls !== DEFAULT_FEEL.balls) q.set('keystone.balls', f.balls);
  if (!f.marks) q.set('keystone.marks', '0');
  if (f.fx !== DEFAULT_FEEL.fx) q.set('keystone.fx', f.fx);
  if (!f.spent) q.set('keystone.spent', '0');
  if (!f.pullAnim) q.set('keystone.pullanim', '0');
  if (!f.frozenLook) q.set('keystone.frozenlook', '0');
}

/** Hit-stop is counted in frames of 60 Hz, whatever the display's rate. */
export const FRAME_MS = 1000 / 60;
/** The valve never slows time below this (spectacle-mode.md, section 9). */
export const VALVE_MIN = 0.25;
/**
 * Physics budget (ms of step cost per 1/60 s of sim time) when a level or URL sets none. Over it, time
 * slows, and the HUD says so. URL key keystone.budget; 0 turns the valve off. 14 ms, not a whole 60 Hz
 * step (16.7): a budget of a whole step lets physics fill the GPU queue whenever it is behind, and the
 * frames then wait behind steps. E7 on the M5 Max at 120 Hz (a406519, 10k cluster blasts, steps of about
 * 24 ms; docs/pipelining.md): frame p95/p99 9.8/11.6 ms at 14 against 17.6/21.9 at 16.7 (and the same
 * at off), for a sim at 0.64x against 0.68x real time. G4.4 had chosen 16.7 on a 60 Hz run, where the
 * frames looked the same at both.
 */
export const DEFAULT_BUDGET_MS = 14;
/** No juice, the valve at its default budget, the tail skip on, a camera only the player moves, every frame drawn, rapid fire, the duel's hand-over card, instant undo in DEFAULT_UNDO_MB, shots from high, painted balls, engraved stones, impacts that follow the damage, spent ammo faded, pulls drawn, Bullet Time's frozen look. */
export const DEFAULT_FEEL: Readonly<PaceFeel> = { hitStop: false, slowMo: false, budgetMs: DEFAULT_BUDGET_MS, tailSkip: true, follow: false, shake: false, frames: 'all', rapid: true, turnView: true, arcs: true, handoff: true, undoMB: DEFAULT_UNDO_MB, launch: 'high', balls: 'painted', marks: true, fx: 'damage', spent: true, pullAnim: true, frozenLook: true };
/**
 * Owed time the clock keeps, ms; beyond it the rest is dropped (slow motion, not a burst of catch-up
 * steps after a stall). As the viewer's free loop (loop.ts FREE_MAX_LAG_MS).
 */
export const MAX_LAG_MS = 50;
/** A step this fraction of its interval early still counts as due, so a frame that wakes slightly early does not skip it. */
export const PACE_SLACK = 0.25;

/**
 * The valve: how fast sim time may run when a step costs `stepMs` and physics may spend `budgetMs`
 * per 1/60 s: budget / step, clamped to [VALVE_MIN, max] (max 1 at normal speed, FAST_SCALE while
 * fast-forwarding). No budget or no measured step: max.
 */
export function valve(budgetMs: number, stepMs: number, max = 1): number {
  if (!(budgetMs > 0) || !(stepMs > 0)) return max;
  return Math.min(max, Math.max(VALVE_MIN, budgetMs / stepMs));
}

/**
 * A step's cost on an engine that submits and returns (the GPU's finish()): from when the step could
 * start, the later of its submit and the step before's done, to its own done. A step queued behind a
 * running one reads its own GPU time, not the wait (the viewer's runFree times its steps the same way).
 */
export const stepCost = (submitted: number, done: number, lastDone: number): number => done - (lastDone > submitted ? lastDone : submitted);

export interface PacerOptions {
  /** Hold Space (or the round is over, or the tail skip): run the sim up to FAST_SCALE times faster (no slow motion). */
  fastForward?: boolean;
  /** Skip (agent playtest PT6): up to SKIP_SCALE, the valve's budget ignored. */
  skip?: boolean;
  /** Recent cost of a step, ms (a median); with budgetMs, slows time instead of stuttering. */
  stepMs?: number;
  budgetMs?: number;
}

/**
 * When the next physics step is due, in wall time. The game's physics runs in a loop of its own,
 * apart from the frames (play.ts): it asks due(now) and, when true, runs one step and calls
 * stepped(). Hit-stop, slow motion, fast-forward and the valve set the time scale, so they only
 * change when steps run, never what a step does: juice and load can't change an outcome or a replay.
 */
export class Pacer {
  /** Wall ms the next step is due; NaN before the first. */
  private next = NaN;
  /** Wall ms of the last due(): slow motion runs on real time. */
  private last = NaN;
  /** Hit-stop asked for and not applied yet, ms. */
  private stopMs = 0;
  /** Seconds since slow motion began, and since its release (null while holding). */
  private slow: { t: number; releasedAt: number | null } | null = null;
  timeScale = 1;
  /** The step cost (ms) the last due() read for the valve: what timeScale was set from (NaN before one). */
  costMs = NaN;

  /** Freeze the sim for `frames` 60 Hz frames from the next due() (one per contact, the larger wins). */
  hitStop(frames: number) { this.stopMs = Math.max(this.stopMs, frames * FRAME_MS); }
  slowMo() { if (!this.slow) this.slow = { t: 0, releasedAt: null }; }
  release() { if (this.slow && this.slow.releasedAt === null) this.slow.releasedAt = this.slow.t; }
  get slowing() { return this.slow !== null; }
  reset() { this.next = NaN; this.last = NaN; this.stopMs = 0; this.slow = null; this.timeScale = 1; this.costMs = NaN; }
  /** Restart the clock (a shot starts, the loop was idle): the next due() is at once, with nothing owed. */
  restart() { this.next = NaN; this.last = NaN; }

  /** The slow-motion time scale `t` seconds in, released at `rel` (or not yet). */
  static curve(t: number, rel: number | null): number {
    const r = rel ?? (t >= SLOWMO_MAX ? SLOWMO_MAX : null);
    if (r !== null && t >= r) return Math.min(1, SLOWMO_SCALE + ((1 - SLOWMO_SCALE) * (t - r)) / SLOWMO_OUT);
    return t < SLOWMO_IN ? 1 - ((1 - SLOWMO_SCALE) * t) / SLOWMO_IN : SLOWMO_SCALE;
  }

  /** Whether a step is due at wall time `now` (ms) for steps of dtMs; sets timeScale. Drops owed time beyond MAX_LAG_MS. */
  due(now: number, dtMs: number, o: PacerOptions = {}): boolean {
    const elapsed = Number.isNaN(this.last) ? 0 : Math.min(Math.max(0, now - this.last), 100);
    this.last = now;
    let scale = 1;
    if (this.slow) {
      this.slow.t += elapsed / 1000;
      scale = Pacer.curve(this.slow.t, this.slow.releasedAt);
      if (scale >= 1 && (this.slow.releasedAt !== null || this.slow.t >= SLOWMO_MAX)) this.slow = null;
    }
    const max = o.fastForward ? FAST_SCALE : 1;
    if (o.fastForward) scale = FAST_SCALE;
    // Performance valve: when steps cost more than the budget, slow time down (to at most a quarter) instead of stuttering.
    this.costMs = o.stepMs ?? NaN;
    this.timeScale = o.skip ? SKIP_SCALE : Math.min(scale, valve(o.budgetMs ?? 0, o.stepMs ?? 0, max));
    if (Number.isNaN(this.next)) this.next = now;
    if (this.stopMs > 0) { this.next = Math.max(this.next, now) + this.stopMs; this.stopMs = 0; }
    if (now < this.next - (PACE_SLACK * dtMs) / this.timeScale) return false;
    if (now - this.next > MAX_LAG_MS) this.next = now - MAX_LAG_MS;
    return true;
  }

  /** A step was taken: the next is due one step of sim time later at the current time scale. */
  stepped(dtMs: number) { this.next += dtMs / this.timeScale; }

  /** Wall ms from `now` until the next step is due (0 when due or before the first). */
  wait(now: number): number { return Number.isNaN(this.next) ? 0 : Math.max(0, this.next - now); }
}

/** Seconds of real time the sim speed reading averages over (as the viewer's SIM_SPEED_TAU). */
export const SPEED_TAU = 0.5;

/**
 * Sim speed as shown: sim time per real time over the last SPEED_TAU or so (exponentially weighted),
 * from the steps as they complete. It reads what happened, not what the valve asked for, so the HUD's
 * slow-motion tag never claims a speed the engine did not reach.
 */
export class SpeedMeter {
  private sim = SPEED_TAU;
  private real = SPEED_TAU;
  private t = NaN;
  private advance(now: number) {
    if (Number.isNaN(this.t)) { this.t = now; return; }
    const d = Math.max(0, now - this.t) / 1000, keep = Math.exp(-d / SPEED_TAU);
    this.sim *= keep;
    this.real = keep * this.real + SPEED_TAU * (1 - keep);
    this.t = now;
  }
  /** A step of dt seconds completed at wall time now (ms). */
  step(now: number, dt: number) { this.advance(now); this.sim += dt; }
  /** Sim seconds per real second at now. */
  speed(now: number): number { this.advance(now); return this.sim / this.real; }
  /** As if the sim had always run at real time (a new shot). */
  reset() { this.sim = SPEED_TAU; this.real = SPEED_TAU; this.t = NaN; }
}

/** Shown as slow motion below this sim speed (the "80% speed" HUD tag); above, real time. */
export const SLOW_TAG_BELOW = 0.95;
/** The HUD's slow-motion tag for a sim speed ("84% speed": never a bare ×0.84, which read as leverage, PT9), or '' at real time or faster. */
export const slowTag = (speed: number): string => (speed < SLOW_TAG_BELOW ? `${Math.round(100 * speed)}% speed` : '');

/** Tail skip (spectacle-mode.md, section 9): fast-forward once fewer than this fraction of the structure moves... */
export const TAIL_MOVING = 0.01;
/** ...and the collapse fraction D has gained under this over the last TAIL_STEPS steps. */
export const TAIL_GAIN = 0.001;
export const TAIL_STEPS = 60;

/**
 * Decides, step by step through one shot, when the rest of it is a tail that can run at fast-forward
 * until it settles: a few rocking blocks (under TAIL_MOVING of the structure, D gaining under TAIL_GAIN
 * over TAIL_STEPS), or (agent playtest PT6) a collapse that has stopped changing whatever still moves,
 * D within @tb/keystone's STEADY_D for STEADY_STEPS (2 s), as settle v4 reads it: debris rolling on a
 * big level held the picture still for 10 s and more. Once on it stays on until reset (the next shot).
 * Pacing only: the same steps run, sooner.
 */
export class TailSkip {
  private d: number[] = [];
  /** Settle v4's steady run, as rules.ts settleUpdate counts it: its first D and its length. */
  private steadyD = NaN;
  private steadyRun = 0;
  on = false;
  reset() { this.d = []; this.on = false; this.steadyD = NaN; this.steadyRun = 0; }
  /** One observed step of the shot: structure bodies moving, structure size, collapse fraction now. */
  update(nMoving: number, n: number, collapse: number): boolean {
    this.d.push(collapse);
    if (this.d.length > TAIL_STEPS + 1) this.d.shift();
    if (Number.isNaN(this.steadyD) || !(Math.abs(collapse - this.steadyD) < STEADY_D)) { this.steadyD = collapse; this.steadyRun = 0; }
    this.steadyRun++;
    if (!this.on && this.d.length > TAIL_STEPS && nMoving < TAIL_MOVING * n && collapse - this.d[0]! < TAIL_GAIN) this.on = true;
    if (!this.on && this.steadyRun >= STEADY_STEPS) this.on = true;
    return this.on;
  }
}

/** When renderer interpolation needs it: the newest snapshot's arrival, and the usual time between them. */
export { alphaAt, arrived, type Arrivals, newArrivals } from './arrivals.ts';
