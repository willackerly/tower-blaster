// Fuse & Fold's domino fuses (M5b, docs/game/fuse-and-fold.md, "Domino fuses"): the lane board's geometry, the level
// it builds (bodies, charges, watches), the props kept out of the building's numbers and the weapon scale, the lanes
// the game reads back, the Light shot, stroke snapping, and the detonator's wait against the longest fuse a budget lays.
import { describe, expect, it } from 'vitest';
import { DETONATOR_WAIT } from '@tb/weapons';
import {
  asideOf, compileLevel, cubeScale, DOMINO_PITCH, FOLD_SITES, foldLevel, FUSE_HOP_STEPS, FUSE_LEAD_STEPS, FUSE_SITES, fuseCandidate, fuseGo, fuseLanes, fuseSteps,
  FUSE_LEVELS, isFuseLevel, LANE_BODIES, laneGeometry, laneParts, LEAD_HALF, LEAD_TILT, LEAD_Y, type LevelDef, type P2, runCentres, snapFuse, STOP_AT, STOP_HALF, validateLevel,
} from '@tb/keystone';

const rad = (d: number) => (d * Math.PI) / 180;
const IDS = Object.keys(FUSE_SITES);

describe('the lane board', () => {
  it('the lead stands on its low edge at LEAD_TILT, and the stop\'s top edge meets its face 0.6 h above its centre', () => {
    const t = rad(LEAD_TILT), [hx, hy] = LEAD_HALF;
    expect(LEAD_Y).toBeCloseTo(hy * Math.cos(t) + hx * Math.sin(t), 4);
    // In the lane's (along, up) plane from the lead's centre: its face toward the lane is n = (cos t, -sin t) at hx; the
    // stop's near top edge is its centre less its half along, plus its half up.
    const edge = [STOP_AT[0] - STOP_HALF[2], STOP_AT[1] + STOP_HALF[1]], n = [Math.cos(t), -Math.sin(t)], u = [Math.sin(t), Math.cos(t)];
    const off = edge[0]! * n[0]! + edge[1]! * n[1]! - hx, along = edge[0]! * u[0]! + edge[1]! * u[1]!;
    expect(off).toBeGreaterThanOrEqual(0); // touching or just clear: never inside the lead
    expect(off).toBeLessThan(0.005);
    expect(along).toBeCloseTo(0.6, 2);
  });

  it('a lane\'s head and socket are its straight fuse apart, a pitch on from the lead run', () => {
    for (const id of IDS) for (const l of FUSE_SITES[id]!.fuse.lanes) {
      const g = laneGeometry(l), d = Math.hypot(g.socket[0] - g.head[0], g.socket[1] - g.head[1]);
      expect(d).toBeCloseTo(l.straight * DOMINO_PITCH, 9);
      expect(Math.hypot(g.head[0] - g.run.at(-1)![0], g.head[1] - g.run.at(-1)![1])).toBeCloseTo(DOMINO_PITCH, 9);
      // A straight fuse from the head to 0.6 h short of the socket lays exactly `straight` dominoes.
      const end: P2 = [g.socket[0] - g.dir[0] * 0.6, g.socket[1] - g.dir[1] * 0.6];
      expect(runCentres([g.head, end], DOMINO_PITCH)).toHaveLength(l.straight);
    }
  });

  it('the stop is pinned stone and the only part turned on a lane is the lead (its fields literal: the hash sees no trig)', () => {
    const p = laneParts(FUSE_SITES['FD-2']!.fuse.lanes[0]!);
    expect(p.stop).toMatchObject({ kind: 'piece', material: 'stone', pinned: true });
    expect(p.socket).not.toHaveProperty('yaw');
    expect(p.lead).toMatchObject({ yaw: 180, tilt: -LEAD_TILT });
  });
});

