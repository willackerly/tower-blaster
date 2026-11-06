// X4, cantilevers and hollows hold: the harmonic stacks, the corbelled span
// and the walls are what the probe says (CPU: statics by hand, no overlaps),
// and at CI size on the GPU engine (SwiftShader) the 95% stack holds and the
// 105% one falls, the span carries a bowling ball, and a hollowed brick wall
// loses only bricks over its hole and the wall beside it does not creep. The full-size probe
// (60 s at 20 and 40 iterations) runs with pnpm probe:modes X4.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BodyDesc } from '@tb/engine-api';
import { boxBoxSeparation, obb } from '@tb/geom';
import { requireWebGPU } from '@tb/testkit';
import { corners, probeById } from '../src/index.ts';
import { harmonicOverhang, overhang, span, SPAN, wall, X4, type X4Result } from '../src/x4-hold.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const ob = (b: BodyDesc) => obb(b.pos, b.rot, (b.shape as { half: [number, number, number] }).half);
const halfOf = (b: BodyDesc) => (b.shape as { half: [number, number, number] }).half;
const noOverlaps = (bs: BodyDesc[]) => { for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(boxBoxSeparation(ob(bs[i]!), ob(bs[j]!))).toBeGreaterThan(-1e-9); };

describe('X4 structures', () => {
  it('harmonic stacks: at 95% every sub-stack\'s centre of mass is over the block below it, at 105% every one is past its edge', () => {
    for (const f of [0.95, 1.05]) {
      const [pedestal, ...stack] = overhang(8, f, 0);
      noOverlaps([pedestal!, ...stack]);
      // stack[0] is the bottom block; the one below block k is k - 1, and the pedestal's edge is x = 0.
      const reach = stack.at(-1)!.pos[0] + halfOf(stack.at(-1)!)[0];
      expect(reach).toBeCloseTo(f * harmonicOverhang(8), 9);
      for (let k = 0; k < stack.length; k++) {
        const above = stack.slice(k), com = above.reduce((a, b) => a + b.pos[0], 0) / above.length;
        const edge = k === 0 ? 0 : stack[k - 1]!.pos[0] + halfOf(stack[k - 1]!)[0];
        if (f < 1) expect(com).toBeLessThan(edge); else expect(com).toBeGreaterThan(edge);
      }
    }
  });

  it('the span: 3 m clear at the foot, its top courses meet, and each side\'s courses stand on the course below with their load over it', () => {
    const bs = span(3);
    noOverlaps(bs);
    const foot = bs.filter((b) => b.pos[1] < 0.5), inner = Math.min(...foot.map((b) => Math.abs(b.pos[0]) - halfOf(b)[0]));
    expect(2 * inner).toBeCloseTo(3, 2);
    const topY = Math.max(...bs.map((b) => b.pos[1]));
    expect(Math.min(...bs.filter((b) => b.pos[1] === topY).map((b) => Math.abs(b.pos[0]) - halfOf(b)[0]))).toBeLessThan(1e-3);
    for (let k = 1; k < SPAN.courses; k++) {
      // Right side: the centre of mass of courses k and up lies over course k - 1's extent.
      const right = bs.filter((b) => b.pos[0] > 0), course = (j: number) => right.filter((b) => Math.round(b.pos[1] / 0.5 - 0.5) === j);
      const above = right.filter((b) => Math.round(b.pos[1] / 0.5 - 0.5) >= k), com = above.reduce((a, b) => a + b.pos[0], 0) / above.length;
      const below = course(k - 1), lo = Math.min(...below.map((b) => b.pos[0] - 0.5)), hi = Math.max(...below.map((b) => b.pos[0] + 0.5));
      expect(com).toBeGreaterThan(lo);
      expect(com).toBeLessThan(hi);
    }
  });

  it('walls: running bond and the cube lattice, 1 cm joints, nothing overlapping, the hollow taking the bodies inside the half disc', () => {
    for (const kind of ['bricks', 'cubes'] as const) {
      const w = wall(kind, 8, 6, 1.6);
      noOverlaps(w.bodies);
      for (const b of w.bodies) expect(Math.min(...corners(b).map((p) => p[1]))).toBeGreaterThan(-1e-9);
      expect(w.hollow.length).toBeGreaterThan(2);
      for (const i of w.hollow) expect(Math.hypot(w.bodies[i]!.pos[0], w.bodies[i]!.pos[1])).toBeLessThan(1.6);
    }
    expect(wall('bricks', 20, 25, 5).bodies).toHaveLength(13 * 20 + 12 * 21);
    expect(wall('cubes', 40, 25, 5).bodies).toHaveLength(1000);
    expect(probeById('X4')).toBe(X4);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X4 on the GPU engine at game settings (CI size)', () => {
  it('95% holds, 105% falls, the span carries the ball, the hollowed brick wall holds', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X4, 'ci', { log: (l) => console.log(l) });
    console.log(run.verdict.table.join('\n'));
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    expect(run.verdict.checks.filter((c) => !c.pass)).toEqual([]);
    const arch = run.runs.find((r) => r.label.startsWith('arch'))!.result as X4Result;
    expect(arch.dropped.length).toBeGreaterThan(0);
    // The wall's own creep is part of the creep anywhere, and the body that crept most is named with where it stood.
    expect(arch.creepWall).toBeLessThanOrEqual(arch.creep);
    // Triangle inequality: a move from the window's midpoint is at most twice the largest move from its start.
    expect(arch.creepLate).toBeLessThanOrEqual(2 * arch.creep + 1e-9);
    if (arch.creep > 0) { expect(arch.creepBody).toBeGreaterThanOrEqual(0); expect(arch.creepFromPos).not.toBeNull(); }
  });
});
