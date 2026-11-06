// Pinned bodies (engine-api pinned.ts, roadmap C8) on the f64 reference: the shared cases of @tb/testkit's pinned.ts.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { PIN_CASE, pinErrors, pinScene, PIN_SLIDE_CASE, pinSlideErrors, pinSlideScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, push = false): Promise<Snapshot[]> {
  const e = new AvbdReferenceEngine();
  await e.init(push ? { ...scene, inputs: [] } : scene);
  if (push) e.push(scene.inputs);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  return out;
}

describe('AVBD reference: pinned bodies', () => {
  it('holds a pinned body exactly where it was given, at rest and not awake, under a load, a ball and a blast; a removed pin drops its load', async () => {
    const r = pinErrors(await run(pinScene(), PIN_CASE.end));
    expect(r.pinMoved).toBe(0);
    expect(r.pinSpeed).toBe(0);
    expect(r.pinAwake).toEqual([]);
    expect(r.droppedRests).toBe(true);
    // The cube on the removed pin (top at 2.5) falls to the ground (its centre at 0.4): 2.9 - 0.4.
    expect(r.cubeDrop).toBeCloseTo(2.5, 1);
  });

  it('a cube slides on a pinned slab as on the ground plane at the slab\'s height', async () => {
    const r = pinSlideErrors(await run(pinSlideScene(true), PIN_SLIDE_CASE.end), await run(pinSlideScene(false), PIN_SLIDE_CASE.end));
    expect(r.path).toBeGreaterThan(1);
    // X5's rule: within 1 cm + 1% of the path.
    expect(r.diff).toBeLessThan(0.01 + 0.01 * r.path);
  });

  it('a pinned body pushed after init is as solid, and pushed inputs replay scene ones bit for bit', async () => {
    const scene = pinScene(), spawned = { ...scene, bodies: scene.bodies.slice(0, 1), inputs: [...scene.bodies.slice(1).map((body) => ({ step: 0, kind: 'spawn' as const, body })), ...scene.inputs] };
    const a = await run(spawned, PIN_CASE.end), b = await run(spawned, PIN_CASE.end, true);
    expect(b.at(-1)!.pos).toEqual(a.at(-1)!.pos);
    // Spawned at step 0, the bodies are there from the first step on: the same run as given at init.
    const c = await run(scene, PIN_CASE.end);
    expect(a.at(-1)!.pos).toEqual(c.at(-1)!.pos);
  });

  it('refuses pinned bodies with restitution on, at init and push', async () => {
    const e = new AvbdReferenceEngine({ restitution: true });
    await expect(e.init(pinScene())).rejects.toThrow(/pinned bodies are not implemented with AvbdParams.restitution/);
    await e.init(pinSlideScene(false));
    expect(() => e.push([{ step: 1, kind: 'spawn', body: pinSlideScene(true).bodies[1]! }])).toThrow(/pinned bodies are not implemented/);
  });
});
