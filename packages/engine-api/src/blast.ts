// Blasts: a radial impulse field, the first input event that acts on bodies
// already in the world instead of adding one. Every engine applies it by
// blastKick() below, so this file is the definition they are tested against.
//
// A body whose centre lies within `radius` of the blast's centre gets a speed
// change away from the centre (straight up when it sits on the centre):
//
//   |dv| = min(maxDv, impulse * w(d) * A / m)
//   w(d) = 1 for d <= core * radius, else ((1 - d / radius) / (1 - core))^falloff
//
// impulse is the blast's impulse per square metre of a body's exposed area at
// the centre (N s / m^2). A is the body's mean silhouette: a convex body's
// average projected area is a quarter of its surface (Cauchy), so a box's is
// 2 (hx hy + hy hz + hz hx), 1.5 times a cube's face, and a sphere's is pi r^2. So a light or small body flies faster than a heavy one at the same
// distance, as in a pressure wave, and a dense material resists. Only linear
// velocity changes: the push acts through the centre of mass. Contacts
// afterwards make the spin. An upward bias is a centre placed below the
// grenade, not a separate term.
//
// Everything is +, -, *, / and one square root (falloff is an integer power,
// by multiplication), so the f64 reference is the same on every machine:
// no Math.pow or Math.cbrt, whose accuracy ECMAScript leaves open.
//
// When: at the start of the step the event is due, in event order with the
// spawns due at the same step, before anything of the step runs. A blast
// acts on the bodies that exist at that point (ids below `count`), so a body
// spawned after it in the same step is not pushed. The solver sees the new
// velocity as the body's velocity at the start of the step: its inertial
// target, its sweep for the broadphase, and the restitution pass's approach
// speeds all include it. The engines add the kick to the velocity the
// adaptive warm start compares with (AVBD's prevLinVel) as well, so a kick
// does not read as an acceleration: a body kicked down while it rests on
// its supports is not first guessed to be in free fall.
//
// The centre is a point, or a body: { body, offset } is that body's position
// when the blast is due (plus offset, world frame), read from the engine's
// live state, so a grenade goes off where it is, not where a reader one step
// behind last saw it. The body must exist when the blast is due; engines
// refuse the event otherwise (checkBlastQueue).
//
// After each blast's kick a pushed body's speed is capped at maxSpeed
// (scaled, direction kept), so stacked kicks or a fast body cannot outrun
// the broadphase's sweep and tunnel. The cap changes the warm start's
// previous velocity by the same amount.
//
// Not covered yet (docs/design/weapons.md): waking dormant lattice cells
// inside the radius (TieredEngine refuses blasts), occlusion (a body behind
// another is pushed as hard), and removing the grenade (`exclude` keeps it
// out of its own blast).
import type { InputEvent, ShapeDesc, Vec3 } from './index.ts';

/** A blast centred on a body: its position when the blast is due, plus `offset` (world frame, m; default 0). */
export interface BodyCentre { body: number; offset?: Vec3 }

export interface Blast {
  /** World position of the blast (m), or a body's (header). */
  centre: Vec3 | BodyCentre;
  /** Bodies whose centre lies within this distance are pushed, m (> 0). */
  radius: number;
  /** Impulse per m^2 of exposed area at the centre, N s / m^2 (>= 0). */
  impulse: number;
  /** Integer exponent of the falloff (header): 0 flat, 1 linear (default), 2 gentler edge. 0..8. */
  falloff?: number;
  /** Fraction of the radius pushed at full strength (header), [0, 1); default 0. */
  core?: number;
  /** Largest speed change any body gets, m/s (default DEFAULT_BLAST_MAX_DV). Keeps bodies under the broadphase's sweep. */
  maxDv?: number;
  /** Speed a pushed body is capped at after the kick, m/s (default DEFAULT_BLAST_MAX_SPEED; header). */
  maxSpeed?: number;
  /** Ids the blast does not push (the grenade itself); at most MAX_BLAST_EXCLUDE. */
  exclude?: readonly number[];
}

