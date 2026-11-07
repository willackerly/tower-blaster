// The judge verify's statistics (mason-stats.ts) against textbook values.
import { describe, expect, it } from 'vitest';
import { fisherExact, wilson } from '../src/mason-stats.ts';

describe('mason-stats', () => {
  it("Fisher's exact test, two-sided, matches the textbook tables", () => {
    // Fisher's tea tasting, [[3, 1], [1, 3]]: 0.4857 two-sided.
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.485714, 5);
    // [[1, 9], [11, 3]] (the Wikipedia example): 0.002759.
    expect(fisherExact(1, 9, 11, 3)).toBeCloseTo(0.0027594, 6);
    // Symmetric in the rows and in the columns.
    expect(fisherExact(11, 3, 1, 9)).toBeCloseTo(fisherExact(1, 9, 11, 3), 12);
    expect(fisherExact(9, 1, 3, 11)).toBeCloseTo(fisherExact(1, 9, 11, 3), 12);
    // Equal arms: 1; all one outcome: 1 (the margins allow one table).
    expect(fisherExact(40, 24, 40, 24)).toBeCloseTo(1, 9);
    expect(fisherExact(64, 0, 64, 0)).toBeCloseTo(1, 9);
    // 64 of 64 against 0 of 64 is as far apart as two arms get.
    expect(fisherExact(64, 0, 0, 64)).toBeLessThan(1e-30);
    // 38 against 46 of 64: no evidence of a difference at 0.05.
    expect(fisherExact(38, 26, 46, 18)).toBeGreaterThan(0.05);
  });

  it('the Wilson interval matches the textbook values and stays in [0, 1]', () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
    expect(wilson(0, 10)[0]).toBe(0);
    expect(wilson(0, 10)[1]).toBeCloseTo(0.2775, 4);
    expect(wilson(64, 64)[1]).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});
