import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compactIndices, exclusiveScanU32, sortPairs } from '../src/reference.ts';

// The GPU tests trust these references, so they get their own checks.
describe('CPU references', () => {
  it('exclusiveScanU32 wraps modulo 2^32', () => {
    expect(Array.from(exclusiveScanU32([0xffffffff, 2, 3]))).toEqual([0, 0xffffffff, 1]);
  });
  it('compactIndices keeps nonzero positions in order', () => {
    expect(Array.from(compactIndices([0, 5, 0, 1, 1]))).toEqual([1, 3, 4]);
  });
  it('sortPairs is a stable sort on the masked key', () => {
    fc.assert(fc.property(fc.array(fc.nat({ max: 0xffffffff }), { maxLength: 200 }), fc.constantFrom(4, 12, 32), (ks, bits) => {
      const vals = ks.map((_, i) => i);
      const { keys, vals: v } = sortPairs(ks, vals, bits);
      const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
      for (let i = 1; i < keys.length; i++) {
        const a = (keys[i - 1]! & mask) >>> 0, b = (keys[i]! & mask) >>> 0;
        if (a > b || (a === b && v[i - 1]! > v[i]!)) return false;
      }
      return [...v].sort((a, b) => a - b).every((x, i) => x === i);
    }));
  });
});
