// The restitution pass's energy cap (AvbdParams.restitutionEnergyCap, on by
// default; AvbdWorld.restitute(), "Energy cap"), checked from outside the
// engine: on random touching clusters struck at e 0.3-0.9, after every step,
// no island (bodies joined by the step's contacts, found here with a union-find
// of its own) has more of semi-implicit Euler's invariant energy than it had at
// the start of the step or than the solve left it (the pass's input, taken by
// wrapping restitute()). The same clusters with the cap off break that, so the
// property has teeth.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BodyDesc, Quat, SceneDesc, Vec3 } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { applyRotation, type AvbdParams, AvbdReferenceEngine, capAlpha, GROUND } from '../src/index.ts';

const G = 9.81, H = 1 / 60;

interface Cluster {
  /** 0: a row of cubes on the ground, struck along it; 1: a stack, struck from the side and above; 2: a row in zero g, struck from both ends. */
  kind: 0 | 1 | 2;
  n: number;
  strikers: number;
  e: number;
  rounds: number;
  anchors: boolean;
  seed: number;
}

/** A small PRNG (mulberry32), so a cluster is a function of its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const box = (pos: Vec3, density: number, e: number, linVel: Vec3 = [0, 0, 0], half = 0.5): BodyDesc => ({
  shape: { kind: 'box', half: [half, half, half] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density, friction: 0.6, restitution: e, tag: 0,
});
const sphere = (pos: Vec3, density: number, e: number, linVel: Vec3, radius: number): BodyDesc => ({
  shape: { kind: 'sphere', radius }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density, friction: 0.6, restitution: e, tag: -1,
});

/** The cluster's scene: touching bodies of random density (0.2-20, log-uniform) and strikers at 5-20 m/s that reach them within a few steps. */
function clusterScene(c: Cluster): SceneDesc {
  const r = rng(c.seed), dens = () => 0.2 * 100 ** r(), speed = () => 5 + 15 * r();
  const bodies: BodyDesc[] = [];
  const zeroG = c.kind === 2;
  if (c.kind === 1) for (let k = 0; k < c.n; k++) bodies.push(box([0.02 * (r() - 0.5), 0.5 + k, 0.02 * (r() - 0.5)], dens(), c.e));
  else for (let k = 0; k < c.n; k++) bodies.push(box([k * 1.0, zeroG ? 0 : 0.5, 0], dens(), c.e));
  for (let s = 0; s < c.strikers; s++) {
    const v = speed(), ball = r() < 0.5, size = 0.25 + 0.25 * r();
    const y = zeroG ? 0.4 * (r() - 0.5) : c.kind === 1 ? 0.5 + Math.floor(r() * c.n) : 0.5 + 0.3 * (r() - 0.5);
    let pos: Vec3, vel: Vec3;
    if (c.kind === 1 && s % 2 === 1) { pos = [0.3 * (r() - 0.5), c.n + size + 0.05 + v * H, 0.3 * (r() - 0.5)]; vel = [0, -v, 0]; }
    else {
      const left = c.kind !== 2 || s % 2 === 0;
      const x = left ? -0.5 - size - 0.05 - v * H * r() : c.n - 0.5 + size + 0.05 + v * H * r();
      pos = [x, Math.max(size, y), 0.2 * (r() - 0.5)]; vel = [left ? v : -v, 0, 0];
    }
    bodies.push(ball ? sphere(pos, dens(), c.e, vel, size) : box(pos, dens(), c.e, vel, size));
  }
  return {
    id: 'cap', params: {}, seed: c.seed, gravity: zeroG ? [0, 0, 0] : [0, -G, 0], dt: H,
    ground: zeroG ? null : { y: 0, friction: 0.6, restitution: c.e }, sleep: false, bodies, inputs: [],
  };
}

interface Pose { x: Vec3; q: Quat; v: Vec3; w: Vec3 }
/** One body's semi-implicit Euler invariant energy: 1/2 m |v + g h/2|^2 + 1/2 w.I(q) w - m g.x. */
function energy(m: number, inertia: Vec3, g: Vec3, s: Pose): number {
  const v = [0, 1, 2].map((k) => s.v[k]! + g[k]! * H / 2);
  const wb = rotate([-s.q[0], -s.q[1], -s.q[2], s.q[3]], s.w);
  return 0.5 * m * (v[0]! ** 2 + v[1]! ** 2 + v[2]! ** 2) + 0.5 * (inertia[0] * wb[0] ** 2 + inertia[1] * wb[1] ** 2 + inertia[2] * wb[2] ** 2) - m * (g[0] * s.x[0] + g[1] * s.x[1] + g[2] * s.x[2]);
}

/**
 * Runs the cluster `steps` steps and returns the worst excess, over every step and island, of the island's energy
 * after the step over the larger of its energy at the start and after the solve, relative to the island's kinetic
 * energy at the start plus after the solve (+1e-12 J), and how many steps the cap scaled.
 */
