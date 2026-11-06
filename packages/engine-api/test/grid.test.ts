// Grid reductions (docs/design/grid.md) against a brute-force reading that
// shares no code with grid.ts: every body against every cell, in BigInt, with
// the naive aabb scalar of naive.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  chessDistance, dilate, EMPTY_TOP, emptySnapshot, floorDiv, type GridResult, type GridSpec, gridMetres, maskScore, type Quat, type ReduceInput,
  reduceGrid, type ShapeDesc, type Snapshot, TIER_FREE,
} from '../src/index.ts';
import { scalar } from './naive.ts';
import { bitsOf, quantBig } from './oracle.ts';

interface Body { p: number[]; q?: number[]; shape?: ShapeDesc; tier?: number }

const CUBE: ShapeDesc = { kind: 'box', half: [0.25, 0.25, 0.25] };

function world(bodies: Body[]): { snap: Snapshot; shapes: ShapeDesc[] } {
  const snap = emptySnapshot(bodies.length);
  if (bodies.some((b) => b.tier !== undefined)) snap.tier = new Uint8Array(bodies.length);
  bodies.forEach((b, i) => {
    snap.pos.set(b.p, 3 * i);
    snap.rot.set(b.q ?? [0, 0, 0, 1], 4 * i);
    if (b.tier !== undefined) snap.tier![i] = b.tier;
  });
  return { snap, shapes: bodies.map((b) => b.shape ?? CUBE) };
}

/** The brute-force reading: per body, per cell, BigInt; the same result shape as reduceGrid. */
function naiveGrid(spec: GridSpec, snap: Snapshot, shapes: ShapeDesc[], ids?: number[], weight?: number[]) {
  const s = spec.s ?? 16, [u, v] = spec.axes ?? [0, 2], w = 3 - u - v, [nu, nv] = spec.n;
  const qb = (x: number) => quantBig(bitsOf(x), s)!;
  const O = [qb(spec.origin[0]), qb(spec.origin[1])], C = [qb(spec.cell[0]), qb(spec.cell[1])];
  const inp: ReduceInput = { snap, prevLinVel: new Float64Array(0), prevCount: 0, shapes, tagWords: 0, tags: new Uint32Array(0), refs: [], gravity: [0, 0, 0], dt: 1 };
  const cells = nu * nv;
  const out = {
    count: new Array<number>(cells).fill(0), weight: new Array<number>(cells).fill(0), cover: new Array<number>(cells).fill(0), top: new Array<number>(cells).fill(EMPTY_TOP),
    projUc: new Array<number>(nu).fill(0), projUw: new Array<number>(nu).fill(0), projVc: new Array<number>(nv).fill(0), projVw: new Array<number>(nv).fill(0),
    total: { n: 0, weight: 0 }, outside: { n: 0, weight: 0 }, invalid: 0, removed: 0,
  };
  for (const id of ids ?? Array.from({ length: snap.count }, (_, i) => i)) {
    if (snap.tier?.[id] === TIER_FREE) { out.removed++; continue; }
    const wt = weight ? weight[id]! : 1;
    const P = [u, v, w].map((a) => scalar({ comp: 'pos', axis: a as 0 | 1 | 2, s }, inp, id));
    const lo = [u, v].map((a) => scalar({ aabb: 'lo', axis: a as 0 | 1 | 2, s }, inp, id));
    const hi = [u, v, w].map((a) => scalar({ aabb: 'hi', axis: a as 0 | 1 | 2, s }, inp, id));
    if ([...P, ...lo, ...hi].includes(null)) { out.invalid++; continue; }
    out.total.n++; out.total.weight += wt;
    const cellOf = (k: number, x: bigint, n: number) => {
      for (let i = 0; i < n; i++) if (O[k]! + BigInt(i) * C[k]! <= x && x < O[k]! + BigInt(i + 1) * C[k]!) return i;
      return -1;
    };
    const iu = cellOf(0, P[0]! as bigint, nu), jv = cellOf(1, P[1]! as bigint, nv);
    if (iu >= 0) { out.projUc[iu]!++; out.projUw[iu]! += wt; }
    if (jv >= 0) { out.projVc[jv]!++; out.projVw[jv]! += wt; }
    if (iu >= 0 && jv >= 0) { out.count[jv * nu + iu]!++; out.weight[jv * nu + iu]! += wt; } else { out.outside.n++; out.outside.weight += wt; }
    const meets = (k: number, i: number) => {
      const a = O[k]! + BigInt(i) * C[k]!, b = a + C[k]!, l = lo[k]! as bigint, h = hi[k]! as bigint;
      const he = h > l ? h : l + 1n;
      return l < b && he > a;
    };
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      if (!meets(0, i) || !meets(1, j)) continue;
      out.cover[j * nu + i]!++;
      out.top[j * nu + i] = Math.max(out.top[j * nu + i]!, Number(hi[2]!));
    }
  }
  return out;
}

