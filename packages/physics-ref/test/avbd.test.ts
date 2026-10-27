import { describe, expect, it } from 'vitest';
import { type BodyDesc, bodiesAt, type CombineRule, freeFlight, type InputEvent, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { drift, energy, jitter, nonFinite, penetration, survival } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { appliedMu, slideMu, slideScene, THROW, throwScene } from '@tb/testkit';
import { AvbdReferenceEngine, type AvbdParams, colorGraph, DEFAULT_AVBD, froudeParams, GROUND, outranks, solveSpd6, tangentBasis } from '../src/index.ts';

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

  it('sliding friction needs the secant stiffness at low iteration counts', async () => {
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

// The stick/slip boundary. Before the secant stiffness and the dual-branch
// stick flag (2026-10-25), a cube that slid to a stop never settled: its
// contacts sat on the cone boundary, the friction Hessian flipped between k_t
// and 0 along the slide, and the cube spun at up to 0.66 rad/s and crept up
// to 14 mm, so its pose depended on rounding (a GPU test failed on one
// platform only). Each test below fails on that code.
describe('friction at the stick/slip boundary', () => {
  const box = (pos: Vec3, half: Vec3, linVel: Vec3 = [0, 0, 0], angVel: Vec3 = [0, 0, 0], friction = MU): BodyDesc => ({
    shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel, angVel, density: 1, friction, restitution: 0, tag: 0,
  });
  const stopping = (v0: number) => {
    let x = 0;
    for (let v = v0 - MU * G / 60; v > 0; v -= MU * G / 60) x += v / 60;
    return x;
  };
  const speedOf = (v: Vec3) => Math.hypot(v[0], v[2]);
  const yawOf = (q: readonly number[]) => 2 * Math.atan2(q[1]!, q[3]!);
  /** Slide a cube from the origin; measure from 10 steps after it stops (speed < 1 cm/s) to step 240. */
  async function slideToRest(v: Vec3, params: Partial<AvbdParams> = {}) {
    const e = new AvbdReferenceEngine(params);
    await e.init(sceneOf([cube([0, 0.5, 0], v)]));
    const b = e.world!.bodies[0]!;
    let stop = -1, dStop = 0, maxW = 0, maxV = 0, p0: Vec3 = [0, 0, 0], yaw0 = 0;
    for (let s = 1; s <= 240; s++) {
      e.step();
      if (stop < 0 && speedOf(b.linVel) < 1e-2) [stop, dStop] = [s, Math.hypot(b.pos[0], b.pos[2])];
      if (stop > 0 && s === stop + 10) [p0, yaw0] = [[...b.pos], yawOf(b.rot)];
      if (stop > 0 && s > stop + 10) [maxW, maxV] = [Math.max(maxW, Math.hypot(...b.angVel)), Math.max(maxV, Math.hypot(...b.linVel))];
    }
    const off = Math.atan2(b.pos[2], b.pos[0]) - Math.atan2(v[2], v[0]);
    return { stop, dStop, maxW, maxV, creep: Math.hypot(b.pos[0] - p0[0], b.pos[2] - p0[2]), yawDrift: Math.abs(yawOf(b.rot) - yaw0), off: Math.atan2(Math.sin(off), Math.cos(off)) };
  }
  const at = (speed: number, deg: number): Vec3 => [Math.fround(speed * Math.cos((deg * Math.PI) / 180)), 0, Math.fround(speed * Math.sin((deg * Math.PI) / 180))];

  // Baseline worst cases over 72 slides: 0.66 rad/s, 14 mm, 3.3 deg, 0.073 rad. Now: 2.6e-7, 1.8e-5 mm, 3e-11 deg, 1.1e-5.
  it.for([[3, 15], [3, 120], [6, 0], [1.5, 45], [3, 255], [6, 200]] as const)('a cube slid at %s m/s, %s deg comes to rest: no spin, creep or yaw drift', async ([speed, deg]) => {
    const r = await slideToRest(at(speed, deg));
    expect(r.stop).toBeGreaterThan(0);
    expect(Math.abs(r.dStop / stopping(speed) - 1)).toBeLessThan(0.01);
    expect(r.maxW).toBeLessThan(1e-4);
    expect(r.maxV).toBeLessThan(1e-4);
    expect(r.creep).toBeLessThan(1e-4);
    expect(r.yawDrift).toBeLessThan(1e-4);
    expect(Math.abs(r.off)).toBeLessThan(1e-4);
  });

  it('where it stops does not depend on rounding: 1-ulp nudges of the start velocity', async () => {
    const nudge = (x: number, k: number) => { const f = new Float32Array([x]); new Int32Array(f.buffer)[0]! += k; return f[0]!; };
    for (const [vx, vz] of [[-1.5, 2.598], [2.9, 0.78]] as const) {
      const offs: number[] = [];
      for (let k = -3; k <= 3; k++) offs.push((await slideToRest([nudge(vx, k), 0, nudge(vz, -k)])).off);
      // Baseline spread (±3 ulp): 2.8e-3 rad at 120 deg (f32 on the GPU: 0.031). Now below 1e-11.
      expect(Math.max(...offs) - Math.min(...offs)).toBeLessThan(1e-6);
    }
  });

  it('a contact that slides for the whole step never holds its anchors', async () => {
    // The old end-of-step test |lambda_t| < mu |lambda_n| passed by rounding for sliding contacts
    // (48-72 of 224 contact-steps), and the stabilization pass then pulled the cube back to stale anchors.
    for (const iterations of [2, 10]) for (const deg of [0, 120]) {
      const e = new AvbdReferenceEngine({ iterations });
      await e.init(sceneOf([cube([0, 0.5, 0], at(6, deg))]));
      let held = 0, sliding = 0;
      for (let s = 0; s < 60; s++) {
        e.step();
        if (speedOf(e.world!.bodies[0]!.linVel) < 0.5) continue;
        sliding++;
        held += e.world!.contacts.filter((c) => c.stick).length;
      }
      expect(sliding).toBeGreaterThan(50);
      expect(held).toBe(0);
    }
  });

  it('a contact never reuses anchors that have drifted apart by stickThreshold, even after an impact at 1-3 iterations', async () => {
    // A fresh contact's k_t is still penaltyMin, so in an impact its trial force can sit inside the
    // cone while it slips at m/s: the in-cone flag alone would keep its anchors. Before the drift was
    // checked at reuse, the next step reused them 1.4-10.8 cm apart and pulled the bodies back.
    const sphere = (pos: Vec3, linVel: Vec3, radius: number, density: number): BodyDesc => ({ ...cube(pos, linVel), shape: { kind: 'sphere', radius }, density, friction: 0.5 });
    const scenes: SceneDesc[] = [
      sceneOf([cube([0, 0.6, 0], [3, -1, 0])]), // lands sliding
      sceneOf([box([0, 0.6, 0], [0.5, 0.5, 0.5], [0, -1, 0], [0, 8, 0])]), // lands spinning
      sceneOf([0, 1, 2, 3].map((k) => cube([0, 0.5 + k, 0])).concat([sphere([-3, 2.5, 0], [10, 0, 0], 0.3, 5)])), // a stack knocked by a ball
    ];
    const threshold = DEFAULT_AVBD.stickThreshold;
    for (const iterations of [1, 2, 3]) for (const scene of scenes) {
      const e = new AvbdReferenceEngine({ iterations });
      await e.init(scene);
      let worst = 0;
      for (let s = 0; s < 60; s++) {
        e.step();
        for (const c of e.world!.contacts) worst = Math.max(worst, Math.hypot(c.c0[1], c.c0[2]));
      }
      expect(worst, `${iterations} iterations, scene ${scenes.indexOf(scene)}`).toBeLessThan(threshold);
    }
  });

  it('a cube spinning on the ground stops on the step Coulomb friction says, and stays stopped', async () => {
    // Four corner contacts at r = sqrt(1/2) carry mu m g / 4 each: alpha = mu m g r / I = 6 r mu g for I = m / 6.
    for (const [mu, w0] of [[1, 10], [0.6, 5], [0.3, 10]] as const) {
      const e = new AvbdReferenceEngine();
      await e.init({ ...sceneOf([box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0], [0, w0, 0], mu)]), ground: { y: 0, friction: mu } });
      const b = e.world!.bodies[0]!;
      let stop = -1, after = 0;
      for (let s = 1; s <= 180; s++) {
        e.step();
        if (stop < 0 && Math.abs(b.angVel[1]) < 1e-2) stop = s;
        if (stop > 0 && s > stop + 10) after = Math.max(after, Math.hypot(...b.angVel), Math.hypot(...b.linVel));
      }
      expect(Math.abs(stop - Math.ceil(w0 / ((6 * Math.SQRT1_2 * mu * G) / 60)))).toBeLessThanOrEqual(1); // baseline: step 135 for (1, 10)
      expect(after).toBeLessThan(1e-4); // baseline: 0.45 rad/s for (0.6, 5)
      expect(Math.hypot(b.pos[0], b.pos[2])).toBeLessThan(1e-4);
    }
  });

  it('a sphere sliding with backspin starts to roll when Coulomb friction says, and keeps rolling', async () => {
    // Slip v + w R falls at mu g (1 + m R^2 / I) = 3.5 mu g.
    for (const R of [0.25, 0.5]) {
      const v0 = 3, w0 = 5 / R;
      const e = new AvbdReferenceEngine();
      await e.init(sceneOf([{ ...cube([0, R, 0], [v0, 0, 0]), shape: { kind: 'sphere', radius: R }, angVel: [0, 0, w0] }]));
      const b = e.world!.bodies[0]!;
      let rolled = -1, late = 0;
      for (let s = 1; s <= 180; s++) {
        e.step();
        const slip = Math.abs(b.linVel[0] + b.angVel[2] * R);
        if (rolled < 0 && slip < 0.05) rolled = s;
        if (s >= 60) late = Math.max(late, slip);
      }
      expect(Math.abs(rolled - (v0 + w0 * R) / (3.5 * MU * G) * 60)).toBeLessThan(2); // analytic 23.3 steps
      expect(late).toBeLessThan(0.025); // baseline R 0.5: a period-2 slip of 0.17-0.52 m/s for 20 s
      // Rolling speed (5 v0 - 2 w0 R) / 7 = 0.714 m/s: exact with rolling contacts; kept anchors drifted up to 1.3 m/s by 3 s.
      expect(Math.abs(b.linVel[0] / ((5 * v0 - 2 * w0 * R) / 7) - 1)).toBeLessThan(0.01);
    }
  });

  // Flat boxes 1 x 0.5 x 1, the bottom pushed at f m_b g along deg; ground capacity mu (m_b + m_t) g = 1.2 m_b g.
  async function pushedStack(f: number, until: number, deg: number) {
    const u = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)] as const;
    const e = new AvbdReferenceEngine();
    await e.init(sceneOf([box([0, 0.25, 0], [0.5, 0.25, 0.5]), box([0, 0.75, 0], [0.5, 0.25, 0.5])]));
    const bottom = e.world!.bodies[0]!, top = e.world!.bodies[1]!;
    for (let s = 1; s <= 300; s++) {
      if (s <= until) bottom.linVel = [bottom.linVel[0] + (f * G * u[0]) / 60, bottom.linVel[1], bottom.linVel[2] + (f * G * u[1]) / 60];
      e.step();
    }
    const along = (p: Vec3) => p[0] * u[0] + p[2] * u[1];
    return { bottom: along(bottom.pos), top: along(top.pos) };
  }
  it.for([0, 30, 120] as const)('a 2-box stack pushed at its bottom box at %s deg: held below static friction, slides as one above it', async (deg) => {
    // 1.3 m_b g for 90 steps: 0.05 g together, then 0.6 g to a stop. Exact implicit Euler: 0.558 m + 0.040 m.
    let v = 0, x = 0;
    for (let s = 1; s <= 300; s++) { v = Math.max(0, v + (s <= 90 ? 0.05 * G : -MU * G) / 60); x += v / 60; }
    const above = await pushedStack(1.3, 90, deg);
    expect(above.bottom / x).toBeGreaterThan(0.95); // now 1.14 at every angle; baseline 0.77-6.1
    expect(above.bottom / x).toBeLessThan(1.2);
    expect(Math.abs(above.top - above.bottom)).toBeLessThan(0.01);
    const below = await pushedStack(1.0, 300, deg);
    expect(Math.abs(below.bottom)).toBeLessThan(0.01); // now 1e-4 m; baseline 1.6-3.1 m
    expect(Math.abs(below.top)).toBeLessThan(0.01);
  });
});

