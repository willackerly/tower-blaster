// gpuHealth and pairFix (health.ts): the GPU engine's limits as engine-api
// EngineHealth, on hand-made diagnostics; no GPU needed. The engine's own
// health() on a real overflow is in engine-stacks.test.ts.
import { describe, expect, it } from 'vitest';
import { limitProblems } from '@tb/engine-api';
import type { GpuDiagnostics } from '../src/engine.ts';
import { gpuHealth, type GpuHealthContext, maxPairsPerBody, PAIR_FIX_HEADROOM, pairFix } from '../src/health.ts';
import { AvbdSolver } from '../src/solver.ts';

const ctx = (o: Partial<GpuHealthContext> = {}): GpuHealthContext =>
  ({ capacity: 2000, records: 1, storageLimit: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, boxBroadphase: false, ...o });
const diag = (o: Partial<GpuDiagnostics> = {}): GpuDiagnostics =>
  ({ pairsRequired: 0, pairsWritten: 0, maxPairs: 32000, pairsRequiredPeak: 0, pairsOverflowSteps: 0, steps: 60, colors: 8, uncolored: 0, colorOverflow: 0, ...o });

describe('pairFix', () => {
  it('is the least multiple of 8 per body that holds the peak with the headroom, at least 8', () => {
    expect(PAIR_FIX_HEADROOM).toBe(1.25);
    // 1.25 x 1280 / 100 = 16 exactly; one pair more needs the next multiple.
    expect(pairFix(1280, ctx({ capacity: 100 }))).toBe(16);
    expect(pairFix(1281, ctx({ capacity: 100 }))).toBe(24);
    expect(pairFix(10, ctx({ capacity: 100 }))).toBe(8);
    expect(pairFix(0, ctx({ capacity: 100 }))).toBe(8);
    // The Kapla thread's 2k-plank pile: 45.6k pairs needed against 16 x 2000 (1.25 x 45.6k / 2000 = 28.5).
    expect(pairFix(45600, ctx())).toBe(32);
    for (const capacity of [1, 7, 100, 2000, 12345]) {
      for (let peak = 0; peak < 40 * capacity; peak += Math.max(1, Math.floor(capacity / 3))) {
        const v = pairFix(peak, ctx({ capacity, storageLimit: Infinity }))!;
        expect(v % 8).toBe(0);
        expect(v * capacity).toBeGreaterThanOrEqual(PAIR_FIX_HEADROOM * peak);
        if (v > 8) expect((v - 8) * capacity).toBeLessThan(PAIR_FIX_HEADROOM * peak);
      }
    }
  });

  it('holds at most what one indirect dispatch covers (64 x maxComputeWorkgroupsPerDimension): less headroom past it, null past the peak', () => {
    // 8 x 524,280 = 4,194,240 = 64 x 65535 slots; peak 3,355,392 x 1.25 is exactly that.
    const capacity = 524280, storageLimit = Infinity;
    expect(maxPairsPerBody(ctx({ capacity, storageLimit }))).toBe(8);
    expect(pairFix(3355392, ctx({ capacity, storageLimit }))).toBe(8);
    // One workgroup fewer covers 7 per body (3,669,960 slots): still the peak, with less to spare.
    expect(maxPairsPerBody(ctx({ capacity, storageLimit, maxComputeWorkgroupsPerDimension: 65534 }))).toBe(7);
    expect(pairFix(3355392, ctx({ capacity, storageLimit, maxComputeWorkgroupsPerDimension: 65534 }))).toBe(7);
    expect(pairFix(3355393, ctx({ capacity, storageLimit }))).toBe(8); // the full headroom would be 16 per body
    expect(pairFix(8 * capacity, ctx({ capacity, storageLimit }))).toBe(8);
    expect(pairFix(8 * capacity + 1, ctx({ capacity, storageLimit }))).toBeNull();
    // 100k bodies: 48 per body is past the cover, 41 (4.1M slots) is the most it takes and holds 3.5M.
    expect(pairFix(3.5e6, ctx({ capacity: 1e5, storageLimit: Infinity }))).toBe(41);
  });

  it('holds at most what the device\'s storage limit takes for the contacts, in every record layout', () => {
    for (const records of [0, 1, 2] as const) {
      const bytes = (v: number) => AvbdSolver.contactBytes(2000, v * 2000, records);
      expect(pairFix(45600, ctx({ records, storageLimit: bytes(32) }))).toBe(32);
      // One byte less: 31 per body is the most (62k slots, 1.36 x 45.6k), and 23 is the least that holds the peak.
      expect(maxPairsPerBody(ctx({ records, storageLimit: bytes(32) - 1 }))).toBe(31);
      expect(pairFix(45600, ctx({ records, storageLimit: bytes(32) - 1 }))).toBe(31);
      expect(pairFix(45600, ctx({ records, storageLimit: bytes(23) }))).toBe(23);
      expect(pairFix(45600, ctx({ records, storageLimit: bytes(23) - 1 }))).toBeNull();
    }
    // The reviewer's case: 2000 bodies, a 128 MiB device, 130k pairs: 88 is past it, 86 is not.
    expect(pairFix(130000, ctx({ storageLimit: 2 ** 27 }))).toBe(86);
    // 10k bodies at 128 MiB needing 130k: the full headroom (24 per body) is past it, the default 16 is not.
    expect(pairFix(130000, ctx({ capacity: 10000, storageLimit: 2 ** 27 }))).toBe(16);
  });
});

