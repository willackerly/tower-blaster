// The one contract every physics implementation meets: the TypeScript
// reference, CPU baselines (Rapier, Box3D, Jolt) and every GPU variant.
// The game and the benchmark harness both drive engines only through this.

export type Vec3 = [number, number, number];
/** Unit quaternion, (x, y, z, w). */
export type Quat = [number, number, number, number];

export type ShapeDesc =
  | { kind: 'box'; half: Vec3 }
  | { kind: 'sphere'; radius: number };

export interface BodyDesc {
  shape: ShapeDesc;
  pos: Vec3;
  rot: Quat;
  linVel: Vec3;
  angVel: Vec3;
  density: number;
  friction: number;
  restitution: number;
  /** Free-form grouping used by metrics: tower index, or a TAG_* role. */
  tag: number;
}

export const TAG_BALL = -1;
export const TAG_DEBRIS = -2;

/** Something that happens at a given step, e.g. a ball is fired. */
export type InputEvent = { step: number; kind: 'spawn'; body: BodyDesc };

export interface SceneDesc {
  /** Scenario id, e.g. "S1". */
  id: string;
  params: Record<string, number | string | boolean>;
  seed: number;
  gravity: Vec3;
  /** Fixed physics step in seconds. */
  dt: number;
  /** Infinite ground plane at y, or none. */
  ground: { y: number; friction: number } | null;
  /** Whether engines may put bodies to sleep. */
  sleep: boolean;
  bodies: BodyDesc[];
  /** Sorted by step. Spawned bodies get indices after `bodies`, in event order. */
  inputs: InputEvent[];
}

/** Structure-of-arrays copy of body state; index i is body i. */
export interface Snapshot {
  count: number;
  pos: Float64Array; // 3 per body
  rot: Float64Array; // 4 per body, (x, y, z, w)
  linVel: Float64Array; // 3 per body
  angVel: Float64Array; // 3 per body
  awake: Uint8Array; // 1 per body
}

export interface EngineInfo {
  name: string;
  /** Everything that distinguishes this variant; hashed into result keys. */
  variant: Record<string, string | number | boolean>;
  /** Where it runs, e.g. "wasm-cpu" or "webgpu:apple/m5". */
  backend: string;
}

export interface StepReport {
  /** GPU-side duration if the engine can measure it (timestamp queries). */
  gpuMs?: number;
}

export interface PhysicsEngine {
  readonly info: EngineInfo;
  init(scene: SceneDesc): Promise<void>;
  /**
   * Queue inputs after init, for interactive play. An event applies at the
   * first step() whose index is >= event.step (so a past step means "next
   * step"), in the same order as scene.inputs: by step, then push order.
   * Recording pushed events into scene.inputs replays the session exactly.
   */
  push(events: InputEvent[]): void;
  /** Advance exactly one fixed step, applying any inputs due at this step. */
  step(): StepReport | void | Promise<StepReport | void>;
  /** Steps taken since init. */
  readonly stepIndex: number;
  /** Full state copy. Never called inside a timed region. */
  snapshot(): Snapshot | Promise<Snapshot>;
  /**
   * Resolves once every step submitted so far has finished executing. Engines
   * whose step() returns only after the work is done (CPU engines) leave it out;
   * GPU engines, whose step() only submits, must provide it, or timing sees
   * only the submission.
   */
  finish?(): Promise<void>;
  dispose(): void;
}

export function emptySnapshot(count: number): Snapshot {
  return {
    count,
    pos: new Float64Array(3 * count),
    rot: new Float64Array(4 * count),
    linVel: new Float64Array(3 * count),
    angVel: new Float64Array(3 * count),
    awake: new Uint8Array(count),
  };
}

/** Bodies present at `step` (initial bodies plus inputs spawned before it). */
export function bodiesAt(scene: SceneDesc, step: number): BodyDesc[] {
  const out = scene.bodies.slice();
  for (const ev of scene.inputs) if (ev.step < step) out.push(ev.body);
  return out;
}

export function massOf(b: BodyDesc): number {
  return b.density * volumeOf(b.shape);
}

export function volumeOf(s: ShapeDesc): number {
  return s.kind === 'box'
    ? 8 * s.half[0] * s.half[1] * s.half[2]
    : (4 / 3) * Math.PI * s.radius ** 3;
}

/** Principal moments of inertia in the body frame (diagonal). */
export function inertiaOf(b: BodyDesc): Vec3 {
  const m = massOf(b);
  if (b.shape.kind === 'sphere') {
    const i = 0.4 * m * b.shape.radius ** 2;
    return [i, i, i];
  }
  const [hx, hy, hz] = b.shape.half;
  const k = m / 3; // (m/12)*(2h)^2 = m h^2 / 3
  return [k * (hy * hy + hz * hz), k * (hx * hx + hz * hz), k * (hx * hx + hy * hy)];
}

export * from './host.ts';
