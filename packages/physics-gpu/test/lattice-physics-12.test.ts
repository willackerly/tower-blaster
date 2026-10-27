// The opt-in lattice colouring (AvbdParams.colorMode) on the GPU against
// the f64 reference variant, colorMode 1 and 2 (lattice-physics-case.ts):
// packed stacks stand. The other modes: lattice-physics-34.test.ts; an impact:
// lattice-impact-<mode>.test.ts; the colours themselves: lattice-colours.test.ts.
import { describe, it } from 'vitest';
import { gpu } from './lattice-harness.ts';
import { STAND_CASE, standCase } from './lattice-physics-case.ts';

describe('GPU AVBD engine: lattice colouring against the reference variant', () => {
  it.for([1, 2])(`colorMode %s: ${STAND_CASE}`, { timeout: 300_000 }, async (colorMode, ctx) => {
    if (!gpu) return ctx.skip();
    await standCase(colorMode);
  });
});
