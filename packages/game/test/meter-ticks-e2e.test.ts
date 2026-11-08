// The Down bar's star labels never overlap (PT2 Metal look review, 2026-11-08: on B3, the 2★ at 53% and the 3★ at
// 61% drew on top of each other). The HUD is laid out with the game's own CSS, with no engine, since the HUD is a pure
// function of its state (hud.ts hudHtml). Covered: every series level's cast ticks (meterTicks; B3's are the closest
// of any level today) plus made-up worst cases (three ticks within 2%, and ticks against either end). Each is laid
// out on the desktop HUD (1280x800, the 640x400 test page) and on the docked phone HUD (390x844, a 360x780 phone,
// 844x390). Checks:
//   - no two labels overlap, and there is at least a pixel between them;
//   - each label still reads as its tick's: its box spans the tick, or ends within 4 px of it. The made-up cases are
//     only held to order and no overlap: three labels 63 px wide over 3 px of ticks cannot all sit by their ticks.
import { describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, SERIES } from '@tb/keystone';
import { hudHtml, type HudState, meterTicks, type MeterTick, rackChips } from '../src/hud.ts';
import { GAME_CSS } from '../src/ui.ts';
import { gamePage } from './page.ts';

const game = gamePage();
const VIEWS = [
  ['desktop 1280x800', 1280, 800, false],
  ['desktop 640x400', 640, 400, false],
  ['phone upright', 390, 844, true],
  ['small phone upright', 360, 780, true],
  ['phone sideways', 844, 390, true],
] as const;

const B3 = SERIES.flat().find((d) => d.id === 'B3')!;
/** Every level with more than one tick, as cast, and the made-up cases on B3's HUD. */
const CASES: { name: string; def: LevelDef; ticks: MeterTick[]; near: number }[] = [
  ...SERIES.flat().map((def) => ({ name: def.id, def, ticks: meterTicks(compileLevel(def)), near: 4 })).filter((c) => c.ticks.length > 1),
  { name: 'three within 2%', def: B3, ticks: [{ at: 0.5, stars: 1 }, { at: 0.51, stars: 2 }, { at: 0.52, stars: 3 }], near: Infinity },
  { name: 'two at the start', def: B3, ticks: [{ at: 0.02, stars: 1 }, { at: 0.05, stars: 2 }, { at: 0.6, stars: 3 }], near: Infinity },
  { name: 'two at the end', def: B3, ticks: [{ at: 0.4, stars: 1 }, { at: 0.95, stars: 2 }, { at: 0.98, stars: 3 }], near: Infinity },
];

const hud = (def: LevelDef, ticks: MeterTick[]) => {
  const c = compileLevel(def);
  const s: HudState = {
    level: def, strokes: 1, crownsDown: 0, crownsTotal: c.meta.crowns.length, heritageBroken: 0, heritageTotal: c.meta.heritage.length,
    chips: rackChips(def.rack, def.rack, def.rack[0] ?? null), power: 100, launch: 4, leverage: { round: 1, shot: 1 }, phase: 'aiming', reachable: null,
    collapse: 0.31, pulled: 0, met: false, canBank: true, opener: false, ticks,
  };
  return hudHtml(s);
};

describe('the Down bar star labels never overlap (PT2 review)', () => {
  for (const [name, width, height, docked] of VIEWS) it(name, async (ctx) => {
    const b = game.browser();
    if (!b) return ctx.skip();
    const page = await b.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ...(docked ? { isMobile: true, hasTouch: true } : {}) });
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${GAME_CSS}</style></head><body class="${docked ? 'kg-touch' : ''}"><div id="hud" class="kg-panel kg-hud${docked ? ' kg-dock' : ''}"></div></body></html>`);
    expect(CASES.map((c) => c.name)).toContain('B3');
    for (const c of CASES) {
      const m = await page.evaluate((html) => {
        const el = document.getElementById('hud')!;
        el.innerHTML = html;
        const bar = el.querySelector('.meter')!;
        return {
          bar: bar.getBoundingClientRect().width,
          ticks: [...bar.querySelectorAll<HTMLElement>('.tick')].map((t) => {
            const x = t.getBoundingClientRect(), l = t.querySelector('b')!.getBoundingClientRect();
            return { stars: t.querySelector('b')!.textContent!.length, tick: x.left + x.width / 2, l: l.left, r: l.right };
          }),
        };
      }, hud(c.def, c.ticks));
      const what = `${name}, ${c.name} (bar ${m.bar.toFixed(0)} px)`;
      if (c.name === 'B3') console.log(what, JSON.stringify(m.ticks));
      expect(m.ticks.map((t) => t.stars), what).toEqual(c.ticks.map((t) => t.stars));
      for (let i = 1; i < m.ticks.length; i++) {
        expect(m.ticks[i]!.l, `${what}: ${m.ticks[i]!.stars}★ starts a pixel after ${m.ticks[i - 1]!.stars}★ ends`).toBeGreaterThanOrEqual(m.ticks[i - 1]!.r + 1);
      }
      for (const t of m.ticks) {
        const off = t.tick < t.l ? t.l - t.tick : t.tick > t.r ? t.tick - t.r : 0;
        expect(off, `${what}: ${t.stars}★ by its tick`).toBeLessThanOrEqual(c.near);
      }
    }
    await page.close();
  });
});