describe('gpuHealth', () => {
  it('reports the pair buffer with no fix and no problem when no step overflowed', () => {
    const h = gpuHealth(diag({ pairsRequired: 9000, pairsWritten: 9000, pairsRequiredPeak: 12000 }), ctx());
    expect(h).toEqual({
      steps: 60,
      limits: [{ id: 'pairs', effect: 'physics', steps: 0, peak: 12000, room: 32000, message: 'pair buffer: a step needed at most 12000 of its 32000 pairs' }],
    });
    expect(limitProblems(h, 'engine 0 (avbd-gpu)')).toEqual([]);
  });

  it('names the dropped steps and the pairsPerBody that gives room, and the box test while it is off', () => {
    const d = diag({ pairsRequired: 41000, pairsWritten: 32000, pairsRequiredPeak: 45600, pairsOverflowSteps: 42 });
    const what = 'contacts dropped on 42 of 60 steps: a step needed 45600 broadphase pairs and the buffer holds 32000, so pairs between the bodies latest in index order were left out, and those that touch pass through each other';
    const off = gpuHealth(d, ctx()).limits[0]!;
    expect(off).toEqual({
      id: 'pairs', effect: 'physics', steps: 42, peak: 45600, room: 32000, fix: { option: 'pairsPerBody', value: 32 },
      message: `${what}; pairsPerBody=32 gives room (boxBroadphase=true needs fewer pairs for long, thin bodies)`,
    });
    const on = gpuHealth(d, ctx({ boxBroadphase: true })).limits[0]!;
    expect(on.fix).toEqual({ option: 'pairsPerBody', value: 32 });
    expect(on.message).toBe(`${what}; pairsPerBody=32 gives room`);
    // Exactly the headroom (16 x 100 = 1.25 x 1280) is the full fix, not the most the device holds.
    const exact = gpuHealth(diag({ maxPairs: 800, pairsRequiredPeak: 1280, pairsOverflowSteps: 1 }), ctx({ capacity: 100, boxBroadphase: true })).limits[0]!;
    expect(exact.message).toMatch(/; pairsPerBody=16 gives room$/);
    expect(limitProblems(gpuHealth(d, ctx()), 'engine 0 (avbd-gpu)')).toEqual([`engine 0 (avbd-gpu): ${off.message}`]);
  });

  it('says when the fix is the most the device holds, and gives none, naming the box test as a hint only, when that is too little', () => {
    const d = diag({ maxPairs: 32000, pairsRequiredPeak: 45600, pairsOverflowSteps: 1 });
    const what = 'contacts dropped on 1 of 60 steps: a step needed 45600 broadphase pairs and the buffer holds 32000, so pairs between the bodies latest in index order were left out, and those that touch pass through each other';
    const most = gpuHealth(d, ctx({ storageLimit: AvbdSolver.contactBytes(2000, 26 * 2000, 1) })).limits[0]!;
    expect(most).toMatchObject({ fix: { option: 'pairsPerBody', value: 26 }, message: `${what}; pairsPerBody=26 gives room, the most this device holds (boxBroadphase=true needs fewer pairs for long, thin bodies)` });
    const tight = { storageLimit: AvbdSolver.contactBytes(2000, 23 * 2000, 1) - 1 }; // 22 per body at most, 23 needed
    const off = gpuHealth(d, ctx(tight)).limits[0]!;
    expect(off.fix).toBeUndefined();
    expect(off.message).toBe(`${what}; this device cannot hold a buffer for 45600 pairs (22 per body at most) (boxBroadphase=true needs fewer pairs for long, thin bodies)`);
    const on = gpuHealth(d, ctx({ ...tight, boxBroadphase: true })).limits[0]!;
    expect(on.fix).toBeUndefined();
    expect(on.message).toBe(`${what}; this device cannot hold a buffer for 45600 pairs (22 per body at most)`);
    expect(limitProblems({ steps: 60, limits: [on] }, 'x')).toEqual([`x: ${on.message}`]);
  });

  it('suggests more pairs per body than the buffer had whenever a step overflowed it, or none', () => {
    for (const capacity of [1, 13, 2000]) {
      for (const ppb of [1, 4, 16, 32]) {
        for (const limit of [Infinity, AvbdSolver.contactBytes(capacity, 40 * capacity, 1)]) {
          for (let peak = ppb * capacity + 1; peak < 60 * capacity; peak += Math.max(1, Math.floor(capacity / 2))) {
            const l = gpuHealth(diag({ maxPairs: ppb * capacity, pairsRequiredPeak: peak, pairsOverflowSteps: 1 }), ctx({ capacity, storageLimit: limit })).limits[0]!;
            if (!l.fix) { expect(peak).toBeGreaterThan(40 * capacity); continue; }
            const v = l.fix.value as number;
            expect(v).toBeGreaterThan(ppb);
            expect(v * capacity).toBeGreaterThanOrEqual(peak);
            expect(AvbdSolver.contactBytes(capacity, v * capacity, 1)).toBeLessThanOrEqual(limit);
          }
        }
      }
    }
  });
});
