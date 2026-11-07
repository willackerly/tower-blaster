// Level starts on the game page (docs/game/level-start.md), on Rapier, which is fast on a CPU: the
// next level is built ahead (from the result card, the offscreen default, or from the load while the
// player aims, keystone.prefetch=aim, held while a shot runs), so Next swaps it in, and the state it
// swaps in is the one a cold load of that level gives; and the pre-settle is paced, so frames keep drawing while a
// level loads (with keystone.loadpace=0, as before, they stop for the whole pre-settle). The GPU
// engine's paced pre-settle leaves the state an unpaced one does: every *-gpu test that compares the
// live state with handle.replay (an unpaced reset) checks that.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { B1, L1, type Shot } from '@tb/keystone';
import { gamePage, playShots, ready } from './page.ts';

const game = gamePage();
const MINUTE = 60_000;

/** Wall time of `act` (a load), and the longest gap between animation frames meanwhile, ms. */
async function frameGap(page: Page, act: () => Promise<unknown>): Promise<{ ms: number; gap: number; frames: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __gap: { last: number; max: number; n: number; on: boolean } };
    w.__gap = { last: performance.now(), max: 0, n: 0, on: true };
    const tick = (t: number) => { const g = w.__gap; if (!g.on) return; g.max = Math.max(g.max, t - g.last); g.last = t; g.n++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await act();
  await ready(page, 5 * MINUTE);
  const ms = Date.now() - t0;
  const g = await page.evaluate(() => { const w = window as unknown as { __gap: { last: number; max: number; n: number; on: boolean } }; w.__gap.on = false; return { max: Math.max(w.__gap.max, performance.now() - w.__gap.last), n: w.__gap.n }; });
  return { ms, gap: g.max, frames: g.n };
}

