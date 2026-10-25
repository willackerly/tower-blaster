// The tiered engine against plain Rapier (every cube dynamic) on the same
// ball shot. The reference starts from a packed tower that never settles,
// so individual cubes differ; the aggregate outcome must not.
import { describe, expect, it } from 'vitest';
import { RapierEngine, RapierHost } from '@tb/adapter-rapier';
import { buildScenario } from '@tb/scenarios';
import { compare, trace, TieredEngine } from '../src/index.ts';

describe('tiered vs all-dynamic Rapier, ball into a 1,600-cube tower', () => {
  it('moves about as many cubes and spreads them as far', async () => {
    const scene = buildScenario('S5', { N: 1600 }, 1);
    const ref = await trace(new RapierEngine(), scene, 180);
    const test = await trace(new TieredEngine(new RapierHost()), scene, 180);
    const c = compare(scene, ref.final, test.final);
    // Measured: reference 189 +- 8 moved over 1-4% speed perturbations, tiered 199 +- 14; spread 4.42 vs 4.32.
    expect(c.movedTest / c.movedRef).toBeGreaterThan(0.8);
    expect(c.movedTest / c.movedRef).toBeLessThan(1.25);
    expect(Math.abs(c.spreadTest / c.spreadRef - 1)).toBeLessThan(0.1);
  });

  it("frictionless: the static lattice does not swallow the ball's momentum", async () => {
    // With no friction anywhere, horizontal momentum is conserved exactly in
    // the reference (the ground pushes only vertically). Any momentum a
    // dormant cell absorbs while it is still static is lost.
    const scene = buildScenario('S5', { N: 1600 }, 1);
    for (const b of [...scene.bodies, ...scene.inputs.map((ev) => ev.body)]) b.friction = 0;
    scene.ground!.friction = 0;
    const test = await trace(new TieredEngine(new RapierHost()), scene, 150);
    const p0 = 200; // ball: mass 10 at 20 m/s
    expect(test.momentumX.at(-1)! / p0).toBeGreaterThan(0.9); // measured 0.93 (separate static boxes: 0.55)
    expect(Math.max(...test.momentumX) / p0).toBeLessThan(1.05);
  });
});
