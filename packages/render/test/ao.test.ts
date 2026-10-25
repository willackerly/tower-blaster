// The occupancy splat's CPU side (design step 13): the grid, the footprint
// rule and the splat twin, checked against hand-computed cases and volume
// conservation, so the GPU comparison in render.test.ts compares against
// something independently right.
import { describe, expect, it } from 'vitest';
import { AO_ONE, aoFootReference, aoGrid, composeReference, FOOT_SPHERE, splatReference, voxelCount, type AoGrid, type V3 } from '../src/index.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quat = (axis: V3, angle: number) => { const l = Math.hypot(...axis), s = Math.sin(angle / 2) / l; return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };
const ID = [0, 0, 0, 1];
const prod = (v: readonly number[]) => v[0]! * v[1]! * v[2]!;
const sum = (a: Uint32Array) => a.reduce((s, x) => s + x, 0);

describe('aoGrid', () => {
  it('covers the arena box clipped by its sphere, on a voxel-aligned origin', () => {
    const g = aoGrid({ center: [0.2, 4, 0], half: [30, 12, 30], radius: 25 });
    expect(g.voxel).toBe(0.5);
    expect(g.origin).toEqual([-25, -8, -25]); // floor(-24.8 / 0.5) * 0.5 on x; y from the box, not the sphere
    expect(g.dims).toEqual([104, 48, 100]); // up to 25.2, 16 and 25, rounded up to whole level-2 voxels (multiples of 4)
  });

  it('doubles the voxel until the grid fits the cap', () => {
    const g = aoGrid({ center: [0, 0, 0], half: [400, 50, 400] });
    expect(g.voxel).toBe(4); // 0.5 m would be 512M voxels, 2 m 8M
    expect(voxelCount(g)).toBeLessThanOrEqual(5_000_000);
    expect(voxelCount(aoGrid({ center: [0, 0, 0], half: [400, 50, 400] }, 2, 1e12))).toBeGreaterThan(5_000_000);
  });

  it('stops one coarsest texel under the floor, and only in y', () => {
    const arena = { center: [0.2, 4, 0] as V3, half: [30, 12, 30] as V3, radius: 25 };
    const all = aoGrid(arena);
    expect(aoGrid(arena, undefined, undefined, -Infinity)).toEqual(all);
    expect(aoGrid(arena, undefined, undefined, -20)).toEqual(all); // the arena ends above that floor
    for (const floorY of [0, 0.3, -1.1, 3]) {
      const g = aoGrid(arena, undefined, undefined, floorY);
      expect(g.voxel).toBe(0.5);
      // At least 4 voxels (one level-2 texel) under the floor, less than 5.
      expect(floorY - g.origin[1]).toBeGreaterThanOrEqual(4 * 0.5);
      expect(floorY - g.origin[1]).toBeLessThan(5 * 0.5);
      expect(Math.abs(g.origin[1] % 0.5)).toBe(0);
      expect([g.origin[0], g.origin[2]]).toEqual([all.origin[0], all.origin[2]]);
      expect([g.dims[0], g.dims[2]]).toEqual([all.dims[0], all.dims[2]]);
      expect(g.dims[1] % 4).toBe(0);
      expect(g.origin[1] + g.dims[1] * g.voxel).toBeGreaterThanOrEqual(16); // the top is kept
    }
    // A floor above the whole arena leaves one level-2 texel, not a negative grid.
    const above = aoGrid(arena, undefined, undefined, 100);
    expect(above.dims[1]).toBe(4);
    expect(above.origin[1]).toBeLessThanOrEqual(16);
  });

  it('the bench\'s far city (an arena sphere of radius 150 about y = 5): about half the voxels with the floor at 0', () => {
    const arena = { center: [0, 5, 0] as V3, half: [150, 150, 150] as V3, radius: 150 };
    const all = aoGrid(arena), clipped = aoGrid(arena, undefined, undefined, 0);
    expect(all.voxel).toBe(2);
    expect(clipped.voxel).toBe(2);
    expect(voxelCount(clipped) / voxelCount(all)).toBeLessThan(0.56); // 152 x 84 x 152 of 152 x 152 x 152
  });
});