// Rolling contacts (AvbdWorld.collide): a contact on a sphere takes fresh
// points every step, carries slip instead of anchors, and is matched by a
// sphere's world lever arm. With kept anchors (the baselines below) the
// rotated material point read as a gap, so a rolling ball sank and sped up,
// and above matchDistance / h = 3 m/s every step's contact was new, its
// force and penalty restarting from zero.
describe('rolling contacts', () => {
  const R = 0.25;
  const ball = (pos: Vec3, v: number, radius = R): BodyDesc => ({
    shape: { kind: 'sphere', radius }, pos, rot: [0, 0, 0, 1], linVel: [v, 0, 0], angVel: [0, 0, -v / radius], density: 7800, friction: 0.55, restitution: 0, tag: 0,
  });
  const slab = (half: Vec3): BodyDesc => ({ ...cube([0, 0.25, 0]), shape: { kind: 'box', half }, density: 1e4 });
  const rollScene = (bodies: BodyDesc[]): SceneDesc => ({ ...sceneOf(bodies), frictionCombine: 'min' });
  const radiusOf = (d: BodyDesc) => (d.shape as { radius: number }).radius;
  /** Run `steps`; the ball's lowest height above `surface` from step 31 (after the landing transient), final height, velocity, w R. */
  async function roll(scene: SceneDesc, ball: number, steps: number, surface: (e: AvbdReferenceEngine) => number, params: Partial<AvbdParams> = {}) {
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    const b = e.world!.bodies[ball]!, r = radiusOf(scene.bodies[ball]!);
    let low = Infinity;
    for (let s = 1; s <= steps; s++) {
      e.step();
      if (s > 30) low = Math.min(low, b.pos[1] - surface(e) - r);
    }
    return { low, h: b.pos[1] - surface(e) - r, v: b.linVel, wR: -b.angVel[2] * r };
  }
  /**
   * Settle the scene for 60 steps with the ball at rest, then set it rolling along x at v0 (w R = v0) and run `steps`.
   * Worst over the run: the lowest height above `surface`, the change of that height, |v / v0 - 1| and the slip
   * |v + w R| / v0. `path` is x travelled minus the sum of v h: what the stabilization pass moved it (it moves positions only).
   */
  async function rollSettled(scene: SceneDesc, ball: number, v0: number, steps: number, surface: (e: AvbdReferenceEngine) => number, params: Partial<AvbdParams> = {}) {
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    const b = e.world!.bodies[ball]!, r = radiusOf(scene.bodies[ball]!);
    for (let s = 0; s < 60; s++) e.step();
    b.linVel = [v0, 0, 0];
    b.angVel = [0, 0, -v0 / r];
    const y0 = b.pos[1] - surface(e) - r, x0 = b.pos[0];
    let low = Infinity, dy = 0, dv = 0, slip = 0, sum = 0;
    for (let s = 0; s < steps; s++) {
      e.step();
      const y = b.pos[1] - surface(e) - r;
      low = Math.min(low, y);
      dy = Math.max(dy, Math.abs(y - y0));
      dv = Math.max(dv, Math.abs(b.linVel[0] / v0 - 1));
      slip = Math.max(slip, Math.abs(b.linVel[0] + b.angVel[2] * r) / v0);
      sum += b.linVel[0] * scene.dt;
    }
    return { low, dy, dv, slip, path: b.pos[0] - x0 - sum };
  }

  it.for([10, 20])('a ball rolling on the ground at 0.05-6 m/s keeps its height, speed and rolling (%i iterations)', async (iterations) => {
    // Set rolling once settled at rest, so the bounds need not skip a landing. Kept anchors stuck across steps below
    // stickThreshold / h = 0.6 m/s and never matched above matchDistance / h = 3 m/s.
    // Baseline, 300 steps at 10 iterations: the steel ball sinks 1.22-1.73 m, at 60x the speed from 0.05 m/s and 6x from 0.5;
    // the 65 g ball (density 1) sinks 8 mm at 0.05-0.5 m/s, at 27x and 2.8x the speed.
    for (const density of [7800, 1]) for (const v0 of [0.05, 0.5, 2, 3.2, 6]) {
      const r = await rollSettled(rollScene([{ ...ball([0, R, 0], 0), density }]), 0, v0, 300, () => 0, { iterations });
      const at = `${v0} m/s, density ${density}`;
      expect(r.low, at).toBeGreaterThan(-1e-4); // the resting penetration is 0 (post-stabilization, slop 0)
      expect(r.dy, at).toBeLessThan(1e-4);
      expect(r.dv, at).toBeLessThan(1e-3);
      expect(r.slip, at).toBeLessThan(1e-3);
      expect(Math.abs(r.path), at).toBeLessThan(1e-4);
    }
  });

  it('a ball rolls across a heavy box at constant height and speed, listed before or after the box', async () => {
    // A 4 x 0.5 x 4 slab at 2 m/s, and an 8 m slab at 6 m/s, where b's anchor (the box's, with the ball listed first)
    // moves v h = 0.1 m a step: the match is keyed on the ball's world lever arm.
    // Baseline: 0.71-0.90 m into the box at 2 m/s, at 1.4-1.5x the speed, and 1.35 m at 6 m/s.
    for (const [half, v0, steps] of [[[2, 0.25, 2], 2, 100], [[4, 0.25, 2], 6, 65]] as const) for (const first of [true, false]) {
      const bodies = first ? [ball([0.4 - half[0], 0.5 + R, 0], 0), slab([...half])] : [slab([...half]), ball([0.4 - half[0], 0.5 + R, 0], 0)];
      const r = await rollSettled(rollScene(bodies), first ? 0 : 1, v0, steps, (e) => e.world!.bodies[first ? 1 : 0]!.pos[1] + 0.25);
      const at = `${v0} m/s, ${first ? 'ball first' : 'box first'}`;
      expect(r.low, at).toBeGreaterThan(-1e-4);
      expect(r.dv, at).toBeLessThan(1e-3);
      expect(r.slip, at).toBeLessThan(1e-3);
    }
  });

  it('a ball rolls down an incline at 5/7 g sin theta', async () => {
    // Tilted gravity, mu 0.6 > 2/7 tan(30 deg). Baseline: 1.06-1.43x the speed, 0.15-3 m sunk.
    for (const radius of [0.25, 1]) for (const deg of [10, 30]) {
      const th = (deg * Math.PI) / 180;
      const scene = sceneOf([{ ...ball([0, radius, 0], 0, radius), density: 1000, friction: MU }], [G * Math.sin(th), -G * Math.cos(th), 0]);
      const r = await roll(scene, 0, 120, () => 0);
      const v = (5 / 7) * G * Math.sin(th) * 2;
      expect(Math.abs(r.v[0] / v - 1), `R ${radius}, ${deg} deg`).toBeLessThan(0.01);
      expect(Math.abs(r.wR / v - 1)).toBeLessThan(0.01);
      expect(r.low).toBeGreaterThan(-1e-3);
    }
  });

  it('an oblique landing ends rolling at 5/7 of the speed along the surface, on the ground or on a box', async () => {
    // Contact forces act at the contact point, so they keep the angular momentum about it: m v R = (m R^2 + I) w.
    // Baseline after 1 s: 0.98-1.05x, still sinking at 1.9 m/s.
    const top = slab([4, 0.25, 4]);
    for (const [vx, vy] of [[5, 5], [8, 2]] as const) for (const on of ['ground', 'box first', 'ball first'] as const) {
      const b: BodyDesc = { ...ball([-3, (on === 'ground' ? 0 : 0.5) + R + vy / 60, 0], 0), linVel: [vx, -vy, 0], angVel: [0, 0, 0] };
      const bodies = on === 'ground' ? [b] : on === 'box first' ? [top, b] : [b, top];
      const r = await roll(rollScene(bodies), on === 'ball first' ? 0 : bodies.length - 1, 60, (e) => (on === 'ground' ? 0 : e.world!.bodies[on === 'box first' ? 0 : 1]!.pos[1] + 0.25));
      expect(Math.abs(r.v[0] / ((5 / 7) * vx) - 1), `(${vx}, ${-vy}) on the ${on}`).toBeLessThan(0.01);
      expect(Math.abs(r.v[1])).toBeLessThan(0.01);
      expect(Math.abs(r.wR / r.v[0] - 1)).toBeLessThan(0.01);
    }
  });

  it.for([10, 20])('a plank pushed over two ball rollers moves at 2 M V0 / (2 M + 1.4 m), the balls rolling at half its speed (%i iterations)', async (iterations) => {
    // Each ball keeps its angular momentum about its ground contact: the plank's impulse P at 2R gives 2 P R = 1.4 m v R,
    // and the plank M (V - V0) = -2 P with V = 2 v. Baseline: the plank at 2.1-2.55 V, 83-180 mm low.
    const plank: BodyDesc = { ...cube([0, 2 * R + 0.05, 0], [1, 0, 0]), shape: { kind: 'box', half: [2.4, 0.05, 0.4] }, density: 500 };
    const balls = [-0.6, 0.6].map((x): BodyDesc => ({ ...ball([x, R, 0], 0), density: 1000, friction: MU }));
    for (const plankFirst of [true, false]) {
      const e = new AvbdReferenceEngine({ iterations });
      await e.init(sceneOf(plankFirst ? [plank, ...balls] : [...balls, plank]));
      const bs = e.world!.bodies, P = bs[plankFirst ? 0 : 2]!, B = plankFirst ? [bs[1]!, bs[2]!] : [bs[0]!, bs[1]!];
      let off = 0;
      for (let s = 1; s <= 90; s++) {
        e.step();
        if (s > 30) off = Math.max(off, Math.abs(P.pos[1] - (2 * R + 0.05)), ...B.map((b) => Math.abs(b.pos[1] - R)));
      }
      const V = (2 * P.mass) / (2 * P.mass + 1.4 * B[0]!.mass), at = plankFirst ? 'plank first' : 'balls first';
      expect(Math.abs(P.linVel[0] / V - 1), at).toBeLessThan(0.01);
      for (const b of B) {
        expect(Math.abs(b.linVel[0] / (V / 2) - 1), at).toBeLessThan(0.01);
        expect(Math.abs((-b.angVel[2] * R) / b.linVel[0] - 1), at).toBeLessThan(0.01);
      }
      expect(off, at).toBeLessThan(1e-4);
    }
  });

  it('a ball rolling over a much larger sphere stays on its surface, listed before or after it', async () => {
    // A ball of radius r at v over a sphere of radius R turns the normal by v h / (R + r) per step: the ball's arm moves
    // r v h / (R + r), the big sphere's nearly v h, so the match is keyed on the smaller sphere.
    // Baseline (and keyed on b's arm, with the big sphere listed second): 817 mm into it.
    const Rb = 10, r = R, v0 = 4;
    const big: BodyDesc = { ...ball([0, Rb, 0], 0, Rb), density: 1e5, friction: MU };
    const small = ball([-0.5, Rb + Math.sqrt((Rb + r) ** 2 - 0.25), 0], v0);
    for (const bigFirst of [true, false]) {
      const e = new AvbdReferenceEngine({ iterations: 10 });
      await e.init(sceneOf(bigFirst ? [big, small] : [small, big]));
      const S = e.world!.bodies[bigFirst ? 1 : 0]!, Bg = e.world!.bodies[bigFirst ? 0 : 1]!;
      let low = Infinity, high = -Infinity, n = 0;
      for (let s = 1; s <= 120; s++) {
        e.step();
        const dx = S.pos[0] - Bg.pos[0], dy = S.pos[1] - Bg.pos[1];
        if (Math.abs(Math.atan2(dx, dy)) > (20 * Math.PI) / 180) break; // 20 deg past the top
        const gap = Math.hypot(dx, dy) - Rb - r;
        if (s > 10) { low = Math.min(low, gap); high = Math.max(high, gap); n++; }
      }
      const at = bigFirst ? 'big sphere first' : 'big sphere second';
      expect(n, at).toBeGreaterThan(20);
      expect(low, at).toBeGreaterThan(-5e-3);
      expect(high, at).toBeLessThan(5e-3);
    }
  });

  it.for([10, 20])('a tetrahedron of 4 balls holds its height: static friction carries each rolling contact\'s slip, c0_t + J_t dx, into the next step (%i iterations)', async (iterations) => {
    // The bottom balls are pushed apart and held by friction, on the ground and under the top ball. A rolling contact
    // keeps no anchors, so static friction holds only through the slip it carries; without it each step's friction
    // starts from zero slip, and the creep it lets through while k_t ramps up is never pulled back.
    // 480 steps: the top ball ends 0.036 mm (10 iterations) and 0.016 mm (20) below R + 2R sqrt(2/3). With the carry
    // negated, removed, without J_t dx or without c0_t: 4.2-4.5 mm and 1.8-1.9 mm below. Kept anchors (rollingContacts
    // false): 602 mm and 426 mm (it collapses).
    // White-box, every step: a contact that stuck at the end of last step and is carried starts with c0_t = its
    // geometric part (0 on a sphere: both points are this step's) + last step's slip, the old contact's c0_t + J_t dx
    // from its own Jacobian rows and that step's dx, re-expressed in the new tangent basis. The scene needs both
    // terms: up to 9.0 mm of slip carried and J_t dx up to 3.9 mm a step at 10 iterations (3.6 and 1.7 mm at 20).
    const d = 2 * R;
    const at: Vec3[] = [[0, R, 0], [d, R, 0], [d / 2, R, (d * Math.sqrt(3)) / 2], [d / 2, R + d * Math.sqrt(2 / 3), (d * Math.sqrt(3)) / 6]];
    const e = new AvbdReferenceEngine({ iterations });
    await e.init(sceneOf(at.map((p): BodyDesc => ({ ...ball(p, 0), density: 1000, friction: MU }))));
    const w = e.world!, bs = w.bodies;
    let carried = 0, worst = 0, slipMax = 0, oldMax = 0, jdxMax = 0;
    for (let s = 1; s <= 480; s++) {
      const old = new Map(w.contacts.map((c) => [`${c.a},${c.b}`, c])), dx = w.lastDx, x0 = bs.map((b) => b.pos);
      e.step();
      for (const c of w.contacts) {
        const o = old.get(`${c.a},${c.b}`); // one contact per pair of spheres
        if (!o?.stick) continue;
        const jdx = (r: number) => {
          let x = 0;
          for (let k = 0; k < 6; k++) x += o.jb[6 * r + k]! * dx[o.b]![k]! + (o.a === GROUND ? 0 : o.ja[6 * r + k]! * dx[o.a]![k]!);
          return x;
        };
        const s1 = o.c0[1] + jdx(1), s2 = o.c0[2] + jdx(2);
        const slip = [0, 1, 2].map((k) => s1 * o.t1[k]! + s2 * o.t2[k]!);
        const pa = c.a === GROUND ? c.ra : [0, 1, 2].map((k) => x0[c.a]![k]! + c.raw[k]!);
        const g = [0, 1, 2].map((k) => x0[c.b]![k]! + c.rbw[k]! - pa[k]!);
        const dot = (u: number[], v: Vec3) => u[0]! * v[0] + u[1]! * v[1] + u[2]! * v[2];
        const e1 = dot(slip, c.t1), e2 = dot(slip, c.t2);
        if (Math.hypot(e1, e2) >= DEFAULT_AVBD.stickThreshold) continue; // dropped, as kept anchors that drifted are
        carried++;
        worst = Math.max(worst, Math.hypot(c.c0[1] - dot(g, c.t1) - e1, c.c0[2] - dot(g, c.t2) - e2));
        slipMax = Math.max(slipMax, Math.hypot(e1, e2));
        oldMax = Math.max(oldMax, Math.hypot(o.c0[1], o.c0[2]));
        jdxMax = Math.max(jdxMax, Math.hypot(jdx(1), jdx(2)));
      }
    }
    expect(Math.abs(bs[3]!.pos[1] - (R + d * Math.sqrt(2 / 3)))).toBeLessThan(5e-4);
    expect(carried).toBeGreaterThan(2000);
    expect(Math.min(slipMax, oldMax, jdxMax)).toBeGreaterThan(1e-3);
    expect(worst).toBeLessThan(1e-12);
  });

  it.for(['head-on', 'grazing'] as const)('a ball hitting a free cube %s in zero g keeps the momentum: an impact contact gets a capped load floor', async (hit) => {
    // A 5 kg ball at 15 m/s hits a 1 kg cube. The contact persists through the impact; with the full load floor its k_n
    // was 20x the cube's m / h^2. Worst drift at 10 iterations: head-on 0.41% (baseline 9.0%), grazing 0.11% (5.1% with
    // the full floor). Grazing is a guard: there kept anchors lost the match, and with it the floor (baseline 0.15%).
    const R6 = 0.6, density = 5 / ((4 / 3) * Math.PI * R6 ** 3);
    const pos: Vec3 = hit === 'head-on' ? [-1.5, 0, 0] : [-1.5, 0.45, 0.2], v: Vec3 = hit === 'head-on' ? [15, 0, 0] : [15, -2.6, 0];
    const b: BodyDesc = { ...ball(pos, 0, R6), linVel: v, angVel: [0, 0, 0], density, friction: MU };
    const e = new AvbdReferenceEngine();
    await e.init({ ...sceneOf([cube([0, 0, 0]), b], [0, 0, 0]), ground: null });
    const P = () => [0, 1, 2].map((k) => e.world!.bodies.reduce((s, x) => s + x.mass * x.linVel[k]!, 0));
    const p0 = P();
    let worst = 0;
    for (let s = 0; s < 90; s++) {
      e.step();
      const p = P();
      worst = Math.max(worst, Math.hypot(p[0]! - p0[0]!, p[1]! - p0[1]!, p[2]! - p0[2]!) / Math.hypot(...p0));
    }
    expect(e.world!.bodies[0]!.linVel[0]).toBeGreaterThan(5); // the cube was hit
    expect(worst).toBeLessThan(0.01);
  });

  it('a heavy ball landing on a light cube stays shallow (a guard on the impact cap)', async () => {
    // Keystone's case: a 510 kg steel ball dropped 1 m onto a 31 kg plaster cube resting on the ground. Deepest at
    // 10 iterations with the cap at sqrt(m_a m_b) / h^2: 24.6 mm (baseline 23.5 mm; capped at the lighter body's m / h^2, 59.1 mm).
    const cubeD: BodyDesc = { ...cube([0, 0.25, 0]), shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, density: 250 };
    const bodies = [cubeD, ball([0, 0.5 + R + 1, 0], 0)];
    const e = new AvbdReferenceEngine({ iterations: 10 });
    await e.init(sceneOf(bodies));
    let deepest = 0;
    for (let s = 0; s < 120; s++) {
      e.step();
      deepest = Math.max(deepest, penetration(bodies, e.snapshot(), 0).max);
    }
    expect(deepest).toBeLessThan(0.03);
  });

  it('a heavy ball at rest on a light cube keeps the full load floor: the cap is only for a contact that moved along its normal', async () => {
    // A 510 kg steel ball placed on a 1 kg cube on the ground. Its contact moves along the normal by restDepth or
    // more only in the landing transient, so from step 61 it has the full floor, |lambda_n| / restDepth (20 x the
    // cap): 0 mm deep at 10 and 20 iterations. Capped whether or not it moved: 1.3 mm and 0.7 mm deep.
    const cubeD: BodyDesc = { ...cube([0, 0.25, 0]), shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, density: 8 };
    const bodies = [cubeD, ball([0, 0.5 + R, 0], 0)];
    for (const iterations of [10, 20]) {
      const e = new AvbdReferenceEngine({ iterations });
      await e.init(sceneOf(bodies));
      let late = 0;
      for (let s = 1; s <= 300; s++) {
        e.step();
        if (s > 60) late = Math.max(late, penetration(bodies, e.snapshot(), 0).max);
      }
      expect(late, `${iterations} iterations`).toBeLessThan(1e-4);
    }
  });
});

