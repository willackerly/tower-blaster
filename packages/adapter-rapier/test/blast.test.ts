// Blasts (engine-api blast.ts) on Rapier: the shared case of @tb/testkit's
// blast.ts. Rapier keeps f32 state, so the velocity change holds to f32 rounding.
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@tb/engine-api';
import { BLAST_CASE, blastErrors, blastScene } from '@tb/testkit';
import { RapierEngine } from '../src/index.ts';

async function run(withBlast: boolean, steps: number): Promise<Snapshot[]> {
  const e = new RapierEngine();
  await e.init(blastScene(withBlast));
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  e.dispose();
  return out;
}

describe('RapierEngine: blasts', () => {
  it('changes exactly the velocities blastKick gives, and nothing else', async () => {
    const at = BLAST_CASE.step;
    const base = await run(false, at + 1), blasted = await run(true, at + 1);
    const r = blastErrors(base[at]!, base[at + 1]!, blasted[at + 1]!);
    expect(r.relErr).toBeLessThan(1e-5);
    expect(r.untouchedChanged).toEqual([]);
  });
});