/** A Blast checked by checkBlast, with defaults filled in: the centre is a point (body -1) or a body (point null). */
export interface CheckedBlast {
  point: Vec3 | null;
  body: number;
  offset: Vec3;
  radius: number;
  impulse: number;
  falloff: number;
  core: number;
  maxDv: number;
  maxSpeed: number;
  exclude: readonly number[];
}

/** Blast.falloff when unset: linear. */
export const DEFAULT_BLAST_FALLOFF = 1;
/**
 * Blast.maxDv when unset, m/s. AVBD's broadphase sweeps a body by at most
 * maxSweep (1 m) a step, 60 m/s at 60 Hz, and a 0.5 m cube is crossed in
 * one step above 30 m/s; 25 keeps a blasted cube well inside both.
 */
export const DEFAULT_BLAST_MAX_DV = 25;
/** Blast.maxSpeed when unset, m/s: 0.8 of AVBD's sweep limit at its defaults (maxSweep 1 m a step at 60 Hz). */
export const DEFAULT_BLAST_MAX_SPEED = 48;
export const MAX_BLAST_EXCLUDE = 8;
const MAX_FALLOFF = 8;

/** Throws on a blast no engine should apply; returns it with defaults filled in. */
export function checkBlast(b: Blast): CheckedBlast {
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(fin);
  const c = b.centre as unknown;
  let point: Vec3 | null = null, body = -1, offset: Vec3 = [0, 0, 0];
  if (vec3(c)) point = c;
  else if (typeof c === 'object' && c !== null && !Array.isArray(c) && 'body' in c) {
    const { body: id, offset: o, ...rest } = c as BodyCentre;
    if (Object.keys(rest).length || !Number.isInteger(id) || id < 0 || id >= 2 ** 32) throw new Error(`blast.centre must be 3 finite numbers or { body, offset? }, got ${JSON.stringify(c)}`);
    if (o !== undefined && !vec3(o)) throw new Error(`blast.centre.offset must be 3 finite numbers, got ${JSON.stringify(o)}`);
    body = id;
    offset = o ?? offset;
  } else throw new Error(`blast.centre must be 3 finite numbers or { body, offset? }, got ${JSON.stringify(c)}`);
  if (!fin(b.radius) || b.radius <= 0) throw new Error(`blast.radius must be a finite number > 0, got ${b.radius}`);
  if (!fin(b.impulse) || b.impulse < 0) throw new Error(`blast.impulse must be a finite number >= 0, got ${b.impulse}`);
  const falloff = b.falloff ?? DEFAULT_BLAST_FALLOFF, core = b.core ?? 0, maxDv = b.maxDv ?? DEFAULT_BLAST_MAX_DV, maxSpeed = b.maxSpeed ?? DEFAULT_BLAST_MAX_SPEED, exclude = b.exclude ?? [];
  if (!Number.isInteger(falloff) || falloff < 0 || falloff > MAX_FALLOFF) throw new Error(`blast.falloff must be an integer from 0 to ${MAX_FALLOFF}, got ${falloff}`);
  if (!fin(core) || core < 0 || core >= 1) throw new Error(`blast.core must be a number in [0, 1), got ${core}`);
  if (!fin(maxDv) || maxDv < 0) throw new Error(`blast.maxDv must be a finite number >= 0, got ${maxDv}`);
  if (!(typeof maxSpeed === 'number' && maxSpeed > 0)) throw new Error(`blast.maxSpeed must be a number > 0 (Infinity: no cap), got ${maxSpeed}`);
  if (!Array.isArray(exclude) || exclude.length > MAX_BLAST_EXCLUDE || !exclude.every((i) => Number.isInteger(i) && i >= 0 && i < 2 ** 32)) throw new Error(`blast.exclude must be at most ${MAX_BLAST_EXCLUDE} body ids, got ${JSON.stringify(exclude)}`);
  return { point, body, offset, radius: b.radius, impulse: b.impulse, falloff, core, maxDv, maxSpeed, exclude };
}