describe('per-pair SAT axis history (AvbdWorld.axes)', () => {
  // b overlaps a by 10 mm along x and 10.2 mm along y: x separates more,
  // but within the face tolerance, so last step's axis decides (geom/manifold.ts).
  const pair = (): SceneDesc => ({ ...sceneOf([cube([0, 0, 0]), cube([0.99, 0.9898, 0])], [0, 0, 0]), ground: null });
  const along = (e: AvbdReferenceEngine, n: Vec3) => {
    const cs = e.world!.contacts.filter((c) => c.a === 0 && c.b === 1);
    return cs.length > 0 && cs.every((c) => c.n[0] * n[0] + c.n[1] * n[1] + c.n[2] * n[2] > 0.999);
  };

  it('the narrowphase gets last step\'s axis for the pair and records this step\'s', async () => {
    const plain = new AvbdReferenceEngine();
    await plain.init(pair());
    plain.step();
    expect(plain.world!.axes.get('0,1')).toBe(0);
    expect(along(plain, [1, 0, 0])).toBe(true);
    const hinted = new AvbdReferenceEngine();
    await hinted.init(pair());
    hinted.world!.axes.set('0,1', 1);
    hinted.step();
    expect(hinted.world!.axes.get('0,1')).toBe(1);
    expect(along(hinted, [0, 1, 0])).toBe(true);
  });

  it('in a tower jiggled by 1e-5 every step, no touching pair changes axis', async () => {
    // 2026-10-25: 0 of ~31k pair-steps switch (19k face pairs, the rest
    // zero-depth slivers: see FACE_INSET); with the history cleared before
    // each step 3 do here (and 1-27 in a 4x4x12 tower, by noise seed).
    const scene = buildScenario('S1', { F: 3, H: 8, gap: 0 }, 1);
    const e = new AvbdReferenceEngine();
    await e.init(scene);
    const w = e.world!;
    let seed = 1;
    const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    let changes = 0, kept = 0, last = new Map(w.axes);
    for (let i = 0; i < 120; i++) {
      for (const b of w.bodies) b.pos = [b.pos[0] + 1e-5 * r(), b.pos[1] + 1e-5 * r(), b.pos[2] + 1e-5 * r()];
      e.step();
      for (const [k, axis] of w.axes) {
        const p = last.get(k);
        if (p !== undefined) { if (p === axis) kept++; else changes++; }
      }
      last = new Map(w.axes);
    }
    expect(changes).toBe(0);
    expect(kept).toBeGreaterThan(15_000);
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

  // A resting stack resists tilting with about iterations x k_n x (lever
  // arm)^2 per interface. With no error left to ramp k_n, gamma would decay it
  // every step until the stack leans over by itself, from any seed (here a
  // 0.1 mm lean, top to bottom); the load floor (restDepth) stops that. Measured
  // 2026-10-26: 0.14 / 0.07 mm at 10 / 20 iterations with the floor; without
  // it the column falls (5.7 m by 15 s at both).
  const leaningColumn = async (params: Partial<AvbdParams>) => {
    const plaster = (k: number): BodyDesc => ({
      shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, pos: [1e-5 * k, 0.25 + 0.5 * k, 0], rot: [0, 0, 0, 1],
      linVel: [0, 0, 0], angVel: [0, 0, 0], density: 250, friction: 0.6, restitution: 0.05, tag: 0,
    });
    const scene: SceneDesc = { ...sceneOf(Array.from({ length: 12 }, (_, k) => plaster(k))), frictionCombine: 'min' };
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    for (let i = 0; i < 90; i++) e.step();
    const p0 = e.snapshot().pos.slice();
    let worst = 0;
    for (let i = 0; i < 900; i++) {
      e.step();
      const p = e.snapshot().pos;
      for (let b = 0; b < 12; b++) worst = Math.max(worst, Math.hypot(p[3 * b]! - p0[3 * b]!, p[3 * b + 2]! - p0[3 * b + 2]!));
    }
    return worst;
  };
  it.each([10, 20])('a 12-cube column of 0.5 m cubes, settled with a lean, stands for 15 s at %i iterations', async (iterations) => {
    expect(await leaningColumn({ iterations })).toBeLessThan(1e-3);
  });
  it('without the load floor that column falls over', async () => {
    expect(await leaningColumn({ restDepth: 0 })).toBeGreaterThan(1);
  });

  // The floor alone is a ratchet: a landing's lambda_n spikes (here the
  // pre-settle) and the beta ramp stay in k_n for ~100 steps, and a column
  // taller than 10 iterations resolve is unstable to kicks at about 2x its
  // resting k_n: it bounces, each landing raises k_n again, and it never stops.
  // The load cap eases k_n towards loadCap x the floor of the largest load on
  // a point of its pair, falling at most to capFall x its uncapped value each
  // step, so it forgets them within a dozen-odd steps. Measured 2026-10-26,
  // max speed over steps 301-600 with / without the cap: 24 cubes 1e-15 /
  // 0.36 m/s, 30 cubes 5e-10 / 0.50 m/s (40 cubes 2e-5 with it). Kicked
  // vertically at step 400 (every cube a random vertical speed of up to
  // 1 m/s), the 30-cube column boils again for good without the cap
  // (0.51 m/s over steps 601-900) and comes back to rest with it (4e-7 m/s).
  // A 4x4x25 tower (max speed over steps 201-300, sideways offset at step
  // 300): 6e-5 m/s and 0.025 mm with the cap, 0.42 m/s and 50 mm without; an
  // 8x8x25 one, as in the S4 city, the same (6e-5 m/s, 0.027 mm; 0.41 m/s,
  // 45 mm).
  //
  // Sideways kicks are not covered. At 10 iterations a column of 8-20 cubes,
  // or a 2x2 to 4x4 tower 8 high, kicked sideways by up to 0.01 m/s per cube
  // keeps rocking (0.17-0.50 m/s over steps 1201-1500), with the cap as with
  // the floor alone (the 8-cube case below: 0.25 m/s with the cap, 0.18 with
  // the floor alone, 0.39 with neither; over 22 draws of the kick 0.12-0.26,
  // 0.17-0.18 and 0.31-0.62). 4x4x25 and 8x8x25 towers slow to 8e-4 and
  // 5e-4 m/s by step 1500, then grow again (7e-3 and 3e-3 m/s over steps
  // 2101-2400). postStabilize off (2e-5) or 100 iterations (1e-9) damp it, so
  // it is post-stabilization at low iteration counts, not the floor or the cap
  // (2026-10-26). The it.fails case below tracks it.
  type Kick = (linVel: Vec3, rnd: () => number) => void;
  const column = async (H: number, params: Partial<AvbdParams>, { F = 1, steps = 600, win = 300, kick }: { F?: number; steps?: number; win?: number; kick?: Kick } = {}) => {
    const scene = buildScenario('S1', { F, H, gap: 0 }, 1);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    let maxV = 0, side = 0, seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 1; i <= steps; i++) {
      if (kick && i === 401) for (const b of e.world!.bodies) kick(b.linVel, rnd);
      e.step();
      if (i > steps - win) for (const b of e.world!.bodies) maxV = Math.max(maxV, Math.hypot(...b.linVel));
    }
    e.world!.bodies.forEach((b, i) => { const p0 = scene.bodies[i]!.pos; side = Math.max(side, Math.hypot(b.pos[0] - p0[0], b.pos[2] - p0[2])); });
    return { maxV, side, loaded: e.world!.contacts.every((c) => c.lambda[0] < 0) };
  };
  it.each([24, 30])('a column of %i unit cubes comes to rest with every contact loaded', async (H) => {
    const r = await column(H, {});
    expect(r.maxV).toBeLessThan(1e-3);
    expect(r.loaded).toBe(true);
  });
  it('with the floor alone (loadCap 0) a 24-cube column never comes to rest', async () => {
    expect((await column(24, { loadCap: 0 })).maxV).toBeGreaterThan(0.1);
  });
  it('a settled 30-cube column kicked vertically at up to 1 m/s per cube comes back to rest', async () => {
    const r = await column(30, {}, { steps: 900, kick: (v, rnd) => { v[1] += 2 * rnd() - 1; } });
    expect(r.maxV).toBeLessThan(1e-3);
    expect(r.loaded).toBe(true);
  });
  it('a packed 4x4x25 tower comes to rest without sliding', { timeout: 300_000 }, async () => {
    const r = await column(25, {}, { F: 4, steps: 300, win: 100 });
    expect(r.maxV).toBeLessThan(1e-3);
    expect(r.side).toBeLessThan(1e-3);
  });
  it.fails('a settled 8-cube column kicked sideways at up to 0.01 m/s per cube comes back to rest (known: post-stabilization rocking)', async () => {
    const kick: Kick = (v, rnd) => { v[0] += 0.01 * (2 * rnd() - 1); v[2] += 0.01 * (2 * rnd() - 1); };
    expect((await column(8, {}, { steps: 1500, kick })).maxV).toBeLessThan(1e-3);
  });
  it('a column of 24 cubes under one 100x as heavy comes to rest (S9)', async () => {
    // With the floor alone it boils too (0.30 m/s over steps 301-600). With k_n dropped to the cap at once
    // (capFall 0), the heavy top bounced on the column for good (0.91 m/s; the column sank 0.93 m): each time it
    // lifted off, the contact's k_n fell to penaltyMin, and it landed on a soft contact. capFall eases it down
    // instead: 1e-7 m/s (2026-10-26).
    const e = new AvbdReferenceEngine({});
    await e.init(buildScenario('S9', { H: 24, ratio: 100 }, 1));
    let maxV = 0;
    for (let i = 1; i <= 600; i++) {
      e.step();
      if (i > 300) for (const b of e.world!.bodies) maxV = Math.max(maxV, Math.hypot(...b.linVel));
    }
    expect(maxV).toBeLessThan(1e-3);
    expect(e.world!.contacts.every((c) => c.lambda[0] < 0)).toBe(true);
  });

  // Same scene in Rapier: survival 0.30, ball rebounds at -4.1 m/s, worst
  // transient penetration 0.14 (cubes falling at 12-15 m/s move 0.25 per step).
  const knockdown = async (params: Partial<AvbdParams>, speed = 15) => {
    const scene = buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio: 5, radius: 0.6 }, 1);
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
  // One collapse is chaotic: nearby ball speeds, or a 1e-12 nudge to the
  // tower (what any rounding-level code change does), give a different
  // collapse. At speed 17 the ball keeps only -1.1 m/s, and a run's deepest
  // transient is set by a single tumbling cube (0.02 to 0.52 over 144
  // re-rolled runs). So the outcomes are medians over 9 speeds, with bounds
  // outside their measured spread (16 re-rolls with 1e-12 jitter,
  // 2026-10-25), not one realization.
  const median = (x: number[]) => [...x].sort((a, b) => a - b)[x.length >> 1]!;
  const speeds = [11, 12, 13, 14, 15, 16, 17, 18, 19];
  let knocks: ReturnType<typeof knockdown>[] | null = null;
  const knocked = () => Promise.all(knocks ??= speeds.map((v) => knockdown({}, v)));

  it('a ball knocks a slender tower down (medians over 9 ball speeds)', async () => {
    // Survival 0.16-0.31 (median 0.22), ball vx -4.5 to -1.1 (median -3.4).
    const runs = await knocked();
    for (const r of runs) expect(nonFinite(r.s1)).toBe(0);
    expect(median(runs.map((r) => r.survival))).toBeLessThan(0.5);
    expect(median(runs.map((r) => r.ballVx))).toBeLessThan(-1);
  });

  it('speculative margins keep impacts shallow (median over 9 ball speeds)', async () => {
    // Median deepest transient 0.042 with sweeps (0.037-0.068 over the
    // re-rolls), 0.27 without (0.20-0.27); Rapier, fixed margin: 0.14 at
    // speed 15. A bootstrap of the re-rolled runs fails these bounds 0.02%
    // of the time (the earlier 5 speeds, < 0.07 and > 3x: 16%).
    const on = median((await knocked()).map((r) => r.maxPen));
    const off = median(await Promise.all(speeds.map(async (v) => (await knockdown({ sweep: false }, v)).maxPen)));
    expect(on).toBeLessThan(0.1);
    expect(off).toBeGreaterThan(2 * on);
  });

  it('is deterministic', async () => {
    const scene = buildScenario('S11', { N: 40 }, 7);
    const a = await simulate(scene, 60), b = await simulate(scene, 60);
    expect([...a.s1.pos]).toEqual([...b.s1.pos]);
    expect([...a.s1.rot]).toEqual([...b.s1.rot]);
  });
});

