// Removals (engine-api remove.ts) on the f64 reference: the shared cases of
// @tb/testkit's remove.ts, exact.
import { describe, expect, it } from 'vitest';
import type { InputEvent, SceneDesc, Snapshot } from '@tb/engine-api';
import { REMOVE_CASE, removeErrors, removeScene, STACK_CASE, stackScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, push = false): Promise<Snapshot[]> {
  const e = new AvbdReferenceEngine();
  await e.init(push ? { ...scene, inputs: [] } : scene);
  if (push) e.push(scene.inputs);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  return out;
}

describe('AVBD reference: removals', () => {
  it('takes removed bodies out where they were, at rest and tier free, and leaves every other body bit for bit as it was', async () => {
    const base = await run(removeScene(false), REMOVE_CASE.end), removed = await run(removeScene(true), REMOVE_CASE.end);
    expect(base[REMOVE_CASE.end]!.tier).toBeUndefined();
    expect(removeErrors(base, removed)).toEqual({ kept: 0, removedMoved: expect.any(Number), removedSpeed: 0, badTiers: [] });
    // Frozen: positions exact; rotations renormalised at most to the last bit.
    expect(removeErrors(base, removed).removedMoved).toBeLessThan(1e-15);
    // The removed bodies would have moved: the baseline's fly on and the blasts push them.
    const id = 2, at = REMOVE_CASE.step, end = REMOVE_CASE.end;
    expect(Math.abs(base[end]!.pos[3 * id + 1]! - base[at]!.pos[3 * id + 1]!)).toBeGreaterThan(0.05);
  });

  it('pushed removals replay scene-input ones bit for bit', async () => {
    const a = await run(removeScene(true), REMOVE_CASE.end), b = await run(removeScene(true), REMOVE_CASE.end, true);
    expect(b.at(-1)).toEqual(a.at(-1));
  });

  it('a cube whose support is removed falls to the ground; the one beside it stands as it stood', async () => {
    const base = await run(stackScene(false), STACK_CASE.end), removed = await run(stackScene(true), STACK_CASE.end);
    const [b, r] = [base.at(-1)!, removed.at(-1)!];
    expect(b.pos[4]).toBeCloseTo(1.5, 1); // on its support
    expect(r.pos[4]).toBeCloseTo(0.5, 1); // on the ground
    expect(Math.abs(r.pos[3]!) + Math.abs(r.pos[5]!)).toBeLessThan(0.01); // straight down
    expect([...r.pos.subarray(6, 9)]).toEqual([...b.pos.subarray(6, 9)]);
    expect([...r.pos.subarray(0, 3)]).toEqual([...removed[STACK_CASE.step]!.pos.subarray(0, 3)]);
    expect([...r.tier!]).toEqual([255, 0, 0]);
  });

  it('refuses a bad removal at init and on push, and changes nothing', async () => {
    const e = new AvbdReferenceEngine();
    const scene = stackScene(false);
    await expect(e.init({ ...scene, inputs: [{ step: 0, kind: 'remove', id: 3 }] })).rejects.toThrow(/body 3, which does not exist/);
    await e.init(scene);
    e.push([{ step: 2, kind: 'remove', id: 1 }]);
    const again: InputEvent[] = [{ step: 4, kind: 'remove', id: 0 }, { step: 4, kind: 'remove', id: 1 }];
    expect(() => e.push(again)).toThrow(/body 1, which is already removed/);
    for (let i = 0; i < 3; i++) e.step();
    expect(() => e.push([{ step: 5, kind: 'blast', blast: { centre: { body: 1 }, radius: 1, impulse: 1 } }])).toThrow(/removed then/);
    expect(() => e.push([{ step: 5, kind: 'remove', id: 1 }])).toThrow(/already removed/);
    // Nothing of the refused batches was queued: body 0 is still in the world.
    for (let i = 0; i < 3; i++) e.step();
    expect([...e.snapshot().tier!]).toEqual([0, 255, 0]);
  });
});
