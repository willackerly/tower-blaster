// The body of the lattice-rule tests (lattice-rule-<set>.test.ts): the colours
// are the reference rule's (physics-ref coloring.ts) on the GPU's own poses
// and graph, at rest and through an impact. One file per set of modes, so CI's
// shard planner can put them on different workers (as one test in
// lattice-colours.test.ts the seven took 648 s on one runner, 2026-10-27).
import { expect } from 'vitest';
import type { AvbdParams } from '@tb/physics-ref';
import { call, impact } from './lattice-harness.ts';

export const RULE_CASE = 'the colours are the reference rule\'s on the GPU\'s own poses and graph, at rest and through an impact';

export async function ruleCase(params: Partial<AvbdParams>): Promise<void> {
  const at = [1, 10, 20, 30, 37, 40, 50, 60, 80];
  const r = await call('latticeRun', impact(), 80, params, {}, at);
  expect(r.error).toBeNull();
  for (const c of r.checks) {
    expect(c.mismatches, `${JSON.stringify(params)} step ${c.step}`).toBe(0);
    expect(c.uncolored).toBe(0);
    expect(c.overflow).toBe(0);
  }
  // The resting tower before the ball: every interior cube takes its pattern colour.
  const rest = r.checks.find((c) => c.step === 10)!;
  if (params.colorMode === 1) expect(rest.K).toBe(8);
  else if (params.colorMode) expect(rest.K).toBe(4);
  if (params.colorMode) expect(rest.tookPreference).toBe(rest.preferring);
}
