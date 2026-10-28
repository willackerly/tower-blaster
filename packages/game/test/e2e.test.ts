// The game page in headless Chromium (SwiftShader in CI): it loads a level,
// aims, plays L1's par line, shows the result card, and scores exactly what
// the headless driver scores for the same shots. It runs on Rapier, which is
// fast on a CPU; par-gpu-L*.test.ts play every level on the default GPU solver.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();

describe('game page', () => {
  it('plays the L1 par line to a result card that matches the headless score', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.bodies)).toBe(40);
    // No pace juice unless asked for.
    expect(await page.evaluate(() => window.__game.feel)).toEqual({ hitStop: false, slowMo: false });

    // Hovering the tower gives a reachable aim and preview beads. (L1's tower
    // is 1 m wide, and the centre ray runs down the 1 cm seam between its columns.)
    const aimed = await page.evaluate(() => window.__game.aim(0.05, 0));
    expect(aimed?.reachable).toBe(true);
    const stats = await page.evaluate(() => window.__game.capture());
    expect(stats!.bodyFraction).toBeGreaterThan(0.02);
    expect(stats!.distinctColors).toBeGreaterThan(50);

    await page.evaluate(() => { window.__game.fast = true; });
    // Pinned on the AVBD reference; this line also clears L1 on Rapier.
    const shots = L1.solutions!.par as Shot[];
    for (const shot of shots) {
      await ready(page);
      expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    }
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    expect(await page.evaluate(() => document.querySelector('#result.show') !== null)).toBe(true);
    const result = await page.evaluate(() => ({ score: window.__game.result, counts: window.__game.counts, phase: window.__game.phase }));
    expect(result.phase).toBe('cleared');
    expect(result.counts.fired).toBe(1);
    expect(result.counts.contact).toBeGreaterThanOrEqual(1);
    expect(result.counts.crownDown).toBe(4);
    const card = await page.locator('#result').innerText();
    expect(card).toMatch(/PAR/);
    expect(card).toMatch(/Total/);

    // Same shots, headless, same engine: the same score to the point.
    const r = await runSession(new RapierEngine(), compileLevel(L1), shots);
    expect(result.score).toEqual(r.session.score);
    // And the page's own replay agrees, pose for pose.
    const live = await page.evaluate(() => window.__game.state());
    expect(live).toMatchObject({ step: r.steps, phase: 'cleared' });
    // The card showed as soon as the last crown was down, before the settle that scores it.
    const shownAt = await page.evaluate(() => window.__game.resultShownAt);
    const lastCrown = r.feedback.filter((f) => f.t === 'crownDown').at(-1)!.step;
    expect(shownAt).toBeGreaterThanOrEqual(lastCrown);
    expect(shownAt).toBeLessThan(r.feedback.find((f) => f.t === 'levelEnd')!.step);
    expect(await page.evaluate((s) => window.__game.replay(s), shots)).toEqual(live);

    // Retry regrows the level and resets the rack.
    await page.keyboard.press('r');
    await ready(page);
    expect(await page.evaluate(() => ({ phase: window.__game.phase, strokes: window.__game.strokes, result: window.__game.result }))).toEqual({ phase: 'aiming', strokes: 0, result: null });
    expect(await page.locator('#result').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('names the engines when ?engine= is unknown', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const page = await game.browser()!.newPage();
    await page.goto(game.url('/?level=L1&engine=physx&offscreen=1'));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/unknown engine physx: use rapier or gpu/);
    await page.close();
  });

  it('shows a readable error for an unknown level', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const page = await game.browser()!.newPage();
    await page.goto(game.url('/?level=L99&offscreen=1'));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/unknown level L99/);
    await page.close();
  });
});
