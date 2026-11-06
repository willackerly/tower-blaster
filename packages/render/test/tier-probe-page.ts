// The quality-tier probe's measurements in the browser (tier-probe.test.ts bundles this file).
import { sharedDevice } from '@tb/gpu';
import { LOOKS, probeDispatch, probeFrames } from '../src/index.ts';

export async function frames(width: number, height: number, toggles: Record<string, boolean>, stopAboveMs: number) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const f = await probeFrames(device, { width, height, toggles, look: LOOKS.hazy!, frames: 2, budgetMs: 10_000, stopAboveMs });
  const err = await device.popErrorScope();
  return { ...f, error: err?.message ?? null };
}

export async function dispatch() {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const d = await probeDispatch(device, { rounds: 2 });
  const err = await device.popErrorScope();
  return { ...d, error: err?.message ?? null };
}
