// SCRATCH (not committed): frames for the PT8/PT17 visual review. VR_DIR=<dir>.
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { encodePng } from '@tb/testkit';
import type { Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const dir = process.env.VR_DIR!;
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
type P = import('playwright').Page;
const save = async (page: P, name: string) => {
  const s = await page.evaluate(() => window.__game.capture(true));
  if (s?.pixels) writeFileSync(`${dir}/${name}.png`, encodePng(s.width, s.height, { data: Uint8Array.from(s.pixels.data), bytesPerRow: s.pixels.bytesPerRow }));
};

describe.skipIf(!dir)('visual review', () => {
  for (const look of ['candy', 'real']) {
    it(`frozen ${look}`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      const o = await game.open(`/?level=L1&engine=rapier&look=${look}&offscreen=1&keystone.rapid=0&keystone.freeze=1`);
      if (!o) return ctx.skip();
      const { page } = o;
      await ready(page);
      const start = await page.evaluate(() => window.__game.stepIndex);
      await page.evaluate((s) => window.__game.fire(s), miss);
      await page.waitForFunction((n) => window.__game.stepIndex >= n, start + 10, { timeout: 60_000, polling: 20 });
      await page.evaluate(() => window.__game.freeze(true));
      await page.waitForTimeout(500);
      await save(page, `frozen-${look}-graded`);
      await page.evaluate(() => { window.__game.feel.frozenLook = false; });
      await page.waitForTimeout(500);
      await save(page, `frozen-${look}-plain`);
      await page.close();
    }, 300_000);
    it(`crown ${look}`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      const o = await game.open(`/?level=U3&engine=rapier&look=${look}&offscreen=1`);
      if (!o) return ctx.skip();
      const { page } = o;
      await ready(page);
      await page.waitForTimeout(300);
      await save(page, `crown-${look}`);
      await page.close();
    }, 300_000);
  }
  it('pull', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const n of [5, 11]) {
      const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&look=candy&keystone.rack=pull,pull&keystone.freeze=1&keystone.frozenlook=0`);
      if (!o) return ctx.skip();
      const { page } = o;
      await ready(page);
      await page.evaluate(() => window.__game.select('pull'));
      const body = await page.evaluate(() => {
        for (let y = 0.9; y >= -0.9; y -= 0.05) for (let x = -0.3; x <= 0.3; x += 0.05) { const a = window.__game.aim(x, y); if (a && a.shot.ammo === 'pull' && a.reachable) return a.shot.body; }
        return -1;
      });
      await save(page, `pull-before-${n}`);
      const start = await page.evaluate(() => window.__game.stepIndex);
      await page.evaluate(([b, k]) => new Promise<void>((done) => {
        window.__game.fire({ ammo: 'pull', body: b });
        const t = setInterval(() => { if (window.__game.stepIndex >= k) { clearInterval(t); window.__game.freeze(true); done(); } }, 2);
      }), [body, start + n] as const);
      await page.waitForTimeout(150);
      await save(page, `pull-k${n}`);
      await page.close();
    }
  }, 300_000);
});
