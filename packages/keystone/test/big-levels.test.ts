// The big levels (big-levels.ts, roadmap G5): each is an outcome level that
// compiles and validates clean on the GPU budget, is reachable by id and plays
// on in its own series, and the shared building blocks hold their shapes.
import { describe, expect, it } from 'vitest';
import { B1, B2, B3, BIG_LEVELS, castStars, cathedralLevel, compileLevel, findLevel, L2, LEVELS, levelById, SERIES, seriesOf, thirdBondWall, UNDERCUT_LEVELS, validateLevel } from '@tb/keystone';

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

  it('B1 plays by its cast stars: their hash is the level\'s (any change to B1 drops them until it is recast)', () => {
    const c = compileLevel(B1);
    expect(B1.stars?.hash).toBe(c.hash);
    expect(castStars(c)).toBe(B1.stars);
    // One star at the objective, two at the competent median, three at the nudge cloud's lower quartile.
    expect(B1.stars!.t2).toBeGreaterThan(0.4);
    expect(B1.stars!.t3).toBeGreaterThan(B1.stars!.t2);
    expect(castStars(compileLevel({ ...B1, rack: ['w-bomb', 'w-bomb'] }))).toBeUndefined();
  });

  it('B2 Spare the Cathedral: 5,184 plaster cubes, crowns the middle 4 of the tallest roof, the cathedral 32 heritage cubes, a bomb and two rams', () => {
    const c = compileLevel(B2), m = c.meta;
    expect(m.n).toBe(5184);
    expect(B2.rack).toEqual(['w-bomb', 'w-ram', 'w-ram']);
    expect(B2.objective).toEqual({ kind: 'crowns', footprintMax: 0.05 });
    expect(m.crowns.length).toBe(4);
    expect(m.heritage.length).toBe(32);
    // The crowns are the top course of one tower, and the middle 4 of the 16 the whole roof would crown.
    const ys = m.crowns.map((i) => m.home[3 * i + 1]!);
    expect(Math.min(...ys)).toBe(Math.max(...ys));
    const roof = compileLevel(cathedralLevel('B2', B2.rack, { weapons: B2.weapons }, 'roof')).meta;
    expect(roof.crowns.length).toBe(16);
    const at = (mm: typeof m, i: number) => [0, 1, 2].map((k) => mm.home[3 * i + k]!.toFixed(6)).join();
    const roofAt = new Set(Array.from(roof.crowns, (i) => at(roof, i)));
    for (const i of m.crowns) expect(roofAt.has(at(m, i))).toBe(true);
    // Heritage sits in a different tower: no crown is heritage.
    expect(Array.from(m.crowns).filter((i) => m.heritage.includes(i))).toEqual([]);
  });

  it('B2 plays by its cast stars on score: their hash is the level\'s, and the showcase line parses', () => {
    const c = compileLevel(B2);
    expect(B2.stars).toMatchObject({ metric: 'score', hash: c.hash, engine: 'gpu' });
    expect(castStars(c)).toBe(B2.stars);
    expect(B2.stars!.t3).toBeGreaterThan(B2.stars!.t2);
    expect(B2.stars!.best).toBeGreaterThanOrEqual(B2.stars!.t3);
    expect(B2.solutions?.ace?.map((s) => s.ammo)).toEqual(B2.rack);
    // Moving the crowns to the whole roof is another level: the stars drop until it is recast.
    expect(castStars(compileLevel(cathedralLevel('B2', B2.rack, { weapons: B2.weapons, stars: B2.stars }, 'roof')))).toBeUndefined();
  });

  it('B3 Ten Thousand: 10,000 stone cubes, three bombs, collapse 0.4, within the GPU engine\'s body limit', () => {
    const c = compileLevel(B3);
    expect(c.meta.n).toBe(10_000);
    expect(B3.rack).toEqual(['w-bomb', 'w-bomb', 'w-bomb']);
    expect(B3.objective).toEqual({ kind: 'collapse', min: 0.4 });
    expect(B3.physics).toBeUndefined();
  });

  it('ids are unique across the series; lookups find either series in any case, and refuse unknown ids naming both', () => {
    const ids = SERIES.flat().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SERIES).toEqual([LEVELS, BIG_LEVELS, UNDERCUT_LEVELS]);
    expect(seriesOf('u3')).toBe(UNDERCUT_LEVELS);
    expect(levelById('b1')).toBe(B1);
    expect(levelById('l2')).toBe(L2);
    expect(seriesOf('B1')).toBe(BIG_LEVELS);
    expect(seriesOf('l2')).toBe(LEVELS);
    expect(findLevel('B9')).toBeUndefined();
    expect(seriesOf('S4')).toBeUndefined();
    expect(() => levelById('B9')).toThrow(/unknown level B9; known: L1, L2, L3, L4, L5, B1, B2, B3, U1, U2, U3/);
  });

  it('a third-bond wall shifts every other course a third of a cube', () => {
    const x = thirdBondWall(4, 3, 'plaster').map((p) => (p.kind === 'block' ? p.at[0] : NaN));
    [-2 - 1 / 6, -2 + 1 / 6, -2 - 1 / 6].forEach((v, k) => expect(x[k]).toBeCloseTo(v, 12));
  });
});
