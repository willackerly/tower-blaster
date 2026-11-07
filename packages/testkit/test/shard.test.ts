import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkShards, drifted, durationsFromLog, durationsFromReport, mergeDurations, planShards, shardLoad, shardWall, SHARD_WORKERS, slowCaseFiles } from '../src/index.ts';

describe('planShards', () => {
  it('puts every file in exactly one shard, for any files, durations and count', () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 40 }),
      fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.double({ min: 0, max: 1000, noNaN: true })),
      fc.integer({ min: 1, max: 8 }),
      (files, durations, count) => {
        const shards = planShards(files, durations, count);
        expect(shards).toHaveLength(count);
        expect(shards.flat().sort()).toEqual([...files].sort());
        // The same inputs in another order give the same plan.
        expect(planShards([...files].reverse(), durations, count)).toEqual(shards);
      },
    ));
  });

  it('balances: no shard exceeds the ideal share by more than its largest file', () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: 0.01, max: 900, noNaN: true }), { minLength: 1, maxLength: 70 }),
      fc.integer({ min: 1, max: 6 }),
      (times, count) => {
        const files = times.map((_, i) => `f${i}.test.ts`);
        const durations = Object.fromEntries(files.map((f, i) => [f, times[i]!]));
        const loads = planShards(files, durations, count).map((s) => shardLoad(s, durations));
        // LPT's bound: the last file placed on the fullest shard went to the then-least-loaded one.
        const total = times.reduce((a, b) => a + b, 0);
        expect(Math.max(...loads)).toBeLessThanOrEqual(total / count + Math.max(...times) + 1e-9);
      },
    ));
  });

  it('splits two long files and many short ones as a person would', () => {
    const durations = { 'gpu.test.ts': 300, 'render.test.ts': 280, 'a.test.ts': 100, 'b.test.ts': 90, 'c.test.ts': 80, 'd.test.ts': 10 };
    expect(planShards(Object.keys(durations), durations, 2)).toEqual([
      ['gpu.test.ts', 'b.test.ts', 'd.test.ts'],
      ['render.test.ts', 'a.test.ts', 'c.test.ts'],
    ]);
  });

  it('counts a file with no recorded time as the median recorded file', () => {
    const durations = { 'a.test.ts': 1, 'b.test.ts': 2, 'c.test.ts': 100 };
    expect(shardLoad(['new.test.ts'], durations)).toBe(2);
    expect(shardLoad(['new.test.ts'], {})).toBe(1);
  });

  it('refuses a count that is not a positive integer', () => {
    expect(() => planShards(['a'], {}, 0)).toThrow(/positive integer/);
    expect(() => planShards(['a'], {}, 1.5)).toThrow(/positive integer/);
  });
});

describe('durationsFromReport', () => {
  it('keys wall times by repo-relative path, rounded to 0.1 s', () => {
    const report = { testResults: [
      { name: '/repo/packages/b/test/x.test.ts', startTime: 1000, endTime: 13_460 },
      { name: '/repo/packages/a/test/y.test.ts', startTime: 0, endTime: 49 },
    ] };
    expect(durationsFromReport(report, '/repo')).toEqual({ 'packages/a/test/y.test.ts': 0, 'packages/b/test/x.test.ts': 12.5 });
  });
});

describe('shardWall', () => {
  it('spreads a shard over its workers but never under its longest file', () => {
    expect(SHARD_WORKERS).toBe(3);
    expect(shardWall(['a', 'b', 'c'], { a: 300, b: 300, c: 300 })).toBe(300);
    expect(shardWall(['a', 'b'], { a: 500, b: 10 })).toBe(500); // one worker holds the long file the whole time
    expect(shardWall(['a', 'b', 'c', 'd'], { a: 120, b: 120, c: 120, d: 120 }, 2)).toBe(240);
    expect(shardWall([], {})).toBe(0);
  });

  it("matches main's run 806: each shard's wall within 6% of its file time over 3 (the estimate runs up to 5% short)", () => {
    // [file-seconds, test-step wall seconds] of each shard (logs of run 42358505764).
    const runs = [[3276, 1139], [2207, 751], [3104, 1091], [2206, 752], [3316, 1128], [3013, 1023], [3467, 1177], [3053, 1038]];
    for (const [files, wall] of runs) expect(Math.abs(files! / SHARD_WORKERS - wall!) / wall!).toBeLessThan(0.06);
  });
});

