// Quality tiers (quality.ts, docs/game/quality-tiers.md): the tier table, the pick from the probe's
// measurements, the URL key and the setting, the door's Quality row, and the canvas size. Pure.
import { describe, expect, it } from 'vitest';
import { LEVELS } from '@tb/keystone';
import { WEAPON_TIERS } from '@tb/weapons';
import { doorHtml, doorLevels, QUALITY_TITLES } from '../src/door.ts';
import { canvasSize, frameBudgetMs, QUALITY_TIERS, knobsFor, MIN_BUDGET_MS, pickTier, predictedStepMs, QUALITY_SETTINGS, qualityParam, STEP_DISPATCHES, TIER_FRAME_MS, TIER_KNOBS, tierFor } from '../src/quality.ts';
import { DEFAULT_SETTINGS, parseSettings, QUALITY_CHOICES, SettingsStore, urlSettings } from '../src/settings.ts';
import { memoryKeyValue } from '../src/progress.ts';

const q = (s: string) => new URLSearchParams(s);
const measured = (dispatchMs: number, highFrameMs: number, midFrameMs = NaN) => ({ software: false, dispatchMs, highFrameMs, midFrameMs });

describe('tier knobs', () => {
  it('the tiers are the WeaponSpec caps\' tiers, by name (a weapon capped for a tier fits a device of it)', () => {
    expect([...QUALITY_TIERS].sort()).toEqual([...WEAPON_TIERS].sort());
  });
  it('high is the game as it was before tiers', () => {
    expect(TIER_KNOBS.high).toEqual({ maxDpr: 2, shadow: true, ao: true, sparks: true, frames: 'all' });
  });
  it('each tier down costs no more than the one above: fewer pixels, no effect turned back on', () => {
    const order = ['high', 'mid', 'low'] as const;
    for (let i = 1; i < order.length; i++) {
      const up = TIER_KNOBS[order[i - 1]!], down = TIER_KNOBS[order[i]!];
      expect(down.maxDpr).toBeLessThan(up.maxDpr);
      for (const k of ['shadow', 'ao', 'sparks'] as const) if (!up[k]) expect(down[k]).toBe(false);
    }
  });
  it('sun shadows stay on at every tier (the aim reads the blocks on the ground)', () => {
    for (const k of Object.values(TIER_KNOBS)) expect(k.shadow).toBe(true);
  });
  it('Sharpness caps the tier\'s resolution, and the URL\'s keystone.frames wins over the tier\'s frames', () => {
    expect(knobsFor('high', 1, null)).toEqual({ ...TIER_KNOBS.high, maxDpr: 1 });
    expect(knobsFor('low', 2, null).maxDpr).toBe(0.5);
    expect(knobsFor('mid', 2, null).frames).toBe('auto');
    expect(knobsFor('mid', 2, 'all').frames).toBe('all');
    expect(knobsFor('high', 2, 'half').frames).toBe('half');
  });
});

describe('the pick', () => {
  it('the frame budget is half of what a step leaves of a 60 Hz frame', () => {
    expect(TIER_FRAME_MS).toBeCloseTo(16.667, 3);
    expect(frameBudgetMs(0)).toBeCloseTo(8.333, 3);
    expect(frameBudgetMs(6.667)).toBeCloseTo(5, 3);
    expect(frameBudgetMs(NaN)).toBe(0);
    expect(predictedStepMs(0.002)).toBeCloseTo(0.002 * STEP_DISPATCHES, 9);
  });
  it('a software adapter is low without timing anything', () => {
    expect(pickTier({ software: true, dispatchMs: NaN, highFrameMs: NaN, midFrameMs: NaN })).toMatchObject({ tier: 'low', reason: 'software' });
  });
  it('SwiftShader as measured (chain 0.125 ms, so a 1k step of 300 ms): physics leaves no frame budget, low', () => {
    const p = pickTier(measured(0.125, 716, 716));
    expect(p).toMatchObject({ tier: 'low', reason: 'physics' });
    expect(p.stepMs).toBeCloseTo(300, 6);
  });
  it('a fast device whose high frame fits is high', () => {
    // An M5-like guess: 2 us a dispatch (a 1k step of 4.8 ms), a 3.5 ms frame at 2x.
    expect(pickTier(measured(0.002, 3.5))).toMatchObject({ tier: 'high', reason: 'fits' });
  });
  it('a high frame over budget falls to mid when mid\'s fits, else low', () => {
    expect(pickTier(measured(0.002, 12, 4))).toMatchObject({ tier: 'mid', reason: 'fits' });
    expect(pickTier(measured(0.002, 30, 9))).toMatchObject({ tier: 'low', reason: 'frame' });
  });
  it('slower physics shrinks the budget: the same frames pick a lower tier', () => {
    const fast = pickTier(measured(0.001, 5, 2)), slow = pickTier(measured(0.005, 5, 2));
    expect(fast.tier).toBe('high');
    expect(slow.budgetMs).toBeLessThan(fast.budgetMs);
    expect(slow.tier).toBe('mid');
  });
  it('a frame that was not measured (NaN) does not fit; physics just under the floor is low', () => {
    expect(pickTier(measured(0.002, NaN, NaN))).toMatchObject({ tier: 'low', reason: 'frame' });
    const floor = (TIER_FRAME_MS - 2 * MIN_BUDGET_MS) / STEP_DISPATCHES;
    expect(pickTier(measured(floor * 0.999, 0.1)).tier).toBe('high');
    expect(pickTier(measured(floor * 1.001, 0.1))).toMatchObject({ tier: 'low', reason: 'physics' });
  });
  it('the tier in effect: a fixed setting is itself; auto takes the probe, mid if it failed, high with no probe', () => {
    const probe = pickTier(measured(0.002, 12, 4));
    expect(tierFor('low', probe)).toEqual({ tier: 'low', reason: 'setting' });
    expect(tierFor('high', null)).toEqual({ tier: 'high', reason: 'setting' });
    expect(tierFor('auto', probe)).toEqual({ tier: 'mid', reason: 'fits' });
    expect(tierFor('auto', null, true)).toEqual({ tier: 'mid', reason: 'error' });
    expect(tierFor('auto', null)).toEqual({ tier: 'high', reason: 'offscreen' });
  });
});