describe('engine contract: friction rule and integrator', () => {
  const mu = async (rule: CombineRule | undefined) => {
    const e = new AvbdReferenceEngine();
    await e.init(slideScene(rule));
    e.step();
    const v1 = e.snapshot().linVel[0]!;
    for (let i = 0; i < 10; i++) e.step();
    return appliedMu(v1, e.snapshot().linVel[0]!);
  };
  it.for(['average', 'min', 'max', 'multiply'] as const)('SceneDesc.frictionCombine %s: a sliding cube decelerates at mu g with the combined mu', async (rule) => {
    // Within solver convergence (2e-4 at 10 iterations); the closest two rules differ by 0.03.
    expect(await mu(rule)).toBeCloseTo(slideMu(rule), 3);
  });

  it('frictionCombine defaults to average', async () => {
    expect(await mu(undefined)).toBe(await mu('average'));
  });

  it('free flight is exactly what EngineInfo.integrator says', async () => {
    const e = new AvbdReferenceEngine();
    expect(e.info.integrator).toEqual({ substeps: 1 });
    const scene = throwScene();
    await e.init(scene);
    for (let i = 0; i < THROW.steps; i++) e.step();
    const want = freeFlight(THROW.pos, THROW.vel, scene.gravity, scene.dt, 1, THROW.steps);
    const s = e.snapshot();
    for (let k = 0; k < 3; k++) {
      expect(s.pos[k]!).toBeCloseTo(want.pos[k]!, 9);
      expect(s.linVel[k]!).toBeCloseTo(want.vel[k]!, 9);
    }
  });
});

