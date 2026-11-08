// A shot held on purpose is not slow motion (PT2 Metal look review, 2026-11-08). The agent playtest holds the shot
// (window.__game.hold) while it captures a frame, and the HUD's tag read "0% speed": the speed meter counted the
// held wall time as real time in which no sim time passed. Now the meter does not count held time
// (SpeedMeter.idle), so:
//   - while held, the HUD shows no speed tag and the handle reads real time;
//   - right after the hold, the meter reads what it read before the hold (within 20%: a frame or two of steps), and
//     never a tag under 20% (the sim on this machine is far faster than that).
// Rapier on L1, for speed.
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;

describe('a held shot is not slow motion (PT2 review)', () => {
  it('L1: no speed tag while held, and the pace after the hold is the pace before', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    const shot = (L1.solutions!.par as Shot[])[0]!;
    const start = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    // Two seconds of the shot as it runs, then hold it (in the page, so the hold lands on a step count).
    await page.waitForFunction((n) => window.__game.stepIndex >= n, start + 30, { timeout: MINUTES, polling: 'raf' });
    await page.waitForTimeout(1000);
    const before = await page.evaluate(() => { const g = window.__game; g.hold = true; return { speed: g.pace.speed, step: g.stepIndex, phase: g.phase }; });
    expect(before.phase, 'the shot still runs when held').toBe('running');
    await page.waitForTimeout(2000);
    const held = await page.evaluate(() => ({ pace: window.__game.pace, tag: document.querySelector('.kg-hud .pace')?.textContent ?? '', step: window.__game.stepIndex }));
    expect(held.step - before.step, 'no steps while held (one in flight at most)').toBeLessThanOrEqual(1);
    expect(held.pace.tag, 'no tag on the handle while held').toBe('');
    expect(held.tag, 'no tag on the HUD while held').toBe('');
    expect(held.pace.speed).toBe(1);
    // Release, and read the meter after a few frames of steps.
    await page.evaluate(() => { window.__game.hold = false; });
    await page.waitForFunction((n) => window.__game.stepIndex >= n || window.__game.phase !== 'running', held.step + 3, { timeout: MINUTES, polling: 'raf' });
    const after = await page.evaluate(() => window.__game.pace);
    console.log('pace', JSON.stringify({ before: before.speed, after: after.speed, tag: after.tag }));
    expect(after.speed, `the pace after the hold (${after.speed.toFixed(2)}) is the pace before (${before.speed.toFixed(2)})`).toBeGreaterThan(0.8 * Math.min(1, before.speed));
    expect(after.tag).not.toMatch(/^1?\d% speed$/);
    expect(errors).toEqual([]);
    await page.close();
  }, 4 * MINUTES);
});
