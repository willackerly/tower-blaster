// Field events (roadmap C7): the world's gravity as a schedule over steps, and
// uniform velocity kicks. Quakes, tilts and jolts (M7 Aftershock) are made of
// them. Every engine applies them as this file says, and the shared case in
// @tb/testkit's field.ts checks it. Design and alternatives:
// docs/design/gravity-and-pins.md.
//
// { step, kind: 'field', gravity?, kick? }
//
// gravity: the world's gravity from this step on, until the next field event
// that sets it. SceneDesc.gravity is the gravity before the first one, so
// g(step) is piecewise constant, keyed by steps (fieldGravity()).
//
// kick: a velocity change added, at the start of this step, to every body that
// moves: not pinned (pinned.ts), not removed (remove.ts). Seen from the
// ground's frame it is a jolt of the ground by -kick (a Galilean change of
// frame, exact for bodies in flight and at rest alike: the ground and the pins
// are the frame). As a blast's kick, it is added to the velocity the adaptive
// warm start compares with too (AVBD's prevLinVel), so it does not read as an
// acceleration.
//
// When: at the start of the step the event is due, in event order with that
// step's spawns, blasts and removals: a body spawned after a kick in the same
// step is not kicked.
//
// Waking: with sleep, a field event that changes gravity (any component
// differs from the gravity in force) or carries a non-zero kick wakes every
// sleeper but the pinned bodies. A sleeper holds its pose under the loads it
// fell asleep with; a new gravity changes every load. Setting gravity to its
// current value wakes nothing.
//
// Quantised: every component of gravity and kick is a multiple of
// FIELD_QUANTUM (2^-12, m/s^2 or m/s) no larger than FIELD_MAX (2^10) in
// magnitude. Such a number has at most 22 significant bits, so it is exact in
// f32 as in f64: the GPU's uniforms hold the value the reference uses, a JSON
// round trip is exact, and "changed" is an exact comparison. Engines refuse
// other values (checkInputQueue); quantiseField() rounds to the grid.
import type { InputEvent, SceneDesc, Vec3 } from './index.ts';

export interface FieldEvent {
  step: number;
  kind: 'field';
  /** The world's gravity from this step on (m/s^2, quantised). */
  gravity?: Vec3;
  /** A velocity change for every moving body at the start of this step (m/s, quantised). */
  kick?: Vec3;
}

/** The grid of field values: 2^-12 (m/s^2 for gravity, m/s for a kick). */
export const FIELD_QUANTUM = 2 ** -12;
/** The largest magnitude of a field component: 2^10. */
export const FIELD_MAX = 2 ** 10;

/** x rounded to the nearest multiple of FIELD_QUANTUM (exact: the quantum is a power of two). Throws on a value beyond FIELD_MAX or not finite. */
export function quantiseField(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) > FIELD_MAX) throw new Error(`quantiseField: ${x} is not a finite number within ${FIELD_MAX}`);
  // + 0 turns -0 into 0, so equal fields serialise equally.
  return Math.round(x / FIELD_QUANTUM) * FIELD_QUANTUM + 0;
}

export const quantiseVec3 = (v: Vec3): Vec3 => [quantiseField(v[0]), quantiseField(v[1]), quantiseField(v[2])];

/** Whether x is on the field grid and in range. */
export const onFieldGrid = (x: number): boolean => Number.isFinite(x) && Math.abs(x) <= FIELD_MAX && Number.isInteger(x / FIELD_QUANTUM);

/** Throws unless a field event is well formed: a gravity or a kick (or both), each three components on the grid. */
export function checkField(ev: FieldEvent): void {
  if (ev.gravity === undefined && ev.kick === undefined) throw new Error(`field at step ${ev.step}: needs a gravity or a kick`);
  for (const k of ['gravity', 'kick'] as const) {
    const v = ev[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length !== 3 || !v.every(onFieldGrid)) {
      throw new Error(`field at step ${ev.step}: ${k} must be three multiples of 2^-12 within ${FIELD_MAX} (quantiseVec3), got ${JSON.stringify(v)}`);
    }
  }
}

