import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { emptySnapshot, type Snapshot, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { quatFromAxisAngle } from '@tb/geom';
import { BIG_LEVELS, closestApproach, compileLevel, GRAVITY, L1, L4, launcherPos, LEVELS, outsideLot, predictArc, Session, shotToSpawn } from '@tb/keystone';
import { eyeOf, frame } from '@tb/render/camera';
import { azFromYaw, LAUNCH_ABOVE_TOP, LAUNCH_MAX_ABOVE_TOP, LAUNCH_STEP, launchHeight, launchRange, launchStep, launchY, pick, previewBeads, pullFor, rayBox, raySphere, REACH, shotFor, SUBSTEPS } from '../src/aim.ts';

const c = compileLevel(L1);
const h = c.frame.unit, p = c.frame.pitch * h;
function atHome(): Snapshot {
  const s = emptySnapshot(c.meta.n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}
const dir = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

describe('launch height', () => {
  it("is the launcher's for Keystone ammo and every preset that fits, and lifts the boulder clear of the ground", () => {
    const base = Math.round(L1.launcher.y * 4);
    for (const a of ['marble', 'cannonball', 'p-beachball', 'p-wreckingball'] as const) expect(launchY(c, a), a).toBe(base);
    // w-grenade's shell is the level's (w-grenadem's, 0.2 cube = 0.1 m here): small enough to leave from the launcher too.
    expect(launchY(compileLevel({ ...L1, rack: [...L1.rack, 'w-grenade'] }), 'w-grenade')).toBe(base);
    // 6.7 m across at h = 0.5 m: radius 6.7 h, so 27 quarter-h, its bottom 0.025 m above the ground.
    expect(launchY(c, 'p-boulder')).toBe(27);
    const a = shotFor(compileLevel({ ...L1, rack: ['p-boulder'] }), 'p-boulder', 360, 100, [0, 2, 0])!;
    expect(a.shot).toMatchObject({ y: 27 });
    const ev = shotToSpawn(c.frame, a.shot, 0);
    expect(ev.body.pos[1] - (ev.body.shape as { radius: number }).radius).toBeGreaterThanOrEqual(0);
  });
});

describe('high launcher (keystone.launch=high, the default)', () => {
  it('opens LAUNCH_ABOVE_TOP h over the structure (never under the level\'s own); level mode is the level\'s; W and S step one h within low..top', () => {
    for (const def of [...LEVELS, ...BIG_LEVELS]) {
      const cc = compileLevel(def), r = launchRange(cc), top = cc.height / cc.frame.unit;
      expect(r.low, def.id).toBe(Math.round(def.launcher.y * 4));
      expect(r.high / 4, def.id).toBeGreaterThanOrEqual(top + LAUNCH_ABOVE_TOP);
      expect(r.high / 4, def.id).toBeLessThan(top + LAUNCH_ABOVE_TOP + 0.25);
      expect(r.high, def.id).toBeGreaterThan(r.low);
      expect(r.top / 4, def.id).toBeGreaterThanOrEqual(top + LAUNCH_MAX_ABOVE_TOP);
      expect(launchHeight(cc, 'high')).toBe(r.high);
      expect(launchHeight(cc, 'level')).toBe(r.low);
      expect(launchStep(cc, r.high, 1)).toBe(r.high + LAUNCH_STEP);
      expect(launchStep(cc, r.high, -1)).toBe(Math.max(r.low, r.high - LAUNCH_STEP));
      expect(launchStep(cc, r.high, -1000)).toBe(r.low);
      expect(launchStep(cc, r.high, 1000)).toBe(r.top);
    }
    // L1's tower is 10 h: shots now leave from 12 h (6 m) instead of 2 h (1 m).
    expect(launchRange(c)).toMatchObject({ low: 8, high: 48 });
    // A shot from the high launcher records its height, and the boulder still leaves clear of the ground.
    expect(shotFor(c, 'cannonball', 360, 100, [0, 2, 0], SUBSTEPS, 48)!.shot).toMatchObject({ y: 48 });
    expect(launchY(c, 'p-boulder', 8)).toBe(27);
    expect(launchY(c, 'p-boulder', 48)).toBe(48);
  });

  it('a shot at the top of the structure clears a 2 h rubble pile anywhere between the launcher and the lot, where one from the level\'s launcher does not', () => {
    // A pile in front of the structure: anything 2 h high on the ground outside the lot. The arc from the
    // launcher to where it passes the target, while it is outside the lot, must stay over it.
    const lowest = (cc: ReturnType<typeof compileLevel>, at: number, az: number, ammo: 'cannonball' | 'marble') => {
      const hh = cc.frame.unit, target: Vec3 = [cc.frame.centre[0], cc.height - 0.25 * hh, cc.frame.centre[1]];
      const a = shotFor(cc, ammo, az, 100, target, SUBSTEPS, at)!;
      const arc = predictArc(shotToSpawn(cc.frame, a.shot, 0), [0, -GRAVITY, 0], cc.scene.dt, 240, SUBSTEPS);
      let low = Infinity;
      for (let k = 0; 3 * k < arc.length; k++) {
        if (!outsideLot(cc, arc[3 * k]!, arc[3 * k + 2]!)) break;
        low = Math.min(low, arc[3 * k + 1]! / hh);
      }
      return { low, reachable: a.reachable };
    };
    for (const def of [...LEVELS, ...BIG_LEVELS]) {
      const cc = compileLevel(def);
      for (const az of [0, 180, 360, 540]) for (const ammo of ['cannonball', 'marble'] as const) {
        if (!cc.def.rack.includes(ammo) && def.id.startsWith('L')) continue;
        const hi = lowest(cc, launchHeight(cc, 'high'), az, ammo);
        expect(hi.reachable, `${def.id} ${ammo} az ${az}`).toBe(true);
        expect(hi.low, `${def.id} ${ammo} az ${az}`).toBeGreaterThan(2);
      }
    }
    // On L1 the level's launcher (2 h, 1 m) starts no higher than such a pile: the shot runs into it.
    expect(lowest(c, launchHeight(c, 'level'), 360, 'cannonball').low).toBeLessThanOrEqual(2);
  });

  it('from high, the structure\'s base is still in reach at full power (the launcher does not shoot over everything)', () => {
    for (const def of [...LEVELS, ...BIG_LEVELS]) {
      const cc = compileLevel(def), hh = cc.frame.unit;
      for (const az of [0, 360]) {
        const a = shotFor(cc, 'cannonball', az, 100, [cc.frame.centre[0], 0.5 * hh, cc.frame.centre[1]], SUBSTEPS, launchHeight(cc, 'high'))!;
        expect(a.reachable, `${def.id} az ${az}: misses by ${a.error.toFixed(2)} m`).toBe(true);
      }
    }
  });
});

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
  it('looks through a pulled (removed) body to the one behind it', () => {
    const s = atHome(), ray = { origin: [-20, 5.5 * h, 0.2] as Vec3, dir: [1, 0, 0] as Vec3 };
    const first = pick(ray, s, c)!;
    s.tier = new Uint8Array(s.count);
    s.tier[first.body] = TIER_FREE;
    const behind = pick(ray, s, c)!;
    expect(behind.body).not.toBe(first.body);
    expect(behind.point[0]).toBeGreaterThan(first.point[0] + 0.9 * h);
  });
});

describe('pull aim', () => {
  const se = new Session(c);
  const s = atHome();
  it('aims a pull at the block under the cursor; a crown is aimed but refused; the ground or nothing aims none', () => {
    const side = pick({ origin: [-20, 5.5 * h, 0.2], dir: [1, 0, 0] }, s, c)!;
    expect(pullFor(se, side)).toEqual({ shot: { ammo: 'pull', body: side.body }, error: 0, reachable: true, refusal: null });
    const top = pick({ origin: [0.1, 50, 0.1], dir: [0, -1, 0] }, s, c)!;
    const crown = pullFor(se, top)!;
    expect(crown.reachable).toBe(false);
    expect(crown.refusal).toMatch(/is a crown/);
    expect(pullFor(se, pick({ origin: [10, 5, 10], dir: dir([0, -1, 1]) }, s, c))).toBeNull();
    expect(pullFor(se, null)).toBeNull();
    expect(shotFor(c, 'pull', 0, 50, [0, 1, 0])).toBeNull();
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
