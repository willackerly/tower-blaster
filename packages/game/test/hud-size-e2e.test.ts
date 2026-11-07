// The docked phone HUD keeps one size through a round, on every level (agent playtest round 2, PT30: L3's strip grew a
// line after shot 1 when "Heritage 1 cracked" wrapped). The HUD's markup for the first frame and for the widest the
// round can make it (every crown down, every heritage block cracked, the most strokes, a three-digit leverage, the
// objective met) is laid out with the game's own CSS at 390x844 and 844x390, and the status strip and aim tray must
// measure the same. No engine: the HUD is a pure function of its state (hud.ts hudHtml).
import { describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, lotSheetOf, scoringOf, SERIES } from '@tb/keystone';
import { hudHtml, type HudState, meterTicks, rackChips } from '../src/hud.ts';
import { goalsHudHtml } from '../src/lot-hud.ts';
import { hudProfile } from '../src/mode-ui.ts';
import { GAME_CSS } from '../src/ui.ts';
import { gamePage } from './page.ts';

const game = gamePage();
const LEVELS = SERIES.flat();

/** The first frame's HUD and the widest one the round can reach, for a level. */
function states(def: LevelDef): [string, string] {
  const c = compileLevel(def), crowns = c.meta.crowns.length, heritage = c.meta.heritage.length;
  const sheet = lotSheetOf(def.id);
  const goals = (met: boolean) => (sheet ? sheet.goals.map((g) => ({ id: g.id, text: g.text, met })) : []);
  const base: HudState = {
    level: def, strokes: 0, crownsDown: 0, crownsTotal: crowns, heritageBroken: 0, heritageTotal: heritage,
    chips: rackChips(def.rack, def.rack, def.rack[0] ?? null), power: 100, launch: 4, leverage: { round: 0, shot: 0 }, phase: 'aiming', reachable: null,
    collapse: 0, pulled: 0, met: false, canBank: false, opener: true, profile: hudProfile(def),
    ...(scoringOf(def) === 'outcome' ? { ticks: meterTicks(c) } : {}),
    ...(def.freeze !== undefined ? { freezes: { left: def.freeze, total: def.freeze, frozen: false, can: false } } : {}),
  };
  const last = def.rack.slice(-1);
  const widest: HudState = {
    ...base, strokes: Math.max(1, def.rack.length), crownsDown: crowns, heritageBroken: heritage, chips: rackChips(def.rack, last, last[0] ?? null),
    leverage: { round: 188, shot: 188 }, phase: 'running', collapse: 1, pulled: 1, met: true, canBank: true, opener: false, canSkip: true, pace: '20% speed',
    ...(def.freeze !== undefined ? { freezes: { left: 0, total: def.freeze, frozen: false, can: false } } : {}),
  };
  return [hudHtml(base, goalsHudHtml(goals(false), false)), hudHtml(widest, goalsHudHtml(goals(true), false))];
}

describe('the docked phone HUD keeps one size through every level\'s round (PT30)', () => {
  for (const [name, width, height] of [['upright', 390, 844], ['sideways', 844, 390]] as const) it(name, async (ctx) => {
    const b = game.browser();
    if (!b) return ctx.skip();
    const page = await b.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${GAME_CSS}</style></head><body class="kg-touch"><div id="hud" class="kg-panel kg-hud kg-dock"></div></body></html>`);
    const grew: string[] = [], shrank: string[] = [], cut: string[] = [];
    for (const def of LEVELS) {
      const [first, wide] = states(def);
      const m = await page.evaluate(([a, z]) => {
        const hud = document.getElementById('hud')!;
        const size = (html: string) => {
          hud.innerHTML = html;
          const st = hud.querySelector(':scope > .st')!.getBoundingClientRect(), tray = hud.querySelector(':scope > .tray')!.getBoundingClientRect();
          // Every rack chip inside the tray, none scrolled or cut off at its edge (the duel thread saw the rail's second chip clipped).
          const cut = [...hud.querySelectorAll('.tray [data-act="ammo"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < tray.left - 0.5 || r.right > tray.right + 0.5); }).length;
          return { st: Math.round(st.height), tray: Math.round(tray.height), cut };
        };
        return { a: size(a), z: size(z) };
      }, [first, wide] as const);
      // Neither may grow. Some get smaller after the first shot, by design: Aftershock's tray loses the quake designer,
      // Wavefront's strip its push hint, Rube Lab's tray its Run button. A smaller HUD only widens the free band the
      // opening view was framed in (PT3b), so the scene stays in it.
      if (m.a.cut || m.z.cut) cut.push(`${def.id}: ${m.a.cut} / ${m.z.cut} chips cut off`);
      if (m.z.st > m.a.st || m.z.tray > m.a.tray) grew.push(`${def.id}: strip ${m.a.st}→${m.z.st}, tray ${m.a.tray}→${m.z.tray}`);
      else if (m.z.st !== m.a.st || m.z.tray !== m.a.tray) shrank.push(def.id);
    }
    expect(grew).toEqual([]);
    expect(cut).toEqual([]);
    // The shrinks are the ones named above, and no others.
    expect(shrank.filter((id) => !/^(A|W|RL)\d/.test(id))).toEqual([]);
    await page.close();
  }, 120_000);
});
