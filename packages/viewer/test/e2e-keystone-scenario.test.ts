// A scenario as a level under Keystone's rules (docs/game/spectacle-mode.md,
// G2.6) on the GPU solver at the game's own settings (40 iterations, gapSlop,
// 300 pre-settle steps): a 50-cube S3 wall from ?scenario=S3&rules=keystone, one
// cannonball through it, banked; the outcome score, no engine limit hit, and a
// replay on this device bit for bit the live session. Small enough for
// SwiftShader in CI (a few minutes); the 10k city is e2e-keystone-10k.test.ts.
import { describe, expect, it } from 'vitest';
import { limitsHit } from '@tb/engine-api';
import { type OutcomeScore, scenarioLevel, validateLevel } from '@tb/keystone';
import { browser, useViewer } from './e2e-harness.ts';
import { aimAtNearest, openRules, ready } from './keystone-page.ts';

useViewer();

const MINUTES = 60_000;
const PARAMS = { W: 10, H: 5 };
/** From +z (azimuth 90 degrees), square to the wall's face, a course above the ground. */
const shotIntoWall = () => aimAtNearest(scenarioLevel('S3', PARAMS, 1), 180, 1, 3);

describe('a scenario as a level under Keystone rules, GPU', () => {
  it('the automatic S3 level validates clean and the shot reaches the wall', () => {
    const { c, error } = shotIntoWall();
    expect(c.meta.n).toBe(50);
    expect(validateLevel(c)).toEqual([]);
    expect(error).toBeLessThan(0.25 * c.frame.unit);
  });

  it('a cannonball brings some of the wall down, the bank scores it, and a replay matches', async (ctx) => {
    if (!browser) return ctx.skip();
    const { shot } = shotIntoWall();
    const o = await openRules(`/?scenario=S3&param.W=${PARAMS.W}&param.H=${PARAMS.H}&rules=keystone&offscreen=1`, undefined, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => { const g = window.__viewer.game!; return { engine: g.engine, level: g.level, bodies: g.bodies, collapse: g.collapse }; })).toEqual({ engine: 'gpu', level: 'S3', bodies: 50, collapse: 0 });
    await page.evaluate(() => { window.__viewer.game!.fast = true; });
    await ready(page, 10 * MINUTES);
    expect(await page.evaluate((s) => window.__viewer.game!.fire(s), shot)).toBe(true);
    // Settled with rack left: an outcome level waits for the next shot or a bank.
    await page.waitForFunction(() => { const g = window.__viewer.game!; return g.ready && g.strokes === 1; }, undefined, { timeout: 10 * MINUTES, polling: 250 });
    const mid = await page.evaluate(() => { const g = window.__viewer.game!; return { phase: g.phase, result: g.result, contacts: g.counts.contact ?? 0, collapse: g.collapse }; });
    expect(mid).toMatchObject({ phase: 'aiming', result: null });
    expect(mid.contacts).toBeGreaterThan(0);
    expect(mid.collapse).toBeGreaterThan(0.02);
    expect(await page.evaluate(() => window.__viewer.game!.bank())).toBe(true);
    await page.waitForFunction(() => window.__viewer.game!.result !== null, undefined, { timeout: MINUTES, polling: 250 });
    const score = await page.evaluate(() => window.__viewer.game!.result) as OutcomeScore;
    expect(score.outcome).toMatchObject({ metric: 'collapse' });
    expect(score.outcome.collapse).toBeCloseTo(mid.collapse, 6);
    expect(score.stamp).toMatch(/INCOMPLETE|% DOWN/);
    // Banked: cleared when the objective (30% down) was met, else failed; the rack left counts only when met.
    const live = await page.evaluate(() => window.__viewer.game!.state());
    expect(live).toMatchObject({ phase: mid.collapse >= 0.3 ? 'cleared' : 'failed', strokes: 1 });
    expect(score.lines.some((l) => l.label === 'Rack left')).toBe(mid.collapse >= 0.3);
    await page.waitForFunction(() => window.__viewer.health !== null && window.__viewer.health.steps > 0, undefined, { timeout: MINUTES, polling: 250 });
    expect(limitsHit(await page.evaluate(() => window.__viewer.health!))).toEqual([]);
    // (level, shots) is the whole session: a fresh engine on this device, the shot, then the bank as
    // the shots run out, lands on the same step, phase and poses.
    expect(await page.evaluate((s) => window.__viewer.game!.replay([s]), shot)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  }, 25 * MINUTES);
});