describe('froudeParams: k x gravity is the same world, sqrt(k) x faster', () => {
  // A tower of 2x2x4 cubes, a turned cube on top, hit from the side by a cube at 6 m/s
  // (cube on cube, cube on ground, sliding and tumbling), 90 steps. e is every cube's restitution.
  const bodies = (vs: number, e = 0): BodyDesc[] => {
    const out: BodyDesc[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) out.push(cube([x - 0.5, 0.5 + y, z - 0.5]));
    out.push({ ...cube([0, 4.6, 0]), rot: [0, Math.sin(0.3), 0, Math.cos(0.3)] });
    out.push(cube([-4, 1.6, 0.2], [6 * vs, 0, 0]));
    return out.map((b) => ({ ...b, restitution: e }));
  };
  // p is the unit world's params; fast overrides the k world's (froudeParams(p, k) by default).
  const run = async (k: number, steps: number, { p = {}, e = 0, fast: fp }: { p?: Partial<AvbdParams>; e?: number; fast?: Partial<AvbdParams> } = {}) => {
    const slow = { ...sceneOf(bodies(1, e)), dt: Math.sqrt(k) / 60 }; // gravity g, steps sqrt(k) times as long
    const fast = { ...sceneOf(bodies(Math.sqrt(k), e), [0, -G * k, 0]), dt: 1 / 60 }; // gravity k g, the viewer's step
    const a = await simulate(slow, steps, p), b = await simulate(fast, steps, fp ?? froudeParams(p, k));
    let dp = 0, dv = 0, dw = 0, moved = 0;
    for (let i = 0; i < a.s1.count; i++) for (let c = 0; c < 3; c++) {
      dp = Math.max(dp, Math.abs(a.s1.pos[3 * i + c]! - b.s1.pos[3 * i + c]!));
      dv = Math.max(dv, Math.abs(a.s1.linVel[3 * i + c]! * Math.sqrt(k) - b.s1.linVel[3 * i + c]!));
      dw = Math.max(dw, Math.abs(a.s1.angVel[3 * i + c]! * Math.sqrt(k) - b.s1.angVel[3 * i + c]!));
      moved = Math.max(moved, Math.abs(a.s1.pos[3 * i + c]! - a.s0.pos[3 * i + c]!));
    }
    return { dp, dv, dw, moved };
  };

  it('k = 4 (factors that are powers of two): the same floats, step for step', async () => {
    const r = await run(4, 90);
    expect(r.moved).toBeGreaterThan(1); // the hit knocked the tower about
    expect(r.dp).toBe(0);
    expect(r.dv).toBe(0);
    expect(r.dw).toBe(0);
  });

  it('k = 2.25: equal to rounding', async () => {
    const r = await run(2.25, 30);
    expect(r.moved).toBeGreaterThan(0.1);
    expect(r.dp).toBeLessThan(1e-9);
    expect(r.dv).toBeLessThan(1e-8);
  });

  it('k = 4 with restitution on: its threshold is a speed and scales too, so the same floats', async () => {
    const p = { restitution: true }, e = 0.5;
    const r = await run(4, 90, { p, e });
    expect(r.moved).toBeGreaterThan(1);
    expect(r.dp).toBe(0);
    expect(r.dv).toBe(0);
    expect(r.dw).toBe(0);
    // The scene has approaches between 1 and 2 m/s in the k world (0.5-1 in the unit world): left at 1 m/s, the threshold bounces them and the worlds part (measured 0.085 m apart).
    const unscaled = await run(4, 90, { p, e, fast: { ...froudeParams(p, 4), restitutionThreshold: 1 } });
    expect(unscaled.dp).toBeGreaterThan(1e-3);
  });

  it('only forces and speeds change: lengths and rates stay, unset fields take the defaults', () => {
    const p = froudeParams({ iterations: 7, beta: 10 }, 4);
    expect(p).toEqual({ iterations: 7, beta: 40, penaltyMin: DEFAULT_AVBD.penaltyMin * 4, penaltyMax: DEFAULT_AVBD.penaltyMax * 4, maxAngularSpeed: DEFAULT_AVBD.maxAngularSpeed * 2 });
    // Restitution's threshold is a speed, scaled only while the switch is on.
    expect(froudeParams({ restitution: true }, 4).restitutionThreshold).toBe(2);
    expect(froudeParams({ restitution: true, restitutionThreshold: 0.5 }, 4).restitutionThreshold).toBe(1);
    expect(froudeParams({ restitution: false, restitutionThreshold: 0.5 }, 4).restitutionThreshold).toBe(0.5);
    expect(() => froudeParams({}, 0)).toThrow();
  });
});

