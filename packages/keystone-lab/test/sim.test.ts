// Keystone on a real engine (Rapier): levels sit still, shots fly as
// predicted, sessions are deterministic, and records replay exactly.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { quatAngle } from '@tb/geom';
import { RAPIER_SUBSTEPS } from '@tb/keystone-lab';
import { compileLevel, Driver, GRAVITY, L1, type LevelDef, LEVELS, predictArc, PRESETTLE_STEPS, runSession, type Shot, shotToSpawn, snapshotHash } from '@tb/keystone';

describe('levels on Rapier', () => {
  it.each(LEVELS.map((l) => [l.id, l] as const))('%s settles within the pre-settle and then sits still', async (_id, def) => {
    const c = compileLevel(def), d = new Driver(new RapierEngine(), c);
    await d.reset();
    const settled = d.snapshot, h = c.frame.unit;
    // The pre-settle only absorbs contact compression: small, and no tilt.
    for (let i = 0; i < c.meta.n; i++) {
      const drift = Math.hypot(...[0, 1, 2].map((k) => settled.pos[3 * i + k]! - c.meta.home[3 * i + k]!));
      expect(drift, `body ${i} drift`).toBeLessThan(0.2 * h);
      expect(quatAngle([...settled.rot.subarray(4 * i, 4 * i + 4)] as [number, number, number, number]), `body ${i} tilt`).toBeLessThan((2 * Math.PI) / 180);
    }
    expect(settled.awake.every((a) => a === 0)).toBe(true);
    for (let t = 0; t < 120; t++) await d.engine.step();
    const later = await d.engine.snapshot();
    for (let i = 0; i < 3 * c.meta.n; i++) expect(Math.abs(later.pos[i]! - settled.pos[i]!)).toBeLessThan(1e-3);
    d.engine.dispose();
  });
});

const open: LevelDef = {
  id: 'O', name: 'open', version: 1, world: 0, parts: [{ kind: 'block', at: [20, 0, 20], size: [1, 1, 1], material: 'plaster' }],
  lot: { min: [-30, -30], max: [30, 30] }, crownLine: 0, objective: { kind: 'crowns' }, par: 1, rack: ['marble', 'cannonball'], launcher: { radius: 10, y: 4, dropY: 10 },
};

describe('shots on Rapier', () => {
  it('free flight matches predictArc (with Rapier\'s 4 substeps) to float32 rounding for one second', async () => {
    const c = compileLevel(open), e = new RapierEngine();
    await e.init(c.scene);
    const shot: Shot = { ammo: 'marble', az: 0, y: 8, yaw: 0, pitch: 350, power: 80 };
    const ev = shotToSpawn(c.frame, shot, 0);
    e.push([ev]);
    const arc = predictArc(ev, [0, -GRAVITY, 0], c.scene.dt, 60, RAPIER_SUBSTEPS);
    for (let n = 1; n <= 60; n++) {
      e.step();
      const s = e.snapshot();
      for (let k = 0; k < 3; k++) expect(Math.abs(s.pos[3 + k]! - arc[3 * n + k]!), `step ${n} axis ${k}`).toBeLessThan(2e-4);
    }
    e.dispose();
  });
});

describe('par lines', () => {
  // A physics or adapter change that breaks a level's recorded solution fails here.
  it.each(LEVELS.map((l) => [l.id, l] as const))('%s: the recorded par line clears at par with no heritage broken', async (_id, def) => {
    const shots = def.solutions?.par ?? [];
    expect(shots.length).toBe(def.par);
    const e = new RapierEngine();
    const r = await runSession(e, compileLevel(def), shots);
    e.dispose();
    expect(r.session.phase).toBe('cleared');
    expect(r.session.heritageBroken.every((x) => !x)).toBe(true);
    expect(r.session.score!.stars).toBeGreaterThanOrEqual(2);
  });
});

describe('sessions on Rapier', () => {
  const shots: Shot[] = [
    { ammo: 'cannonball', az: 360, y: 8, yaw: 0, pitch: 505, power: 100 },
    { ammo: 'cannonball', az: 180, y: 8, yaw: -46, pitch: 526, power: 60 },
  ];
  it('are deterministic: the same shots give the same final state and score', async () => {
    const c = compileLevel(L1);
    const a = await runSession(new RapierEngine(), c, shots), b = await runSession(new RapierEngine(), c, shots);
    expect(snapshotHash(a.snapshot)).toBe(snapshotHash(b.snapshot));
    expect(a.session.score).toEqual(b.session.score);
    expect(a.steps).toBe(b.steps);
  });
  it('replaying the recorded inputs through scene.inputs reproduces the interactive run exactly', async () => {
    const c = compileLevel(L1);
    const live = await runSession(new RapierEngine(), c, shots);
    const inputs = live.session.inputs.map(({ step, shot }) => shotToSpawn(c.frame, shot, step));
    const e = new RapierEngine();
    await e.init({ ...c.scene, inputs });
    while (e.stepIndex < live.steps) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(live.snapshot));
    expect(live.session.inputs[0]!.step).toBe(PRESETTLE_STEPS);
  });
});
