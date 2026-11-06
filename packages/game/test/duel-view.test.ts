// Where to aim from in a duel (duel-view.ts): the turn view frames the table from the middle of the side to fire,
// high enough that the far keep shows over the near one; the turn cue names the shorter drag to the side, and a
// drag that way gets there; the swing eases from the old view to the new one the short way round and lets go on a
// grab; the arc beads dot the side's arc on the ground in its ink. Pure: no GPU.
import { describe, expect, it } from 'vitest';
import { compileLevel, D1, D2, Duel, duelLevel, DUELS, EAST_ARC, inArc, WEST_ARC } from '@tb/keystone';
import { eyeOf, type Orbit, viewProj } from '@tb/render/camera';
import { azFromYaw } from '../src/aim.ts';
import { arcBeads, arcMiddle, DUEL_PITCH, duelView, joinOverlays, smooth, TURN_SWING_S, turnCue, turnCueText, TurnSwing, yawOfAz } from '../src/duel-view.ts';
import { orbitDrag } from '../src/play.ts';
import { clearOfHud, viewOf } from '../src/view.ts';

const DEG = Math.PI / 180;
const tables = DUELS.map((d) => [d.id, d] as const);

describe('duel turn view', () => {
  it('arcMiddle wraps through 0; yawOfAz is azFromYaw\'s inverse at every azimuth', () => {
    expect(arcMiddle(WEST_ARC)).toBe(360);
    expect(arcMiddle(EAST_ARC)).toBe(0);
    expect(arcMiddle([10, 30])).toBe(20);
    expect(arcMiddle([700, 40])).toBe(10);
    for (let az = 0; az < 720; az++) expect(azFromYaw(yawOfAz(az))).toBe(az);
  });

  it.each(tables)('%s: each side\'s view has its eye over the middle of its arc, from DUEL_PITCH, on a wide screen and an upright phone', (_, def) => {
    const c = compileLevel(duelLevel(def));
    for (const side of def.sides) {
      for (const aspect of [1.6, 390 / 844]) {
        const o = duelView(c, side, aspect), e = eyeOf(o);
        const az = (((Math.atan2(e[2] - o.target[2], e[0] - o.target[0]) / DEG) * 2) % 720 + 720) % 720;
        expect(az).toBeCloseTo(arcMiddle(side.arc), 6);
        expect(azFromYaw(o.yaw)).toBe(arcMiddle(side.arc));
        expect(inArc(azFromYaw(o.yaw), side.arc)).toBe(true);
        expect(o.pitch).toBeCloseTo(DUEL_PITCH * DEG, 12);
        // The level's own framing apart from where it looks from: the same target height rule and floor.
        expect(o.floor).toBe(viewOf(c, aspect).floor);
        if (aspect < 1) {
          const min: [number, number, number] = [Infinity, 0, Infinity], max: [number, number, number] = [-Infinity, c.height, -Infinity];
          for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
            min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
            max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
          }
          expect(clearOfHud(o, aspect, min, max)).toBe(true);
        }
      }
    }
  });

  it('D1: from either side the whole other keep shows over your own (why DUEL_PITCH is above the framing\'s 12 deg)', () => {
    const c = compileLevel(duelLevel(D1)), d = new Duel(D1, c);
    /** The keep's box: every block the side owns. */
    const boxOf = (idx: Int32Array) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const i of idx) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]!); hi[k] = Math.max(hi[k]!, c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]!); }
      return [lo, hi] as const;
    };
    const share = (o: Orbit, aspect: number, near: Int32Array, far: Int32Array) => {
      const m = viewProj(o, aspect), y = (p: number[]) => (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!) / (m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!);
      const [nl, nh] = boxOf(near), [fl, fh] = boxOf(far);
      const corners = (lo: readonly number[], hi: readonly number[], h: number) => [lo[0]!, hi[0]!].flatMap((x) => [lo[2]!, hi[2]!].map((z) => y([x, h, z])));
      const nearTop = Math.max(...corners(nl, nh, nh[1]!)), farTop = Math.max(...corners(fl, fh, fh[1]!)), farBottom = Math.min(...corners(fl, fh, fl[1]!));
      return Math.max(0, Math.min(1, (farTop - Math.max(nearTop, farBottom)) / (farTop - farBottom)));
    };
    for (const k of [0, 1] as const) {
      const o = duelView(c, D1.sides[k], 1.6);
      expect(share(o, 1.6, d.owned[k], d.owned[1 - k as 0 | 1])).toBe(1);
      // The level framing's own pitch from the same spot would hide most of it.
      const low = viewOf(c, 1.6, { yaw: o.yaw / DEG, pitch: 12 });
      expect(share(low, 1.6, d.owned[k], d.owned[1 - k as 0 | 1])).toBeLessThan(0.5);
    }
  });
});

