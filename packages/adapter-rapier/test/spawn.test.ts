// Relative spawns (engine-api spawn.ts) on Rapier: the shared case of @tb/testkit's spawn.ts, to f32 rounding.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { BURST_CASE, burstMomentumError, burstScene, SPAWN_CASE, spawnErrors, spawnScene } from '@tb/testkit';
import { RapierEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number): Promise<{ snaps: Snapshot[]; substeps: number }> {
  const e = new RapierEngine();
  await e.init(scene);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  const substeps = e.info.integrator!.substeps;
  e.dispose();
  return { snaps: out, substeps };
}

describe('RapierEngine: relative spawns', () => {
  it('starts each child where relativeBody puts it from its parent as the step starts, and leaves every other body as it was', async () => {
    const base = await run(spawnScene(false), SPAWN_CASE.end), rel = await run(spawnScene(true), SPAWN_CASE.end);
    const r = spawnErrors(base.snaps, rel.snaps, rel.substeps);
    expect(r.children).toBe(5);
    expect(r.othersChanged).toEqual([]);
    // Rapier keeps state in f32: positions near 50 m to a few ulps.
    expect(r.pos).toBeLessThan(2e-5);
    expect(r.vel).toBeLessThan(2e-5);
    expect(r.rot).toBeLessThan(2e-6);
  });

  it('a burst whose offsets and velocities sum to zero over children of the parent\'s mass conserves its momentum (f32)', async () => {
    const r = (await run(burstScene(), BURST_CASE.step + 1)).snaps;
    expect(burstMomentumError(r[BURST_CASE.step]!, r[BURST_CASE.step + 1]!)).toBeLessThan(1e-6);
  });
});
