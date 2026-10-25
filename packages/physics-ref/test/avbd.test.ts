import { describe, expect, it } from 'vitest';
import { type BodyDesc, bodiesAt, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { drift, energy, jitter, nonFinite, penetration, survival } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { AvbdReferenceEngine, type AvbdParams, colorGraph, outranks, solveSpd6, tangentBasis } from '../src/index.ts';

const cube = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0,
});
const sceneOf = (bodies: BodyDesc[], gravity: Vec3 = [0, -9.81, 0]): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity, dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: false, bodies, inputs: [],
});
async function simulate(scene: SceneDesc, steps: number, params: Partial<AvbdParams> = {}) {
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  const s0 = e.snapshot();
  for (let i = 0; i < steps; i++) e.step();
  return { e, s0, s1: e.snapshot() };
}
const all = (n: number) => Array.from({ length: n }, (_, i) => i);
const G = 9.81, MU = 0.6;

describe('building blocks', () => {
  it('solveSpd6 solves random SPD systems', () => {
    let seed = 3;
    const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    for (let t = 0; t < 200; t++) {
      const B = Array.from({ length: 36 }, r), A = new Float64Array(36);
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        let s = i === j ? 1e-3 : 0;
        for (let k = 0; k < 6; k++) s += B[6 * k + i]! * B[6 * k + j]!;
        A[6 * i + j] = s;
      }
      const x = Array.from({ length: 6 }, r), b = new Float64Array(6), out = new Float64Array(6);
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) b[i] = b[i]! + A[6 * i + j]! * x[j]!;
      solveSpd6(A, b, out);
      for (let i = 0; i < 6; i++) expect(out[i]).toBeCloseTo(x[i]!, 6);
    }
  });

  it('colouring is proper and equals parallel Jones-Plassmann rounds', () => {
    // Random graph of degree ~10 on 500 nodes.
    let seed = 5;
    const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const n = 500, adj: Array<Set<number>> = Array.from({ length: n }, () => new Set());
    for (let e = 0; e < 2500; e++) {
      const a = Math.floor(r() * n), b = Math.floor(r() * n);
      if (a !== b) { adj[a]!.add(b); adj[b]!.add(a); }
    }
    const lists = adj.map((s) => [...s]);
    const greedy = colorGraph(lists);
    for (let v = 0; v < n; v++) for (const u of lists[v]!) expect(greedy[u]).not.toBe(greedy[v]);
    // Jones-Plassmann, simulated round by round as the GPU will run it.
    const jp = new Int32Array(n).fill(-1);
    let rounds = 0;
    while (jp.includes(-1)) {
      rounds++;
      const ready = all(n).filter((v) => jp[v] === -1 && lists[v]!.every((u) => jp[u] !== -1 || outranks(v, u)));
      const next = ready.map((v) => {
        const used = new Set(lists[v]!.map((u) => jp[u]!));
        let c = 0;
        while (used.has(c)) c++;
        return c;
      });
      ready.forEach((v, k) => { jp[v] = next[k]!; });
    }
    expect([...jp]).toEqual([...greedy]);
    expect(rounds).toBeLessThan(40);
  });

  it('tangent basis is orthonormal for lattice and random normals', () => {
    const normals: Vec3[] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.6, 0.8, 0], [0.267261, 0.534522, 0.801784]];
    for (const raw of normals) {
      const l = Math.hypot(...raw), n: Vec3 = [raw[0] / l, raw[1] / l, raw[2] / l];
      const [t1, t2] = tangentBasis(n);
      const d = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      expect(d(t1, t1)).toBeCloseTo(1, 12);
      expect(d(t2, t2)).toBeCloseTo(1, 12);
      expect(d(t1, n)).toBeCloseTo(0, 12);
      expect(d(t2, n)).toBeCloseTo(0, 12);
      expect(d(t1, t2)).toBeCloseTo(0, 12);
    }
  });
});

