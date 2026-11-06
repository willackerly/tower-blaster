// Forces (engine-api force.ts) on the f64 reference: the shared case of @tb/testkit's force.ts.
import { describe, expect, it } from 'vitest';
import { MAX_FORCED, type InputEvent, type SceneDesc, type Snapshot } from '@tb/engine-api';
import { FORCE_CASE, forceErrors, forceScene, PULL_CASE, pullScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, push = false): Promise<Snapshot[]> {
  const e = new AvbdReferenceEngine();
  await e.init(push ? { ...scene, inputs: [] } : scene);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) {
    // Pushed at their own step, just before it runs: what a game does.
    if (push) { const due = scene.inputs.filter((ev) => ev.step === i); if (due.length) e.push(due); }
    e.step();
    out.push(e.snapshot());
  }
  return out;
}

describe('AVBD reference: forces', () => {
  it('each step is free flight from the step before plus the force\'s kick h F / m; bodies never forced stay bit for bit as they were', async () => {
    const base = await run(forceScene(false), FORCE_CASE.end), forced = await run(forceScene(true), FORCE_CASE.end);
    const r = forceErrors(base, forced, 1);
    // Steps 3 to 15: body 0 for 3 + 5 (thrust, then vibration), 1 for 8, 2 for 10, 3 for 6 (ended), 4 for 13, 6 for 3 (removed).
    expect(r.forced).toBe(48);
    expect(r.controlChanged).toEqual([]);
    expect(r.firstDiff).toBe(FORCE_CASE.start + 1);
    expect(r.pos).toBeLessThan(1e-12);
    expect(r.vel).toBeLessThan(1e-12);
    expect(r.rot).toBeLessThan(1e-12);
  });

  it('pushed force events replay scene-input ones bit for bit', async () => {
    const a = await run(forceScene(true), FORCE_CASE.end), b = await run(forceScene(true), FORCE_CASE.end, true);
    expect(b.at(-1)).toEqual(a.at(-1));
  });

  it('refuses a force on a body that does not exist or is removed, a malformed one, and more than MAX_FORCED forced bodies', async () => {
    const s = forceScene(false);
    const bad = (inputs: InputEvent[]) => new AvbdReferenceEngine().init({ ...s, inputs });
    const thrust = { steps: 10, thrust: [0, 1, 0] as [number, number, number] };
    await expect(bad([{ step: 2, kind: 'force', id: 6, force: thrust }])).rejects.toThrow(/does not exist/);
    await expect(bad([{ step: 1, kind: 'remove', id: 0 }, { step: 2, kind: 'force', id: 0, force: thrust }])).rejects.toThrow(/removed/);
    await expect(bad([{ step: 2, kind: 'force', id: 0, force: { steps: 0, thrust: [0, 1, 0] } }])).rejects.toThrow(/steps/);
    await expect(bad([{ step: 2, kind: 'force', id: 0, force: { steps: 3, pull: [0, 1, 0], stiffness: -1 } }])).rejects.toThrow(/stiffness/);
    await expect(bad([{ step: 2, kind: 'force', id: 0, force: { steps: 3, thrust: [0, 1, 0], period: 1 } as never }])).rejects.toThrow(/unknown keys/);
    // A spawn and a force on it in one step is fine (a rocket), as is a force and the removal that ends it.
    await expect(bad([{ step: 2, kind: 'spawn', body: s.bodies[0]! }, { step: 2, kind: 'force', id: 6, force: thrust }, { step: 4, kind: 'remove', id: 6 }])).resolves.toBeUndefined();
    // MAX_FORCED bodies at once are fine; one more is not, but it is once one has ended.
    const many: SceneDesc = { ...s, bodies: Array.from({ length: MAX_FORCED + 1 }, (_, i) => ({ ...s.bodies[5]!, pos: [2 * i, 80, 0] })), inputs: [] };
    const all = (n: number, step: number, steps: number): InputEvent[] => Array.from({ length: n }, (_, i) => ({ step, kind: 'force', id: i, force: { steps, thrust: [0, 1, 0] } }));
    await expect(new AvbdReferenceEngine().init({ ...many, inputs: all(MAX_FORCED, 2, 5) })).resolves.toBeUndefined();
    await expect(new AvbdReferenceEngine().init({ ...many, inputs: [...all(MAX_FORCED, 2, 5), { step: 6, kind: 'force', id: MAX_FORCED, force: thrust }] })).rejects.toThrow(/MAX_FORCED/);
    await expect(new AvbdReferenceEngine().init({ ...many, inputs: [...all(MAX_FORCED, 2, 5), { step: 7, kind: 'force', id: MAX_FORCED, force: thrust }] })).resolves.toBeUndefined();
    // Pushed: the forces already acting count.
    const e = new AvbdReferenceEngine();
    await e.init({ ...many, inputs: all(MAX_FORCED, 0, 100) });
    e.step();
    expect(() => e.push([{ step: 3, kind: 'force', id: MAX_FORCED, force: thrust }])).toThrow(/MAX_FORCED/);
    expect(() => e.push([{ step: 3, kind: 'force', id: 0, force: null }, { step: 3, kind: 'force', id: MAX_FORCED, force: thrust }])).not.toThrow();
  });

  it('a held pull drags the middle cube of a column out, and the cube above it falls', async () => {
    const r = await run(pullScene(), PULL_CASE.rest + PULL_CASE.hold), at = r[PULL_CASE.rest]!, end = r.at(-1)!;
    // At rest before the pull: the column stands.
    expect(Math.abs(at.pos[4]! - 1.5)).toBeLessThan(0.01);
    expect(Math.abs(at.pos[7]! - 2.5)).toBeLessThan(0.01);
    // The middle cube is held near the point (it sags under its weight), the top one has fallen by a cube or more.
    expect(Math.hypot(end.pos[3]! - PULL_CASE.target[0], end.pos[5]! - PULL_CASE.target[2])).toBeLessThan(0.1);
    expect(end.pos[7]!).toBeLessThan(1.6);
  });
});
