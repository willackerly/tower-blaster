import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@tb/engine-api';
import { quatFromAxisAngle, quatMul, rotate } from '@tb/geom';
import { BRICK_WORDS, CUBE_ROTATIONS, EMPTY, Lattice, checkStorage, nearestCubeRotation } from '../src/index.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe('cube rotations', () => {
  it('are 24 distinct unit quaternions that map the axes onto signed axes', () => {
    expect(CUBE_ROTATIONS).toHaveLength(24);
    const mats = CUBE_ROTATIONS.map((q) => {
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
      const cols = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map((v) => rotate(q, v));
      for (const c of cols) for (const x of c) expect(near(x, 0) || near(Math.abs(x), 1)).toBe(true);
      return cols.flat().map((x) => Math.round(x)).join(',');
    });
    expect(new Set(mats).size).toBe(24);
  });

  it('form a group: every product is again one of them', () => {
    for (const a of CUBE_ROTATIONS)
      for (const b of CUBE_ROTATIONS) expect(nearestCubeRotation(quatMul(a, b)).angle).toBeLessThan(1e-7);
  });

  it('nearest symmetry recovers the index and the perturbation angle', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 23 }), fc.double({ min: 0, max: 0.5, noNaN: true }), fc.integer({ min: 0, max: 2 }), (idx, angle, ax) => {
      const axis: Vec3 = [0, 0, 0];
      axis[ax] = 1;
      const q = quatMul(quatFromAxisAngle(axis, angle), CUBE_ROTATIONS[idx]!);
      const r = nearestCubeRotation(q.map((x) => -x) as Quat); // sign of q must not matter
      expect(r.index).toBe(idx);
      expect(r.angle).toBeCloseTo(angle, 6);
    }));
  });
});

describe('Lattice storage', () => {
  const frame = { origin: [10, 0.5, -3] as Vec3, edge: 1 };

  it('round-trips cells and maps centres to cells', () => {
    const lat = new Lattice(frame, { nx: 4, ny: 70, nz: 3 });
    lat.insert(2, 65, 1, 7, 5);
    expect(lat.has(2, 65, 1)).toBe(true);
    expect(lat.idAt(2, 65, 1)).toBe(7);
    expect(lat.rotAt(2, 65, 1)).toBe(5);
    expect(lat.center(2, 65, 1)).toEqual([12, 65.5, -2]);
    expect(lat.nearest([12.3, 65.2, -2.4])).toEqual([2, 65, 1]);
    expect(lat.coords(lat.cell(2, 65, 1))).toEqual([2, 65, 1]);
    expect(() => lat.insert(2, 65, 1, 8)).toThrow(/already/);
    expect(() => lat.insert(4, 0, 0, 8)).toThrow(/outside/);
    expect(lat.remove(2, 65, 1)).toBe(7);
    expect(lat.idAt(2, 65, 1)).toBe(EMPTY);
    expect(() => lat.remove(2, 65, 1)).toThrow(/empty/);
    expect(lat.has(-1, 0, 0)).toBe(false);
  });

  it('matches a Map model under random inserts and removes (columns span several words)', () => {
    const dims = { nx: 3, ny: 71, nz: 2 };
    const cellArb = fc.tuple(fc.integer({ min: 0, max: dims.nx - 1 }), fc.integer({ min: 0, max: dims.ny - 1 }), fc.integer({ min: 0, max: dims.nz - 1 }));
    fc.assert(fc.property(fc.array(fc.tuple(fc.boolean(), cellArb), { maxLength: 300 }), (ops) => {
      const lat = new Lattice(frame, dims);
      const model = new Map<string, number>();
      let nextId = 0;
      for (const [ins, [i, j, k]] of ops) {
        const key = `${i},${j},${k}`;
        if (ins && !model.has(key)) { lat.insert(i, j, k, nextId); model.set(key, nextId++); }
        if (!ins && model.has(key)) { expect(lat.remove(i, j, k)).toBe(model.get(key)); model.delete(key); }
      }
      expect(checkStorage(lat)).toEqual([]);
      expect(lat.count).toBe(model.size);
      for (let i = 0; i < dims.nx; i++)
        for (let k = 0; k < dims.nz; k++) {
          const want = [...model.keys()].map((s) => s.split(',').map(Number)).filter(([a, , c]) => a === i && c === k).map(([, b]) => b!).sort((a, b) => a - b);
          expect(lat.occupiedFrom(i, k, 0)).toEqual(want);
          const from = 33;
          expect(lat.occupiedFrom(i, k, from)).toEqual(want.filter((j) => j >= from));
        }
    }));
  });

  it('exports 8^3 brick masks that agree with the cells, and tracks dirty bricks', () => {
    const lat = new Lattice(frame, { nx: 13, ny: 9, nz: 10 });
    const cells: Array<[number, number, number]> = [[0, 0, 0], [7, 7, 7], [8, 0, 0], [12, 8, 9], [3, 8, 2]];
    cells.forEach(([i, j, k], n) => lat.insert(i, j, k, n));
    const { keys, masks } = lat.bricks();
    expect(keys.length).toBe(4); // (0,0,0) holds three cells; the others one each
    let bitsSet = 0;
    keys.forEach((key, n) => {
      const m = masks.subarray(n * BRICK_WORDS, (n + 1) * BRICK_WORDS);
      for (let b = 0; b < 512; b++) {
        if (!((m[b >>> 5]! >>> (b & 31)) & 1)) continue;
        bitsSet++;
        const lx = b & 7, ly = (b >> 3) & 7, lz = b >> 6;
        const bj = key % lat.nby, rest = (key - bj) / lat.nby, bi = rest % lat.nbx, bk = (rest - bi) / lat.nbx;
        expect(lat.has(bi * 8 + lx, bj * 8 + ly, bk * 8 + lz)).toBe(true);
      }
    });
    expect(bitsSet).toBe(cells.length);
    expect(lat.takeDirtyBricks().keys).toEqual(keys);
    expect(lat.takeDirtyBricks().keys.length).toBe(0);
    lat.remove(12, 8, 9);
    const d = lat.takeDirtyBricks();
    expect([...d.keys]).toEqual([lat.brickKey(12, 8, 9)]);
    expect([...d.masks].every((w) => w === 0)).toBe(true); // now empty, still reported
  });
});
