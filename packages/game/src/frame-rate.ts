// Which display frames to draw. Physics and frames share one GPU queue: on
// the M5 at 10k cubes a render frame costs about 2-3 ms of GPU, so 120 frames
// a second take a quarter or more of the GPU while a collapse needs all of it
// for physics (G4 probe: steps of about 19 ms, sim at 0.64-0.82x). Frames are
// interpolated between physics states (arrivals.ts), so 60 drawn frames a
// second still move smoothly. FrameGovernor decimates the display rate by a
// whole factor that keeps at least MIN_DRAWN_HZ drawn frames a second
// (120 Hz -> 60, 144 -> 72, 240 -> 60; 60 to 100 Hz are never decimated):
// - 'all': every frame (the default until the M5 A/B, docs/pipelining.md).
// - 'half': decimated always (the A/B's other arm).
// - 'auto': decimated only while physics is behind real time, and back to
//   every frame as soon as physics stops (a shot ends: aiming wants every
//   frame) or after it has had headroom for HOLD_MS.
// It changes which frames are drawn, never which steps run.

export type FrameMode = 'all' | 'half' | 'auto';
export const FRAME_MODES: readonly FrameMode[] = ['all', 'half', 'auto'];

/** Drawn frames a second the governor never goes below: a display under twice this (110 Hz) is never decimated. */
export const MIN_DRAWN_HZ = 55;
/** Headroom must last this long before 'auto' draws every frame again, so it does not flip at each step. */
export const HOLD_MS = 1000;
/**
 * 'auto' has headroom when the median step cost is under this share of a step's real time: drawing
 * every frame again, which on the M5 Max at 10k adds about a frame's GPU time (2-3 ms) to each of
 * two steps' worth of frames, still fits.
 */
export const CLEAR_SHARE = 0.6;
/** An rAF interval over this many times the estimate is a missed frame, not the display's rate. */
export const MISSED = 1.5;
/** Decimation never skips more than this many frames in a row, whatever the display's rate. */
export const MAX_FACTOR = 4;

/** What 'auto' reads each frame. */
export interface PhysicsLoad {
  /** No shot is running: physics is idle, nothing competes with the frames. */
  idle: boolean;
  /** Physics runs slower than real time (the sim speed under 0.95, the HUD's slow-motion tag). */
  behind: boolean;
  /** Physics has headroom: steps cost well under their budget, so drawing every frame again would not slow it. */
  clear: boolean;
}

/** The whole decimation factor for a display frame interval (ms): the most that keeps MIN_DRAWN_HZ, at least 1. */
export function factorFor(intervalMs: number): number {
  if (!(intervalMs > 0)) return 1;
  const k = Math.floor(1000 / MIN_DRAWN_HZ / intervalMs);
  return Math.min(MAX_FACTOR, Math.max(1, k));
}

export class FrameGovernor {
  /** Display frame interval (ms): an EMA over rAF intervals, leaving out missed frames (over MISSED x the estimate). */
  interval = NaN;
  /** Whether frames are being decimated now. */
  decimating = false;
  /** Frames drawn, and display frames skipped, since construction. */
  drawn = 0;
  skipped = 0;
  private last = NaN;
  private sinceDraw = 0;
  private clearSince = NaN;

  constructor(public mode: FrameMode = 'all') {}

  /**
   * Called once per display frame at `now` (ms): whether to draw it. `force` (a capture is waiting)
   * always draws. `load` is read in 'auto' mode only.
   */
  frame(now: number, load: PhysicsLoad, force = false): boolean {
    if (!Number.isNaN(this.last)) {
      const dt = now - this.last;
      // A long gap (a hidden tab, a stall) or a missed frame says nothing about the display's rate.
      if (dt > 0 && dt < 100 && !(dt > MISSED * this.interval)) this.interval = Number.isNaN(this.interval) ? dt : 0.9 * this.interval + 0.1 * dt;
    }
    this.last = now;
    this.decimating = this.wants(now, load);
    const k = this.decimating ? factorFor(this.interval) : 1;
    this.sinceDraw++;
    if (force || this.sinceDraw >= k) {
      this.sinceDraw = 0;
      this.drawn++;
      return true;
    }
    this.skipped++;
    return false;
  }

  private wants(now: number, load: PhysicsLoad): boolean {
    if (this.mode === 'all') return false;
    if (this.mode === 'half') return true;
    if (load.idle) { this.clearSince = NaN; return false; }
    if (load.behind) { this.clearSince = NaN; return true; }
    if (!this.decimating) return false;
    if (!load.clear) { this.clearSince = NaN; return true; }
    if (Number.isNaN(this.clearSince)) this.clearSince = now;
    return now - this.clearSince < HOLD_MS;
  }
}

/** The URL's keystone.frames: all (default), half or auto; anything else is refused. */
export function frameMode(v: string | null): FrameMode {
  if (v === null) return 'all';
  if (!(FRAME_MODES as readonly string[]).includes(v)) throw new Error(`keystone.frames must be one of ${FRAME_MODES.join(', ')}: ${v}`);
  return v as FrameMode;
}
