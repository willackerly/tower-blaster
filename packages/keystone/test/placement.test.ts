// Placement geometry (C9, placement.ts): the oriented-box overlap test against
// an independent point-sampling check, ray picks, and face snap landing a
// piece exactly where the level's own lattice would put it.
import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@tb/engine-api';
import {
  axisOf, compileLevel, type Hit, type LevelDef, normDeg, type Obb, obbOfBody, obbOverlap, PlacementIndex, rayGround, rayObb, snapPlace, yawOf, yawQuat,
} from '@tb/keystone';

const cube = (c: Vec3, half = 0.5, q: Quat = [0, 0, 0, 1]): Obb => ({ c, q, half: [half, half, half] });

/** A seeded uniform generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomQuat(r: () => number): Quat {
  const [u, v, w] = [r(), r(), r()];
  return [Math.sqrt(1 - u) * Math.sin(2 * Math.PI * v), Math.sqrt(1 - u) * Math.cos(2 * Math.PI * v), Math.sqrt(u) * Math.sin(2 * Math.PI * w), Math.sqrt(u) * Math.cos(2 * Math.PI * w)];
}
/** Whether world point p is inside box b (independent of the SAT code: local coordinates by the rotation's columns). */
function inside(b: Obb, p: Vec3): boolean {
  const d: Vec3 = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
  return ([0, 1, 2] as const).every((k) => { const a = axisOf(b.q, k); return Math.abs(a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) <= b.half[k]!; });
}
/** A point of box b at local fractions f in [-1, 1]^3. */
function pointOf(b: Obb, f: Vec3): Vec3 {
  const out: Vec3 = [...b.c];
  for (const k of [0, 1, 2] as const) { const a = axisOf(b.q, k); for (let i = 0; i < 3; i++) out[i]! += a[i]! * f[k]! * b.half[k]!; }
  return out;
}

describe('oriented-box overlap', () => {
  it('flush faces touch (about 0), a millimetre in overlaps, a millimetre apart does not', () => {
    expect(Math.abs(obbOverlap(cube([0, 0, 0]), cube([1, 0, 0])))).toBeLessThan(1e-12);
    expect(obbOverlap(cube([0, 0, 0]), cube([0.999, 0, 0]))).toBeCloseTo(0.001, 9);
    expect(obbOverlap(cube([0, 0, 0]), cube([1.001, 0, 0]))).toBeCloseTo(-0.001, 9);
    // A cube turned 45 deg about y beside an upright one: its edge reaches 0.5 sqrt 2 from its centre.
    const turned = cube([0.5 + Math.SQRT1_2 + 0.01, 0, 0], 0.5, yawQuat(45));
    expect(obbOverlap(cube([0, 0, 0]), turned)).toBeCloseTo(-0.01, 9);
    expect(obbOverlap(cube([0, 0, 0]), { ...turned, c: [0.5 + Math.SQRT1_2 - 0.01, 0, 0] })).toBeCloseTo(0.01, 9);
  });

  it('two edges crossing a gap apart: every face axis overlaps, the edge-edge axis separates', () => {
    // A diamond turned 45 deg about z, and above it one turned 45 deg about x: A's top edge (along z,
    // at y = sqrt 1/2) passes under B's bottom edge (along x, at 1.55 - sqrt 1/2), 1.55 - sqrt 2 apart.
    const rot = (axis: 0 | 2, deg: number): Quat => { const q: Quat = [0, 0, 0, Math.cos((deg * Math.PI) / 360)]; q[axis] = Math.sin((deg * Math.PI) / 360); return q; };
    const a = cube([0, 0, 0], 0.5, rot(2, 45)), b = cube([0, 1.55, 0], 0.5, rot(0, 45));
    const d: Vec3 = [0, 1.55, 0];
    for (const q of [a.q, b.q]) for (const k of [0, 1, 2] as const) {
      const u = axisOf(q, k), proj = (o: Obb) => ([0, 1, 2] as const).reduce<number>((s, i) => s + Math.abs(axisOf(o.q, i).reduce((t, x, j) => t + x * u[j]!, 0)) * o.half[i]!, 0);
      expect(proj(a) + proj(b) - Math.abs(u[0] * d[0] + u[1] * d[1] + u[2] * d[2])).toBeGreaterThan(0.2);
    }
    expect(obbOverlap(a, b)).toBeCloseTo(-(1.55 - Math.SQRT2), 9);
    // Independent check: no sampled point of b is in a.
    let hit = false;
    for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) for (let k = -10; k <= 10; k++) hit ||= inside(a, pointOf(b, [i / 10, j / 10, k / 10]));
    expect(hit).toBe(false);
  });

  it('agrees with point sampling on 400 random pairs', () => {
    const r = rng(7);
    let overlapping = 0, apart = 0;
    for (let n = 0; n < 400; n++) {
      const a: Obb = { c: [0, 0, 0], q: randomQuat(r), half: [0.2 + r(), 0.2 + r(), 0.2 + r()] };
      const b: Obb = { c: [3 * r() - 1.5, 3 * r() - 1.5, 3 * r() - 1.5], q: randomQuat(r), half: [0.2 + r(), 0.2 + r(), 0.2 + r()] };
      const depth = obbOverlap(a, b);
      if (Math.abs(depth) < 0.02) continue; // too close to call by sampling
      let hit = false;
      for (let i = -6; i <= 6 && !hit; i++) for (let j = -6; j <= 6 && !hit; j++) for (let k = -6; k <= 6 && !hit; k++) hit = inside(a, pointOf(b, [i / 6, j / 6, k / 6])) || inside(b, pointOf(a, [i / 6, j / 6, k / 6]));
      // Sampling can miss a shallow overlap (no sample lands in it), never invent one.
      if (hit) expect(depth).toBeGreaterThan(0);
      if (depth < 0) expect(hit).toBe(false);
      if (depth > 0) overlapping++; else apart++;
    }
    expect(overlapping).toBeGreaterThan(50);
    expect(apart).toBeGreaterThan(50);
  });
});

