// The big levels (big-levels.ts, roadmap G5): each is an outcome level that
// compiles and validates clean on the GPU budget, is reachable by id and plays
// on in its own series, and the shared building blocks hold their shapes.
import { describe, expect, it } from 'vitest';
import { B1, BIG_LEVELS, compileLevel, findLevel, L2, LEVELS, levelById, SERIES, seriesOf, thirdBondWall, validateLevel } from '@tb/keystone';

describe('big levels', () => {
  it.each(BIG_LEVELS.map((d) => d.id))('%s compiles and validates clean on the GPU, scored on outcome', (id) => {
    const def = levelById(id), c = compileLevel(def);
    expect(validateLevel(c, { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    expect(def.scoring).toBe('outcome');
    expect(def.id).toMatch(/^B[1-5]$/);
  });

  it('B1 Long Wall: 1,000 plaster cubes in 25 courses, three bombs, collapse 0.4', () => {
    const c = compileLevel(B1);
    expect(c.meta.n).toBe(1000);
    expect(B1.rack).toEqual(['w-bomb', 'w-bomb', 'w-bomb']);
    expect(B1.objective).toEqual({ kind: 'collapse', min: 0.4 });
  });

  it('ids are unique across the series; lookups find either series in any case, and refuse unknown ids naming both', () => {
    const ids = SERIES.flat().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SERIES).toEqual([LEVELS, BIG_LEVELS]);
    expect(levelById('b1')).toBe(B1);
    expect(levelById('l2')).toBe(L2);
    expect(seriesOf('B1')).toBe(BIG_LEVELS);
    expect(seriesOf('l2')).toBe(LEVELS);
    expect(findLevel('B9')).toBeUndefined();
    expect(seriesOf('S4')).toBeUndefined();
    expect(() => levelById('B9')).toThrow(/unknown level B9; known: L1, L2, L3, L4, L5, B1/);
  });

  it('a third-bond wall shifts every other course a third of a cube', () => {
    const x = thirdBondWall(4, 3, 'plaster').map((p) => (p.kind === 'block' ? p.at[0] : NaN));
    [-2 - 1 / 6, -2 + 1 / 6, -2 - 1 / 6].forEach((v, k) => expect(x[k]).toBeCloseTo(v, 12));
  });
});