describe('the canvas size', () => {
  it('CSS size times the display\'s ratio under the cap, at least 1 x 1', () => {
    expect(canvasSize(1728, 1117, 2, 2)).toEqual([3456, 2234]);
    expect(canvasSize(1728, 1117, 2, 1)).toEqual([1728, 1117]);
    expect(canvasSize(1728, 1117, 2, 0.5)).toEqual([864, 558]);
    expect(canvasSize(390, 844, 3, 2)).toEqual([780, 1688]);
    expect(canvasSize(640, 400, 1, 2)).toEqual([640, 400]);
    expect(canvasSize(640, 400, 0, 2)).toEqual([640, 400]); // no ratio reported: 1
    expect(canvasSize(1, 1, 1, 0.5)).toEqual([1, 1]);
  });
});

describe('the setting', () => {
  it('auto by default; a stored tier is kept; anything else is auto', () => {
    expect(DEFAULT_SETTINGS.quality).toBe('auto');
    expect(parseSettings('{"quality":"mid"}').quality).toBe('mid');
    expect(parseSettings('{"quality":"ultra"}').quality).toBe('auto');
    expect(parseSettings('{"sharp":1}').quality).toBe('auto'); // stored before tiers
  });
  it('?quality= wins for the visit; a bad value is refused; a door click replaces it', () => {
    expect(qualityParam(q(''))).toBeNull();
    for (const v of QUALITY_SETTINGS) expect(qualityParam(q(`quality=${v}`))).toBe(v);
    expect(() => qualityParam(q('quality=medium'))).toThrow(/quality must be one of auto, high, mid, low: medium/);
    expect(urlSettings(q('quality=low'))).toEqual({ quality: 'low' });
    const kv = memoryKeyValue(), store = new SettingsStore(kv, q('quality=low'));
    expect(store.current.quality).toBe('low');
    expect(store.set({ quality: 'high' }).quality).toBe('high');
    expect(new SettingsStore(kv).current.quality).toBe('high');
  });
});

describe('the door\'s Quality row', () => {
  const levels = doorLevels(LEVELS, () => null);
  it('one button per setting, the stored one lit, each with its tooltip; Auto names the probe\'s tier', () => {
    const html = doorHtml({ levels, current: 0, settings: { ...DEFAULT_SETTINGS, quality: 'auto' }, howTo: false, advanced: true, detected: 'mid' });
    expect(html).toContain('<span class="lbl">Quality</span>');
    expect(QUALITY_CHOICES.map((c) => c.quality)).toEqual(['auto', 'high', 'mid', 'low']);
    for (const c of QUALITY_CHOICES) expect(html).toContain(`data-act="quality" data-arg="${c.quality}"`);
    expect(html).toContain(`data-act="quality" data-arg="auto" class="on" title="${QUALITY_TITLES.auto}">Auto (Medium)</button>`);
    expect(html).toContain(`data-arg="low" class="" title="${QUALITY_TITLES.low}">Low</button>`);
  });
  it('without a probe Auto is just Auto; a fixed setting is lit', () => {
    const html = doorHtml({ levels, current: 0, settings: { ...DEFAULT_SETTINGS, quality: 'low' }, howTo: false, advanced: true });
    expect(html).toContain('data-arg="auto" class=""');
    expect(html).toContain('>Auto</button>');
    expect(html).toContain('data-arg="low" class="on"');
  });
});
