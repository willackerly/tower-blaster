import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { emptySnapshot, type Snapshot, type Vec3 } from '@tb/engine-api';
import { quatFromAxisAngle } from '@tb/geom';
import { closestApproach, compileLevel, GRAVITY, L1, L4, launcherPos, predictArc, shotToSpawn } from '@tb/keystone';
import { eyeOf, frame } from '@tb/render/camera';
import { azFromYaw, pick, previewBeads, rayBox, raySphere, REACH, shotFor, SUBSTEPS } from '../src/aim.ts';

const c = compileLevel(L1);
const h = c.frame.unit, p = c.frame.pitch * h;
function atHome(): Snapshot {
  const s = emptySnapshot(c.meta.n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}
const dir = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

describe('launcher follows the camera', () => {
  it('puts the launcher on the eye side of the lot for any yaw', () => {
    for (let k = 0; k < 64; k++) {
      const yaw = -Math.PI + (k * 2 * Math.PI) / 64;
      const o = { ...frame([-2, 0, -2], [2, 6, 2]), target: [c.frame.centre[0], 1, c.frame.centre[1]] as Vec3, yaw };
      const e = eyeOf(o), l = launcherPos(c.frame, azFromYaw(yaw), 0);
      const a = Math.atan2(e[2] - o.target[2], e[0] - o.target[0]), b = Math.atan2(l[2] - c.frame.centre[1], l[0] - c.frame.centre[0]);
      const diff = Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(diff).toBeLessThanOrEqual((0.25 * Math.PI) / 180 + 1e-9);
    }
    expect(azFromYaw(-Math.PI / 2)).toBe(360); // eye on -x: the par lines' launcher
  });
});

describe('ray casts', () => {
  const id: [number, number, number, number] = [0, 0, 0, 1];
  it('hits an axis-aligned box on the near face with its outward normal', () => {
    const r = rayBox({ origin: [-5, 0.1, 0.2], dir: [1, 0, 0] }, [0, 0, 0], id, [1, 1, 1])!;
    expect(r.t).toBeCloseTo(4, 12);
    expect(r.normal).toEqual([-1, 0, 0]);
    expect(rayBox({ origin: [-5, 1.1, 0], dir: [1, 0, 0] }, [0, 0, 0], id, [1, 1, 1])).toBeNull();
    expect(rayBox({ origin: [5, 0, 0], dir: [1, 0, 0] }, [0, 0, 0], id, [1, 1, 1])).toBeNull(); // behind
    expect(rayBox({ origin: [0, 0, 0], dir: [1, 0, 0] }, [0, 0, 0], id, [1, 1, 1])!.t).toBe(0); // inside
  });
  it('respects rotation: a box turned 45 degrees is hit at its corner distance', () => {
    const q = quatFromAxisAngle([0, 1, 0], Math.PI / 4);
    const r = rayBox({ origin: [-5, 0, 0], dir: [1, 0, 0] }, [0, 0, 0], q, [1, 1, 1])!;
    expect(r.t).toBeCloseTo(5 - Math.SQRT2, 9);
    expect(Math.hypot(...r.normal)).toBeCloseTo(1, 12);
    expect(r.normal[0]).toBeLessThan(0);
  });
  it('sphere: entry distance, inside and miss', () => {
    expect(raySphere({ origin: [-5, 0, 0], dir: [1, 0, 0] }, [0, 0, 0], 1)).toBeCloseTo(4, 12);
    expect(raySphere({ origin: [0, 0, 0], dir: [1, 0, 0] }, [0, 0, 0], 1)).toBe(0);
    expect(raySphere({ origin: [-5, 2, 0], dir: [1, 0, 0] }, [0, 0, 0], 1)).toBeNull();
  });
  it('picks the nearest structure body, else the ground, else nothing', () => {
    const s = atHome();
    const y = 5.5 * h;
    const side = pick({ origin: [-20, y, 0.2], dir: [1, 0, 0] }, s, c)!;
    expect(side.point[0]).toBeCloseTo(-p + (p - h) / 2, 9); // L1's -x face
    expect(Math.floor(c.meta.home[3 * side.body + 1]! / h)).toBe(5);
    const top = pick({ origin: [0.1, 50, 0.1], dir: [0, -1, 0] }, s, c)!;
    expect(c.meta.role[top.body]).toBe(1); // a crown on the top course
    expect(top.normal).toEqual([0, 1, 0]);
    const ground = pick({ origin: [10, 5, 10], dir: dir([0, -1, 1]) }, s, c)!;
    expect(ground.body).toBe(-1);
    expect(ground.point[1]).toBe(0);
    expect(pick({ origin: [10, 5, 10], dir: [0, 1, 0] }, s, c)).toBeNull();
  });
});

describe('shots from a picked point', () => {
  it('a launch shot passes within REACH of the target and the arc preview ends there', () => {
    const target: Vec3 = [-1.5 * p, 5.5 * h, 0];
    for (const [ammo, power] of [['marble', 100], ['cannonball', 100], ['cannonball', 60]] as const) {
      const a = shotFor(c, ammo, 360, power, target)!;
      expect(a.reachable).toBe(true);
      const arc = predictArc(shotToSpawn(c.frame, a.shot, 0), [0, -GRAVITY, 0], c.scene.dt, 240, SUBSTEPS);
      expect(closestApproach(arc, target)).toBeCloseTo(a.error, 9);
      expect(a.error).toBeLessThanOrEqual(REACH);
      const beads = previewBeads(c, a.shot, target);
      const last: Vec3 = [beads.at(-3)!, beads.at(-2)!, beads.at(-1)!];
      expect(Math.hypot(last[0] - target[0], last[1] - target[1], last[2] - target[2])).toBeLessThan(0.5);
      expect(beads.length / 3).toBeLessThanOrEqual(40);
      for (let k = 1; k < beads.length; k += 3) expect(beads[k]!).toBeGreaterThanOrEqual(0);
    }
  });
  it('flags a target out of reach at low power', () => {
    expect(shotFor(c, 'marble', 360, 0, [6 * p, 30 * h, 0])!.reachable).toBe(false);
  });
  it('a drop lands within an eighth of a cell of the target, and its preview falls straight down', () => {
    const c4 = compileLevel(L4), p4 = c4.frame.pitch * c4.frame.unit;
    const target: Vec3 = [8.3 * p4, 4.25 * c4.frame.unit, -0.7 * p4];
    const a = shotFor(c4, 'drop', 0, 100, target)!;
    expect(a.shot).toEqual({ ammo: 'drop', x: 33, z: -3 });
    expect(a.error).toBeLessThanOrEqual((Math.SQRT2 * p4) / 8);
    const beads = previewBeads(c4, a.shot, target);
    for (let k = 0; k < beads.length; k += 3) expect([beads[k], beads[k + 2]]).toEqual([(33 / 4) * p4, (-3 / 4) * p4]);
    expect(beads.at(-2)).toBeCloseTo(target[1], 9);
  });
  it('has no cue aiming yet', () => {
    expect(shotFor(c, 'cue', 0, 50, [0, 1, 0])).toBeNull();
  });
});

describe('SUBSTEPS', () => {
  // The arc preview must integrate as the engine does (EngineInfo.integrator).
  it('matches the substeps Rapier reports', () => {
    expect(new RapierEngine().info.integrator?.substeps).toBe(SUBSTEPS);
  });
  it('aims and previews with the substeps it is given (AVBD reports 1)', () => {
    const target: Vec3 = [-1.5 * p, 5.5 * h, 0];
    const a1 = shotFor(c, 'marble', 360, 100, target, 1)!, a4 = shotFor(c, 'marble', 360, 100, target, 4)!;
    const arc1 = predictArc(shotToSpawn(c.frame, a1.shot, 0), [0, -GRAVITY, 0], c.scene.dt, 240, 1);
    expect(closestApproach(arc1, target)).toBeCloseTo(a1.error, 9);
    // Every bead is a point of the one-substep arc, and the preview differs from Rapier's.
    const beads = previewBeads(c, a1.shot, target, 1);
    for (let b = 0; b < beads.length; b += 3) {
      let best = Infinity;
      for (let k = 0; k < arc1.length; k += 3) best = Math.min(best, Math.hypot(beads[b]! - arc1[k]!, beads[b + 1]! - arc1[k + 1]!, beads[b + 2]! - arc1[k + 2]!));
      expect(best).toBe(0);
    }
    const beads4 = previewBeads(c, a1.shot, target, 4);
    expect(Array.from(beads4.subarray(0, 3))).toEqual(Array.from(beads.subarray(0, 3))); // same spawn point
    expect(beads4.some((v, i) => i < beads.length && Math.abs(v - beads[i]!) > 1e-3)).toBe(true);
    expect(a4.reachable && a1.reachable).toBe(true);
  });
});
