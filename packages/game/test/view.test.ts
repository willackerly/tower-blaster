// The opening view (view.ts, PT1 and part of PT14): fitBox is an exact fit inside the free area for any direction
// and insets, and the search opens every level with crowns or heritage on a view that shows them (the CPU ID
// raster's measure; sightlines-gpu.test.ts checks the same on the renderer's own ID pass under the real HUD).
import { describe, expect, it } from 'vitest';
import { B2, compileLevel, FUSE_LEVELS, L1, L5, LEVELS, levelById, SERIES } from '@tb/keystone';
import { panelTimeline } from '../src/fuse-timeline.ts';
import { DEFAULT_FRAMING, viewProj } from '@tb/render/camera';
import { transform } from '@tb/render/math';
import {
  baseYaw, clearOfHud, CONFIRM_PX, CROWNS_SEEN, defaultInsets, fitBox, fitShares, framedBox, FUSE_PANEL_PX, FUSE_PANEL_SHARE, HERITAGE_SEEN, hudRects, type Insets, joinInsets, NO_INSETS, openingDirection, openingInsets, PORTRAIT_HUD_SHARE,
  scoreView, searchViews, showsObjectives, structureBox, TOP_MARGIN, viewOf, WIDE_HUD,
} from '../src/view.ts';

const PHONE = 390 / 844, WIDE = 1.6;

/** The NDC extremes of the box's corners under orbit o: [xmin, xmax, ymin, ymax]. */
function extent(o: ReturnType<typeof fitBox>, aspect: number, min: number[], max: number[]): number[] {
  const m = viewProj(o, aspect), e = [Infinity, -Infinity, Infinity, -Infinity];
  for (const x of [min[0]!, max[0]!]) for (const y of [min[1]!, max[1]!]) for (const z of [min[2]!, max[2]!]) {
    const [px, py, , pw] = transform(m, [x, y, z]);
    expect(pw).toBeGreaterThan(0);
    e[0] = Math.min(e[0]!, px / pw); e[1] = Math.max(e[1]!, px / pw); e[2] = Math.min(e[2]!, py / pw); e[3] = Math.max(e[3]!, py / pw);
  }
  return e;
}

describe('fitBox', () => {
  const c = compileLevel(LEVELS[1]!), { min, max } = structureBox(c);
  const cases: [string, number, Insets][] = [
    ['wide, no insets', WIDE, NO_INSETS], ['wide, top margin', WIDE, defaultInsets(WIDE)], ['upright phone', PHONE, defaultInsets(PHONE)],
    ['sideways phone with a left rail', 844 / 390, { ...NO_INSETS, left: 0.25 }], ['upright with a top strip and a bottom tray', PHONE, { top: 0.2, bottom: 0.25, left: 0, right: 0 }],
  ];
  for (const [name, aspect, ins] of cases) for (const dir of [{ yaw: 36, pitch: 12 }, { yaw: -100, pitch: 40 }, { yaw: 180, pitch: 55 }]) {
    it(`${name}, yaw ${dir.yaw} pitch ${dir.pitch}: every corner inside the free area, touching it on one axis (the least distance)`, () => {
      const o = fitBox(min, max, dir, aspect, ins), [x0, x1, y0, y1] = extent(o, aspect, min, max);
      // The free area in NDC (wide screens count a square's width: within it, and so within the screen less its insets).
      const sq = aspect >= 1 ? 1 / aspect : 1, L = (-1 + 2 * ins.left) * sq, R = (1 - 2 * ins.right) * sq, B = -1 + 2 * ins.bottom, T = 1 - 2 * ins.top;
      const eps = 1e-9;
      expect(x0!).toBeGreaterThanOrEqual(L - eps); expect(x1!).toBeLessThanOrEqual(R + eps);
      expect(y0!).toBeGreaterThanOrEqual(B - eps); expect(y1!).toBeLessThanOrEqual(T + eps);
      // FIT = 1.05: the box fills 1 / 1.05 of the free area across one axis, centred on it.
      const fill = Math.max((x1! - x0!) / (R - L), (y1! - y0!) / (T - B));
      if (o.distance > 8 + 1e-9) expect(fill).toBeCloseTo(1 / DEFAULT_FRAMING.fit, 6);
      expect({ yaw: o.yaw, pitch: o.pitch }).toEqual({ yaw: (dir.yaw * Math.PI) / 180, pitch: (dir.pitch * Math.PI) / 180 });
    });
  }
  it('refuses insets that leave no room', () => {
    expect(() => fitBox(min, max, { yaw: 0, pitch: 12 }, WIDE, { top: 0.5, bottom: 0.5, left: 0, right: 0 })).toThrow(/no room/);
  });
});

