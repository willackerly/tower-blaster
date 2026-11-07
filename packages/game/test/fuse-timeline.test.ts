// Fuse & Fold's timeline (fuse-timeline.ts): charge labels by grid position, sweeps by row along a
// direction, the plunger shot it makes (every charge, delays on the 0.1 s grid), and the markers.
import { describe, expect, it } from 'vitest';
import { B1, compileLevel, foldCandidate, FUSE_LEVELS, RL1, Session } from '@tb/keystone';
import { type Orbit, viewProj } from '@tb/render/camera';
import { arrowBeads, COMPASS_CELLS, COMPASS_COLOUR, compassArrow, delayColour, LOT_COLOUR, LOT_SPACING, lotBeads, MAX_SNAPS, northOnScreen, panelTimeline, planBeads, RELAY_COLOUR, relayCharges, SNAP_STEPS, sweepRanks, SWEEP_DIRS, Timeline, timelineCharges, timelineOverlay, YARD_COLOUR, yardArrow } from '../src/fuse-timeline.ts';

const c = compileLevel(foldCandidate('FC-2')); // a 3 x 3 frame: nine cutters on the ground storey

describe('timeline charges', () => {
  it('the panel shows on a plunger level, not on a Rube Lab contraption (its plunger is the Go release) or a launch level', () => {
    const f1 = compileLevel(FUSE_LEVELS[0]!);
    expect(panelTimeline(f1)?.charges.length).toBe(timelineCharges(f1).length);
    expect(timelineCharges(f1).length).toBeGreaterThan(0);
    expect(RL1.rack).toContain('plunger');
    expect(RL1.charges?.length).toBeGreaterThan(0);
    expect(panelTimeline(compileLevel(RL1))).toBeNull();
    expect(panelTimeline(compileLevel(B1))).toBeNull();
  });

  it('labels the ground columns A1 to C3: letters west to east, numbers north to south', () => {
    const ch = timelineCharges(c);
    expect(ch.map((t) => t.label).sort()).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']);
    const a1 = ch.find((t) => t.label === 'A1')!, c3 = ch.find((t) => t.label === 'C3')!;
    expect(a1.at[0]).toBeLessThan(c3.at[0]);
    expect(a1.at[2]).toBeLessThan(c3.at[2]);
    expect(ch.map((t) => t.charge)).toEqual(c.def.charges!.map((_, i) => i));
  });

  it('a sweep ranks rows along its direction, the far row first', () => {
    const ch = timelineCharges(c), cell = c.frame.unit * c.frame.pitch;
    const west = sweepRanks(ch, SWEEP_DIRS.find((d) => d.name === 'W')!.d, cell);
    ch.forEach((t, k) => expect(west[k]).toBe(t.label.charCodeAt(0) - 65));
    const north = sweepRanks(ch, SWEEP_DIRS.find((d) => d.name === 'N')!.d, cell);
    ch.forEach((t, k) => expect(north[k]).toBe(Number(t.label.slice(1)) - 1));
    // The diagonal: A1 (north-west corner) alone first, C3 last, five diagonals in all.
    const nw = sweepRanks(ch, SWEEP_DIRS.find((d) => d.name === 'NW')!.d, cell);
    expect(Math.max(...nw)).toBe(4);
    expect(nw[ch.findIndex((t) => t.label === 'A1')]).toBe(0);
  });
});

