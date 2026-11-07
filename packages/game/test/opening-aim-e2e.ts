// PT29's e2e (docs/game/aim-clarity.md), shared by opening-aim-e2e-desktop.test.ts and opening-aim-e2e-phone.test.ts
// (one file per viewport, so CI's shards can share them): every level the player aims at a point opens with no
// "Out of reach" at shot 0. Where it shows an opening aim, that preview lands on a structure block that is not
// heritage, its dots stay within PT36's size, and a tap or click at its point aims the same shot, reachable, with
// no warning. Rapier (the levels' load is the test's cost, not their physics); offscreen.
import { devices, type BrowserContextOptions } from 'playwright';
import { describe, expect, it } from 'vitest';
import { compileLevel, SERIES } from '@tb/keystone';
import { nextSelection } from '../src/hud.ts';
import { aimsAtPoint } from '../src/opening-aim.ts';
import { DOT_MAX_PX } from '../src/preview-dots.ts';
import { gamePage, ready } from './page.ts';

export const AIMED_LEVELS = SERIES.flat().filter((d) => { const item = nextSelection(d.rack, d.rack, null); return item !== null && aimsAtPoint(item) && !d.build; });
/** A level's family: its id less the number (L, B, W, T-S, T-X, T-B, T-I). */
const family = (id: string) => id.replace(/\d.*$/, '');
/** On a PR (CI rule O5): every chamber level (a few seconds each) and the first level of each other family; PHYSICS_GPU_SLOW=1 (the nightly run) loads them all. */
export const PR_LEVELS = AIMED_LEVELS.filter((d, i) => family(d.id) === 'L' || AIMED_LEVELS.findIndex((x) => family(x.id) === family(d.id)) === i);
const LEVELS = process.env.PHYSICS_GPU_SLOW === '1' ? AIMED_LEVELS : PR_LEVELS;

const SHAPES: Record<'desktop' | 'phone', { size: string; context: BrowserContextOptions }> = {
  desktop: { size: '1280x800', context: { viewport: { width: 1280, height: 800 } } },
  phone: { size: '390x844', context: { ...devices['iPhone 13']!, viewport: { width: 390, height: 844 } } },
};

export function openingAimE2e(shape: 'desktop' | 'phone'): void {
  const game = gamePage(), { size, context } = SHAPES[shape];
  describe(`game page at ${size}, the aim at shot 0`, () => {
    for (const def of LEVELS) {
      it(`${def.id}: no "Out of reach"; the opening aim lands on the structure, off heritage, and a tap there aims it`, async (ctx) => {
        if (!game.browser()) return ctx.skip();
        const o = await game.open(`/?level=${def.id}&engine=rapier&offscreen=${size}&progress=off&door=0`, 120_000, context);
        if (!o) return ctx.skip();
        const { page, errors } = o;
        await ready(page, 120_000);
        const f0 = await page.evaluate(() => window.__game.frames);
        await page.waitForFunction((n) => window.__game.frames > n + 2, f0, { timeout: 60_000, polling: 100 });
        const at0 = await page.evaluate(() => ({ impact: window.__game.impact, opening: window.__game.openingAim, aimed: window.__game.input.aimed, dots: window.__game.view.dots, hud: document.querySelector('.kg-hud')!.textContent }));
        expect(at0.hud).not.toMatch(/Out of reach/);
        expect(at0.aimed).toBeNull();
        const c = compileLevel(def), heritage = new Set(c.meta.heritage);
        if (at0.impact?.opener) return void (await page.close()); // the pre-aimed opener's preview (aim-clarity-e2e.test.ts)
        expect(at0.opening, 'an opening aim').not.toBeNull();
        expect(at0.impact).toMatchObject({ opening: true, body: at0.opening!.body });
        expect(at0.opening!.body).toBeGreaterThanOrEqual(0);
        expect(heritage.has(at0.opening!.body)).toBe(false);
        expect(Math.max(0, ...at0.dots.map((d) => d.px))).toBeLessThanOrEqual(DOT_MAX_PX + 1e-6);
        // A tap or click where it rests: the same shot, reachable, no warning.
        const [x, y] = at0.opening!.ndc;
        const aimed = await page.evaluate(([px, py]) => window.__game.aim(px!, py!), [x, y]);
        expect(aimed?.reachable).toBe(true);
        expect(aimed?.shot).toEqual(at0.opening!.shot);
        const f1 = await page.evaluate(() => window.__game.frames);
        await page.waitForFunction((n) => window.__game.frames > n + 1, f1, { timeout: 60_000, polling: 100 });
        expect(await page.evaluate(() => document.querySelector('.kg-hud')!.textContent)).not.toMatch(/Out of reach/);
        expect(errors).toEqual([]);
        await page.close();
      }, 240_000);
    }
  });
}