describe('the opening view shows the objectives (PT1)', () => {
  const levels = SERIES.flat().filter((d) => { const c = compileLevel(d); return c.meta.crowns.length + c.meta.heritage.length > 0; });
  it.each(levels.map((d) => [d.id, d] as const))('%s: at the wide and upright shapes', (_, def) => {
    const c = compileLevel(def);
    for (const a of [WIDE, PHONE]) {
      // The insets the game frames with: the defaults, and upright the fuse panel's band on a level with charges.
      const ins = joinInsets(defaultInsets(a), openingInsets(a, panelTimeline(c) !== null));
      const dir = openingDirection(c, a, ins), s = scoreView(c, dir, a, ins);
      expect(showsObjectives(s), `${def.id} at ${a.toFixed(2)}: ${JSON.stringify(s)}`).toBe(true);
      expect(s.crownsSeen).toBeGreaterThanOrEqual(Math.ceil(CROWNS_SEEN * s.crowns - 1e-9));
      if (s.heritage) expect(s.heritageSeen).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(HERITAGE_SEEN * s.heritage - 1e-9)));
    }
  });

  it('B2 (first visit -15,361 with the cathedral and crowns hidden): the old view shows none of either; the new one looks over the town', () => {
    const c = compileLevel(B2), old = scoreView(c, { yaw: baseYaw(c), pitch: 12 }, WIDE, defaultInsets(WIDE));
    expect(old.crownsSeen + old.heritageSeen).toBe(0);
    const dir = openingDirection(c, WIDE);
    expect(dir.pitch).toBeGreaterThan(12);
    expect(showsObjectives(scoreView(c, dir, WIDE, defaultInsets(WIDE)))).toBe(true);
  });

  it('L5 (the domino row seen end-on showed one domino): opens at least 30 degrees off the row, the row\'s outline mostly in sight', () => {
    const c = compileLevel(L5), dir = openingDirection(c, WIDE);
    expect(Math.abs(dir.yaw - baseYaw(c))).toBeGreaterThanOrEqual(30);
    expect(dir.pitch).toBe(12);
    const end = scoreView(c, { yaw: baseYaw(c), pitch: 12 }, WIDE, defaultInsets(WIDE)), now = scoreView(c, dir, WIDE, defaultInsets(WIDE));
    expect(end.exposure).toBeLessThan(0.4);
    expect(now.exposure).toBeGreaterThan(0.8);
  });

  it('a level that already shows its objectives keeps the base view (L3); a level without objectives is never searched (B1)', async () => {
    const { L3, B1 } = await import('@tb/keystone');
    const l3 = compileLevel(L3);
    expect(openingDirection(l3, WIDE)).toEqual({ yaw: baseYaw(l3), pitch: 12 });
    const b1 = compileLevel(B1);
    expect(openingDirection(b1, WIDE)).toEqual({ yaw: baseYaw(b1), pitch: 12 });
  });

  it('the search tries pitches lowest first and yaws nearest first, and is deterministic', () => {
    const c = compileLevel(B2), a = searchViews(c, WIDE), b = searchViews(c, WIDE);
    expect(a.pick).toEqual(b.pick);
    const order = a.scored.map((s) => s.dir.pitch);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(a.scored[0]!.dir).toEqual({ yaw: baseYaw(c), pitch: 12 });
  });
});

