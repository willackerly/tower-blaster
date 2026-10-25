import { describe, expect, it } from 'vitest';
import { checkSpec, OBSERVER_CAPS, type ObserverCaps, type Output, type Pred, type ReduceSpec, type Scalar, specCost, type Vec3 } from '../src/index.ts';
import { exactEdge, keystoneSpec, type KeystoneLevel } from './keystone.ts';

const GRAVITY: Vec3 = [0, -9.81, 0], DT = 1 / 60;
const check = (spec: unknown, caps: ObserverCaps = OBSERVER_CAPS, tagWords = 2, gravity = GRAVITY, dt = DT) =>
  checkSpec(spec as ReduceSpec, caps, tagWords, gravity, dt);
const one = (o: unknown): ReduceSpec => ({ outputs: [o as Output] });
const where = (p: unknown): ReduceSpec => one({ op: 'count', where: p });
const cmp = (x: unknown, k: number, op = '>'): ReduceSpec => where({ cmp: x, op, k });
const P0: Scalar = { comp: 'pos', axis: 0 };
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const LEVEL: KeystoneLevel = { lot: { min: [-4, -3], max: [4, 3] }, unit: 0.5, height: 6 };

describe('checkSpec (§2, §3.3)', () => {
  it('accepts the keystone spec without touching it; its cost is the hand count', () => {
    const spec = deepFreeze(keystoneSpec(LEVEL));
    expect(() => check(spec)).not.toThrow();
    // Record: nAwake 2, two maxes 4 each, pe 7, displaced 2, outOfLot 2, heightHist 2 + 64 + 1, impacts 2 + 48 + 1.
    // Program: 10 distinct scalars (P0, P1, P2, the structure bit, norm2 of linVel, angVel, disp 0 and dv,
    // aabb hi y, the impacts class field), 53 predicate nodes, 8 outputs, 63 i32 edges, one dv scalar.
    expect(specCost(spec)).toEqual({ recordWords: 139, programWords: 4 * 10 + 4 * 53 + 4 * 8 + 63 + 3 });
  });

  it.each<[string, ReduceSpec, RegExp]>([
    ['s > 24', cmp({ comp: 'pos', axis: 0, s: 25 }, 0), /s must be an integer 0\.\.24, got 25/],
    ['s < 0', cmp({ norm2: 'linVel', s: -1 }, 0), /s must be an integer 0\.\.24/],
    ['a fractional s', cmp({ aabb: 'hi', axis: 1, s: 15.5 }, 0), /s must be an integer 0\.\.24/],
    ['k = 2^31 on an i32 scalar', cmp(P0, 2 ** 31), /k must be an integer with \|k\| < 2\^31/],
    ['k = -2^31 on an i32 scalar', cmp(P0, -(2 ** 31)), /\|k\| < 2\^31/],
    ['a fractional k', cmp(P0, 0.5), /\|k\| < 2\^31/],
    ['a NaN k', cmp({ tag: 0 }, NaN), /\|k\| < 2\^31/],
    ['norm2 k = 2^50', cmp({ norm2: 'linVel' }, 2 ** 50), /0 ≤ k < 2\^50/],
    ['a negative norm2 k', cmp({ norm2: 'dv' }, -1), /0 ≤ k < 2\^50/],
    ['norm2 in a sum', one({ op: 'sum', x: { norm2: 'pos' }, where: 'all' }), /a sum cannot take norm2/],
    ['unsorted edges', one({ op: 'hist', by: { x: P0, edges: [1, 3, 2] }, where: 'all' }), /non-decreasing/],
    ['a fractional edge', one({ op: 'hist', by: { x: P0, edges: [0.5] }, where: 'all' }), /edge must be an integer/],
    ['an i32 edge of 2^31', one({ op: 'hist', by: { x: P0, edges: [0, 2 ** 31] }, where: 'all' }), /edges\[1\]: edge/],
    ['a norm2 edge of 2^50', one({ op: 'hist', by: { x: { norm2: 'angVel' }, edges: [2 ** 50] }, where: 'all' }), /2\^50/],
    ['257 tag bins', one({ op: 'hist', by: { tag: 0, bits: 9, bins: 257 }, where: 'all' }), /bins must be an integer 1\.\.256/],
    ['0 tag bins', one({ op: 'hist', by: { tag: 0, bits: 1, bins: 0 }, where: 'all' }), /bins must be an integer 1\.\.256/],
    ['256 edges (257 bins)', one({ op: 'hist', by: { x: P0, edges: range(256) }, where: 'all' }), /257 bins, over 256/],
    ['a tag word ≥ tagWords', cmp({ tag: 2 }, 0), /tag word must be an integer below tagWords = 2/],
    ['a weight word ≥ tagWords', one({ op: 'sum', x: P0, weight: 2, where: 'all' }), /weight .*below tagWords = 2/],
    ['a hist tag word ≥ tagWords', one({ op: 'hist', by: { tag: 3, bits: 2, bins: 4 }, where: 'all' }), /tag word/],
    ['a sum shift of 63', one({ op: 'sum', x: P0, shift: 63, where: 'all' }), /sum shift must be an integer 0\.\.62/],
    ['a negative sum shift', one({ op: 'sum', x: P0, shift: -1, where: 'all' }), /sum shift/],
    ['tag bits 0', cmp({ tag: 0, bits: 0 }, 0), /tag bits must be an integer 1\.\.31/],
    ['tag bits 32', cmp({ tag: 0, bits: 32 }, 0), /tag bits must be an integer 1\.\.31/],
    ['hist tag bits 32', one({ op: 'hist', by: { tag: 0, bits: 32, bins: 4 }, where: 'all' }), /tag bits/],
    ['a hist tag field without bits', one({ op: 'hist', by: { tag: 0, bins: 4 }, where: 'all' }), /bits is required/],
    ['tag shift 32', cmp({ tag: 0, shift: 32, bits: 1 }, 0), /tag shift must be an integer 0\.\.31/],
    ['tag shift -1', cmp({ tag: 0, shift: -1, bits: 1 }, 0), /tag shift/],
    ['tag shift + bits > 32', cmp({ tag: 0, shift: 2, bits: 31 }, 0), /shift \+ bits must be ≤ 32, got 2 \+ 31/],
    ['tag shift 2 with the default 31 bits', cmp({ tag: 0, shift: 2 }, 0), /shift \+ bits must be ≤ 32, got 2 \+ 31/],
    ['hist tag shift + bits > 32', one({ op: 'hist', by: { tag: 1, shift: 30, bits: 3, bins: 8 }, where: 'all' }), /shift \+ bits/],
    ['ref slot = refSlots', cmp({ norm2: { disp: 2 } }, 0), /ref slot must be an integer below refSlots = 2/],
    ['a negative ref slot', cmp({ comp: { disp: -1 }, axis: 0 }, 0), /ref slot/],
    ['an unknown vector source', cmp({ comp: 'vel', axis: 0 }, 0), /vector source/],
    ['axis 3', cmp({ comp: 'pos', axis: 3 }, 0), /axis must be an integer 0\.\.2/],
    ['an aabb side', cmp({ aabb: 'mid', axis: 0 }, 0), /'lo' or 'hi'/],
    ['an unknown cmp op', cmp(P0, 0, '=<'), /op: must be one of/],
    ['an unknown output op', one({ op: 'min', x: P0, where: 'all' }), /must be count, sum, max or hist/],
    ['a missing where', one({ op: 'count' }), /where is required/],
    ['an unknown predicate', where('asleep'), /predicate must be/],
    ['an unknown field', cmp({ comp: 'pos', axis: 0, S: 16 }, 0), /unknown field "S"/],
    ['a scalar of two kinds', cmp({ comp: 'pos', axis: 0, tag: 0 }, 0), /unknown field "tag"/],
    ['a predicate with two operators', where({ and: [], not: 'all' }), /unknown field "not"/],
    ['outputs that are not an array', { outputs: 5 } as unknown as ReduceSpec, /outputs: must be an array/],
  ])('rejects %s', (_, spec, msg) => {
    expect(() => check(spec)).toThrow(msg);
  });

  it('accepts every range at its inclusive end', () => {
    const at = (o: unknown) => expect(() => check(one(o))).not.toThrow();
    for (const x of [{ comp: 'linVel', axis: 2, s: 0 }, { norm2: 'angVel', s: 24 }, { tag: 1, shift: 31, bits: 1 }, { tag: 0, shift: 1 }, { comp: { disp: 1 }, axis: 0 }]) {
      at({ op: 'count', where: { cmp: x, op: '<=', k: 2 ** 31 - 1 } });
      at({ op: 'max', x, where: 'all' });
    }
    at({ op: 'count', where: { cmp: P0, op: '!=', k: -(2 ** 31 - 1) } });
    at({ op: 'count', where: { cmp: { norm2: { disp: 0 } }, op: '==', k: 2 ** 50 - 1 } });
    at({ op: 'count', where: { or: [{ and: [] }, { or: [] }, { not: 'awake' }] } });
    at({ op: 'sum', x: { aabb: 'lo', axis: 2 }, weight: 1, shift: 62, where: 'all' });
    at({ op: 'hist', by: { tag: 1, shift: 24, bits: 8, bins: 256 }, where: 'all' });
    at({ op: 'hist', by: { x: { norm2: 'dv' }, edges: [0, 0, 5, 5, 2 ** 50 - 1] }, where: 'all' });
    at({ op: 'hist', by: { x: P0, edges: range(255).map((i) => i - 127) }, where: 'all' });
    at({ op: 'hist', by: { x: P0, edges: [] }, where: 'all' });
    expect(() => check({ outputs: [] })).not.toThrow();
  });

  it('caps the number of outputs, distinct scalars and predicate nodes, inclusive', () => {
    const counts = (n: number) => ({ outputs: range(n).map(() => ({ op: 'count', where: 'all' })) });
    expect(() => check(counts(16))).not.toThrow();
    expect(() => check(counts(17))).toThrow(/17 outputs, over the cap of 16/);
    // Distinct after defaults: the last term repeats s 16 by leaving it out.
    const scalars = (n: number) => where({ and: [...range(n).map((i) => ({ cmp: { comp: 'pos', axis: i % 3, s: 6 + Math.floor(i / 3) }, op: '>', k: 0 })), { cmp: { comp: 'pos', axis: 0 }, op: '<', k: 9 }] });
    expect(() => check(scalars(32))).not.toThrow();
    expect(() => check(scalars(33))).toThrow(/33 distinct scalars, over the cap of 32/);
    // A hist-by-tag field is a tag scalar too.
    const withField = { outputs: [...scalars(32).outputs, { op: 'hist', by: { tag: 0, bits: 2, bins: 4 }, where: 'all' }] };
    expect(() => check(withField)).toThrow(/33 distinct scalars/);
    const nodes = (n: number) => where({ and: range(n - 1).map(() => 'all') });
    expect(() => check(nodes(64))).not.toThrow();
    expect(() => check(nodes(65))).toThrow(/65 predicate nodes, over the cap of 64/);
    // Shared subtrees count at every use.
    const shared: Pred = { and: range(31).map(() => 'awake') };
    expect(() => check({ outputs: [{ op: 'count', where: shared }, { op: 'count', where: shared }] })).not.toThrow();
    expect(() => check({ outputs: [{ op: 'count', where: shared }, { op: 'count', where: shared }, { op: 'count', where: 'all' }] })).toThrow(/65 predicate nodes/);
  });

  it('walks a shared subtree once, counting it at every use; a cycle is rejected', () => {
    // p doubled 20 times: 2^21 - 1 nodes in 21 objects. Each and list is read once, not 2^(20 - level) times.
    let p: Pred = 'all', reads = 0;
    for (let i = 0; i < 20; i++) {
      const c = [p, p];
      p = Object.defineProperty({}, 'and', { enumerable: true, get: () => (reads++, c) }) as Pred;
    }
    expect(() => check(where(p))).toThrow(/2097151 predicate nodes, over the cap of 64/);
    expect(specCost(where(p))).toEqual({ recordWords: 2, programWords: 4 * (2 ** 21 - 1) + 4 });
    expect(reads).toBe(2 * 20);
    const loop: { and: Pred[] } = { and: ['all'] };
    loop.and.push({ not: loop });
    expect(() => check(where(loop))).toThrow(/where\.and\[1\]\.not: a predicate cannot contain itself/);
  });

  it('caps tagWords at maxTagWords', () => {
    expect(() => check(where('all'), OBSERVER_CAPS, 4)).not.toThrow();
    expect(() => check(where('all'), OBSERVER_CAPS, 5)).toThrow(/tagWords must be an integer 0\.\.4/);
    expect(() => check(where('all'), OBSERVER_CAPS, -1)).toThrow(/tagWords/);
    expect(() => check(cmp({ tag: 0 }, 0), OBSERVER_CAPS, 0)).toThrow(/below tagWords = 0/);
  });

  it("checks G at each 'dv' scalar's own s, on every axis", () => {
    // g·dt = -9000: quant(-9000, 10) is valid, quant(-9000, 16) = -9000·2^16 ≥ 2^29 is ⊥.
    const g: Vec3 = [0, -9000, 0];
    expect(() => check(cmp({ norm2: 'dv', s: 10 }, 0), OBSERVER_CAPS, 2, g, 1)).not.toThrow();
    expect(() => check(cmp({ comp: 'dv', axis: 0, s: 16 }, 0), OBSERVER_CAPS, 2, g, 1)).toThrow(/G = quant\(gravity·dt, 16\) is ⊥/);
    expect(() => check({ outputs: [...cmp({ norm2: 'dv', s: 10 }, 0).outputs, ...cmp({ norm2: 'dv' }, 0).outputs] }, OBSERVER_CAPS, 2, g, 1)).toThrow(/s = 16/);
    // Without a dv scalar G is never needed.
    expect(() => check(cmp({ norm2: 'linVel' }, 0), OBSERVER_CAPS, 2, [NaN, 0, 0], 1)).not.toThrow();
    expect(() => check(cmp({ norm2: 'dv' }, 0), OBSERVER_CAPS, 2, [NaN, 0, 0], 1)).toThrow(/is ⊥/);
    expect(() => check(cmp({ norm2: 'dv' }, 0), OBSERVER_CAPS, 2, GRAVITY, Infinity)).toThrow(/is ⊥/);
  });

  it('rejects one record word over maxRecordWords and accepts exactly the limit', () => {
    const hist = (bins: number): Output => ({ op: 'hist', by: { tag: 0, bits: 8, bins }, where: 'all' });
    // 3 × (2 + 256 + 1) + (2 + 244 + 1) = 1024.
    const at = { outputs: [hist(256), hist(256), hist(256), hist(244)] };
    expect(specCost(at).recordWords).toBe(1024);
    expect(() => check(at)).not.toThrow();
    const over = { outputs: [hist(256), hist(256), hist(256), hist(245)] };
    expect(specCost(over).recordWords).toBe(1025);
    expect(() => check(over)).toThrow(/1025 record words, over the cap of 1024/);
    expect(specCost({ outputs: [{ op: 'sum', x: P0, where: 'all' }, { op: 'max', x: P0, where: 'all' }, { op: 'count', where: 'all' }] }).recordWords).toBe(7 + 4 + 2);
  });

  it('rejects one program word over maxProgramWords and accepts exactly the limit', () => {
    // The other default caps keep a spec far below 4096 words (the record cap
    // bounds the edges), so the limit is checked against a lowered cap.
    const spec: ReduceSpec = {
      outputs: [
        { op: 'hist', by: { x: { norm2: 'linVel' }, edges: range(255) }, where: 'all' },
        { op: 'hist', by: { x: { comp: 'dv', axis: 1, s: 20 }, edges: range(10) }, where: { not: 'awake' } },
      ],
    };
    // 2 scalars, 3 nodes, 2 outputs, 255 norm2 edges at 2 words, 10 i32 edges, one dv G.
    const words = 4 * 2 + 4 * 3 + 4 * 2 + 2 * 255 + 10 + 3;
    expect(specCost(spec).programWords).toBe(words);
    expect(() => check(spec, { ...OBSERVER_CAPS, maxProgramWords: words })).not.toThrow();
    expect(() => check(spec, { ...OBSERVER_CAPS, maxProgramWords: words - 1 })).toThrow(new RegExp(`${words} program words, over the cap of ${words - 1}`));
  });

  it('keystone heightHist edges are exact rational ceilings, not f64 products', () => {
    // 5 · 0.1 rounds to exactly 0.5 in f64, but 0.1's binary value is above 0.1.
    expect(Math.ceil(5 * 0.1 * 1024)).toBe(512);
    expect(exactEdge(5, 0.1)).toBe(513);
    expect(exactEdge(1, 6)).toBe(6144);
    expect(exactEdge(63, 1)).toBe(63 * 1024);
  });
});
