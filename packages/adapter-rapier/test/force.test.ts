// Forces (engine-api force.ts) on Rapier: the shared case of @tb/testkit's force.ts, to f32 rounding; the held
// pull on a sleeping column; and a checkpoint taken while forces act replays bit for bit.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { FORCE_CASE, forceErrors, forceScene, PULL_CASE, pullScene } from '@tb/testkit';
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

describe('RapierEngine: forces', () => {
  it('each step is free flight from the step before plus the force\'s kick h F / m; bodies never forced stay as they were', async () => {
    const base = await run(forceScene(false), FORCE_CASE.end), forced = await run(forceScene(true), FORCE_CASE.end);
    const r = forceErrors(base.snaps, forced.snaps, forced.substeps);
    expect(r.forced).toBe(48);
    expect(r.controlChanged).toEqual([]);
    expect(r.firstDiff).toBe(FORCE_CASE.start + 1);
    // Rapier keeps state in f32: positions near 50 m to a few ulps.
    expect(r.pos).toBeLessThan(2e-5);
    expect(r.vel).toBeLessThan(2e-5);
    expect(r.rot).toBeLessThan(2e-6);
  });

  it('a held pull wakes the sleeping column, drags the middle cube out, and the cube above it falls', async () => {
    const { rest, hold, press } = PULL_CASE;
    const r = (await run(pullScene(), rest + hold + press + 360)).snaps, at = r[rest]!, end = r[rest + hold]!;
    expect([...at.awake]).toEqual([0, 0, 0]);
    expect(Math.abs(at.pos[7]! - 2.5)).toBeLessThan(0.01);
    expect(r[rest + 2]!.awake[2]).toBe(1);
    expect(Math.hypot(end.pos[3]! - PULL_CASE.target[0], end.pos[5]! - PULL_CASE.target[2])).toBeLessThan(0.1);
    expect(end.pos[7]!).toBeLessThan(1.6);
    // Held, pressed still onto the ground, it does not fall asleep while the force acts; let go, it does.
    const pressed = r[rest + hold + press]!;
    // Rapier's soft contacts leave it creeping a few cm/s under the press.
    expect(Math.hypot(pressed.linVel[3]!, pressed.linVel[4]!, pressed.linVel[5]!)).toBeLessThan(0.05);
    for (let k = rest + 1; k <= rest + hold + press; k++) expect(r[k]!.awake[1], `step ${k}`).toBe(1);
    expect(r.at(-1)!.awake[1]).toBe(0);
  });

  it('a checkpoint taken while forces act replays the rest bit for bit', async () => {
    const e = new RapierEngine();
    await e.init(forceScene(true));
    for (let i = 0; i < FORCE_CASE.start + 4; i++) e.step();
    const cp = e.checkpoint(), first: Snapshot[] = [];
    for (let i = 0; i < 6; i++) { e.step(); first.push(e.snapshot()); }
    cp.restore();
    for (let i = 0; i < 6; i++) { e.step(); expect(e.snapshot()).toEqual(first[i]); }
    cp.dispose();
    e.dispose();
  });
});
