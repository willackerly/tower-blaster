// The opening aim (PT29, docs/game/aim-clarity.md): for every level the player aims at a point, from its opening
// view on a desktop (1280x800) and an upright phone (390x844), with the launcher to the side (the default) and behind
// the eye: an aim exists; it rests on a block the eye sees that is not heritage; its flight reaches the point and first
// touches a structure block that is not heritage (the block aimed at, but in a dense city); the touched point keeps clear of heritage (a blast's zone reaches none, and no heritage touches the struck block ahead of the shot); a tap at its
// screen point picks that block. CPU only, on the bodies at their home poses. Whether it does something once fired
// (collapse above 0, heritage intact) is opening-aim-physics.test.ts, on the f64 reference.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { compileLevel, type CompiledLevel, L3, SERIES } from '@tb/keystone';
import { rayThrough } from '@tb/render/camera';
import { launchAz, launchHeight, pick, shotFor, SUBSTEPS } from '../src/aim.ts';
import { nextSelection } from '../src/hud.ts';
import { aimsAtPoint, BLAST_MARGIN, blastReach, boxDistance, HERITAGE_CLEAR, heritageAhead, openingAim } from '../src/opening-aim.ts';
import { openingInsets, viewOf } from '../src/view.ts';
import { panelTimeline } from '../src/fuse-timeline.ts';

function atHome(c: CompiledLevel): Snapshot {
  const s = emptySnapshot(c.meta.n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot.set(c.scene.bodies[i]!.rot, 4 * i);
  return s;
}

/** The viewports PT29's verify names: a desktop and an upright phone. */
export const VIEWPORTS = [['desktop', 1280 / 800], ['phone', 390 / 844]] as const;

/** The opening view play.ts frames for a level at `aspect` (no measured HUD: the upright guess). */
export const openingView = (c: CompiledLevel, aspect: number) => viewOf(c, aspect, undefined, undefined, undefined, { insets: openingInsets(aspect, panelTimeline(c) !== null) });

/** The levels whose first item is aimed at a point. */
const AIMED = SERIES.flat().filter((d) => { const item = nextSelection(d.rack, d.rack, null); return item !== null && aimsAtPoint(item) && !d.build; });

describe('the opening aim', () => {
  it('covers the chamber and big levels and the trials', () => {
    const ids = AIMED.map((d) => d.id);
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'B1', 'B2', 'B3']) expect(ids).toContain(id);
  });

  for (const def of AIMED) for (const side of ['side', 'behind'] as const) {
    it(`${def.id}, launcher ${side}: on a block the eye sees, not heritage, reached, landing on the structure, clear of heritage, at both viewports`, () => {
      const c = compileLevel(def), s = atHome(c), item = nextSelection(def.rack, def.rack, null)!, at = launchHeight(c, 'high');
      const heritage = new Set(c.meta.heritage), reach = blastReach(c, item), unit = c.frame.unit;
      for (const [shape, aspect] of VIEWPORTS) {
        const view = openingView(c, aspect), az = launchAz(view.yaw, side);
        const aim = openingAim(c, s, { view, aspect, item, power: 100, az, at });
        expect(aim, `${shape}: an aim`).not.toBeNull();
        const { shot, contact, point, ndc } = aim!;
        expect(heritage.has(contact.body), shape).toBe(false);
        expect(contact.body, shape).toBeGreaterThanOrEqual(0);
        // A tap at its screen point picks the point it rests on, a block that is not heritage, and aims the same shot.
        const hit = pick(rayThrough(view, aspect, ndc[0], ndc[1]), s, c)!;
        expect(hit.body, shape).toBeGreaterThanOrEqual(0);
        expect(heritage.has(hit.body), shape).toBe(false);
        expect(Math.hypot(hit.point[0] - point[0], hit.point[1] - point[1], hit.point[2] - point[2])).toBeLessThan(1e-9);
        const again = shotFor(c, item, az, 100, hit.point, SUBSTEPS, at)!;
        expect(again.shot, shape).toEqual(shot);
        expect(again.reachable, shape).toBe(true);
        expect(Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1, shape).toBe(true);
        // Clear of heritage, by HERITAGE_CLEAR, and a blast's zone by its radius and BLAST_MARGIN.
        const clear = Math.min(Infinity, ...Array.from(c.meta.heritage, (i) => boxDistance(c, s, i, contact.point)));
        expect(clear, shape).toBeGreaterThanOrEqual(HERITAGE_CLEAR * unit);
        expect(heritageAhead(c, s, contact.body, shot), shape).toBe(false);
        if (reach > 0) expect(clear, shape).toBeGreaterThanOrEqual(reach + BLAST_MARGIN * unit);
      }
    });
  }

  it('L3 (spare the middle column): from behind the eye it rests on a crown; from the side, never on a block with heritage touching it ahead', () => {
    const c = compileLevel(L3), s = atHome(c), item = nextSelection(L3.rack, L3.rack, null)!, at = launchHeight(c, 'high');
    for (const [, aspect] of VIEWPORTS) {
      const view = openingView(c, aspect);
      const behind = openingAim(c, s, { view, aspect, item, power: 100, az: launchAz(view.yaw, 'behind'), at })!;
      expect([...c.meta.crowns]).toContain(behind.contact.body);
      expect(heritageAhead(c, s, behind.contact.body, behind.shot)).toBe(false);
      const side = openingAim(c, s, { view, aspect, item, power: 100, az: launchAz(view.yaw, 'side'), at });
      if (side) expect(heritageAhead(c, s, side.contact.body, side.shot)).toBe(false);
      // From the side, a crown between two heritage blocks has one of them ahead of the shot.
      const crownShot = shotFor(c, item, launchAz(view.yaw, 'side'), 100, [s.pos[3 * c.meta.crowns[0]!]!, s.pos[3 * c.meta.crowns[0]! + 1]!, s.pos[3 * c.meta.crowns[0]! + 2]!], SUBSTEPS, at)!;
      expect(heritageAhead(c, s, c.meta.crowns[0]!, crownShot.shot)).toBe(true);
    }
  });

  it('none for a pull, a cue, a plunger or a quake', () => {
    const c = compileLevel(L3), s = atHome(c), view = openingView(c, 1.6);
    for (const item of ['pull', 'cue', 'plunger', 'quake'] as const) expect(openingAim(c, s, { view, aspect: 1.6, item, power: 100, az: 0, at: 8 })).toBeNull();
  });
});
