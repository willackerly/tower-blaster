// Reference rigid-body solver: Augmented Vertex Block Descent (Giles, Diaz
// and Yuksel, SIGGRAPH 2025) in double precision, serial, deterministic.
// It is the oracle for the GPU solver and the place to tune parameters
// against the quality metrics without a GPU.
//
// It follows the authors' reference (github.com/savant117/avbd-demo2d,
// solver.cpp and manifold.cpp) taken to 3D:
// - Each body is a 6-dof block (position and a rotation vector relative to
//   the pose at the start of the step). The primal update solves its 6x6
//   system (inertia / h^2 plus k J J^T over its contact rows) and moves it.
// - Contacts are hard constraints with an augmented Lagrangian: force
//   f = clamp(k C + lambda), lambda updated in the dual step, and the
//   penalty k ramped by beta |C| while the force is inside its bounds.
// - Constraints are linearized at the start of the step (C0 + J dx).
// - Post-stabilization: the main iterations ignore penetration that existed
//   at the start of the step (alpha = 1), velocities are taken from them,
//   then one extra primal pass with alpha = 0 removes it without adding
//   energy.
// - Warm start: lambda carried over in full, the penalty decayed by gamma.
//   Static friction keeps the contact anchors of the previous step, so the
//   friction rows also correct tangential drift.
//
// Departures from the 2D reference, each needed in 3D or by our pipeline:
// - Speculative contacts: a positive gap at the start of the step is not
//   error, so it always counts in full (only penetration is scaled by
//   1 - alpha). With alpha = 1 a body would otherwise hover on the margin.
// - Persistence matches contact points by their anchor on body b (within
//   matchDistance) instead of clipping feature ids, and carries the friction
//   force as a world vector so a rotated tangent basis does not scramble it.
// - Speculative margins grow with each body's speed (see collide()).
// - Each touching pair keeps last step's SAT face axis unless another is
//   clearly better (geom/manifold.ts): aligned neighbours tie on several axes.
// - Friction is a cone (the two tangent rows clamped together to mu |lambda_n|).
// - Bodies are swept by graph colour (see coloring.ts), the order the
//   parallel GPU version uses, so the two can be compared step by step.
import { type BodyDesc, combineFriction, inertiaOf, massOf, type Quat, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { boundingRadius, cross, dot, groundManifold, NO_AXIS, quatMul, quatNormalize, rotate, shapeManifold, spherePairs } from '@tb/geom';
import { colorGraph } from './coloring.ts';
import { solveSpd6 } from './linalg.ts';

export interface AvbdParams {
  iterations: number;
  /** Penalty ramp per unit constraint error. */
  beta: number;
  /** Penalty decay per step when warm starting. */
  gamma: number;
  /** Stabilization when postStabilize is off: fraction of start-of-step error left uncorrected. */
  alpha: number;
  postStabilize: boolean;
  penaltyMin: number;
  penaltyMax: number;
  /** Speculative contact margin for the narrowphase. */
  margin: number;
  /** Allowed resting penetration (the reference's COLLISION_MARGIN). */
  slop: number;
  /** Tangential drift below which a contact may stick to its old anchors. */
  stickThreshold: number;
  /** A new contact point inherits an old one's state within this distance (on body b). */
  matchDistance: number;
  /** Angular speed clamp, rad/s (the reference clamps at 50). */
  maxAngularSpeed: number;
  /** Grow each body's contact margin by its per-step motion bound h (|v| + h|g| + |w| r). */
  sweep: boolean;
  /** Cap on that growth. */
  maxSweep: number;
  /** Use the cone projection's derivative as the friction Hessian while sliding (else k_t J J^T, as the reference). */
  slidingHessian: boolean;
}

export const DEFAULT_AVBD: AvbdParams = {
  iterations: 10, beta: 1e5, gamma: 0.99, alpha: 0.99, postStabilize: true, penaltyMin: 1, penaltyMax: 1e9,
  margin: 0.02, slop: 0, stickThreshold: 0.01, matchDistance: 0.05, maxAngularSpeed: 50, slidingHessian: true, sweep: true, maxSweep: 1,
};

export const GROUND = -1;

/** One contact point: three rows (normal, two tangents) between bodies a and b (a may be the ground). */
export interface Contact {
  a: number;
  b: number;
  /** Anchor in a's frame (world for the ground) and in b's frame. */
  ra: Vec3;
  rb: Vec3;
  n: Vec3;
  t1: Vec3;
  t2: Vec3;
  mu: number;
  /** C at the start of the step along n, t1, t2 (separation; < 0 is overlap). */
  c0: Vec3;
  /** Jacobian rows for a and b: 3 rows x 6 (linear, angular). */
  ja: Float64Array;
  jb: Float64Array;
  lambda: Vec3;
  k: Vec3;
  stick: boolean;
}

export interface BodyState {
  desc: BodyDesc;
  mass: number;
  /** Body-frame principal moments. */
  inertia: Vec3;
  pos: Vec3;
  rot: Quat;
  linVel: Vec3;
  angVel: Vec3;
  prevLinVel: Vec3;
}

/** Tangent basis continuous everywhere except near n = +-E (a direction no lattice normal takes). */
const E: Vec3 = [0.267261, 0.534522, 0.801784];
export function tangentBasis(n: Vec3): [Vec3, Vec3] {
  const c = cross(n, E);
  const l = Math.hypot(c[0], c[1], c[2]);
  const t1: Vec3 = l > 1e-6 ? [c[0] / l, c[1] / l, c[2] / l] : (Math.abs(n[0]) < 0.9 ? norm(cross(n, [1, 0, 0])) : norm(cross(n, [0, 1, 0])));
  return [t1, cross(n, t1)];
}
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** q advanced by rotation vector phi (exponential map), normalized. */
export function applyRotation(q: Quat, phi: Vec3): Quat {
  const t = Math.hypot(phi[0], phi[1], phi[2]);
  const s = t > 1e-9 ? Math.sin(t / 2) / t : 0.5 - t * t / 48;
  return quatNormalize(quatMul([phi[0] * s, phi[1] * s, phi[2] * s, Math.cos(t / 2)], q));
}

export interface StepStats { contacts: number; manifolds: number; colors: number }

/**
 * Solver state for a set of bodies. step() advances one fixed step; callers
 * add bodies between steps.
 */
export class AvbdWorld {
  readonly bodies: BodyState[] = [];
  contacts: Contact[] = [];
  /** Last step's SAT axis per touching pair (key `a,b`), preferred by this step's narrowphase. */
  axes = new Map<string, number>();
  stats: StepStats = { contacts: 0, manifolds: 0, colors: 0 };

  constructor(readonly scene: Pick<SceneDesc, 'gravity' | 'dt' | 'ground' | 'frictionCombine'>, readonly p: AvbdParams = DEFAULT_AVBD) {}

  add(b: BodyDesc): void {
    this.bodies.push({
      desc: b, mass: massOf(b), inertia: inertiaOf(b),
      pos: [...b.pos], rot: [...b.rot], linVel: [...b.linVel], angVel: [...b.angVel], prevLinVel: [...b.linVel],
    });
  }

  /** Find contacts at the current poses and carry state over from the previous step. */
  collide(): void {
    const { p, bodies } = this;
    const old = new Map<string, Contact[]>();
    for (const c of this.contacts) {
      const key = `${c.a},${c.b}`;
      const list = old.get(key);
      if (list) list.push(c); else old.set(key, [c]);
    }
    const out: Contact[] = [];
    let manifolds = 0;
    const emit = (a: number, b: number, normal: Vec3, points: Array<{ point: Vec3; depth: number }>, mu: number) => {
      manifolds++;
      const prev = old.get(`${a},${b}`) ?? [];
      const taken = new Set<Contact>();
      const A = a === GROUND ? null : bodies[a]!, B = bodies[b]!;
      for (const pt of points) {
        // Surface points: a's is the one further along n (it reaches into b).
        const wa: Vec3 = [pt.point[0] + normal[0] * pt.depth / 2, pt.point[1] + normal[1] * pt.depth / 2, pt.point[2] + normal[2] * pt.depth / 2];
        const wb: Vec3 = [pt.point[0] - normal[0] * pt.depth / 2, pt.point[1] - normal[1] * pt.depth / 2, pt.point[2] - normal[2] * pt.depth / 2];
        let ra: Vec3 = A ? rotate(conj(A.rot), sub3(wa, A.pos)) : wa;
        let rb: Vec3 = rotate(conj(B.rot), sub3(wb, B.pos));
        const [t1, t2] = tangentBasis(normal);
        let lambda: Vec3 = [0, 0, 0], k: Vec3 = [p.penaltyMin, p.penaltyMin, p.penaltyMin], stick = false;
        let best: Contact | null = null, bestD = p.matchDistance;
        for (const c of prev) {
          if (taken.has(c)) continue;
          const d = Math.hypot(c.rb[0] - rb[0], c.rb[1] - rb[1], c.rb[2] - rb[2]);
          if (d < bestD) { best = c; bestD = d; }
        }
        if (best) {
          taken.add(best);
          // Friction force as a world vector, re-expressed in the new basis.
          const f: Vec3 = [
            best.lambda[1] * best.t1[0] + best.lambda[2] * best.t2[0],
            best.lambda[1] * best.t1[1] + best.lambda[2] * best.t2[1],
            best.lambda[1] * best.t1[2] + best.lambda[2] * best.t2[2],
          ];
          lambda = [best.lambda[0], dot(f, t1), dot(f, t2)];
          const decay = (x: number) => Math.min(p.penaltyMax, Math.max(p.penaltyMin, x * p.gamma));
          k = [decay(best.k[0]), decay(best.k[1]), decay(best.k[2])];
          if (!p.postStabilize) lambda = [lambda[0] * p.alpha * p.gamma, lambda[1] * p.alpha * p.gamma, lambda[2] * p.alpha * p.gamma];
          stick = best.stick;
          if (stick) { ra = best.ra; rb = best.rb; }
        }
        // Start-of-step constraint and Jacobians, from the (possibly old) anchors.
        const raw = A ? rotate(A.rot, ra) : null; // lever arm of a, world
        const rbw = rotate(B.rot, rb);
        const pa = A ? add3(A.pos, raw!) : ra, pb = add3(B.pos, rbw);
        const d = sub3(pb, pa);
        const c0: Vec3 = [dot(d, normal) + p.slop, dot(d, t1), dot(d, t2)];
        const ja = new Float64Array(18), jb = new Float64Array(18);
        [normal, t1, t2].forEach((u, r) => {
          const xb = cross(rbw, u);
          jb.set([u[0], u[1], u[2], xb[0], xb[1], xb[2]], 6 * r);
          if (raw) {
            const xa = cross(raw, u);
            ja.set([-u[0], -u[1], -u[2], -xa[0], -xa[1], -xa[2]], 6 * r);
          }
        });
        out.push({ a, b, ra, rb, n: normal, t1, t2, mu, c0, ja, jb, lambda, k, stick });
      }
    };
    // Speculative contacts: each body's margin grows by how far any of its
    // points can move this step, so fast bodies are caught before they
    // overlap (resting ones pay nothing).
    const n = bodies.length, h = this.scene.dt, gl = Math.hypot(...this.scene.gravity);
    const centers = new Float64Array(3 * n), radii = new Float64Array(n), sweep = new Float64Array(n);
    bodies.forEach((b, i) => {
      centers.set(b.pos, 3 * i);
      radii[i] = boundingRadius(b.desc.shape);
      const v = Math.hypot(...b.linVel) + h * gl + Math.hypot(...b.angVel) * radii[i]!;
      sweep[i] = p.sweep ? Math.min(p.maxSweep, h * v) : 0;
    });
    const inflated = radii.map((r, i) => r + sweep[i]!);
    const rule = this.scene.frictionCombine ?? 'average';
    const axes = new Map<string, number>();
    for (const [i, j] of spherePairs(centers, inflated, p.margin)) {
      const A = bodies[i]!, B = bodies[j]!;
      const key = `${i},${j}`;
      const m = shapeManifold(A.desc.shape, A.pos, A.rot, B.desc.shape, B.pos, B.rot, p.margin + sweep[i]! + sweep[j]!, true, this.axes.get(key) ?? NO_AXIS);
      if (!m) continue;
      axes.set(key, m.axis);
      emit(i, j, m.normal, m.points, combineFriction(rule, A.desc.friction, B.desc.friction));
    }
    this.axes = axes;
    const g = this.scene.ground;
    if (g) {
      bodies.forEach((B, i) => {
        const m = groundManifold(B.desc.shape, B.pos, B.rot, g.y, p.margin + sweep[i]!);
        if (m) emit(GROUND, i, m.normal, m.points, combineFriction(rule, B.desc.friction, g.friction));
      });
    }
    this.contacts = out;
    this.stats.contacts = out.length;
    this.stats.manifolds = manifolds;
  }

  step(): void {
    const { p, bodies } = this;
    const h = this.scene.dt, gv = this.scene.gravity;
    const gl = Math.hypot(gv[0], gv[1], gv[2]);
    this.collide();
    const contacts = this.contacts;
    const n = bodies.length;

    // Per-body contact lists and the contact graph between dynamic bodies.
    const touching: number[][] = Array.from({ length: n }, () => []);
    const adj: Array<Set<number>> = Array.from({ length: n }, () => new Set());
    contacts.forEach((c, ci) => {
      touching[c.b]!.push(ci);
      if (c.a !== GROUND) {
        touching[c.a]!.push(ci);
        adj[c.a]!.add(c.b); adj[c.b]!.add(c.a);
      }
    });
    const color = colorGraph(adj.map((s) => [...s].sort((x, y) => x - y)));
    let colors = 0;
    for (let i = 0; i < n; i++) colors = Math.max(colors, color[i]! + 1);
    const byColor: number[][] = Array.from({ length: colors }, () => []);
    for (let i = 0; i < n; i++) byColor[color[i]!]!.push(i);
    this.stats.colors = colors;

    // Start-of-step state, inertial targets and warm-started guesses.
    // dx[i] = [position - start position, rotation vector since the start].
    const x0 = bodies.map((b) => [...b.pos] as Vec3);
    const q0 = bodies.map((b) => [...b.rot] as Quat);
    const dx = bodies.map(() => new Float64Array(6));
    const target = bodies.map(() => new Float64Array(6));
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      const w = b.angVel, ws = Math.hypot(w[0], w[1], w[2]);
      if (ws > p.maxAngularSpeed) b.angVel = [w[0] * p.maxAngularSpeed / ws, w[1] * p.maxAngularSpeed / ws, w[2] * p.maxAngularSpeed / ws];
      const v = b.linVel;
      // Adaptive warm start (VBD): expect gravity only as far as the body was accelerating with it.
      let wAcc = gl > 0 ? dot([(v[0] - b.prevLinVel[0]) / h, (v[1] - b.prevLinVel[1]) / h, (v[2] - b.prevLinVel[2]) / h], gv) / (gl * gl) : 0;
      wAcc = Number.isFinite(wAcc) ? Math.min(1, Math.max(0, wAcc)) : 0;
      for (let k = 0; k < 3; k++) {
        target[i]![k] = h * v[k]! + h * h * gv[k]!;
        target[i]![3 + k] = h * b.angVel[k]!;
        dx[i]![k] = h * v[k]! + h * h * gv[k]! * wAcc;
        dx[i]![3 + k] = h * b.angVel[k]!;
      }
    }
    // World inertia at the start of the step, row-major 3x3.
    const inertiaW = bodies.map((b) => {
      const I = new Float64Array(9);
      const ax = [rotate(b.rot, [1, 0, 0]), rotate(b.rot, [0, 1, 0]), rotate(b.rot, [0, 0, 1])];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) I[3 * r + c] = b.inertia[0] * ax[0]![r]! * ax[0]![c]! + b.inertia[1] * ax[1]![r]! * ax[1]![c]! + b.inertia[2] * ax[2]![r]! * ax[2]![c]!;
      return I;
    });

    // Constraint value of row r of contact c at the current dx.
    const C = new Float64Array(3);
    const evalC = (c: Contact, alpha: number) => {
      for (let r = 0; r < 3; r++) {
        const c0 = c.c0[r]!;
        // Start-of-step penetration is error (scaled by 1 - alpha); a gap is not.
        let v = r === 0 ? (c0 < 0 ? (1 - alpha) * c0 : c0) : (1 - alpha) * c0;
        const db = dx[c.b]!;
        for (let k = 0; k < 6; k++) v += c.jb[6 * r + k]! * db[k]!;
        if (c.a !== GROUND) { const da = dx[c.a]!; for (let k = 0; k < 6; k++) v += c.ja[6 * r + k]! * da[k]!; }
        C[r] = v;
      }
    };
    // Clamped forces for the current C: normal compressive only, friction inside the cone.
    // The tangent rows share one penalty k[1] (k[2] only mirrors it) so friction is
    // isotropic: per-row penalties tilt the force off the sliding direction.
    const F = new Float64Array(3), FZ = new Float64Array(4), K = new Float64Array(9);
    const evalF = (c: Contact) => {
      F[0] = Math.min(0, c.k[0] * C[0]! + c.lambda[0]);
      const bound = c.mu * Math.abs(c.lambda[0]);
      const f1 = c.k[1] * C[1]! + c.lambda[1], f2 = c.k[1] * C[2]! + c.lambda[2];
      const fl = Math.hypot(f1, f2);
      const s = fl > bound ? (fl > 0 ? bound / fl : 0) : 1;
      F[1] = f1 * s; F[2] = f2 * s;
      FZ[0] = fl; FZ[1] = bound; FZ[2] = f1; FZ[3] = f2;
      return fl <= bound; // inside the cone (sticking)
    };

    const lhs = new Float64Array(36), rhs = new Float64Array(6), step = new Float64Array(6);
    const total = p.iterations + (p.postStabilize ? 1 : 0);
    for (let it = 0; it < total; it++) {
      const alpha = p.postStabilize ? (it < p.iterations ? 1 : 0) : p.alpha;
      // Primal: one Gauss-Seidel sweep, colour by colour.
      for (const group of byColor) {
        for (const i of group) {
          const b = bodies[i]!;
          lhs.fill(0);
          const mh = b.mass / (h * h), I = inertiaW[i]!, d = dx[i]!, t = target[i]!;
          for (let k = 0; k < 3; k++) {
            lhs[7 * k] = mh;
            rhs[k] = mh * (d[k]! - t[k]!);
          }
          for (let r = 0; r < 3; r++) {
            let s = 0;
            for (let c = 0; c < 3; c++) {
              lhs[6 * (3 + r) + 3 + c] = I[3 * r + c]! / (h * h);
              s += I[3 * r + c]! * (d[3 + c]! - t[3 + c]!);
            }
            rhs[3 + r] = s / (h * h);
          }
          for (const ci of touching[i]!) {
            const c = contacts[ci]!;
            evalC(c, alpha);
            const sticking = evalF(c);
            const J = c.b === i ? c.jb : c.ja;
            // Row stiffness K (3x3): k_n on the normal; on the tangents k_t
            // while sticking, else the derivative of the cone projection,
            // k_t (bound / |z|) (I - z z^T / |z|^2): no stiffness along the
            // slide, where the force no longer depends on displacement.
            K.fill(0);
            K[0] = c.k[0];
            if (sticking || !p.slidingHessian) { K[4] = c.k[1]; K[8] = c.k[1]; }
            else if (FZ[0]! > 0) {
              const s = c.k[1] * FZ[1]! / FZ[0]!, zx = FZ[2]! / FZ[0]!, zy = FZ[3]! / FZ[0]!;
              K[4] = s * (1 - zx * zx); K[5] = K[7] = -s * zx * zy; K[8] = s * (1 - zy * zy);
            }
            for (let r = 0; r < 3; r++) {
              const f = F[r]!;
              for (let u = 0; u < 6; u++) rhs[u] = rhs[u]! + J[6 * r + u]! * f;
              for (let q = 0; q < 3; q++) {
                const k = K[3 * r + q]!;
                if (k === 0) continue;
                for (let u = 0; u < 6; u++) {
                  const ju = k * J[6 * r + u]!;
                  for (let v = 0; v < 6; v++) lhs[6 * u + v] = lhs[6 * u + v]! + ju * J[6 * q + v]!;
                }
              }
            }
          }
          solveSpd6(lhs, rhs, step);
          for (let k = 0; k < 6; k++) d[k] = d[k]! - step[k]!;
        }
      }
      // Dual: update forces and penalties (not in the stabilization pass).
      if (it < p.iterations) {
        for (const c of contacts) {
          evalC(c, alpha);
          const bound = c.mu * Math.abs(c.lambda[0]);
          c.lambda[0] = Math.min(0, c.k[0] * C[0]! + c.lambda[0]);
          if (c.lambda[0] < 0) c.k[0] = Math.min(c.k[0] + p.beta * Math.abs(C[0]!), p.penaltyMax);
          const f1 = c.k[1] * C[1]! + c.lambda[1], f2 = c.k[1] * C[2]! + c.lambda[2];
          const fl = Math.hypot(f1, f2);
          if (fl < bound) {
            c.lambda[1] = f1; c.lambda[2] = f2;
            c.k[1] = c.k[2] = Math.min(c.k[1] + p.beta * Math.hypot(C[1]!, C[2]!), p.penaltyMax);
          } else {
            const s = fl > 0 ? bound / fl : 0;
            c.lambda[1] = f1 * s; c.lambda[2] = f2 * s;
          }
        }
      }
      // Velocities from the last main iteration (BDF1); stabilization moves positions only.
      if (it === p.iterations - 1) {
        for (let i = 0; i < n; i++) {
          const b = bodies[i]!, d = dx[i]!;
          b.prevLinVel = b.linVel;
          b.linVel = [d[0]! / h, d[1]! / h, d[2]! / h];
          b.angVel = [d[3]! / h, d[4]! / h, d[5]! / h];
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!, d = dx[i]!;
      b.pos = [x0[i]![0] + d[0]!, x0[i]![1] + d[1]!, x0[i]![2] + d[2]!];
      b.rot = applyRotation(q0[i]!, [d[3]!, d[4]!, d[5]!]);
    }
    for (const c of contacts) {
      c.stick = Math.hypot(c.lambda[1], c.lambda[2]) < c.mu * Math.abs(c.lambda[0]) && Math.hypot(c.c0[1], c.c0[2]) < p.stickThreshold;
    }
  }
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