describe('single bodies against analytic results', () => {
  it('a resting cube stays put', async () => {
    const { s1 } = await simulate(sceneOf([cube([0, 0.5, 0])]), 120);
    expect(Math.abs(s1.pos[1]! - 0.5)).toBeLessThan(1e-4);
    expect(Math.hypot(s1.linVel[0]!, s1.linVel[1]!, s1.linVel[2]!)).toBeLessThan(1e-6);
    expect(Math.abs(s1.rot[3]!)).toBeGreaterThan(1 - 1e-12);
  });

  it('a dropped cube lands without bouncing or gaining energy', async () => {
    const scene = sceneOf([cube([0, 2, 0])]);
    const e = new AvbdReferenceEngine();
    await e.init(scene);
    const e0 = energy(scene.bodies, e.snapshot(), scene.gravity).total;
    let landed = -1, maxAfter = 0;
    for (let i = 0; i < 120; i++) {
      e.step();
      const s = e.snapshot();
      expect(energy(scene.bodies, s, scene.gravity).total).toBeLessThan(e0 + 1e-6);
      if (landed < 0 && s.pos[1]! < 0.51) landed = i;
      if (landed >= 0) maxAfter = Math.max(maxAfter, s.pos[1]!);
    }
    // Free fall from 1.5 m above contact takes sqrt(2 * 1.5 / g) = 0.553 s, step 33.
    // A speculative contact must not stop it early (it would hover, then creep down).
    expect(landed).toBeGreaterThanOrEqual(31);
    expect(landed).toBeLessThanOrEqual(34);
    expect(maxAfter).toBeLessThan(0.51);
    expect(Math.abs(e.snapshot().pos[1]! - 0.5)).toBeLessThan(1e-3);
  });

  // Implicit Euler with Coulomb friction: v drops by mu g h per step, x
  // advances by h v_(k+1), so the discrete stopping distance is
  // h * sum_k max(0, v0 - k mu g h).
  const stopping = (v0: number, h = 1 / 60) => {
    let x = 0;
    for (let v = v0 - MU * G * h; v > 0; v -= MU * G * h) x += h * v;
    return x;
  };
  it.for([[3, 0], [0, 3], [2.1213, 2.1213], [-1.5, 2.598]] as const)('a cube sliding at (%s, %s) stops where Coulomb friction says, in a straight line', async ([vx, vz]) => {
    const { s1 } = await simulate(sceneOf([cube([0, 0.5, 0], [vx, 0, vz])]), 120);
    const d = Math.hypot(s1.pos[0]!, s1.pos[2]!);
    expect(d / stopping(Math.hypot(vx, vz))).toBeGreaterThan(0.97);
    expect(d / stopping(Math.hypot(vx, vz))).toBeLessThan(1.03);
    const off = Math.atan2(s1.pos[2]!, s1.pos[0]!) - Math.atan2(vz, vx);
    expect(Math.abs(off)).toBeLessThan(3e-3); // 0.17 degrees
  });

  it('sliding friction needs the cone-projection Hessian at low iteration counts', async () => {
    // Ablation: with k J J^T on sliding friction rows (the 2D reference's choice), 4 iterations slide ~2x too far.
    const scene = sceneOf([cube([0, 0.5, 0], [3, 0, 0])]);
    const exact = await simulate(scene, 120, { iterations: 4 });
    const plain = await simulate(scene, 120, { iterations: 4, slidingHessian: false });
    expect(Math.abs(exact.s1.pos[0]! / stopping(3) - 1)).toBeLessThan(0.03);
    expect(plain.s1.pos[0]! / stopping(3)).toBeGreaterThan(1.5);
  });

  // Tilting gravity by theta turns the ground into an incline.
  const tilted = (theta: number): Vec3 => [G * Math.sin(theta), -G * Math.cos(theta), 0];
  it('on an incline below the friction angle a cube sticks', async () => {
    const { s1 } = await simulate(sceneOf([cube([0, 0.5, 0])], tilted(Math.atan(0.5))), 120);
    expect(Math.abs(s1.pos[0]!)).toBeLessThan(1e-3);
  });
  it('above the friction angle it slides at g (sin - mu cos)', async () => {
    const theta = Math.atan(0.8), T = 1;
    const { s1 } = await simulate(sceneOf([cube([0, 0.5, 0])], tilted(theta)), 60 * T);
    const a = G * (Math.sin(theta) - MU * Math.cos(theta));
    expect(s1.linVel[0]! / (a * T)).toBeGreaterThan(0.95);
    expect(s1.linVel[0]! / (a * T)).toBeLessThan(1.05);
    expect(Math.abs(s1.linVel[2]!)).toBeLessThan(1e-6);
  });
});

