// PT1's gate on the game page (headless Chromium; SwiftShader in CI): open a level at a desktop or phone shape,
// read the renderer's ID pass at the opening view (handle.sightlines), leave out what the page's own HUD panels
// cover (measured from the DOM, so a HUD re-layout is checked as it ships), and count the objectives in sight.
import { describe, expect, it } from 'vitest';
import { compileLevel, levelById, SERIES } from '@tb/keystone';
import { seen } from '../src/sightlines.ts';
import { CROWNS_SEEN } from '../src/view.ts';
import { type GamePage, gamePage, ready } from './page.ts';

export const SHAPES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
} as const;

export interface Sight { crowns: number; crownsSeen: number; heritage: number; heritageSeen: number }

/** Open `id` at `shape` (URL keys `extra` added) on Rapier (the opening view does not depend on the engine) and count what the ID pass shows. */
export async function sightOf(game: GamePage, id: string, shape: keyof typeof SHAPES, extra = ''): Promise<Sight | null> {
  const s = SHAPES[shape], { width, height } = s.viewport;
  // keystone.build=0: a workshop (T-W1) opens on its play view, not its build phase (the gate is about the view the shots are aimed from).
  const o = await game.open(`/?level=${id}&engine=rapier&offscreen=${width}x${height}&progress=off&door=0&keystone.build=0${extra}`, 10 * 60_000, s);
  if (!o) return null;
  const { page, errors } = o;
  await ready(page, 10 * 60_000); // the structure is in the renderer's source once the level is ready to play
  const got = await page.evaluate(async () => {
    const W = innerWidth, H = innerHeight;
    const shown = (e: Element) => getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    // A docked HUD (ui.ts DOCK_CSS, a phone) spans the screen with no background of its own: what covers the
    // scene is its strip, tray and the hints over the tray, its children.
    const covered = [...document.querySelectorAll<HTMLElement>('.kg-panel')]
      .filter((e) => !e.classList.contains('kg-result') && shown(e))
      .flatMap((e) => (e.classList.contains('kg-dock') && getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)' ? [...e.children].filter(shown) : [e]))
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ left: r.left / W, top: r.top / H, right: r.right / W, bottom: r.bottom / H }));
    return window.__game.sightlines(covered);
  });
  expect(errors).toEqual([]);
  await page.close();
  expect(got).not.toBeNull();
  const c = compileLevel(levelById(id)), n = (list: Int32Array | readonly number[]) => Array.from(list).filter((i) => seen(got!.px[i]!, got!.solo[i]!)).length;
  return { crowns: c.meta.crowns.length, crownsSeen: n(c.meta.crowns), heritage: c.meta.heritage.length, heritageSeen: n(c.meta.heritage) };
}

/** The PT1 verify: at least CROWNS_SEEN of the crowns and one heritage body in sight. */
export function expectObjectivesInSight(s: Sight): void {
  expect(s.crownsSeen).toBeGreaterThanOrEqual(Math.ceil(CROWNS_SEEN * s.crowns - 1e-9));
  if (s.heritage > 0) expect(s.heritageSeen).toBeGreaterThanOrEqual(1);
}

/** Levels with objectives and under 1,000 bodies (the city levels are sightlines-city-gpu.test.ts's). */
const chambers = () => SERIES.flat().filter((d) => { const c = compileLevel(d); return c.meta.n < 1000 && c.meta.crowns.length + c.meta.heritage.length > 0; }).map((d) => d.id);

/** The chamber levels' PT1 gate at one shape, on a game page of its own (one shape a file keeps each under CI's 300 s). */
export function chamberSightSuite(shape: keyof typeof SHAPES): void {
  const game = gamePage(), CHAMBERS = chambers();
  describe('PT1: objectives in sight at the opening view (ID pass, chamber levels)', () => {
    it(`${shape}: ${CHAMBERS.join(', ')}`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      for (const id of CHAMBERS) {
        const s = await sightOf(game, id, shape);
        if (!s) return ctx.skip();
        ctx.annotate(`${id}: crowns ${s.crownsSeen}/${s.crowns}, heritage ${s.heritageSeen}/${s.heritage}`);
        expectObjectivesInSight(s);
      }
    }, 10 * 60_000);
  });
}
