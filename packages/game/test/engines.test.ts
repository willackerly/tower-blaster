import { describe, expect, it } from 'vitest';
import { compileLevel, L1, L4 } from '@tb/keystone';
import { engineKind, GPU_ITERATIONS, gpuOptions, makeEngine } from '../src/engines.ts';

describe('engine choice', () => {
  it('defaults to Rapier, accepts gpu, and names the choices for anything else', () => {
    expect(engineKind(null)).toBe('rapier');
    expect(engineKind('')).toBe('rapier');
    expect(engineKind('gpu')).toBe('gpu');
    expect(() => engineKind('physx')).toThrow(/unknown engine physx: use rapier or gpu/);
  });
  it('the GPU engine runs 20 iterations with one substep (no device needed to build it)', () => {
    const e = makeEngine('gpu', compileLevel(L1));
    expect(e.info.variant.iterations).toBe(GPU_ITERATIONS);
    expect(e.info.integrator?.substeps).toBe(1);
    expect(makeEngine('rapier', compileLevel(L1)).info.name).toBe('rapier');
  });
  it('reserves a slot per rack item and room for the largest ammo', () => {
    const c1 = compileLevel(L1), h = c1.frame.unit;
    expect(gpuOptions(c1)).toEqual({ capacity: c1.meta.n + c1.def.rack.length, maxRadius: 0.5 * h }); // cannonballs
    const c4 = compileLevel(L4);
    expect(c4.def.rack).toContain('drop');
    expect(gpuOptions(c4).maxRadius).toBeCloseTo(Math.sqrt(3) * 0.4 * c4.frame.unit, 12); // the anvil's corner
  });
});
