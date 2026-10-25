import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CmpOp, emptySnapshot, gatherRows, mergeOut, type Output, type OutResult, type Pred, type ReduceInput, reduceRef, type ReduceSpec,
  type Scalar, type ShapeDesc, type VecSrc, type Vec3,
} from '../src/index.ts';
import { exactEdge, KEYSTONE, keystoneSpec, q } from './keystone.ts';
import { naiveReduce, rotation } from './naive.ts';

interface Body {
  p?: number[]; q?: number[]; v?: number[]; w?: number[]; awake?: number; shape?: ShapeDesc;
  tags?: number[]; prev?: number[]; ref?: (number[] | null)[];
}
interface Opts { tagWords?: number; prevCount?: number; gravity?: Vec3; dt?: number }

const CUBE: ShapeDesc = { kind: 'box', half: [0.5, 0.5, 0.5] };

/** A ReduceInput from per-body fields; prev defaults to v, ref slots without a row are NaN-filled. */
function state(bodies: Body[], o: Opts = {}): ReduceInput {
  const n = bodies.length, tw = o.tagWords ?? 2, snap = emptySnapshot(n);
  const prev = new Float64Array(3 * n), tags = new Uint32Array(n * tw);
  const refs = [0, 1].map((slot) => (bodies.some((b) => b.ref?.[slot]) ? new Float64Array(3 * n).fill(NaN) : null));
  bodies.forEach((b, i) => {
    snap.pos.set(b.p ?? [0, 0, 0], 3 * i);
    snap.rot.set(b.q ?? [0, 0, 0, 1], 4 * i);
    snap.linVel.set(b.v ?? [0, 0, 0], 3 * i);
    snap.angVel.set(b.w ?? [0, 0, 0], 3 * i);
    snap.awake[i] = b.awake ?? 1;
    prev.set(b.prev ?? b.v ?? [0, 0, 0], 3 * i);
    tags.set((b.tags ?? []).map((t) => t >>> 0), i * tw);
    b.ref?.forEach((r, slot) => r && refs[slot]!.set(r, 3 * i));
  });
  return {
    snap, prevLinVel: prev, prevCount: o.prevCount ?? n, shapes: bodies.map((b) => b.shape ?? CUBE), tagWords: tw, tags, refs,
    gravity: o.gravity ?? [0, 0, 0], dt: o.dt ?? 1 / 60,
  };
}

/** reduceRef, checked against the naive evaluator on the way. */
function reduce(spec: ReduceSpec, inp: ReduceInput, lo?: number, hi?: number): OutResult[] {
  const r = reduceRef(spec, inp, lo, hi);
  expect(r).toEqual(naiveReduce(spec, inp, lo, hi));
  return r;
}

/** The scalar's value on a one-body state, or null for ⊥. */
function value(x: Scalar, b: Body, o?: Opts): number | null {
  const [r] = reduce({ outputs: [{ op: 'max', x, where: 'all' }] }, state([b], o));
  expect(r!.n + r!.invalid).toBe(1);
  return r!.max!;
}

const P = (axis: 0 | 1 | 2, s?: number): Scalar => ({ comp: 'pos', axis, ...(s === undefined ? {} : { s }) });
const sphere = (radius: number): ShapeDesc => ({ kind: 'sphere', radius });
const box = (...half: Vec3): ShapeDesc => ({ kind: 'box', half });
const G: Vec3 = [0, -9.81, 0];

