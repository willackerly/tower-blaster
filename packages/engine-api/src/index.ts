// The one contract every physics implementation meets: the TypeScript
// reference, CPU baselines (Rapier, Box3D, Jolt) and every GPU variant.
// The game and the benchmark harness both drive engines only through this.
import type { Blast } from './blast.ts';
import type { ObserveOptions, Observer } from './observe.ts';

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
  /**
   * Coefficient of restitution, combined with the other surface's by
   * SceneDesc.restitutionCombine. The AVBD reference clamps the combined value
   * to [0, 1]; the Rapier adapter passes it to Rapier as given.
   */
  restitution: number;
  /** Free-form grouping used by metrics: tower index, or a TAG_* role. */
  tag: number;
}

export const TAG_BALL = -1;
export const TAG_DEBRIS = -2;

/** Something that happens at a given step: a body is added (a ball is fired), or a blast pushes the bodies around a point (blast.ts). */
export type InputEvent = SpawnEvent | BlastEvent;
export interface SpawnEvent { step: number; kind: 'spawn'; body: BodyDesc }
/** Engines that do not apply blasts throw on push() and init() of one. */
export interface BlastEvent { step: number; kind: 'blast'; blast: Blast }

/** The bodies a list of events spawns, in order. */
export const spawnedBodies = (events: readonly InputEvent[]): BodyDesc[] => events.flatMap((e) => (e.kind === 'spawn' ? [e.body] : []));

export interface SceneDesc {
  /** Scenario id, e.g. "S1". */
  id: string;
  params: Record<string, number | string | boolean>;
  seed: number;
  gravity: Vec3;
  /** Fixed physics step in seconds. */
  dt: number;
  /** Infinite ground plane at y, or none. Its restitution, in [0, 1] (default 0), combines with a body's by restitutionCombine. */
  ground: { y: number; friction: number; restitution?: number } | null;
  /** Whether engines may put bodies to sleep. */
  sleep: boolean;
  /** How the friction of two touching surfaces combines (ground included). Default 'average', as Rapier. */
  frictionCombine?: CombineRule;
  /** How the restitution of two touching surfaces combines (ground included). Default DEFAULT_RESTITUTION_COMBINE. */
  restitutionCombine?: CombineRule;
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
  /**
   * Per body, the tier it is in, in the renderer's Body.flags encoding
   * (@tb/schema TIER: active 0, rubble 1, lattice 2). Set by engines that
   * keep tiers (TieredEngine); absent means every body is active. A body
   * that is not active does not move until its tier changes.
   */
  tier?: Uint8Array;
}

export interface EngineInfo {
  name: string;
  /** Everything that distinguishes this variant; hashed into result keys. */
  variant: Record<string, string | number | boolean>;
  /** Where it runs, e.g. "wasm-cpu" or "webgpu:apple/m5". */
  backend: string;
  /**
   * How a body in free flight moves: each step is `substeps` semi-implicit
   * Euler steps of dt / substeps (see freeFlight), so a game can predict an
   * arc exactly. Every engine here sets it; absent means unknown.
   */
  integrator?: { substeps: number };
}

/** Rapier's names for combining two coefficients. */
export type CombineRule = 'average' | 'min' | 'max' | 'multiply';

export function combineFriction(rule: CombineRule, a: number, b: number): number {
  switch (rule) {
    case 'average': return (a + b) / 2;
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'multiply': return a * b;
  }
}

/** SceneDesc.restitutionCombine when it is unset, in every engine that applies restitution (Rapier; the AVBD reference with AvbdParams.restitution on): Rapier's own default. */
export const DEFAULT_RESTITUTION_COMBINE: CombineRule = 'average';

/** The restitution of two touching surfaces, by the same rules as friction (the ground's is SceneDesc.ground.restitution, default 0). */
export function combineRestitution(rule: CombineRule, a: number, b: number): number {
  return combineFriction(rule, a, b);
}

/**
 * Position and velocity after `steps` steps of free flight under gravity, as
 * an engine with `integrator.substeps` moves a body: semi-implicit Euler
 * (velocity first, then position) with dt / substeps.
 */
export function freeFlight(pos: Vec3, vel: Vec3, gravity: Vec3, dt: number, substeps: number, steps: number): { pos: Vec3; vel: Vec3 } {
  const p: Vec3 = [...pos], v: Vec3 = [...vel], h = dt / substeps;
  for (let s = 0; s < steps * substeps; s++) {
    for (let k = 0; k < 3; k++) { v[k]! += h * gravity[k]!; p[k]! += h * v[k]!; }
  }
  return { pos: p, vel: v };
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
  /**
   * Full state copy. Never called inside a timed region. An engine with
   * finish() queues its read before snapshot() returns, so the copy holds the
   * state after exactly the steps submitted before the call, even when step()
   * is called again before it resolves (the viewer's pipelined loop relies on
   * this).
   */
  snapshot(): Snapshot | Promise<Snapshot>;
  /**
   * Resolves once every step submitted so far has finished executing. Engines
   * whose step() returns only after the work is done (CPU engines) leave it out;
   * GPU engines, whose step() only submits, must provide it, or timing sees
   * only the submission.
   */
  finish?(): Promise<void>;
  /**
   * GPU engines only: the live state buffers, so a renderer on the same
   * device draws them with no CPU copy. Read-only for the caller.
   */
  gpu?(): GpuBodies | null;
  /** Exact reductions and sparse reads. Valid until the next init() or dispose(). Engines without it are wrapped with withSnapshotObserver(). */
  observe?(opts: ObserveOptions): Promise<Observer>;
  dispose(): void;
}

/**
 * Body state that lives on the GPU. Buffers use the @tb/schema layouts and
 * are overwritten in place by each step(); work submitted after step()
 * returns sees the new state (queue order).
 */
export interface GpuBodies {
  device: GPUDevice;
  /** array<Body>, `capacity` slots; body i is slot i (slots are stable). */
  bodies: GPUBuffer;
  /** array<Shape>, indexed by Body.shape. */
  shapes: GPUBuffer;
  /** Bodies in use, slots [0, count); grows when inputs spawn. Read after step(). */
  count: number;
  /** Fixed at init. */
  capacity: number;
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
  for (const ev of scene.inputs) if (ev.step < step && ev.kind === 'spawn') out.push(ev.body);
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

export * from './blast.ts';
export * from './host.ts';
export * from './observe.ts';
export * from './snapshot-observer.ts';
