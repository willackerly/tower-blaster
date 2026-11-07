// The opening view (view.ts, PT1 and part of PT14): fitBox is an exact fit inside the free area for any direction
// and insets, and the search opens every level with crowns or heritage on a view that shows them (the CPU ID
// raster's measure; sightlines-gpu.test.ts checks the same on the renderer's own ID pass under the real HUD).
import { describe, expect, it } from 'vitest';
import { B2, compileLevel, L1, L5, LEVELS, levelById, SERIES } from '@tb/keystone';
import { panelTimeline } from '../src/fuse-timeline.ts';
import { DEFAULT_FRAMING, viewProj } from '@tb/render/camera';
import { transform } from '@tb/render/math';
import {
  baseYaw, CROWNS_SEEN, defaultInsets, fitBox, FUSE_PANEL_SHARE, HERITAGE_SEEN, type Insets, joinInsets, NO_INSETS, openingDirection, openingInsets, PORTRAIT_HUD_SHARE,
  scoreView, searchViews, showsObjectives, structureBox, TOP_MARGIN, viewOf,
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
  it('adds the fuse panel\'s band upright on a level with charges (F1), nothing wide or without charges (L1)', () => {
    expect(openingInsets(PHONE, true)).toEqual({ bottom: FUSE_PANEL_SHARE });
    expect(openingInsets(WIDE, true)).toBeUndefined();
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
