// X5, pinned anchors solid: the two frames of every case are the same scene
// (CPU: the surface transform round-trips, the pinned box's top face is the
// surface, every mover starts above it, gravity in the reference frame is the
// world's turned), the KS test behaves, and at CI size on the GPU engine
// (SwiftShader) no pinned body moves at all, the cannonball really lands on
// the surface, and the bodies on a pinned box move as on the ground. The
// full-size probe runs with pnpm probe:modes X5.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { requireWebGPU } from '@tb/testkit';
import { PROJECTILE_PRESETS } from '@tb/weapons';
import { GRAVITY, ks2, probeById, rng } from '../src/index.ts';
import { type Design, fromSurface, surfaceOf, toSurface, X5, type X5Case, type X5Result, x5Spec } from '../src/x5-pinned.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const DESIGNS: Design[] = ['slab', 'wall', 'ramp'];
const caseOf = (design: Design, frame: X5Case['frame']): X5Case => ({ design, frame, nudge: 1, marbles: 27, steps: 30 });

describe('X5 frames', () => {
  it('toSurface and fromSurface are inverse, and the pinned box\'s top face is the surface h = 0', () => {
    for (const d of DESIGNS) {
      const s = surfaceOf(d), r = rng(7);
      for (let k = 0; k < 20; k++) {
        const p: Vec3 = [10 * r() - 5, 10 * r() - 5, 10 * r() - 5], q = fromSurface(s, toSurface(s, p));
        for (let a = 0; a < 3; a++) expect(q[a]).toBeCloseTo(p[a]!, 12);
      }
      const box = x5Spec(caseOf(d, 'pinned')).scene.bodies[0]!;
      // The box centre sits half a thickness under the surface, along the surface normal.
      const c = toSurface(s, box.pos);
      expect(c[0]).toBeCloseTo(0, 12); expect(c[1]).toBeCloseTo(-s.half[1], 12); expect(c[2]).toBeCloseTo(0, 12);
      expect(box.rot).toEqual(s.Q);
    }
  });

  it('every mover starts above the surface, in both frames at the same surface-frame position and velocity; reference gravity is g turned into the surface frame', () => {
    for (const d of DESIGNS) {
      const s = surfaceOf(d), pin = x5Spec(caseOf(d, 'pinned')), ref = x5Spec(caseOf(d, 'reference'));
      expect(pin.pins).toEqual([0]);
      expect(ref.pins).toBeUndefined();
      const movers = pin.scene.bodies.slice(1);
      expect(movers).toHaveLength(ref.scene.bodies.length);
      movers.forEach((b, i) => {
        const g = ref.scene.bodies[i]!, l = toSurface(s, b.pos), r = (g.shape as { radius: number }).radius;
        for (let a = 0; a < 3; a++) expect(l[a]).toBeCloseTo(g.pos[a]!, 9);
        expect(g.pos[1]).toBeGreaterThan(r);
        const v = rotate([-s.Q[0], -s.Q[1], -s.Q[2], s.Q[3]], b.linVel);
        for (let a = 0; a < 3; a++) expect(v[a]).toBeCloseTo(g.linVel[a]!, 9);
      });
      const gr = ref.scene.gravity, gw = rotate(s.Q, gr);
      expect(Math.hypot(...gr)).toBeCloseTo(GRAVITY, 9);
      expect(gw[0]).toBeCloseTo(0, 9); expect(gw[1]).toBeCloseTo(-GRAVITY, 9); expect(gw[2]).toBeCloseTo(0, 9);
    }
    expect(probeById('X5')).toBe(X5);
  });

  it('ks2: identical samples give D 0 and p 1, disjoint ones D 1 and p near 0, and two draws of one distribution pass', () => {
    const a = Array.from({ length: 64 }, (_, i) => i / 64);
    expect(ks2(a, a)).toEqual({ D: 0, p: 1 });
    const far = ks2(a, a.map((x) => x + 2));
    expect(far.D).toBe(1);
    expect(far.p).toBeLessThan(1e-10);
    const r1 = rng(1), r2 = rng(2), x = Array.from({ length: 500 }, r1), y = Array.from({ length: 500 }, r2);
    expect(ks2(x, y).p).toBeGreaterThan(0.05);
    // A shift of 0.2 of the range in 500 draws is far outside chance.
    expect(ks2(x, y.map((v) => v + 0.2)).p).toBeLessThan(1e-6);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X5 on the GPU engine at game settings (CI size)', () => {
  it('pins hold exactly, the cannonball lands on the surface, and the pinned and ground runs agree', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X5, 'ci', { log: (l) => console.log(l) });
    console.log(run.verdict.table.join('\n'));
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    expect(run.verdict.checks.filter((c) => !c.pass)).toEqual([]);
    for (const r of run.runs) {
      const res = r.result as X5Result, c = r.c as X5Case;
      if (c.frame === 'pinned') { expect(res.pinMove, r.label).toBe(0); expect(res.pinTurn, r.label).toBe(0); }
      if (c.design === 'ramp') { expect(res.onSurface, r.label).toBeGreaterThan(0.9); continue; }
      // The ball hit: it touched the surface (came within 5 mm of it), and ended past where it struck, sliding on along
      // the slab or down the wall (a ball that bounced clear of the wall drifts off it a few cm under gravity along it).
      const [u, h] = res.end[0]!, radius = PROJECTILE_PRESETS.cannonball.diameter / 2;
      console.log(r.label, 'end', res.end[0], 'min gap', res.minGap);
      expect(res.minGap, r.label).toBeLessThan(5e-3);
      expect(h, r.label).toBeGreaterThan(radius - 0.01);
      if (c.design === 'slab') { expect(u, r.label).toBeGreaterThan(1); expect(h - radius, r.label).toBeLessThan(0.02); }
      else expect(u, r.label).toBeLessThan(-0.5);
    }
  });
});