describe('reduceRef scalars (§3.3)', () => {
  it('comp quantizes the f32 value at its s', () => {
    expect(value(P(0), { p: [1.5, -2.25, 3] })).toBe(98304);
    expect(value(P(1), { p: [1.5, -2.25, 3] })).toBe(-147456);
    expect(value(P(2, 0), { p: [0, 0, 2.5] })).toBe(2);
    expect(value({ comp: 'linVel', axis: 1, s: 10 }, { v: [0, -0.1, 0] })).toBe(-102);
    expect(value({ comp: 'angVel', axis: 2, s: 24 }, { w: [0, 0, -31.5] })).toBe(-528482304);
    expect(value(P(0), { p: [NaN, 0, 0] })).toBe(null);
    expect(value(P(0), { p: [8192, 0, 0] })).toBe(null);
    expect(value(P(0, 15), { p: [8192, 0, 0] })).toBe(2 ** 28);
  });

  it("dv: quant(v) − quant(prev) − G at the scalar's own s; ⊥ for entering ids and ⊥ prev", () => {
    // G_y = quant(-9.81/60, 16) = -10715 and quant(-9.81/60, 8) = -42.
    const b: Body = { v: [0, 1, 0], prev: [0, 0.5, 0] };
    expect(value({ comp: 'dv', axis: 1 }, b, { gravity: G })).toBe(65536 - 32768 + 10715);
    expect(value({ comp: 'dv', axis: 1, s: 8 }, b, { gravity: G })).toBe(256 - 128 + 42);
    expect(value({ comp: 'dv', axis: 0 }, b, { gravity: G })).toBe(0);
    expect(value({ comp: 'dv', axis: 1 }, b, { gravity: G, prevCount: 0 })).toBe(null);
    expect(value({ norm2: 'dv' }, { v: [0, 0, 0], prev: [0, NaN, 0] }, { gravity: G })).toBe(null);
    // Free fall from rest reads dv = 0 up to the quantum.
    expect(value({ comp: 'dv', axis: 1 }, { v: [0, -9.81 / 60, 0], prev: [0, 0, 0] }, { gravity: G })).toBe(0);
  });

  it('disp: quant(pos) − quant(ref); ⊥ with no ref row, a NaN ref, or an uncaptured slot', () => {
    const b: Body = { p: [1, 2, 3], ref: [[0.5, 2, 4]] };
    expect(value({ comp: { disp: 0 }, axis: 0 }, b)).toBe(32768);
    expect(value({ comp: { disp: 0 }, axis: 2 }, b)).toBe(-65536);
    expect(value({ norm2: { disp: 0 } }, b)).toBe(32768 ** 2 + 65536 ** 2);
    expect(value({ norm2: { disp: 1 } }, b)).toBe(null);
    expect(value({ comp: { disp: 0 }, axis: 1 }, { p: [1, 2, 3], ref: [[0, NaN, 0]] })).toBe(null);
    // A ref captured before a spawn covers only the ids it saw.
    const inp = state([b, { p: [1, 2, 3] }]);
    inp.refs = [inp.refs[0]!.subarray(0, 3), null];
    expect(reduce({ outputs: [{ op: 'count', where: { cmp: { norm2: { disp: 0 } }, op: '>=', k: 0 } }] }, inp)).toEqual([{ n: 1, invalid: 1 }]);
  });

  it('norm2: Σ min(|c|, 2^25)², ⊥ if any component is', () => {
    expect(value({ norm2: 'linVel', s: 0 }, { v: [3, 4, 0] })).toBe(25);
    expect(value({ norm2: 'linVel' }, { v: [3, -4, 0] })).toBe(25 * 2 ** 32);
    expect(value({ norm2: 'linVel' }, { v: [1024, 0, 0] })).toBe(2 ** 50);
    expect(value({ norm2: 'angVel' }, { w: [-512, 512, 600] })).toBe(3 * 2 ** 50);
    expect(value({ norm2: 'angVel' }, { w: [0, 0, Infinity] })).toBe(null);
  });

  it('aabb: identity, 45° about z, a corner quaternion at the largest H, and an unnormalized one', () => {
    const at: Body = { p: [1, 2, 3] };
    expect(value({ aabb: 'lo', axis: 0 }, at)).toBe(32768);
    expect(value({ aabb: 'hi', axis: 1 }, at)).toBe(163840);
    expect(value({ aabb: 'hi', axis: 2 }, { ...at, shape: box(0.5, 0.25, 0.125) })).toBe(196608 + 8192);
    // Q = (0, 0, 6270, 15137): R00 = 189809656, R01 = -189817980, so ext_x = ⌊379627636·32768 / 2^28⌋ = 46341.
    const z45 = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    expect(value({ aabb: 'hi', axis: 0 }, { ...at, q: z45 })).toBe(65536 + 46341);
    expect(value({ aabb: 'lo', axis: 1 }, { ...at, q: z45 })).toBe(131072 - 46341);
    expect(value({ aabb: 'hi', axis: 2 }, { ...at, q: z45 })).toBe(196608 + 32768);
    // Q = -2^14 on every component: row 0 is (-3·2^28, 0, 2^30), so ext = 7H with H = 2^20.
    expect(value({ aabb: 'hi', axis: 0 }, { q: [-1, -1, -1, -1], shape: box(16, 16, 16) })).toBe(7 * 2 ** 20);
    // Norm 1.5 with components ≤ 1 is taken as is: row 0 is (-3·2^27, 2^29, 2^28).
    expect(value({ aabb: 'hi', axis: 0 }, { q: [1, 1, 0.5, 0] })).toBe(((3 * 2 ** 27 + 2 ** 29 + 2 ** 28) * 32768) / 2 ** 28);
    expect(value({ aabb: 'hi', axis: 1 }, { q: [-0, -0, -0, 1] })).toBe(32768);
  });

  it('aabb: H bounds, negative extents, component bounds; spheres never read rot', () => {
    expect(value({ aabb: 'hi', axis: 0 }, { shape: box(16, 1, 1) })).toBe(2 ** 20);
    expect(value({ aabb: 'hi', axis: 0 }, { shape: box(16 + 2 ** -16, 1, 1) })).toBe(null);
    expect(value({ aabb: 'lo', axis: 2 }, { shape: box(1, 1, -0.5) })).toBe(null);
    expect(value({ aabb: 'hi', axis: 1 }, { q: [1 + 2 ** -14, 0, 0, 0] })).toBe(null);
    expect(value({ aabb: 'hi', axis: 1 }, { q: [0, 0, 0, NaN] })).toBe(null);
    expect(value({ aabb: 'hi', axis: 1 }, { p: [0, 5, 0], shape: sphere(2) })).toBe(7 * 65536);
    expect(value({ aabb: 'hi', axis: 1 }, { p: [0, 5, 0], q: [NaN, 2, -7, Infinity], shape: sphere(2) })).toBe(7 * 65536);
    expect(value({ aabb: 'lo', axis: 0 }, { shape: sphere(-1) })).toBe(null);
    expect(value({ aabb: 'lo', axis: 0 }, { shape: sphere(16 + 2 ** -16) })).toBe(null);
  });

  it('aabb equals the BigInt matrix on every Q14 corner combination, with no entry beyond 2^30', () => {
    const corners = [-(2 ** 14), -(2 ** 14) + 1, -1, 0, 1, 2 ** 14 - 1, 2 ** 14].map((c) => c / 2 ** 14);
    const bodies: Body[] = [];
    for (const x of corners) for (const y of corners) for (const z of corners) for (const w of corners) bodies.push({ q: [x, y, z, w], shape: box(16, 0.5, 3) });
    expect(bodies.length).toBe(7 ** 4);
    const inp = state(bodies);
    for (const axis of [0, 1, 2] as const) reduce({ outputs: [{ op: 'hist', by: { x: { aabb: 'hi', axis }, edges: [0, 2 ** 20, 2 ** 22, 3 * 2 ** 22] }, where: 'all' }] }, inp);
    let biggest = 0n;
    for (const b of bodies) for (const row of rotation(b.q!.map((c) => BigInt(c * 2 ** 14)))) for (const e of row) biggest = e > biggest ? e : -e > biggest ? -e : biggest;
    expect(biggest).toBe(2n ** 30n);
  });

  it('tag: unsigned fields; words beyond tags read 0', () => {
    const b: Body = { tags: [0xdeadbeef] };
    expect(value({ tag: 0 }, b)).toBe(0x5eadbeef);
    expect(value({ tag: 0, shift: 31, bits: 1 }, b)).toBe(1);
    expect(value({ tag: 0, shift: 8, bits: 8 }, b)).toBe(0xbe);
    expect(value({ tag: 0, shift: 1 }, b)).toBe(0xdeadbeef >>> 1);
    expect(value({ tag: 1 }, b)).toBe(0);
    const inp = state([b, { tags: [7] }]);
    inp.tags = inp.tags.subarray(0, 2);
    expect(reduce({ outputs: [{ op: 'hist', by: { tag: 0, bits: 3, bins: 8 }, where: 'all' }] }, inp)[0]!.bins).toEqual(new Uint32Array([1, 0, 0, 0, 0, 0, 0, 1]));
  });
});

