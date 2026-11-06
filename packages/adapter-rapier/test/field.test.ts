// Field events (engine-api field.ts, roadmap C7) on Rapier: the shared cases of @tb/testkit's field.ts. Rapier takes
// `iterations` substeps a step (4 by default), so its free flight is fieldFlight's with 4 substeps.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { FIELD_CASE, fieldErrors, fieldScene, TILT_CASE, tiltExpected, tiltResult, tiltScene } from '@tb/testkit';
import { RapierEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, restoreAt = -1): Promise<Snapshot[]> {
  const e = new RapierEngine();
  await e.init(scene);
  const out = [e.snapshot()];
  let cp = null;
  for (let i = 0; i < steps; i++) {
    if (i === restoreAt) cp = e.checkpoint();
    e.step();
    out.push(e.snapshot());
  }
  // Undo back to restoreAt and run again: the same end, with the gravity in force there restored.
  if (cp) {
    cp.restore();
    for (let i = restoreAt; i < steps; i++) e.step();
    out.push(e.snapshot());
  }
  e.dispose();
  return out;
}

describe('RapierEngine: field events', () => {
  it('free flight follows the gravity schedule and the kicks (4 substeps); pinned and removed bodies are not kicked, a body spawned after a kick is not', async () => {
    const r = fieldErrors(await run(fieldScene(), FIELD_CASE.end), 4);
    expect(r.pos).toBeLessThan(1e-4);
    expect(r.vel).toBeLessThan(1e-4);
    expect(r.counts.at(-1)).toBe(6);
  });

  it.for([[20, false], [40, false], [40, true]] as const)('a cube under gravity tilted %i degrees (sleep %s) sticks below the friction angle and slides at g (sin t - mu cos t) above it', async ([deg, sleep]) => {
    const s = await run(tiltScene(deg, sleep), TILT_CASE.end), r = tiltResult(s[TILT_CASE.at]!, s[TILT_CASE.end]!), want = tiltExpected(deg);
    // With sleep the cube had fallen asleep before the tilt, which woke it.
    expect(r.asleepAtTilt).toBe(sleep);
    if (want === 0) expect(Math.abs(r.slide)).toBeLessThan(0.005);
    else expect(Math.abs(r.slide - want) / want).toBeLessThan(0.05);
    expect(r.across).toBeLessThan(1e-4);
    expect(r.lift).toBeLessThan(0.005);
  });

  it('a checkpoint taken before a tilt, restored after it, replays it: the gravity in force there comes back', async () => {
    const s = await run(tiltScene(40), TILT_CASE.end, TILT_CASE.at - 40);
    expect(s.at(-1)!.pos[0]).toBeCloseTo(s[TILT_CASE.end]!.pos[0]!, 9);
  });
});
