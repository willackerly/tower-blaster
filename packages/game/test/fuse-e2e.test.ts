// Fuse & Fold on the game page (M5, docs/game/fuse-and-fold.md), on the GPU solver (SwiftShader in CI): the
// timeline panel shows the level's charges, the Sweep tool sets their delays, the Plunger fires every charge,
// and the first level's two outcomes hold on the GPU as the search found them on the reference: a west sweep
// folds the tower into its yard (cleared), everything at once drops it a storey (failed). The panel never moves
// the camera.
import { describe, expect, it } from 'vitest';
import { compileLevel, FUSE_LEVELS } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
const F1 = FUSE_LEVELS[0]!;
const charges = F1.charges!.length;

describe('fuse & fold on the game page', () => {
  it('F1 has a plunger, four cutters and a fold objective', () => {
    expect(F1.rack).toEqual(['plunger']);
    expect(charges).toBe(4);
    expect(compileLevel(F1).def.objective.kind).toBe('fold');
  });

  it('GPU: the panel sweeps west, the plunger folds the tower into its yard; all at once after Retry drops it in place', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=${F1.id}&engine=gpu&offscreen=1`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 5 * MINUTES);
    const panel = page.locator('.kg-fuse.show');
    await expect.poll(() => panel.count()).toBe(1);
    expect(await panel.locator('.r').count()).toBe(charges);
    // PT20: the stars hold on the GPU (cast on the reference, checked here), so nothing says custom.
    expect(await page.locator('.custom').count()).toBe(0);
    const view0 = await page.evaluate(() => window.__game.view);
    // Sweep west at the default spacing, then two steps more (0.8 s between the rows).
    await panel.locator('button[data-dir="W"]').click();
    await panel.locator('button[data-act="sp+"]').click();
    await panel.locator('button[data-act="sp+"]').click();
    const times = await panel.locator('.r .t').allTextContents();
    expect(new Set(times)).toEqual(new Set(['0.0 s', '0.8 s']));
    expect(await page.evaluate(() => window.__game.view)).toEqual(view0);
    await page.evaluate(() => { window.__game.fast = true; });
    await panel.locator('button.plunger').click();
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 20 * MINUTES, polling: 250 });
    const fell = await page.evaluate(() => ({ phase: window.__game.phase, collapse: window.__game.collapse, fired: window.__game.counts.fired }));
    expect(fell.phase).toBe('cleared');
    expect(fell.collapse).toBeGreaterThan(0.6);
    expect(fell.fired).toBe(1);
    expect(await page.locator('.custom').count()).toBe(0);
    // Retry, all at once: the frame drops a storey and stands.
    await page.evaluate(() => window.__game.retry());
    await ready(page, 5 * MINUTES);
    await panel.locator('button[data-act="clear"]').click();
    await page.evaluate(() => { window.__game.fast = true; });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 20 * MINUTES, polling: 250 });
    const drop = await page.evaluate(() => ({ phase: window.__game.phase, collapse: window.__game.collapse }));
    expect(drop.phase).toBe('failed');
    expect(drop.collapse).toBeLessThan(0.4);
    expect(fell.collapse - drop.collapse).toBeGreaterThan(0.1);
    expect(errors).toEqual([]);
    await page.close();
  }, 30 * MINUTES);
});