describe('reduceRef predicates (§3.4)', () => {
  const NAN: Body = { p: [NaN, 0, 0] };
  const leaf = { T: 'all', F: { not: 'all' }, U: { cmp: P(0), op: '>', k: 0 } } as const satisfies Record<string, Pred>;
  type Tri = keyof typeof leaf;
  function truth(p: Pred, b: Body = NAN): Tri {
    const [r] = reduce({ outputs: [{ op: 'count', where: p }] }, state([b]));
    return r!.n ? 'T' : r!.invalid ? 'U' : 'F';
  }
  // The table, written out: the first operand that is not the identity decides.
  const seq = (vals: Tri[], id: Tri): Tri => vals.find((v) => v !== id) ?? id;

  it('and, or over every list of up to three T, F, ⊥ operands, left to right', () => {
    const lists: Tri[][] = [[]];
    for (let len = 1; len <= 3; len++) for (const l of lists.filter((x) => x.length === len - 1)) for (const v of ['T', 'F', 'U'] as Tri[]) lists.push([...l, v]);
    expect(lists.length).toBe(40);
    for (const l of lists) {
      expect(truth({ and: l.map((v) => leaf[v]) })).toBe(seq(l, 'T'));
      expect(truth({ or: l.map((v) => leaf[v]) })).toBe(seq(l, 'F'));
    }
    expect(truth({ and: [leaf.U, leaf.F] })).toBe('U');
    expect(truth({ and: [leaf.F, leaf.U] })).toBe('F');
    expect(truth({ or: [leaf.U, leaf.T] })).toBe('U');
    expect(truth({ or: [leaf.T, leaf.U] })).toBe('T');
  });

  it('not and cmp keep ⊥; awake reads awake = 1', () => {
    expect(truth({ not: leaf.U })).toBe('U');
    expect(truth({ not: leaf.T })).toBe('F');
    expect(truth({ not: leaf.F })).toBe('T');
    expect(truth({ not: { not: leaf.U } })).toBe('U');
    expect(truth(leaf.U)).toBe('U');
    expect(truth('awake', { awake: 1 })).toBe('T');
    expect(truth('awake', { awake: 0 })).toBe('F');
    expect(truth('awake', { awake: 2 })).toBe('F'); // awake = 1, not nonzero
    expect(truth({ and: ['awake', leaf.U] }, { p: [NaN, 0, 0], awake: 0 })).toBe('F');
  });

  it('every cmp op at k − 1, k and k + 1', () => {
    const at = (op: string, k: number) => truth({ cmp: P(0, 0), op, k } as Pred, { p: [5, 0, 0] });
    const want: Record<string, string> = { '<': 'FFT', '<=': 'FTT', '>': 'TFF', '>=': 'TTF', '==': 'FTF', '!=': 'TFT' };
    for (const [op, w] of Object.entries(want)) expect([4, 5, 6].map((k) => at(op, k)).join('')).toBe(w);
  });

  it('a structure test first: a non-structure body with no ref is excluded, a structure one is invalid', () => {
    const structure: Pred = { cmp: { tag: 0, bits: 1 }, op: '==', k: 1 };
    const displaced: Pred = { and: [structure, { cmp: { norm2: { disp: 0 } }, op: '>', k: 2 ** 28 }] };
    const inp = state([{ tags: [1], ref: [[0, 0, 0]] }, { tags: [0] }, { tags: [1] }]);
    expect(reduce({ outputs: [{ op: 'count', where: displaced }] }, inp)).toEqual([{ n: 0, invalid: 1 }]);
  });
});

