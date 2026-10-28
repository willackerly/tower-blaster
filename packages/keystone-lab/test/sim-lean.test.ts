// Resting stacks must not lean over by themselves (Rapier and the AVBD
// reference). Its own file, apart from sim.test.ts: the reference's 10 s idle
// takes ~2 min of CPU, and behind the rest of sim.test it ran past its timeout
// on a busy CI runner. 300 s is the CI file budget (CLAUDE.md).
import { describe, expect, it } from 'vitest';
import { LEVELS } from '@tb/keystone';
import { ENGINES, idle } from './idle.ts';

describe.each(ENGINES)('levels on %s', (_name, make) => {
  // Resting stacks used to lean over by themselves on the AVBD reference,
  // growing from rounding error: L2's portal moved 0.94 m sideways by 10 s
  // (L1 55 mm, L3 6.7 mm). The load floor (AvbdParams.restDepth) fixed it;
  // L2 now moves 0.27 mm (2026-10-26).
  it('L2 does not lean in 10 s (within 1 mm sideways)', async () => {
    const { side } = await idle(make, LEVELS.find((l) => l.id === 'L2')!, 600);
    expect(side).toBeLessThan(1e-3);
  }, 300_000);
});
