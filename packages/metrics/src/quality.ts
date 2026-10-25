// Quality metrics computed from snapshots. None of these run inside a timed
// region: the harness samples state between timing blocks.
import { type BodyDesc, inertiaOf, massOf, type Quat, type Snapshot, type Vec3 } from '@tb/engine-api';
import { boundingRadius, groundDepth, rotate, shapeDepth, spherePairs } from '@tb/geom';

const pos = (s: Snapshot, i: number): Vec3 => [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!];
const rot = (s: Snapshot, i: number): Quat => [s.rot[4 * i]!, s.rot[4 * i + 1]!, s.rot[4 * i + 2]!, s.rot[4 * i + 3]!];
const vel = (a: Float64Array, i: number): Vec3 => [a[3 * i]!, a[3 * i + 1]!, a[3 * i + 2]!];

export interface PenetrationStats { contacts: number; p50: number; p99: number; max: number }

/**
 * Penetration depths between every overlapping pair and against the ground,
 * divided by the characteristic length h (cube edge). Pairs that merely
 * touch (depth <= eps) are not counted as contacts.
 */
export function penetration(bodies: BodyDesc[], s: Snapshot, groundY: number | null, h = 1, eps = 1e-6): PenetrationStats {
  const n = s.count;
  const radii = Array.from({ length: n }, (_, i) => boundingRadius(bodies[i]!.shape));
  const depths: number[] = [];
  for (const [i, j] of spherePairs(s.pos, radii)) {
    const d = shapeDepth(bodies[i]!.shape, pos(s, i), rot(s, i), bodies[j]!.shape, pos(s, j), rot(s, j));
    if (d > eps) depths.push(d / h);
  }
  if (groundY !== null) {
    for (let i = 0; i < n; i++) {
      const d = groundDepth(bodies[i]!.shape, pos(s, i), rot(s, i), groundY);
      if (d > eps) depths.push(d / h);
    }
  }
  depths.sort((a, b) => a - b);
  const q = (p: number) => (depths.length ? depths[Math.min(depths.length - 1, Math.floor(p * depths.length))]! : 0);
  return { contacts: depths.length, p50: q(0.5), p99: q(0.99), max: depths.length ? depths[depths.length - 1]! : 0 };
}

/** Largest horizontal displacement of the selected bodies, divided by h. */
export function drift(s0: Snapshot, s1: Snapshot, indices?: number[], h = 1): number {
  let worst = 0;
  const idx = indices ?? Array.from({ length: Math.min(s0.count, s1.count) }, (_, i) => i);
  for (const i of idx) {
    worst = Math.max(worst, Math.hypot(s1.pos[3 * i]! - s0.pos[3 * i]!, s1.pos[3 * i + 2]! - s0.pos[3 * i + 2]!));
  }
  return worst / h;
}

/** RMS of |v|^2 + (h/2)^2 |w|^2 over bodies expected to be at rest. */
export function jitter(s: Snapshot, indices?: number[], h = 1): number {
  const idx = indices ?? Array.from({ length: s.count }, (_, i) => i);
  if (!idx.length) return 0;
  let sum = 0;
  for (const i of idx) {
    const v = vel(s.linVel, i), w = vel(s.angVel, i);
    sum += v[0] ** 2 + v[1] ** 2 + v[2] ** 2 + (h / 2) ** 2 * (w[0] ** 2 + w[1] ** 2 + w[2] ** 2);
  }
  return Math.sqrt(sum / idx.length);
}

export interface Energy { kinetic: number; potential: number; total: number }

/** Kinetic (linear + rotational, in the body frame) plus gravitational energy. */
export function energy(bodies: BodyDesc[], s: Snapshot, gravity: Vec3): Energy {
  let kinetic = 0, potential = 0;
  for (let i = 0; i < s.count; i++) {
    const b = bodies[i]!;
    const m = massOf(b), I = inertiaOf(b);
    const v = vel(s.linVel, i);
    const q = rot(s, i);
    const wb = rotate([-q[0], -q[1], -q[2], q[3]], vel(s.angVel, i)); // world -> body
    kinetic += 0.5 * m * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) + 0.5 * (I[0] * wb[0] ** 2 + I[1] * wb[1] ** 2 + I[2] * wb[2] ** 2);
    const p = pos(s, i);
    potential -= m * (gravity[0] * p[0] + gravity[1] * p[1] + gravity[2] * p[2]);
  }
  return { kinetic, potential, total: kinetic + potential };
}

/** Relative energy gain over a series: max(0, max E(t) - E(0)) / |E(0)|. */
export function energyGain(series: number[]): number {
  if (!series.length) return 0;
  const e0 = series[0]!;
  return Math.max(0, Math.max(...series) - e0) / Math.max(Math.abs(e0), 1e-12);
}

export function momentum(bodies: BodyDesc[], s: Snapshot): Vec3 {
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i < s.count; i++) {
    const m = massOf(bodies[i]!);
    px += m * s.linVel[3 * i]!;
    py += m * s.linVel[3 * i + 1]!;
    pz += m * s.linVel[3 * i + 2]!;
  }
  return [px, py, pz];
}

/**
 * For each tag in `tags`, top height at s1 divided by top height at s0;
 * returns the minimum. A tower "survives" when this stays >= 0.98.
 */
export function survival(bodies: BodyDesc[], s0: Snapshot, s1: Snapshot, tags: number[]): number {
  let worst = Infinity;
  for (const t of tags) {
    let top0 = -Infinity, top1 = -Infinity;
    for (let i = 0; i < s0.count; i++) {
      if (bodies[i]!.tag !== t) continue;
      top0 = Math.max(top0, s0.pos[3 * i + 1]!);
      top1 = Math.max(top1, s1.pos[3 * i + 1]!);
    }
    if (top0 > 0) worst = Math.min(worst, top1 / top0);
  }
  return worst === Infinity ? 1 : worst;
}

export function sleepRatio(s: Snapshot): number {
  if (!s.count) return 1;
  let asleep = 0;
  for (let i = 0; i < s.count; i++) if (!s.awake[i]) asleep++;
  return asleep / s.count;
}

export function nonFinite(s: Snapshot): number {
  let bad = 0;
  for (const a of [s.pos, s.rot, s.linVel, s.angVel]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) bad++;
  return bad;
}

/**
 * FNV-1a over the f32 bit patterns of positions and rotations: a cheap
 * fingerprint for determinism canaries. Differences below f32 precision do
 * not change it, which matches what GPU engines can represent.
 */
export function stateHash(s: Snapshot): string {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    f[0] = x;
    let w = u[0]!;
    for (let k = 0; k < 4; k++) {
      h ^= w & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      w >>>= 8;
    }
  };
  for (let i = 0; i < s.pos.length; i++) mix(s.pos[i]!);
  for (let i = 0; i < s.rot.length; i++) mix(s.rot[i]!);
  return h.toString(16).padStart(8, '0');
}