describe('the timeline', () => {
  it('starts all at once, and its shot names every charge, sorted by delay', () => {
    const t = new Timeline(c);
    expect(t.snaps.every((s) => s === 0)).toBe(true);
    t.sweep('E', 4);
    const shot = t.shot();
    expect(shot.fuse).toHaveLength(9);
    expect(new Set(shot.fuse.map((f) => f[0])).size).toBe(9);
    for (let k = 1; k < shot.fuse.length; k++) expect(shot.fuse[k]![1]).toBeGreaterThanOrEqual(shot.fuse[k - 1]![1]);
    // The east column (C) at 0, B at 0.4 s, A at 0.8 s; in engine steps.
    expect([...new Set(shot.fuse.map((f) => f[1]))]).toEqual([0, 4 * SNAP_STEPS, 8 * SNAP_STEPS]);
    expect(t.span).toBeCloseTo(0.8, 12);
    // What the game would fire: a fold level's plunger takes it.
    expect(new Session(c).plungerRefusal(shot)).toBeNull();
  });

  it('clamps and snaps delays, caps a long sweep at 2 s, and round-trips a shot', () => {
    const t = new Timeline(c);
    t.set(0, 3.4); t.set(1, -2); t.set(2, 99);
    expect(t.snaps.slice(0, 3)).toEqual([3, 0, MAX_SNAPS]);
    t.sweep('NW', 10);
    expect(Math.max(...t.snaps)).toBe(MAX_SNAPS);
    const shot = t.shot(), u = new Timeline(c);
    u.load(shot);
    expect(u.snaps).toEqual(t.snaps);
    t.clear();
    expect(t.snaps.every((s) => s === 0)).toBe(true);
    expect(() => t.sweep('UP', 1)).toThrow(/no direction/);
  });

  it('draws one marker per charge on its host, coloured by delay, the selected one larger', () => {
    const t = new Timeline(c);
    t.sweep('W', 10);
    t.selected = 4;
    const o = timelineOverlay(t), m = c.meta;
    expect(o.colours).toHaveLength(9);
    t.charges.forEach((ch, k) => {
      expect(o.colours[k]).toBe(delayColour(t.snaps[k]!));
      // Within a marker's reach of the host's box.
      const b = ch.host, dx = Math.abs(o.xyzr[4 * k]! - m.home[3 * b]!), dz = Math.abs(o.xyzr[4 * k + 2]! - m.home[3 * b + 2]!);
      expect(Math.max(dx - m.half[3 * b]!, dz - m.half[3 * b + 2]!)).toBeLessThan(o.xyzr[4 * k + 3]!);
    });
    expect(o.xyzr[4 * 4 + 3]).toBeGreaterThan(o.xyzr[3]!);
    expect(delayColour(0)).not.toBe(delayColour(MAX_SNAPS));
  });

  it('shows relays (armed at start) as markers of their own colour, off the timeline, by storey', () => {
    const r = compileLevel(foldCandidate('FC-5b')), t = new Timeline(r);
    expect(t.charges).toHaveLength(9);
    expect(t.relays).toHaveLength(9);
    expect(relayCharges(r).every((x) => x.storey === 5 && r.def.charges![x.charge]!.arm === 'start')).toBe(true);
    expect(t.shot().fuse.map((f) => f[0]).sort((a, b) => a - b)).toEqual(t.charges.map((ch) => ch.charge));
    expect(new Session(r).plungerRefusal(t.shot())).toBeNull();
    const o = timelineOverlay(t);
    expect(o.colours).toHaveLength(18);
    expect([...o.colours.slice(9)].every((x) => x === RELAY_COLOUR)).toBe(true);
    expect([...o.colours.slice(0, 9)].includes(RELAY_COLOUR)).toBe(false);
    // A level without relays has none.
    expect(relayCharges(c)).toEqual([]);
  });
});

describe('reading the scene', () => {
  it('chalks the lot: a bead on every corner, the edges evenly dotted about a cube edge apart, on the ground', () => {
    const o = lotBeads(c), n = o.colours.length, u = c.frame.unit, [x0, z0] = c.lot.min, [x1, z1] = c.lot.max;
    expect(o.colours.every((x) => x === LOT_COLOUR)).toBe(true);
    const pts = Array.from({ length: n }, (_, k) => [o.xyzr[4 * k]!, o.xyzr[4 * k + 1]!, o.xyzr[4 * k + 2]!] as const);
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) expect(pts.some(([x, , z]) => Math.abs(x - cx!) < 1e-6 && Math.abs(z - cz!) < 1e-6)).toBe(true);
    for (const [x, y, z] of pts) {
      expect(Math.min(Math.abs(x - x0), Math.abs(x - x1), Math.abs(z - z0), Math.abs(z - z1))).toBeLessThan(1e-6);
      expect(y).toBeCloseTo(o.xyzr[3]!, 6);
    }
    // Neighbours along the ring (it closes on itself) are about LOT_SPACING cube edges apart.
    for (let k = 0; k < n; k++) {
      const a = pts[k]!, b = pts[(k + 1) % n]!, d = Math.hypot(a[0] - b[0], a[2] - b[2]) / (LOT_SPACING * u);
      expect(d).toBeGreaterThan(0.6);
      expect(d).toBeLessThan(1.5);
    }
  });

  it('points the compass needle where north (-z) projects on screen, for any camera yaw (the eye above the ground)', () => {
    for (const yaw of [0, 0.4, 1.3, Math.PI / 2, 2.5, -2, -0.7]) {
      for (const pitch of [0.3, 0.6, 1.2]) {
      const o: Orbit = { target: [0, 1, 0], distance: 30, yaw, pitch, fovY: 0.8 };
      const m = viewProj(o, 1);
      const clip = (p: readonly number[]) => {
        const v = [0, 1, 2, 3].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!);
        return [v[0]! / v[3]!, v[1]! / v[3]!];
      };
      const a = clip([0, 1, 0]), b = clip([0, 1, -0.01]);
      // Screen angle of the north step, clockwise from up (clip y is up, x is right).
      const want = Math.atan2(b[0]! - a[0]!, b[1]! - a[1]!);
      expect(Math.abs(Math.atan2(Math.sin(northOnScreen(yaw, pitch) - want), Math.cos(northOnScreen(yaw, pitch) - want)))).toBeLessThan(1e-3);
      }
    }
  });
});

