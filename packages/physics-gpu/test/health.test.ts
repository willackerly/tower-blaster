// gpuHealth and pairFix (health.ts): the GPU engine's limits as engine-api
// EngineHealth, on hand-made diagnostics; no GPU needed. The engine's own
// health() on a real overflow is in engine-stacks.test.ts.
import { describe, expect, it } from 'vitest';
import { limitProblems } from '@tb/engine-api';
import type { GpuDiagnostics } from '../src/engine.ts';
import { gpuHealth, type GpuHealthContext, PAIR_FIX_HEADROOM, pairFix } from '../src/health.ts';
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

  it('is null past what one indirect dispatch covers (64 x maxComputeWorkgroupsPerDimension), and not at it', () => {
    // 8 x 524,280 = 4,194,240 = 64 x 65535 slots; peak 3,355,392 x 1.25 is exactly that.
    const capacity = 524280, storageLimit = Infinity;
    expect(pairFix(3355392, ctx({ capacity, storageLimit }))).toBe(8);
    expect(pairFix(3355392, ctx({ capacity, storageLimit, maxComputeWorkgroupsPerDimension: 65534 }))).toBeNull();
    expect(pairFix(3355393, ctx({ capacity, storageLimit }))).toBeNull(); // needs 16 per body
  });

  it('is null when the contact buffer for it is past the device\'s storage limit, and not at it', () => {
    for (const records of [0, 1, 2] as const) {
      const bytes = AvbdSolver.contactBytes(2000, 32 * 2000, records);
      expect(pairFix(45600, ctx({ records, storageLimit: bytes }))).toBe(32);
      expect(pairFix(45600, ctx({ records, storageLimit: bytes - 1 }))).toBeNull();
    }
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
    const what = 'contacts dropped on 42 of 60 steps: a step needed 45600 broadphase pairs and the buffer holds 32000, so the bodies latest in index order passed through each other';
    const off = gpuHealth(d, ctx()).limits[0]!;
    expect(off).toEqual({
      id: 'pairs', effect: 'physics', steps: 42, peak: 45600, room: 32000, fix: { option: 'pairsPerBody', value: 32 },
      message: `${what}; pairsPerBody=32 gives room (or boxBroadphase=true, which needs fewer pairs for long, thin bodies)`,
    });
    const on = gpuHealth(d, ctx({ boxBroadphase: true })).limits[0]!;
    expect(on.fix).toEqual({ option: 'pairsPerBody', value: 32 });
    expect(on.message).toBe(`${what}; pairsPerBody=32 gives room`);
    expect(limitProblems(gpuHealth(d, ctx()), 'engine 0 (avbd-gpu)')).toEqual([`engine 0 (avbd-gpu): ${off.message}`]);
  });

  it('falls back to the box test when no pair buffer fits the device, and to no fix when it is already on', () => {
    const d = diag({ maxPairs: 32000, pairsRequiredPeak: 45600, pairsOverflowSteps: 1 });
    const tight = { storageLimit: AvbdSolver.contactBytes(2000, 32 * 2000, 1) - 1 };
    const what = 'contacts dropped on 1 of 60 steps: a step needed 45600 broadphase pairs and the buffer holds 32000, so the bodies latest in index order passed through each other';
    expect(gpuHealth(d, ctx(tight)).limits[0]).toMatchObject({
      fix: { option: 'boxBroadphase', value: true }, message: `${what}; this device cannot hold a buffer for 45600 pairs, but boxBroadphase=true needs fewer`,
    });
    const none = gpuHealth(d, ctx({ ...tight, boxBroadphase: true })).limits[0]!;
    expect(none.fix).toBeUndefined();
    expect(none.message).toBe(`${what}; this device cannot hold a buffer for 45600 pairs`);
    expect(limitProblems({ steps: 60, limits: [none] }, 'x')).toEqual([`x: ${none.message}`]);
  });
});
