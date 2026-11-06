// What an undo costs on a big level (roadmap U6, docs/game/undo.md): B1 (1k), B2 (5k) and B3 (10k) play
// their ace line, then undo every shot, from the checkpoints (the default) and by replay
// (keystone.undo=0); each undo's wall time, how it went back, and the checkpoint memory held after
// the line are printed. A measurement for a real GPU only, so it runs only with TB_UNDO_COST=1 (with
// TB_CHANNEL=chrome on the Mac: Metal). Timings from SwiftShader are never performance results.
import { describe, expect, it } from 'vitest';
import { B1, B2, B3, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const on = process.env.TB_UNDO_COST === '1';
const game = gamePage();

describe.runIf(on)('undo cost on a big level', () => {
  for (const level of [B1, B2, B3]) for (const mode of ['checkpoint', 'replay'] as const) {
    it(`${level.id}: undo every shot of the ace line (${mode})`, async () => {
      const o = await game.open(`/?level=${level.id}&engine=gpu&offscreen=1&progress=off${mode === 'replay' ? '&keystone.undo=0' : ''}`, 20 * MINUTES);
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
      const mem = await page.evaluate(() => window.__game.undoMemory());
      const rows: string[] = [];
      for (let n = await page.evaluate(() => window.__game.strokes); n > 0; n--) {
        const t = await page.evaluate(async () => { const t0 = performance.now(); await window.__game.undo(); return { ms: performance.now() - t0, step: window.__game.stepIndex, how: window.__game.undone }; });
        expect(t.how!.mode).toBe(mode);
        rows.push(`undo to ${n - 1} shots: ${t.ms.toFixed(1)} ms wall (${t.how!.mode}, ${t.how!.ms.toFixed(1)} ms inside), at engine step ${t.step}`);
      }
      console.log(`${level.id} undo cost (${mode}; ${mem.marks} checkpoints, ${(mem.bytes / 2 ** 20).toFixed(1)} MB held after the line):\n  ${rows.join('\n  ')}`);
      expect(errors).toEqual([]);
      await page.close();
    }, 60 * MINUTES);
  }
});