describe('yaw and rays', () => {
  it('yaw 0 is exactly the identity; yawOf reads a yaw back and refuses a tilt', () => {
    expect(yawQuat(0)).toEqual([0, 0, 0, 1]);
    expect(yawOf(yawQuat(37))).toBeCloseTo(37, 12);
    expect(yawOf(yawQuat(-120))).toBeCloseTo(-120, 12);
    expect(yawOf([Math.sin(0.1), 0, 0, Math.cos(0.1)])).toBeNull();
    // Local +z turns to (sin a, 0, cos a).
    const z = axisOf(yawQuat(30), 2);
    expect(z[0]).toBeCloseTo(Math.sin(Math.PI / 6), 12);
    expect(z[2]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(normDeg(190)).toBe(-170);
    expect(normDeg(-180)).toBe(180);
    expect(Object.is(normDeg(-360), 0)).toBe(true);
  });

  it('a ray enters a box on the face it meets, and meets the ground from above only', () => {
    const h = rayObb({ origin: [0, 5, 0], dir: [0, -1, 0] }, cube([0, 0, 0]));
    expect(h).toEqual({ t: 4.5, normal: [0, 1, 0] });
    const side = rayObb({ origin: [-5, 0.2, 0.1], dir: [2, 0, 0] }, cube([0, 0, 0]));
    expect(side!.t).toBeCloseTo(2.25, 12);
    expect(side!.normal).toEqual([-1, 0, 0]);
    // A box turned 90 deg: still the face toward the ray.
    const turned = rayObb({ origin: [0, 0, -5], dir: [0, 0, 1] }, { c: [0, 0, 0], q: yawQuat(90), half: [2, 0.5, 0.25] });
    expect(turned!.t).toBeCloseTo(3, 9);
    expect(turned!.normal[2]).toBeCloseTo(-1, 9);
    expect(rayObb({ origin: [0, 5, 0], dir: [0, 1, 0] }, cube([0, 0, 0]))).toBeNull();
    expect(rayObb({ origin: [3, 5, 0], dir: [0, -1, 0] }, cube([0, 0, 0]))).toBeNull();
    expect(rayGround({ origin: [0, 2, 0], dir: [1, -1, 0] })).toEqual({ t: 2, normal: [0, 1, 0] });
    expect(rayGround({ origin: [0, 2, 0], dir: [1, 1, 0] })).toBeNull();
  });

  it('an index picks the nearest face, skips what was removed, and falls through to the ground', () => {
    const ix = PlacementIndex.of([cube([0, 0.5, 0]), cube([0, 1.5, 0])], 2);
    const down = { origin: [0, 10, 0] as Vec3, dir: [0, -1, 0] as Vec3 };
    expect(ix.pick(down)).toMatchObject({ body: 1, normal: [0, 1, 0], point: [0, 2, 0] });
    ix.remove(1);
    expect(ix.pick(down)).toMatchObject({ body: 0, point: [0, 1, 0] });
    ix.remove(0);
    expect(ix.pick(down)).toMatchObject({ body: -1, point: [0, 0, 0] });
    expect(ix.near(cube([0, 0.5, 0]))).toEqual([]);
  });
});

describe('face snap', () => {
  // Three cubes in a row on the default lattice (h 0.5 m, gap 0.02 h), as compileLevel places them.
  const level: LevelDef = {
    id: 'SNAP', name: 'snap', version: 1, world: 0, lot: { min: [-5, -5], max: [5, 5] }, crownLine: 1, objective: { kind: 'crowns' }, par: 1,
    rack: ['marble'], launcher: { radius: 8, y: 1, dropY: 8 },
    parts: [{ kind: 'block', at: [0, 0, 0], size: [3, 2, 1], material: 'plaster' }],
  };
  const c = compileLevel(level), world = c.scene.bodies.map(obbOfBody), h = 0.5, pitch = 1.02, grid = { h, pitch };
  const halfCube: Vec3 = [h / 2, h / 2, h / 2];
  /** Where compileLevel would put a cube of cell (i, k, j). */
  const cell = (i: number, k: number, j: number): Vec3 => [(i + 0.5) * pitch * h, (k + 0.5) * h, (j + 0.5) * pitch * h];
  const near = (a: Vec3, b: Vec3) => a.forEach((x, k) => expect(x).toBeCloseTo(b[k]!, 12));
  const top = (i: number) => c.scene.bodies.findIndex((b) => b.pos[1] > h && Math.abs(b.pos[0] - cell(i, 1, 0)[0]) < 1e-9);

  it('a cube on a top face lands on the next course, centred or straddling by the pointer', () => {
    const t = top(1), b = world[t]!;
    const hit: Hit = { body: t, point: [b.c[0] + 0.03, 2 * h, b.c[2] - 0.05], normal: [0, 1, 0], t: 1 };
    near(snapPlace(hit, halfCube, 0, grid, world).box.c, cell(1, 2, 0));
    // Pointer near the cube's edge: the half-cell grid straddles two cells (a bond).
    const edge: Hit = { ...hit, point: [b.c[0] + 0.24, 2 * h, b.c[2]] };
    near(snapPlace(edge, halfCube, 0, grid, world).box.c, [cell(1, 2, 0)[0] + (pitch * h) / 2, 2.5 * h, cell(1, 2, 0)[2]]);
  });

  it('a cube on a side face lands in the neighbouring lattice cell, on the course the pointer is at', () => {
    const t = top(2), b = world[t]!;
    const hit: Hit = { body: t, point: [b.c[0] + h / 2, b.c[1] + 0.1, b.c[2] + 0.02], normal: [1, 0, 0], t: 1 };
    near(snapPlace(hit, halfCube, 0, grid, world).box.c, cell(3, 1, 0));
    // Low on the bottom cube's side: course 0.
    const low: Hit = { body: c.scene.bodies.findIndex((x) => x.pos[1] < h && Math.abs(x.pos[0] - cell(2, 0, 0)[0]) < 1e-9), point: [cell(2, 0, 0)[0] + h / 2, 0.05, 0.26], normal: [1, 0, 0], t: 1 };
    near(snapPlace(low, halfCube, 0, grid, world).box.c, cell(3, 0, 0));
  });

  it('on the ground: the half-cell grid, standing on y = 0; snap off follows the pointer', () => {
    const hit: Hit = { body: -1, point: [3.1, 0, -1.37], normal: [0, 1, 0], t: 1 };
    const s = (h * pitch) / 2;
    near(snapPlace(hit, halfCube, 0, grid, world).box.c, [Math.round(3.1 / s) * s, h / 2, Math.round(-1.37 / s) * s]);
    near(snapPlace(hit, halfCube, 0, grid, world, { snap: false }).box.c, [3.1, h / 2, -1.37]);
    // A domino (0.5 x 1 x 0.15 m) stands on its end: centre 0.5 m up whatever its yaw.
    expect(snapPlace(hit, [0.25, 0.5, 0.075], 33, grid, world).box.c[1]).toBeCloseTo(0.5, 12);
  });

  it('a piece on a turned body takes its yaw (align), or keeps its own', () => {
    const plank: Obb = { c: [0, 0.25, 0], q: yawQuat(30), half: [1, 0.25, 0.25] };
    const hit: Hit = { body: 0, point: [0, 0.5, 0], normal: [0, 1, 0], t: 1 };
    expect(snapPlace(hit, halfCube, 10, grid, [plank]).yaw).toBeCloseTo(40, 9);
    expect(snapPlace(hit, halfCube, 10, grid, [plank], { align: false }).yaw).toBe(10);
  });
});
