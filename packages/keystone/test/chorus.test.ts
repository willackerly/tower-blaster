// Chorus (M9, chorus.ts): the worlds, the per-world judge, the fence, the aim nudges and the score, on a
// scripted engine (no physics: every snapshot is what the test says). The physics half (Rapier islands
// against solo runs, the Driver's hold and rescore) is keystone-lab chorus*.test.ts.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type InputEvent, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';
import {
  CHORUS_JITTER, ChorusEngine, type ChorusJudgement, chorusIssues, chorusOf, chorusScore, chorusWorlds, compileLevel, L2, L3,
  type LevelDef, shotToSpawn, validateLevel,
} from '../src/index.ts';

/** L3 (Surgeon: two crowns between heritage on a wall) as a Chorus level of K worlds, one cannonball. */
const surgeon = (chorus: LevelDef['chorus'] = { worlds: 8 }): LevelDef => ({ ...L3, id: 'CH-T', rack: ['cannonball'], par: 1, scoring: 'outcome', solutions: undefined, lGold: undefined, chorus });

/** An engine that runs no physics: its state is the scene as given, the spawns as released, and whatever the test writes. */
class Scripted implements PhysicsEngine {
  readonly info = { name: 'scripted', variant: {}, backend: 'none', integrator: { substeps: 1 } };
  stepIndex = 0;
  scene!: SceneDesc;
  pushed: InputEvent[] = [];
  state: Snapshot = emptySnapshot(0);
  async init(scene: SceneDesc) {
    this.scene = scene;
    this.state = emptySnapshot(scene.bodies.length);
    scene.bodies.forEach((b, i) => { this.state.pos.set(b.pos, 3 * i); this.state.rot.set(b.rot, 4 * i); });
  }
  push(events: InputEvent[]) {
    this.pushed.push(...events);
    for (const e of events) if (e.kind === 'spawn') {
      const s = emptySnapshot(this.state.count + 1);
      for (const k of ['pos', 'rot', 'linVel', 'angVel', 'awake'] as const) (s[k] as Float64Array).set(this.state[k] as Float64Array);
      s.pos.set(e.body.pos, 3 * this.state.count);
      s.rot.set(e.body.rot, 4 * this.state.count);
      s.linVel.set(e.body.linVel, 3 * this.state.count);
      this.state = s;
    }
  }
  step() { this.stepIndex++; }
  snapshot(): Snapshot {
    const s = this.state;
    return { count: s.count, pos: s.pos.slice(), rot: s.rot.slice(), linVel: s.linVel.slice(), angVel: s.angVel.slice(), awake: s.awake.slice() };
  }
  dispose() {}
}

async function setUp(def = surgeon()) {
  const c = compileLevel(def), inner = new Scripted(), e = new ChorusEngine(inner, c);
  await e.init(c.scene);
  await e.snapshot();
  return { c, inner, e, isl: e.islands };
}

