import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, CpuObserver, L1, L4, type LevelDef, type OutcomeScore, Session } from '@tb/keystone';
import { driverOptions, engineKind, gpuEngineOptions, gpuOptions, gpuParams, makeEngine } from '../src/engines.ts';
import { levelRules, withRules } from '../src/params.ts';

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
    expect(gpuOptions(c1)).toEqual({ capacity: c1.meta.n + c1.def.rack.length, maxRadius: 0.5 * h }); // cannonballs
    const c4 = compileLevel(L4);
    expect(c4.def.rack).toContain('drop');
    expect(gpuOptions(c4).maxRadius).toBeCloseTo(Math.sqrt(3) * 0.4 * c4.frame.unit, 12); // the anvil's corner
  });
});

describe('the level\'s physics block reaches the engine', () => {
  it('iterations, slop and Bounce reach the GPU params; the pair buffer its options', () => {
    expect(gpuParams(compileLevel(L1))).toEqual({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
    const c = compileLevel({ ...L1, physics: { iterations: 20, gapSlop: 0, bounce: 0.3, pairsPerBody: 24 } });
    expect(gpuParams(c)).toEqual({ iterations: 20, gapSlop: 0, restitution: true });
    expect(gpuEngineOptions(c)).toEqual({ ...gpuOptions(c), pairsPerBody: 24 });
    expect(gpuEngineOptions(compileLevel(L1))).toEqual(gpuOptions(compileLevel(L1)));
    const v = makeEngine('gpu', c).info.variant as Record<string, unknown>;
    expect(v.iterations).toBe(20);
    expect(v.gapSlop ?? 0).toBe(0); // off: the variant leaves it out
  });
  it('an override from the URL marks the level custom: the session records no cast stars', () => {
    const cast = { ...L1, scoring: 'outcome' as const, stars: { metric: 'collapse' as const, t2: 0, t3: 0 } };
    const play = (def: LevelDef) => {
      const c = compileLevel(def), s = emptySnapshot(c.meta.n + 1);
      s.pos.set(c.meta.home);
      for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
      const se = new Session(c), obs = new CpuObserver(c, s);
      se.fire(L1.solutions!.par![0]!, 0);
      for (let t = 1; t <= 60; t++) se.observe(obs.observe(s, t, se.watchIdx)); // a quiet miss: D = 0, met (min 0)
      se.bank(61);
      return se.score as OutcomeScore;
    };
    const asCast = play({ ...cast, objective: { kind: 'collapse', min: 0 } });
    expect(asCast.outcome).toMatchObject({ uncast: false });
    expect(asCast.stars).toBe(3); // D 0 at thresholds 0
    const custom = play(withRules({ ...cast, objective: { kind: 'collapse', min: 0 } }, levelRules(new URLSearchParams('?keystone.iterations=20'))));
    expect(custom.outcome).toMatchObject({ uncast: true });
    expect(custom.stars).toBe(1);
  });
});
