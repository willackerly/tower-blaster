// Quality tiers by device (roadmap P1, docs/game/quality-tiers.md): a short
// probe on load measures what a frame of the renderer and a dependent
// compute dispatch cost on this device (tier-probe.ts in @tb/render), and
// pickTier turns those into one of three tiers. Each tier is a set of knobs
// that already exist at run time (no shader of its own), so 'high' is the
// game exactly as it was before tiers.
//
// The names are the WeaponSpec caps' (@tb/weapons tiers.ts): a shared weapon
// cannot overload a device of the tier it was capped for.
//
// The player's say: the Quality row in Advanced settings (auto, high, mid,
// low), the URL's ?quality= for a visit. Auto takes the probe's tier.
import type { FrameMode } from './frame-rate.ts';

export type QualityTier = 'low' | 'mid' | 'high';
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'mid', 'high'];
export type QualitySetting = 'auto' | QualityTier;
export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'high', 'mid', 'low'];

/** What a tier sets. */
export interface TierKnobs {
  /** The most device pixels per CSS pixel the canvas draws (below 1, the canvas is drawn smaller and stretched). */
  maxDpr: number;
  /** The renderer's toggles: sun shadows, ambient occlusion, and the effect particles (sparks, impact dust and chips). */
  shadow: boolean;
  ao: boolean;
  sparks: boolean;
  /** Which display frames are drawn (frame-rate.ts) when the URL's keystone.frames does not say. */
  frames: FrameMode;
}

/**
 * The tiers. high: every knob as before tiers (2 device pixels per CSS pixel, everything on, every frame).
 * mid: 1 device pixel per CSS pixel, which on a 2x screen is a quarter of the pixels, the largest lever on
 * a GPU that runs out of fragment throughput; half the frames on a fast display while physics is behind.
 * low: half a device pixel per CSS pixel (a sixteenth of high's on a 2x screen), no ambient occlusion and
 * no effect particles. Sun shadows stay at every tier: they place the blocks on the ground, which the aim
 * needs (docs/game/quality-tiers.md, "Why shadows stay").
 */
export const TIER_KNOBS: Readonly<Record<QualityTier, Readonly<TierKnobs>>> = {
  high: { maxDpr: 2, shadow: true, ao: true, sparks: true, frames: 'all' },
  mid: { maxDpr: 1, shadow: true, ao: true, sparks: true, frames: 'auto' },
  low: { maxDpr: 0.5, shadow: true, ao: false, sparks: false, frames: 'auto' },
};

/** The display frame the budget is for (ms): a step of 1/60 s is due once in it. */
export const TIER_FRAME_MS = 1000 / 60;
/** The share of what is left of a frame after physics that drawing may take (headroom for the look, the level, the browser). */
export const FRAME_SHARE = 0.5;
/** Below this frame budget (ms) physics takes the GPU and only the low tier is tried. */
export const MIN_BUDGET_MS = 1;
/**
 * Dependent dispatches per step of a 1k level: a step of the GPU solver costs about this many of the
 * probe's chain dispatches. SwiftShader (4 cores, 2026-11-06): B1's steps in a shot cost a median 299 ms,
 * the chain 0.125 ms a dispatch, so 2400. That ratio holds only where work dominates a dispatch (a CPU
 * running 4,096 threads); on a GPU a dispatch is mostly latency and the ratio is the solver's own dispatch
 * count, several times smaller. So it is applied only on adapters it was measured on (ProbeResult.calibrated):
 * the M5 in Chrome read it as a 1k step past a whole frame and picked low (2026-11-07), where its real
 * 1k step is about 5 ms.
 */
export const STEP_DISPATCHES = 2400;
/** A tier's frame is ruled out after a timed frame this many times over budget: one is enough. */
export const STOP_FACTOR = 3;

/** What the probe measured; each frame cost is the median of a few timed frames, NaN when that size was not measured. */
export interface ProbeResult {
  /** A software adapter (SwiftShader, llvmpipe): low without timing anything. */
  software: boolean;
  /**
   * The step proxy (STEP_DISPATCHES) was calibrated on this class of adapter, so its predicted step may shrink
   * the frame budget and rule a tier out: software adapters only, so far. Elsewhere the step is reported, and
   * the frames are held to the budget of a frame without physics.
   */
  calibrated: boolean;
  /** Wall ms per dependent compute dispatch (NaN when not measured). */
  dispatchMs: number;
  /** Median frame ms at high's size and toggles, and at mid's. */
  highFrameMs: number;
  midFrameMs: number;
  /** Wall ms the probe took, warmups included. */
  ms: number;
}

