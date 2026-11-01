import { describe, expect, it } from 'vitest';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, L1, L4, LEVELS } from '@tb/keystone';
import { everyPairPerBody } from '@tb/physics-gpu';
import type { EngineHealth, EngineLimit } from '@tb/engine-api';
import { driverOptions, engineKind, gpuOptions, makeEngine, roomAfter } from '../src/engines.ts';

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
  it('pipelines the read-back on the GPU engine only (its step() only submits)', () => {
    expect(driverOptions('gpu')).toEqual({ pipelined: true });
    expect(driverOptions('rapier')).toEqual({ pipelined: false });
  });
  it('reserves a slot per rack item and room for the largest ammo', () => {
    const c1 = compileLevel(L1), h = c1.frame.unit;
    const capacity = c1.meta.n + c1.def.rack.length;
    expect(gpuOptions(c1)).toEqual({ capacity, maxRadius: 0.5 * h, pairsPerBody: everyPairPerBody(capacity) }); // cannonballs
    const c4 = compileLevel(L4);
    expect(c4.def.rack).toContain('drop');
    expect(gpuOptions(c4).maxRadius).toBeCloseTo(Math.sqrt(3) * 0.4 * c4.frame.unit, 12); // the anvil's corner
  });
  it('sizes the pair buffer for every pair of the level\'s bodies and rack, in live play and replay alike', () => {
    for (const def of LEVELS) {
      const c = compileLevel(def), o = gpuOptions(c);
      expect(o.pairsPerBody * o.capacity, def.id).toBeGreaterThanOrEqual((o.capacity * (o.capacity - 1)) / 2);
      // makeEngine builds live play's engine and replay()'s: both take it.
      expect(makeEngine('gpu', c).info.variant, def.id).toMatchObject({ capacity: o.capacity, pairsPerBody: o.pairsPerBody });
    }
  });
  it('takes a given pair room in place of every pair (a later round of a level that dropped pairs)', () => {
    const c = compileLevel(L1), o = gpuOptions(c);
    expect(gpuOptions(c, 40)).toEqual({ ...o, pairsPerBody: 40 });
    expect(gpuOptions(c, 2).pairsPerBody).toBe(2);
    expect(makeEngine('gpu', c, undefined, 40).info.variant).toMatchObject({ pairsPerBody: 40 });
  });
});

describe('the pair room after a round (roomAfter)', () => {
  const pairs = (o: Partial<EngineLimit>): EngineHealth => ({ steps: 300, limits: [{ id: 'pairs', effect: 'physics', steps: 0, peak: 200, room: 880, message: 'pair buffer', ...o }] });
  it('grows to the engine\'s fix when the round dropped pairs, and never shrinks', () => {
    expect(roomAfter(20, pairs({ steps: 3, peak: 1000, fix: { option: 'pairsPerBody', value: 32 } }))).toBe(32);
    // A fix below the room in use (a round built with more than it needed) keeps the room.
    expect(roomAfter(40, pairs({ steps: 3, fix: { option: 'pairsPerBody', value: 32 } }))).toBe(40);
  });
  it('keeps the room when nothing was dropped, no fix is known, or the engine has no limits', () => {
    expect(roomAfter(20, pairs({ steps: 0, fix: { option: 'pairsPerBody', value: 32 } }))).toBe(20);
    expect(roomAfter(20, pairs({ steps: 3 }))).toBe(20); // the device holds no buffer that fits
    expect(roomAfter(20, pairs({ steps: 3, fix: { option: 'boxBroadphase', value: true } }))).toBe(20);
    expect(roomAfter(20, pairs({ steps: 3, effect: 'speed', fix: { option: 'pairsPerBody', value: 32 } }))).toBe(20);
    expect(roomAfter(20, { steps: 300, limits: [{ id: 'colours', effect: 'physics', steps: 3, peak: 70, room: 64, message: 'c', fix: { option: 'pairsPerBody', value: 32 } }] })).toBe(20);
    expect(roomAfter(20, null)).toBe(20);
  });
});
