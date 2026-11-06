// Sparse forces (docs/design/weapons.md, plan step 6): an input event that puts
// a force on one body for a number of steps: a rocket's thrust, a vibration, a
// held pull (a hand that drags a block to a point and holds it there). At most
// MAX_FORCED bodies carry a force at any step, so an engine applies them in one
// small pass over a short list.
//
// When: a force event due at step s gives body `id` its force from the step it
// applies (s, or the next step when pushed late) for `steps` steps, replacing
// any force it had; `force: null` ends the body's force. A removal ends it too.
//
// What: on each step the body has a force, after every other event of that
// step (spawns, blasts, removals), its velocity changes by
//
//   dv = h F / m          (forceKick)
//
// with F evaluated from its state then (forceAt; k: steps since the force
// began, h the step):
//   thrust   F = the axes' image of `thrust` (N): world, the body's own
//            rotation, or its heading (spawn.ts spawnAxes; a thrust along +y in
//            heading axes pushes the body on along its velocity);
//   vibrate  F = vibrate sin(2 pi (k h / period + phase)) (N, world), the sine
//            by cosSin, so every machine shakes alike;
//   pull     F = stiffness (pull - x) - damping v (N; a spring to the point
//            `pull` and a dashpot), its length capped at `max`.
// A kick at the start of the step through the centre of mass is a force over
// the step for the solver: the inertial target x + h v + h^2 g moves by
// h^2 F / m. As a blast's kick, it is added to the adaptive warm start's
// previous velocity too, so a force is not read as falling: a block pressed
// down onto its support or dragged across it is still guessed to rest on it.
// The body wakes (an engine with sleep keeps it awake while it is forced),
// and so does what it pushes into.
//
// Everything is +, -, *, / and square roots (and cosSin), so the f64 reference
// is the same on every machine; the GPU engine evaluates thrust in body or
// heading axes and pulls in f32 on its own state, and gets world-axis thrusts
// and vibrations from the host.
//
// Engines refuse (at init and push, before anything changes) a force on a body
// that does not exist when it is due or is removed, a malformed force, and a
// queue that would put forces on more than MAX_FORCED bodies at one step
// (remove.ts checkInputQueue).
import type { Vec3 } from './index.ts';
import { type BodyMotion, SPAWN_AXES, type SpawnAxes, spawnAxes } from './spawn.ts';

/** Most bodies under a force at any one step. */
export const MAX_FORCED = 64;
/** Longest force, steps (a held pull that is never let go is still re-pushed now and then by its holder). */
export const MAX_FORCE_STEPS = 2 ** 30;

interface ForceBase {
  /** Steps it acts, from the step it applies; an integer >= 1. */
  steps: number;
}
/** A constant force in the body's world, own or heading axes (spawn.ts), N. */
export interface Thrust extends ForceBase { thrust: Vec3; axes?: SpawnAxes }
/** A sine force along a world vector: amplitude `vibrate`, N; `period`, s; `phase`, a fraction of a period at its first step (default 0). */
export interface Vibrate extends ForceBase { vibrate: Vec3; period: number; phase?: number }
/** A spring to the world point `pull` (stiffness N/m) with a dashpot (damping N s/m, default 0), its force capped at `max` N (default none). */
export interface Pull extends ForceBase { pull: Vec3; stiffness: number; damping?: number; max?: number }
export type Force = Thrust | Vibrate | Pull;

/** Body `id` takes `force` from this step (replacing any it has), or loses its force (null). */
export interface ForceEvent { step: number; kind: 'force'; id: number; force: Force | null }

/** A Force checked by checkForce, defaults filled in. */
export type CheckedForce =
  | { kind: 'thrust'; steps: number; thrust: Vec3; axes: SpawnAxes }
  | { kind: 'vibrate'; steps: number; vibrate: Vec3; period: number; phase: number }
  | { kind: 'pull'; steps: number; pull: Vec3; stiffness: number; damping: number; max: number };