describe('openingInsets', () => {
  it('adds the fuse panel\'s band upright and its column wide (as fitBox counts the square) on a level with charges (F1), nothing without (L1)', () => {
    expect(openingInsets(PHONE, true)).toEqual({ bottom: FUSE_PANEL_SHARE });
    // 320 of 1280 px is a quarter of the screen; of the middle square (x 240 to 1040 px) it covers 960 to 1040, 0.1.
    expect(openingInsets(WIDE, true, 1280)!.right).toBeCloseTo(fitShares({ ...NO_INSETS, right: FUSE_PANEL_PX / 1280 }, WIDE).right, 12);
    expect(openingInsets(WIDE, true, 1280)!.right).toBeCloseTo(80 / 800, 9);
    expect(openingInsets(WIDE, true, 3000)!.right).toBe(0); // a wide window: the panel is outside the square
    expect(openingInsets(WIDE, false)).toBeUndefined();
    expect(openingInsets(PHONE, false)).toBeUndefined();
    expect(panelTimeline(compileLevel(levelById('F1')))).not.toBeNull();
    expect(panelTimeline(compileLevel(L1))).toBeNull();
  });
});

describe('viewOf', () => {
  it('classic (keystone.view=classic) opens on the base yaw at 12 degrees whatever the level shows', () => {
    const c = compileLevel(B2), o = viewOf(c, WIDE, undefined, undefined, undefined, { mode: 'classic' });
    expect(o.yaw).toBeCloseTo((baseYaw(c) * Math.PI) / 180, 12);
    expect(o.pitch).toBeCloseTo((12 * Math.PI) / 180, 12);
    expect(viewOf(c, WIDE)).not.toEqual(o);
  });

  it('remembers its search: the second open of B2 costs a fraction of the first', () => {
    const c = compileLevel(B2), shape = 0.55; // an upright shape no other test searched (wide ones all search as 16:10)
    let t = performance.now();
    const first = viewOf(c, shape);
    const cold = performance.now() - t;
    t = performance.now();
    const again = viewOf(compileLevel(B2), shape);
    expect(again).toEqual(first);
    expect(performance.now() - t).toBeLessThan(cold);
  });

  it('extra insets (a measured HUD band) join the defaults side by side', () => {
    const c = compileLevel(LEVELS[0]!), { min, max } = structureBox(c);
    const o = viewOf(c, PHONE, undefined, undefined, undefined, { insets: { top: 0.1, bottom: 0.3 } }), [, , y0, y1] = extent(o, PHONE, min, max);
    expect(y1!).toBeLessThanOrEqual(1 - 2 * PORTRAIT_HUD_SHARE + 1e-9);
    expect(y0!).toBeGreaterThanOrEqual(-1 + 2 * 0.3 - 1e-9);
    const w = viewOf(c, WIDE), [, , , top] = extent(w, WIDE, min, max);
    expect(top!).toBeLessThanOrEqual(1 - 2 * TOP_MARGIN + 1e-9);
  });
});

