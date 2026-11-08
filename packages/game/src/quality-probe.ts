// The probe on load (roadmap P1, docs/game/quality-tiers.md): measure this
// device, then pickTier (quality.ts). A software adapter is low at once.
// Otherwise a chain of dependent dispatches gives the step's proxy (and, on an
// adapter it is calibrated for, the frame budget), then frames of the renderer are timed at high's size and
// toggles and, when those do not fit, at mid's. A tier whose first timed
// frame is STOP_FACTOR over budget is ruled out at once, so a slow device
// spends at most one frame on each size.
import { isSoftwareAdapter } from '@tb/gpu';
import { LOOKS, medianOf, probeDispatch, probeFrames } from '@tb/render';
import { budgetFor, canvasSize, MIN_BUDGET_MS, pickTier, predictedStepMs, type ProbeResult, STOP_FACTOR, type TierKnobs, type TierPick, TIER_KNOBS } from './quality.ts';
import { GAME_LOOK } from './params.ts';

/** Timed frames per size (after its warmup frame). */
export const PROBE_FRAMES = 5;
/** Wall time (ms) for each size's timed frames at most. */
export const PROBE_SIZE_MS = 250;

const toggles = (k: TierKnobs) => ({ shadow: k.shadow, ao: k.ao, sparks: k.sparks });

/**
 * Probe the device for a canvas of cssWidth x cssHeight CSS pixels on a display of devicePixelRatio.
 * `measureSoftware` (tests, calibration) times a software adapter too instead of naming it low at once.
 */
export async function probeQuality(device: GPUDevice, adapter: GPUAdapter, cssWidth: number, cssHeight: number, devicePixelRatio: number, o: { measureSoftware?: boolean } = {}): Promise<ProbeResult & TierPick> {
  const t0 = performance.now();
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const software = isSoftwareAdapter({ vendor: info.vendor, architecture: info.architecture, description: info.description, device: info.device, isFallbackAdapter: info.isFallbackAdapter ?? (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter });
  const p: ProbeResult = { software: software && !o.measureSoftware, calibrated: software, dispatchMs: NaN, highFrameMs: NaN, midFrameMs: NaN, ms: 0, warmupMs: 0 };
  const done = () => { p.ms = performance.now() - t0; return { ...p, ...pickTier(p) }; };
  if (p.software) return done();
  const d = await probeDispatch(device);
  p.dispatchMs = d.msPerDispatch;
  p.warmupMs += d.warmupMs;
  const budget = budgetFor(p.calibrated, predictedStepMs(p.dispatchMs));
  if (p.calibrated && !(budget >= MIN_BUDGET_MS)) return done();
  const look = LOOKS[GAME_LOOK];
  for (const tier of ['high', 'mid'] as const) {
    const k = TIER_KNOBS[tier], [width, height] = canvasSize(cssWidth, cssHeight, devicePixelRatio, k.maxDpr);
    const f = await probeFrames(device, { width, height, toggles: toggles(k), ...(look ? { look } : {}), frames: PROBE_FRAMES, budgetMs: PROBE_SIZE_MS, stopAboveMs: STOP_FACTOR * budget });
    const ms = medianOf(f.frameMs);
    p.warmupMs += f.warmupMs;
    if (tier === 'high') p.highFrameMs = ms; else p.midFrameMs = ms;
    if (ms <= budget) break;
  }
  return done();
}
