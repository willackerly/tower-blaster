// Per-body sleep (sleep.ts; roadmap E2), the differential against all-awake on S14, a blast in a city (sleep-diff-case.ts).
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { gpu } from './harness.ts';
import { differential } from './sleep-diff-case.ts';

describe('GPU sleep: differential against all-awake', () => {
  it('S14: a blast in a sleeping city moves and breaks as many cubes as in an awake one', { timeout: 450_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const city = buildScenario('S14', { towers: 4, W: 3, D: 3, H: 6, street: 4 }, 1);
    const p0 = city.bodies[0]!.pos;
    const scene: SceneDesc = { ...city, sleep: true, inputs: [{ step: 60, kind: 'blast', blast: { centre: [p0[0] - 1, 1, p0[2] + 1], radius: 4, impulse: 6 } }] };
    const { a } = await differential(scene, 240, 60);
    expect(Math.min(...a.map((x) => x.moved))).toBeGreaterThan(5);
  });
});
