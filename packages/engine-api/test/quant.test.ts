import { describe, expect, it } from 'vitest';
import { quant } from '../src/index.ts';
import { bitsOf, fromBits, quantBig, quantBits } from './oracle.ts';

// Fraction patterns that sit on the rounding decisions for every shift k: the
// tie (bit k-1 alone), either side of it, both parities of the kept bit, and
// the same with every higher bit set.
function edgeFractions(): number[] {
  const out = new Set([0, 1, 2, 3, 0x7fffff, 0x7ffffe, 0x400000, 0x3fffff, 0x400001, 0x555555, 0x2aaaaa]);
  for (let k = 1; k <= 23; k++) {
    const tie = 1 << (k - 1), high = 0x7fffff & ~((1 << k) - 1);
    for (const f of [tie, tie - 1, tie + 1, tie | (1 << k), high | tie, high | (tie - 1), high | (tie + 1), high]) out.add(f & 0x7fffff);
  }
  return [...out];
}

// mulberry32, as @tb/scenarios uses, so failures replay.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Compares the oracle, the bit twin and quant on one pattern; returns a description on mismatch. */
function disagree(b: number, s: number): string | null {
  const big = quantBig(b, s), want = big === null ? null : Number(big);
  const bits = quantBits(b, s), got = quant(fromBits(b), s);
  if (bits === want && Object.is(got, want)) return null;
  return `bits 0x${(b >>> 0).toString(16)} s ${s}: oracle ${want}, bit twin ${bits}, quant ${got}`;
}

describe('quant (§3.2)', () => {
  it('matches the rational oracle and the WGSL bit twin on every exponent, s, sign and edge mantissa', () => {
    const fracs = edgeFractions();
    expect(fracs.length).toBe(150);
    const bad: string[] = [];
    let n = 0;
    for (let e = 0; e < 256; e++)
      for (let s = 0; s <= 24; s++)
        for (const sign of [0, 1])
          for (const f of fracs) {
            const d = disagree(((sign << 31) | (e << 23) | f) >>> 0, s);
            n++;
            if (d && bad.length < 10) bad.push(d);
          }
    expect(bad).toEqual([]);
    expect(n).toBe(256 * 25 * 2 * fracs.length);
  });

  it('matches on 2M random patterns and on random doubles, which it reads through fround', () => {
    const r = rng(0x5eed);
    const bad: string[] = [];
    for (let i = 0; i < 2_000_000; i++) {
      const d = disagree(r(), r() % 25);
      if (d && bad.length < 10) bad.push(d);
    }
    for (let i = 0; i < 200_000; i++) {
      // Doubles that are not f32 values, near the magnitudes quant keeps.
      const x = (r() / 2 ** 32 - 0.5) * 2 ** ((r() % 60) - 30) * (1 + r() / 2 ** 52), s = r() % 25;
      const want = quantBig(bitsOf(x), s);
      if (!Object.is(quant(x, s), want === null ? null : Number(want)) && bad.length < 10) bad.push(`x ${x} s ${s}`);
    }
    expect(bad).toEqual([]);
  });

  // §8, quant row.
  const MAX_F32 = fromBits(0x7f7fffff);
  it.each<[string, number, number, number | null]>([
    ['tie 0.5 to even 0', 0.5, 0, 0],
    ['tie 1.5 to even 2', 1.5, 0, 2],
    ['tie 2.5 to even 2', 2.5, 0, 2],
    ['tie -0.5 to 0', -0.5, 0, 0],
    ['tie -1.5 to -2', -1.5, 0, -2],
    ['tie -2.5 to -2', -2.5, 0, -2],
    ['tie at s 16, odd', 3 * 2 ** -17, 16, 2],
    ['tie at s 16, even', 5 * 2 ** -17, 16, 2],
    ['tie at s 24, -odd', -7 * 2 ** -25, 24, -4],
    ['just above a tie', 0.5 + 2 ** -24, 0, 1],
    ['-0 reads +0', -0, 16, 0],
    ['smallest subnormal', fromBits(1), 24, 0],
    ['largest subnormal', fromBits(0x7fffff), 24, 0],
    ['smallest normal', 2 ** -126, 24, 0],
    ['just under 2^29 at s 0', 2 ** 29 - 32, 0, 2 ** 29 - 32],
    ['2^29 at s 0 is ⊥', 2 ** 29, 0, null],
    ['-(2^29 - 32) at s 0', -(2 ** 29 - 32), 0, -(2 ** 29 - 32)],
    ['-2^29 at s 0 is ⊥', -(2 ** 29), 0, null],
    ['just under 8192 m at s 16', 8192 - 2 ** -11, 16, 2 ** 29 - 32],
    ['8192 m at s 16 is ⊥', 8192, 16, null],
    ['a double that frounds up to 8192 is ⊥', 8192 - 2 ** -20, 16, null],
    ['just under 32 at s 24', 32 - 2 ** -19, 24, 2 ** 29 - 32],
    ['32 at s 24 is ⊥', 32, 24, null],
    ['largest finite', MAX_F32, 0, null],
    ['-largest finite', -MAX_F32, 24, null],
    ['+Inf', Infinity, 16, null],
    ['-Inf', -Infinity, 0, null],
    ['NaN 0x7fc00000', fromBits(0x7fc00000), 16, null],
    ['NaN 0x7f800001', fromBits(0x7f800001), 16, null],
    ['NaN 0xffffffff', fromBits(0xffffffff), 16, null],
    ['0.1 is read as fround(0.1)', 0.1, 16, 6554],
    ['1/3 frounds onto a tie at s 24', 1 / 3, 24, 5592406],
  ])('%s', (_, x, s, want) => {
    expect(Object.is(quant(x, s), want)).toBe(true);
  });

  it('every s from 0 to 24: 1, half a quantum, one and a half quanta', () => {
    for (let s = 0; s <= 24; s++) {
      expect(quant(1, s)).toBe(2 ** s);
      expect(quant(-1, s)).toBe(-(2 ** s));
      expect(quant(2 ** -s / 2, s)).toBe(0);
      expect(quant(1.5 * 2 ** -s, s)).toBe(2);
      expect(quant(-2.5 * 2 ** -s, s)).toBe(-2);
      expect(quant(2 ** (29 - s), s)).toBe(null);
    }
  });

  it('rejects s outside 0..24', () => {
    for (const s of [-1, 25, 1.5, NaN]) expect(() => quant(1, s)).toThrow(RangeError);
  });
});