/** Throws on a force no engine should apply; returns it with defaults filled in. */
export function checkForce(f: Force): CheckedForce {
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(fin);
  const x = f as unknown as Record<string, unknown>;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`force must be an object, got ${JSON.stringify(x)}`);
  const kinds = ['thrust', 'vibrate', 'pull'].filter((k) => k in x);
  if (kinds.length !== 1) throw new Error(`force must have exactly one of thrust, vibrate, pull, got ${JSON.stringify(x)}`);
  const kind = kinds[0] as CheckedForce['kind'];
  const allowed = { thrust: ['steps', 'thrust', 'axes'], vibrate: ['steps', 'vibrate', 'period', 'phase'], pull: ['steps', 'pull', 'stiffness', 'damping', 'max'] }[kind];
  const extra = Object.keys(x).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`force (${kind}) has unknown keys ${extra.join(', ')} (allowed: ${allowed.join(', ')})`);
  const steps = x.steps;
  if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > MAX_FORCE_STEPS) throw new Error(`force.steps must be an integer from 1 to ${MAX_FORCE_STEPS}, got ${JSON.stringify(steps)}`);
  const s = steps as number;
  if (!vec3(x[kind])) throw new Error(`force.${kind} must be 3 finite numbers, got ${JSON.stringify(x[kind])}`);
  const v = x[kind] as Vec3;
  if (kind === 'thrust') {
    const axes = (x.axes ?? 'world') as SpawnAxes;
    if (!SPAWN_AXES.includes(axes)) throw new Error(`force.axes must be one of ${SPAWN_AXES.join(', ')}, got ${JSON.stringify(x.axes)}`);
    return { kind, steps: s, thrust: v, axes };
  }
  if (kind === 'vibrate') {
    const period = x.period, phase = x.phase ?? 0;
    if (!fin(period) || period <= 0) throw new Error(`force.period must be a finite number > 0 (s), got ${JSON.stringify(period)}`);
    if (!fin(phase) || phase < 0 || phase >= 1) throw new Error(`force.phase must be a number in [0, 1), got ${JSON.stringify(phase)}`);
    return { kind, steps: s, vibrate: v, period, phase };
  }
  const stiffness = x.stiffness, damping = x.damping ?? 0, max = x.max ?? Infinity;
  if (!fin(stiffness) || stiffness < 0) throw new Error(`force.stiffness must be a finite number >= 0 (N/m), got ${JSON.stringify(stiffness)}`);
  if (!fin(damping) || damping < 0) throw new Error(`force.damping must be a finite number >= 0 (N s/m), got ${JSON.stringify(damping)}`);
  if (!(typeof max === 'number' && max > 0)) throw new Error(`force.max must be a number > 0 (N; Infinity: no cap), got ${JSON.stringify(max)}`);
  return { kind, steps: s, pull: v, stiffness, damping, max };
}

/** cos and sin of x (|x| <= 2 pi), by range reduction to [-pi/4, pi/4] and fixed Taylor series: the same on every machine. */
export function cosSin(x: number): [number, number] {
  const PI = 3.141592653589793, H = PI / 2;
  // x = q (pi/2) + r with |r| <= pi/4.
  const q = Math.round(x / H), r = x - q * H, r2 = r * r;
  // Horner forms of the series to r^17, well under an ulp on [-pi/4, pi/4].
  let c = 1, s = 1;
  for (let k = 16; k >= 2; k -= 2) c = 1 - (r2 / (k * (k - 1))) * c;
  for (let k = 17; k >= 3; k -= 2) s = 1 - (r2 / (k * (k - 1))) * s;
  s *= r;
  switch (((q % 4) + 4) % 4) {
    case 0: return [c, s];
    case 1: return [-s, c];
    case 2: return [-c, -s];
    default: return [s, -c];
  }
}

/** The vibration's factor at step k of it: sin(2 pi (k h / period + phase)), the angle wrapped to [0, 2 pi) first. */
export function vibration(f: { period: number; phase: number }, k: number, h: number): number {
  const turns = (k * h) / f.period + f.phase, frac = turns - Math.floor(turns);
  return cosSin(6.283185307179586 * frac)[1];
}

