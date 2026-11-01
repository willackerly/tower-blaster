// Removals (engine-api remove.ts) on Rapier: the shared cases of @tb/testkit's remove.ts. Rapier disables a
// removed body; the others keep their state to f32 rounding.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { REMOVE_CASE, removeErrors, removeScene, STACK_CASE, stackScene } from '@tb/testkit';
import { RapierEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number): Promise<Snapshot[]> {
  const e = new RapierEngine();
  await e.init(scene);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  e.dispose();
  return out;
}

describe('RapierEngine: removals', () => {
  it('takes removed bodies out where they were, at rest and tier free, and leaves every other body as it was', async () => {
    const r = removeErrors(await run(removeScene(false), REMOVE_CASE.end), await run(removeScene(true), REMOVE_CASE.end));
    expect(r.badTiers).toEqual([]);
    expect(r.kept).toBeLessThan(1e-5);
    expect(r.removedMoved).toBeLessThan(1e-6);
    expect(r.removedSpeed).toBe(0);
  });

  it('a cube whose support is removed falls to the ground; the one beside it stands', async () => {
    const [b, r] = [(await run(stackScene(false), STACK_CASE.end)).at(-1)!, (await run(stackScene(true), STACK_CASE.end)).at(-1)!];
    expect(b.pos[4]).toBeCloseTo(1.5, 1);
    expect(r.pos[4]).toBeCloseTo(0.5, 1);
    expect(Math.abs(r.pos[7]! - b.pos[7]!)).toBeLessThan(1e-5);
    expect([...r.tier!]).toEqual([255, 0, 0]);
  });
});
