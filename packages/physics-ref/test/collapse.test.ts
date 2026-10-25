// Walls and columns that must fall the way rigid bodies do (S12, S13).
// Rapier fails both at its defaults (see the scenarios): it holds 17 of the
// 18 cubes over S12's hole for good, and its 4-degree column takes 6.0 s to
// reach 30 degrees, 33% slower than the rigid column.
import { describe, expect, it } from 'vitest';
import { freeFlight, type SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, type ColumnSample, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { AvbdReferenceEngine, type AvbdParams } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, params: Partial<AvbdParams> = {}) {
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  const samples: ColumnSample[] = [{ t: 0, pos: [...e.snapshot().pos] }];
  for (let i = 1; i <= steps; i++) { e.step(); samples.push({ t: i * scene.dt, pos: [...e.snapshot().pos] }); }
  return samples;
}

describe('reference AVBD: walls and columns fall as rigid bodies do', () => {
  it('S12: the cubes above a hole in a stack-bond wall fall freely, and the rest of the wall stays', async () => {
    // The defaults are the wall in Will's screenshot: 20 x 14, a 3 x 5 hole.
    const scene = buildScenario('S12', {}, 1);
    const above = aboveHole(scene);
    expect(above).toHaveLength(18);
    const steps = 30;
    const s = await run(scene, steps);
    const end = s[steps]!.pos;
    for (const i of above) {
      // Side contacts between aligned neighbours carry no normal force, so no friction:
      // each cube falls as semi-implicit Euler free flight (1.267 m in 0.5 s).
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      expect((scene.bodies[i]!.pos[1] - end[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
    }
    // The rest sags at most 1.6 cm while the contact penalties ramp up (2026-10-25).
    let worst = 0;
    scene.bodies.forEach((b, i) => {
      if (!above.includes(i)) worst = Math.max(worst, Math.hypot(end[3 * i]! - b.pos[0], end[3 * i + 1]! - b.pos[1], end[3 * i + 2]! - b.pos[2]));
    });
    expect(worst).toBeLessThan(0.03);
  });

  // A column of loose cubes whose joints stay shut moves as one rigid box
  // rocking on its corners (rodToppleTime, rodRock). The solver only gets
  // there with enough iterations: at the default 10, a 20-cube column flexes
  // (bends up to 1.3 m by 30 degrees) and topples 9% early; it is rigid from
  // 13 iterations. A 30-cube column at 3 degrees topples 20% early at 10, 6%
  // at 25 and within 1% at 40 (2026-10-25). The loose bounds at the default
  // still fail Rapier.
  it.for([
    [10, 0.12, Infinity],
    [20, 0.03, 0.1],
  ] as const)('S13: a 20-cube column leaning 4 deg topples like the rigid column (%s iterations)', async ([iterations, tol, maxBend]) => {
    const H = 20, rod = rodToppleTime(H, 4, 30);
    expect(rod).toBeCloseTo(4.51, 2);
    const r = readColumn(await run(buildScenario('S13', { H, deg: 4 }, 1), 330, { iterations }), H);
    expect(r.topple).not.toBeNull();
    expect(Math.abs(r.topple! / rod - 1)).toBeLessThan(tol);
    expect(r.bend).toBeLessThan(maxBend);
  });

  // Below its tipping angle (2.86 deg) the column rocks back. Its first swing
  // is a test of the rocking; later swings are not: there the potential is so
  // flat that 0.003% of the column's energy decides whether it falls, and the
  // solver gains that much at a landing (2026-10-25: at 40 iterations it
  // leans 2.32 deg on its third swing, where the rigid column leans 1.94).
  it.for([
    [10, 0.15, 0.6],
    [20, 0.03, 0.95],
  ] as const)('S13: a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column (%s iterations)', async ([iterations, tol, farMin]) => {
    const H = 20, rod = rodRock(H, 2);
    const r = readColumn(await run(buildScenario('S13', { H, deg: 2 }, 1), 300, { iterations }), H);
    expect(r.upright).not.toBeNull();
    expect(Math.abs(r.upright! / rod.upright - 1)).toBeLessThan(tol);
    expect(r.before).toBeLessThan(tippingAngle(H));
    expect(r.turned).toBe(true);
    // At 10 iterations the landing loses 31% of the swing (2026-10-25).
    expect(r.farSide / rod.farSide).toBeGreaterThan(farMin);
    expect(r.farSide / rod.farSide).toBeLessThan(1.02);
  });
});