/** True when the force's value at a step does not depend on the body's state (the GPU engine takes these from the host). */
export const forceIsWorld = (f: CheckedForce): boolean => f.kind === 'vibrate' || (f.kind === 'thrust' && f.axes === 'world');

/** The force on a body in state `b` at step k of the force (k = 0 its first), with step h (header), N. */
export function forceAt(f: CheckedForce, k: number, h: number, b: BodyMotion): Vec3 {
  if (f.kind === 'thrust') {
    if (f.axes === 'world') return [...f.thrust];
    const [x, y, z] = spawnAxes(b, f.axes), t = f.thrust;
    return [x[0] * t[0] + y[0] * t[1] + z[0] * t[2], x[1] * t[0] + y[1] * t[1] + z[1] * t[2], x[2] * t[0] + y[2] * t[1] + z[2] * t[2]];
  }
  if (f.kind === 'vibrate') {
    const s = vibration(f, k, h);
    return [f.vibrate[0] * s, f.vibrate[1] * s, f.vibrate[2] * s];
  }
  const F: Vec3 = [0, 1, 2].map((a) => f.stiffness * (f.pull[a]! - b.pos[a]!) - f.damping * b.linVel[a]!) as Vec3;
  const l = Math.sqrt(F[0] * F[0] + F[1] * F[1] + F[2] * F[2]);
  if (l <= f.max) return F;
  const c = f.max / l;
  return [F[0] * c, F[1] * c, F[2] * c];
}

/** The velocity change a force F gives a body of mass m over a step h: h F / m. */
export function forceKick(F: Vec3, mass: number, h: number): Vec3 {
  return [(h * F[0]) / mass, (h * F[1]) / mass, (h * F[2]) / mass];
}

/** A force acting: from step `start` (the step it applied) to `end` (exclusive). */
export interface ActiveForce { id: number; force: CheckedForce; start: number; end: number }

/**
 * The forces an engine holds (header): what force events set, by body. Engines apply a step's events in order
 * (set, end), then act() gives the forces of that step, ascending by id, and drops those that ended.
 */
export class ForceTable {
  private forces = new Map<number, ActiveForce>();

  /** Bodies with a force now (some may have ended; act() drops them). */
  get size(): number { return this.forces.size; }

  /** Applies force event `ev` at engine step `step`. */
  apply(ev: ForceEvent, step: number): void {
    if (ev.force === null) { this.forces.delete(ev.id); return; }
    const force = checkForce(ev.force);
    this.forces.set(ev.id, { id: ev.id, force, start: step, end: step + force.steps });
  }

  /** Body `id` was removed: its force ends. */
  remove(id: number): void { this.forces.delete(id); }

  /** The forces acting at step `step`, ascending by id; those ended by then are dropped. */
  act(step: number): ActiveForce[] {
    const out: ActiveForce[] = [];
    for (const [id, f] of this.forces) {
      if (f.end <= step) this.forces.delete(id);
      else out.push(f);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** True when some force acts at step `step` (one still to be dropped by act() may count). */
  acting(step: number): boolean {
    for (const f of this.forces.values()) if (f.end > step) return true;
    return false;
  }

  /** Each forced body's end step (exclusive), for checkInputQueue. */
  ends(): Map<number, number> {
    return new Map([...this.forces].map(([id, f]) => [id, f.end]));
  }

  /** A copy (engine checkpoints). */
  clone(): ForceTable {
    const t = new ForceTable();
    t.forces = new Map(this.forces);
    return t;
  }
}

/**
 * The velocity changes the forces of one step give, by the definition every engine is tested against: for
 * each active force, its body's state `state(id)` and mass. Ascending by id.
 */
export function forceKicks(active: readonly ActiveForce[], step: number, h: number, state: (id: number) => BodyMotion, mass: (id: number) => number): { id: number; dv: Vec3 }[] {
  return active.map((f) => ({ id: f.id, dv: forceKick(forceAt(f.force, step - f.start, h, state(f.id)), mass(f.id), h) }));
}