describe('level start', () => {
  it('builds the next level while the result card shows, and Next swaps in the state a cold load gives', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.counts.prefetch ?? 0)).toBe(0);
    await playShots(page, L1.solutions!.par as Shot[], 2 * MINUTE);
    expect(await page.evaluate(() => window.__game.result !== null)).toBe(true);
    expect(await page.evaluate(() => window.__game.counts.prefetch)).toBe(1);
    // A retry keeps the spare for a later Next, and the round's end does not build it twice.
    await page.evaluate(() => window.__game.retry());
    await ready(page);
    expect(await page.evaluate(() => ({ level: window.__game.level, prefetched: window.__game.timing.load.prefetched }))).toEqual({ level: 'L1', prefetched: false });
    await playShots(page, L1.solutions!.par as Shot[], 2 * MINUTE);
    // (A retry starts the attempt's counts afresh.)
    expect(await page.evaluate(() => window.__game.counts.prefetch ?? 0)).toBe(0);
    await page.click('#result [data-act="next"]');
    await page.waitForFunction(() => window.__game.level === 'L2', undefined, { timeout: MINUTE, polling: 50 });
    await ready(page);
    const next = await page.evaluate(() => ({ state: window.__game.state(), load: window.__game.timing.load }));
    expect(next.load.prefetched).toBe(true);
    // Its pre-settle ran while the card showed: none of it is in this load.
    expect(next.load.presettle).toBeGreaterThan(0);

    const cold = await game.open('/?level=L2&offscreen=1&engine=rapier&progress=off');
    await ready(cold!.page);
    const fresh = await cold!.page.evaluate(() => ({ state: window.__game.state(), load: window.__game.timing.load }));
    expect(fresh.load.prefetched).toBe(false);
    expect(next.state).toEqual(fresh.state);
    // The same as a replay of no shots on a fresh engine (an unpaced reset), on the page that prefetched.
    expect(await page.evaluate(() => window.__game.replay([]))).toEqual(next.state);
    expect(errors).toEqual([]);
    expect(cold!.errors).toEqual([]);
    await cold!.page.close();
    await page.close();
  }, 5 * MINUTE);

  it('retries from the start checkpoint in place, to the state the level loaded with, and plays the same again', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const runs: Record<string, unknown> = {};
    for (const mode of ['checkpoint', 'rebuild']) {
      const o = await game.open(`/?level=L1&offscreen=1&engine=rapier&progress=off&keystone.retry=${mode}`);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page);
      const loaded = await page.evaluate(() => window.__game.state());
      await playShots(page, L1.solutions!.par as Shot[], 2 * MINUTE);
      const first = await page.evaluate(() => ({ state: window.__game.state(), score: window.__game.result, looks: window.__game.firedLooks() }));
      expect(first.looks.length).toBeGreaterThan(0);
      for (let k = 0; k < 2; k++) {
        await page.evaluate(() => window.__game.retry());
        await ready(page);
        const r = await page.evaluate(() => ({ state: window.__game.state(), load: window.__game.timing.load, looks: window.__game.firedLooks() }));
        expect(r.load.restored, mode).toBe(mode === 'checkpoint');
        if (mode === 'checkpoint') expect(r.load.presettle).toBe(0);
        expect(r.state).toEqual(loaded);
        // The fired balls' paint goes with them: the restored world has none, and the line paints them again.
        expect(r.looks).toEqual([]);
        await playShots(page, L1.solutions!.par as Shot[], 2 * MINUTE);
        expect(await page.evaluate(() => ({ state: window.__game.state(), score: window.__game.result, looks: window.__game.firedLooks() }))).toEqual(first);
      }
      runs[mode] = { loaded, first };
      expect(errors).toEqual([]);
      await page.close();
    }
    expect(runs.checkpoint).toEqual(runs.rebuild);
  }, 5 * MINUTE);

  it('keystone.prefetch=aim builds the next level from the load, beside play that stays exact, and Next takes it', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier&progress=off&keystone.prefetch=aim');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => ({ built: window.__game.counts.prefetch, level: window.__game.spare?.level }))).toEqual({ built: 1, level: 'L2' });
    const line = L1.solutions!.par as Shot[];
    await playShots(page, line, 2 * MINUTE);
    // Built once: the round's end finds it there.
    expect(await page.evaluate(() => window.__game.counts.prefetch)).toBe(1);
    // The level played beside the prefetch is the one a fresh engine plays.
    const live = await page.evaluate(() => window.__game.state());
    expect(await page.evaluate((s) => window.__game.replay(s), line)).toEqual(live);
    await page.click('#result [data-act="next"]');
    await page.waitForFunction(() => window.__game.level === 'L2', undefined, { timeout: MINUTE, polling: 50 });
    await ready(page);
    const next = await page.evaluate(() => ({ state: window.__game.state(), load: window.__game.timing.load, spare: window.__game.spare }));
    expect(next.load.prefetched).toBe(true);
    // And on L2 the level after it is under way.
    expect(next.spare?.level).toBe('L3');
    expect(await page.evaluate(() => window.__game.replay([]))).toEqual(next.state);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTE);

  it('holds the prefetch while a shot runs, and lets it go on between shots', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    // B2's 5,184 cubes take Rapier seconds to pre-settle, so the first shot goes in while it is still settling.
    const o = await game.open(`/?level=${B1.id}&offscreen=1&engine=rapier&progress=off&door=0&keystone.prefetch=aim`, 5 * MINUTE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 5 * MINUTE);
    expect(await page.evaluate(() => window.__game.spare)).toEqual({ level: 'B2', settled: false });
    const shot = (B1.solutions!.ace as Shot[]).slice(0, 1);
    await playShots(page, shot, 5 * MINUTE);
    expect(await page.evaluate(() => window.__game.counts.prefetchHeld ?? 0)).toBeGreaterThan(0);
    // Between shots it goes on to the end.
    await page.waitForFunction(() => window.__game.spare?.settled === true, undefined, { timeout: 5 * MINUTE, polling: 100 });
    // The shot played beside the held prefetch lands where a fresh engine's does (a replay plays the
    // session on to its end, so only the step and the bodies are compared).
    const live = await page.evaluate(() => window.__game.state());
    const again = await page.evaluate((s) => window.__game.replay(s), shot);
    expect({ step: again.step, hash: again.hash }).toEqual({ step: live.step, hash: live.hash });
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTE);

  it('keystone.prefetch=0 builds nothing ahead', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier&progress=off&keystone.prefetch=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await playShots(page, L1.solutions!.par as Shot[], 2 * MINUTE);
    expect(await page.evaluate(() => window.__game.counts.prefetch ?? 0)).toBe(0);
    await page.click('#result [data-act="next"]');
    await page.waitForFunction(() => window.__game.level === 'L2', undefined, { timeout: MINUTE, polling: 50 });
    await ready(page);
    expect(await page.evaluate(() => window.__game.timing.load.prefetched)).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTE);

  it('keeps frames drawing through a paced pre-settle, where an unpaced one holds them', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    // B1's 1,000 cubes: Rapier's 300 pre-settle steps take long enough on one thread to see.
    const gaps: Record<string, { ms: number; gap: number; frames: number; presettle: number }> = {};
    for (const pace of ['8', '0']) {
      const o = await game.open(`/?level=${B1.id}&offscreen=1&engine=rapier&progress=off&door=0&keystone.retry=rebuild&keystone.loadpace=${pace}`, 5 * MINUTE);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page, 5 * MINUTE);
      const g = await frameGap(page, () => page.evaluate(() => window.__game.retry()));
      const p = await page.evaluate(() => window.__game.timing.load);
      expect(p.steps).toBe(300);
      gaps[pace] = { ...g, presettle: Math.round(p.presettle) };
      expect(errors).toEqual([]);
      await page.close();
    }
    console.log(`B1 retry on Rapier: paced ${JSON.stringify(gaps['8'])}, unpaced ${JSON.stringify(gaps['0'])}`);
    // Unpaced, the whole pre-settle is one task; paced, a frame gets in about every batch (8 ms) plus a step.
    // Both bounds are relative to this runner's own timings, never wall-clock caps: a CI runner's frame times are
    // not performance numbers (real ones: the Mac level-start bench). Seen on CI runners (rAF at 60 Hz): paced
    // gaps 17-100 ms over a 600-1,020 ms pre-settle; unpaced gaps 430-500 ms, about the whole pre-settle. A
    // fixed 100 ms cap failed on one slow runner at exactly 100. If pacing broke, the paced gap would be the
    // whole pre-settle and fail both checks below.
    expect(gaps['0']!.gap).toBeGreaterThan(0.8 * gaps['0']!.presettle);
    expect(gaps['8']!.gap).toBeLessThan(0.25 * gaps['8']!.presettle);
    expect(gaps['8']!.gap).toBeLessThan(0.5 * gaps['0']!.gap);
  }, 10 * MINUTE);
});
