// PT1's gate on the game page (headless Chromium; SwiftShader in CI): open a level at a desktop or phone shape,
// read the renderer's ID pass at the opening view (handle.sightlines), leave out what the page's own HUD panels
// cover (measured from the DOM, so a HUD re-layout is checked as it ships), and count the objectives in sight.
import { expect } from 'vitest';
import { compileLevel, levelById } from '@tb/keystone';
import { seen } from '../src/sightlines.ts';
import { CROWNS_SEEN } from '../src/view.ts';
import { type GamePage, ready } from './page.ts';

export const SHAPES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
} as const;

export interface Sight { crowns: number; crownsSeen: number; heritage: number; heritageSeen: number }

/** Open `id` at `shape` (URL keys `extra` added) on Rapier (the opening view does not depend on the engine) and count what the ID pass shows. */
export async function sightOf(game: GamePage, id: string, shape: keyof typeof SHAPES, extra = ''): Promise<Sight | null> {
  const s = SHAPES[shape], { width, height } = s.viewport;
  const o = await game.open(`/?level=${id}&engine=rapier&offscreen=${width}x${height}&progress=off&door=0${extra}`, 10 * 60_000, s);
  if (!o) return null;
  const { page, errors } = o;
  await ready(page, 10 * 60_000); // the structure is in the renderer's source once the level is ready to play
  const got = await page.evaluate(async () => {
    const W = innerWidth, H = innerHeight;
    const covered = [...document.querySelectorAll<HTMLElement>('.kg-panel')]
      .filter((e) => !e.classList.contains('kg-result') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden')
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