describe('reduceRef outputs (§3.5)', () => {
  const sum = (x: Scalar, weight: number | undefined, shift: number, bodies: Body[]) =>
    reduce({ outputs: [{ op: 'sum', x, ...(weight === undefined ? {} : { weight }), shift, where: 'all' }] }, state(bodies))[0]!;
  const X0 = P(0, 0);
  const w = (weight: number, x: number): Body => ({ p: [x, 0, 0], tags: [weight] });

  it('count: n where T, invalid where ⊥', () => {
    const bodies: Body[] = [{ p: [1, 0, 0] }, { p: [-1, 0, 0] }, { p: [NaN, 0, 0] }, { p: [2, 0, 0] }];
    expect(reduce({ outputs: [{ op: 'count', where: { cmp: P(0), op: '>', k: 0 } }] }, state(bodies))).toEqual([{ n: 2, invalid: 1 }]);
  });

  it('sum: floor of w·x / 2^shift, weight absent is 1, x ⊥ is invalid', () => {
    expect(sum(X0, 0, 1, [w(-3, 1)])).toEqual({ n: 1, invalid: 0, sum: -2, sat: 0 });
    expect(sum(X0, 0, 1, [w(3, 1)])).toEqual({ n: 1, invalid: 0, sum: 1, sat: 0 });
    expect(sum(X0, undefined, 0, [w(5, 7), w(5, -2), { p: [NaN, 0, 0] }])).toEqual({ n: 2, invalid: 1, sum: 5, sat: 0 });
    expect(sum(P(0), 0, 16, [w(9810, 10)])).toEqual({ n: 1, invalid: 0, sum: 98100, sat: 0 });
  });

  it('sum: a product of exactly -2^31 clamps to -(2^31 - 1) and counts in sat, at every shift', () => {
    for (let k = 0; k <= 28; k++) expect(sum(X0, 0, k, [w(0x80000000, 2 ** k)])).toEqual({ n: 1, invalid: 0, sum: -(2 ** 31 - 1), sat: 1 });
    expect(sum(X0, 0, 0, [w(0x7fffffff, 1)])).toEqual({ n: 1, invalid: 0, sum: 2 ** 31 - 1, sat: 0 });
    expect(sum(X0, 0, 0, [w(0x80000001, 1)])).toEqual({ n: 1, invalid: 0, sum: -(2 ** 31 - 1), sat: 0 });
    expect(sum(X0, 0, 0, [w(2 ** 30, 2)])).toEqual({ n: 1, invalid: 0, sum: 2 ** 31 - 1, sat: 1 });
    expect(sum(X0, 0, 1, [w(2 ** 30, 2)])).toEqual({ n: 1, invalid: 0, sum: 2 ** 30, sat: 0 });
  });

  it('sum: products beyond 2^53 are exact', () => {
    // x = 2^28 + 1 from a sphere of radius 1 at x = 2^28 (s 0): w·x ≈ 2^59.
    const big: Body[] = [{ p: [2 ** 28, 0, 0], shape: sphere(1), tags: [0x7fffffff] }, { p: [2 ** 28, 0, 0], shape: sphere(1), tags: [0x80000001] }];
    const hiX: Scalar = { aabb: 'hi', axis: 0, s: 0 };
    expect(sum(hiX, 0, 30, big.slice(0, 1)).sum).toBe(536870913);
    expect(sum(hiX, 0, 30, big.slice(1)).sum).toBe(-536870914);
    expect(sum(hiX, 0, 0, big)).toEqual({ n: 2, invalid: 0, sum: 0, sat: 2 });
    expect(sum(hiX, 0, 62, big)).toEqual({ n: 2, invalid: 0, sum: -1, sat: 0 });
  });

  it('sum: totals beyond 2^32, alternating signs, 100k terms of 2^31 − 1', () => {
    expect(sum(X0, 0, 0, Array.from({ length: 4 }, () => w(0x7fffffff, 1))).sum).toBe(4 * (2 ** 31 - 1));
    expect(sum(X0, 0, 0, Array.from({ length: 5 }, (_, i) => w(i % 2 ? 0x80000001 : 0x7fffffff, 1))).sum).toBe(2 ** 31 - 1);
    const n = 100_000, snap = emptySnapshot(n);
    snap.pos.fill(1);
    const inp: ReduceInput = { ...state([]), snap, shapes: [], tagWords: 1, tags: new Uint32Array(n).fill(0x7fffffff), prevLinVel: new Float64Array(3 * n), prevCount: n };
    expect(reduceRef({ outputs: [{ op: 'sum', x: X0, weight: 0, where: 'all' }] }, inp)).toEqual([{ n, invalid: 0, sum: 214_748_364_700_000, sat: 0 }]);
  });

  it('max: null for an empty set, negative values, every body ⊥', () => {
    const max = (x: Scalar, bodies: Body[], where: Pred = 'all') => reduce({ outputs: [{ op: 'max', x, where }] }, state(bodies))[0];
    expect(max(P(0), [])).toEqual({ n: 0, invalid: 0, max: null });
    expect(max(P(0), [{ p: [-3, 0, 0] }, { p: [-1, 0, 0] }, { p: [-2, 0, 0] }])).toEqual({ n: 3, invalid: 0, max: -65536 });
    expect(max(P(0), [{ p: [5, 0, 0] }], { not: 'all' })).toEqual({ n: 0, invalid: 0, max: null });
    expect(max(P(0), Array.from({ length: 5 }, () => ({ p: [NaN, 0, 0] })))).toEqual({ n: 0, invalid: 5, max: null });
    expect(max({ norm2: 'linVel', s: 0 }, [{ v: [3, 4, 0] }, { v: [0, 0, 6] }, { v: [1, 1, 1] }])).toEqual({ n: 3, invalid: 0, max: 36 });
  });

  it('hist by tag: fields ≥ bins are dropped, not counted in n', () => {
    const bodies = [0, 3, 4, 7, 2, 11].map((t) => ({ tags: [t << 4] }));
    const [r] = reduce({ outputs: [{ op: 'hist', by: { tag: 0, shift: 4, bits: 3, bins: 4 }, where: 'all' }] }, state(bodies));
    expect(r).toEqual({ n: 4, invalid: 0, bins: new Uint32Array([1, 0, 1, 2]), dropped: 2 });
  });

  it('hist by edges: upper bound, duplicate edges, x below every edge, x ⊥', () => {
    const bodies = [-1, 0, 4, 5, 6, NaN, -(2 ** 20)].map((x) => ({ p: [x, 0, 0] }));
    const [r] = reduce({ outputs: [{ op: 'hist', by: { x: X0, edges: [0, 0, 5] }, where: 'all' }] }, state(bodies));
    expect(r).toEqual({ n: 6, invalid: 1, bins: new Uint32Array([2, 0, 2, 2]), dropped: 0 });
    const [one] = reduce({ outputs: [{ op: 'hist', by: { x: X0, edges: [] }, where: 'all' }] }, state(bodies));
    expect(one).toEqual({ n: 6, invalid: 1, bins: new Uint32Array([6]), dropped: 0 });
  });

  it('where ⊥ is invalid whatever x is; where F ignores a ⊥ x', () => {
    const bodies: Body[] = [{ p: [NaN, 1, 0] }, { p: [1, NaN, 0] }, { p: [NaN, NaN, 0] }];
    const where: Pred = { cmp: P(1), op: '>', k: 0 };
    const out = reduce({ outputs: [{ op: 'max', x: P(0), where }, { op: 'sum', x: P(0), where: { not: where } }] }, state(bodies));
    expect(out).toEqual([{ n: 0, invalid: 3, max: null }, { n: 0, invalid: 2, sum: 0, sat: 0 }]);
  });
});

