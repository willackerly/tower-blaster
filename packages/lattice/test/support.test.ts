// The loose column rule against a brute-force oracle: a cell is supported iff
// the cell below it is supported (height 0 rests on the base). The oracle
// works on a plain set of cells and iterates to a fixed point.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import { checkStorage, checkSupport, detach, firstGap, Lattice, looseColumns } from '../src/index.ts';

const frame = { origin: [0, 0.5, 0] as Vec3, edge: 1 };
const key = (i: number, j: number, k: number) => `${i},${j},${k}`;

/** Remove unsupported cells from a set until none are left; returns the removed ones. */
function oracleCollapse(cells: Set<string>): Set<string> {
  const removed = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const c of cells) {
      const [i, j, k] = c.split(',').map(Number) as [number, number, number];
      if (j > 0 && !cells.has(key(i, j - 1, k))) { cells.delete(c); removed.add(c); changed = true; }
    }
  }
  return removed;
}

const dims = { nx: 4, ny: 40, nz: 3 };
const cellArb = fc.tuple(fc.integer({ min: 0, max: dims.nx - 1 }), fc.integer({ min: 0, max: dims.ny - 1 }), fc.integer({ min: 0, max: dims.nz - 1 }));
/** Arbitrary occupancy, mostly low columns so that legal and illegal cases both occur. */
const occupancyArb = fc.uniqueArray(cellArb.map(([i, j, k]) => [i, j % 9, k] as [number, number, number]), { selector: (c) => key(...c), maxLength: 80 });

function fill(cells: Array<[number, number, number]>): Lattice {
  const lat = new Lattice(frame, dims);
  cells.forEach(([i, j, k], n) => lat.insert(i, j, k, n));
  return lat;
}

/** Full legal towers: random column heights. */
const towersArb = fc.array(fc.integer({ min: 0, max: dims.ny }), { minLength: dims.nx * dims.nz, maxLength: dims.nx * dims.nz });
function towers(heights: number[]): Lattice {
  const lat = new Lattice(frame, dims);
  let id = 0;
  for (let k = 0; k < dims.nz; k++) for (let i = 0; i < dims.nx; i++) for (let j = 0; j < heights[k * dims.nx + i]!; j++) lat.insert(i, j, k, id++);
  return lat;
}

describe('loose column support', () => {
  it('violations are exactly the cells the oracle removes', () => {
    fc.assert(fc.property(occupancyArb, (cells) => {
      const lat = fill(cells);
      const want = oracleCollapse(new Set(cells.map((c) => key(...c))));
      const got = new Set(looseColumns.violations(lat).map((c) => key(...lat.coords(c))));
      expect(got).toEqual(want);
    }));
  });

  it('firstGap finds the lowest empty height across word boundaries', () => {
    const lat = new Lattice(frame, { nx: 1, ny: 70, nz: 1 });
    expect(firstGap(lat, 0, 0)).toBe(0);
    for (let j = 0; j < 70; j++) lat.insert(0, j, 0, j);
    expect(firstGap(lat, 0, 0)).toBe(70);
    lat.remove(0, 45, 0);
    expect(firstGap(lat, 0, 0)).toBe(45);
    lat.remove(0, 31, 0);
    expect(firstGap(lat, 0, 0)).toBe(31);
  });

  it('detach keeps the lattice legal, returns exactly the oracle closure, and conserves cubes', () => {
    fc.assert(fc.property(towersArb, fc.array(fc.array(cellArb, { maxLength: 6 }), { maxLength: 8 }), (heights, rounds) => {
      const lat = towers(heights);
      const total = lat.count;
      const oracle = new Set<string>();
      lat.forEach((i, j, k) => oracle.add(key(i, j, k)));
      const out = new Set<number>();
      for (const hits of rounds) {
        const direct = hits.filter(([i, j, k]) => oracle.has(key(i, j, k)));
        const res = detach(lat, looseColumns, hits);
        // Oracle: remove the hit cells, then collapse.
        for (const c of direct) oracle.delete(key(...c));
        const lost = oracleCollapse(oracle);
        expect(new Set(res.filter((d) => d.cause === 'direct').map((d) => key(d.i, d.j, d.k)))).toEqual(new Set(direct.map((c) => key(...c))));
        expect(new Set(res.filter((d) => d.cause === 'support').map((d) => key(d.i, d.j, d.k)))).toEqual(lost);
        for (const d of res) { expect(out.has(d.id)).toBe(false); out.add(d.id); }
        expect(checkSupport(lat, looseColumns)).toEqual([]); // no floating cubes
        expect(checkStorage(lat)).toEqual([]);
        expect(lat.count + out.size).toBe(total);
      }
    }));
  });

  it('canInsert accepts exactly the cells that keep the lattice legal', () => {
    fc.assert(fc.property(towersArb, cellArb, (heights, [i, j, k]) => {
      const lat = towers(heights.map((h) => Math.min(h, dims.ny - 1)));
      const ok = looseColumns.canInsert(lat, i, j, k);
      if (lat.has(i, j, k)) { expect(ok).toBe(false); return; }
      lat.insert(i, j, k, 1e6);
      expect(ok).toBe(looseColumns.violations(lat).length === 0);
    }));
  });

  it('detach orders requested cells first, then lost cells by ascending cell index', () => {
    const lat = towers(new Array(dims.nx * dims.nz).fill(5));
    const res = detach(lat, looseColumns, [[2, 3, 1], [0, 1, 0], [2, 3, 1]]);
    expect(res.slice(0, 2).map((d) => [d.i, d.j, d.k])).toEqual([[2, 3, 1], [0, 1, 0]]);
    const rest = res.slice(2).map((d) => lat.cell(d.i, d.j, d.k));
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
    expect(res).toHaveLength(2 + 1 + 3); // (2,4,1) above the first hit, (0,2..4,0) above the second
  });
});
