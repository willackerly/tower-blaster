// Which display frames to draw. Physics and frames share one GPU queue: on
// the M5 at 10k cubes a render frame costs about 2-3 ms of GPU, so 120 frames
// a second take a quarter or more of the GPU while a collapse needs all of it
// for physics. Frames are interpolated between physics states (arrivals.ts),
// so 60 drawn frames a second still move smoothly. On the M5 at 120 Hz (E7
// A/B, a406519, docs/pipelining.md) drawing fewer frames through a 10k
// cluster collapse raised the sim from 0.68x to 0.78-0.81x real time and cut
// the shot's wall time by 13-15%.
//
// While decimating, FrameGovernor draws a display frame once TARGET_MS
// (1/60 s) has passed since the last drawn one, less half a display interval
// of slack, which picks the whole fraction of the display rate nearest 60:
// 120 Hz -> 60, 144 -> 72, 165 -> 55, 240 -> 60. A display under DECIMATE_HZ
// (60-100 Hz) is never decimated. It decides by elapsed time, not by counting
// frames: the first version counted frames against an estimate of the
// display's rate, the estimate collapsed when rAF ticks came unevenly, and
// it drew 30 frames a second instead of 60 (the same A/B).
// - 'all': every frame (the default).
// - 'half': decimated always.
// - 'auto': decimated only while physics is behind real time, and back to
//   every frame as soon as physics stops (a shot ends: aiming wants every
//   frame) or after it has had headroom for HOLD_MS.
// It changes which frames are drawn, never which steps run.

export type FrameMode = 'all' | 'half' | 'auto';
export const FRAME_MODES: readonly FrameMode[] = ['all', 'half', 'auto'];

/** While decimating, a frame is drawn once this long (1/60 s) has passed since the last one drawn, less half a display interval. */
export const TARGET_MS = 1000 / 60;
/** Only a display at least this fast is decimated: at 60-100 Hz every frame is drawn. */
export const DECIMATE_HZ = 110;
/** rAF intervals the display's rate is the median of. */
export const INTERVAL_WINDOW = 31;
/** Intervals needed before the median is trusted: until then every frame is drawn (the first rAF ticks after load come unevenly). */
export const MIN_INTERVALS = 8;
/** Headroom must last this long before 'auto' draws every frame again, so it does not flip at each step. */
export const HOLD_MS = 1000;
/**
 * 'auto' has headroom when the median step cost is under this share of a step's real time: drawing
 * every frame again, which on the M5 Max at 10k adds about a frame's GPU time (2-3 ms) to each of
 * two steps' worth of frames, still fits.
 */
export const CLEAR_SHARE = 0.6;

/** What 'auto' reads each frame. */
export interface PhysicsLoad {
  /** No shot is running: physics is idle, nothing competes with the frames. */
  idle: boolean;
  /** Physics runs slower than real time (the sim speed under 0.95, the HUD's slow-motion tag). */
  behind: boolean;
  /** Physics has headroom: steps cost well under their budget, so drawing every frame again would not slow it. */
  clear: boolean;
}

/** The median of xs (NaN when empty). */
function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

export class FrameGovernor {
  /** The display's frame interval (ms): the median of the last INTERVAL_WINDOW rAF intervals (NaN before the second frame). */
  interval = NaN;
  /** Whether decimation is on now: the mode wants it and the display is at least DECIMATE_HZ. */
  decimating = false;
  /** Frames drawn, and display frames skipped, since construction. */
  drawn = 0;
  skipped = 0;
  private last = NaN;
  private lastDrawn = NaN;
  private intervals: number[] = [];
  private wanted = false;
  private clearSince = NaN;

  constructor(public mode: FrameMode = 'all') {}

  /**
   * Called once per display frame at `now` (ms): whether to draw it. `force` (a capture is waiting)
   * always draws. `load` is read in 'auto' mode only.
   */
  frame(now: number, load: PhysicsLoad, force = false): boolean {
    if (!Number.isNaN(this.last)) {
      const dt = now - this.last;
      // A long gap (a hidden tab, a stall) says nothing about the display's rate.
      if (dt > 0 && dt < 100) {
        this.intervals.push(dt);
        if (this.intervals.length > INTERVAL_WINDOW) this.intervals.shift();
        this.interval = median(this.intervals);
      }
    }
    this.last = now;
    this.wanted = this.wants(now, load);
    this.decimating = this.wanted && this.intervals.length >= MIN_INTERVALS && this.interval < 1000 / DECIMATE_HZ;
    const due = !this.decimating || Number.isNaN(this.lastDrawn) || now - this.lastDrawn >= TARGET_MS - this.interval / 2;
    if (force || due) {
      this.lastDrawn = now;
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
    if (!this.wanted) return false;
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
