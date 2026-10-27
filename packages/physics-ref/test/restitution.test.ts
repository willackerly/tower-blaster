// Opt-in restitution (AvbdParams.restitution): off, it changes nothing.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type CombineRule, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { AvbdReferenceEngine, type AvbdParams, DEFAULT_AVBD, RESTITUTION_DEFAULTS } from '../src/index.ts';

const G = 9.81, H = 1 / 60;
const ON: Partial<AvbdParams> = { restitution: true };
/** A scene on a ground of restitution groundE (undefined: unset, 0), or in zero g with no ground. */
const sceneOf = (bodies: BodyDesc[], o: { gravity?: Vec3; ground?: boolean; groundE?: number; friction?: number; rule?: CombineRule } = {}): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity: o.gravity ?? [0, -G, 0], dt: H,
  ground: o.ground === false ? null : { y: 0, friction: o.friction ?? 0.6, ...(o.groundE !== undefined ? { restitution: o.groundE } : {}) },
  sleep: false, ...(o.rule ? { restitutionCombine: o.rule } : {}), bodies, inputs: [],
});
/** Every body's (and spawned body's) restitution set to e. */
const withE = (s: SceneDesc, e: number): SceneDesc => ({ ...s, bodies: s.bodies.map((b) => ({ ...b, restitution: e })), inputs: s.inputs.map((ev) => ({ ...ev, body: { ...ev.body, restitution: e } })) });
const knock = (speed: number) => buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio: 5, radius: 0.6 }, 1);
const state = (e: AvbdReferenceEngine) => { const s = e.snapshot(); return [...s.pos, ...s.rot, ...s.linVel, ...s.angVel]; };

describe('restitution off (the default)', () => {
  it('is not in DEFAULT_AVBD, and off the engine variant lists no restitution key; on, it lists the switch and every default', () => {
    expect(Object.keys(DEFAULT_AVBD).some((k) => k.startsWith('restitution'))).toBe(false);
    const keys = Object.keys(new AvbdReferenceEngine().info.variant);
    expect(Object.keys(new AvbdReferenceEngine({ restitution: false, restitutionThreshold: 3, restitutionRounds: 2 }).info.variant)).toEqual(keys);
    expect(keys.some((k) => k.startsWith('restitution'))).toBe(false);
    expect(new AvbdReferenceEngine(ON).info.variant).toMatchObject({ restitution: true, ...RESTITUTION_DEFAULTS });
    expect(new AvbdReferenceEngine({ ...ON, restitutionRounds: 3 }).info.variant).toMatchObject({ restitutionThreshold: RESTITUTION_DEFAULTS.restitutionThreshold, restitutionRounds: 3 });
  });

  it('checks its params and the ground\'s restitution: threshold finite and >= 0, rounds an integer >= 1, ground restitution in [0, 1]', async () => {
    for (const t of [-0.1, NaN, Infinity]) expect(() => new AvbdReferenceEngine({ restitutionThreshold: t })).toThrow(`restitutionThreshold must be a finite number >= 0, got ${t}`);
    for (const r of [0, 2.5, -1, NaN]) expect(() => new AvbdReferenceEngine({ ...ON, restitutionRounds: r })).toThrow(`restitutionRounds must be an integer >= 1, got ${r}`);
    expect(() => new AvbdReferenceEngine({ ...ON, restitutionThreshold: 0, restitutionRounds: 1 })).not.toThrow();
    for (const g of [-0.1, 1.5, NaN]) await expect(new AvbdReferenceEngine().init(sceneOf([], { groundE: g }))).rejects.toThrow(`ground.restitution must be in [0, 1], got ${g}`);
    await expect(new AvbdReferenceEngine().init(sceneOf([], { groundE: 1 }))).resolves.toBeUndefined();
  });

  it('ignores BodyDesc.restitution, the ground\'s and the combine rule: a knockdown of bodies with e 0.9 is bit-identical to one with e 0', async () => {
    const run = async (e: number, params: Partial<AvbdParams>) => {
      const s = withE(knock(15), e);
      const eng = new AvbdReferenceEngine(params);
      await eng.init(e ? { ...s, ground: { ...s.ground!, restitution: e }, restitutionCombine: 'max' } : s);
      for (let k = 0; k < 60; k++) eng.step();
      return state(eng);
    };
    const base = await run(0, {});
    expect(await run(0.9, {})).toEqual(base);
    expect(await run(0.9, { restitution: false })).toEqual(base);
  });
});
