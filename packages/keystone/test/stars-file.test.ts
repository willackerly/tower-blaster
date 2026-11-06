// The big levels' cast stars live in stars.json (big-levels.ts STARS_FILE), the
// file a cast writes, so new stars (B3's, from the Metal cast) drop in with no
// code change. The file is checked at import (checkStars).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { B1, B2, B3, BIG_LEVELS, castOf, castStars, checkStars, compileLevel, STARS_FILE } from '../src/index.ts';

const FILE = new URL('../src/stars.json', import.meta.url);

describe('stars.json', () => {
  it('carries B1 and B2 as cast (the values the levels held inline before)', () => {
    expect(B1.stars).toEqual({ metric: 'collapse', t2: 0.7, t3: 0.94, best: 0.9583025426945702, castOn: 'apple metal-3', engine: 'gpu', hash: '18cf21360845bb8b', n: 372, seed: 1 });
    expect(B2.stars).toEqual({ metric: 'score', t2: 770, t3: 3000, best: 3805, castOn: 'apple metal-3', engine: 'gpu', hash: 'c75fbd9832e6814b', n: 236, seed: 1 });
  });
  it('every entry names a big level and matches its hash (a stale cast would silently not show)', () => {
    for (const [id, s] of Object.entries(STARS_FILE)) {
      const def = BIG_LEVELS.find((d) => d.id === id);
      expect(def, `stars.json ${id} is no big level`).toBeDefined();
      expect(castStars(compileLevel(def!))).toBe(s);
    }
  });
  it('a level absent from it plays uncast; castOf gives nothing to spread', () => {
    expect(castOf('B9')).toEqual({});
    expect(B3.stars === undefined).toBe(!('B3' in STARS_FILE));
  });
  it('is the file on disk, parsed plainly (no comments or trailing commas)', () => {
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(STARS_FILE);
  });
});

describe('checkStars', () => {
  const ok = { metric: 'collapse', t2: 0.5, t3: 0.8 };
  it('accepts minimal and full stars', () => {
    expect(checkStars(ok)).toBe(ok);
    expect(() => checkStars(B1.stars)).not.toThrow();
    expect(() => checkStars({ ...ok, waived: ['skill'] })).not.toThrow();
  });
  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...ok, metric: 'height' }, /metric must be one of/],
    [{ ...ok, t2: '0.5' }, /t2 must be a finite number/],
    [{ ...ok, t3: Infinity }, /t3 must be a finite number/],
    [{ ...ok, best: null }, /best must be a finite number when given/],
    [{ ...ok, hash: 42 }, /hash must be a string when given/],
    [{ ...ok, note: 'x' }, /unknown field note/],
    [{ ...ok, waived: 'skill' }, /waived must be a non-empty list/],
    [{ ...ok, waived: [] }, /waived must be a non-empty list/],
    [{ ...ok, waived: [''] }, /waived must be a non-empty list/],
    [{ ...ok, t3: 0.4 }, /t3 \(0.4\) is easier than t2/],
    [{ metric: 'skyline', t2: 0.5, t3: 0.6 }, /t3 \(0.6\) is easier than t2/],
  ])('refuses %j', (x, msg) => {
    expect(() => checkStars(x, 'stars.json B3')).toThrow(msg);
  });
  it('names where the bad stars came from', () => {
    expect(() => checkStars({}, 'stars.json B3')).toThrow(/^stars.json B3\.metric/);
  });
});