describe('the plan in the world (PT24)', () => {
  const byId = (id: string) => compileLevel(FUSE_LEVELS.find((d) => d.id === id)!);
  /** The arrow's heading, degrees clockwise from north (-z): W is 270, N 0. */
  const heading = (a: { tail: [number, number]; tip: [number, number] }) => (((Math.atan2(a.tip[0] - a.tail[0], -(a.tip[1] - a.tail[1])) * 180) / Math.PI) + 360) % 360;
  const inLot = (c: ReturnType<typeof compileLevel>, p: [number, number]) => p[0] >= c.lot.min[0] && p[0] <= c.lot.max[0] && p[1] >= c.lot.min[1] && p[1] <= c.lot.max[1];

  it('the yard arrow points from the building into the yard: F1 west, F2 north (the playtest\'s wrong way), F3 north-west (a corner lot), F4 and F5 west', () => {
    const want: Record<string, number> = { F1: 270, F2: 0, F3: 315, F4: 270, F5: 270 };
    for (const [id, deg] of Object.entries(want)) {
      const c = byId(id), a = yardArrow(c)!;
      expect(a, id).not.toBeNull();
      expect(Math.abs(heading(a) - deg), `${id}: heading ${heading(a)}`).toBeLessThan(1);
      // From outside every charge host (the building) to inside the lot, at least two cells long.
      const cell = c.frame.unit * c.frame.pitch;
      for (const t of timelineCharges(c)) expect(Math.hypot(a.tail[0] - t.at[0], a.tail[1] - t.at[2]), `${id} ${t.label}`).toBeGreaterThan(cell);
      expect(inLot(c, a.tip), `${id}: tip ${a.tip}`).toBe(true);
      expect(Math.hypot(a.tip[0] - a.tail[0], a.tip[1] - a.tail[1])).toBeGreaterThan(2 * cell);
    }
    // No yard arrow on a level that is not a fold, nor where the lot is centred on the building (F2's frame with its lot cut back to the building).
    expect(yardArrow(compileLevel(B1))).toBeNull();
    const centred = compileLevel({ ...FUSE_LEVELS[1]!, lot: { min: [-2.04, -2.04], max: [2.04, 2.04] } });
    expect(yardArrow(centred)).toBeNull();
  });

  it('the ground compass points north, COMPASS_CELLS long, outside the lot and off every body\'s footprint', () => {
    for (const def of FUSE_LEVELS) {
      const c = byId(def.id), a = compassArrow(c), cell = c.frame.unit * c.frame.pitch, m = c.meta;
      expect(heading(a), def.id).toBeCloseTo(0, 9);
      expect(a.tail[1] - a.tip[1]).toBeCloseTo(COMPASS_CELLS * cell, 9);
      expect(a.tail[0] > c.lot.max[0] || a.tail[0] < c.lot.min[0], `${def.id}: beside the lot`).toBe(true);
      for (let i = 0; i < m.n; i++) {
        const hit = Math.abs(a.tail[0] - m.home[3 * i]!) < m.half[3 * i]! && Math.max(a.tail[1], a.tip[1]) > m.home[3 * i + 2]! - m.half[3 * i + 2]! && Math.min(a.tail[1], a.tip[1]) < m.home[3 * i + 2]! + m.half[3 * i + 2]!;
        expect(hit, `${def.id}: body ${i} under the compass`).toBe(false);
      }
    }
  });

  it('arrow beads: a shaft from tail to tip on the ground and a two-barbed head behind the tip; the plan colours the yard green and the compass orange', () => {
    const pts = arrowBeads({ tail: [0, 0], tip: [-6, 0] }, 0.5);
    const beads = Array.from({ length: pts.length / 4 }, (_, k) => pts.slice(4 * k, 4 * k + 4));
    expect(beads[0]!.slice(0, 3)).toEqual([0, beads[0]![3], 0]);
    expect(beads.some((b) => b[0] === -6 && b[2] === 0)).toBe(true);
    for (const b of beads) { expect(b[0]).toBeGreaterThanOrEqual(-6); expect(b[1]).toBe(b[3]); }
    const barbs = beads.filter((b) => b[2] !== 0);
    expect(barbs.filter((b) => b[2]! > 0).length).toBe(barbs.filter((b) => b[2]! < 0).length);
    for (const b of barbs) expect(b[0]).toBeGreaterThan(-6); // back from the tip
    const f1 = byId('F1'), plan = planBeads(f1)!;
    expect(plan.colours.length).toBe((arrowBeads(yardArrow(f1)!, 0.5).length + arrowBeads(compassArrow(f1), 0.5).length) / 4);
    expect(new Set(plan.colours)).toEqual(new Set([YARD_COLOUR, COMPASS_COLOUR]));
    expect(planBeads(compileLevel(B1))).toBeNull();
  });
});