function expectSame(r: GridResult, n: ReturnType<typeof naiveGrid>): void {
  expect([...r.count]).toEqual(n.count);
  expect([...r.weight]).toEqual(n.weight);
  expect([...r.cover]).toEqual(n.cover);
  expect([...r.top]).toEqual(n.top);
  expect([...r.projU.count]).toEqual(n.projUc);
  expect([...r.projU.weight]).toEqual(n.projUw);
  expect([...r.projV.count]).toEqual(n.projVc);
  expect([...r.projV.weight]).toEqual(n.projVw);
  expect(r.total).toEqual(n.total);
  expect(r.outside).toEqual(n.outside);
  expect(r.invalid).toBe(n.invalid);
  expect(r.removed).toBe(n.removed);
}

const unitQuat = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
  .map(([x, y, z, w]) => {
    const l = Math.hypot(x, y, z, w);
    return (l < 1e-3 ? [0, 0, 0, 1] : [x / l, y / l, z / l, w / l]) as Quat;
  });
const coord = fc.oneof(
  { weight: 12, arbitrary: fc.double({ min: -4, max: 4, noNaN: true }) },
  // Exactly on a 1/8 m lattice, where cell edges of the grids below fall.
  { weight: 4, arbitrary: fc.integer({ min: -32, max: 32 }).map((k) => k / 8) },
  { weight: 1, arbitrary: fc.constantFrom(NaN, Infinity, 1e12) },
);
const shape: fc.Arbitrary<ShapeDesc> = fc.oneof(
  fc.tuple(fc.double({ min: 0, max: 1.5, noNaN: true }), fc.double({ min: 0, max: 1.5, noNaN: true }), fc.double({ min: 0, max: 1.5, noNaN: true })).map(([a, b, c]) => ({ kind: 'box' as const, half: [a, b, c] as [number, number, number] })),
  fc.double({ min: 0, max: 1, noNaN: true }).map((r) => ({ kind: 'sphere' as const, radius: r })),
);
const body: fc.Arbitrary<Body> = fc.record({
  p: fc.tuple(coord, coord, coord), q: unitQuat, shape, tier: fc.constantFrom(undefined, 0, 1, TIER_FREE),
}, { requiredKeys: ['p', 'q', 'shape'] });
const spec: fc.Arbitrary<GridSpec> = fc.record({
  origin: fc.tuple(fc.integer({ min: -40, max: 8 }).map((k) => k / 8), fc.double({ min: -5, max: 1, noNaN: true })),
  cell: fc.tuple(fc.integer({ min: 1, max: 12 }).map((k) => k / 8), fc.double({ min: 0.05, max: 1.5, noNaN: true })),
  n: fc.tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 10 })),
  axes: fc.constantFrom<[0 | 1 | 2, 0 | 1 | 2]>([0, 2], [2, 0], [0, 1], [1, 2]),
  s: fc.constantFrom(8, 12, 16),
});

