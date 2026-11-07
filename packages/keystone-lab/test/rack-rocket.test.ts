// The rocket in the rack (weapons plan step 6): a WeaponSpec with a motor (a
// heading thrust on a timer). Scaled to the level, its acceleration keeps its
// ratio to gravity (speed^2 / length); its motor's work is charged as fired
// energy beside its blast's yield; its speed bound counts the motor's
// delta-v; and the aim flies the motor (shots.ts predictArc), as exactly as
// the arc preview (@tb/weapons previewWeapon, itself the reference engine's
// path to 1e-9), so a rocket aimed at a block arrives there on Rapier, where
// one aimed as a thrown shell would not.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type InputEvent, type Vec3 } from '@tb/engine-api';
import { aimAt, compileLevel, cubeScale, GRAVITY, itemSpec, itemYield, L1, type LevelDef, levelArm, predictArc, runSession, type Shot, shotToSpawn, validateLevel } from '@tb/keystone';
import { previewWeapon, ROCKET, scaleWeapon, timedForces, type WeaponSpec } from '@tb/weapons';
import { RAPIER_SUBSTEPS } from '../src/index.ts';

const def: LevelDef = { ...L1, rack: ['w-rocket', 'marble'] };
const c = compileLevel(def);

describe('the rocket, scaled to a level', () => {
  it('keeps 2.5 g of thrust at any block size, bounds its speed by launch plus the motor\'s delta-v, and charges the motor\'s work', () => {
    expect(validateLevel(c)).toEqual([]);
    const arm = levelArm(c, 'rocket'), s = cubeScale(c), h = c.frame.unit;
    const spec = scaleWeapon(ROCKET, s);
    expect(arm.spec).toEqual(JSON.parse(JSON.stringify(arm.spec)));
    // Accelerations go as speed^2 / length: at h = 0.5 m, sqrt(h)^2 / h = 1, so 25 m/s^2 still.
    const accel = ((arm.spec as WeaponSpec).rules[0]!.do[0] as { thrust: { accel: Vec3 } }).thrust.accel;
    expect(accel[1]).toBeCloseTo(25, 12);
    expect(arm.shell.motor).toEqual(timedForces(arm.spec as WeaponSpec));
    expect(itemSpec('w-rocket', c.frame).motor).toHaveLength(1);
    // Speed: 18 sqrt(h) at launch plus 25 m/s^2 for 1 s.
    const vMax = 18 * Math.sqrt(h);
    expect(arm.munitions[0]!.speed).toBeCloseTo(vMax + 25, 9);
    // Motor work m |a| T (v + a T / 2), beside the blast's yield.
    const m = arm.munitions[0]!.mass;
    expect(arm.motor).toBeCloseTo(m * 25 * 1 * (vMax + 12.5), 6);
    expect(itemYield(c, 'w-rocket')).toBe(arm.yield + arm.motor);
    expect(spec.shell.speed).toEqual([6 * Math.sqrt(h), vMax]);
  });

  it('the aim\'s arc with the motor is the arc preview\'s, to 1e-9, up to the blast', () => {
    const arm = levelArm(c, 'rocket'), spec = arm.spec as WeaponSpec;
    const shot: Shot = { ammo: 'w-rocket', az: 360, y: 8, yaw: 0, pitch: 350, power: 50 };
    const ev = shotToSpawn(c.frame, shot, 0), s = c.scene;
    const pre = previewWeapon(spec, { shape: ev.body.shape, pos: ev.body.pos, vel: ev.body.linVel, density: ev.body.density }, { dt: s.dt, substeps: RAPIER_SUBSTEPS, gravity: s.gravity, groundY: s.ground?.y ?? null });
    // In free flight: up to the blast, or the step before it first touches the ground (the preview holds it there).
    const t = pre.tracks[0]!, end = Math.min(pre.blasts[0]!.step, (t.contact ?? Infinity) - 1);
    expect(end).toBeGreaterThan(66);
    const arc = predictArc(ev, [0, -GRAVITY, 0], s.dt, end, RAPIER_SUBSTEPS, arm.shell.motor);
    for (let k = 0; k <= end; k++) for (let i = 0; i < 3; i++) expect(Math.abs(arc[3 * k + i]! - t.points[k]![i]!), `step ${k}`).toBeLessThan(1e-9);
    // Without the motor the line is a thrown shell's, metres short.
    const thrown = predictArc(ev, [0, -GRAVITY, 0], s.dt, end, RAPIER_SUBSTEPS);
    expect(Math.hypot(thrown[3 * end]! - arc[3 * end]!, thrown[3 * end + 2]! - arc[3 * end + 2]!)).toBeGreaterThan(5);
  });

  it('aimed at a block of the tower, it blows next to that block on Rapier; aimed as a thrown shell, it overshoots', { timeout: 60_000 }, async () => {
    // A block on the near face, half way up.
    const m = c.meta, n = m.home.length / 3;
    let pick = 0;
    for (let i = 0; i < n; i++) if (Math.abs(m.home[3 * i + 1]! - 2) + 0.2 * Math.abs(m.home[3 * i]!) < Math.abs(m.home[3 * pick + 1]! - 2) + 0.2 * Math.abs(m.home[3 * pick]!)) pick = i;
    const target: Vec3 = [m.home[3 * pick]!, m.home[3 * pick + 1]!, m.home[3 * pick + 2]!];
    const at = { az: 360, y: 8, power: 40 };
    const aimed = aimAt(c.frame, 'w-rocket', at, target, { substeps: RAPIER_SUBSTEPS, maxSteps: 240 });
    expect(aimed.error).toBeLessThan(0.1);
    const blastAt = async (shot: Shot) => {
      let pushed: InputEvent[] = [];
      const r = await runSession(new RapierEngine(), c, [shot], { perStep: (d) => { pushed = d.pushed; return []; } });
      const b = pushed.find((e) => e.kind === 'blast');
      if (!b || b.kind !== 'blast' || typeof b.blast.centre !== 'object' || !('body' in b.blast.centre)) throw new Error('no blast on the rocket');
      const id = b.blast.centre.body, p = r.snapshot.pos;
      return Math.hypot(p[3 * id]! - target[0], p[3 * id + 1]! - target[1], p[3 * id + 2]! - target[2]);
    };
    // It blows on touching the tower, within a block or so of the block aimed at (centre to centre).
    expect(await blastAt(aimed.shot)).toBeLessThan(1);
    // The pitch a thrown shell of the same speed would need sends the rocket high over its mark.
    const ballistic = aimAt({ ...c.frame, shells: { ...c.frame.shells, 'w-rocket': { ...itemSpec('w-rocket', c.frame), motor: undefined } } }, 'w-rocket', at, target, { substeps: RAPIER_SUBSTEPS });
    expect(ballistic.shot.pitch).toBeGreaterThan(aimed.shot.pitch);
    expect(await blastAt(ballistic.shot)).toBeGreaterThan(1.5);
  });
});
