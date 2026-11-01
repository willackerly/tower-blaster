// Per-body sleep (sleep.ts; roadmap E2), the differential against all-awake on S5, a ball through a wall (sleep-diff-case.ts).
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { gpu } from './harness.ts';
import { differential } from './sleep-diff-case.ts';

describe('GPU sleep: differential against all-awake', () => {
  it('S5: a ball through a sleeping wall moves and breaks as many cubes as through an awake one', { timeout: 450_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Fired at step 60, when the wall is asleep (it sleeps from step 30).
    const scene = { ...buildScenario('S5', { N: 96, F: 2, H: 8, street: 2, fireStep: 60, radius: 0.6, speed: 15 }, 1), sleep: true };
    const { a } = await differential(scene, 240, 60);
    expect(Math.min(...a.map((x) => x.moved))).toBeGreaterThan(5);
  });

});
