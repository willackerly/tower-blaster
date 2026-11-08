// A 10k-block level under Keystone's rules in the viewer (docs/game/spectacle-mode.md,
// G2.6): the S4 city of 10,000 cubes as an automatic outcome level (scenarioLevel)
// from ?scenario=S4&param.N=10000&rules=keystone, on the game's GPU solver.
//
// At the game's settings a step of this city costs about 4.7 s on SwiftShader
// (measured in a cloud container, 2026-11-01: 1.9 s at 10 iterations, 1.3 s at
// 4), so the 300 pre-settle steps alone take about 24 min there. CI therefore
// runs a smoke case: the level loads with keystone.presettle=0 (a custom run),
// a cannonball is fired into it and a few steps run with no engine limit hit.
// Lowering the iterations instead would not make a scoring CI case honest: at 4
// iterations the unsettled city sags by itself (D 0.036 at 20 steps with or
// without a hit). The full case (default settings, the shot settled, banked
// and scored) runs on a real GPU only: TB_CHANNEL=chrome (Metal on a Mac, the run in
// docs/ci/nightly.md). On SwiftShader its load alone passed 60 min without a result
// (nightly run 42469639500), so the nightly does not force it there.
import { describe, expect, it } from 'vitest';
import { limitsHit } from '@tb/engine-api';
import { type OutcomeScore, scenarioLevel, validateLevel } from '@tb/keystone';
import { browser, useViewer } from './e2e-harness.ts';
import { aimAtNearest, openRules, ready } from './keystone-page.ts';

useViewer();

const MINUTES = 60_000;
const CITY = '/?scenario=S4&param.N=10000&rules=keystone&offscreen=1';
const FULL = !!process.env.TB_CHANNEL;
/** From azimuth 0, at the nearest tower a third of the way up. */
const shotIntoCity = () => aimAtNearest(scenarioLevel('S4', { N: 10_000 }, 1), 0, 3, 4);

describe('a 10k level under Keystone rules, GPU', () => {
  it('the automatic S4 level is 10,000 bodies, validates clean, and the shot reaches the city', () => {
    const { c, error } = shotIntoCity();
    expect(c.meta.n).toBe(10_000);
    expect(validateLevel(c)).toEqual([]);
    expect(error).toBeLessThan(0.25 * c.frame.unit);
  });

  it('smoke: loads 10,000 cubes on the GPU solver (no pre-settle), a cannonball flies into it, no limit hit', async (ctx) => {
    if (!browser) return ctx.skip();
    const { shot } = shotIntoCity();
    const o = await openRules(`${CITY}&keystone.presettle=0`, undefined, 5 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => { const g = window.__viewer.game!; return { engine: g.engine, level: g.level, bodies: g.bodies, phase: g.phase }; })).toEqual({ engine: 'gpu', level: 'S4', bodies: 10_000, phase: 'aiming' });
    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await ready(page, 5 * MINUTES);
    const s0 = await page.evaluate(() => window.__viewer.game!.stepIndex);
    expect(await page.evaluate((s) => window.__viewer.game!.fire(s), shot)).toBe(true);
    await page.waitForFunction((k) => window.__viewer.game!.stepIndex >= k, s0 + 8, { timeout: 5 * MINUTES, polling: 250 });
    expect(await page.evaluate(() => ({ bodies: window.__viewer.game!.bodies, phase: window.__viewer.game!.phase }))).toEqual({ bodies: 10_001, phase: 'running' });
    // A read of the engine's limits that saw steps of the shot.
    await page.waitForFunction(() => (window.__viewer.health?.steps ?? 0) > 0, undefined, { timeout: 5 * MINUTES, polling: 250 });
    expect(limitsHit(await page.evaluate(() => window.__viewer.health!))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 15 * MINUTES);

  it.runIf(FULL)('full: at the game\'s settings the shot settles, banks and scores on the outcome, no limit hit', async (ctx) => {
    if (!browser) return ctx.skip();
    const { shot } = shotIntoCity();
    const t0 = performance.now();
    const o = await openRules(CITY, undefined, 60 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    const loadMs = performance.now() - t0;
    expect(await page.evaluate(() => { const g = window.__viewer.game!; return { engine: g.engine, level: g.level, bodies: g.bodies }; })).toEqual({ engine: 'gpu', level: 'S4', bodies: 10_000 });
    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await ready(page, 60 * MINUTES);
    expect(await page.evaluate((s) => window.__viewer.game!.fire(s), shot)).toBe(true);
    await page.waitForFunction(() => { const g = window.__viewer.game!; return g.ready && g.strokes === 1; }, undefined, { timeout: 60 * MINUTES, polling: 500 });
    const shotMs = performance.now() - t0 - loadMs;
    const mid = await page.evaluate(() => { const g = window.__viewer.game!; return { phase: g.phase, result: g.result, contacts: g.counts.contact ?? 0, collapse: g.collapse, steps: g.timing.stepMs.length, stepMs: [...g.timing.stepMs].sort((a, b) => a - b) }; });
    expect(mid).toMatchObject({ phase: 'aiming', result: null });
    expect(mid.contacts).toBeGreaterThan(0);
    expect(mid.collapse).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__viewer.game!.bank())).toBe(true);
    await page.waitForFunction(() => window.__viewer.game!.result !== null, undefined, { timeout: MINUTES, polling: 250 });
    const score = await page.evaluate(() => window.__viewer.game!.result) as OutcomeScore;
    expect(score.outcome.metric).toBe('collapse');
    expect(score.outcome.collapse).toBeCloseTo(mid.collapse, 6);
    await page.waitForFunction(() => (window.__viewer.health?.steps ?? 0) > 0, undefined, { timeout: MINUTES, polling: 250 });
    expect(limitsHit(await page.evaluate(() => window.__viewer.health!))).toEqual([]);
    expect(errors).toEqual([]);
    // Wall times on this machine: a record of the run, a performance result only on a physical GPU (pnpm bench decides).
    const q = (p: number) => mid.stepMs[Math.min(mid.stepMs.length - 1, Math.floor(p * mid.stepMs.length))]?.toFixed(1);
    console.log(`10k S4 under rules=keystone: load ${(loadMs / 1000).toFixed(1)} s, shot to settle ${(shotMs / 1000).toFixed(1)} s over ${mid.steps} live steps (median ${q(0.5)} ms, p95 ${q(0.95)} ms), D ${(100 * score.outcome.collapse).toFixed(2)}%, ${score.stamp}`);
    await page.close();
  }, 120 * MINUTES);
});