describe('stacks and towers', () => {
  it('a 10-cube stack stands for 5 s', async () => {
    const scene = buildScenario('S9', { H: 10, ratio: 1 }, 1);
    const { s0, s1 } = await simulate(scene, 300);
    expect(survival(scene.bodies, s0, s1, [0, 1])).toBeGreaterThan(0.999);
    expect(drift(s0, s1)).toBeLessThan(1e-4);
    expect(penetration(scene.bodies, s1, 0).max).toBeLessThan(1e-3);
  });

  it('a 100:1 mass ratio stack holds without NaNs', async () => {
    const scene = buildScenario('S9', { H: 10, ratio: 100 }, 1);
    const { s0, s1 } = await simulate(scene, 300);
    expect(nonFinite(s1)).toBe(0);
    expect(survival(scene.bodies, s0, s1, [0, 1])).toBeGreaterThan(0.99);
    expect(penetration(scene.bodies, s1, 0).max).toBeLessThan(0.01);
  });

  it('a 3x3x8 tower stands still for 2 s without gaining energy', async () => {
    const scene = buildScenario('S1', { F: 3, H: 8, gap: 0 }, 1);
    const e = new AvbdReferenceEngine();
    await e.init(scene);
    const s0 = e.snapshot();
    const e0 = energy(scene.bodies, s0, scene.gravity).total;
    let eMax = e0;
    for (let i = 0; i < 120; i++) {
      e.step();
      if (i % 10 === 9) eMax = Math.max(eMax, energy(scene.bodies, e.snapshot(), scene.gravity).total);
    }
    const s1 = e.snapshot();
    expect(survival(scene.bodies, s0, s1, [0])).toBeGreaterThan(0.999);
    expect(drift(s0, s1, all(s1.count))).toBeLessThan(1e-3);
    expect(jitter(s1)).toBeLessThan(1e-3);
    expect(penetration(scene.bodies, s1, 0).max).toBeLessThan(1e-3);
    expect((eMax - e0) / Math.abs(e0)).toBeLessThan(1e-3);
  });

  // Same scene in Rapier: survival 0.30, ball rebounds at -4.1 m/s, worst
  // transient penetration 0.14 (cubes falling at 12-15 m/s move 0.25 per step).
  const knockdown = async (params: Partial<AvbdParams>) => {
    const scene = buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed: 15, massRatio: 5, radius: 0.6 }, 1);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    e.step();
    const bodies = bodiesAt(scene, 1), ball = bodies.length - 1;
    const s0 = e.snapshot();
    let maxPen = 0;
    for (let i = 0; i < 180; i++) {
      e.step();
      maxPen = Math.max(maxPen, penetration(bodies, e.snapshot(), 0).max);
    }
    const s1 = e.snapshot();
    return { s1, survival: survival(bodies, s0, s1, [0]), ballVx: s1.linVel[3 * ball]!, maxPen };
  };
  it('a ball knocks a slender tower down, with speculative margins keeping impacts shallow', async () => {
    const r = await knockdown({});
    expect(nonFinite(r.s1)).toBe(0);
    expect(r.survival).toBeLessThan(0.5);
    expect(r.ballVx).toBeLessThan(-2);
    expect(r.maxPen).toBeLessThan(0.03);
    // Ablation: a fixed margin lets fast cubes land 0.1+ deep, as in Rapier.
    expect((await knockdown({ sweep: false })).maxPen).toBeGreaterThan(0.1);
  });

  it('is deterministic', async () => {
    const scene = buildScenario('S11', { N: 40 }, 7);
    const a = await simulate(scene, 60), b = await simulate(scene, 60);
    expect([...a.s1.pos]).toEqual([...b.s1.pos]);
    expect([...a.s1.rot]).toEqual([...b.s1.rot]);
  });
});