describe('reduceRef domain', () => {
  it.each([0, 1, 255, 256, 257, 1023, 1024, 1025, 100_003])('n = %i', (n) => {
    const snap = emptySnapshot(n);
    for (let i = 0; i < n; i++) snap.pos[3 * i] = i;
    const inp: ReduceInput = { ...state([]), snap, shapes: [], tagWords: 0, tags: new Uint32Array(0), prevLinVel: new Float64Array(0), prevCount: 0 };
    const h = Math.floor(n / 2);
    const out = reduceRef({
      outputs: [
        { op: 'count', where: 'all' }, { op: 'sum', x: P(0, 0), where: 'all' }, { op: 'max', x: P(0, 0), where: 'all' },
        { op: 'hist', by: { x: P(0, 0), edges: [h] }, where: 'all' }, { op: 'count', where: { cmp: { comp: 'dv', axis: 0 }, op: '==', k: 0 } },
      ],
    }, inp);
    expect(out).toEqual([
      { n, invalid: 0 }, { n, invalid: 0, sum: n ? (n * (n - 1)) / 2 : 0, sat: 0 }, { n, invalid: 0, max: n ? n - 1 : null },
      { n, invalid: 0, bins: new Uint32Array([h, n - h]), dropped: 0 }, { n: 0, invalid: n },
    ]);
  });

  it('rejects a bad id range and a domain over 2^22', () => {
    const inp = state([{}, {}]);
    expect(() => reduceRef({ outputs: [] }, inp, 1, 3)).toThrow(RangeError);
    expect(() => reduceRef({ outputs: [] }, inp, 2, 1)).toThrow(RangeError);
    expect(() => reduceRef({ outputs: [] }, { ...inp, snap: { ...inp.snap, count: 2 ** 22 + 1 } })).toThrow(/2\^22/);
  });
});

