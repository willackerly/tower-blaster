import { describe, expect, it } from 'vitest';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, L1, L4 } from '@tb/keystone';
import { engineKind, gpuOptions, makeEngine } from '../src/engines.ts';

describe('engine choice', () => {
  it('defaults to the GPU solver, accepts rapier, and names the choices for anything else', () => {
    expect(engineKind(null)).toBe('gpu');
    expect(engineKind('')).toBe('gpu');
    expect(engineKind('rapier')).toBe('rapier');
    expect(engineKind('gpu')).toBe('gpu');
    expect(() => engineKind('physx')).toThrow(/unknown engine physx: use rapier or gpu/);
  });
  it('the GPU engine runs at the settings par lines are pinned at, with one substep (no device needed to build it)', () => {
    const e = makeEngine('gpu', compileLevel(L1));
    expect(e.info.variant).toMatchObject({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
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
