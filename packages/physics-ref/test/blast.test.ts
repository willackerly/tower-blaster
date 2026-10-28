// Blasts (engine-api blast.ts) on the f64 reference: the shared case of
// @tb/testkit's blast.ts, exact to rounding.
import { describe, expect, it } from 'vitest';
import type { InputEvent, Snapshot } from '@tb/engine-api';
import { BLAST_CASE, blastErrors, blastScene, expectedKicks } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(withBlast: boolean, steps: number, push = false): Promise<Snapshot[]> {
  const e = new AvbdReferenceEngine();
  const scene = blastScene(withBlast);
  await e.init(push ? { ...scene, inputs: [] } : scene);
  if (push) e.push(scene.inputs);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  return out;
}

describe('AVBD reference: blasts', () => {
  const at = BLAST_CASE.step;

  it('changes exactly the velocities blastKick gives, and nothing else', async () => {
    const base = await run(false, at + 1), blasted = await run(true, at + 1);
    const r = blastErrors(base[at]!, base[at + 1]!, blasted[at + 1]!);
    expect(r.maxKick).toBeGreaterThan(10); // the case pushes hard enough to tell
    expect(r.relErr).toBeLessThan(1e-12);
    expect(r.untouchedChanged).toEqual([]);
    // Who is pushed: inside the radius, not excluded, not spawned after the blast.
    const k = expectedKicks(base[at]!);
    const pushed = Array.from({ length: k.length / 3 }, (_, i) => i).filter((i) => k[3 * i] || k[3 * i + 1] || k[3 * i + 2]);
    expect(pushed).toEqual([0, 1, 2, 4, 5, 6, 9, 10]); // 10: spawned after the first blast, pushed by the second
  });

  it('a pushed blast replays a scene-input blast bit for bit', async () => {
    const a = await run(true, at + 20), b = await run(true, at + 20, true);
    expect(b.at(-1)).toEqual(a.at(-1));
  });

  it('refuses a bad blast at init and on push, and changes nothing', async () => {
    const bad: InputEvent = { step: 0, kind: 'blast', blast: { centre: [0, 0, 0], radius: -1, impulse: 1 } };
    const e = new AvbdReferenceEngine();
    await expect(e.init({ ...blastScene(false), inputs: [bad] })).rejects.toThrow(/radius/);
    await e.init(blastScene(false));
    expect(() => e.push([blastScene(true).inputs[1]!, bad])).toThrow(/radius/);
    for (let i = 0; i <= at; i++) e.step();
    const base = await run(false, at + 1);
    expect(e.snapshot()).toEqual(base.at(-1));
  });
});
