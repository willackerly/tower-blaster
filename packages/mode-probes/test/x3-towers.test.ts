// X3, towers as dominoes: the three tower designs stand clear and rest on
// what is below them (CPU), and at CI size on the GPU engine (SwiftShader)
// the push fells the first tower of a chain of 3 in every design, with no
// engine limit hit and every run ending before its cap. Whether a chain
// propagates is the probe's finding, not the test's: pnpm probe:modes X3
// (docs/game/mode-probes.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BodyDesc } from '@tb/engine-api';
import { boxBoxSeparation, obb } from '@tb/geom';
import { requireWebGPU } from '@tb/testkit';
import { corners, probeById, rng } from '../src/index.ts';
import { chain, DESIGNS, SPACING, tower, TOWER_H, X3, type X3Result, x3Spec } from '../src/x3-towers.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const ob = (b: BodyDesc) => obb(b.pos, b.rot, (b.shape as { half: [number, number, number] }).half);
const lowest = (b: BodyDesc) => Math.min(...corners(b).map((p) => p[1]));
const highest = (b: BodyDesc) => Math.max(...corners(b).map((p) => p[1]));

describe('X3 towers', () => {
  it.for(DESIGNS)('%s: about 4 m tall in a 1 m square, nothing overlaps, and every body rests on the ground or on a body below it', (d) => {
    const { bodies, height } = tower(d, 0, rng(1), true);
    expect(Math.max(...bodies.map(highest))).toBeCloseTo(height, 2);
    expect(height).toBeGreaterThanOrEqual(TOWER_H);
    for (const b of bodies) for (const p of corners(b)) { expect(Math.abs(p[0])).toBeLessThan(0.52); expect(Math.abs(p[2])).toBeLessThan(0.52); }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) expect(boxBoxSeparation(ob(bodies[i]!), ob(bodies[j]!))).toBeGreaterThan(-1e-3);
      // Supported: on the ground, or its bottom within 1 mm of some body's top whose footprint it overlaps.
      const b = bodies[i]!, y = lowest(b);
      if (y > 0.01) expect(bodies.some((o) => o !== b && Math.abs(highest(o) - y) < 2e-3 && boxBoxSeparation(ob(o), ob(b)) < 2e-3)).toBe(true);
    }
  });

  it('a chain spaces its towers 0.55 h apart along +z and the push flies at the first one', () => {
    const c = chain({ design: 'bricks', towers: 4, nudge: 0, presettle: 300 });
    expect(c.towerOf.filter((t) => t === 3)).toHaveLength(16);
    expect(c.pitch).toBeCloseTo(SPACING * TOWER_H, 12);
    const s = x3Spec({ design: 'bricks', towers: 4, nudge: 2, presettle: 300 }), push = s.scene.inputs[0]!;
    if (push.kind !== 'spawn') throw new Error('the push is a spawn');
    expect(push.step).toBe(300);
    expect(push.body.linVel[2]).toBeGreaterThan(2.6);
    expect(push.body.pos[2] + 0.4).toBeLessThan(-0.5);
    expect(probeById('X3')).toBe(X3);
    expect(X3.cases('full')).toHaveLength(3 * 32);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X3 on the GPU engine at game settings (CI size)', () => {
  it('the push fells the first tower of every design; runs end before their cap with no limit hit', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X3, 'ci', { log: (l) => console.log(l) });
    console.log(run.verdict.table.join('\n'));
    for (const r of run.runs) {
      expect(r.error, r.label).toBeNull();
      expect(r.limits, r.label).toEqual([]);
      expect((r.result as X3Result).reach, r.label).toBeGreaterThanOrEqual(1);
      expect(r.steps, r.label).toBeLessThan(X3.spec(r.c as never).steps);
    }
  });
});
