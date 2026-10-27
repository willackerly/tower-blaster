// Each level's par line, pinned on the f64 AVBD reference, must also clear on
// the GPU solver (f32; SwiftShader here, Metal on the M5 Max) with no
// heritage broken: the game plays what the bot pinned. One file per level
// (par-gpu-L*.test.ts) so CI's shards can share them out: SwiftShader takes
// one to three minutes a level at 40 iterations.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { LEVELS, type Shot } from '@tb/keystone';
import { gamePage, playShots } from './page.ts';

const MINUTES = 60_000;

/** The par-line check for one level, with extra checks on the page before the first shot and after the level cleared. */
export function parOnGpu(id: string, more: { before?(page: Page): Promise<void>; after?(page: Page, shots: Shot[]): Promise<void> } = {}): void {
  const def = LEVELS.find((l) => l.id === id)!;
  const game = gamePage();
  describe(`${id} on the GPU solver`, () => {
    it('the par line clears with no heritage broken', async (ctx) => {
      if (!game.browser()) return ctx.skip();
      // Loading runs the pre-settle: 300 steps at 40 iterations.
      const o = await game.open(`/?level=${id}&offscreen=1&engine=gpu`, 10 * MINUTES);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      expect(await page.evaluate(() => window.__game.engine)).toBe('gpu');
      await more.before?.(page);
      const shots = def.solutions!.par as Shot[];
      await playShots(page, shots, 20 * MINUTES);
      const live = await page.evaluate(() => window.__game.state());
      const adapter = await page.evaluate(async () => { const i = (await navigator.gpu.requestAdapter())?.info; return i ? `${i.vendor} ${i.architecture} ${i.description}`.trim() : 'none'; });
      console.log(`${id} on the GPU (${adapter}): ${live.phase}, ${live.step} steps`);
      expect({ phase: live.phase, strokes: live.strokes, heritageBroken: live.heritageBroken }).toEqual({ phase: 'cleared', strokes: def.par, heritageBroken: 0 });
      await more.after?.(page, shots);
      expect(errors).toEqual([]);
      await page.close();
    }, 60 * MINUTES);
  });
}
