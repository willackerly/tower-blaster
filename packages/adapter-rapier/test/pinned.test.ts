// Pinned bodies (engine-api pinned.ts, roadmap C8) on Rapier: the shared cases of @tb/testkit's pinned.ts. A pinned
// body is a Rapier fixed body.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { PIN_CASE, PIN_SLIDE_CASE, pinErrors, pinScene, pinSlideErrors, pinSlideScene } from '@tb/testkit';
import { RapierEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number): Promise<Snapshot[]> {
  const e = new RapierEngine();
  await e.init(scene);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  e.dispose();
  return out;
}

describe('RapierEngine: pinned bodies', () => {
  it('holds a pinned body where it was given, at rest and not awake, under a load, a ball and a blast; a removed pin drops its load', async () => {
    const r = pinErrors(await run(pinScene(), PIN_CASE.end));
    // Rapier holds a fixed body's pose in f32.
    expect(r.pinMoved).toBeLessThan(1e-6);
    expect(r.pinSpeed).toBe(0);
    expect(r.pinAwake).toEqual([]);
    expect(r.droppedRests).toBe(true);
    expect(r.cubeDrop).toBeCloseTo(2.5, 1);
  });

  it('a cube slides on a pinned slab as on the ground plane at the slab\'s height', async () => {
    const r = pinSlideErrors(await run(pinSlideScene(true), PIN_SLIDE_CASE.end), await run(pinSlideScene(false), PIN_SLIDE_CASE.end));
    expect(r.path).toBeGreaterThan(1);
    expect(r.diff).toBeLessThan(0.01 + 0.01 * r.path);
  });
});