describe('duel turn cue', () => {
  it('is null on the arc and names a side otherwise', () => {
    expect(turnCue(WEST_ARC, 360)).toBeNull();
    expect(turnCue(WEST_ARC, 200)).toBeNull();
    expect(turnCue(WEST_ARC, 520)).toBeNull();
    expect(turnCue(WEST_ARC, 199)).toBe('right'); // just short of the arc's start: raise the azimuth
    expect(turnCue(WEST_ARC, 521)).toBe('left');
    expect(turnCue(EAST_ARC, 559)).toBe('right');
    expect(turnCue(EAST_ARC, 161)).toBe('left');
    expect(turnCueText('Gold', 'right', false)).toBe("Drag right ▸ to turn to Gold's side");
    expect(turnCueText('Blue', 'left', true)).toBe("Two fingers left ◂ to turn to Blue's side");
  });

  it.each([['west', WEST_ARC], ['east', EAST_ARC], ['narrow, wrapping', [700, 20] as [number, number]]] as const)('%s arc: from every azimuth off it, dragging the cue\'s way reaches it, and no later than the other way', (_, arc) => {
    /** Pixels of horizontal drag, in 1 px steps as a pointer sends them, until the view's azimuth is on the arc. */
    const pixelsTo = (az0: number, dir: 1 | -1) => {
      const o: Orbit = { target: [0, 0, 0], yaw: yawOfAz(az0), pitch: 0.2, distance: 10, fovY: 0.8 };
      for (let px = 1; px <= 2000; px++) { orbitDrag(o, dir, 0); if (inArc(azFromYaw(o.yaw), arc)) return px; }
      return Infinity;
    };
    let checked = 0;
    for (let az = 0; az < 720; az += 7) {
      const cue = turnCue(arc, az);
      if (cue === null) { expect(inArc(az, arc)).toBe(true); continue; }
      const along = pixelsTo(az, cue === 'right' ? 1 : -1), against = pixelsTo(az, cue === 'right' ? -1 : 1);
      expect(along).toBeLessThan(Infinity);
      expect(along).toBeLessThanOrEqual(against + 1); // ties: either way is as short (1 px of rounding)
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('duel turn swing', () => {
  const at = (yaw: number, distance: number): Orbit => ({ target: [1, 2, 3], yaw, pitch: 0.2, distance, fovY: 0.8, floor: 0.25 });

  it('eases to the goal the short way round over TURN_SWING_S and lands on it exactly', () => {
    const s = new TurnSwing(), o = at(170 * DEG, 10), goal: Orbit = { target: [0, 1.5, 0], yaw: -170 * DEG, pitch: 0.45, distance: 20, fovY: 0.8, floor: 0.25 };
    s.start(o, goal);
    expect(s.active).toBe(true);
    let t = 0, prev = o.yaw;
    while (s.update(o, 1 / 60)) {
      t += 1 / 60;
      // The short way from 170 to -170 deg is up through 180 (20 deg), not down through 0 (340 deg).
      expect(o.yaw).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(o.yaw).toBeLessThanOrEqual(190 * DEG + 1e-12);
      expect(o.distance).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(o.distance).toBeLessThanOrEqual(20 + 1e-9);
      prev = o.yaw;
    }
    expect(t).toBeCloseTo(TURN_SWING_S - 1 / 60, 6);
    expect(s.active).toBe(false);
    expect(o).toEqual(goal);
    expect(o.target).not.toBe(goal.target); // a copy: moving the camera later does not move the goal
    expect([smooth(0), smooth(0.5), smooth(1), smooth(2)]).toEqual([0, 0.5, 1, 1]);
  });

  it('a grab stops it where it is; one dt past the end lands on the goal', () => {
    const s = new TurnSwing(), o = at(0, 10), goal = at(90 * DEG, 10);
    s.start(o, goal);
    s.update(o, TURN_SWING_S / 2);
    expect(o.yaw).toBeCloseTo(45 * DEG, 12);
    s.grab();
    expect(s.active).toBe(false);
    expect(s.update(o, 1)).toBe(false);
    expect(o.yaw).toBeCloseTo(45 * DEG, 12);
    s.start(o, goal);
    expect(s.update(o, 5)).toBe(false);
    expect(o.yaw).toBe(goal.yaw);
  });
});

describe('duel arc beads', () => {
  it.each(tables)('%s: each side\'s arc is dotted on the ground at the launcher ring, end to end, in its ink', (_, def) => {
    const c = compileLevel(duelLevel(def)), f = c.frame, ringR = f.launcher.radius * f.pitch * f.unit;
    for (const side of def.sides) {
      const b = arcBeads(c, side), n = b.colours.length;
      expect(n).toBeGreaterThan(10);
      expect(b.xyzr.length).toBe(4 * n);
      expect(new Set(b.colours).size).toBe(1);
      for (let k = 0; k < n; k++) {
        const x = b.xyzr[4 * k]! - f.centre[0], z = b.xyzr[4 * k + 2]! - f.centre[1], r = b.xyzr[4 * k + 3]!;
        expect(Math.hypot(x, z)).toBeCloseTo(ringR, 4);
        expect(b.xyzr[4 * k + 1]).toBeCloseTo(r, 6); // resting on the ground
        const az = Math.round((((Math.atan2(z, x) / DEG) * 2) % 720 + 720) % 720) % 720;
        expect(inArc(az, side.arc)).toBe(true);
      }
      // The ends sit on the arc's ends.
      const azOf = (k: number) => Math.round((((Math.atan2(b.xyzr[4 * k + 2]! - f.centre[1], b.xyzr[4 * k]! - f.centre[0]) / DEG) * 2) % 720 + 720) % 720) % 720;
      expect([azOf(0), azOf(n - 1)]).toEqual(side.arc);
    }
    // Gold and Blue in their own inks.
    expect(arcBeads(c, def.sides[0]).colours[0]).not.toBe(arcBeads(c, def.sides[1]).colours[0]);
  });

  it('joinOverlays: the first list first, one alone is itself, none is null', () => {
    const c = compileLevel(duelLevel(D2)), a = arcBeads(c, D2.sides[0]), b = arcBeads(c, D2.sides[1]);
    expect(joinOverlays(null, a)).toBe(a);
    expect(joinOverlays(null, null)).toBeNull();
    const j = joinOverlays(a, b)!;
    expect(j.colours.length).toBe(a.colours.length + b.colours.length);
    expect(Array.from(j.xyzr.subarray(0, a.xyzr.length))).toEqual(Array.from(a.xyzr));
    expect(j.colours[a.colours.length]).toBe(b.colours[0]);
  });
});
