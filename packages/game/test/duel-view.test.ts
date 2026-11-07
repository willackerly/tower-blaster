// Where to aim from in a duel (duel-view.ts): the turn view looks over the shoulder of the side to fire at the
// rival, so a click at the middle lands on it and the shot flies clear of your own keep (PT5); your king wears the
// shield and the rival's the crosshair; the turn cue names the shorter drag to the side, and a
// drag that way gets there; the swing eases from the old view to the new one the short way round and lets go on a
// grab; the arc beads dot the side's arc on the ground in its ink. Pure: no GPU.
import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@tb/engine-api';
import { compileLevel, D1, D2, Duel, duelLevel, DUELS, EAST_ARC, inArc, WEST_ARC } from '@tb/keystone';
import { MARK_HIT, MARK_SAVE } from '@tb/render';
import { type Orbit, rayThrough, viewProj } from '@tb/render/camera';
import { azFromYaw, launchHeight, pick, previewBeads, shotFor, SUBSTEPS } from '../src/aim.ts';
import { NOVICE_SPREAD, playCentre, seeded } from '../src/duel-bot.ts';
import { arcBeads, arcMiddle, DUEL_PITCH, DUEL_YAW_OFFSET, duelEndView, duelFocus, duelMarks, duelView, joinOverlays, launcherAz, ownInView, smooth, TURN_SWING_S, turnCue, turnCueText, TurnSwing, yawOfAz } from '../src/duel-view.ts';
import { orbitDrag } from '../src/play.ts';
import { structureMarks } from '../src/scene.ts';
import { PLAY_CENTRE_PORTRAIT, viewOf } from '../src/view.ts';

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

  /** The table at rest: every structure body home. */
  const atHome = (c: ReturnType<typeof compileLevel>) => {
    const s = emptySnapshot(c.meta.n);
    s.pos.set(c.meta.home);
    for (let i = 0; i < c.meta.n; i++) s.rot[4 * i + 3] = 1;
    return s;
  };
  const project = (o: Orbit, aspect: number, p: readonly number[]) => {
    const m = viewProj(o, aspect), w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
    return [(m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!) / w, (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!) / w] as const;
  };
  const ASPECTS = [['wide', 1.6], ['phone upright', 390 / 844], ['phone sideways', 844 / 390]] as const;

  it.each(tables)('%s: each side looks over its shoulder from DUEL_YAW_OFFSET off its arc\'s middle, from DUEL_PITCH, the rival in the middle of what shows', (_, def) => {
    const c = compileLevel(duelLevel(def));
    for (const p of [0, 1] as const) {
      const side = def.sides[p];
      for (const [, aspect] of ASPECTS) {
        const o = duelView(c, def, p, aspect), az = azFromYaw(o.yaw), off = Math.abs(((az - arcMiddle(side.arc) + 1080) % 720) - 360) / 2;
        expect(off).toBeCloseTo(DUEL_YAW_OFFSET, 6);
        expect(inArc(az, side.arc)).toBe(true);
        expect(o.pitch).toBeCloseTo(DUEL_PITCH * DEG, 12);
        expect(o.floor).toBe(viewOf(c, aspect).floor);
        // The rival's middle shows where a click aims: the middle of the screen, or of what an upright phone shows below its HUD.
        const [x, y] = project(o, aspect, duelFocus(c, def, p));
        expect(x).toBeCloseTo(0, 3);
        expect(y).toBeCloseTo(aspect < 1 ? PLAY_CENTRE_PORTRAIT[1] : 0, 3);
      }
    }
  });

  // PT5's verify: the novice's middle click hit its own king; now it lands on the rival's half (D1) or the tower (D2), from either side, on any screen.
  it.each(tables)('%s: a click at the middle lands on the rival, and 400 novice clicks about it never on your own blocks', (_, def) => {
    const c = compileLevel(duelLevel(def)), s = atHome(c), d = new Duel(def, c);
    for (const p of [0, 1] as const) {
      const own = new Set(d.owned[p]), rival = new Set(d.owned[1 - p as 0 | 1]), sign = def.sides[p].arc === WEST_ARC ? 1 : -1;
      for (const [name, aspect] of ASPECTS) {
        const o = duelView(c, def, p, aspect), [cx, cy] = playCentre(aspect);
        const mid = pick(rayThrough(o, aspect, cx, cy), s, c)!;
        // (Heraldry's tower is both sides': its middle is either colour.)
        expect(def.ruleset === 'keeps' ? rival.has(mid.body) : mid.body >= 0, `${def.id} ${def.sides[p].name} ${name}: middle click on body ${mid.body}`).toBe(true);
        const rnd = seeded(41 + p), hits = { own: 0, rival: 0, near: 0 };
        for (let k = 0; k < 400; k++) {
          const h = pick(rayThrough(o, aspect, cx + (rnd() * 2 - 1) * NOVICE_SPREAD, cy + (rnd() * 2 - 1) * NOVICE_SPREAD), s, c);
          if (!h) continue;
          if (own.has(h.body)) hits.own++;
          if (rival.has(h.body)) hits.rival++;
          if (sign * h.point[0] < 0) hits.near++;
        }
        if (def.ruleset === 'keeps') {
          // Two Keeps: not one click on your own keep, every one on the rival's half of the table, and a good share on the keep itself.
          expect(hits, `${def.id} ${def.sides[p].name} ${name}`).toMatchObject({ own: 0, near: 0 });
          expect(hits.rival).toBeGreaterThan(100);
        } else {
          // Heraldry's tower is shared: what matters is that clicks land on it, on both colours.
          expect(hits.rival).toBeGreaterThan(100);
        }
      }
    }
  });

  it('D1: the middle click\'s shot flies clear of your own keep, and your keep hides none of the rival\'s', () => {
    const c = compileLevel(duelLevel(D1)), s = atHome(c), d = new Duel(D1, c), r = 0.5 * c.frame.unit;
    const boxOf = (idx: Int32Array) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const i of idx) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]!); hi[k] = Math.max(hi[k]!, c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]!); }
      return [lo, hi] as const;
    };
    for (const p of [0, 1] as const) for (const [, aspect] of ASPECTS) {
      const o = duelView(c, D1, p, aspect), [cx, cy] = playCentre(aspect), [lo, hi] = boxOf(d.owned[p]);
      const hit = pick(rayThrough(o, aspect, cx, cy), s, c)!;
      const a = shotFor(c, 'cannonball', azFromYaw(o.yaw), 100, hit.point, SUBSTEPS, launchHeight(c, 'high'))!;
      expect(a.reachable).toBe(true);
      const beads = previewBeads(c, a.shot, hit.point, SUBSTEPS, 1000, 1);
      for (let k = 0; k < beads.length; k += 3) {
        const inside = [0, 1, 2].every((j) => beads[k + j]! > lo[j]! - r && beads[k + j]! < hi[j]! + r);
        expect(inside, `${D1.sides[p].name}: the shot passes through its own keep`).toBe(false);
      }
      // A grid of clicks over the rival keep's outline on screen: each one that meets a block meets the rival's.
      const [rl, rh] = boxOf(d.owned[1 - p as 0 | 1]), corners = [rl[0]!, rh[0]!].flatMap((x) => [rl[1]!, rh[1]!].flatMap((y) => [rl[2]!, rh[2]!].map((z) => project(o, aspect, [x, y, z]))));
      const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]), own = new Set(d.owned[p]);
      for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
        const h = pick(rayThrough(o, aspect, Math.min(...xs) + ((Math.max(...xs) - Math.min(...xs)) * i) / 8, Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * j) / 8), s, c);
        expect(h && own.has(h.body)).toBeFalsy();
      }
    }
  });

  it('carves the shield on the king of the player to fire and the crosshair on the rival\'s, swapping with the turn; nothing with marks off', () => {
    const c = compileLevel(duelLevel(D1)), d = new Duel(D1, c);
    const [gold, blue] = d.kings.map((k) => k![0]!);
    expect(duelMarks(c, d)[gold!]).toBe(MARK_SAVE);
    expect(duelMarks(c, d)[blue!]).toBe(MARK_HIT);
    expect(duelMarks(c, { ...d, turn: 1, kings: d.kings })[gold!]).toBe(MARK_HIT);
    expect(duelMarks(c, { ...d, turn: 1, kings: d.kings })[blue!]).toBe(MARK_SAVE);
    expect([...duelMarks(c, d, false)].every((m) => m === 0)).toBe(true);
    // Heraldry has no kings: the level's own marks.
    const c2 = compileLevel(duelLevel(D2));
    expect(duelMarks(c2, new Duel(D2, c2))).toEqual(structureMarks(c2));
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

  // PT34 (agent playtest 2): what the turn view shows.
  describe('PT34', () => {
    const DESKTOPS = [['16:10', 1.6], ['16:9', 1280 / 720]] as const;
    const atRest = (c: ReturnType<typeof compileLevel>) => { const s = emptySnapshot(c.meta.n); s.pos.set(c.meta.home); for (let i = 0; i < c.meta.n; i++) s.rot[4 * i + 3] = 1; return s; };
    /** The share of the screen's width the aim preview of a click at the middle crosses (beads in view only). */
    const arcSpan = (def: typeof D1, p: 0 | 1, aspect: number, lead: boolean) => {
      const c = compileLevel(duelLevel(def)), o = duelView(c, def, p, aspect), [cx, cy] = playCentre(aspect);
      const hit = pick(rayThrough(o, aspect, cx, cy), atRest(c), c)!;
      const a = shotFor(c, def.sides[p].rack[0]!, launcherAz(o.yaw, def, lead), 100, hit.point, SUBSTEPS, launchHeight(c, 'high'))!;
      expect(a.reachable).toBe(true);
      const b = previewBeads(c, a.shot, hit.point), m = viewProj(o, aspect), xs: number[] = [];
      for (let k = 0; k < b.length; k += 3) {
        const w = m[3]! * b[k]! + m[7]! * b[k + 1]! + m[11]! * b[k + 2]! + m[15]!, x = (m[0]! * b[k]! + m[4]! * b[k + 1]! + m[8]! * b[k + 2]! + m[12]!) / w, y = (m[1]! * b[k]! + m[5]! * b[k + 1]! + m[9]! * b[k + 2]! + m[13]!) / w;
        if (w > 0 && Math.abs(x) <= 1 && Math.abs(y) <= 1) xs.push(x);
      }
      return (Math.max(...xs) - Math.min(...xs)) / 2;
    };

    it.each(tables)("%s: on a desktop each side's own blocks are in view, clear of the hint line", (_, def) => {
      const c = compileLevel(duelLevel(def)), d = new Duel(def, c);
      for (const p of [0, 1] as const) for (const [name, aspect] of DESKTOPS) expect(ownInView(duelView(c, def, p, aspect), aspect, c, d.owned[p]), `${def.sides[p].name} ${name}`).toBe(true);
    });

    it("D2: the launcher stands its lead round from the view, inside the side's arc, and the preview arc crosses at least a quarter of the screen", () => {
      for (const p of [0, 1] as const) {
        const c = compileLevel(duelLevel(D2)), o = duelView(c, D2, p, 1.6), az = launcherAz(o.yaw, D2);
        expect((((azFromYaw(o.yaw) - az) % 720) + 720) % 720).toBe(2 * D2.lead!);
        expect(inArc(az, D2.sides[p].arc)).toBe(true);
        expect(launcherAz(o.yaw, D2, false)).toBe(azFromYaw(o.yaw));
        for (const [, aspect] of [...DESKTOPS, ['phone', 390 / 844]] as const) {
          expect(arcSpan(D2, p, aspect, true), `${D2.sides[p].name} ${aspect}`).toBeGreaterThanOrEqual(0.25);
          // Behind the camera (keystone.lead=0), the arc runs straight away from the eye: the playtest's stack of dots.
          expect(arcSpan(D2, p, aspect, false)).toBeLessThan(0.1);
        }
      }
      // D1 has no lead: its keeps stand off the ring's centre, so its arcs cross the screen already (about 15% of it
      // once the view backs off to show your own keep; the playtest found D1's arcs easy to read).
      expect(D1.lead).toBeUndefined();
      expect(arcSpan(D1, 0, 1.6, true)).toBeGreaterThan(0.12);
    });

    it.each(tables)('%s: the end view frames both sides', (_, def) => {
      const c = compileLevel(duelLevel(def)), d = new Duel(def, c);
      for (const [, aspect] of [...DESKTOPS, ['phone', 390 / 844]] as const) {
        const o = duelEndView(c, aspect), m = viewProj(o, aspect);
        for (const i of [...d.owned[0], ...d.owned[1]]) {
          const h = c.meta.home, w = m[3]! * h[3 * i]! + m[7]! * h[3 * i + 1]! + m[11]! * h[3 * i + 2]! + m[15]!;
          const x = (m[0]! * h[3 * i]! + m[4]! * h[3 * i + 1]! + m[8]! * h[3 * i + 2]! + m[12]!) / w, y = (m[1]! * h[3 * i]! + m[5]! * h[3 * i + 1]! + m[9]! * h[3 * i + 2]! + m[13]!) / w;
          expect(Math.abs(x) < 1 && Math.abs(y) < 1, `body ${i} at ${aspect}`).toBe(true);
        }
      }
    });
  });
});
