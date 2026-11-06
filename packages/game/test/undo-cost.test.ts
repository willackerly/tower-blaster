// What an undo costs on a big level (roadmap U6, docs/game/undo.md): B1 (1k) and B2 (5k) play their
// ace line (three shots), then undo three times; each undo's wall time and the steps it replayed are
// printed. A measurement for a real GPU only, so it runs only with TB_UNDO_COST=1 (with
// TB_CHANNEL=chrome on the Mac: Metal). Timings from SwiftShader are never performance results.
import { describe, expect, it } from 'vitest';
import { B1, B2, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const on = process.env.TB_UNDO_COST === '1';
const game = gamePage();

describe.runIf(on)('undo cost on a big level', () => {
  for (const level of [B1, B2]) {
    it(`${level.id}: three undos after the ace line`, async () => {
      const o = await game.open(`/?level=${level.id}&engine=gpu&offscreen=1&progress=off`, 20 * MINUTES);
      expect(o).not.toBeNull();
      const { page, errors } = o!;
      await ready(page, 20 * MINUTES);
      await page.evaluate(() => { window.__game.fast = true; });
      const line = level.solutions!.ace! as Shot[];
      for (const [i, s] of line.entries()) {
        await ready(page, 20 * MINUTES);
        if (await page.evaluate(() => window.__game.result !== null)) break;
        expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
        await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), i + 1, { timeout: 20 * MINUTES, polling: 100 });
      }
      const rows: string[] = [];
      for (let n = await page.evaluate(() => window.__game.strokes); n > 0; n--) {
        const t = await page.evaluate(async () => { const t0 = performance.now(); await window.__game.undo(); return { ms: performance.now() - t0, step: window.__game.stepIndex, load: window.__game.timing.loadMs }; });
        rows.push(`undo to ${n - 1} shots: ${t.ms.toFixed(0)} ms wall (${t.load.toFixed(0)} ms in the load), ${t.step} engine steps`);
      }
      console.log(`${level.id} undo cost:\n  ${rows.join('\n  ')}`);
      expect(errors).toEqual([]);
      await page.close();
    }, 60 * MINUTES);
  }
});
