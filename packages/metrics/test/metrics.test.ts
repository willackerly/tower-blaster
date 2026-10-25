import { describe, expect, it } from 'vitest';
import { type BodyDesc, emptySnapshot, type Snapshot } from '@tb/engine-api';
import { quatFromAxisAngle, rotate } from '@tb/geom';
import {
  bootstrapCI, drift, driftSuspect, energy, energyGain, jitter, linearFit, loglogFit, median, momentum,
  nonFinite, pairedPercentDiff, penetration, quantile, sleepRatio, stateHash, survival, verdict,
} from '../src/index.ts';

const cubeDesc = (tag = 0, half: [number, number, number] = [0.5, 0.5, 0.5]): BodyDesc => ({
  shape: { kind: 'box', half }, pos: [0, 0, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag,
});

function snap(states: Array<{ p: number[]; q?: number[]; v?: number[]; w?: number[]; awake?: boolean }>): Snapshot {
  const s = emptySnapshot(states.length);
  states.forEach((st, i) => {
    s.pos.set(st.p, 3 * i);
    s.rot.set(st.q ?? [0, 0, 0, 1], 4 * i);
    s.linVel.set(st.v ?? [0, 0, 0], 3 * i);
    s.angVel.set(st.w ?? [0, 0, 0], 3 * i);
    s.awake[i] = st.awake === false ? 0 : 1;
  });
  return s;
}

describe('quality metrics: known answers', () => {
  it('penetration finds pair and ground overlaps and ignores touching', () => {
    const bodies = [cubeDesc(), cubeDesc(), cubeDesc()];
    const s = snap([{ p: [0, 0.5, 0] }, { p: [0.9, 0.5, 0] }, { p: [0, 1.5, 0] }]); // 0.1 overlap, touching, on ground
    const r = penetration(bodies, s, 0);
    expect(r.contacts).toBe(1);
    expect(r.max).toBeCloseTo(0.1, 9);
    const sunk = penetration(bodies, snap([{ p: [0, 0.47, 0] }, { p: [5, 0.5, 0] }, { p: [9, 0.5, 0] }]), 0);
    expect(sunk.max).toBeCloseTo(0.03, 9);
  });

  it('drift is the largest horizontal move; vertical settling is ignored', () => {
    const a = snap([{ p: [0, 1, 0] }, { p: [1, 1, 0] }]);
    const b = snap([{ p: [0.03, 0.2, 0.04] }, { p: [1, 1, 0] }]);
    expect(drift(a, b)).toBeCloseTo(0.05, 12);
  });

  it('jitter combines linear and scaled angular speed', () => {
    const s = snap([{ p: [0, 0, 0], v: [3, 0, 4] }, { p: [0, 0, 0], w: [0, 2, 0] }]);
    expect(jitter(s)).toBeCloseTo(Math.sqrt((25 + 0.25 * 4) / 2), 12);
  });

  it('energy: translation, rotation (frame independent for a cube) and height', () => {
    const b = [cubeDesc()];
    const e = energy(b, snap([{ p: [0, 2, 0], v: [3, 0, 0], w: [0, 2, 0] }]), [0, -9.81, 0]);
    expect(e.kinetic).toBeCloseTo(4.5 + 0.5 * (1 / 6) * 4, 12);
    expect(e.potential).toBeCloseTo(9.81 * 2, 12);
    const q = quatFromAxisAngle([1, 1, 0], 0.9);
    const e2 = energy(b, snap([{ p: [0, 2, 0], q, v: [3, 0, 0], w: [0, 2, 0] }]), [0, -9.81, 0]);
    expect(e2.kinetic).toBeCloseTo(e.kinetic, 12);
  });

  it('energy uses the body-frame inertia for non-cubic boxes', () => {
    const plate = [cubeDesc(0, [2, 0.1, 2])]; // mass 8 * 2 * 0.1 * 2 = 3.2
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2); // body y now points along world -x
    const wWorld = rotate(q, [0, 1, 0]); // spin about the body's thin axis
    const e = energy(plate, snap([{ p: [0, 0, 0], q, w: wWorld }]), [0, 0, 0]);
    const Iy = (3.2 / 3) * (2 * 2 + 2 * 2);
    expect(e.kinetic).toBeCloseTo(0.5 * Iy, 9);
  });

  it('energyGain, momentum, survival, sleepRatio, nonFinite', () => {
    expect(energyGain([10, 9, 10.5, 8])).toBeCloseTo(0.05, 12);
    expect(energyGain([10, 9, 8])).toBe(0);
    expect(momentum([cubeDesc(), cubeDesc()], snap([{ p: [0, 0, 0], v: [1, 0, 0] }, { p: [0, 0, 0], v: [-3, 2, 0] }]))).toEqual([-2, 2, 0]);
    const towers = [cubeDesc(0), cubeDesc(0), cubeDesc(1)];
    const s0 = snap([{ p: [0, 0.5, 0] }, { p: [0, 1.5, 0] }, { p: [5, 0.5, 0] }]);
    const s1 = snap([{ p: [0, 0.5, 0] }, { p: [0.2, 0.75, 0] }, { p: [5, 0.5, 0] }]);
    expect(survival(towers, s0, s1, [0, 1])).toBeCloseTo(0.75 / 1.5, 12);
    expect(sleepRatio(snap([{ p: [0, 0, 0], awake: false }, { p: [0, 0, 0] }]))).toBe(0.5);
    const bad = snap([{ p: [NaN, 0, Infinity] }]);
    expect(nonFinite(bad)).toBe(2);
  });

  it('stateHash is stable, order sensitive and f32 resolution', () => {
    const a = snap([{ p: [1, 2, 3] }, { p: [4, 5, 6] }]);
    const b = snap([{ p: [4, 5, 6] }, { p: [1, 2, 3] }]);
    expect(stateHash(a)).toBe(stateHash(snap([{ p: [1, 2, 3] }, { p: [4, 5, 6] }])));
    expect(stateHash(a)).not.toBe(stateHash(b));
    expect(stateHash(snap([{ p: [1 + 1e-12, 2, 3] }, { p: [4, 5, 6] }]))).toBe(stateHash(a));
    expect(stateHash(snap([{ p: [1 + 1e-6, 2, 3] }, { p: [4, 5, 6] }]))).not.toBe(stateHash(a));
  });
});