/** Whether a kick changes anything (a zero kick is no kick). */
export const kicks = (ev: FieldEvent): boolean => ev.kick !== undefined && (ev.kick[0] !== 0 || ev.kick[1] !== 0 || ev.kick[2] !== 0);

/** Whether gravity g differs from the current one in any component. */
export const gravityChanges = (current: Vec3, g: Vec3 | undefined): boolean => g !== undefined && (g[0] !== current[0] || g[1] !== current[1] || g[2] !== current[2]);

/**
 * The gravity in force during step `step` (the step from `step` to `step` + 1): SceneDesc.gravity, then each field
 * event with a gravity due at or before it, in event order. For the game's arc preview and for checks.
 */
export function fieldGravity(scene: Pick<SceneDesc, 'gravity' | 'inputs'>, step: number): Vec3 {
  let g: Vec3 = [...scene.gravity];
  // Stable by step, as the engines queue them (queueInputs).
  const due = scene.inputs.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'field' && e.step <= step).sort((a, b) => a[0].step - b[0].step || a[1] - b[1]);
  for (const [e] of due) if (e.kind === 'field' && e.gravity) g = [...e.gravity];
  return g;
}

/**
 * Field events that set gravity to g(step) for every step in [from, to), quantised, keyed only where the quantised
 * value changes from the step before (`before` is the gravity in force before `from`).
 */
export function scheduleEvents(from: number, to: number, g: (step: number) => Vec3, before: Vec3): FieldEvent[] {
  const out: FieldEvent[] = [];
  let cur = quantiseVec3(before);
  for (let s = from; s < to; s++) {
    const v = quantiseVec3(g(s));
    if (gravityChanges(cur, v)) { out.push({ step: s, kind: 'field', gravity: v }); cur = v; }
  }
  return out;
}

// ---- Exact trigonometry ----
// ECMAScript leaves Math.sin and Math.cos "implementation-approximated": V8 in Node, Chromium and Safari may
// differ in the last bit, so a quake keyed with Math.sin could land one key on the other side of a 2^-12
// rounding edge on another machine, and a level's quake would not be the same input everywhere. These use only
// + - * / and Math.round, which IEEE 754 and ECMAScript define exactly, so every engine computes the same bits.
// Range reduction by a two-part 2 pi, then an odd Taylor polynomial to x^19 on [-pi/2, pi/2]: within 1e-15 of the
// true sine near 0, and under 5e-13 out to |x| = 1500 rad where the reduction's rounding grows (field.test.ts); a
// quake's phase stays under 300 rad. All far below the field grid.
const TWO_PI_HI = 6.283185307179586, TWO_PI_LO = 2.4492935982947064e-16;
const PI_HI = 3.141592653589793, PI_LO = 1.2246467991473532e-16, HALF_PI = 1.5707963267948966;
// 1 / (2k + 1)! for k = 1..9, alternating signs folded in below.
const SIN_C = [1 / 6, 1 / 120, 1 / 5040, 1 / 362880, 1 / 39916800, 1 / 6227020800, 1 / 1307674368000, 1 / 355687428096000, 1 / 121645100408832000];

/** sin(x), the same bits on every engine (only exactly-defined operations); within 5e-13 of Math.sin for |x| < 1500. */
export function exactSin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const k = Math.round(x / TWO_PI_HI);
  let r = x - k * TWO_PI_HI - k * TWO_PI_LO;
  if (r > HALF_PI) r = PI_HI - r + PI_LO;
  else if (r < -HALF_PI) r = -PI_HI - r - PI_LO;
  const r2 = r * r;
  let p = 0;
  for (let i = SIN_C.length - 1; i >= 0; i--) p = (i % 2 === 0 ? -SIN_C[i]! : SIN_C[i]!) + r2 * p;
  return r + r * r2 * p;
}

/** cos(x) as exactSin(x + pi/2): the same bits on every engine. */
export const exactCos = (x: number): number => exactSin(x + HALF_PI);

