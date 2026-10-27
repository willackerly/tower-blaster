// The opt-in lattice colouring (AvbdParams.colorMode) on the GPU against
// the f64 reference variant through an impact, for colorMode 3
// (lattice-impact-case.ts): it follows the reference until the ball arrives,
// on every split between direct colours and the tail. Apart from
// lattice-physics-<modes>.test.ts and the other modes' files so they run on separate
// CI workers.
import { describe, it } from 'vitest';
import { gpu } from './lattice-harness.ts';
import { IMPACT_CASE, impactCase } from './lattice-impact-case.ts';

describe('GPU AVBD engine: lattice colouring against the reference variant through an impact', () => {
  it(`colorMode 3: ${IMPACT_CASE}`, { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await impactCase(3);
  });
});
