// What a level start costs (docs/game/level-start.md): for each pace (keystone.loadpace), the game
// page opens a level, retries it twice, plays its par (or ace) line to the result card, and clicks
// Next (the level built while the card showed, unless keystone.prefetch=0); it prints each load's wall
// time split into its phases (GameHandle.timing.load) and the longest gap between animation frames
// while it ran. A measurement for a real GPU only, so it runs only with TB_LOAD_COST=1 (with
// TB_CHANNEL=chrome on the Mac: Metal). The page draws only for captures (offscreen) unless TB_LOAD_DRAW=1, which
// draws to its canvas so frames queue on the GPU too (headless SwiftShader loses its device there). Timings from
// SwiftShader are never performance results; there they only show which phases the work is in.
// TB_LOAD_LEVELS=L1,B1 picks the levels (default L1, B1, B2, B3); TB_LOAD_PACES=8,0 the paces (default
// 8 and 0: paced, and unpaced as before); TB_LOAD_CARD_MS=1500 how long the card shows before Next
// (default 0: Next at once, the worst case); TB_LOAD_RETRY=rebuild retries by building
// again (default checkpoint: keystone.retry); TB_LOAD_OUT=<file> appends the table to a file.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { levelById, seriesOf, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';
import type { LoadPhases } from '../src/play.ts';

const MINUTES = 60_000;
const on = process.env.TB_LOAD_COST === '1';
const levels = (process.env.TB_LOAD_LEVELS ?? 'L1,B1,B2,B3').split(',').filter(Boolean);
const paces = (process.env.TB_LOAD_PACES ?? '8,0').split(',').filter(Boolean);
const cardMs = Number(process.env.TB_LOAD_CARD_MS ?? 0);
const draw = process.env.TB_LOAD_DRAW === '1';
const retryMode = process.env.TB_LOAD_RETRY ?? 'checkpoint';
const game = gamePage();

const f = (x: number) => x.toFixed(0);
const row = (what: string, ms: number, gap: number, p: LoadPhases) =>
  `${what.padEnd(14)} ${f(ms).padStart(6)} ms  frame gap ${f(gap).padStart(5)} ms | check ${f(p.check)} compile ${f(p.compile)} init ${f(p.init)} presettle ${f(p.presettle)} (${p.steps} steps) replay ${f(p.replay)} swap ${f(p.swap)}${p.prefetched ? `  prefetched, waited ${f(p.wait)}` : ''}${p.restored ? '  restored from the start checkpoint' : ''}`;

/** Starts recording the longest gap between animation frames; the returned function stops and reads it. */
async function gapMeter(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __gap: { last: number; max: number; on: boolean } };
    w.__gap = { last: performance.now(), max: 0, on: true };
    const tick = (t: number) => { const g = w.__gap; if (!g.on) return; g.max = Math.max(g.max, t - g.last); g.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => { const g = (window as unknown as { __gap: { last: number; max: number; on: boolean } }).__gap; g.on = false; return Math.max(g.max, performance.now() - g.last); });
}

describe.runIf(on)('level start cost', () => {
  for (const id of levels) for (const pace of paces) {
    it(`${id} at loadpace ${pace}: open, retry twice, line, Next`, async () => {
      const def = levelById(id);
      const series = seriesOf(id)!, k = series.findIndex((l) => l.id === def.id), next = series[k + 1]?.id;
      const o = await game.open(`/?level=${def.id}&engine=gpu${draw ? '' : '&offscreen=1'}&progress=off&door=0&keystone.loadpace=${pace}&keystone.retry=${retryMode}`, 30 * MINUTES);
      expect(o).not.toBeNull();
      const { page, errors } = o!;
      await ready(page, 30 * MINUTES);
      const timed = async (what: string, act: () => Promise<unknown>, until?: () => Promise<unknown>) => {
        const stop = await gapMeter(page);
        const t0 = Date.now();
        await act();
        await until?.();
        await ready(page, 30 * MINUTES);
        const ms = Date.now() - t0, gap = await stop();
        return row(what, ms, gap, await page.evaluate(() => window.__game.timing.load));
      };
      const first = await page.evaluate(() => window.__game.timing);
      const rows = [row('open', first.loadMs, NaN, first.load)];
      for (const r of [1, 2]) rows.push(await timed(`retry ${r}`, () => page.evaluate(() => window.__game.retry())));
      const line = (def.solutions?.par ?? def.solutions?.ace) as Shot[] | undefined;
      if (line && next) {
        await page.evaluate(() => { window.__game.fast = true; });
        for (const [i, s] of line.entries()) {
          await ready(page, 30 * MINUTES);
          if (await page.evaluate(() => window.__game.result !== null)) break;
          expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
          await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), i + 1, { timeout: 30 * MINUTES, polling: 100 });
        }
        if (await page.evaluate(() => window.__game.result === null)) await page.evaluate(() => window.__game.bank());
        await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 30 * MINUTES, polling: 100 });
        if (cardMs > 0) await page.waitForTimeout(cardMs);
        rows.push(await timed(`Next (${next})`, () => page.click('#result [data-act="next"]'), () => page.waitForFunction((x) => window.__game.level === x, next, { timeout: 30 * MINUTES, polling: 20 })));
      }
      const text = `${def.id} level start cost, loadpace ${pace}, retry ${retryMode}, card ${cardMs} ms, ${draw ? 'drawing' : 'offscreen'} (${await page.evaluate(() => window.__game.engine)}):\n  ${rows.join('\n  ')}\n`;
      console.log(text);
      if (process.env.TB_LOAD_OUT) appendFileSync(process.env.TB_LOAD_OUT, text);
      expect(errors).toEqual([]);
      await page.close();
    }, 120 * MINUTES);
  }
});
