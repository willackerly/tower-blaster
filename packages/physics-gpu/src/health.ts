// The GPU engine's limits as engine-api EngineHealth. Pure, so the mapping is
// tested without a GPU; GpuAvbdEngine.health() feeds it diagnostics().
//
// One limit for now, the pair buffer ('pairs', a physics limit): a step that
// finds more broadphase pairs than it holds leaves out the pairs between the
// bodies latest in index order, and those of them that touch then pass
// through each other (broadphase.ts). Its fix is the pairsPerBody that holds
// the peak with PAIR_FIX_HEADROOM to spare, or, if the device cannot hold
// that buffer, the most it can hold while that still holds the peak. The box
// test (boxBroadphase) is named as a hint only: it is exact and needs about
// half the pairs for long, thin bodies such as Kapla planks, but no fewer
// where a sphere is involved, so it is no sure fix.
import type { EngineHealth, EngineLimit } from '@tb/engine-api';
import { pairDispatchCover } from './broadphase.ts';
import type { GpuDiagnostics } from './engine.ts';
import { AvbdSolver, type RecordMode } from './solver.ts';

/** What the mapping needs besides diagnostics(): the engine's sizing and the device's limits. */
export interface GpuHealthContext {
  capacity: number;
  records: RecordMode;
  /** The largest buffer the device takes: min(maxStorageBufferBindingSize, maxBufferSize). */
  storageLimit: number;
  maxComputeWorkgroupsPerDimension: number;
  boxBroadphase: boolean;
}

/** How much more than the peak a suggested pair buffer holds, when the device can hold that much. */
export const PAIR_FIX_HEADROOM = 1.25;

/** The most pairs per body the device can hold: one indirect dispatch covers them (pairDispatchCover) and their contact buffer fits. */
export function maxPairsPerBody(ctx: GpuHealthContext): number {
  // contactBytes(c, v c) = (v + 1) contactBytes(c, 0).
  const byStorage = Math.floor(ctx.storageLimit / AvbdSolver.contactBytes(ctx.capacity, 0, ctx.records)) - 1;
  return Math.min(Math.floor(pairDispatchCover(ctx.maxComputeWorkgroupsPerDimension) / ctx.capacity), byStorage);
}

/**
 * The pairsPerBody to suggest for a step that needed `peak` pairs: the least
 * multiple of 8 (at least 8) that holds the peak with PAIR_FIX_HEADROOM to
 * spare; if the device cannot hold that, the most it can (maxPairsPerBody),
 * with less to spare; null if even that does not hold the peak.
 */
export function pairFix(peak: number, ctx: GpuHealthContext): number | null {
  const want = Math.max(8, 8 * Math.ceil((PAIR_FIX_HEADROOM * peak) / ctx.capacity / 8));
  const most = maxPairsPerBody(ctx);
  if (want <= most) return want;
  return most * ctx.capacity >= peak ? most : null;
}

export function gpuHealth(d: GpuDiagnostics, ctx: GpuHealthContext): EngineHealth {
  const pairs: EngineLimit = { id: 'pairs', effect: 'physics', steps: d.pairsOverflowSteps, peak: d.pairsRequiredPeak, room: d.maxPairs, message: `pair buffer: a step needed at most ${d.pairsRequiredPeak} of its ${d.maxPairs} pairs` };
  if (d.pairsOverflowSteps > 0) {
    const value = pairFix(d.pairsRequiredPeak, ctx);
    const what = `contacts dropped on ${d.pairsOverflowSteps} of ${d.steps} steps: a step needed ${d.pairsRequiredPeak} broadphase pairs and the buffer holds ${d.maxPairs}, so pairs between the bodies latest in index order were left out, and those that touch pass through each other`;
    const box = ctx.boxBroadphase ? '' : ' (boxBroadphase=true needs fewer pairs for long, thin bodies)';
    if (value !== null) {
      pairs.fix = { option: 'pairsPerBody', value };
      const most = value * ctx.capacity < PAIR_FIX_HEADROOM * d.pairsRequiredPeak ? ', the most this device holds' : '';
      pairs.message = `${what}; pairsPerBody=${value} gives room${most}${box}`;
    } else pairs.message = `${what}; this device cannot hold a buffer for ${d.pairsRequiredPeak} pairs (${maxPairsPerBody(ctx)} per body at most)${box}`;
  }
  return { steps: d.steps, limits: [pairs] };
}
