// Progress kept in the browser (roadmap G7): best play per level and hash, plays
// counted, unreadable storage tolerated, custom runs left to the page.
import { describe, expect, it } from 'vitest';
import type { LevelScore, OutcomeScore } from '@tb/keystone';
import { betterPlay, bestFor, emptyProgress, memoryKeyValue, parseProgress, PROGRESS_KEY, ProgressStore, progressStore, recordPlay } from '../src/progress.ts';

const par = (stars: 0 | 1 | 2 | 3, total: number): LevelScore => ({ lines: [], total, stars, stamp: 'PAR', leverage: 1 });
const outcome = (stars: 0 | 1 | 2 | 3, collapse: number, total = 1000, metric: 'collapse' | 'skyline' = 'collapse'): OutcomeScore => ({
  lines: [], total, stars, stamp: 'X', leverage: 1,
  outcome: { collapse, metric, value: metric === 'collapse' ? collapse : 1 - collapse, stars, beatBot: false, uncast: false },
});
const T0 = new Date('2026-11-02T00:00:00Z'), T1 = new Date('2026-11-02T01:00:00Z');

describe('recordPlay', () => {
  it('a first play is the record', () => {
    const p = recordPlay(emptyProgress(), 'B1', 'h1', outcome(2, 0.75), T0);
    expect(p.levels.B1).toEqual({ hash: 'h1', plays: 1, stars: 2, total: 1000, metric: 'collapse', value: 0.75, collapse: 0.75, beatBot: false, at: T0.toISOString() });
  });
  it('keeps the best play and counts every play', () => {
    let p = recordPlay(emptyProgress(), 'B1', 'h1', outcome(2, 0.75), T0);
    p = recordPlay(p, 'B1', 'h1', outcome(1, 0.5), T1);
    expect(p.levels.B1).toMatchObject({ plays: 2, stars: 2, value: 0.75, at: T0.toISOString() });
    p = recordPlay(p, 'B1', 'h1', outcome(3, 0.95), T1);
    expect(p.levels.B1).toMatchObject({ plays: 3, stars: 3, value: 0.95, at: T1.toISOString() });
  });
  it('the gold-leverage badge sticks to the record once any play of the hash earned it', () => {
    let p = recordPlay(emptyProgress(), 'L1', 'h1', { ...par(3, 4000), gold: true }, T0);
    expect(p.levels.L1).toMatchObject({ stars: 3, gold: true });
    p = recordPlay(p, 'L1', 'h1', par(3, 5000), T1); // a better total without the badge: the record moves, the badge stays
    expect(p.levels.L1).toMatchObject({ plays: 2, total: 5000, gold: true });
    expect(recordPlay(emptyProgress(), 'L1', 'h1', par(3, 4000), T0).levels.L1!.gold).toBeUndefined();
    expect(recordPlay(p, 'L1', 'h2', par(2, 10), T1).levels.L1!.gold).toBeUndefined(); // another hash starts over
  });
  it('a level changed since (another hash) starts its record over', () => {
    let p = recordPlay(emptyProgress(), 'B1', 'h1', outcome(3, 0.95), T0);
    p = recordPlay(p, 'B1', 'h2', outcome(1, 0.45), T1);
    expect(p.levels.B1).toMatchObject({ hash: 'h2', plays: 1, stars: 1 });
    expect(bestFor(p, 'B1', 'h1')).toBeNull();
    expect(bestFor(p, 'B1', 'h2')).toMatchObject({ stars: 1 });
  });
  it('leaves its input unchanged and other levels alone', () => {
    const p0 = recordPlay(emptyProgress(), 'L1', 'a', par(2, 300), T0), snap = JSON.stringify(p0);
    const p1 = recordPlay(p0, 'B1', 'h1', outcome(1, 0.4), T1);
    expect(JSON.stringify(p0)).toBe(snap);
    expect(p1.levels.L1).toEqual(p0.levels.L1);
  });
});

