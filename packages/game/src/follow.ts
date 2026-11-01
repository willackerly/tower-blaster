// The collapse-front camera (spectacle-mode.md, section 9; roadmap G4.3).
// While a shot runs it moves the player's orbit (target and distance; never
// yaw, pitch or field of view, which stay the player's) toward a frame of the
// moving structure bodies (Reductions.movingBox, padded), with a critically
// damped spring, so a collapse that spreads stays in view. The box only grows
// during a shot (every box seen since fire, together), so the camera never
// dives in on the last few stragglers of a 10k collapse; once the shot has
// settled it eases back to where the player had the camera when they fired.
// Any orbit, pan or zoom by the player during the shot ends it for that shot,
// leaving the camera where it is. Render-only: nothing here reaches the physics.
import { frame, type Orbit } from '@tb/render/camera';

/** Spring rate, 1/s: a critically damped spring at this rate is within 1% of its goal 2.3 s after a jump. */
export const FOLLOW_RATE = 3;
/** The moving box is grown by this fraction of its size on each side before framing (the spec's 20%). */
export const FOLLOW_PAD = 0.2;
/** The frame is at least this many cube edges across, so a handful of stragglers does not zoom in on them. */
export const FOLLOW_MIN_SIZE = 8;
/** Follow only while at least this many structure bodies move. */
export const FOLLOW_MIN_MOVING = 8;
/** The follow distance stays within these multiples of the distance the shot was fired from. */
export const FOLLOW_NEAR = 0.6;
export const FOLLOW_FAR = 1.6;

type V3 = [number, number, number];
const DEG = 180 / Math.PI;

/** One step of a critically damped spring at rate w toward goal g over dt seconds (exact, so any dt is stable). */
export function spring(x: number, v: number, g: number, w: number, dt: number): [number, number] {
  const a = x - g, b = v + w * a, e = Math.exp(-w * dt);
  return [g + (a + b * dt) * e, (b - w * (a + b * dt)) * e];
}

/**
 * Where the follow camera heads for a moving box ([min x, y, z, max x, y, z], m) seen at o's yaw,
 * pitch and field of view: the box grown by FOLLOW_PAD of its size (at least FOLLOW_MIN_SIZE edges
 * of `unit` across), framed as the viewer frames a scene (render camera.ts frame, fit 1), the distance
 * kept within [FOLLOW_NEAR, FOLLOW_FAR] times `homeDistance`. With `clip` (a box of the same form:
 * the play area) the moving box is first cut to it, so a few bodies flung far off the lot do not drag
 * the frame after them. Null for an empty box, or one wholly outside `clip`.
 */
export function followGoal(o: Orbit, box: ArrayLike<number>, unit: number, homeDistance: number, clip?: ArrayLike<number>): { target: V3; distance: number } | null {
  const min: V3 = [box[0]!, box[1]!, box[2]!], max: V3 = [box[3]!, box[4]!, box[5]!];
  if (clip) for (let k = 0; k < 3; k++) { min[k] = Math.max(min[k]!, clip[k]!); max[k] = Math.min(max[k]!, clip[3 + k]!); }
  if (!(min.every(Number.isFinite) && max.every(Number.isFinite)) || min.some((x, k) => x > max[k]!)) return null;
  for (let k = 0; k < 3; k++) {
    const c = (min[k]! + max[k]!) / 2, half = Math.max((max[k]! - min[k]!) * (0.5 + FOLLOW_PAD), (FOLLOW_MIN_SIZE * unit) / 2);
    min[k] = c - half;
    max[k] = c + half;
  }
  min[1] = Math.max(0, min[1]!); // nothing below the ground to frame
  const f = frame(min, max, { eye: 0, fov: o.fovY * DEG, yaw: o.yaw * DEG, pitch: o.pitch * DEG, fit: 1 });
  return { target: f.target, distance: Math.min(FOLLOW_FAR * homeDistance, Math.max(FOLLOW_NEAR * homeDistance, f.distance)) };
}

/** The follow camera's state for one shot at a time: start at fire, update every frame, grab on any player camera input. */
export class FollowCam {
  /** The orbit's target and distance when the shot was fired: where it eases back to. */
  private home: { target: V3; distance: number } | null = null;
  /** Spring velocities: target x, y, z, distance. */
  private vel = [0, 0, 0, 0];
  /** Every moving box this shot, together (null until enough moved): what the camera frames. */
  private seen: Float64Array | null = null;
  /** The player moved the camera during this shot: follow is off until the next. */
  grabbed = false;
  /** Whether the camera is being moved now (following, or easing back). */
  get active(): boolean { return this.home !== null && !this.grabbed; }

  /** A shot was fired from orbit o. */
  start(o: Orbit) {
    this.home = { target: [...o.target] as V3, distance: o.distance };
    this.vel = [0, 0, 0, 0];
    this.grabbed = false;
    this.seen = null;
  }
  /** The player orbited, panned or zoomed: leave the camera to them. */
  grab() { this.grabbed = true; }
  /** A level load or retry: nothing to follow or return to. */
  reset() { this.home = null; this.vel = [0, 0, 0, 0]; this.grabbed = false; this.seen = null; }

  /**
   * Move o by dt seconds. Each box with `moving` structure bodies (at least FOLLOW_MIN_MOVING) joins
   * the shot's box; while `running` with a box, head for followGoal of it (cut to `clip`), so the
   * frame grows as the collapse spreads and holds as it dies down; otherwise (nothing has moved
   * enough yet, or the shot is over) head home. Once home after the shot, stop.
   */
  update(o: Orbit, dt: number, running: boolean, box: ArrayLike<number> | null, moving: number, unit: number, clip?: ArrayLike<number>): void {
    if (!this.active || !(dt > 0)) return;
    const home = this.home!;
    if (running && box && moving >= FOLLOW_MIN_MOVING && box.length >= 6 && Array.from(box).every(Number.isFinite)) {
      const u = this.seen ??= Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
      for (let k = 0; k < 3; k++) { u[k] = Math.min(u[k]!, box[k]!); u[3 + k] = Math.max(u[3 + k]!, box[3 + k]!); }
    }
    const goal = (running && this.seen ? followGoal(o, this.seen, unit, home.distance, clip) : null) ?? home;
    for (let k = 0; k < 3; k++) [o.target[k], this.vel[k]] = spring(o.target[k]!, this.vel[k]!, goal.target[k]!, FOLLOW_RATE, dt);
    [o.distance, this.vel[3]] = spring(o.distance, this.vel[3]!, goal.distance, FOLLOW_RATE, dt);
    // Back home after the shot: land exactly and stop, so aiming starts from the player's own view.
    if (!running && goal === home) {
      const off = Math.hypot(o.target[0] - home.target[0], o.target[1] - home.target[1], o.target[2] - home.target[2], o.distance - home.distance);
      if (off < 1e-3 * home.distance) { o.target = [...home.target] as V3; o.distance = home.distance; this.home = null; }
    }
  }
}
