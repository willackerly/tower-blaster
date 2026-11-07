// Rube Lab's goal drawn (rube-view.ts, PT26): a region bell's zone as a dotted outline on its floor, the ball's
// start ringed round the runner, none of it on a level without them.
import { describe, expect, it } from 'vitest';
import { compileLevel, L1, RL1, RL2, RL5, RUBE_LEVELS } from '@tb/keystone';
import { runnerOf, START_BEADS, START_COLOUR, START_COLUMN, START_RING, startBeads, ZONE_COLOUR, zoneBeads } from '../src/rube-view.ts';

describe('Rube Lab goal overlays', () => {
  it('a region bell (RL1, RL5): beads on its region\'s floor outline, gilt; a bell to hit (RL2) has none', () => {
    for (const def of [RL1, RL5]) {
      const c = compileLevel(def), h = c.frame.unit, o = def.objective;
      if (o.kind !== 'bell' || !o.region) throw new Error('region bell expected');
      const z = zoneBeads(c)!;
      const n = z.colours.length, [x0, y0, z0] = o.region.min.map((v) => v * h), [x1, , z1] = o.region.max.map((v) => v * h);
      expect(n, def.id).toBeGreaterThan(8);
      expect(new Set(z.colours)).toEqual(new Set([ZONE_COLOUR]));
      for (let i = 0; i < n; i++) {
        const [x, y, zz, r] = [z.xyzr[4 * i]!, z.xyzr[4 * i + 1]!, z.xyzr[4 * i + 2]!, z.xyzr[4 * i + 3]!];
        expect(y).toBeCloseTo(y0! + r, 5);
        // On the outline: within the rectangle, and on one of its four edges.
        expect(x).toBeGreaterThanOrEqual(x0! - 1e-5); expect(x).toBeLessThanOrEqual(x1! + 1e-5);
        expect(zz).toBeGreaterThanOrEqual(z0! - 1e-5); expect(zz).toBeLessThanOrEqual(z1! + 1e-5);
        expect(Math.min(Math.abs(x - x0!), Math.abs(x - x1!), Math.abs(zz - z0!), Math.abs(zz - z1!))).toBeLessThan(1e-4);
      }
    }
    expect(zoneBeads(compileLevel(RL2))).toBeNull();
  });

  it('the ball\'s start: a ring round the runner where the level puts it and a column over it, in the Go button\'s orange', () => {
    for (const def of RUBE_LEVELS) {
      const c = compileLevel(def), h = c.frame.unit, b = runnerOf(c);
      expect(b, def.id).toBeGreaterThanOrEqual(0);
      expect(c.scene.bodies[b]!.shape).toEqual({ kind: 'sphere', radius: 0.4 * h });
      const s = startBeads(c)!, home = [0, 1, 2].map((k) => c.meta.home[3 * b + k]!);
      expect(s.colours.length).toBe(START_BEADS + START_COLUMN.length);
      expect(new Set(s.colours)).toEqual(new Set([START_COLOUR]));
      for (let i = 0; i < START_BEADS; i++) {
        expect(Math.hypot(s.xyzr[4 * i]! - home[0]!, s.xyzr[4 * i + 2]! - home[2]!)).toBeCloseTo(START_RING * h, 5);
        expect(s.xyzr[4 * i + 1]).toBeCloseTo(home[1]!, 5);
      }
      for (let j = 0; j < START_COLUMN.length; j++) {
        const i = START_BEADS + j;
        expect([s.xyzr[4 * i], s.xyzr[4 * i + 2]]).toEqual([home[0], home[2]].map((v) => Math.fround(v!)));
        expect(s.xyzr[4 * i + 1]! - home[1]!).toBeCloseTo(START_COLUMN[j]! * h, 4);
      }
    }
  });

  it('none on a level that is not Rube Lab', () => {
    const c = compileLevel(L1);
    expect([runnerOf(c), zoneBeads(c), startBeads(c)]).toEqual([-1, null, null]);
  });
});