describe('reduceGrid', () => {
  it('matches the brute-force reading on random worlds, grids, axes and weights', () => {
    fc.assert(fc.property(fc.array(body, { minLength: 0, maxLength: 24 }), spec, fc.array(fc.integer({ min: 0, max: 2 ** 31 - 1 }), { minLength: 24, maxLength: 24 }), fc.boolean(), (bodies, g, weights, weighted) => {
      const { snap, shapes } = world(bodies);
      const w = weighted ? weights.slice(0, bodies.length) : undefined;
      expectSame(reduceGrid(g, { snap, shapes, weight: w }), naiveGrid(g, snap, shapes, undefined, w));
    }), { numRuns: 300, seed: 11 });
  });

  it('gives the same result for any order of the ids, and counts a repeated id each time', () => {
    fc.assert(fc.property(fc.array(body, { minLength: 1, maxLength: 20 }), spec, fc.integer(), (bodies, g, seed) => {
      const { snap, shapes } = world(bodies);
      const ids = bodies.map((_, i) => i);
      let x = seed | 0;
      for (let i = ids.length - 1; i > 0; i--) {
        x = (Math.imul(x, 1103515245) + 12345) | 0;
        const j = (x >>> 0) % (i + 1);
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      }
      const a = reduceGrid(g, { snap, shapes }), b = reduceGrid(g, { snap, shapes, ids });
      expect(b).toEqual(a);
      const twice = reduceGrid(g, { snap, shapes, ids: [...ids, ...ids] });
      expect([...twice.cover]).toEqual([...a.cover].map((c) => 2 * c));
      expect(twice.total.n).toBe(2 * a.total.n);
      expectSame(twice, naiveGrid(g, snap, shapes, [...ids, ...ids]));
    }), { numRuns: 100, seed: 12 });
  });

  it('covers one cell with a cube exactly one cell wide on the grid (half-open), and bins a centre on an edge to the higher cell', () => {
    const g: GridSpec = { origin: [0, 0], cell: [0.5, 0.5], n: [4, 4] };
    const { snap, shapes } = world([{ p: [0.75, 0.25, 0.25] }, { p: [1, 0.25, 1] }]);
    const r = reduceGrid(g, { snap, shapes });
    // Body 0 spans [0.5, 1) x [0, 0.5): cell (1, 0) only.
    // Body 1 is centred on the edge x = 1, z = 1: its centre bins to (2, 2); its box [0.75, 1.25)² meets (1..2, 1..2).
    const cells = (a: ArrayLike<number>) => Array.from(a).flatMap((c, k) => (c ? [`${k % 4},${Math.floor(k / 4)}:${c}`] : []));
    expect(cells(r.count)).toEqual(['1,0:1', '2,2:1']);
    expect(cells(r.cover)).toEqual(['1,0:1', '1,1:1', '2,1:1', '1,2:1', '2,2:1']);
    expect(gridMetres(r.top[1]!)).toBe(0.5);
    expect(r.top[0]).toBe(EMPTY_TOP);
    expect(gridMetres(r.top[0]!)).toBeNull();
  });

  it('reads the box the observer reads: a cube turned 45° about y covers its diagonal', () => {
    const g: GridSpec = { origin: [-1, -1], cell: [0.25, 0.25], n: [8, 8] };
    const c = Math.cos(Math.PI / 8), sn = Math.sin(Math.PI / 8);
    const { snap, shapes } = world([{ p: [0, 0.25, 0], q: [0, sn, 0, c] }]);
    const r = reduceGrid(g, { snap, shapes });
    // Half extent 0.25·√2 ≈ 0.354 on x and z: [-0.354, 0.354) meets cells 2..5 on each axis.
    const covered = [...r.cover].flatMap((x, k) => (x ? [k] : []));
    expect(covered.length).toBe(16);
    expect(covered.every((k) => k % 8 >= 2 && k % 8 <= 5 && Math.floor(k / 8) >= 2 && Math.floor(k / 8) <= 5)).toBe(true);
  });

  it('counts removed and invalid bodies apart, and off-grid centres as outside', () => {
    const g: GridSpec = { origin: [0, 0], cell: [1, 1], n: [2, 2] };
    const { snap, shapes } = world([{ p: [0.5, 0, 0.5] }, { p: [NaN, 0, 0] }, { p: [0.5, 0, 0.5], tier: TIER_FREE }, { p: [5, 0, 0.5] }]);
    const r = reduceGrid(g, { snap, shapes, weight: [3, 4, 5, 6] });
    expect(r.removed).toBe(1);
    expect(r.invalid).toBe(1);
    expect(r.total).toEqual({ n: 2, weight: 9 });
    expect(r.outside).toEqual({ n: 1, weight: 6 });
    // Body 3 is off the grid on u but within it on v: it counts in the v projection.
    expect([...r.projV.count]).toEqual([2, 0]);
    expect([...r.projU.count]).toEqual([1, 0]);
  });

  it('rejects bad specs, ids and weights', () => {
    const { snap, shapes } = world([{ p: [0, 0, 0] }]);
    const ok: GridSpec = { origin: [0, 0], cell: [1, 1], n: [2, 2] };
    expect(() => reduceGrid({ ...ok, n: [0, 2] }, { snap, shapes })).toThrow(/grid.n/);
    expect(() => reduceGrid({ ...ok, n: [1024, 1024] }, { snap, shapes })).toThrow(/cells/);
    expect(() => reduceGrid({ ...ok, cell: [1e-9, 1] }, { snap, shapes })).toThrow(/grid.cell/);
    expect(() => reduceGrid({ ...ok, axes: [1, 1] }, { snap, shapes })).toThrow(/grid.axes/);
    expect(() => reduceGrid({ ...ok, s: 30 }, { snap, shapes })).toThrow(/grid.s/);
    expect(() => reduceGrid({ ...ok, origin: [1e9, 0] }, { snap, shapes })).toThrow(/grid.origin/);
    expect(() => reduceGrid(ok, { snap, shapes, ids: [1] })).toThrow(/id 1/);
    expect(() => reduceGrid(ok, { snap, shapes: [] })).toThrow(/no shape for body 0/);
    expect(() => reduceGrid(ok, { snap, shapes, weight: [0.5] })).toThrow(/weight/);
    expect(() => reduceGrid(ok, { snap, shapes, weight: [2 ** 31] })).toThrow(/weight/);
  });
});

