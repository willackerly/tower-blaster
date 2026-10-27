// The opt-in lattice colouring (AvbdParams.colorMode, colorPriority) on the
// GPU: the reference rule's colours through an impact (lattice-rule-case.ts),
// for the other patterns, modes 1 and 2 (2 also with colorPriority 1).
import { describe, it } from 'vitest';
import type { AvbdParams } from '@tb/physics-ref';
import { gpu } from './lattice-harness.ts';
import { RULE_CASE, ruleCase } from './lattice-rule-case.ts';

describe('GPU AVBD engine: lattice colouring (AvbdParams.colorMode, colorPriority)', () => {
  it.for<Partial<AvbdParams>>([{ colorMode: 1 }, { colorMode: 2 }, { colorMode: 2, colorPriority: 1 }])(`%j: ${RULE_CASE}`, { timeout: 600_000 }, async (params, ctx) => {
    if (!gpu) return ctx.skip();
    await ruleCase(params);
  });
});