describe('fuse levels', () => {
  it.for(IDS)('%s compiles clean: a release per lane on its stop, a detonator per row column watching the lane\'s socket', (id) => {
    const d = fuseCandidate(id), c = compileLevel(d), fs = FUSE_SITES[id]!.fuse;
    expect(validateLevel(c).filter((i) => !i.warning)).toEqual([]);
    expect(isFuseLevel(d)).toBe(true);
    expect(d.settle).toBe('v3');
    expect(d.build).toEqual({ budget: fs.budget, pieces: ['domino'], brush: true });
    const rel = d.charges!.filter((ch) => ch.weapon === 'release'), det = d.charges!.filter((ch) => ch.weapon === 'detonator');
    expect(rel).toHaveLength(fs.lanes.length);
    expect(det).toHaveLength(fs.lanes.reduce((a, l) => a + l.row.length, 0));
    expect(d.charges!.length).toBeLessThanOrEqual(16); // the plunger shot names every charge (MAX_TIMELINE)
    rel.forEach((r, k) => {
      const socket = r.host + LANE_BODIES - 1, watching = det.filter((x) => x.watch === socket);
      expect(watching).toHaveLength(fs.lanes[k]!.row.length);
      // The socket stands where the lane's geometry puts it.
      const g = laneGeometry(fs.lanes[k]!), h = c.frame.unit;
      expect(c.meta.home[3 * socket]! / h).toBeCloseTo(g.socket[0], 9);
      expect(c.meta.home[3 * socket + 2]! / h).toBeCloseTo(g.socket[1], 9);
    });
    // Detonators ride the frame's columns, never a prop.
    const aside = asideOf(c);
    for (const x of det) expect(aside[x.host]).toBe(0);
  });

  it.for(IDS)('%s: every lane body is a prop (aside), and laying dominoes leaves the weapon scale the frame\'s', (id) => {
    const d = fuseCandidate(id), c = compileLevel(d), aside = asideOf(c), first = c.meta.n - LANE_BODIES * FUSE_SITES[id]!.fuse.lanes.length;
    for (let i = first; i < c.meta.n; i++) expect(aside[i], `body ${i}`).toBe(1);
    // A site's level without its lanes (foldLevel) scales weapons to the same block, and so does one with 200 dominoes laid.
    const bare = compileLevel(foldLevel(id, 'bare', { ...FUSE_SITES[id]!.fuse.site, cuts: [0] }));
    const laid: LevelDef = { ...d, parts: [...d.parts, { kind: 'run', path: [[-60, -60], [-60, 180]], pitch: DOMINO_PITCH, half: [0.5, 1, 0.15], material: 'plaster' }] };
    expect(cubeScale(c)).toEqual(cubeScale(bare));
    expect(cubeScale(compileLevel(laid))).toEqual(cubeScale(bare));
  });

  it('F1 to F5 (timeline fold levels) are not fuse levels and keep their timeline', () => {
    for (const l of FUSE_LEVELS.filter((x) => /^F[1-5]$/.test(x.id))) { expect(isFuseLevel(l)).toBe(false); expect(fuseGo(l)).toBeNull(); }
    expect(isFuseLevel(compileLevel(foldLevel('x', 'x', FOLD_SITES['FC-1']!.site)).def)).toBe(false);
  });

  it('Light the fuses names every plunger charge at 0, in charge order', () => {
    const d = fuseCandidate('FD-3'), go = fuseGo(d)!;
    expect(go.ammo).toBe('plunger');
    expect(go.fuse).toEqual(d.charges!.map((_, i) => [i, 0]));
  });

  it('the detonator outwaits a fuse given the whole budget on one lane (the others straight)', () => {
    for (const id of IDS) {
      const fs = FUSE_SITES[id]!.fuse, others = fs.lanes.slice(1).reduce((a, l) => a + l.straight, 0), n = fs.budget - others;
      // A straight fuse is the slowest per domino (bends burn faster); 20% for engines that burn slower than the reference.
      expect((1.2 * (FUSE_LEAD_STEPS + (n + 1) * FUSE_HOP_STEPS)) / 60, id).toBeLessThan(DETONATOR_WAIT);
    }
  });
});

