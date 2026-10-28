// The GPU engine's limits as engine-api EngineHealth. Pure, so the mapping is
// tested without a GPU; GpuAvbdEngine.health() feeds it diagnostics().
//
// One limit for now, the pair buffer ('pairs', a physics limit): a step that
// finds more broadphase pairs than it holds drops the pairs between the
// bodies latest in index order, which then pass through each other
// (broadphase.ts). Its fix is the pairsPerBody that holds the peak with
// PAIR_FIX_HEADROOM to spare, if the device can hold that buffer, else the
// box test if it is off (exact, and about half the pairs for long, thin
// bodies such as Kapla planks).
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

/** How much more than the peak a suggested pair buffer holds. */
export const PAIR_FIX_HEADROOM = 1.25;

/**
 * The pairsPerBody whose buffer holds `peak` pairs with PAIR_FIX_HEADROOM to
 * spare, rounded up to a multiple of 8; null if one indirect dispatch cannot
 * cover it or its contact buffer does not fit the device.
 */
export function pairFix(peak: number, ctx: GpuHealthContext): number | null {
  const value = Math.max(8, 8 * Math.ceil((PAIR_FIX_HEADROOM * peak) / ctx.capacity / 8));
  const slots = value * ctx.capacity;
  if (slots > pairDispatchCover(ctx.maxComputeWorkgroupsPerDimension)) return null;
  if (AvbdSolver.contactBytes(ctx.capacity, slots, ctx.records) > ctx.storageLimit) return null;
  return value;
}

export function gpuHealth(d: GpuDiagnostics, ctx: GpuHealthContext): EngineHealth {
  const pairs: EngineLimit = { id: 'pairs', effect: 'physics', steps: d.pairsOverflowSteps, peak: d.pairsRequiredPeak, room: d.maxPairs, message: `pair buffer: a step needed at most ${d.pairsRequiredPeak} of its ${d.maxPairs} pairs` };
  if (d.pairsOverflowSteps > 0) {
    const value = pairFix(d.pairsRequiredPeak, ctx);
    const what = `contacts dropped on ${d.pairsOverflowSteps} of ${d.steps} steps: a step needed ${d.pairsRequiredPeak} broadphase pairs and the buffer holds ${d.maxPairs}, so the bodies latest in index order passed through each other`;
    if (value !== null) {
      pairs.fix = { option: 'pairsPerBody', value };
      pairs.message = `${what}; pairsPerBody=${value} gives room${ctx.boxBroadphase ? '' : ' (or boxBroadphase=true, which needs fewer pairs for long, thin bodies)'}`;
    } else if (!ctx.boxBroadphase) {
      pairs.fix = { option: 'boxBroadphase', value: true };
      pairs.message = `${what}; this device cannot hold a buffer for ${d.pairsRequiredPeak} pairs, but boxBroadphase=true needs fewer`;
    } else pairs.message = `${what}; this device cannot hold a buffer for ${d.pairsRequiredPeak} pairs`;
  }
  return { steps: d.steps, limits: [pairs] };
}
