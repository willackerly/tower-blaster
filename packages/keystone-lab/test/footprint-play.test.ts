// Footprints (footprint.ts, docs/design/grid.md) over a snapshot an engine left: L5's par line on the
// reference engine topples the dominoes, and the exact integer grid's spill and rubble height agree
// with a plain float reading of the same snapshot. The end snapshot also holds the ammo, which a
// footprint never counts.
import { describe, expect, it } from 'vitest';
import { compileLevel, L5, type Shot } from '@tb/keystone';
import { makeRunner, playFacts } from '@tb/keystone-lab';

describe('footprint facts on a played round', () => {
  it("match a float reading of L5's end state on the reference engine", async () => {
    const runner = makeRunner({ kind: 'ref' }, 1), c = compileLevel(L5), n = c.meta.n, h = c.frame.unit, p = c.frame.pitch * h;
    try {
      const r = await runner.play(L5, L5.solutions!.par as Shot[]);
      const s = r.snapshot;
      expect(s.count, 'the marble is in the snapshot too').toBeGreaterThan(n);
      const f = playFacts(c, { footprints: { exact: { grow: 0 }, near: { grow: 1 } } }, r).footprints;

      // Floats: a body's home cells from its axis-aligned home box, its end cell from its centre.
      const home = new Set<string>();
      for (let i = 0; i < n; i++) {
        const lo = (a: number) => Math.floor((c.meta.home[3 * i + a]! - c.meta.half[3 * i + a]!) / p), hi = (a: number) => Math.floor((c.meta.home[3 * i + a]! + c.meta.half[3 * i + a]!) / p);
        for (let x = lo(0); x <= hi(0); x++) for (let z = lo(2); z <= hi(2); z++) home.add(`${x},${z}`);
      }
      let mass = 0, out = 0, top = 0;
      for (let i = 0; i < n; i++) {
        const m = Math.round(c.meta.mass[i]! * 1000);
        mass += m;
        if (!home.has(`${Math.floor(s.pos[3 * i]! / p)},${Math.floor(s.pos[3 * i + 2]! / p)}`)) out += m;
        // The top of the rotated box: y + Σ_b |R_1b| half_b.
        const [x, y, z, w] = Array.from(s.rot.subarray(4 * i, 4 * i + 4)) as [number, number, number, number], hb = c.meta.half.subarray(3 * i, 3 * i + 3);
        const ext = Math.abs(2 * (x * y + w * z)) * hb[0]! + Math.abs(1 - 2 * (x * x + z * z)) * hb[1]! + Math.abs(2 * (y * z - w * x)) * hb[2]!;
        top = Math.max(top, s.pos[3 * i + 1]! + ext);
      }
      expect(out / mass, 'the dominoes fell out of their own cells').toBeGreaterThan(0.05);
      expect(f.exact!.spill).toBeCloseTo(out / mass, 12);
      expect(f.exact!.height).toBeCloseTo(top / h, 3);
      expect(f.exact!.height, 'nothing still stands 9 h tall').toBeLessThan(9);
      // Growing the mask can only take spill down and fill down, and IoU is never above fill.
      expect(f.near!.spill).toBeLessThanOrEqual(f.exact!.spill);
      expect(f.exact!.iou).toBeLessThanOrEqual(f.exact!.fill);
      expect(f.exact!.reach).toBeGreaterThan(0);
    } finally {
      await runner.close();
    }
  }, 300_000);
});
