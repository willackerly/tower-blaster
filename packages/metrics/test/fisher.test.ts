// Fisher's exact test (stats.ts fisherExact) against known values, and KS (ks2) on equal and shifted samples.
import { describe, expect, it } from 'vitest';
import { fisherExact, ks2 } from '../src/index.ts';

describe('fisherExact', () => {
  it('matches the textbook tables', () => {
    // The lady tasting tea: 3 of 4 against 1 of 4, two-sided p = 0.4857.
    expect(fisherExact(3, 4, 1, 4)).toBeCloseTo(0.485714, 5);
    // 1 of 10 against 9 of 10: the tables with 0, 1, 9 or 10 in the first cell, 2 (1 + 100) / C(20, 10).
    expect(fisherExact(1, 10, 9, 10)).toBeCloseTo(202 / 184756, 12);
    expect(fisherExact(5, 10, 5, 10)).toBeCloseTo(1, 12);
    expect(fisherExact(0, 64, 0, 64)).toBe(1);
  });
  it('is symmetric in the two samples', () => {
    expect(fisherExact(20, 64, 30, 64)).toBeCloseTo(fisherExact(30, 64, 20, 64), 12);
  });
});

describe('ks2', () => {
  it('agrees on equal samples and rejects a clear shift', () => {
    const a = Array.from({ length: 64 }, (_, i) => i / 64);
    expect(ks2(a, a).p).toBe(1);
    expect(ks2(a, a.map((x) => x + 0.5)).p).toBeLessThan(1e-4);
  });
});
