// The GPU AVBD engine in a world of smaller cubes (the viewer's scale knob):
// stronger gravity with froudeParams is the unit world played faster.
import { describe, expect, it } from 'vitest';
import type { BodyDesc } from '@tb/engine-api';
import { froudeParams } from '@tb/physics-ref';
import { cube, G, gpu, runGpu, sceneOf } from './harness.ts';

describe('GPU AVBD engine: world scale (the viewer\'s scale knob, froudeParams)', () => {
  // physics-ref/test/avbd.test.ts has the f64 version, exact to the bit: 4 g
  // at the viewer's step with froudeParams(4) is the unit world at twice the
  // step, its speeds doubled. In f32 the GPU's divisions and square roots
  // need not round alike, so it holds to rounding: a 2x2x4 tower with a
  // turned cube on top, a cube sliding to a stop and a tilted cube dropped
  // onto an edge (no chaotic tumbling: a 1-ulp nudge of the slide moves
  // things 1.4 um). Measured on SwiftShader: 25 um apart after 90 steps;
  // 1.9 mm without froudeParams (4 g, the unit world's penalties).
  const bodies = (vs: number): BodyDesc[] => {
    const out: BodyDesc[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) out.push(cube([x - 0.5, 0.5 + y, z - 0.5]));
    out.push({ ...cube([0, 4.6, 0]), rot: [0, Math.sin(0.3), 0, Math.cos(0.3)] });
    out.push(cube([-4, 0.5, 4], [6 * vs, 0, 0]));
    out.push({ ...cube([5, 2.5, 0]), rot: [Math.sin(0.2), 0, 0, Math.cos(0.2)] });
    return out;
  };
  it('4 g at dt with froudeParams(4) is 1 g at 2 dt, twice as fast, to rounding; without it, not', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const slow = await runGpu({ ...sceneOf(bodies(1)), dt: 2 / 60 }, 45);
    const fast = await runGpu({ ...sceneOf(bodies(2), [0, -4 * G, 0]), dt: 1 / 60 }, 90, froudeParams({}, 4));
    const plain = await runGpu({ ...sceneOf(bodies(2), [0, -4 * G, 0]), dt: 1 / 60 }, 90);
    const dmax = (a: Float32Array | Float64Array, b: Float32Array | Float64Array, k = 1) => Math.max(...[...a].map((x, i) => Math.abs(x - k * b[i]!)));
    expect(dmax(slow.s1.pos, slow.s0.pos)).toBeGreaterThan(1); // the slide went somewhere
    expect(dmax(fast.s1.pos, slow.s1.pos)).toBeLessThan(1e-4);
    expect(dmax(fast.s1.linVel, slow.s1.linVel, 2)).toBeLessThan(1e-3);
    expect(dmax(fast.s1.angVel, slow.s1.angVel, 2)).toBeLessThan(1e-3);
    expect(dmax(plain.s1.pos, slow.s1.pos)).toBeGreaterThan(10 * dmax(fast.s1.pos, slow.s1.pos));
  });
});
