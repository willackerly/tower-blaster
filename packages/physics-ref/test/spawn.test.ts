// Relative spawns (engine-api spawn.ts) on the f64 reference: the shared case of @tb/testkit's spawn.ts.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { BURST_CASE, burstMomentumError, burstScene, SPAWN_CASE, spawnErrors, spawnScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, push = false): Promise<Snapshot[]> {
  const e = new AvbdReferenceEngine();
  await e.init(push ? { ...scene, inputs: [] } : scene);
  if (push) e.push(scene.inputs);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  return out;
}

describe('AVBD reference: relative spawns', () => {
  it('starts each child where relativeBody puts it from its parent as the step starts, and leaves every other body bit for bit as it was', async () => {
    const base = await run(spawnScene(false), SPAWN_CASE.end), rel = await run(spawnScene(true), SPAWN_CASE.end);
    const r = spawnErrors(base, rel, 1);
    expect(r.children).toBe(5);
    expect(r.othersChanged).toEqual([]);
    expect(r.pos).toBeLessThan(1e-12);
    expect(r.vel).toBeLessThan(1e-12);
    expect(r.rot).toBeLessThan(1e-12);
    // The case means something: the first child's parent was pushed at its step (it inherits the state before), and the split's parent is gone.
    const at = SPAWN_CASE.step;
    expect(rel[at + 1]!.linVel[1]! - rel[at]!.linVel[1]! + 9.81 / 60).toBeGreaterThan(1);
    expect(rel[at + 1]!.tier![1]).toBe(255);
  });

  it('pushed relative spawns replay scene-input ones bit for bit', async () => {
    const a = await run(spawnScene(true), SPAWN_CASE.end), b = await run(spawnScene(true), SPAWN_CASE.end, true);
    expect(b.at(-1)).toEqual(a.at(-1));
  });

  it('refuses a parent that is spawned at the same step, is removed before it, or does not exist, and a pinned child', async () => {
    const s = spawnScene(true), child = s.bodies[3]!;
    const bad = (inputs: SceneDesc['inputs']) => new AvbdReferenceEngine().init({ ...s, inputs });
    await expect(bad([{ step: 2, kind: 'spawn', body: child }, { step: 2, kind: 'spawn', body: child, from: { body: 5 } }])).rejects.toThrow(/does not exist at the start/);
    await expect(bad([{ step: 1, kind: 'remove', id: 0 }, { step: 2, kind: 'spawn', body: child, from: { body: 0 } }])).rejects.toThrow(/removed before/);
    await expect(bad([{ step: 2, kind: 'spawn', body: child, from: { body: 9 } }])).rejects.toThrow(/does not exist/);
    await expect(bad([{ step: 2, kind: 'spawn', body: child, from: { body: 0, axes: 'sideways' as 'body' } }])).rejects.toThrow(/axes/);
    // A pinned body is bolted to the world (engine-api pinned.ts): it is placed in world coordinates, never a parent's.
    await expect(bad([{ step: 2, kind: 'spawn', body: { ...child, pinned: true }, from: { body: 0 } }])).rejects.toThrow(/pinned and relative/);
    // The parent's removal at the same step, before or after, is fine: it reads the parent as the step starts.
    await expect(bad([{ step: 2, kind: 'remove', id: 0 }, { step: 2, kind: 'spawn', body: child, from: { body: 0 } }])).resolves.toBeUndefined();
    // Pushed late, events due at past steps share the next step's start: a parent spawned by one of them is not there yet.
    const e = new AvbdReferenceEngine();
    await e.init({ ...s, inputs: [] });
    for (let i = 0; i < 4; i++) e.step();
    expect(() => e.push([{ step: 1, kind: 'spawn', body: child }, { step: 2, kind: 'spawn', body: child, from: { body: 5 } }])).toThrow(/does not exist at the start/);
  });

  it('a burst whose offsets and velocities sum to zero over children of the parent\'s mass conserves its momentum', async () => {
    const r = await run(burstScene(), BURST_CASE.step + 1);
    expect(burstMomentumError(r[BURST_CASE.step]!, r[BURST_CASE.step + 1]!)).toBeLessThan(1e-14);
  });
});