describe('footprint', () => {
  it('is the box itself at rest, and keeps the volume at any rotation', () => {
    expect(aoFootReference(ID, [0.5, 0.25, 2], false)).toEqual([0.5, 0.25, 2]);
    const r = rng(5);
    for (let i = 0; i < 500; i++) {
      const half = [0.05 + r(), 0.05 + r() * 2, 0.05 + r() * 0.3];
      const q = quat([r() - 0.5, r() - 0.5, r() - 0.5], r() * 6.3);
      const f = aoFootReference(q, half, false);
      expect(prod(f) / prod(half)).toBeCloseTo(1, 5);
    }
  });

  it('turns a 45 degree cube into a box of AABB aspect, and a sphere into the cube of its volume', () => {
    const f = aoFootReference(quat([0, 1, 0], Math.PI / 4), [0.5, 0.5, 0.5], false);
    // AABB sqrt2 x 1 x sqrt2 halves, scaled by cbrt(1/2).
    const s = Math.cbrt(0.5);
    [Math.SQRT1_2 * s, 0.5 * s, Math.SQRT1_2 * s].forEach((v, k) => expect(f[k]).toBeCloseTo(v, 6));
    const sph = aoFootReference(ID, [0.6, 0, 0], true);
    expect(sph[0]).toBe(Math.fround(0.6 * FOOT_SPHERE));
    expect(8 * prod(sph)).toBeCloseTo((4 / 3) * Math.PI * 0.6 ** 3, 5);
  });

  it('is empty for a hidden body (FX scale 0)', () => {
    expect(aoFootReference(quat([1, 1, 0], 1), [0, 0, 0], false)).toEqual([0, 0, 0]);
    expect(aoFootReference(ID, [0, 0, 0], true)).toEqual([0, 0, 0]);
  });
});

describe('splatReference', () => {
  const g: AoGrid = { origin: [-4, -4, -4], voxel: 0.5, dims: [16, 16, 16] };
  const eye: V3 = [0, 0, 0];
  const at = (occ: Uint32Array, x: number, y: number, z: number) => occ[(z * 16 + y) * 16 + x]!;

  it('fills exactly the 8 voxels of a voxel-aligned unit cube', () => {
    const occ = splatReference([{ pos: [0, 0, 0], rot: ID, half: [0.5, 0.5, 0.5], sphere: false }], g, eye);
    let n = 0;
    occ.forEach((v) => { if (v) { n++; expect(v).toBe(AO_ONE); } });
    expect(n).toBe(8);
    expect(at(occ, 7, 7, 7)).toBe(AO_ONE); // voxel 7 spans -0.5..0
    expect(at(occ, 8, 8, 8)).toBe(AO_ONE);
  });

  it('splits a cube offset by a quarter voxel into 27 voxels of overlap products', () => {
    const occ = splatReference([{ pos: [0.125, 0.125, 0.125], rot: ID, half: [0.5, 0.5, 0.5], sphere: false }], g, eye);
    // Per axis it spans -0.375..0.625 m: voxels 7, 8, 9 by 0.75, 1, 0.25 (of 0.5 m).
    const o = [0.75, 1, 0.25];
    for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) expect(at(occ, 7 + x, 7 + y, 7 + z)).toBe(Math.round(o[x]! * o[y]! * o[z]! * AO_ONE));
    expect(sum(occ)).toBe(8 * AO_ONE);
  });

  it('conserves each body\'s volume inside the grid, whatever its rotation, size or shape', () => {
    const r = rng(9);
    for (let i = 0; i < 300; i++) {
      const sphere = r() < 0.2;
      const half = sphere ? [0.1 + r()] : [0.05 + r(), 0.05 + r() * 1.5, 0.05 + r() * 0.4];
      const b = { pos: [(r() - 0.5) * 3, (r() - 0.5) * 3, (r() - 0.5) * 3], rot: quat([r() - 0.5, r() - 0.5, r() - 0.5], r() * 6.3), half, sphere };
      const occ = splatReference([b], g, eye);
      const vol = sphere ? (4 / 3) * Math.PI * half[0]! ** 3 : 8 * prod(half);
      const touched = occ.reduce((n, v) => n + (v ? 1 : 0), 0);
      // Each touched voxel rounds by at most half a unit.
      expect(Math.abs(sum(occ) / AO_ONE - vol / 0.125)).toBeLessThan(1e-4 * vol / 0.125 + (touched * 0.5) / AO_ONE);
    }
  });

  it('clips at the grid edge and drops what lies outside', () => {
    const half = [0.5, 0.5, 0.5];
    // Centred on the low x face: half of it inside.
    const edge = splatReference([{ pos: [-4, 0.25, 0.25], rot: ID, half, sphere: false }], g, eye);
    expect(sum(edge)).toBe(4 * AO_ONE);
    expect(sum(splatReference([{ pos: [-9, 0, 0], rot: ID, half, sphere: false }], g, eye))).toBe(0);
    expect(sum(splatReference([{ pos: [0, 50, 0], rot: ID, half, sphere: false }], g, eye))).toBe(0);
  });

  it('places camera-relative records where the world says', () => {
    const e: V3 = [10.25, -3, 7];
    const world = splatReference([{ pos: [0.125, 0.125, 0.125], rot: ID, half: [0.5, 0.5, 0.5], sphere: false }], g, [0, 0, 0]);
    const rel = splatReference([{ pos: [0.125 - e[0], 0.125 - e[1], 0.125 - e[2]], rot: ID, half: [0.5, 0.5, 0.5], sphere: false }], g, e);
    expect(rel).toEqual(world);
  });
});

