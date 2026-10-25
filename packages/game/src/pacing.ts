// How many physics steps to run this frame. Hit-stop, slow motion and
// fast-forward all go through here and only change *when* steps run, never
// what a step does, so juice can't change an outcome or a replay.

export const SLOWMO_SCALE = 0.3;
export const SLOWMO_IN = 0.12; // s to ramp down
export const SLOWMO_OUT = 0.3; // s to ramp back up
export const SLOWMO_MAX = 1.5; // s at most before ramping back on its own
export const FAST_SCALE = 4;

export interface PacerOptions {
  /** Hold Space: run the sim this many times faster (no slow motion). */
  fastForward?: boolean;
  /** Recent wall-clock ms per step; with budgetMs, slows time instead of stuttering. */
  stepMs?: number;
  budgetMs?: number;
}

export class Pacer {
  private acc = 0;
  private stopFrames = 0;
  /** Seconds since slow motion began, and since its release (null while holding). */
  private slow: { t: number; releasedAt: number | null } | null = null;
  timeScale = 1;

  /** Freeze the sim for the next `frames` frames (one per contact, the larger wins). */
  hitStop(frames: number) { this.stopFrames = Math.max(this.stopFrames, frames); }
  slowMo() { if (!this.slow) this.slow = { t: 0, releasedAt: null }; }
  release() { if (this.slow && this.slow.releasedAt === null) this.slow.releasedAt = this.slow.t; }
  get slowing() { return this.slow !== null; }
  /** True while a hit-stop holds: stop stepping for the rest of this frame too. */
  get frozen() { return this.stopFrames > 0; }
  reset() { this.acc = 0; this.stopFrames = 0; this.slow = null; this.timeScale = 1; }

  /** The slow-motion time scale `t` seconds in, released at `rel` (or not yet). */
  static curve(t: number, rel: number | null): number {
    const r = rel ?? (t >= SLOWMO_MAX ? SLOWMO_MAX : null);
    if (r !== null && t >= r) return Math.min(1, SLOWMO_SCALE + ((1 - SLOWMO_SCALE) * (t - r)) / SLOWMO_OUT);
    return t < SLOWMO_IN ? 1 - ((1 - SLOWMO_SCALE) * t) / SLOWMO_IN : SLOWMO_SCALE;
  }

  stepsThisFrame(frameMs: number, dt: number, o: PacerOptions = {}): number {
    const frame = Math.min(frameMs / 1000, 0.1);
    if (this.stopFrames > 0) { this.stopFrames--; return 0; }
    let scale = 1;
    if (this.slow) {
      this.slow.t += frame;
      scale = Pacer.curve(this.slow.t, this.slow.releasedAt);
      if (scale >= 1 && (this.slow.releasedAt !== null || this.slow.t >= SLOWMO_MAX)) this.slow = null;
    }
    if (o.fastForward) scale = FAST_SCALE;
    // Performance valve: if this frame's steps would cost more than the
    // budget, slow time down (to at most a quarter) instead of stuttering.
    if (o.stepMs && o.budgetMs && frame > 0) scale = Math.min(scale, Math.max(0.25, (o.budgetMs * dt) / (o.stepMs * frame)));
    this.timeScale = scale;
    this.acc += frame * scale;
    const cap = o.fastForward ? 8 : 2;
    let n = Math.floor(this.acc / dt + 1e-9);
    if (n > cap) { n = cap; this.acc = 0; } else this.acc -= n * dt;
    return n;
  }
}