/** The unit vector in the ground plane at `azimuth` radians from +x toward +z (exact trigonometry: the same on every engine). */
const along = (azimuth: number): Vec3 => [exactCos(azimuth), 0, exactSin(azimuth)];

/**
 * One key that turns gravity by `degrees` from straight down toward `azimuth` (radians from +x toward +z), keeping its
 * magnitude: a steady side load of |g| sin(degrees). A column of n cubes tips once the side load passes g / n.
 * Exact trigonometry (exactSin), so the key is the same on every engine.
 */
export function tiltEvent(step: number, degrees: number, base: Vec3, azimuth = 0): FieldEvent {
  const m = Math.sqrt(base[0] * base[0] + base[1] * base[1] + base[2] * base[2]), t = (degrees * Math.PI) / 180, a = along(azimuth);
  return { step, kind: 'field', gravity: quantiseVec3([m * exactSin(t) * a[0], -m * exactCos(t), m * exactSin(t) * a[2]]) };
}

export interface QuakeSpec {
  /** The first step of the quake. */
  step: number;
  /** How long it shakes (s). */
  seconds: number;
  /** The physics step (SceneDesc.dt, s). */
  dt: number;
  /** The peak side load as a fraction of |base| (0.3: 0.3 g). */
  peak: number;
  /** Shaking frequency (Hz; default 1). Probe X6 found no resonance: low frequencies do the damage, amplitude and duration are the levers. */
  hz?: number;
  /** Direction of the shaking in the ground plane, radians from +x toward +z (default 0). */
  azimuth?: number;
  /** Seconds the envelope takes to reach the peak and to fall back to 0 (defaults: a quarter of the quake each). */
  rise?: number;
  fall?: number;
}

/**
 * A quake: gravity base + peak |base| envelope(t) sin(2 pi hz t) along the azimuth, one quantised key per step that
 * changes it, and a last key at the end that restores `base`. The envelope rises linearly over `rise` seconds and
 * falls over `fall`. Seen from the ground it is the ground shaking side to side (a horizontal gravity on a still
 * ground is an accelerating ground in its own frame). Built from exactly-defined arithmetic only (exactSin), so the
 * same spec gives the same keys in Node and in every browser: a level's quake is one input everywhere.
 */
export function quakeEvents(q: QuakeSpec, base: Vec3): FieldEvent[] {
  const hz = q.hz ?? 1, a = along(q.azimuth ?? 0), rise = q.rise ?? q.seconds / 4, fall = q.fall ?? q.seconds / 4;
  if (!(q.seconds > 0 && q.dt > 0 && q.peak >= 0 && hz > 0 && rise >= 0 && fall >= 0)) throw new Error(`quakeEvents: bad spec ${JSON.stringify(q)}`);
  // Math.sqrt is exact (correctly rounded) everywhere; Math.hypot is not.
  const m = Math.sqrt(base[0] * base[0] + base[1] * base[1] + base[2] * base[2]), n = Math.round(q.seconds / q.dt);
  const env = (t: number) => Math.max(0, Math.min(1, rise > 0 ? t / rise : 1, fall > 0 ? (q.seconds - t) / fall : 1));
  const g = (s: number): Vec3 => {
    const t = (s - q.step) * q.dt, side = q.peak * m * env(t) * exactSin(2 * Math.PI * hz * t);
    return [base[0] + side * a[0], base[1], base[2] + side * a[2]];
  };
  const out = scheduleEvents(q.step, q.step + n, g, base);
  const last = out.at(-1)?.gravity ?? quantiseVec3(base);
  if (gravityChanges(last, quantiseVec3(base))) out.push({ step: q.step + n, kind: 'field', gravity: quantiseVec3(base) });
  return out;
}

/** A jolt: every moving body's velocity changes by dv (quantised) at `step`; the ground, seen from the bodies, moves by -dv. */
export const joltEvent = (step: number, dv: Vec3): FieldEvent => ({ step, kind: 'field', kick: quantiseVec3(dv) });

/** The field events in a list. */
export const fieldEvents = (events: readonly InputEvent[]): FieldEvent[] => events.flatMap((e) => (e.kind === 'field' ? [e] : []));
