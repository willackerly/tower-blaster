// Rapid fire on the game page (PaceFeel.rapid, on by default): a click while a
// shot is still running goes in at once, cutting that shot, and the attempt's
// recorded line (with `after` on the rapid shot) replays headless to the exact
// state, as does the same line from a link. keystone.rapid=0 waits for the
// settle, as before. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
/** A marble well wide of the tower (it runs a while), then the par cannonball while it is still rolling. */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const par = L1.solutions!.par![0] as Shot;
const BASE = '/?level=L1&engine=rapier&look=candy&offscreen=1';

/** Fire the miss, wait until it has run `steps` steps and is still running, then try the par shot. */
async function fireWhileRunning(page: Page, steps: number): Promise<boolean> {
  const start = await page.evaluate(() => window.__game.stepIndex);
  expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
  await page.waitForFunction((at) => window.__game.stepIndex >= at, start + steps, { timeout: 60_000, polling: 50 });
  expect(await page.evaluate(() => window.__game.phase)).toBe('running');
  return page.evaluate((s) => window.__game.fire(s), par);
}

/** The headless session of `line` on L1, as the page builds its Rapier driver. */
const headless = (line: Shot[]) => runSession(new RapierEngine(), compileLevel(L1), line, driverOptions('rapier'));

describe('rapid fire on the game page', () => {
  it('by default a click mid-shot goes in and cuts it; the recorded line replays headless to the same state', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(true);
    expect(await fireWhileRunning(page, 10)).toBe(true);
    await page.waitForFunction(() => window.__game.strokes === 2, undefined, { timeout: 30_000, polling: 50 });
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    const line = await page.evaluate(() => window.__game.line());
    console.log(`rapid line: ${writeShots(line)}`);
    expect(line).toHaveLength(2);
    expect(line[0]!.after).toBeUndefined();
    expect(line[1]!.after).toBeGreaterThanOrEqual(10);
    expect(await page.evaluate(() => window.__game.counts.cut)).toBe(1);
    const r = await headless(line);
    expect(r.session.outcomes[0]!.cut).toBe(true);
    expect(await page.evaluate(() => window.__game.state())).toEqual({ step: r.steps, phase: r.session.phase, strokes: 2, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(await page.evaluate(() => window.__game.result)).toEqual(r.session.score);
    // The handle's own replay (a fresh engine on the page) agrees too.
    expect(await page.evaluate((l) => window.__game.replay(l), line)).toEqual(await page.evaluate(() => window.__game.state()));

    // The same line from a link: the timed shot goes in at its step, to the same state.
    const link = await game.open(`${BASE}&keystone.shots=${encodeURIComponent(writeShots(line))}`);
    expect(link).not.toBeNull();
    await link!.page.evaluate(() => { window.__game.fast = true; });
    await link!.page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    expect(await link!.page.evaluate(() => window.__game.line())).toEqual(line);
    expect(await link!.page.evaluate(() => window.__game.state())).toEqual(await page.evaluate(() => window.__game.state()));
    expect(link!.errors).toEqual([]);
    await link!.page.close();
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('with keystone.rapid=0 a click mid-shot is refused, and the next shot waits for the settle', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`${BASE}&keystone.rapid=0`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(false);
    expect(await fireWhileRunning(page, 10)).toBe(false);
    expect(await page.evaluate(() => window.__game.strokes)).toBe(1);
    await page.evaluate(() => { window.__game.fast = true; });
    await ready(page, 120_000);
    expect(await page.evaluate((s) => window.__game.fire(s), par)).toBe(true);
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    const line = await page.evaluate(() => window.__game.line());
    expect(line.map((s) => s.after)).toEqual([undefined, undefined]);
    expect(await page.evaluate(() => window.__game.counts.cut)).toBeUndefined();
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});