/**
 * Throws unless every blast in `queue` (the events an engine will apply, in
 * order) passes checkBlast and, when centred on a body, names one that
 * exists when it is due: one of the `existing` bodies or a spawn before it.
 */
export function checkBlastQueue(existing: number, queue: readonly InputEvent[]): void {
  let n = existing;
  for (const ev of queue) {
    if (ev.kind === 'spawn') { n++; continue; }
    const b = checkBlast(ev.blast);
    if (b.body >= n) throw new Error(`blast at step ${ev.step} is centred on body ${b.body}, which does not exist then (${n} bodies)`);
  }
}

/** The blast's centre, given the position of its body when it is due (ignored for a point centre). */
export function blastCentre(b: CheckedBlast, bodyPos: Vec3 | null): Vec3 {
  if (b.point) return b.point;
  if (!bodyPos) throw new Error(`blast centred on body ${b.body}: no position given`);
  return [bodyPos[0] + b.offset[0], bodyPos[1] + b.offset[1], bodyPos[2] + b.offset[2]];
}

/**
 * A body's velocity after blast `b` centred at `centre`: vel plus its kick
 * (blastKick), the speed capped at b.maxSpeed; null when it gets no kick.
 */
export function blastVelocity(b: CheckedBlast, centre: Vec3, id: number, pos: Vec3, vel: Vec3, mass: number, area: number): Vec3 | null {
  const k = blastKick(b, centre, id, pos, mass, area);
  if (!k) return null;
  const v: Vec3 = [vel[0] + k[0], vel[1] + k[1], vel[2] + k[2]];
  const s = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (s <= b.maxSpeed) return v;
  const f = b.maxSpeed / s;
  return [v[0] * f, v[1] * f, v[2] * f];
}

/** A shape's mean silhouette area, m^2 (the header's A). */
export function blastArea(s: ShapeDesc): number {
  if (s.kind === 'sphere') return Math.PI * s.radius * s.radius;
  const [x, y, z] = s.half;
  return 2 * (x * y + y * z + z * x);
}

/** The falloff weight at distance d (header), for d < radius. */
export function blastWeight(b: CheckedBlast, d: number): number {
  const r0 = b.core * b.radius;
  if (d <= r0) return 1;
  const t = (b.radius - d) / (b.radius - r0);
  let w = 1;
  for (let k = 0; k < b.falloff; k++) w *= t;
  return w;
}

/**
 * The speed change blast `b` centred at `centre` (blastCentre) gives body
 * `id` with centre `pos`, mass `mass` and silhouette `area` (blastArea), or
 * null when it is out of range or excluded. Before the speed cap
 * (blastVelocity). In f64; the GPU engine evaluates the same expression in f32.
 */
export function blastKick(b: CheckedBlast, centre: Vec3, id: number, pos: Vec3, mass: number, area: number): Vec3 | null {
  if (b.exclude.includes(id)) return null;
  const dx = pos[0] - centre[0], dy = pos[1] - centre[1], dz = pos[2] - centre[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d < b.radius)) return null;
  const dv = Math.min(b.maxDv, (b.impulse * blastWeight(b, d) * area) / mass);
  // On the centre the direction is undefined: straight up.
  return d > 0 ? [(dx / d) * dv, (dy / d) * dv, (dz / d) * dv] : [0, dv, 0];
}

/** `pending` with `events` inserted as every engine queues pushed inputs: by step, after events due at the same step (a new array). */
export function queueInputs(pending: readonly InputEvent[], events: readonly InputEvent[]): InputEvent[] {
  const out = [...pending];
  for (const ev of events) {
    let i = out.length;
    while (i > 0 && out[i - 1]!.step > ev.step) i--;
    out.splice(i, 0, ev);
  }
  return out;
}
