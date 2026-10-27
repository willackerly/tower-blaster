import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { durationsFromReport, planShards, shardLoad } from '../src/index.ts';

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
