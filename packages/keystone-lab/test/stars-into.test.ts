// pnpm keystone:cast --stars-into: a passing cast sets its level's stars in the
// game's stars file (mergeStarsFile), keeping the others, one level per line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { B1, type StarsDef } from '@tb/keystone';
import { mergeStarsFile } from '../src/cast.ts';

const FILE = readFileSync(new URL('../../keystone/src/stars.json', import.meta.url), 'utf8');
const B3: StarsDef = { metric: 'collapse', t2: 0.5, t3: 0.62, best: 0.71, castOn: 'apple metal-3', engine: 'gpu', hash: '0123456789abcdef', n: 186, seed: 1 };

describe('mergeStarsFile', () => {
  it('rewrites the committed file unchanged when a level is set to the stars it has (the format is the file\'s)', () => {
    expect(mergeStarsFile(FILE, 'B1', B1.stars!)).toBe(FILE);
  });
  it('adds a new level as one line, in id order, and keeps the others', () => {
    const out = mergeStarsFile(FILE, 'B3', B3), parsed = JSON.parse(out);
    expect(parsed.B3).toEqual(B3);
    expect(Object.keys(parsed)).toEqual(['B1', 'B2', 'B3']);
    expect(out.split('\n').filter((l) => l.includes('"B3"'))).toHaveLength(1);
    expect(out.split('\n').length).toBe(FILE.split('\n').length + 1);
  });
  it('replaces a level\'s stars (a recast pooled)', () => {
    const out = JSON.parse(mergeStarsFile(mergeStarsFile(FILE, 'B3', B3), 'B3', { ...B3, t2: 0.55 }));
    expect(out.B3.t2).toBe(0.55);
  });
  it('starts a new file from nothing', () => {
    expect(JSON.parse(mergeStarsFile(null, 'B3', B3))).toEqual({ B3 });
    expect(JSON.parse(mergeStarsFile('', 'B3', B3))).toEqual({ B3 });
  });
  it('orders ids numerically (B10 after B9)', () => {
    const out = mergeStarsFile(mergeStarsFile(null, 'B10', B3), 'B9', B3);
    expect(Object.keys(JSON.parse(out))).toEqual(['B9', 'B10']);
  });
  it('refuses bad stars, and a file that is not an object of stars', () => {
    expect(() => mergeStarsFile(FILE, 'B3', { ...B3, t3: 0.1 })).toThrow(/stars for B3: t3/);
    expect(() => mergeStarsFile('[]', 'B3', B3)).toThrow(/not an object/);
    expect(() => mergeStarsFile('{"B1": {"metric": "x"}}', 'B3', B3)).toThrow(/stars file B1\.metric/);
  });
});
