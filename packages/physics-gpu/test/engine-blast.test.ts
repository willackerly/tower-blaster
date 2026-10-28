// Blasts (engine-api blast.ts) on the GPU engine: the shared case of
// @tb/testkit's blast.ts in f32, and a blast inside a block of cubes on the
// ground against the f64 reference.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, SceneDesc, Snapshot } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { BLAST_CASE, blastErrors, blastScene } from '@tb/testkit';
import { cube, gpu, runGpu, sceneOf } from './harness.ts';

describe('GPU AVBD engine: blasts', () => {
  it('changes exactly the velocities blastKick gives, to f32 rounding, and nothing else', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const at = BLAST_CASE.step;
    const base = await runGpu(blastScene(false), at + 1, {}, 1), blasted = await runGpu(blastScene(true), at + 1, {}, 1);
    const r = blastErrors(base.all[at]!, base.all[at + 1]!, blasted.all[at + 1]!);
    expect(r.relErr).toBeLessThan(1e-5);
    expect(r.untouchedChanged).toEqual([]);
  });

  // A 6 x 4 x 6 block of unit cubes on the ground, a blast at its side, one
  // course up. Contacts pass the push on, so the comparison is statistical:
  // the reference and the GPU fling the same cubes about as far.
  it('a blast in a block of cubes moves it as the reference does', { timeout: 180_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const bodies: BodyDesc[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) bodies.push(cube([x - 2.5, 0.5 + y, z - 2.5]));
    const settle = 60, after = 30;
    const scene: SceneDesc = { ...sceneOf(bodies), inputs: [{ step: settle, kind: 'blast', blast: { centre: [-3.2, 1.5, 0], radius: 4, impulse: 12 } }] };
    const ref = new AvbdReferenceEngine({ iterations: 10 });
    await ref.init(scene);
    for (let i = 0; i < settle + after; i++) ref.step();
    const r = ref.snapshot();
    const g = (await runGpu(scene, settle + after, { iterations: 10 }, 5)).s1; // every 5 steps: no pair overflow while bodies fly
    const moved = (s: Snapshot) => bodies.map((b, i) => Math.hypot(s.pos[3 * i]! - b.pos[0], s.pos[3 * i + 1]! - b.pos[1], s.pos[3 * i + 2]! - b.pos[2]));
    const mr = moved(r), mg = moved(g);
    const far = (m: number[]) => m.filter((d) => d > 0.5).length;
    const ke = (s: Snapshot) => bodies.reduce((a, _, i) => a + 0.5 * (s.linVel[3 * i]! ** 2 + s.linVel[3 * i + 1]! ** 2 + s.linVel[3 * i + 2]! ** 2), 0);
    console.log(`blast block: moved > 0.5 m ref ${far(mr)} gpu ${far(mg)}; max ${Math.max(...mr).toFixed(3)} / ${Math.max(...mg).toFixed(3)} m; KE ${ke(r).toFixed(2)} / ${ke(g).toFixed(2)} J; per-body |d| diff max ${Math.max(...mr.map((d, i) => Math.abs(d - mg[i]!))).toFixed(4)} m`);
    expect(far(mr)).toBeGreaterThan(5);
    expect(Math.abs(far(mg) - far(mr))).toBeLessThanOrEqual(Math.max(2, 0.1 * far(mr)));
    expect(Math.max(...mg) / Math.max(...mr)).toBeGreaterThan(0.8);
    expect(Math.max(...mg) / Math.max(...mr)).toBeLessThan(1.25);
  });
});