describe('docked on a phone, the opening view keeps clear of the HUD as measured (PT3b, docs/game/phone-hud.md)', () => {
  // The docked HUD's bands as play.ts dockedHud measures them (layout.ts hudInsets of the phone-hud-e2e boxes):
  // upright the strip to 100 of 844 px and the tray with its hint from 639; sideways the rail to 228 of 844.
  const UP_HUD: Insets = { top: 100 / 844, bottom: (844 - 639) / 844, left: 0, right: 0 };
  const SIDE = 844 / 390, SIDE_HUD: Insets = { ...NO_INSETS, left: 228 / 844 };
  const levels = SERIES.flat().filter((d) => compileLevel(d).meta.n > 0);
  const LEVELS_WITH_GOALS = SERIES.flat().filter((d) => { const c = compileLevel(d); return c.meta.crowns.length + c.meta.heritage.length > 0 && c.meta.n < 1000; });

  it('fitShares: upright as measured; wide, a rail\'s share of the screen becomes the part of fitBox\'s middle square it covers', () => {
    expect(fitShares(UP_HUD, PHONE)).toEqual(UP_HUD);
    const side = (l: number, a: number) => fitShares({ ...NO_INSETS, left: l, right: l }, a);
    expect(side(0.3, 1.6).left).toBeCloseTo((1 - 1.6 * 0.4) / 2, 12); // the rail reaches into the square: 0.18 of it
    expect(side(0.3, 1.6).right).toBeCloseTo(0.18, 12);
    expect(side(0.25, SIDE).left).toBe(0); // the rail ends before the square starts
    expect(side(0.5, 1)).toEqual({ top: 0, bottom: 0, left: 0.5, right: 0.5 }); // a square screen: the same
    expect(fitShares({ top: 0.2, bottom: 0.3, left: 0, right: 0 }, SIDE)).toEqual({ top: 0.2, bottom: 0.3, left: 0, right: 0 });
  });

  it('defaultInsets with the HUD: its band in place of the upright guess, never under the top margin; the search masks nothing', () => {
    expect(defaultInsets(PHONE)).toEqual({ ...NO_INSETS, top: PORTRAIT_HUD_SHARE });
    expect(defaultInsets(PHONE, UP_HUD)).toEqual(UP_HUD);
    expect(defaultInsets(PHONE, { ...UP_HUD, top: 0.05 }).top).toBe(TOP_MARGIN);
    expect(defaultInsets(SIDE, SIDE_HUD)).toEqual({ ...NO_INSETS, top: TOP_MARGIN, left: fitShares(SIDE_HUD, SIDE).left });
    expect(hudRects(PHONE, UP_HUD, 'docked')).toEqual([]);
    expect(hudRects(WIDE, defaultInsets(WIDE), 'docked')).toEqual([]);
    expect(hudRects(WIDE, defaultInsets(WIDE))).toHaveLength(1); // the floating panel, as before
  });

  it.each(levels.map((d) => [d.id, d] as const))('%s: every corner of the structure on screen clear of the strip, the tray and the rail; the objectives in sight', (_, def) => {
    const c = compileLevel(def), { min, max } = structureBox(c);
    for (const [a, hud] of [[PHONE, UP_HUD], [SIDE, SIDE_HUD]] as const) {
      const extra = openingInsets(a, panelTimeline(c) !== null);
      const o = viewOf(c, a, undefined, undefined, undefined, { insets: extra, hud });
      // On the real screen (screen shares, clearOfHud's NDC): inside the screen less the HUD and the level's panels.
      expect(clearOfHud(o, a, min, max, joinInsets(hud, extra)), `${def.id} at ${a.toFixed(2)}`).toBe(true);
      if (c.meta.crowns.length + c.meta.heritage.length === 0) continue;
      const ins = joinInsets(defaultInsets(a, hud), extra), s = scoreView(c, openingDirection(c, a, ins, 'docked'), a, ins, 'docked');
      expect(showsObjectives(s), `${def.id} at ${a.toFixed(2)}: ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it('a pick is confirmed at CONFIRM_PX: T-X3B docked upright (yaw 66 passed at 74 x 160 with a crown the page\'s frame hid) opens on a view whose crowns show at the fine raster too', () => {
    const c = compileLevel(levelById('T-X3B')), hud: Insets = { top: 0.0861, bottom: 0.2431, left: 0, right: 0 }, ins = defaultInsets(PHONE, hud);
    const coarse66 = scoreView(c, { yaw: 66, pitch: 12 }, PHONE, ins, 'docked'), fine66 = scoreView(c, { yaw: 66, pitch: 12 }, PHONE, ins, 'docked', CONFIRM_PX);
    expect(showsObjectives(coarse66)).toBe(true);
    expect(showsObjectives(fine66)).toBe(false);
    const dir = openingDirection(c, PHONE, ins, 'docked');
    expect(dir).not.toEqual({ yaw: 66, pitch: 12 });
    expect(showsObjectives(scoreView(c, dir, PHONE, ins, 'docked', CONFIRM_PX))).toBe(true);
  });

  it.each(LEVELS_WITH_GOALS.map((d) => [d.id, d] as const))('%s: a search that finds a passing view returns one that passes at CONFIRM_PX (wide, upright, docked upright)', (_, def) => {
    const c = compileLevel(def);
    for (const [a, ins, hud] of [[WIDE, defaultInsets(WIDE), 'panel'], [PHONE, defaultInsets(PHONE), 'panel'], [PHONE, defaultInsets(PHONE, UP_HUD), 'docked']] as const) {
      const { pick, scored } = searchViews(c, a, ins, hud);
      if (!scored.some((s) => showsObjectives(s))) continue; // no view passes even coarse: the fallback, judged as before
      const fine = scoreView(c, pick, a, ins, hud, CONFIRM_PX);
      if (showsObjectives(scoreView(c, pick, a, ins, hud))) expect(showsObjectives(fine), `${def.id} at ${a.toFixed(2)} ${hud}: ${JSON.stringify(fine)}`).toBe(true);
    }
  });

  it('L1 upright: its base clears the tray (it opened 2% under it on the guess) and the structure takes more of the screen', () => {
    const c = compileLevel(L1), { min, max } = structureBox(c);
    const guess = viewOf(c, PHONE, undefined, undefined, undefined, { mode: 'classic' });
    const docked = viewOf(c, PHONE, undefined, undefined, undefined, { mode: 'classic', hud: UP_HUD });
    expect(clearOfHud(guess, PHONE, min, max, UP_HUD)).toBe(false);
    expect(clearOfHud(docked, PHONE, min, max, UP_HUD)).toBe(true);
    const height = (o: typeof guess) => { const e = extent(o, PHONE, min, max); return e[3]! - e[2]!; };
    expect(height(docked)).toBeGreaterThan(height(guess));
  });
});

/** The screen box (shares of the width and height from the top left, as ScreenRect) of a box's corners under orbit o. */
function screenBox(o: ReturnType<typeof viewOf>, aspect: number, min: number[], max: number[]) {
  const [x0, x1, y0, y1] = extent(o, aspect, min, max);
  return { left: (x0! + 1) / 2, right: (x1! + 1) / 2, top: (1 - y1!) / 2, bottom: (1 - y0!) / 2 };
}
const overlaps = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('a fold level\'s opening view frames its yard clear of the panels (PT24)', () => {
  it('framedBox: the structure and the lot (and the compass), only on a fold level', () => {
    expect(framedBox(compileLevel(L1))).toEqual(structureBox(compileLevel(L1)));
    for (const def of FUSE_LEVELS) {
      const c = compileLevel(def), f = framedBox(c), s = structureBox(c);
      expect(f.min[0]).toBeLessThanOrEqual(Math.min(s.min[0], c.lot.min[0]));
      expect(f.min[2]).toBeLessThanOrEqual(Math.min(s.min[2], c.lot.min[1]));
      expect(f.max[0]).toBeGreaterThanOrEqual(Math.max(s.max[0], c.lot.max[0]));
      expect(f.max[2]).toBeGreaterThanOrEqual(Math.max(s.max[2], c.lot.max[1]));
      expect([f.min[1], f.max[1]]).toEqual([0, c.height]);
    }
    // F1's yard reaches 12.75 m west, past its structure's box (2 m): the case that opened with the yard off screen.
    const f1 = compileLevel(FUSE_LEVELS[0]!);
    expect(f1.lot.min[0]).toBeLessThan(structureBox(f1).min[0] - 10);
  });

  // 1280 x 800 with the Timeline down the right (300 px, 12 from the edge) and the HUD at the top left; an upright
  // phone with a docked strip, tray and the panel on the tray (as fuse-layout-e2e.test.ts measures them, about).
  const DESK_PANEL = { left: 1 - FUSE_PANEL_PX / 1280, top: 0, right: 1, bottom: 1 };
  const UP_BAND: Insets = { top: 110 / 844, bottom: (844 - 420) / 844, left: 0, right: 0 };
  it.each(FUSE_LEVELS.map((d) => [d.id, d] as const))('%s: the lot inside the screen and off the Timeline and HUD at 1280 x 800, and inside the free band upright', (_, def) => {
    const c = compileLevel(def), lotMin = [c.lot.min[0], 0, c.lot.min[1]], lotMax = [c.lot.max[0], 0, c.lot.max[1]];
    const wide = viewOf(c, WIDE, undefined, undefined, undefined, { insets: openingInsets(WIDE, true, 1280) });
    const box = screenBox(wide, WIDE, lotMin, lotMax);
    expect(box.left >= 0 && box.right <= 1 && box.top >= 0 && box.bottom <= 1, `${def.id} wide: ${JSON.stringify(box)}`).toBe(true);
    expect(overlaps(box, DESK_PANEL), `${def.id} wide: the yard under the Timeline ${JSON.stringify(box)}`).toBe(false);
    expect(overlaps(box, WIDE_HUD), `${def.id} wide: the yard under the HUD ${JSON.stringify(box)}`).toBe(false);
    const up = viewOf(c, PHONE, undefined, undefined, undefined, { insets: openingInsets(PHONE, true), hud: UP_BAND });
    expect(clearOfHud(up, PHONE, lotMin as never, lotMax as never, UP_BAND), `${def.id} upright`).toBe(true);
  });
});
