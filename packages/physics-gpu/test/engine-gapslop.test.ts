// The GPU AVBD engine with the loaded-gap slop (AvbdParams.gapSlop, opt-in;
// the header of physics-ref/src/avbd.ts says why), the cases of the
// reference's own tests (physics-ref/test/avbd.test.ts): off it is the engine
// as before, on it brings the sideways-kicked column back to rest, it leaves
// rolling contacts and unloaded points alone (spheres without rollingContacts
// get it), and a lifted stack or cube rests on the excused gap and comes down
// as on the reference. The kicked column coming back to rest:
// engine-gapslop-column.test.ts (its own file, for CI's shards). With manifold
// records (AvbdParams.records):
// engine-gapslop-records.test.ts and engine-gapslop-records-rest.test.ts. Its
// checks and variant keys are in engine.test.ts. Unloaded points and the lifted stack and cube:
// engine-gapslop-lifted.test.ts.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type SceneDesc } from '@tb/engine-api';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { column, kicked, poked, sideways, state } from './gapslop-case.ts';
import { cube, gpu, sceneOf } from './harness.ts';

describe('GPU AVBD engine: the loaded-gap slop (AvbdParams.gapSlop)', () => {
  // The slop is a pipeline constant (solver.ts), passed only while it is on, so off the pipelines are built as
  // before. The default runs records 1 and the array form points, the same floats (records.test.ts). On
  // SwiftShader, absent or 0, the engine gave the same floats as at 9c1ed93 (before the port) on this
  // case, at 20 iterations and with the array Hessian, and on a 3x3x8 tower, a ball knocking down two towers (S5),
  // the ball stack below and S13 leaning 2 deg (2026-10-27). On, 96 of the 104 floats here differ. The constant
  // goes to the setup, primal, tail and dual kernels; with colorTail 0 the tail sweeps every colour, and the array
  // form is another primal shader, so the last run fails if one of them is built without it.
  it('absent or 0 it is the same floats; on, it changes them alike in every primal dispatch and Hessian form', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const off = await kicked({});
    expect(await kicked({ gapSlop: 0 })).toEqual(off);
    const on = await kicked({ gapSlop: 3e-5 });
    expect(on).not.toEqual(off);
    expect(await kicked({ gapSlop: 3e-5 }, column(), { colorTail: 0, hessian: 'array' })).toEqual(on);
  });

  // The lattice colouring (colorMode) only reorders the bodies: with the slop on it still changes the floats.
  it('with the lattice colouring it acts', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    expect(await kicked({ gapSlop: 3e-5, colorMode: 3 })).not.toEqual(await kicked({ colorMode: 3 }));
  });

  it('it leaves rolling contacts alone, and spheres without rollingContacts get it: a ball on a cube on a ball, kicked', { timeout: 400_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const ball = (y: number): BodyDesc => ({ ...cube([0, y, 0]), shape: { kind: 'sphere', radius: 0.5 } });
    const balls = sceneOf([ball(0.5), cube([0, 1.5, 0]), ball(2.5)]);
    // Every contact rolls (rollingContacts is on by default): the same floats.
    expect(await kicked({ gapSlop: 3e-5 }, balls)).toEqual(await kicked({}, balls));
    // Without rollingContacts the same contacts are plain points and get it, so the gate is rollingContacts and
    // not the shape. Kicked before step 101 instead, to keep it short: 50 steps on, 39 of the 39 floats differ
    // (2026-10-27; 39 of 39 too at 450 steps, here and on the reference).
    const plain = async (params: Partial<AvbdParams>) => state((await poked(balls, 150, { rollingContacts: false, ...params }, { at: 100, dv: sideways(3) })).final);
    expect(await plain({ gapSlop: 3e-5 })).not.toEqual(await plain({}));
  });
});