describe('floorDiv', () => {
  it('is exact over its range, near-integer quotients included', () => {
    // (2^31 − 2) / (2^30 − 1) = 2 exactly; one less is just under 2.
    expect(floorDiv(2 ** 31 - 3, 2 ** 30 - 1)).toBe(1);
    expect(floorDiv(-(2 ** 31) + 1, 3)).toBe(-715827883);
    fc.assert(fc.property(fc.integer({ min: -(2 ** 31) + 1, max: 2 ** 31 - 1 }), fc.integer({ min: 1, max: 2 ** 29 - 1 }), (a, c) => {
      const want = Number(BigInt(a) / BigInt(c) - (a < 0 && BigInt(a) % BigInt(c) !== 0n ? 1n : 0n));
      expect(floorDiv(a, c)).toBe(want);
    }), { numRuns: 2000, seed: 13 });
  });
});

describe('chessDistance and dilate', () => {
  it('match the brute-force chessboard distance', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 9 }), fc.array(fc.boolean(), { minLength: 81, maxLength: 81 }), fc.integer({ min: 0, max: 4 }), (nu, nv, bits, r) => {
      const mask = Uint8Array.from({ length: nu * nv }, (_, k) => (bits[k] ? 1 : 0));
      const d = chessDistance(mask, nu, nv), grown = dilate(mask, nu, nv, r);
      for (let k = 0; k < nu * nv; k++) {
        let best = -1;
        for (let m = 0; m < nu * nv; m++) if (mask[m]) {
          const dd = Math.max(Math.abs((k % nu) - (m % nu)), Math.abs(Math.floor(k / nu) - Math.floor(m / nu)));
          if (best < 0 || dd < best) best = dd;
        }
        expect(d[k]).toBe(best);
        expect(grown[k]).toBe(best >= 0 && best <= r ? 1 : 0);
      }
    }), { numRuns: 200, seed: 14 });
  });
});

