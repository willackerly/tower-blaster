// The per-level physics block (docs/game/spectacle-mode.md, section 8, G2.5):
// resolved against Keystone's defaults, checked, part of the level hash (with
// defaults written out hashing as absent), Bounce compiled into the scene, the
// pre-settle run by the driver, and cast stars only on the level they were cast for.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type EngineInfo, type PhysicsEngine, type SceneDesc } from '@tb/engine-api';
import {
  AVBD_GAP_SLOP, AVBD_ITERATIONS, castStars, checkPhysics, compileLevel, Driver, L1, L2, type LevelDef, PHYSICS_DEFAULTS, physicsOf, PRESETTLE_STEPS,
} from '@tb/keystone';

/** An engine that only counts steps: enough to see how many the driver runs before play. */
class CountingEngine implements PhysicsEngine {
  readonly info = { name: 'count' } as EngineInfo;
  stepIndex = 0;
  private n = 0;
  async init(scene: SceneDesc) { this.n = scene.bodies.length; this.stepIndex = 0; }
  push() {}
  step() { this.stepIndex++; }
  snapshot() { const s = emptySnapshot(this.n); for (let i = 0; i < this.n; i++) s.rot[4 * i + 3] = 1; return s; }
  dispose() {}
}

describe('physics block', () => {
  it('defaults to the settings par lines are pinned at', () => {
    expect(PHYSICS_DEFAULTS).toEqual({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP, bounce: null, presettle: PRESETTLE_STEPS, sleep: false, asleep: false });
    expect(physicsOf(L1)).toEqual(PHYSICS_DEFAULTS);
    expect(physicsOf({ ...L1, physics: { iterations: 20, bounce: 0.4, pairsPerBody: 24 } })).toEqual({ ...PHYSICS_DEFAULTS, iterations: 20, bounce: 0.4, pairsPerBody: 24 });
    expect(physicsOf({ ...L1, physics: { bounce: null } }).bounce).toBeNull();
    expect(physicsOf({ ...L1, physics: { sleep: true } }).sleep).toBe(true);
  });

  it('refuses values out of range, naming the field', () => {
    expect(() => checkPhysics({ iterations: 0 })).toThrow(/physics.iterations must be a whole number from 1 to 200: 0/);
    expect(() => checkPhysics({ iterations: 2.5 })).toThrow(/physics.iterations/);
    expect(() => checkPhysics({ pairsPerBody: 300 })).toThrow(/physics.pairsPerBody must be a whole number from 1 to 256/);
    expect(() => checkPhysics({ presettle: -1 })).toThrow(/physics.presettle/);
    expect(() => checkPhysics({ gapSlop: -1e-5 })).toThrow(/physics.gapSlop must be from 0 to 0.01 m/);
    expect(() => checkPhysics({ bounce: 1.5 })).toThrow(/physics.bounce must be from 0 to 1, or null for off/);
    expect(() => compileLevel({ ...L1, physics: { iterations: 0 } })).toThrow(/physics.iterations/);
    expect(() => checkPhysics({ iterations: 1, gapSlop: 0, bounce: 0, pairsPerBody: 1, presettle: 0 })).not.toThrow();
    // Sleep is a boolean, and not with Bounce (the restitution pass does not know sleepers yet).
    expect(() => checkPhysics({ sleep: 1 as unknown as boolean })).toThrow(/physics.sleep must be true or false: 1/);
    expect(() => checkPhysics({ sleep: true, bounce: 0.4 })).toThrow(/physics.sleep does not go with bounce yet/);
    expect(() => compileLevel({ ...L1, physics: { sleep: true, bounce: 0.4 } })).toThrow(/physics.sleep does not go with bounce/);
    expect(() => checkPhysics({ sleep: true, bounce: null })).not.toThrow();
    expect(() => checkPhysics({ sleep: false, bounce: 0.4 })).not.toThrow();
  });

  it('every field is part of the level hash; fields at their defaults hash as absent', () => {
    const hash = (physics?: LevelDef['physics']) => compileLevel({ ...L1, ...(physics ? { physics } : {}) }).hash;
    const all = [hash(), hash({ iterations: 20 }), hash({ gapSlop: 0 }), hash({ bounce: 0.4 }), hash({ pairsPerBody: 16 }), hash({ presettle: 120 }), hash({ sleep: true })];
    expect(new Set(all).size).toBe(all.length);
    expect(hash({})).toBe(hash());
    expect(hash({ iterations: 40, gapSlop: 3e-5, bounce: null, presettle: 300, sleep: false })).toBe(hash());
    expect(hash()).toBe(compileLevel(L1).hash);
  });

  it('Bounce sets e on the structure and the ground; off, the materials\' own restitution stays', () => {
    const on = compileLevel({ ...L2, physics: { bounce: 0.4 } }), off = compileLevel(L2);
    expect(new Set(on.scene.bodies.map((b) => b.restitution))).toEqual(new Set([0.4]));
    expect(on.scene.ground!.restitution).toBe(0.4);
    expect(off.scene.ground!.restitution).toBeUndefined();
    expect(new Set(off.scene.bodies.map((b) => b.restitution)).has(0.4)).toBe(false);
    expect(on.scene.bodies.map((b) => b.pos)).toEqual(off.scene.bodies.map((b) => b.pos));
  });

  it('the driver pre-settles for the level\'s own step count', async () => {
    for (const [def, want] of [[L1, PRESETTLE_STEPS], [{ ...L1, physics: { presettle: 17 } }, 17], [{ ...L1, physics: { presettle: 0 } }, 0]] as const) {
      const e = new CountingEngine(), d = new Driver(e, compileLevel(def));
      await d.reset();
      expect(e.stepIndex).toBe(want);
      expect(d.snapshotStep).toBe(want);
    }
  });
});

describe('cast stars apply only to the level they were cast for', () => {
  const stars = { metric: 'collapse' as const, t2: 0.3, t3: 0.5 };
  it('no hash recorded: they apply unless the run is custom', () => {
    expect(castStars(compileLevel({ ...L1, stars }))).toEqual(stars);
    expect(castStars(compileLevel({ ...L1, stars, custom: true }))).toBeUndefined();
    expect(castStars(compileLevel(L1))).toBeUndefined();
  });
  it('a recorded hash must match: a physics change since the cast drops them', () => {
    const hash = compileLevel(L1).hash;
    expect(castStars(compileLevel({ ...L1, stars: { ...stars, hash } }))).toEqual({ ...stars, hash });
    expect(castStars(compileLevel({ ...L1, physics: { iterations: 20 }, stars: { ...stars, hash } }))).toBeUndefined();
    // custom is not part of the hash: the overrides that made the level are.
    expect(compileLevel({ ...L1, custom: true }).hash).toBe(hash);
  });
});
