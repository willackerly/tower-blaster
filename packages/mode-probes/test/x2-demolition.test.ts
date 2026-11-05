// X2, does order matter when a building comes down: the buildings and their
// charges are what the probe says (CPU), and at CI size on the GPU engine
// (SwiftShader) felling the slab building west lands rubble outside its
// footprint where firing every charge at once drops it straight down. The
// full-size probe runs with pnpm probe:modes X2 (docs/game/mode-probes.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BodyDesc } from '@tb/engine-api';
import { boxBoxSeparation, obb } from '@tb/geom';
import { requireWebGPU } from '@tb/testkit';
import { corners, probeById } from '../src/index.ts';
import { building, CELL, CHARGES, footprintOf, ORDERS, PITCH, X2, type X2Result, x2Spec } from '../src/x2-demolition.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const ob = (b: BodyDesc) => obb(b.pos, b.rot, (b.shape as { half: [number, number, number] }).half);

describe('X2 buildings and charges', () => {
  it.for(['cubes', 'slabs'] as const)('%s 4x4x12: cells stand clear of each other, and the four charges between them take exactly the ground storey', (design) => {
    const { bodies, charges } = building(design, 4, 4, 12, 3);
    expect(bodies).toHaveLength(design === 'cubes' ? 192 : 4 * (2 * 16 + 1));
    for (const b of bodies) expect(Math.min(...corners(b).map((p) => p[1]))).toBeGreaterThan(-1e-9);
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      if (Math.abs(bodies[i]!.pos[1] - bodies[j]!.pos[1]) < 0.9 * CELL) expect(boxBoxSeparation(ob(bodies[i]!), ob(bodies[j]!))).toBeGreaterThan(0.005);
    }
    const fired = CHARGES.flatMap((k) => charges[k]);
    expect(new Set(fired).size).toBe(fired.length);
    const ground = bodies.flatMap((b, i) => (b.pos[1] < 2 * CELL ? [i] : []));
    expect(fired.sort((a, b) => a - b)).toEqual(ground);
    expect(charges.W.every((i) => bodies[i]!.pos[0] < -PITCH)).toBe(true);
    expect(charges.E.every((i) => bodies[i]!.pos[0] > PITCH)).toBe(true);
    expect(charges.C).toHaveLength(8);
    if (design === 'slabs') {
      const slab = bodies.find((b) => b.shape.kind === 'box' && b.shape.half[0] > CELL)!;
      expect((slab.shape as { half: number[] }).half[0]! * 2).toBeCloseTo(3 * PITCH + CELL, 12);
    }
  });

  it('every order fires every charge once, after the pre-settle', () => {
    for (const order of ORDERS) {
      const s = x2Spec({ design: 'slabs', W: 4, D: 4, H: 6, order, nudge: 1, presettle: 300 });
      const ids = s.scene.inputs.map((e) => (e.kind === 'remove' ? e.id : -1));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(2 * 16);
      expect(Math.min(...s.scene.inputs.map((e) => e.step))).toBe(300);
    }
    expect(footprintOf({ W: 4, D: 4 }).x).toBeCloseTo((3 * PITCH + CELL) / 2 + CELL, 12);
    expect(probeById('X2')).toBe(X2);
    expect(X2.cases('full')).toHaveLength(2 * ORDERS.length * 32);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X2 on the GPU engine at game settings (CI size)', () => {
  it('felling the slab building west spills rubble; firing everything at once drops it in its footprint', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X2, 'ci', { log: (l) => console.log(l) });
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    console.log(run.verdict.table.join('\n'));
    const res = (label: string) => run.runs.find((r) => r.label === label)!.result as X2Result;
    const drop = res('slabs 4x4x6 all at once nudge 1'), fell = res('slabs 4x4x6 fell west, east wall +0.3 s nudge 1');
    expect(drop.spill).toBeLessThan(0.05);
    expect(fell.spill - drop.spill).toBeGreaterThanOrEqual(0.1);
    expect(fell.lean).toBeLessThan(-0.5);
    for (const r of run.runs) {
      expect(r.limits, r.label).toEqual([]);
      expect((r.result as X2Result).settled, r.label).toBe(true);
      expect((r.result as X2Result).down, r.label).toBeGreaterThan(0.5);
    }
  });
});
