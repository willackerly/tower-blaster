// The occupancy splat's CPU side (design step 13): the grid, the footprint
// rule and the splat twin, checked against hand-computed cases and volume
// conservation, so the GPU comparison in render.test.ts compares against
// something independently right.
import { describe, expect, it } from 'vitest';
import { AO_ONE, aoFootReference, aoGrid, FOOT_SPHERE, splatReference, voxelCount, type AoGrid, type V3 } from '../src/index.ts';

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
    expect(g.dims).toEqual([101, 48, 100]); // up to 25.2, 16 and 25
  });

  it('doubles the voxel until the grid fits the cap', () => {
    const g = aoGrid({ center: [0, 0, 0], half: [400, 50, 400] });
    expect(g.voxel).toBe(4); // 0.5 m would be 512M voxels, 2 m 8M
    expect(voxelCount(g)).toBeLessThanOrEqual(5_000_000);
    expect(voxelCount(aoGrid({ center: [0, 0, 0], half: [400, 50, 400] }, 2, 1e12))).toBeGreaterThan(5_000_000);
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