describe('Chorus levels', () => {
  it('defaults: 64 worlds, stars at 1/2, 3/4 and 15/16 of them, seed 1, every crown to clear', () => {
    const ch = chorusOf(surgeon({}))!;
    expect(ch).toEqual({ worlds: 64, jitter: CHORUS_JITTER, seed: 1, stars: [32, 48, 60], need: null });
    expect(chorusOf(surgeon({ worlds: 16 }))!.stars).toEqual([8, 12, 15]);
    expect(chorusOf({ ...L3 })).toBeNull();
  });

  it('a level that is not one shot of a ball, a drop or a pull into a crowns objective is refused', () => {
    expect(chorusIssues(surgeon())).toEqual([]);
    expect(validateLevel(compileLevel(surgeon())).filter((i) => i.code === 'chorus')).toEqual([]);
    const issues = (d: Partial<LevelDef>, ch: LevelDef['chorus'] = { worlds: 8 }) => chorusIssues({ ...surgeon(ch), ...d }).map((i) => i.message);
    expect(issues({ rack: ['cannonball', 'marble'] })).toEqual([expect.stringMatching(/one shot/)]);
    expect(issues({ rack: ['w-grenade'] })).toEqual([expect.stringMatching(/world 0's state/)]);
    expect(issues({ objective: { kind: 'collapse', min: 0.3 } })).toEqual([expect.stringMatching(/crowns down/)]);
    expect(issues({}, { worlds: 1 })).toEqual([expect.stringMatching(/2 to 256/)]);
    expect(issues({}, { worlds: 8, stars: [4, 3, 8] })).toEqual([expect.stringMatching(/non-decreasing/)]);
    expect(issues({}, { worlds: 8, jitter: { pos: 0.02 } })).toEqual([expect.stringMatching(/lattice gap/)]);
    expect(issues({}, { worlds: 8, need: 0 })).toEqual([expect.stringMatching(/need/)]);
    expect(validateLevel(compileLevel({ ...surgeon(), rack: ['cannonball', 'marble'], par: 1 })).some((i) => i.code === 'chorus')).toBe(true);
    // Ice cracks from world 0's state in the Driver, so no Chorus level holds any.
    const iced = surgeon();
    iced.parts = [...iced.parts, { kind: 'block', at: [4, 0, 4], size: [1, 1, 1], material: 'ice' }];
    expect(validateLevel(compileLevel(iced)).filter((i) => i.code === 'chorus').map((i) => i.message)).toEqual([expect.stringMatching(/no ice/)]);
  });

  it('the chorus block is part of the level hash: worlds, stars, need and seed each make another level', () => {
    const h = (ch: LevelDef['chorus']) => compileLevel(surgeon(ch)).hash;
    const base = h({ worlds: 8 });
    expect(h({ worlds: 8 })).toBe(base);
    for (const other of [{ worlds: 16 }, { worlds: 8, stars: [2, 4, 8] as [number, number, number] }, { worlds: 8, need: 1 }, { worlds: 8, seed: 2 }]) expect(h(other)).not.toBe(base);
    expect(compileLevel({ ...surgeon(), chorus: undefined }).hash).not.toBe(base);
  });
});

describe('the worlds', () => {
  it('world 0 is the level exactly; every other is moved and turned by at most a hair, seeded and repeatable', () => {
    const c = compileLevel(surgeon({ worlds: 16 })), w = chorusWorlds(c), h = c.frame.unit, j = CHORUS_JITTER;
    expect(w).toHaveLength(16);
    expect(w[0]).toBe(c.scene);
    expect(chorusWorlds(c)).toEqual(w);
    let maxD = 0, maxYaw = 0;
    for (let k = 1; k < 16; k++) {
      expect(w[k]!.bodies).toHaveLength(c.meta.n);
      w[k]!.bodies.forEach((b, i) => {
        const a = c.scene.bodies[i]!;
        expect(b.pos[1]).toBe(a.pos[1]);
        const d = Math.max(Math.abs(b.pos[0] - a.pos[0]), Math.abs(b.pos[2] - a.pos[2]));
        maxD = Math.max(maxD, d);
        // L3's blocks start unrotated: the jitter is a yaw (x and z of the quaternion stay 0).
        expect(Math.abs(b.rot[0]) + Math.abs(b.rot[2])).toBeLessThan(1e-12);
        maxYaw = Math.max(maxYaw, (2 * Math.asin(Math.abs(b.rot[1])) * 180) / Math.PI);
      });
    }
    expect(maxD).toBeLessThanOrEqual(j.pos * h);
    expect(maxD).toBeGreaterThan(0.5 * j.pos * h);
    expect(maxYaw).toBeLessThanOrEqual(j.yaw + 1e-9);
    expect(maxYaw).toBeGreaterThan(0.5 * j.yaw);
    // Another seed meets other worlds.
    expect(chorusWorlds(compileLevel(surgeon({ worlds: 16, seed: 7 })))[3]).not.toEqual(w[3]);
  });

  it('a long body turns no further than its corners may move (pos), and pinned bodies stay put', () => {
    const c = compileLevel({ ...L2, id: 'CH-L2', rack: ['cannonball'], par: 1, scoring: 'outcome', chorus: { worlds: 6 } });
    const slab = c.scene.bodies.findIndex((b) => b.shape.kind === 'box' && b.shape.half[0] > 1.5);
    expect(slab).toBeGreaterThanOrEqual(0);
    const s = c.scene.bodies[slab]!, half = s.shape.kind === 'box' ? s.shape.half : [0, 0, 0];
    const reach = Math.hypot(half[0]!, half[2]!), cap = ((CHORUS_JITTER.pos * c.frame.unit) / reach) * (180 / Math.PI);
    for (const w of chorusWorlds(c).slice(1)) expect((2 * Math.asin(Math.abs(w.bodies[slab]!.rot[1])) * 180) / Math.PI).toBeLessThanOrEqual(cap + 1e-9);
    const pinned: SceneDesc = { ...c.scene, bodies: c.scene.bodies.map((b, i) => (i === 0 ? { ...b, pinned: true } : b)) };
    for (const w of chorusWorlds(c, pinned).slice(1)) expect(w.bodies[0]).toBe(pinned.bodies[0]);
  });
});

describe('the engine', () => {
  it('shows world 0 in its own ids and coordinates, and fires the shot into every world, nudged for k >= 1', async () => {
    const { c, inner, e, isl } = await setUp();
    expect(inner.scene.bodies).toHaveLength(8 * c.meta.n);
    const s0 = await e.snapshot();
    expect(s0.count).toBe(c.meta.n);
    expect([...s0.pos]).toEqual(c.scene.bodies.flatMap((b) => b.pos));
    // Room for the launcher and the ball's flight: no cell edge inside the launcher's circle plus 24 m.
    expect(isl.half).toBeGreaterThan((c.def.launcher.radius + 2) * c.frame.unit + 24 - 1);
    const shot = shotToSpawn(c.frame, { ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 341, power: 100 }, 0);
    e.push([shot]);
    e.step();
    const spawns = inner.pushed.filter((p) => p.kind === 'spawn');
    expect(spawns).toHaveLength(8);
    const v0 = shot.body.linVel, speed = Math.hypot(...v0);
    spawns.forEach((sp, k) => {
      if (sp.kind !== 'spawn') return;
      const o = isl.offsets[k]!, v = sp.body.linVel;
      if (k === 0) { expect(sp.body).toEqual(shot.body); return; }
      expect(sp.body.pos).toEqual([shot.body.pos[0] + o[0], shot.body.pos[1], shot.body.pos[2] + o[2]]);
      const sk = Math.hypot(...v), cos = (v[0] * v0[0] + v[1] * v0[1] + v[2] * v0[2]) / (sk * speed);
      expect(Math.abs(sk / speed - 1)).toBeLessThanOrEqual(CHORUS_JITTER.power + 1e-12);
      // Turned by at most aim in yaw and pitch in pitch: under their sum overall (the triangle inequality on the sphere).
      const angle = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
      expect(angle).toBeLessThanOrEqual(CHORUS_JITTER.aim + CHORUS_JITTER.pitch + 1e-9);
      expect(angle).toBeGreaterThan(0);
    });
    // World 0 sees its own ball as body n.
    const s1 = await e.snapshot();
    expect(s1.count).toBe(c.meta.n + 1);
    expect([...s1.pos.subarray(3 * c.meta.n)]).toEqual(shot.body.pos);
  });

  it('judges each world in the observer\'s arithmetic: crowns below the line or off the lot, heritage cracked, bodies moved', async () => {
    const { c, inner, e, isl } = await setUp();
    e.push([shotToSpawn(c.frame, { ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 341, power: 100 }, 0)]);
    e.step();
    await e.snapshot();
    const [c0, c1] = [...c.meta.crowns], h = c.frame.unit, s = inner.state;
    const at = (k: number, local: number) => 3 * isl.idOf(k, local);
    // World 1: both crowns on the ground. World 2: one down, one thrown off the lot but still high (down too).
    // World 3: both down and a heritage block knocked 0.6 h along x (cracked: no clear). World 4: one crown down.
    for (const cr of [c0!, c1!]) s.pos[at(1, cr) + 1] = 0.5 * h;
    s.pos[at(2, c0!) + 1] = 0.5 * h;
    s.pos[at(2, c1!)] = c.lot.max[0] + 1 + isl.offsets[2]![0];
    for (const cr of [c0!, c1!]) s.pos[at(3, cr) + 1] = 0.5 * h;
    s.pos[at(3, c.meta.heritage[0]!)]! += 0.6 * h;
    s.pos[at(4, c0!) + 1] = 0.5 * h;
    e.step();
    await e.snapshot();
    const j = e.judge();
    expect(j.worlds).toBe(8);
    expect(j.crownsDown).toEqual([0, 2, 2, 2, 1, 0, 0, 0]);
    expect(j.heritage).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
    expect(j.cleared).toEqual([false, true, true, false, false, false, false, false]);
    expect(j.clears).toBe(2);
    // Moved: world 1 its two crowns (dropped 7 h), world 2 two, world 3 three (the heritage block too), world 4 one.
    expect(j.moved.map((m) => Math.round(m * c.meta.n))).toEqual([0, 2, 2, 3, 1, 0, 0, 0]);
    // need 1: one crown down clears world 4.
    const one = await setUp(surgeon({ worlds: 8, need: 1 }));
    one.e.push([shotToSpawn(one.c.frame, { ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 341, power: 100 }, 0)]);
    one.e.step();
    await one.e.snapshot();
    one.inner.state.pos[3 * one.isl.idOf(4, c0!) + 1] = 0.5 * h;
    one.e.step();
    await one.e.snapshot();
    expect(one.e.judge().cleared[4]).toBe(true);
  });

  it('removes a body that strays past the fence before it can reach the next island, and holds the settle while a world moves', async () => {
    const { c, inner, e, isl } = await setUp();
    e.push([shotToSpawn(c.frame, { ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 341, power: 100 }, 0)]);
    e.step();
    await e.snapshot();
    const ball5 = isl.idOf(5, c.meta.n);
    inner.state.pos[3 * ball5 + 2] = isl.offsets[5]![2] + e.fenceAt + 0.5;
    // World 6 has a block moving: the round holds.
    const b6 = isl.idOf(6, 0);
    inner.state.awake[b6] = 1;
    inner.state.linVel[3 * b6] = 1;
    await e.snapshot();
    expect(e.settleHold()).toBe(true);
    expect(e.fencedCount).toBe(1);
    e.step();
    expect(inner.pushed.at(-1)).toEqual({ step: inner.stepIndex - 1, kind: 'remove', id: ball5 });
    inner.state.linVel[3 * b6] = 0;
    for (let i = 0; i < 30; i++) { e.step(); await e.snapshot(); }
    expect(e.settleHold()).toBe(false);
    expect(e.judge().leaks).toBe(0);
  });

  it('health() and checkpoint() exist exactly when the inner engine has them (Rapier keeps no health: a call would throw at the round\'s end)', () => {
    const c = compileLevel(surgeon({ worlds: 2 }));
    const bare = new ChorusEngine(new Scripted(), c);
    expect([bare.health, bare.checkpoint]).toEqual([undefined, undefined]);
    const health = async () => ({ limits: {} }) as never, kept = new Scripted();
    Object.assign(kept, { health, checkpoint: () => ({ step: 0, bytes: 0, restore() {}, dispose() {} }) });
    const e = new ChorusEngine(kept, c);
    expect(typeof e.health).toBe('function');
    expect(typeof e.checkpoint).toBe('function');
  });

  it('only: k plays world k alone at the origin, jittered and nudged as in the chorus', async () => {
    const c = compileLevel(surgeon()), all = chorusWorlds(c), inner = new Scripted(), e = new ChorusEngine(inner, c, { only: 3 });
    await e.init(c.scene);
    expect(inner.scene.bodies).toEqual(all[3]!.bodies);
    expect(e.worlds).toBe(1);
    expect(() => new ChorusEngine(new Scripted(), c, { only: 8 })).toThrow(/only/);
    const full = await setUp();
    const shot = shotToSpawn(c.frame, { ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 341, power: 100 }, 0);
    e.push([shot]);
    e.step();
    full.e.push([shot]);
    full.e.step();
    const solo = inner.pushed[0]!, island = full.inner.pushed[3]!;
    if (solo.kind !== 'spawn' || island.kind !== 'spawn') throw new Error('spawns');
    expect(solo.body.linVel).toEqual(island.body.linVel);
  });
});

describe('the score (agreed with the scores thread)', () => {
  const c = compileLevel(surgeon({})), j = (clears: number): ChorusJudgement => ({
    step: 0, worlds: 64, cleared: Array.from({ length: 64 }, (_, k) => k < clears), heritage: Array(64).fill(0), crownsDown: Array(64).fill(1),
    moved: Array(64).fill(0.5), crowns: 2, need: 2, clears, leaks: 0,
  });
  it('stars at 32, 48 and 60 of 64: one short of each threshold is a star less', () => {
    const stars = (n: number) => chorusScore(c, j(n), { leverage: 1 }).stars;
    expect([0, 31, 32, 47, 48, 59, 60, 64].map(stars)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
  it('one line, the total its sum (0 of 64 scores 0), the stamp the count, no gold, the leverage world 0\'s', () => {
    for (const n of [0, 1, 33, 64]) {
      const s = chorusScore(c, j(n), { leverage: 2.5 });
      expect(s.total).toBe(s.lines.reduce((a, l) => a + l.value, 0));
      expect(s.stamp).toBe(`${n}/64 CLEAR`);
      expect(s.worlds).toEqual({ cleared: n, of: 64, thresholds: [32, 48, 60] });
      expect(s.gold).toBe(false);
      expect(s.leverage).toBe(2.5);
    }
    expect(chorusScore(c, j(0), { leverage: 0 })).toMatchObject({ total: 0, stars: 0 });
    expect(chorusScore(c, j(64), { leverage: 0 }).total).toBe(3000);
  });
});
