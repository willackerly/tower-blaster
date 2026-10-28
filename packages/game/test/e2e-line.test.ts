// The game page with ?keystone.shots (params.ts, playLine in play.ts): a link's
// line plays on load through the path a click takes, to the session runSession
// reaches headless, and moving to another level keeps the URL's other keys and
// drops the line. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();

describe('game page, a line in the link', () => {
  it('plays the line on load to runSession\'s session, and N keeps the other keys and drops the line', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
    const line = [miss, ...(L1.solutions!.par as Shot[])];
    const o = await game.open(`/?level=L1&engine=rapier&look=candy&offscreen=1&keystone.shots=${writeShots(line)}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    const r = await runSession(new RapierEngine(), compileLevel(L1), line, driverOptions('rapier'));
    expect(await page.evaluate(() => window.__game.state())).toEqual({ step: r.steps, phase: r.session.phase, strokes: 2, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(await page.evaluate(() => window.__game.result)).toEqual(r.session.score);

    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__game.level === 'L2', undefined, { timeout: 60_000 });
    await ready(page);
    expect(Object.fromEntries(new URLSearchParams(await page.evaluate(() => location.search)))).toEqual({ level: 'L2', engine: 'rapier', look: 'candy', offscreen: '1' });
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });
});
