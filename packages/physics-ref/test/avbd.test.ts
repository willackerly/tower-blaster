import { describe, expect, it } from 'vitest';
import { type BodyDesc, bodiesAt, type CombineRule, freeFlight, type InputEvent, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { drift, energy, jitter, nonFinite, penetration, survival } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { appliedMu, slideMu, slideScene, THROW, throwScene } from '@tb/testkit';
import { AvbdReferenceEngine, type AvbdParams, colorGraph, DEFAULT_AVBD, outranks, solveSpd6, tangentBasis } from '../src/index.ts';

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
      // Not checked: the rolling speed. It drifts up from the analytic 0.714 m/s (to 1.3 m/s by 3 s), before and after this fix.
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
