// How many physics steps to run this frame. Hit-stop, slow motion and
// fast-forward all go through here and only change *when* steps run, never
// what a step does, so juice can't change an outcome or a replay.
import { type FrameMode, frameMode } from './frame-rate.ts';

export const SLOWMO_SCALE = 0.3;
export const SLOWMO_IN = 0.12; // s to ramp down
export const SLOWMO_OUT = 0.3; // s to ramp back up
export const SLOWMO_MAX = 1.5; // s at most before ramping back on its own
export const FAST_SCALE = 4;

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
}

/** The URL's keystone.hitstop, keystone.slowmo, keystone.tailskip, keystone.follow, keystone.shake (0 or 1 each), keystone.budget (ms, 0 to 1000) and keystone.frames (all, half, auto); any other value is refused. */
export function paceFeel(q: URLSearchParams): PaceFeel {
  const flag = (k: string, dflt: boolean) => {
    const v = q.get(k);
    if (v !== null && v !== '0' && v !== '1') throw new Error(`${k} must be 0 or 1: ${v}`);
    return v === null ? dflt : v === '1';
  };
  const b = q.get('keystone.budget'), budgetMs = b === null ? DEFAULT_BUDGET_MS : b.trim() === '' ? NaN : Number(b);
  if (!(budgetMs >= 0 && budgetMs <= 1000)) throw new Error(`keystone.budget must be from 0 to 1000 ms (0: no valve): ${b}`);
  return { hitStop: flag('keystone.hitstop', false), slowMo: flag('keystone.slowmo', false), budgetMs, tailSkip: flag('keystone.tailskip', true), follow: flag('keystone.follow', false), shake: flag('keystone.shake', false), frames: frameMode(q.get('keystone.frames')) };
}

/** Throws unless f's budget is a number of ms from 0 to 1000 (the Scene panel's field can hold anything). */
export function checkPaceFeel(f: PaceFeel): PaceFeel {
  if (!(f.budgetMs >= 0 && f.budgetMs <= 1000)) throw new Error(`physics budget must be from 0 to 1000 ms (0: no valve): ${f.budgetMs}`);
  frameMode(f.frames);
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
}

/** Hit-stop is counted in frames of 60 Hz, whatever the display's rate. */
export const FRAME_MS = 1000 / 60;
/** The valve never slows time below this (spectacle-mode.md, section 9). */
export const VALVE_MIN = 0.25;
/**
 * Physics budget (ms of step cost per 1/60 s of sim time) when a level or URL sets none: a whole 60 Hz
 * step, so time slows only as far as the GPU must, and the HUD says so. Over it, time slows. URL key
 * keystone.budget; 0 turns the valve off. G4.4 on the M5 Max (10k, a cluster blast, steps of about
 * 19 ms): frames were the same at 14 ms, 16.7 ms and off (p99 18.6 ms), while 14 ms held the sim at
 * 0.70x real time against 0.82x, so no budget is held back for the frames (spectacle-mode.md, G4.4).
 */
export const DEFAULT_BUDGET_MS = 16.7;
/** No juice, the valve at its default budget, the tail skip on, a camera only the player moves, every frame drawn. */
export const DEFAULT_FEEL: Readonly<PaceFeel> = { hitStop: false, slowMo: false, budgetMs: DEFAULT_BUDGET_MS, tailSkip: true, follow: false, shake: false, frames: 'all' };
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

  /** Freeze the sim for `frames` 60 Hz frames from the next due() (one per contact, the larger wins). */
  hitStop(frames: number) { this.stopMs = Math.max(this.stopMs, frames * FRAME_MS); }
  slowMo() { if (!this.slow) this.slow = { t: 0, releasedAt: null }; }
  release() { if (this.slow && this.slow.releasedAt === null) this.slow.releasedAt = this.slow.t; }
  get slowing() { return this.slow !== null; }
  reset() { this.next = NaN; this.last = NaN; this.stopMs = 0; this.slow = null; this.timeScale = 1; }
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
    this.timeScale = Math.min(scale, valve(o.budgetMs ?? 0, o.stepMs ?? 0, max));
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

/** Shown as slow motion below this sim speed (the "x0.8" HUD tag); above, real time. */
export const SLOW_TAG_BELOW = 0.95;
/** The HUD's slow-motion tag for a sim speed, or '' at real time or faster. */
export const slowTag = (speed: number): string => (speed < SLOW_TAG_BELOW ? `\u00d7${speed.toFixed(2).replace(/0$/, '')}` : '');

/** Tail skip (spectacle-mode.md, section 9): fast-forward once fewer than this fraction of the structure moves... */
export const TAIL_MOVING = 0.01;
/** ...and the collapse fraction D has gained under this over the last TAIL_STEPS steps. */
export const TAIL_GAIN = 0.001;
export const TAIL_STEPS = 60;

/**
 * Decides, step by step through one shot, when the rest of it is a tail of a few rocking blocks that
 * can run at fast-forward until it settles. Once on it stays on until reset (the next shot). Pacing
 * only: the same steps run, sooner.
 */
export class TailSkip {
  private d: number[] = [];
  on = false;
  reset() { this.d = []; this.on = false; }
  /** One observed step of the shot: structure bodies moving, structure size, collapse fraction now. */
  update(nMoving: number, n: number, collapse: number): boolean {
    this.d.push(collapse);
    if (this.d.length > TAIL_STEPS + 1) this.d.shift();
    if (!this.on && this.d.length > TAIL_STEPS && nMoving < TAIL_MOVING * n && collapse - this.d[0]! < TAIL_GAIN) this.on = true;
    return this.on;
  }
}

/** When renderer interpolation needs it: the newest snapshot's arrival, and the usual time between them. */
export { alphaAt, arrived, type Arrivals, newArrivals } from './arrivals.ts';