/**
 * Why a tier: the probe's software, physics (a calibrated step proxy leaves under MIN_BUDGET_MS of a frame), frame (mid's frame
 * did not fit) or fits; the player's setting; offscreen (an offscreen page without ?quality=auto runs no
 * probe and keeps high); error (the probe threw: mid).
 */
export type TierReason = 'software' | 'physics' | 'frame' | 'fits' | 'setting' | 'offscreen' | 'error';

export interface TierPick { tier: QualityTier; reason: TierReason; budgetMs: number; stepMs: number }

/** A 1k level's predicted step cost (ms) from the chain dispatch's. */
export function predictedStepMs(dispatchMs: number): number {
  return dispatchMs * STEP_DISPATCHES;
}

/** The frame budget (ms) left after a step that costs stepMs: FRAME_SHARE of the rest of a 60 Hz frame. */
export function frameBudgetMs(stepMs: number): number {
  return FRAME_SHARE * (TIER_FRAME_MS - (Number.isFinite(stepMs) ? stepMs : TIER_FRAME_MS));
}

/** The frame budget the probe holds frames to: after the predicted step where the proxy is calibrated, else a whole frame's. */
export function budgetFor(calibrated: boolean, stepMs: number): number {
  return frameBudgetMs(calibrated ? stepMs : 0);
}

/**
 * The tier from the probe's measurements: the highest whose frame fits the budget left after a step.
 * A software adapter is low; so is a device whose physics leaves under MIN_BUDGET_MS of a frame, where
 * the step proxy is calibrated (elsewhere the budget is a frame's without physics: budgetFor).
 * A frame not measured (NaN) does not fit.
 */
export function pickTier(p: Pick<ProbeResult, 'software' | 'calibrated' | 'dispatchMs' | 'highFrameMs' | 'midFrameMs'>): TierPick {
  const stepMs = predictedStepMs(p.dispatchMs), budgetMs = budgetFor(p.calibrated, stepMs);
  if (p.software) return { tier: 'low', reason: 'software', budgetMs, stepMs };
  if (p.calibrated && !(budgetMs >= MIN_BUDGET_MS)) return { tier: 'low', reason: 'physics', budgetMs, stepMs };
  if (p.highFrameMs <= budgetMs) return { tier: 'high', reason: 'fits', budgetMs, stepMs };
  if (p.midFrameMs <= budgetMs) return { tier: 'mid', reason: 'fits', budgetMs, stepMs };
  return { tier: 'low', reason: 'frame', budgetMs, stepMs };
}

/** The canvas's size in device pixels for a CSS box at a display's devicePixelRatio, under a cap (at least 1 x 1). */
export function canvasSize(cssWidth: number, cssHeight: number, devicePixelRatio: number, maxDpr: number): [number, number] {
  const dpr = Math.min(devicePixelRatio || 1, maxDpr);
  return [Math.max(1, Math.floor(cssWidth * dpr)), Math.max(1, Math.floor(cssHeight * dpr))];
}

/** The URL's quality: auto, high, mid or low (anything else is refused); null when absent. */
export function qualityParam(q: URLSearchParams): QualitySetting | null {
  const v = q.get('quality');
  if (v === null) return null;
  if (!(QUALITY_SETTINGS as readonly string[]).includes(v)) throw new Error(`quality must be one of ${QUALITY_SETTINGS.join(', ')}: ${v}`);
  return v as QualitySetting;
}

/** What the page reports (GameHandle.quality): the setting, the tier in effect and why, and what the probe measured. */
export interface QualityState {
  setting: QualitySetting;
  tier: QualityTier;
  reason: TierReason;
  /** The probe's tier (what auto picks), null when no probe ran (a fixed setting, an offscreen page). */
  probed: QualityTier | null;
  probe: (ProbeResult & TierPick) | null;
  knobs: TierKnobs;
}

/**
 * The tier in effect for a setting: a fixed one is itself; auto is the probe's pick, mid when the probe
 * failed, and high when no probe ran (the offscreen test pages keep drawing what they drew before tiers).
 */
export function tierFor(setting: QualitySetting, probe: TierPick | null, failed = false): { tier: QualityTier; reason: TierReason } {
  if (setting !== 'auto') return { tier: setting, reason: 'setting' };
  if (probe) return { tier: probe.tier, reason: probe.reason };
  return failed ? { tier: 'mid', reason: 'error' } : { tier: 'high', reason: 'offscreen' };
}

/** The knobs in effect: the tier's, with the frames the URL's keystone.frames names when it does, and the canvas capped by Sharpness too. */
export function knobsFor(tier: QualityTier, sharp: number, urlFrames: FrameMode | null): TierKnobs {
  const k = TIER_KNOBS[tier];
  return { ...k, maxDpr: Math.min(k.maxDpr, sharp), frames: urlFrames ?? k.frames };
}
