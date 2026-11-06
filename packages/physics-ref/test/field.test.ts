// Field events (engine-api field.ts, roadmap C7) on the f64 reference: the shared cases of @tb/testkit's field.ts.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { FIELD_CASE, fieldErrors, fieldScene, TILT_CASE, tiltExpected, tiltResult, tiltScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(scene: SceneDesc, steps: number, push = false): Promise<Snapshot[]> {
  const e = new AvbdReferenceEngine();
  await e.init(push ? { ...scene, inputs: [] } : scene);
  if (push) e.push(scene.inputs);
  const out = [e.snapshot()];
  for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
  return out;
}

describe('AVBD reference: field events', () => {
  it('free flight follows the gravity schedule and the kicks exactly (semi-implicit Euler); pinned and removed bodies are not kicked, a body spawned after a kick is not', async () => {
    const r = fieldErrors(await run(fieldScene(), FIELD_CASE.end), 1);
    expect(r.pos).toBeLessThan(1e-9);
    expect(r.vel).toBeLessThan(1e-9);
    expect(r.counts.at(-1)).toBe(6);
  });

  it('pushed field events replay scene-input ones bit for bit', async () => {
    const [a, b] = [await run(fieldScene(), FIELD_CASE.end), await run(fieldScene(), FIELD_CASE.end, true)];
    expect(b.at(-1)!.pos).toEqual(a.at(-1)!.pos);
    expect(b.at(-1)!.linVel).toEqual(a.at(-1)!.linVel);
  });

  it.for([20, 40])('a cube under gravity tilted %i degrees sticks below the friction angle and slides at g (sin t - mu cos t) above it', async (deg) => {
    const s = await run(tiltScene(deg), TILT_CASE.end), r = tiltResult(s[TILT_CASE.at]!, s[TILT_CASE.end]!), want = tiltExpected(deg);
    if (want === 0) expect(Math.abs(r.slide)).toBeLessThan(0.005);
    else expect(Math.abs(r.slide - want) / want).toBeLessThan(0.05);
    expect(r.across).toBeLessThan(1e-6);
    expect(r.lift).toBeLessThan(0.005);
  });
});
