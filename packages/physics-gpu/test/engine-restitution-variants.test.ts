// Restitution (AvbdParams.restitution) with the other opt-in solver variants on
// the GPU (#72). The pass reads and resets points or exact records
// (src/restitution.ts; records 1 in engine-restitution-records.test.ts), so
// centre-friction records (2) refuse it. Lattice colouring (colorMode) changes
// only the colour order: the pass walks the contact graph's rows in slot order,
// and bounces as the reference does with the same colouring.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESTITUTION_COMBINE } from '@tb/engine-api';
import { AvbdSolver, DEFAULT_DISPATCH, GpuAvbdEngine, type RestitutionConfig, type SolverBuffers } from '../src/index.ts';
import { cube, G, gainOf, gpuRun, ON, refRun, type Run, sceneOf } from './bounce.ts';
import { gpu } from './harness.ts';

const CONFIG: RestitutionConfig = { threshold: 1, rounds: 8, groundRestitution: 0, combine: DEFAULT_RESTITUTION_COMBINE };

describe('GPU AVBD engine: restitution with records and colorMode', () => {
  it('is refused with records 2, in the engine and in the solver; records 0 and 1 build', () => {
    expect(() => new GpuAvbdEngine({ records: 2, restitution: true })).toThrow('GpuAvbdEngine: AvbdParams.restitution is not implemented with AvbdParams.records 2 on the GPU yet');
    expect(() => new GpuAvbdEngine({ records: 2, restitution: false })).not.toThrow();
    // The solver checks before it touches the device, so neither needs one here.
    expect(() => new AvbdSolver({} as GPUDevice, 1, 1, {} as SolverBuffers, DEFAULT_DISPATCH, 2, 0, CONFIG)).toThrow('AvbdSolver: restitution is not implemented with records 2 yet');
    expect(() => new GpuAvbdEngine({ records: 1, restitution: true })).not.toThrow();
    // The fused dual was removed (engine-variants.test.ts): with restitution too, it throws that.
    expect(() => new GpuAvbdEngine({ dualFusion: true, restitution: true } as never)).toThrow(/dualFusion \(the fused dual\) was removed after the M5 sweep/);
    expect(() => new GpuAvbdEngine({ records: 0, restitution: true })).not.toThrow();
    expect(new GpuAvbdEngine({ colorMode: 3, restitution: true }).info.variant).toMatchObject({ colorMode: 3, restitution: true });
  });

  // engine-restitution.test.ts's cube dropped flat onto two cubes (two bouncing pair manifolds, summed
  // through the contact graph's rows), with lattice colouring on both engines.
  it('with colorMode 3, a cube dropped flat onto two cubes moves as on the reference and gains no energy', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 0.9, scene = sceneOf([cube([-0.55, 0.5, 0], { e }), cube([0.55, 0.5, 0], { e }), cube([0, 1.5 + 25 / (2 * G), 0], { e })], { groundE: e });
    const params = { ...ON, colorMode: 3 };
    const r = { gpu: await gpuRun(scene, 240, params), ref: await refRun(scene, 240, params) };
    const up = (x: Run) => Math.max(...x.snaps.map((s) => s.linVel[7]!));
    expect(up(r.gpu)).toBeGreaterThan(3.8);
    expect(Math.abs(up(r.gpu) - up(r.ref))).toBeLessThan(1e-4);
    for (const k of [6, 7, 8]) expect(Math.abs(r.gpu.snaps[100]!.linVel[k]! - r.ref.snaps[100]!.linVel[k]!)).toBeLessThan(1e-4);
    expect(gainOf(scene, r.gpu).gain).toBeLessThan(1e-6);
  });
});