describe('AvbdReferenceEngine.push()', () => {
  it('push() during a run replays exactly as the same events in scene.inputs', async () => {
    const ball = (x: number): BodyDesc => ({ shape: { kind: 'sphere', radius: 0.4 }, pos: [x, 3, -6], rot: [0, 0, 0, 1], linVel: [0, 0, 12], angVel: [0, 0, 0], density: 5, friction: 0.5, restitution: 0.1, tag: -1 });
    // As the Rapier test: a past-step event applies now, and two events for
    // step 20 pushed around an earlier one keep push order (stable insert).
    const live = new AvbdReferenceEngine();
    const base = buildScenario('S1', { F: 2, H: 4, gap: 0.02 });
    await live.init(base);
    const pushedAt: InputEvent[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 10) {
        const evs: InputEvent[] = [{ step: 20, kind: 'spawn', body: ball(10) }, { step: 3, kind: 'spawn', body: ball(-10) }, { step: 20, kind: 'spawn', body: ball(20) }];
        live.push(evs);
        pushedAt.push(...evs.map((e) => ({ ...e, step: Math.max(e.step, i) })));
      }
      live.step();
    }
    const replay = new AvbdReferenceEngine();
    await replay.init({ ...base, inputs: [...pushedAt].sort((a, b) => a.step - b.step) });
    for (let i = 0; i < 40; i++) replay.step();
    const a = live.snapshot(), b = replay.snapshot();
    expect(a.count).toBe(base.bodies.length + 3);
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(Array.from(a.rot)).toEqual(Array.from(b.rot));
    const n = base.bodies.length;
    expect([a.pos[3 * n], a.pos[3 * (n + 1)], a.pos[3 * (n + 2)]].map((x) => Math.round(x!))).toEqual([-10, 10, 20]);
  });
});
