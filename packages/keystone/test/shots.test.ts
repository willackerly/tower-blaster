import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { massOf } from '@tb/engine-api';
import { aimAt, ammoKE, closestApproach, compileLevel, decodeRecord, encodeRecord, GRAVITY, L1, launchDir, predictArc, type SessionRecord, type Shot, shotToSpawn, speedOf } from '@tb/keystone';

const c = compileLevel(L1);
const f = c.frame;

describe('shots', () => {
  it('launch direction: az points from the launcher to the lot centre, yaw turns, pitch raises', () => {
    const d = launchDir(0, 0, 0); // launcher on +x, fires toward -x
    expect(d[0]).toBeCloseTo(-1, 12); expect(d[1]).toBeCloseTo(0, 12);
    const up = launchDir(0, 0, 450);
    expect(up[1]).toBeCloseTo(Math.SQRT1_2, 12);
    const turned = launchDir(0, 900, 0);
    expect(turned[2]).toBeCloseTo(-1, 12);
  });
  it('quantisation is exact: integer shots map to identical spawns every time', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 719 }), fc.integer({ min: 0, max: 40 }), fc.integer({ min: -300, max: 300 }), fc.integer({ min: -400, max: 800 }), fc.integer({ min: 0, max: 100 }), (az, y, yaw, pitch, power) => {
      const s: Shot = { ammo: 'marble', az, y, yaw, pitch, power };
      expect(shotToSpawn(f, s, 7)).toEqual(shotToSpawn(f, structuredClone(s), 7));
      const v = shotToSpawn(f, s, 0).body.linVel;
      expect(Math.hypot(...v)).toBeCloseTo(speedOf('marble', power), 9);
    }));
  });
  it('rejects non-integer or out-of-range shots', () => {
    expect(() => shotToSpawn(f, { ammo: 'marble', az: 0.5, y: 0, yaw: 0, pitch: 0, power: 0 }, 0)).toThrow(/az/);
    expect(() => shotToSpawn(f, { ammo: 'cue', x: 0, y: 0, z: 0, dir: 0, power: 101 }, 0)).toThrow(/power/);
  });
  it('cue rods lie along their push direction and stand off the target point', () => {
    const ev = shotToSpawn(f, { ammo: 'cue', x: 0, y: 4, z: 0, dir: 2, power: 100 }, 0);
    expect(ev.body.shape).toEqual({ kind: 'box', half: [0.05, 0.05, 0.6] });
    expect(ev.body.pos[2]).toBeCloseTo(-(0.6 + 0.05), 12);
    expect(ev.body.linVel).toEqual([0, 0, 5]);
  });
  it('energy: kinetic for launched ammo, potential above the ground for a drop', () => {
    const m = shotToSpawn(f, { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 100 }, 0);
    expect(ammoKE(m)).toBeCloseTo(0.5 * massOf(m.body) * 15 * 15, 9);
    const d = shotToSpawn(f, { ammo: 'drop', x: 0, z: 0 }, 0);
    expect(ammoKE(d)).toBeCloseTo(massOf(d.body) * GRAVITY * L1.launcher.dropY * f.unit, 9);
  });
  it('predictArc is semi-implicit Euler: v += g dt, then x += v dt', () => {
    const ev = shotToSpawn(f, { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 300, power: 50 }, 0);
    const arc = predictArc(ev, [0, -GRAVITY, 0], 1 / 60, 2);
    const v0 = ev.body.linVel, p0 = ev.body.pos, dt = 1 / 60;
    expect(arc[4]).toBeCloseTo(p0[1] + (v0[1] - GRAVITY * dt) * dt, 12);
    expect(arc[7]).toBeCloseTo(p0[1] + (v0[1] - GRAVITY * dt) * dt + (v0[1] - 2 * GRAVITY * dt) * dt, 12);
  });
  it('aimAt: for reachable targets the chosen arc passes within one pitch quantum of the target', () => {
    fc.assert(fc.property(fc.double({ min: -1.5, max: 1.5, noNaN: true }), fc.double({ min: 0.3, max: 5, noNaN: true }), fc.double({ min: -1.5, max: 1.5, noNaN: true }), fc.integer({ min: 0, max: 719 }), (x, y, z, az) => {
      const a = aimAt(f, 'cannonball', { az, y: 8, power: 100 }, [x, y, z]);
      // One quantum (0.1 deg) of pitch or yaw moves the arc by about range * 0.00175 rad.
      const range = Math.hypot(x - 7.14 * Math.cos(az * Math.PI / 360), z - 7.14 * Math.sin(az * Math.PI / 360));
      expect(a.error).toBeLessThan(range * 0.0018 + 0.01);
    }), { numRuns: 25 });
  });
  it('closestApproach measures distance to segments, not just samples', () => {
    expect(closestApproach(Float64Array.from([0, 0, 0, 10, 0, 0]), [5, 1, 0])).toBeCloseTo(1, 12);
  });
});

describe('session records', () => {
  const rec: SessionRecord = {
    v: 1, level: 'L1', levelHash: c.hash, engine: 'rapier 0.21.0',
    inputs: [
      { step: 90, shot: { ammo: 'cannonball', az: 360, y: 8, yaw: -13, pitch: 429, power: 60 } },
      { step: 412, shot: { ammo: 'marble', az: 719, y: 0, yaw: 1800, pitch: -890, power: 100 } },
      { step: 800, shot: { ammo: 'cue', x: -40, y: 6, z: 3, dir: 3, power: 0 } },
      { step: 1201, shot: { ammo: 'drop', x: 46, z: -4 } },
      { step: 1500, shot: { ammo: 'marble', az: 1, y: 3, yaw: 0, pitch: 0, power: 1 } },
      { step: 1900, shot: { ammo: 'cannonball', az: 540, y: 40, yaw: 26, pitch: 516, power: 99 } },
    ],
  };
  it('round-trips exactly', () => expect(decodeRecord(encodeRecord(rec))).toEqual(rec));
  it('fits six shots in 200 bytes, as a URL-safe string', () => {
    const s = encodeRecord(rec);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('rejects unknown versions and truncated input', () => {
    expect(() => decodeRecord(encodeRecord({ ...rec, v: 2 as 1 }))).toThrow(/version/);
    expect(() => decodeRecord(encodeRecord(rec).slice(0, 20))).toThrow();
  });
});

describe('aimAt search', () => {
  it('coarse-to-fine finds the same error as an exhaustive pitch sweep', () => {
    fc.assert(fc.property(fc.double({ min: -1.5, max: 1.5, noNaN: true }), fc.double({ min: 0.3, max: 6, noNaN: true }), fc.integer({ min: 0, max: 719 }), fc.integer({ min: 20, max: 100 }), (x, y, az, power) => {
      const a = aimAt(f, 'marble', { az, y: 4, power }, [x, y, 0], { substeps: 4 });
      let best = Infinity;
      for (let pitch = -450; pitch <= 800; pitch++) {
        const ev = shotToSpawn(f, { ...a.shot, pitch }, 0);
        best = Math.min(best, closestApproach(predictArc(ev, [0, -GRAVITY, 0], 1 / 60, 240, 4), [x, y, 0]));
      }
      expect(a.error).toBeLessThanOrEqual(best + 0.01);
    }), { numRuns: 15 });
  });
});