async function worstExcess(c: Cluster, cap: boolean, steps = 40) {
  const scene = clusterScene(c);
  const params: Partial<AvbdParams> = { restitution: true, restitutionRounds: c.rounds, restitutionAnchors: c.anchors, restitutionEnergyCap: cap };
  const eng = new AvbdReferenceEngine(params);
  await eng.init(scene);
  const w = eng.world!, g = scene.gravity;
  const pose = (): Pose[] => w.bodies.map((b) => ({ x: [...b.pos], q: [...b.rot], v: [...b.linVel], w: [...b.angVel] }));
  let solved: Pose[] = [];
  const restitute = w.restitute.bind(w);
  w.restitute = (v0, w0, q0, dx) => {
    // The solve's result: its velocities, at the step's end pose (positions are written after the pass).
    solved = w.bodies.map((b, i) => ({ x: [b.pos[0] + dx[i]![0]!, b.pos[1] + dx[i]![1]!, b.pos[2] + dx[i]![2]!], q: applyRotation(q0[i]!, [dx[i]![3]!, dx[i]![4]!, dx[i]![5]!]), v: [...b.linVel], w: [...b.angVel] }));
    restitute(v0, w0, q0, dx);
  };
  let worst = -Infinity, capped = 0;
  for (let k = 0; k < steps; k++) {
    const start = pose();
    solved = [];
    eng.step();
    capped += w.stats.restitution.capped;
    if (!solved.length) continue;
    const end = pose(), n = w.bodies.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    for (const ct of w.contacts) if (ct.a !== GROUND) parent[find(ct.a)] = find(ct.b);
    const sum = new Map<number, { e0: number; ep: number; e1: number; k: number }>();
    for (let i = 0; i < n; i++) {
      const b = w.bodies[i]!, r = find(i), t = sum.get(r) ?? { e0: 0, ep: 0, e1: 0, k: 0 };
      const ke = (s: Pose) => energy(b.mass, b.inertia, [0, 0, 0], s);
      t.e0 += energy(b.mass, b.inertia, g, start[i]!);
      t.ep += energy(b.mass, b.inertia, g, solved[i]!);
      t.e1 += energy(b.mass, b.inertia, g, end[i]!);
      t.k += ke(start[i]!) + ke(solved[i]!);
      sum.set(r, t);
    }
    for (const t of sum.values()) worst = Math.max(worst, (t.e1 - Math.max(t.e0, t.ep)) / (t.k + 1e-12));
  }
  return { worst, capped };
}

const clusters = fc.record({
  kind: fc.constantFrom(0 as const, 1 as const, 2 as const),
  n: fc.integer({ min: 2, max: 4 }),
  strikers: fc.integer({ min: 1, max: 3 }),
  e: fc.double({ min: 0.3, max: 0.9, noNaN: true }),
  rounds: fc.constantFrom(8, 32, 64),
  anchors: fc.boolean(),
  seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
});

describe('restitution energy cap: no island gains in the pass', () => {
  it('capAlpha: 1 when the pass fits, else the largest alpha with alpha G + alpha^2 Q / 2 <= max(0, D)', () => {
    expect(capAlpha(10, 3, 4)).toBe(1);
    expect(capAlpha(-1, 0, 0)).toBe(1);
    expect(capAlpha(-1, 1, 0)).toBe(0);
    expect(capAlpha(-1, -1, 4)).toBeCloseTo(0.5, 15);
    // Energies on a 1e-5 J grid up to 10 J (denormal products would make the "a little more" check meaningless).
    const x = (lo: number) => fc.integer({ min: lo * 1e6, max: 1e6 }).map((k) => k / 1e5);
    fc.assert(fc.property(x(-1), x(-1), x(0), (D, Gr, Q) => {
      const a = capAlpha(D, Gr, Q), B = Math.max(0, D), f = (x: number) => x * Gr + (x * x * Q) / 2;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(f(a)).toBeLessThanOrEqual(B + 1e-12 * (1 + Math.abs(Gr) + Q));
      // The largest such alpha: a little more breaks the bound, unless it is 1.
      if (a < 1) expect(f(Math.min(1, a + 1e-6))).toBeGreaterThan(B);
    }), { seed: 7, numRuns: 2000 });
  });

  it('random touching clusters struck at e 0.3-0.9: after every step no island has more energy than at its start or after the solve', { timeout: 300_000 }, async () => {
    let capped = 0;
    await fc.assert(fc.asyncProperty(clusters, async (c) => {
      const r = await worstExcess(c, true);
      capped += r.capped;
      expect(r.worst, JSON.stringify(c)).toBeLessThanOrEqual(1e-9);
    }), { seed: 42, numRuns: 60 });
    // The cap had work to do on these clusters (measured: it scaled 10 steps).
    expect(capped).toBeGreaterThan(0);
  });

  it('the same clusters with the cap off: some island gains in the pass (the property has teeth)', { timeout: 300_000 }, async () => {
    let bad = 0;
    for (const c of fc.sample(clusters, { seed: 42, numRuns: 60 })) if ((await worstExcess(c, false)).worst > 1e-6) bad++;
    // Measured 5 of the 60 (2e-3 to 1e-2 of the island's kinetic energy).
    expect(bad).toBeGreaterThan(0);
  });
});
