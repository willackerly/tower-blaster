// The tiered engine against plain Rapier (every cube dynamic) on the same
// ball shot. The reference starts from a packed tower that never settles,
// so individual cubes differ; the aggregate outcome must not.
import { describe, expect, it } from 'vitest';
import { RapierEngine, RapierHost } from '@tb/adapter-rapier';
import { buildScenario } from '@tb/scenarios';
import { brokenBonds, compare, compareBonds, trace, TieredEngine } from '../src/index.ts';

describe('tiered vs all-dynamic Rapier, ball into a 1,600-cube tower', () => {
  it('a ball that smashes small towers breaks about as many cubes and spreads them as far', { timeout: 120_000 }, async () => {
    // Broken bonds, not displacement: displacement counts sway as damage.
    // Measured at 600 steps: reference 181 to 192 broken cubes over 0-3% speed
    // perturbations, tiered 170 to 187; moved 105 to 112 vs 101 to 115.
    const scene = buildScenario('S5', { N: 1024, F: 4, H: 16, radius: 1, speed: 20, fireStep: 2 }, 1);
    scene.sleep = false;
    const ref = await trace(new RapierEngine(), scene, 600);
    const test = await trace(new TieredEngine(new RapierHost()), scene, 600);
    const b = compareBonds(scene, ref.final, test.final), c = compare(scene, ref.final, test.final);
    expect(b.brokenTest / b.brokenRef).toBeGreaterThan(0.85);
    expect(b.brokenTest / b.brokenRef).toBeLessThan(1.15);
    expect(b.jaccard).toBeGreaterThan(0.6);
    expect(Math.abs(c.spreadTest / c.spreadRef - 1)).toBeLessThan(0.1);
  });

  it('a ball that bounces off a big tower breaks little, wakes a small part of it, and it all comes back to rest', { timeout: 120_000 }, async () => {
    // A 10 kg ball at 20 m/s into an 8 x 8 x 25 tower of 1 kg cubes. A rigid
    // tower would tilt ~3 mm; all-dynamic Rapier sways ~0.5 m at the top for
    // seconds and ends with 8 to 29 broken cubes over 8 perturbed runs.
    // Before the slide rules the whole tower woke and stayed awake (1.2M
    // active body-steps in 900 steps); with them, measured over the same 8
    // runs: 0 to 97 broken (median 0), at most 201 awake, 6k to 33k body-steps.
    const scene = buildScenario('S5', { N: 1600, fireStep: 2 }, 1);
    scene.sleep = false;
    const e = new TieredEngine(new RapierHost());
    let peak = 0;
    const step = e.step.bind(e);
    e.step = async () => { const r = await step(); peak = Math.max(peak, e.stats.active); return r; };
    const t = await trace(e, scene, 600);
    const b = brokenBonds(scene, t.final);
    expect(new Set(b.broken.flat()).size).toBeLessThan(100);
    expect(peak).toBeLessThan(400);
    expect(e.stats.active).toBeLessThanOrEqual(1);
    expect(Math.max(...t.ballVx.filter((v) => !Number.isNaN(v)))).toBeGreaterThan(15); // it was shot, and
    expect(t.ballVx.at(-1)!).toBeLessThan(1); // it did not plough through
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