// Deterministic normal samples for statistical calibration tests.
function normals(seed: number, n: number, mu = 0, sigma = 1): number[] {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  return Array.from({ length: n }, () => mu + sigma * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
}

describe('statistics', () => {
  it('quantile matches R type 7', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(xs, 0.99)).toBeCloseTo(99.01, 12);
    expect(median([3, 1, 2, 4])).toBe(2.5);
  });

  it('bootstrap CI for the median has roughly nominal coverage', () => {
    let covered = 0;
    const trials = 200;
    for (let t = 0; t < trials; t++) {
      const ci = bootstrapCI(normals(1000 + t, 60, 10, 2), median, { iters: 600, seed: t + 1 });
      if (ci.lo <= 10 && 10 <= ci.hi) covered++;
    }
    expect(covered / trials).toBeGreaterThan(0.88);
    expect(covered / trials).toBeLessThan(0.995);
  });

  it('A/A comparisons rarely claim a difference; a 10% slowdown is detected', () => {
    let falseAlarms = 0;
    for (let t = 0; t < 100; t++) {
      const a = normals(5000 + t, 12, 10, 0.3), b = normals(9000 + t, 12, 10, 0.3);
      if (verdict(pairedPercentDiff(a, b, { iters: 800, seed: t })) !== 'no-difference') falseAlarms++;
    }
    expect(falseAlarms).toBeLessThan(12);
    const a = normals(1, 12, 10, 0.3);
    const slow = pairedPercentDiff(a, a.map((x, i) => x * 1.1 + 0.01 * (i % 3)));
    expect(verdict(slow)).toBe('slower');
    expect(slow.estimate).toBeCloseTo(0.1, 1);
  });

  it('paired resampling cancels drift shared by A and B', () => {
    // Both series drift upward 30% over the run; B is 3% faster throughout.
    const a = Array.from({ length: 12 }, (_, i) => 10 * (1 + 0.025 * i));
    const b = a.map((x) => x * 0.97);
    const d = pairedPercentDiff(a, b);
    expect(verdict(d)).toBe('faster');
    expect(d.estimate).toBeCloseTo(-0.03, 6);
  });

  it('fits scaling exponents', () => {
    const ns = [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5];
    expect(loglogFit(ns, ns.map((n) => 3e-4 * n)).slope).toBeCloseTo(1, 9);
    expect(loglogFit(ns, ns.map((n) => n * n)).slope).toBeCloseTo(2, 9);
    const nlogn = loglogFit(ns, ns.map((n) => n * Math.log2(n))).slope;
    expect(nlogn).toBeGreaterThan(1.05);
    expect(nlogn).toBeLessThan(1.12);
    const lin = linearFit(ns, ns.map((n) => 0.5 + 2e-4 * n));
    expect(lin.t0).toBeCloseTo(0.5, 9);
    expect(lin.perBody).toBeCloseTo(2e-4, 12);
  });

  it('flags drift within a block', () => {
    expect(driftSuspect(Array.from({ length: 40 }, (_, i) => 10 + 0.05 * i))).toBe(true);
    expect(driftSuspect(Array.from({ length: 40 }, (_, i) => 10 + 0.01 * (i % 2)))).toBe(false);
  });
});