describe('the keystone spec (§4) on a hand-built state', () => {
  // top = 0.1: e_5 = 513, not the f64 512, so T = 512 is bin 4 and T = 513 bin 5.
  const LEVEL = { lot: { min: [-4, -3] as [number, number], max: [4, 3] as [number, number] }, unit: 0.5, height: 0.1 };
  const spec = keystoneSpec(LEVEL);
  const r0 = sphere(0);
  const st = (id: number, b: Body): Body => ({ shape: r0, tags: [1 | (id << 8), 9810], ...b });
  const y = (t: number) => t / 65536;
  const bodies: Body[] = [
    st(0, { p: [0, y(512), 0] }),
    st(1, { p: [0, y(513), 0] }),
    st(2, { p: [0, y(-5), 0] }),
    st(3, { p: [0, 0, 0] }),
    st(4, { p: [0, y(6452), 0] }),
    st(5, { p: [0, y(6451), 0], w: [0, 0, 3] }),
    st(6, { p: [1.25, 0.25, 0], ref: [[1, 0.25, 0]] }), // displaced exactly 0.5 h: not displaced
    st(7, { p: [1.25 + 2 ** -16, 0.25, 0], ref: [[1, 0.25, 0]] }), // one quantum more
    st(8, { p: [4.25 + 2 ** -16, 0.25, 0] }), // out of lot
    st(9, { p: [4.25, 0.25, 0] }), // on the lot edge
    st(10, { p: [0, 0.25, 0], awake: 0, v: [20, 0, 0], prev: [0, 0, 0] }), // asleep
    st(11, { p: [0, 1, 0], v: [0, 0.9, 0], prev: [0, 0, 0] }), // an impact
    st(12, { p: [0, 2, 0], shape: box(0.5, 0.25, 0.5), v: [0, -9.81 / 60, 0], prev: [0, 0, 0] }), // free fall: no impact
    { p: [0, 0.3, 0], v: [2, 0, 0], shape: sphere(0.2) }, // ammo, live at exactly 0.6 h
    { p: [0, 0.3 - 2 ** -16, 0], v: [10, 0, 0], w: [0, 9, 0], shape: sphere(0.2) }, // ammo just below
    { p: [7, 1, 0], shape: sphere(0.2) }, // ammo outside the lot + 4 h
    { p: [0, 1, 0], v: [3, 0, 0], shape: sphere(0.2) }, // ammo that entered this step
  ];
  for (const b of bodies) b.ref ??= [b.p!];
  const inp = state(bodies, { gravity: G, prevCount: 16 });
  inp.refs = [inp.refs[0]!.subarray(0, 3 * 16), null];

  it('every output by hand', () => {
    expect(spec.outputs[KEYSTONE.heightHist]).toMatchObject({ by: { edges: expect.arrayContaining([103, 205, 308, 410, 513, 6452]) } });
    expect(spec.outputs[KEYSTONE.impacts]).toMatchObject({ where: { and: [{}, 'awake', { k: 2_748_779_069 }] } });
    const out = reduce(spec, inp);
    // Structure 0-12 less the sleeper, plus the live ammo 13 and 16.
    expect(out[KEYSTONE.nAwake]).toEqual({ n: 14, invalid: 0 });
    expect(out[KEYSTONE.maxSpeed]).toEqual({ n: 14, invalid: 0, max: (3 * 65536) ** 2 });
    expect(out[KEYSTONE.maxAngSpeed]).toEqual({ n: 14, invalid: 0, max: (3 * 65536) ** 2 });
    // Σ ⌊9810·y_q / 2^16⌋: 76 + 76 - 1 + 0 + 965 + 965 + 5·2452 + 9810 + 19620.
    expect(out[KEYSTONE.pe]).toEqual({ n: 13, invalid: 0, sum: 43771, sat: 0 });
    expect(out[KEYSTONE.displaced]).toEqual({ n: 1, invalid: 0 });
    expect(out[KEYSTONE.outOfLot]).toEqual({ n: 1, invalid: 0 });
    const bins = new Uint32Array(64);
    Object.assign(bins, { 0: 2, 4: 1, 5: 1, 62: 1, 63: 8 });
    expect(out[KEYSTONE.heightHist]).toEqual({ n: 13, invalid: 0, bins, dropped: 0 });
    const impacts = new Uint32Array(48);
    impacts[11] = 1;
    expect(out[KEYSTONE.impacts]).toEqual({ n: 1, invalid: 0, bins: impacts, dropped: 0 });
  });

  it('heightHist bins equal clamp(⌊64T / (top·2^16)⌋, 0, 63) of top as a binary rational', () => {
    const top = 0.1, m = BigInt(Math.round(top * 2 ** 56)); // 0.1 = m·2^-56 exactly
    expect(Number(m) / 2 ** 56).toBe(top);
    const edges = Array.from({ length: 63 }, (_, j) => exactEdge(j + 1, top));
    for (const T of [-1, 0, 102, 103, 512, 513, 6451, 6452, 2 ** 20]) {
      const want = T < 0 ? 0 : Math.min(63, Number(((BigInt(T) * 64n) << 56n) / (m << 16n)));
      expect(edges.filter((e) => e <= T).length).toBe(want);
    }
  });

  it('a NaN structure body is counted invalid, not folded into pe', () => {
    const nan = state([...bodies, st(17, { p: [NaN, NaN, NaN] })], { gravity: G, prevCount: 16 });
    const out = reduce(spec, nan);
    expect(out[KEYSTONE.pe]).toEqual({ n: 13, invalid: 1, sum: 43771, sat: 0 });
    expect(out[KEYSTONE.nAwake]!.invalid).toBe(0); // or(structure, …) is T before the NaN box tests
  });
});

// Random states and specs: values on and around quanta, ties, limits and ⊥.
const TW = 2;
const coord = fc.oneof(
  fc.double({ min: -20, max: 20, noNaN: true }),
  fc.integer({ min: -(2 ** 20), max: 2 ** 20 }).map((k) => k / 2 ** 16),
  fc.integer({ min: -(2 ** 20), max: 2 ** 20 }).map((k) => (2 * k + 1) / 2 ** 17),
  fc.constantFrom(NaN, Infinity, -Infinity, -0, 0, 8192, 8192 - 2 ** -11, -8192, 2 ** 28, 32, 1e30, 2 ** -149),
  fc.double(),
);
const qc = fc.oneof(
  fc.double({ min: -1, max: 1, noNaN: true }),
  fc.constantFrom(-(2 ** 14), -(2 ** 14) + 1, -1, 0, 1, 2 ** 14 - 1, 2 ** 14).map((c) => c / 2 ** 14),
  fc.constantFrom(1 + 2 ** -14, -1 - 2 ** -14, NaN, -0, 0.5),
);
const extent = fc.oneof(fc.double({ min: 0, max: 20, noNaN: true }), fc.constantFrom(-0.5, 0, 16, 16 + 2 ** -16, NaN, 0.5));
const shape: fc.Arbitrary<ShapeDesc> = fc.oneof(
  fc.tuple(extent, extent, extent).map((half) => ({ kind: 'box' as const, half })),
  extent.map((radius) => ({ kind: 'sphere' as const, radius })),
);
const word = fc.oneof(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 300 }), fc.constantFrom(0x80000000, 0xffffffff, 0x7fffffff, 0x80000001, 9810));
const vecs = (n: number, per: number, v: fc.Arbitrary<number>) => fc.array(v, { minLength: per * n, maxLength: per * n });

const arbState = (maxN: number, full = false) =>
  fc.integer({ min: 0, max: maxN }).chain((n) =>
    fc.record({
      pos: vecs(n, 3, coord), rot: vecs(n, 4, qc), lin: vecs(n, 3, coord), ang: vecs(n, 3, coord), prev: vecs(n, 3, coord),
      awake: vecs(n, 1, fc.constantFrom(0, 1)), shapes: fc.array(shape, { minLength: n, maxLength: n }),
      tags: full ? vecs(n, TW, word) : fc.array(word, { maxLength: TW * n }),
      prevCount: full ? fc.constant(n) : fc.integer({ min: 0, max: n }),
      refs: fc.tuple(...[0, 1].map(() => fc.option(fc.integer({ min: full ? n : 0, max: n }).chain((m) => vecs(m, 3, coord)), { nil: null }))),
      gravity: fc.tuple(fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true })),
      dt: fc.constantFrom(1 / 60, 1 / 120, 0.01),
    }).map((r): ReduceInput => {
      const snap = emptySnapshot(n);
      snap.pos.set(r.pos); snap.rot.set(r.rot); snap.linVel.set(r.lin); snap.angVel.set(r.ang); snap.awake.set(r.awake);
      return {
        snap, prevLinVel: Float64Array.from(r.prev), prevCount: r.prevCount, shapes: r.shapes, tagWords: TW, tags: Uint32Array.from(r.tags),
        refs: r.refs.map((x) => (x ? Float64Array.from(x) : null)), gravity: r.gravity as Vec3, dt: r.dt,
      };
    }),
  );