describe('composeReference', () => {
  const g: AoGrid = { origin: [0, 0, 0], voxel: 0.5, dims: [8, 16, 8] };
  const idx = (x: number, y: number, z: number) => (z * 16 + y) * 8 + x;

  it('a full layer: occupied in it, sky 1 above and exp(-k) below, at every level', () => {
    const occ = new Uint32Array(8 * 16 * 8);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) occ[idx(x, 10, z)] = 2 * AO_ONE; // over-full clamps to 1
    const [l0, l1, l2] = composeReference(occ, g, 0.5);
    const at = (l: typeof l0, y: number) => (3 * l!.dims[1] + y) * l!.dims[0] + 3;
    expect(l0!.r[at(l0, 10)]).toBe(1);
    expect(l0!.r[at(l0, 9)]).toBe(0);
    expect(l0!.g[at(l0, 10)]).toBe(1); // nothing above the layer itself
    expect(l0!.g[at(l0, 11)]).toBe(1);
    expect(l0!.g[at(l0, 9)]).toBeCloseTo(Math.exp(-0.5), 7);
    expect(l0!.g[at(l0, 0)]).toBeCloseTo(Math.exp(-0.5), 7);
    // Level 1 (1 m): the layer is half of voxel y 5; below it the same sky.
    expect(l1!.dims).toEqual([4, 8, 4]);
    expect(l1!.r[(1 * 8 + 5) * 4 + 1]).toBe(0.5);
    expect(l1!.g[(1 * 8 + 4) * 4 + 1]).toBeCloseTo(Math.exp(-0.5), 7);
    // Level 2 (2 m): a quarter of voxel y 2.
    expect(l2!.r[(0 * 4 + 2) * 2 + 0]).toBe(0.25);
    expect(l2!.g[(0 * 4 + 1) * 2 + 0]).toBeCloseTo(Math.exp(-0.5), 7);
  });

  it('levels are box filters of the clamped level 0', () => {
    const r = rng(12), occ = new Uint32Array(8 * 16 * 8).map(() => (r() < 0.3 ? Math.floor(r() * 1.5 * AO_ONE) : 0));
    const [l0, l1, l2] = composeReference(occ, g);
    for (const [l, s] of [[l1!, 2], [l2!, 4]] as const) {
      for (let z = 0; z < l.dims[2]; z++) for (let y = 0; y < l.dims[1]; y++) for (let x = 0; x < l.dims[0]; x++) {
        let m = 0;
        for (let dz = 0; dz < s; dz++) for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) m += l0!.r[((z * s + dz) * 16 + y * s + dy) * 8 + x * s + dx]!;
        expect(l.r[(z * l.dims[1] + y) * l.dims[0] + x]).toBeCloseTo(m / s ** 3, 6);
      }
    }
  });
});
