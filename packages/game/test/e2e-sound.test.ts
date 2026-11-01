// The game's collision sound in headless Chromium: the first key (the browser's user gesture)
// starts it, the L1 par line's collapse reaches the audio thread and plays under the limiter, and
// keystone.sound=synth keeps the old voices with no collision sound at all.
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, playShots, ready } from './page.ts';

const game = gamePage();

describe('game page: collision sound', () => {
  it('a key starts it; the par line\'s impacts play under the limiter', { timeout: 240_000 }, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.sound().status)).toBe('off'); // nothing before a gesture
    await page.keyboard.press('Shift');
    await page.waitForFunction(() => ['on', 'error'].includes(window.__game.sound().status), undefined, { timeout: 30_000, polling: 250 });
    expect(await page.evaluate(() => window.__game.sound())).toMatchObject({ mode: 'collapse', status: 'on', error: '' });
    await playShots(page, L1.solutions!.par as Shot[], 120_000);
    // Stats come every 64 blocks (171 ms): wait for the one after the collapse.
    await page.waitForFunction(() => (window.__game.sound().stats?.impacts ?? 0) > 0 && (window.__game.sound().stats?.loudest ?? 0) > 0, undefined, { timeout: 30_000, polling: 250 });
    const s = await page.evaluate(() => window.__game.sound());
    expect(s.posted).toBeGreaterThan(10);
    expect(s.stats!.overflow).toBe(0);
    expect(s.stats!.loudest).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('keystone.sound=synth: no collision sound', { timeout: 120_000 }, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier&keystone.sound=synth');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.keyboard.press('Shift');
    await playShots(page, (L1.solutions!.par as Shot[]).slice(0, 1), 120_000);
    expect(await page.evaluate(() => window.__game.sound())).toEqual({ mode: 'synth', status: 'off', error: '', posted: 0, stats: null });
    expect(errors).toEqual([]);
    await page.close();
  });
});
