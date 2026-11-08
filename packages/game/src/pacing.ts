// How many physics steps to run this frame. Hit-stop, slow motion and
// fast-forward all go through here and only change *when* steps run, never
// what a step does, so juice can't change an outcome or a replay.
import { STEADY_D, STEADY_STEPS } from '@tb/keystone';
import { FEEL_OPTIONS, type PaceFeel } from './options/registry.ts';

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
 * How the sim's pace may change, and how the game feels, from the URL (both pages) and the viewer's scene
 * file: one field per option in ./options (O4, docs/design/options.md), each module saying what its field
 * does, its keystone.* key and its default. Juice that changes the pace on a collision is off unless asked
 * for (keystone.hitstop, keystone.slowmo); load changes it through the valve (keystone.budget) and the tail
 * skip (keystone.tailskip); which display frames are drawn is keystone.frames; the camera moves only when the
 * player moves it unless asked (keystone.follow, keystone.shake). None of them changes which steps run, so
 * none is part of a level.
 */
export type { PaceFeel } from './options/registry.ts';
export { ballStyle } from './options/balls.ts';
export { DEFAULT_BUDGET_MS } from './options/budget.ts';
export { effectStyle } from './options/fx.ts';
export { launchMode } from './options/launch.ts';
export { OPENING_VIEWS, type OpeningView, openingView } from './options/openview.ts';
export { sunMode } from './options/sun.ts';
export { DEFAULT_UNDO_MB, MAX_UNDO_MB } from './options/undo.ts';
export { XRAY_MODES, type XrayMode, xrayMode } from './options/xray.ts';

/** Every feel option's URL key (0 or 1 for a flag, keystone.budget ms 0 to 1000, keystone.undo MB 0 to MAX_UNDO_MB, the named choices for the others); any other value is refused, naming the key. */
export function paceFeel(q: URLSearchParams): PaceFeel {
  const out: Record<string, unknown> = {};
  for (const o of FEEL_OPTIONS) {
    const v = q.get(o.url);
    out[o.field] = v === null ? o.default : o.parse(v);
  }
  return out as PaceFeel;
}

/** Throws unless every field of f is a value its option takes (the Scene panel's fields can hold anything). */
export function checkPaceFeel(f: PaceFeel): PaceFeel {
  for (const o of FEEL_OPTIONS) o.check?.((f as Record<string, unknown>)[o.field]);
  return f;
}

/** The URL keys for f that differ from DEFAULT_FEEL, as paceFeel reads them back. */
export function writePaceFeel(f: PaceFeel, q: URLSearchParams): void {
  for (const o of FEEL_OPTIONS) {
    const v = (f as Record<string, unknown>)[o.field];
    if (v !== o.default) q.set(o.url, o.write(v));
  }
}

/** Hit-stop is counted in frames of 60 Hz, whatever the display's rate. */
export const FRAME_MS = 1000 / 60;
/** The valve never slows time below this (spectacle-mode.md, section 9). */
export const VALVE_MIN = 0.25;
/** Every feel option's default: no juice, the valve at its default budget, the tail skip on, a camera only the player moves, every frame drawn, rapid fire, the duel's hand-over card, instant undo in DEFAULT_UNDO_MB, shots from high, painted balls, engraved stones, impacts that follow the damage, spent ammo faded, pulls drawn, Bullet Time's frozen look. */
export const DEFAULT_FEEL: Readonly<PaceFeel> = Object.fromEntries(FEEL_OPTIONS.map((o) => [o.field, o.default])) as PaceFeel;
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
    // A gap longer than SPEED_STALL_MS between readings is the page not running (no frame drew), not slow motion.
    const d = Math.min(Math.max(0, now - this.t), SPEED_STALL_MS) / 1000, keep = Math.exp(-d / SPEED_TAU);
    this.sim *= keep;
    this.real = keep * this.real + SPEED_TAU * (1 - keep);
    this.t = now;
  }
  /** A step of dt seconds completed at wall time now (ms). */
  step(now: number, dt: number) { this.advance(now); this.sim += dt; }
  /** Sim seconds per real second at now. */
  speed(now: number): number { this.advance(now); return this.sim / this.real; }
  /**
   * Time passes uncounted up to now: physics is held on purpose (Bullet Time's freeze, a test's or capture's hold),
   * which is not slow motion. Without it a held shot read "0% speed" (PT2 Metal review, 2026-11-08: the agent
   * playtest captures frames while holding the shot), and the frame pacer took the page to be behind.
   */
  idle(now: number) { this.t = now; }
  /** As if the sim had always run at real time (a new shot). */
  reset() { this.sim = SPEED_TAU; this.real = SPEED_TAU; this.t = NaN; }
}

/**
 * The longest gap between two readings the meter counts, ms: longer is a stall (a hidden tab, a long GC, a page
 * capture), counted as this long. Frames read the meter each frame, so a slow sim that still draws is never clamped.
 */
export const SPEED_STALL_MS = 250;

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