const src: fc.Arbitrary<VecSrc> = fc.oneof(fc.constantFrom<VecSrc>('pos', 'linVel', 'angVel', 'dv'), fc.integer({ min: 0, max: 2 }).map((disp) => ({ disp })));
const scale = fc.option(fc.oneof(fc.integer({ min: 0, max: 24 }), fc.constantFrom(14, 16)), { nil: undefined });
const axis = fc.constantFrom(0 as const, 1 as const, 2 as const);
const tagScalar = fc.integer({ min: 0, max: 31 }).chain((shift) =>
  fc.record({ tag: fc.integer({ min: 0, max: TW - 1 }), shift: fc.constant(shift), bits: fc.integer({ min: 1, max: Math.min(31, 32 - shift) }) }));
const i32Scalar: fc.Arbitrary<Scalar> = fc.oneof(
  fc.record({ comp: src, axis, s: scale }),
  fc.record({ aabb: fc.constantFrom('lo' as const, 'hi' as const), axis, s: scale }),
  tagScalar,
);
const norm2Scalar: fc.Arbitrary<Scalar> = fc.record({ norm2: src, s: scale });
const anyScalar = fc.oneof(i32Scalar, norm2Scalar);
const kFor = (x: Scalar) =>
  'norm2' in x
    ? fc.oneof(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.maxSafeNat().map((v) => v % 2 ** 50), fc.integer({ min: 0, max: 2 ** 20 }).map((v) => v * v))
    : fc.oneof(fc.integer({ min: -(2 ** 31 - 1), max: 2 ** 31 - 1 }), fc.integer({ min: -(2 ** 21), max: 2 ** 21 }), fc.integer({ min: -64, max: 64 }));
const cmp: fc.Arbitrary<Pred> = anyScalar.chain((x) =>
  fc.record({ cmp: fc.constant(x), op: fc.constantFrom<CmpOp>('<', '<=', '>', '>=', '==', '!='), k: kFor(x) }));
const { pred } = fc.letrec<{ pred: Pred }>((tie) => ({
  pred: fc.oneof(
    { maxDepth: 3, depthIdentifier: 'pred' },
    fc.constantFrom('all' as const, 'awake' as const),
    cmp,
    fc.record({ and: fc.array(tie('pred'), { maxLength: 3 }) }),
    fc.record({ or: fc.array(tie('pred'), { maxLength: 3 }) }),
    fc.record({ not: tie('pred') }),
  ),
}));
const output: fc.Arbitrary<Output> = fc.oneof(
  fc.record({ op: fc.constant('count' as const), where: pred }),
  fc.record({
    op: fc.constant('sum' as const), x: i32Scalar, weight: fc.option(fc.integer({ min: 0, max: TW - 1 }), { nil: undefined }),
    shift: fc.option(fc.integer({ min: 0, max: 62 }), { nil: undefined }), where: pred,
  }),
  fc.record({ op: fc.constant('max' as const), x: anyScalar, where: pred }),
  fc.record({
    op: fc.constant('hist' as const),
    by: fc.oneof(
      tagScalar.chain((t) => fc.integer({ min: 1, max: 20 }).map((bins) => ({ ...t, bins }))),
      anyScalar.chain((x) => fc.array(kFor(x), { maxLength: 8 }).map((e) => ({ x, edges: e.sort((a, b) => a - b) }))),
    ),
    where: pred,
  }),
);
const arbSpec: fc.Arbitrary<ReduceSpec> = fc.array(output, { minLength: 1, maxLength: 4 }).map((outputs) => ({ outputs }));

/** A permutation of ids: every per-id input moves with its id. */
function permute(inp: ReduceInput, perm: number[]): ReduceInput {
  const n = perm.length, snap = emptySnapshot(n), tw = inp.tagWords;
  const prev = new Float64Array(3 * n), tags = new Uint32Array(n * tw);
  const refs = inp.refs.map((r) => (r ? new Float64Array(3 * n) : null));
  perm.forEach((from, to) => {
    snap.pos.set(inp.snap.pos.subarray(3 * from, 3 * from + 3), 3 * to);
    snap.rot.set(inp.snap.rot.subarray(4 * from, 4 * from + 4), 4 * to);
    snap.linVel.set(inp.snap.linVel.subarray(3 * from, 3 * from + 3), 3 * to);
    snap.angVel.set(inp.snap.angVel.subarray(3 * from, 3 * from + 3), 3 * to);
    snap.awake[to] = inp.snap.awake[from]!;
    prev.set(inp.prevLinVel.subarray(3 * from, 3 * from + 3), 3 * to);
    tags.set(inp.tags.subarray(tw * from, tw * from + tw), tw * to);
    refs.forEach((r, s) => r?.set(inp.refs[s]!.subarray(3 * from, 3 * from + 3), 3 * to));
  });
  return { ...inp, snap, prevLinVel: prev, tags, refs, shapes: perm.map((from) => inp.shapes[from]!) };
}

