// The opt-in lattice colouring (AvbdParams.colorMode, colorPriority) on the
// GPU: the reference rule's colours through an impact (lattice-rule-case.ts),
// for largest-degree-first priority, alone and with mode 4.
import { describe, it } from 'vitest';
import type { AvbdParams } from '@tb/physics-ref';
import { gpu } from './lattice-harness.ts';
import { RULE_CASE, ruleCase } from './lattice-rule-case.ts';

describe('GPU AVBD engine: lattice colouring (AvbdParams.colorMode, colorPriority)', () => {
  it.for<Partial<AvbdParams>>([{ colorPriority: 1 }, { colorMode: 4, colorPriority: 1 }])(`%j: ${RULE_CASE}`, { timeout: 600_000 }, async (params, ctx) => {
    if (!gpu) return ctx.skip();
    await ruleCase(params);
  });
});
