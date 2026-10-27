// The opt-in lattice colouring (AvbdParams.colorMode) on the GPU against
// the f64 reference variant through an impact, for colorMode 2
// (lattice-impact-case.ts). colorMode 2 is not a candidate (modes 3 and 4
// are; physics-ref/src/coloring.ts), and its case took 447 s on a CI runner,
// so it runs only with PHYSICS_GPU_SLOW=1, as engine-rest.test.ts's slow cases.
import { describe, it } from 'vitest';
import { gpu } from './lattice-harness.ts';
import { IMPACT_CASE, impactCase } from './lattice-impact-case.ts';

const slow = process.env.PHYSICS_GPU_SLOW === '1';

describe('GPU AVBD engine: lattice colouring against the reference variant through an impact', () => {
  it.runIf(slow)(`colorMode 2: ${IMPACT_CASE}`, { timeout: 900_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await impactCase(2);
  });
});