describe('reduceRef against the naive BigInt evaluator (fast-check)', () => {
  it('random specs on random states', () => {
    fc.assert(fc.property(arbSpec, arbState(24), (spec, inp) => {
      expect(reduceRef(spec, inp)).toEqual(naiveReduce(spec, inp));
    }), { numRuns: 400 });
  });

  it('mergeOut over a random partition equals the whole', () => {
    fc.assert(fc.property(arbSpec, arbState(24), fc.array(fc.nat(), { maxLength: 4 }), (spec, inp, cuts) => {
      const n = inp.snap.count, at = [0, ...cuts.map((c) => c % (n + 1)).sort((a, b) => a - b), n];
      let merged = reduceRef(spec, inp, 0, 0);
      for (let j = 1; j < at.length; j++) merged = mergeOut(spec, merged, reduceRef(spec, inp, at[j - 1], at[j]));
      expect(merged).toEqual(reduceRef(spec, inp));
    }), { numRuns: 200 });
  });

  it('partitions across chunk boundaries of a 3000-body state', () => {
    const big = fc.sample(arbState(1, true).filter((s) => s.snap.count === 1), 3000);
    const n = big.length, snap = emptySnapshot(n);
    const inp: ReduceInput = { ...big[0]!, snap, shapes: big.map((s) => s.shapes[0]!), tags: new Uint32Array(TW * n), prevLinVel: new Float64Array(3 * n), prevCount: n, refs: [new Float64Array(3 * n), null] };
    big.forEach((s, i) => {
      snap.pos.set(s.snap.pos, 3 * i); snap.rot.set(s.snap.rot, 4 * i); snap.linVel.set(s.snap.linVel, 3 * i); snap.angVel.set(s.snap.angVel, 3 * i);
      snap.awake[i] = s.snap.awake[0]!;
      inp.prevLinVel.set(s.prevLinVel, 3 * i);
      inp.tags.set(s.tags, TW * i);
      inp.refs[0]!.set(s.refs[0] ?? [NaN, NaN, NaN], 3 * i);
    });
    fc.assert(fc.property(arbSpec, fc.array(fc.integer({ min: 0, max: n }), { minLength: 1, maxLength: 5 }), (spec, cuts) => {
      const whole = reduceRef(spec, inp);
      const at = [0, ...cuts.sort((a, b) => a - b), n];
      let merged = reduceRef(spec, inp, 0, 0);
      for (let j = 1; j < at.length; j++) merged = mergeOut(spec, merged, reduceRef(spec, inp, at[j - 1], at[j]));
      expect(merged).toEqual(whole);
    }), { numRuns: 30 });
    const spec = fc.sample(arbSpec, { seed: 7, numRuns: 1 })[0]!;
    expect(reduceRef(spec, inp)).toEqual(naiveReduce(spec, inp));
  });

  it('permuting ids with their tags, shapes, refs and prev gives the same result', () => {
    fc.assert(fc.property(arbSpec, arbState(24, true).chain((inp) => fc.tuple(fc.constant(inp), fc.shuffledSubarray([...Array(inp.snap.count).keys()], { minLength: inp.snap.count }))), (spec, [inp, perm]) => {
      expect(reduceRef(spec, permute(inp, perm))).toEqual(reduceRef(spec, inp));
    }), { numRuns: 200 });
  });
});

describe('gatherRows', () => {
  const snap = state([{ p: [0.1, 0.2, 0.3], q: [0.6, 0, 0, 0.8], v: [1, 2, 3], w: [4, 5, 6] }, { p: [7, 8, 9], awake: 0 }, { p: [1e-30, -0, 1e30] }]).snap;

  it('copies rows exactly; negative, out-of-range ids are absent; duplicates and order are kept', () => {
    const ids = new Int32Array([2, -1, 0, 3, 2, 2 ** 31 - 1, -(2 ** 31), 1]);
    const r = gatherRows(snap, ids);
    expect([...r.ids]).toEqual([...ids]);
    expect([...r.present]).toEqual([1, 0, 1, 0, 1, 0, 0, 1]);
    expect([...r.pos.subarray(0, 3)]).toEqual([1e-30, -0, 1e30]);
    expect(Object.is(r.pos[1], -0)).toBe(true);
    expect([...r.pos.subarray(6, 9)]).toEqual([0.1, 0.2, 0.3]);
    expect([...r.rot.subarray(8, 12)]).toEqual([0.6, 0, 0, 0.8]);
    expect([...r.linVel.subarray(6, 9)]).toEqual([1, 2, 3]);
    expect([...r.angVel.subarray(6, 9)]).toEqual([4, 5, 6]);
    expect([...r.awake]).toEqual([1, 0, 1, 0, 1, 0, 0, 0]);
    for (const j of [1, 3, 5, 6]) {
      expect([...r.pos.subarray(3 * j, 3 * j + 3), ...r.linVel.subarray(3 * j, 3 * j + 3), ...r.angVel.subarray(3 * j, 3 * j + 3)]).toEqual(Array(9).fill(0));
      expect([...r.rot.subarray(4 * j, 4 * j + 4)]).toEqual([0, 0, 0, 1]);
    }
    ids[0] = 1;
    expect(r.ids[0]).toBe(2); // a copy, not a view
  });

  it('an empty list and a full maxWatch list', () => {
    const e = gatherRows(snap, new Int32Array(0));
    expect([e.ids.length, e.present.length, e.pos.length, e.rot.length, e.awake.length]).toEqual([0, 0, 0, 0, 0]);
    const full = gatherRows(snap, Int32Array.from({ length: 256 }, (_, i) => i % 4));
    expect(full.present.reduce((a, b) => a + b, 0)).toBe(192);
  });
});
