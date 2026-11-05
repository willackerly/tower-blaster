// Scenes for the mode probes, built the way the game builds a level (keystone
// compileLevel): metres, real gravity, 60 Hz, a plaster ground at y = 0 with
// friction 0.6, friction combined by 'min', and Keystone's solver settings
// (40 iterations, 3e-5 m loaded-gap slop). A probe that departs from these
// says so in its case.
import type { BodyDesc, InputEvent, Quat, SceneDesc, Vec3 } from '@tb/engine-api';
import { QUAT_IDENTITY, rotate } from '@tb/geom';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, MATERIALS } from '@tb/keystone';

export const PLASTER = MATERIALS[0];
export const STONE = MATERIALS[1];
export const STEEL = MATERIALS[5];
export const GRAVITY = 9.81;
export const DT = 1 / 60;

/** The AVBD params Keystone plays at (driver.ts AVBD_ITERATIONS, AVBD_GAP_SLOP). */
export const GAME_PARAMS = { iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP } as const;

export interface BoxOpts { density?: number; friction?: number; restitution?: number; tag?: number; linVel?: Vec3; angVel?: Vec3 }

export function box(pos: Vec3, half: Vec3, rot: Quat = QUAT_IDENTITY, o: BoxOpts = {}): BodyDesc {
  return {
    shape: { kind: 'box', half }, pos, rot, linVel: o.linVel ?? [0, 0, 0], angVel: o.angVel ?? [0, 0, 0],
    density: o.density ?? PLASTER.density, friction: o.friction ?? PLASTER.friction, restitution: o.restitution ?? 0, tag: o.tag ?? 0,
  };
}

export function ball(pos: Vec3, radius: number, linVel: Vec3, o: Omit<BoxOpts, 'linVel'> = {}): BodyDesc {
  return {
    shape: { kind: 'sphere', radius }, pos, rot: QUAT_IDENTITY, linVel, angVel: o.angVel ?? [0, 0, 0],
    density: o.density ?? STEEL.density, friction: o.friction ?? STEEL.friction, restitution: o.restitution ?? 0, tag: o.tag ?? -1,
  };
}

/** A scene as compileLevel makes one (header); `extra` overrides any field. */
export function gameScene(id: string, params: SceneDesc['params'], bodies: BodyDesc[], inputs: InputEvent[] = [], extra: Partial<SceneDesc> = {}): SceneDesc {
  return {
    id, params, seed: 1, gravity: [0, -GRAVITY, 0], dt: DT, ground: { y: 0, friction: PLASTER.friction }, sleep: true, frictionCombine: 'min',
    bodies, inputs: [...inputs].sort((a, b) => a.step - b.step), ...extra,
  };
}

/** Rotation about +y by `a` radians: local +z turns to (sin a, 0, cos a). */
export const yaw = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

/** Angle in degrees between body i's local +y and world +y, from a structure-of-arrays rot. */
export function tiltDeg(rot: ArrayLike<number>, i: number): number {
  const x = rot[4 * i]!, z = rot[4 * i + 2]!;
  // The y component of q (0, 1, 0) q*: 1 - 2 (x^2 + z^2).
  const c = Math.max(-1, Math.min(1, 1 - 2 * (x * x + z * z)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** World-space corners of a box body (8, any order). */
export function corners(b: BodyDesc): Vec3[] {
  if (b.shape.kind !== 'box') throw new Error('corners: not a box');
  const [hx, hy, hz] = b.shape.half, out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const r = rotate(b.rot, [sx * hx, sy * hy, sz * hz]);
    out.push([b.pos[0] + r[0], b.pos[1] + r[1], b.pos[2] + r[2]]);
  }
  return out;
}

/** mulberry32, as @tb/scenarios rng: one stream per seed, identical everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform draw in [-1, 1). */
export const sym = (r: () => number) => 2 * r() - 1;

/** Least-squares slope of y on x; NaN with fewer than two distinct x. */
export function slope(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : NaN;
}

/**
 * Two-sample Kolmogorov-Smirnov test: the largest gap D between the samples' empirical CDFs, and its p-value
 * from the asymptotic Kolmogorov distribution with Stephens' small-sample correction
 * (sqrt(ne) + 0.12 + 0.11 / sqrt(ne), ne = n m / (n + m)); Numerical Recipes' probks.
 */
export function ks2(a: readonly number[], b: readonly number[]): { D: number; p: number } {
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  let i = 0, j = 0, D = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i]!, y[j]!);
    while (i < x.length && x[i]! <= v) i++;
    while (j < y.length && y[j]! <= v) j++;
    D = Math.max(D, Math.abs(i / x.length - j / y.length));
  }
  const ne = (x.length * y.length) / (x.length + y.length), lam = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * D;
  return { D, p: kolmogorovQ(lam) };
}

/** Q_KS(lambda) = 2 sum_{k>=1} (-1)^(k-1) exp(-2 k^2 lambda^2), 1 near 0. */
export function kolmogorovQ(lam: number): number {
  if (lam < 1e-3) return 1;
  let sum = 0, prev = 0;
  for (let k = 1; k <= 100; k++) {
    const term = 2 * (k % 2 ? 1 : -1) * Math.exp(-2 * k * k * lam * lam);
    sum += term;
    if (Math.abs(term) <= 1e-10 * Math.abs(prev) || Math.abs(term) < 1e-12) return Math.min(1, Math.max(0, sum));
    prev = term;
  }
  return 1;
}