describe('maskScore', () => {
  // A 6 x 6 grid of 1 m cells from (0, 0); a unit cube (half 0.4) at the centre of cell (i, j) covers it alone.
  const g: GridSpec = { origin: [0, 0], cell: [1, 1], n: [6, 6] };
  const at = (cells: [number, number][], y = 0.4): Body[] => cells.map(([i, j]) => ({ p: [i + 0.5, y, j + 0.5], shape: { kind: 'box', half: [0.4, 0.4, 0.4] } }));
  const maskOf = (cells: [number, number][]) => {
    const m = new Uint8Array(36);
    for (const [i, j] of cells) m[j * 6 + i] = 1;
    return m;
  };
  const L: [number, number][] = [[1, 1], [1, 2], [1, 3], [2, 3], [3, 3]];

  it('scores a shape on its own mask as perfect', () => {
    const { snap, shapes } = world(at(L));
    const sc = maskScore(reduceGrid(g, { snap, shapes }), maskOf(L));
    expect(sc).toMatchObject({ maskCells: 5, occCells: 5, hitCells: 5, fill: 1, iou: 1, spill: 0, reach: 0, outWeight: 0, inWeight: 5 });
    expect(gridMetres(sc.topIn)).toBeCloseTo(0.8, 4);
    expect(sc.topOut).toBe(EMPTY_TOP);
  });

  it('scores the shape moved one cell east: known fill, IoU, spill and reach', () => {
    const moved = L.map(([i, j]) => [i + 1, j] as [number, number]);
    const { snap, shapes } = world(at(moved));
    const sc = maskScore(reduceGrid(g, { snap, shapes }), maskOf(L));
    // Moved cells (2,1) (2,2) (2,3) (3,3) (4,3); in the mask: (2,3) (3,3).
    expect(sc).toMatchObject({ hitCells: 2, occCells: 5, maskCells: 5, fill: 2 / 5, iou: 2 / 8, spill: 3 / 5, reach: 1 });
  });

  it('weights spill by mass, counts off-grid weight as spilt, and reaches across the grid', () => {
    const { snap, shapes } = world([...at([[1, 1]]), ...at([[5, 5]]), { p: [20, 0, 20] }]);
    const r = reduceGrid(g, { snap, shapes, weight: [6, 1, 3] });
    const sc = maskScore(r, maskOf([[1, 1]]));
    expect(sc).toMatchObject({ inWeight: 6, outWeight: 4, spill: 0.4, reach: 4, occCells: 2, hitCells: 1 });
  });

  it('honours minCover, and rejects empty or mis-sized masks', () => {
    const { snap, shapes } = world([...at([[0, 0], [0, 0], [1, 0]])]);
    const r = reduceGrid(g, { snap, shapes });
    expect(maskScore(r, maskOf([[0, 0]]), 2)).toMatchObject({ occCells: 1, hitCells: 1, iou: 1 });
    expect(maskScore(r, maskOf([[0, 0]]))).toMatchObject({ occCells: 2, iou: 0.5 });
    expect(() => maskScore(r, new Uint8Array(36))).toThrow(/empty/);
    expect(() => maskScore(r, new Uint8Array(35).fill(1))).toThrow(/35 cells/);
  });

  it('scores an empty world as iou 0, fill 0, spill 0', () => {
    const { snap, shapes } = world([]);
    expect(maskScore(reduceGrid(g, { snap, shapes }), maskOf(L))).toMatchObject({ fill: 0, iou: 0, spill: 0, reach: 0 });
  });
});
