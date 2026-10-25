import { describe, expect, it } from 'vitest';
import { bodiesAt, type CombineRule, freeFlight, type SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { appliedMu, slideMu, slideScene, THROW, throwScene } from '@tb/testkit';
import RAPIER from '@dimforge/rapier3d-simd-compat';
import { RapierEngine } from '../src/index.ts';

function dropScene(y0: number): SceneDesc {
  return {
    id: 'drop', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: null, sleep: false,
    bodies: [{ shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos: [0, y0, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 }],
    inputs: [],
  };
}

describe('RapierEngine', () => {
  it('free fall: exact velocity, position between continuous and one-substep Euler', async () => {
    const e = new RapierEngine();
    const scene = dropScene(100);
    await e.init(scene);
    const n = 30, g = 9.81, dt = scene.dt;
    for (let i = 0; i < n; i++) e.step();
    const s = e.snapshot();
    // Rapier substeps internally, so the drop lies between the exact g t^2/2
    // and symplectic Euler with one substep, g dt^2 n(n+1)/2.
    const drop = 100 - s.pos[1]!;
    expect(drop).toBeGreaterThan((g * (n * dt) ** 2) / 2 - 1e-4);
    expect(drop).toBeLessThan((g * dt ** 2 * n * (n + 1)) / 2 + 1e-4);
    expect(s.linVel[1]).toBeCloseTo(-g * n * dt, 4);
    e.dispose();
  });

  it('keeps a small tower standing and lets it sleep', async () => {
    const e = new RapierEngine();
    const scene = buildScenario('S1', { F: 2, H: 5, gap: 0.02 });
    await e.init(scene);
    for (let i = 0; i < 240; i++) e.step();
    const s = e.snapshot();
    const top = Math.max(...Array.from({ length: s.count }, (_, i) => s.pos[3 * i + 1]!));
    expect(top).toBeGreaterThan(0.98 * 4.5);
    expect(s.awake.every((a) => a === 0)).toBe(true);
    e.dispose();
  });

  it('spawns input bodies at their step, matching bodiesAt', async () => {
    const e = new RapierEngine();
    const scene = buildScenario('S5', { N: 200, F: 4, H: 5, fireStep: 3 });
    await e.init(scene);
    for (let i = 0; i < 3; i++) e.step();
    expect(e.snapshot().count).toBe(bodiesAt(scene, 3).length);
    e.step();
    const s = e.snapshot();
    expect(s.count).toBe(bodiesAt(scene, 4).length);
    expect(s.count).toBe(201);
    expect(s.linVel[3 * 200]).toBeGreaterThan(15); // ball moving +x
    e.dispose();
  });

  it('honours the iteration option and reports it in the variant', () => {
    expect(new RapierEngine({ iterations: 8 }).info.variant.iterations).toBe(8);
  });
});

describe('RapierEngine: engine contract (friction rule, integrator)', () => {
  const mu = async (rule: CombineRule | undefined) => {
    const e = new RapierEngine();
    await e.init(slideScene(rule));
    e.step();
    const v1 = e.snapshot().linVel[0]!;
    for (let i = 0; i < 10; i++) e.step();
    const v11 = e.snapshot().linVel[0]!;
    e.dispose();
    return appliedMu(v1, v11);
  };
  it.for(['average', 'min', 'max', 'multiply'] as const)('SceneDesc.frictionCombine %s reaches Rapier: the cube decelerates with the combined mu', async (rule) => {
    // Rapier's solver lands within about 1% (0.891 for max's 0.9); the closest two rules are 11% apart.
    expect(Math.abs((await mu(rule)) / slideMu(rule) - 1)).toBeLessThan(0.02);
  });

  it('frictionCombine defaults to average', async () => {
    expect(await mu(undefined)).toBe(await mu('average'));
  });

  it('every collider, ground included, carries the rule, so body-body contacts use it too', async () => {
    // A pair takes the higher-priority rule of its two colliders, so the slide alone
    // can't see a body collider left at the default.
    const e = new RapierEngine();
    const scene = slideScene('min');
    scene.bodies.push({ ...scene.bodies[0]!, pos: [0, 2, 0] });
    await e.init(scene);
    const rules: number[] = [];
    (e as unknown as { world: RAPIER.World }).world.forEachCollider((c) => rules.push(c.frictionCombineRule()));
    expect(rules).toEqual(Array(3).fill(RAPIER.CoefficientCombineRule.Min));
    e.dispose();
  });

  it.for([4, 1, 8])('free flight with %i iterations is semi-implicit Euler with that many substeps, as EngineInfo.integrator says', async (iterations) => {
    const e = new RapierEngine({ iterations });
    expect(e.info.integrator).toEqual({ substeps: iterations });
    const scene = throwScene();
    await e.init(scene);
    for (let i = 0; i < THROW.steps; i++) e.step();
    const s = e.snapshot();
    const want = freeFlight(THROW.pos, THROW.vel, scene.gravity, scene.dt, iterations, THROW.steps);
    // f32 state; one substep fewer or more would be 1 cm or more off by now.
    for (let k = 0; k < 3; k++) expect(Math.abs(s.pos[k]! - want.pos[k]!)).toBeLessThan(5e-4);
    const other = freeFlight(THROW.pos, THROW.vel, scene.gravity, scene.dt, iterations === 1 ? 2 : iterations - 1, THROW.steps);
    expect(Math.abs(other.pos[1]! - want.pos[1]!)).toBeGreaterThan(1e-2 / iterations);
    e.dispose();
  });
});