describe('lanes as the game reads them', () => {
  it.for(IDS)('%s: fuseLanes finds every lane: head, end 0.6 h short of the socket, direction, straight count, columns', (id) => {
    const c = compileLevel(fuseCandidate(id)), lanes = fuseLanes(c), fs = FUSE_SITES[id]!.fuse;
    expect(lanes).toHaveLength(fs.lanes.length);
    lanes.forEach((l, k) => {
      const g = laneGeometry(fs.lanes[k]!);
      expect(l.head[0]).toBeCloseTo(g.head[0], 3);
      expect(l.head[1]).toBeCloseTo(g.head[1], 3);
      expect(l.dir).toEqual(g.dir.map((x) => x + 0));
      expect(Math.hypot(l.end[0] - g.socket[0], l.end[1] - g.socket[1])).toBeCloseTo(0.6, 3);
      expect(l.straight).toBe(fs.lanes[k]!.straight);
      expect(l.hosts).toHaveLength(fs.lanes[k]!.row.length);
    });
  });

  it('none on other levels', () => {
    expect(fuseLanes(compileLevel(FUSE_LEVELS[0]!))).toEqual([]);
  });

  it('a stroke drawn near a head and an end snaps to them: straight it lays the straight fuse exactly', () => {
    const lanes = fuseLanes(compileLevel(fuseCandidate('FD-1'))), l = lanes[1]!;
    // Hand-drawn: starts 1 h off the head and ends 1.5 h short of the end, wobbling.
    const n = 12, stroke: P2[] = Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, x = l.head[0] + (l.end[0] - l.head[0]) * t + 0.3 * Math.sin(7 * t), z = l.head[1] + (l.end[1] - l.head[1]) * t;
      return [x + (i === 0 ? 1 : 0), z - l.dir[1] * (i === n ? -1.5 : 0)];
    });
    const s = snapFuse(lanes, stroke);
    expect(s[0]).toEqual(l.head);
    expect(s.at(-1)).toEqual(l.end);
    // The first and last pitches run straight along the lane.
    expect(s[1]![0] - s[0]![0]).toBeCloseTo(l.dir[0] * DOMINO_PITCH, 9);
    expect(s[1]![1] - s[0]![1]).toBeCloseTo(l.dir[1] * DOMINO_PITCH, 9);
    expect(s.at(-1)![1] - s.at(-2)![1]).toBeCloseTo(l.dir[1] * DOMINO_PITCH, 9);
    expect(runCentres(snapFuse(lanes, [l.head, l.end]), DOMINO_PITCH)).toHaveLength(l.straight);
  });

  it('a stroke far from every head and end is left as drawn', () => {
    const lanes = fuseLanes(compileLevel(fuseCandidate('FD-1'))), far: P2[] = [[-40, -40], [-30, -40], [-20, -38]];
    expect(snapFuse(lanes, far)).toEqual(far);
    expect(snapFuse([], far)).toEqual(far);
  });

  it('a straight fuse\'s burn is the lead plus a hop a domino; a bend burns faster', () => {
    const l = fuseLanes(compileLevel(fuseCandidate('FD-1')))[0]!;
    expect(fuseSteps([l.head, l.end])).toBeCloseTo(FUSE_LEAD_STEPS + (l.straight + 1) * FUSE_HOP_STEPS, 6);
    // A quarter circle of radius 3 h: its dominoes each burn quicker than a straight one's.
    const arc: P2[] = Array.from({ length: 19 }, (_, i) => [3 * Math.sin(rad(5 * i)), 3 - 3 * Math.cos(rad(5 * i))]);
    const k = runCentres(arc, DOMINO_PITCH).length;
    expect(fuseSteps(arc)).toBeLessThan(FUSE_LEAD_STEPS + (k + 1) * FUSE_HOP_STEPS);
  });
});