describe('checkShards', () => {
  const limits = { shard: 600, file: 300 };
  it('passes a fresh file and an even plan', () => {
    const d = { 'a.test.ts': 290, 'b.test.ts': 290, 'c.test.ts': 290, 'd.test.ts': 100 };
    expect(checkShards(Object.keys(d), d, 2, limits)).toEqual([]);
  });

  it('names stale entries both ways, files over the limit and shards over the estimate', () => {
    const d = { 'a.test.ts': 301, 'gone.test.ts': 5, 'b.test.ts': 1000 };
    expect(checkShards(['a.test.ts', 'b.test.ts', 'new.test.ts'], d, 1, limits).map((p) => `${p.kind}: ${p.message}`)).toEqual([
      'stale: new.test.ts has no recorded time',
      'stale: gone.test.ts has a recorded time but is not a test file',
      'file: a.test.ts: 301 s recorded, over the 300 s one file may take',
      'file: b.test.ts: 1000 s recorded, over the 300 s one file may take',
      'shard: shard 1/1: ~16.7 min estimated, over 10 min',
    ]);
  });

  it('counts a known file left out of the shards as recorded, not stale, and leaves it out of the estimate', () => {
    const d = { 'a.test.ts': 100, 'slow.test.ts': 5000 };
    expect(checkShards(['a.test.ts'], d, 1, limits, ['a.test.ts', 'slow.test.ts'])).toEqual([]);
  });
});

describe('durations files', () => {
  it('reads every vitest-durations line of a CI log, later lines winning', () => {
    const log = [
      '2026-11-07T09:48:57.1Z ##[group]Run pnpm exec tsx durations-cli.ts --print',
      '2026-11-07T09:48:57.7Z vitest-durations {"a.test.ts":1.5,"b.test.ts":20}',
      'noise',
      '2026-11-07T09:50:00.0Z vitest-durations {"b.test.ts":22.5}',
    ].join('\n');
    expect(durationsFromLog(log)).toEqual({ 'a.test.ts': 1.5, 'b.test.ts': 22.5 });
    expect(durationsFromLog('no times here')).toEqual({});
  });

  it('merges new times over old, keeps the rest, drops files that are gone, sorted', () => {
    const merged = mergeDurations({ 'z.test.ts': 9, 'b.test.ts': 1, 'gone.test.ts': 4 }, { 'b.test.ts': 2, 'a.test.ts': 3 }, (f) => f !== 'gone.test.ts');
    expect(Object.entries(merged)).toEqual([['a.test.ts', 3], ['b.test.ts', 2], ['z.test.ts', 9]]);
  });

  it('flags a file over half again its record and a minute more, nothing smaller', () => {
    const recorded = { 'a.test.ts': 100, 'b.test.ts': 100, 'c.test.ts': 10, 'd.test.ts': 200 };
    expect(drifted({ 'a.test.ts': 161, 'b.test.ts': 149, 'c.test.ts': 69, 'd.test.ts': 100, 'new.test.ts': 500 }, recorded)).toEqual([{ file: 'a.test.ts', took: 161, recorded: 100 }]);
  });
});

describe('slowCaseFiles', () => {
  it('finds files that name PHYSICS_GPU_SLOW themselves or in a file they import by a relative path', () => {
    const src: Record<string, string> = {
      'p/test/own.test.ts': "const slow = process.env.PHYSICS_GPU_SLOW === '1';",
      'p/test/via.test.ts': "import { suite } from './suite.ts';\nsuite();",
      'p/test/suite.ts': '// PHYSICS_GPU_SLOW=1 runs every level',
      'p/test/up.test.ts': "import { x } from '../src/levels.ts';",
      'p/src/levels.ts': 'export const ALL = process.env.PHYSICS_GPU_SLOW;',
      'p/test/plain.test.ts': "import { y } from '@tb/keystone';\nimport { z } from './plain-helper.ts';",
      'p/test/plain-helper.ts': 'export const z = 1;',
      'p/test/missing.test.ts': "import { w } from './gone.ts';",
    };
    const files = Object.keys(src).filter((f) => f.endsWith('.test.ts'));
    expect(slowCaseFiles(files, (f) => src[f])).toEqual(['p/test/own.test.ts', 'p/test/via.test.ts', 'p/test/up.test.ts']);
  });
});
