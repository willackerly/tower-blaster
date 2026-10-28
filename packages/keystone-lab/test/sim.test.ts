// Keystone on real engines: levels sit still (Rapier and the AVBD reference;
// the 10 s lean check is sim-lean.test.ts),
// and on Rapier shots fly as predicted, sessions are deterministic, and
// records replay exactly.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { Snapshot } from '@tb/engine-api';
import { quatAngle } from '@tb/geom';
import { RAPIER_SUBSTEPS } from '@tb/keystone-lab';
import { compileLevel, GRAVITY, L1, type LevelDef, LEVELS, predictArc, PRESETTLE_STEPS, runSession, SETTLE_QUIET, type Shot, shotToSpawn, snapshotHash } from '@tb/keystone';
import { ENGINES, idle, presettle } from './idle.ts';

describe.each(ENGINES)('levels on %s', (name, make) => {
  const levels = LEVELS.map((l) => [l.id, l] as const);
  it.each(levels)('%s goes quiet within the pre-settle', async (_id, def) => {
    const e = make();
    const { c, run, settled } = await presettle(e, def);
    e.dispose();
    expect(run, 'quiet steps at the end of the pre-settle').toBeGreaterThanOrEqual(SETTLE_QUIET);
    // The pre-settle only absorbs contact compression: small, and no tilt.
    for (let i = 0; i < c.meta.n; i++) {
      const drift = Math.hypot(...[0, 1, 2].map((k) => settled.pos[3 * i + k]! - c.meta.home[3 * i + k]!));
      expect(drift, `body ${i} drift`).toBeLessThan(0.2 * c.frame.unit);
      expect(quatAngle([...settled.rot.subarray(4 * i, 4 * i + 4)] as [number, number, number, number]), `body ${i} tilt`).toBeLessThan((2 * Math.PI) / 180);
    }
    if (name === 'Rapier') expect(settled.awake.every((a) => a === 0)).toBe(true); // the reference does not sleep
  }, 120_000);

  // Idle stacks must stay put, or a level changes before the first shot. On the
  // AVBD reference L1 and L2 used to rise 3.6 and 6.1 mm in these 2 s, out of
  // the compression of a 90-step pre-settle; PRESETTLE_STEPS covers it now.
  it.each(levels)('%s then sits still for 2 s (within 1 mm)', async (_id, def) => {
    const { up, side } = await idle(make, def, 120);
    expect(Math.max(up, side)).toBeLessThan(1e-3);
  }, 120_000);

});

describe('pre-settle on Rapier', () => {
  // Rapier puts every level to sleep well inside the pre-settle, so the steps
  // it runs for AVBD's sake leave Rapier's state (and its par lines) unchanged.
  it.each(LEVELS.map((l) => [l.id, l] as const))('%s: asleep early, and unchanged from then to the end of the pre-settle', async (_id, def) => {
    const e = new RapierEngine();
    await e.init(compileLevel(def).scene);
    let asleepAt = -1, hash = '';
    for (let t = 1; t <= PRESETTLE_STEPS; t++) {
      e.step();
      if (asleepAt < 0 && e.snapshot().awake.every((a) => a === 0)) { asleepAt = t; hash = snapshotHash(e.snapshot()); }
    }
    expect(asleepAt).toBeGreaterThan(0);
    expect(asleepAt).toBeLessThan(PRESETTLE_STEPS / 2);
    expect(snapshotHash(e.snapshot())).toBe(hash);
    e.dispose();
  });
});

const open: LevelDef = {
  id: 'O', name: 'open', version: 1, world: 0, parts: [{ kind: 'block', at: [20, 0, 20], size: [1, 1, 1], material: 'plaster' }],
  lot: { min: [-30, -30], max: [30, 30] }, crownLine: 0, objective: { kind: 'crowns' }, par: 1, rack: ['marble', 'cannonball'], launcher: { radius: 10, y: 4, dropY: 10 },
};

describe('friction on Rapier', () => {
  // An ice cube shoved across the plaster ground stops after v0^2 / (2 mu g).
  // Keystone combines by 'min', so one ice face makes a slip plane (mu 0.05);
  // the engines' default 'average' would make it 0.325 and ice would not work.
  const v0 = 2;
  const slide = async (rule: 'min' | 'average') => {
    const c = compileLevel({ ...open, parts: [{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'ice' }] });
    const body = { ...c.scene.bodies[0]!, linVel: [v0, 0, 0] as [number, number, number] };
    const e = new RapierEngine();
    await e.init({ ...c.scene, frictionCombine: rule, bodies: [body] });
    for (let t = 0; t < 360; t++) e.step();
    const x = e.snapshot().pos[0]! - body.pos[0];
    e.dispose();
    return x;
  };
  it("compiled levels combine by 'min'", () => {
    for (const def of LEVELS) expect(compileLevel(def).scene.frictionCombine).toBe('min');
  });
  it('an ice cube slides as far as mu = 0.05 predicts, not the averaged 0.325', async () => {
    const expected = (mu: number) => (v0 * v0) / (2 * mu * GRAVITY);
    const min = await slide('min'), avg = await slide('average');
    expect(Math.abs(min / expected(0.05) - 1)).toBeLessThan(0.02);
    expect(Math.abs(avg / expected(0.325) - 1)).toBeLessThan(0.02);
  });
});

describe('shots on Rapier', () => {
  it('the lab predicts with the substeps Rapier reports', () => {
    expect(new RapierEngine().info.integrator?.substeps).toBe(RAPIER_SUBSTEPS);
  });
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
  it('a pipelined driver sees the same steps: one shot ends with the same score and feedback one step later, in the state serial play reaches one step on', async () => {
    const c = compileLevel(L1), par = L1.solutions!.par! as Shot[];
    const serial = await runSession(new RapierEngine(), c, par);
    const piped = await runSession(new RapierEngine(), c, par, { pipelined: true });
    expect(serial.session.phase).toBe('cleared');
    expect(piped.session.score).toEqual(serial.session.score);
    expect(piped.feedback).toEqual(serial.feedback);
    expect(piped.steps).toBe(serial.steps + 1);
    const e = new RapierEngine();
    await e.init({ ...c.scene, inputs: serial.session.inputs.map(({ step, shot }) => shotToSpawn(c.frame, shot, step)) });
    while (e.stepIndex < serial.steps + 1) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(piped.snapshot));
    e.dispose();
  });
  it('a pipelined session fires each later shot from the world as it stands, and replays exactly through scene.inputs', async () => {
    const c = compileLevel(L1);
    const aiming: [string, string][] = [];
    const live = await runSession(new RapierEngine(), c, shots, { pipelined: true, onAiming: (d) => aiming.push([snapshotHash(d.snapshot), snapshotHash(d.engine.snapshot() as Snapshot)]) });
    expect(aiming.length).toBe(1);
    expect(aiming[0]![0]).toBe(aiming[0]![1]);
    expect(live.session.inputs.length).toBe(2);
    const inputs = live.session.inputs.map(({ step, shot }) => shotToSpawn(c.frame, shot, step));
    const e = new RapierEngine();
    await e.init({ ...c.scene, inputs });
    while (e.stepIndex < live.steps) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(live.snapshot));
    e.dispose();
  });
});