describe('betterPlay', () => {
  it('stars first, then the metric in its own direction, then the total', () => {
    expect(betterPlay({ stars: 2, total: 0 }, { stars: 1, total: 9999 })).toBe(true);
    expect(betterPlay({ stars: 2, total: 0, metric: 'collapse', value: 0.8 }, { stars: 2, total: 9999, metric: 'collapse', value: 0.7 })).toBe(true);
    // skyline: lower is better
    expect(betterPlay({ stars: 2, total: 0, metric: 'skyline', value: 0.3 }, { stars: 2, total: 0, metric: 'skyline', value: 0.4 })).toBe(true);
    expect(betterPlay({ stars: 2, total: 0, metric: 'skyline', value: 0.5 }, { stars: 2, total: 0, metric: 'skyline', value: 0.4 })).toBe(false);
    expect(betterPlay({ stars: 1, total: 500 }, { stars: 1, total: 400 })).toBe(true);
    expect(betterPlay({ stars: 1, total: 400 }, { stars: 1, total: 400 })).toBe(false); // a tie keeps the earlier play
  });
});

describe('parseProgress', () => {
  it.each([null, '', 'not json', '[]', '{"version":2,"levels":{}}', '{"version":1}'])('reads %j as empty', (t) => {
    expect(parseProgress(t)).toEqual(emptyProgress());
  });
  it('drops malformed records and keeps good ones', () => {
    const good = recordPlay(emptyProgress(), 'B1', 'h', outcome(1, 0.5), T0).levels.B1;
    const text = JSON.stringify({ version: 1, levels: { B1: good, B2: { hash: 'x', plays: 0, stars: 1, total: 1, at: '' }, B3: { stars: 5 }, L1: null } });
    expect(parseProgress(text)).toEqual({ version: 1, levels: { B1: good } });
  });
});

describe('ProgressStore', () => {
  it('survives a reload: a new store on the same storage reads what the last wrote', () => {
    const kv = memoryKeyValue();
    new ProgressStore(kv).record('B1', 'h1', outcome(2, 0.71), T0);
    expect(new ProgressStore(kv).best('B1', 'h1')).toMatchObject({ stars: 2, plays: 1 });
    expect(JSON.parse(kv.getItem(PROGRESS_KEY)!).version).toBe(1);
  });
  it('keeps going in memory when storage throws (a private window, a full quota)', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('denied'); } };
    const s = new ProgressStore(bad);
    expect(s.record('B1', 'h', outcome(1, 0.5), T0)).toMatchObject({ plays: 1 });
    expect(s.best('B1', 'h')).toMatchObject({ plays: 1 });
    expect(() => s.reset()).not.toThrow();
    expect(s.best('B1', 'h')).toBeNull();
  });
  it('reset forgets everything, on disk too', () => {
    const kv = memoryKeyValue(), s = new ProgressStore(kv);
    s.record('B1', 'h', outcome(1, 0.5), T0);
    s.reset();
    expect(new ProgressStore(kv).progress).toEqual(emptyProgress());
  });
  it('?progress=off keeps this visit only; anything but on or off is refused', () => {
    const kv = memoryKeyValue();
    progressStore(new URLSearchParams('progress=off'), kv).record('B1', 'h', outcome(1, 0.5), T0);
    expect(kv.getItem(PROGRESS_KEY)).toBeNull();
    progressStore(new URLSearchParams(''), kv).record('B1', 'h', outcome(1, 0.5), T0);
    expect(kv.getItem(PROGRESS_KEY)).not.toBeNull();
    expect(() => progressStore(new URLSearchParams('progress=1'), kv)).toThrow(/progress must be on or off: 1/);
  });
  it('falls back to memory where the browser has no storage', () => {
    expect(progressStore(new URLSearchParams(''), null).record('B1', 'h', outcome(1, 0.5), T0).plays).toBe(1);
  });
});
