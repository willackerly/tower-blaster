// The opt-in lattice-preferred colouring (AvbdParams.colorMode) and largest-
// degree-first priority (colorPriority) on the GPU, the colours: the
// reference rule (physics-ref coloring.ts) on the GPU's own poses and graph,
// with and without the fallback colours. Off, the engine is the default.
// lattice-physics.test.ts, lattice-impact.test.ts and lattice-gates.test.ts
// run the trajectories.
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { GpuAvbdEngine } from '../src/index.ts';
import { call, gpu, impact, runGpu, squeezed } from './lattice-harness.ts';

describe('GPU AVBD engine: lattice colouring (AvbdParams.colorMode, colorPriority)', () => {
  it('the constructor checks both options, and they enter the variant only when on', () => {
    for (const bad of [{ colorMode: 5 }, { colorMode: 1.5 }, { colorMode: -1 }, { colorPriority: 2 }]) expect(() => new GpuAvbdEngine(bad)).toThrow(/^AvbdParams\.color(Mode|Priority) must be one of/);
    expect(new GpuAvbdEngine({ colorMode: 2, colorPriority: 1 }).info.variant).toMatchObject({ colorMode: 2, colorPriority: 1 });
    expect(new GpuAvbdEngine({}).info.variant).not.toHaveProperty('colorMode');
    expect(new GpuAvbdEngine({ colorMode: 0, colorPriority: 0 }).info.variant).toEqual(new GpuAvbdEngine({}).info.variant);
  });

  it('the colours are the reference rule\'s on the GPU\'s own poses and graph: every mode, at rest and through an impact', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const at = [1, 10, 20, 30, 37, 40, 50, 60, 80];
    for (const params of [{ colorMode: 1 }, { colorMode: 2 }, { colorMode: 3 }, { colorMode: 4 }, { colorPriority: 1 }, { colorMode: 2, colorPriority: 1 }, { colorMode: 4, colorPriority: 1 }] as const) {
      const r = await call('latticeRun', impact(), 80, params, {}, at);
      expect(r.error).toBeNull();
      for (const c of r.checks) {
        expect(c.mismatches, `${JSON.stringify(params)} step ${c.step}`).toBe(0);
        expect(c.uncolored).toBe(0);
        expect(c.overflow).toBe(0);
      }
      // The resting tower before the ball: every interior cube takes its pattern colour.
      const rest = r.checks.find((c) => c.step === 10)!;
      if (params.colorMode === 1) expect(rest.K).toBe(8);
      else if (params.colorMode) expect(rest.K).toBe(4);
      if (params.colorMode) expect(rest.tookPreference).toBe(rest.preferring);
    }
  });

  it('a squeezed block has contacts along both kernels: the fallback colours take them (mode 4: no preference there), still the reference rule', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const colorMode of [4]) {
      const r = await call('latticeRun', squeezed(), 3, { colorMode }, {}, [1, 3]);
      expect(r.error).toBeNull();
      for (const c of r.checks) {
        expect(c.mismatches).toBe(0);
        expect(c.pairs.inPlaneDiagonal).toBeGreaterThan(0);
        // Every cube here has an in-plane-diagonal neighbour of its 4-colour, so none prefers: the default rule.
        expect(c.preferring).toBe(0);
      }
    }
    for (const colorMode of [2, 3]) {
      const r = await call('latticeRun', squeezed(), 3, { colorMode }, {}, [1, 3]);
      expect(r.error).toBeNull();
      for (const c of r.checks) {
        expect(c.mismatches).toBe(0);
        expect(colorMode === 2 ? c.pairs.corner : c.pairs.inPlaneDiagonal).toBeGreaterThan(0);
        expect(c.fallback).toBeGreaterThan(0);
        expect(c.K).toBeLessThanOrEqual(8);
      }
    }
  });

  it('a resting lattice has no in-plane-diagonal or corner contacts, so the 4-colour patterns need no fallback (8x8x10, 60 steps)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('latticeRun', buildScenario('S1', { F: 8, H: 10, gap: 0 }, 1), 60, { colorMode: 2 }, {}, [5, 30, 60]);
    expect(r.error).toBeNull();
    for (const c of r.checks) {
      expect(c.pairs.face).toBeGreaterThan(0);
      expect(c.pairs.verticalDiagonal).toBeGreaterThan(0);
      expect(c.pairs.inPlaneDiagonal).toBe(0);
      expect(c.pairs.corner).toBe(0);
      expect(c.fallback).toBe(0);
      expect(c.K).toBe(4);
      expect(c.mismatches).toBe(0);
    }
  });

  it('given as 0, both options leave the engine bit-identical to the default', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const base = await runGpu(impact(), 45, {}, 15);
    const zero = await runGpu(impact(), 45, { colorMode: 0, colorPriority: 0 }, 15);
    expect(zero.snaps).toEqual(base.snaps);
    // And the option does change the order (so the tests below test something).
    const on = await runGpu(impact(), 45, { colorMode: 2 }, 15);
    expect(on.snaps).not.toEqual(base.snaps);
  });
});
