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
// Departure from the paper, for resting stacks: a reused contact's normal
// penalty starts the step at no less than |lambda_n| / restDepth. At rest the
// main iterations see no error (alpha = 1), so beta never ramps k up again,
// and gamma alone would decay it 1% a step. A stack's resistance to tilting is
// about iterations x k_n x (lever arm)^2 per interface; once that falls below
// what its weight needs, a tall stack leans over by itself, growing from
// rounding error (by 0.3-6% a step on Keystone's levels, as k decays).
// The floor keeps k_n proportional to the load it carries, so it holds for
// any mass or load. It is not size-free: by an estimate, cubes of half-width
// w under a lever arm L need restDepth well below iterations x w^2 / L.
//
// The floor alone is a ratchet: max(gamma k_n, |lambda_n| / restDepth) holds
// the largest |lambda_n| / restDepth of the last ~100 steps, and the beta
// ramp's increments too. A landing (a tower's pre-settle, a kick) presses
// contacts with several times their resting load, and a column taller than
// the iterations resolve (24+ unit cubes at 10) is unstable to kicks once its
// k_n sits at about 2x the floor of its resting load: it bounces, each landing
// raises k_n again, and it boils for good (0.3-0.5 m/s, cubes 2 cm up; a
// packed 8x8x30 tower too, 2026-10-26). So each step k_n is also pulled down
// towards loadCap x the floor of the largest load on a point of its pair: a
// transient fades from k_n once it ends, and a resting contact keeps its
// floor. The reference is the pair's most loaded point, not the point's own
// load: when a pair rocks, the side that lifts keeps the stiffness of the
// side that bears. On its own load it went soft, and a 20-cube column rocking
// back from 2 degrees (S13) gained energy and fell over. On the pair's mean
// load per point, S13 columns of 16-30 cubes released 0.5-1.5 degrees off
// upright at 20 iterations toppled within 30 s in 10 of 19 cases, against 4
// with the floor alone and 6 with the largest load (the rule used here): the
// softer landing side sinks in further, and post-stabilization lifts it out
// without slowing it. The largest load still costs: over four 35-case sets
// (18-30 cubes, 0.5-1.5 degrees, each angle also nudged by +-0.002 and
// +0.004) it toppled 60 of 140 against 36 with the floor alone at 20
// iterations, and 70 of 70 against 65 at 10. Whether a column below its
// tipping angle falls on a later swing is decided by tiny energy gains at
// its landings (physics-ref/test/collapse.test.ts); at 20 iterations the cap
// makes them slightly less dissipative (far side 0.90 vs 0.87 of the rigid
// column's; at 10, 0.63 vs 0.64). A higher loadCap is no remedy: on 12 of
// these cases (16-30 cubes, 20 iterations) loadCap 1.25, 1.5 and 1.75 each
// toppled 3, as did the floor alone. With capFall, loadCap 1.25-2 rest the
// columns above alike (24-40 cubes, kicked or not); 1.25 is the value the
// idle-city and review runs used.
//
// k_n is eased down to the cap, not dropped to it: each step it is at least
// capFall x what it would have been uncapped (gamma decay, the floor and the
// beta ramp). A contact still in an impact has its k_n climbing the ramp
// faster than capFall pulls it down, so it is not held back while that
// matters, and the cap only bites a dozen-odd steps later, once the impact is
// over. This is why no contact needs an exception. Dropped to the cap at once
// (capFall 0), a 510 kg ball resting on a 31 kg cube sank it 0.9 mm (the
// ground contact lost the stiffness the ramp had built), a ball rolling over
// a sphere sank into it (its fresh point lost the ramp every step), and a
// 100x heavier cube bounced for good on a column of 16-24 cubes whose top
// pair kept lifting off and landing on a softened contact; with capFall 0.85
// all three hold to the floor-alone depth. After a heavy landing the cap
// leaves the penetration to post-stabilization, which removes it about 0.4%
// a step on a 25-cube column, as the floor alone does at rest; the floor
// alone got there sooner by bouncing it out (S9, 24 cubes under a 1000x
// heavier one, 10 iterations: under 0.1 mm by step 1094 vs 254, the same
// 6.9 mm peak). A ball knocking a tower down penetrates as deep: the mean
// sampled maximum is 0.0031 m with and without the cap, over 40 runs at each
// of 5 ball speeds, each run's start moved by up to 1e-6 m (the scene of
// physics-gpu/test/engine.test.ts).
//
// Departures from the 2D reference, each needed in 3D or by our pipeline:
// - Speculative contacts: a positive gap at the start of the step is not
//   error, so it always counts in full (only penetration is scaled by
//   1 - alpha). With alpha = 1 a body would otherwise hover on the margin.
// - Persistence matches contact points by their anchor on body b (within
//   matchDistance) instead of clipping feature ids, and carries the friction
//   force as a world vector so a rotated tangent basis does not scramble it.
// - Rolling contacts (any contact on a sphere) keep no anchors: see collide().
// - Speculative margins grow with each body's speed (see collide()).
// - Each touching pair keeps last step's SAT face axis unless another is
//   clearly better (geom/manifold.ts): aligned neighbours tie on several axes.
// - Friction is a cone (the two tangent rows clamped together to mu |lambda_n|),
//   and a sliding contact's stiffness is the secant of that clamp (see step()).
// - Bodies are swept by graph colour (see coloring.ts), the order the
//   parallel GPU version uses, so the two can be compared step by step.
//
// Restitution is opt-in (AvbdParams.restitution, off by default): a velocity
// pass after post-stabilization (see restitute()). A contact point that
// carried force and approached at restitutionThreshold (1 m/s) or faster at
// the start of the step is set to leave, at the end of that step, at e times
// that normal speed. e is the pair's, combineRestitution under
// SceneDesc.restitutionCombine (default average, Rapier's) clamped to [0, 1],
// and the ground's own e is SceneDesc.ground.restitution (default 0: under
// average a body bounces off the ground at half its e). restitutionRounds (8)
// rounds of mass-split Jacobi solve the bouncing manifolds together with the
// other loaded contacts of their bodies. Off, the step never reads
// BodyDesc.restitution, and runs are bit-identical to those before it
// existed. Its known limits, at 10 iterations, e being the pair's, under the
// default average unless a rule is named:
// - The bounce is step-based: gravity acts over the impact step, so measured
//   at contact a drop's rebound falls short of e, by 2-7% at 5-10 m/s and more
//   at low speed: at 2 m/s it keeps 0.76 of e at e 0.3, and 0.62 at e 0.15 (an
//   e 0.3 body on the default ground).
// - Energy can grow wherever the solve drifts momentum, at any e > 0. The pass
//   keeps momentum to rounding (at most 7.1e-15 N s over 78 zero-g scenes);
//   the gain is the solve's drift, which shows once contacts stop absorbing
//   energy. In zero g: unit-cube pairs meeting head-on at 10 m/s end with
//   1.023, 1.158 and 1.383 x their kinetic energy at e 0.3, 0.6 and 0.9 (1.061
//   at e 0.9 and 20 iterations), a 1:5 pair 1.015 x at e 0.9; with the switch
//   off the solve already moves those pairs' momentum by up to 46% (41% for
//   1:1; 15% at 20 iterations). Chains of 3 and 5 unit cubes 0.05 m apart,
//   struck at 10 m/s, end with 1.14 and 1.48 x at e 0.9 (none at 20
//   iterations); there the solve drifts momentum 4.6 and 2.8 x as much as with
//   the switch off (the chain of 5 from 10 to 17.0 N s, against 12.5). A chain
//   of 5 spheres gains 23% at e 1 (2.6% at 20 iterations). Outside zero-g
//   pairs and chains, no probe gains beyond the switch-off solve at e <= 0.9.
// - e = 1 is not energy-safe: rods (0.2 x 2 x 0.2) dropped tilted from 1 m
//   gained up to about 0.8 of their energy above lying flat (0.78 at 8 rounds,
//   0.81 at 4, worst at 30 degrees), and with the ground at e 1 too (rule max)
//   cubes dropped tilted gained up to 16% and tumbling ones 3.1% (a pair e of
//   0.95, average with the ground at 1, gained 1.5% on one tilted cube).
//   Beyond 8 rounds the pass overshoots at e = 1 (see restitute()).
// - The pass's impulse is along n only: a cube landing on an edge, turned 30
//   degrees, at mu 0.6 keeps 0.36-0.83 of the rigid impact's vertical rebound
//   and spins at 1.66-3.06 x its spin (frictionless: 0.83-0.98 of the rebound,
//   0.97-1.00 of the spin; rule max).
// - Heavy on light: a body struck while it rests on others is held by them
//   only as far as the rounds converge, and they converge more slowly the
//   heavier the striker (see restitute()). A ball (radius 0.25) dropped
//   at 10 m/s onto a 1 kg cube on the ground, e 0.6-0.9 everywhere, rebounds
//   at 0.59-0.67 of e v at 1 kg, 0.27-0.32 at 5 kg and 0.02-0.04 at 50 kg (no
//   better than with the switch off), and the pass drives the cube into the
//   ground at about the bounce's speed: 4.7-5.7 m/s at 5 kg, 8.5-10 at 510 kg,
//   against 0.09 and 0.80 off. No energy is gained, but the ball sinks deeper:
//   at 510 kg up to 0.17 m into the cube over ball and cube e of 0.05-0.9
//   (0.18 under max), against 0.11 m off, and from 2000 kg the ball can go
//   through the cube to the ground (3 of 4 cases at 10-20 m/s), which off
//   holds up to 5000 kg at 10 m/s. A 144 kg rubber ball (e 0.6) at 20 m/s on a
//   10-cube plaster column (e 0.05) sinks 0.19 m into it, against 0.08 m off
//   (0.11 under max).
import { type BodyDesc, combineFriction, combineRestitution, DEFAULT_RESTITUTION_COMBINE, inertiaOf, massOf, type Quat, type SceneDesc, type Vec3 } from '@tb/engine-api';
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
  /** Scale the friction stiffness by the cone clamp, k_t min(1, bound / |z|), while sliding (else k_t J J^T, as the reference). */
  slidingHessian: boolean;
  /**
   * Load floor, m: a reused contact's normal penalty starts the step at least
   * |lambda_n| / restDepth, the stiffness at which last step's normal force
   * would press it in by restDepth. 0 turns it off (the paper's warm start).
   */
  restDepth: number;
  /**
   * Rolling contacts: a contact on a sphere takes its points fresh from the
   * narrowphase every step, carries static friction's slip instead of its
   * anchors, is matched by the sphere's lever arm in world space, and in an
   * impact caps its load floor (see collide()). false treats it as a box's
   * contact.
   */
  rollingContacts: boolean;
  /**
   * Load cap: with the floor on, a reused contact's normal penalty is also
   * pulled down each step towards loadCap x (the largest |lambda_n| on a point
   * of its pair) / restDepth (never below its own floor), at the rate capFall,
   * so it forgets transients once they end. 0 turns it off (the floor alone,
   * which keeps them: see above).
   */
  loadCap: number;
  /**
   * How fast the normal penalty falls to the load cap: at least capFall x what
   * it would have been without the cap, each step. 0 drops it to the cap at
   * once (see above).
   */
  capFall: number;
  /**
   * Restitution, opt-in (see restitute()): off when absent or false. Off, the
   * step does no extra work and never reads BodyDesc.restitution, so impacts
   * are close to perfectly inelastic. The restitution keys are not in
   * DEFAULT_AVBD (their defaults are RESTITUTION_DEFAULTS), and
   * EngineInfo.variant lists them only while the switch is on (avbdVariant),
   * so the result keys of runs without it are as they were before it existed.
   */
  restitution?: boolean;
  /**
   * Normal approach speed at the start of the step, m/s, from which a contact
   * bounces (>=, as Box2D's threshold). Default 1 (RESTITUTION_DEFAULTS); a
   * finite number >= 0, where 0 lets any loaded approaching point bounce.
   */
  restitutionThreshold?: number;
  /**
   * Rounds of the restitution pass (see restitute()): more bounce off bodies
   * that rest on others, for more work. Default 8 (RESTITUTION_DEFAULTS); an
   * integer >= 1.
   */
  restitutionRounds?: number;
}

export const DEFAULT_AVBD: AvbdParams = {
  iterations: 10, beta: 1e5, gamma: 0.99, alpha: 0.99, postStabilize: true, penaltyMin: 1, penaltyMax: 1e9,
  margin: 0.02, slop: 0, stickThreshold: 0.01, matchDistance: 0.05, maxAngularSpeed: 50, slidingHessian: true, sweep: true, maxSweep: 1, restDepth: 0.003,
  rollingContacts: true, loadCap: 1.25, capFall: 0.85,
};

/** The restitution keys' defaults while AvbdParams.restitution is on (Box2D's threshold is 1 m/s too; rounds: see restitute()). */
export const RESTITUTION_DEFAULTS = { restitutionThreshold: 1, restitutionRounds: 8 } as const;

/**
 * Opt-in switches and the params that only matter while they are on, with
 * their defaults. EngineInfo.variant leaves a switch and its params out while
 * it is off (avbdVariant), so adding one does not change the result keys of
 * runs that do not use it.
 */
export const OPT_IN: Partial<Record<keyof AvbdParams, Partial<AvbdParams>>> = { restitution: RESTITUTION_DEFAULTS };

/** EngineInfo.variant for these params: every param, but an opt-in switch and its params only while it is on, with their defaults filled in. */
export function avbdVariant(p: AvbdParams): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  for (const [s, defaults] of Object.entries(OPT_IN)) {
    if (out[s]) for (const [k, v] of Object.entries(defaults)) out[k] ??= v;
    else for (const k of [s, ...Object.keys(defaults)]) delete out[k];
  }
  return out;
}

/** Throws on a restitution param out of range, whether the switch is on or not. */
export function checkRestitution(p: Partial<AvbdParams>): void {
  const t = p.restitutionThreshold, r = p.restitutionRounds;
  if (t !== undefined && !(Number.isFinite(t) && t >= 0)) throw new Error(`AvbdParams.restitutionThreshold must be a finite number >= 0, got ${t}`);
  if (r !== undefined && !(Number.isInteger(r) && r >= 1)) throw new Error(`AvbdParams.restitutionRounds must be an integer >= 1, got ${r}`);
}

export const GROUND = -1;

/** One contact point: three rows (normal, two tangents) between bodies a and b (a may be the ground). */
export interface Contact {
  a: number;
  b: number;
  /** Anchor in a's frame (world for the ground) and in b's frame. */
  ra: Vec3;
  rb: Vec3;
  /** The lever arms in world space at the start of the step (a's is 0 for the ground). */
  raw: Vec3;
  rbw: Vec3;
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

export interface StepStats {
  contacts: number;
  manifolds: number;
  colors: number;
  /**
   * What this step's restitution pass did (all 0 with the switch off): the
   * points it bounced, the normal impulse it applied in all (N s, supports
   * included), the change of the bodies' total linear momentum, and the impulse
   * it took from the ground. Every impulse between two bodies acts on both,
   * equal and opposite, so momentum equals groundImpulse to rounding.
   */
  restitution: { contacts: number; impulse: number; momentum: Vec3; groundImpulse: Vec3 };
}

/**
 * Solver state for a set of bodies. step() advances one fixed step; callers
 * add bodies between steps.
 */
export class AvbdWorld {
  readonly bodies: BodyState[] = [];
  contacts: Contact[] = [];
  /** Last step's SAT axis per touching pair (key `a,b`), preferred by this step's narrowphase. */
  axes = new Map<string, number>();
  stats: StepStats = { contacts: 0, manifolds: 0, colors: 0, restitution: { contacts: 0, impulse: 0, momentum: [0, 0, 0], groundImpulse: [0, 0, 0] } };
  /** Each body's last step, [position change, rotation vector] (what the GPU keeps in SolverBody.dp, phi until the next initBodies). */
  lastDx: Float64Array[] = [];

  constructor(readonly scene: Pick<SceneDesc, 'gravity' | 'dt' | 'ground' | 'frictionCombine' | 'restitutionCombine'>, readonly p: AvbdParams = DEFAULT_AVBD) {}

  add(b: BodyDesc): void {
    this.bodies.push({
      desc: b, mass: massOf(b), inertia: inertiaOf(b),
      pos: [...b.pos], rot: [...b.rot], linVel: [...b.linVel], angVel: [...b.angVel], prevLinVel: [...b.linVel],
    });
  }

  /**
   * Find contacts at the current poses and carry state over from the previous step.
   *
   * Rolling contacts. A box's contact points are material points: a corner, or
   * a point of a face that moves with the box while it sticks. Keeping their
   * anchors under static friction is exact. On a sphere the contact point is
   * not a material point: it is wherever the surface faces the other body,
   * centre + R n in world space whichever way the sphere has turned, and on a
   * rolling sphere a new material point touches every step, as does a new
   * point of the face or ground it rolls on. Kept anchors there are wrong:
   * the old material point has rotated R (1 - cos theta) up off the contact,
   * which the normal row reads as a gap (the ball sinks), and R theta = v h
   * along the surface, which loses the match above matchDistance / h (the
   * force and penalty restart from zero every step). So any contact on a
   * sphere (when rollingContacts is on):
   * - takes all three rows from this step's narrowphase point: the gap, and
   *   the lever arms of the normal and friction rows (the friction torque
   *   needs the arm at the contact, not a tilted one);
   * - carries static friction as slip, not anchors: the relative tangential
   *   displacement of the material points in contact, summed over the steps
   *   it has held. Last step's is its tangential C at the end of the step,
   *   c0_t + J_t dx (c0_t being the slip carried into it). For a sphere that
   *   is exact, not a linearization: the point in contact stays at the same
   *   lever arm r, so its slip over a step is dp + phi x r, and rolling
   *   (v = -w x r) gives 0. Kept material anchors would measure the
   *   cycloid, R (theta - sin theta) per step, as slip. As with anchors,
   *   slip of stickThreshold or more is dropped;
   * - is matched by the sphere's lever arm in world space, which only moves
   *   as the normal turns: R |dn| < matchDistance however fast it rolls,
   *   slides or spins (its anchor on the other body moves with the sphere's
   *   speed, its body-frame anchor with its spin). Between two spheres it is
   *   the smaller one's arm: a ball of radius r rolling at v over a sphere of
   *   radius R turns the normal by v h / (R + r) per step, which moves the
   *   ball's arm r v h / (R + r) but the big sphere's R v h / (R + r), nearly
   *   v h, so keyed on that one the match was lost above about 3 m/s again;
   * - between two bodies, gets a load floor (restDepth) of at most
   *   sqrt(m_a m_b) / h^2 if it moved along its normal by restDepth or more
   *   last step (|n . J dx|): it was in an impact, not at rest. Matched this
   *   way, a ball's contact persists through an impact (kept anchors often
   *   lost it there: the spin and the turning normal moved them past
   *   matchDistance, and k restarted at penaltyMin), and the full floor
   *   would read the impact force as a load: k_n of 20 x a 1 kg cube's
   *   m / h^2. A Gauss-Seidel sweep shrinks the two bodies' disagreement
   *   about the contact by rho = k^2 / ((k + a)(k + b)), with a = m_a / h^2
   *   and b = m_b / h^2, near 1 there: uncapped, a 5 kg ball hitting a 1 kg
   *   cube in zero g at 10 iterations lost 9.0% of the momentum head-on and
   *   5.1% grazing. With k at most sqrt(ab), rho is at most
   *   sqrt(ab) / (sqrt a + sqrt b)^2 <= 1/4 for any mass ratio: 0.41% and
   *   0.11%. (Kept anchors: 9.0% head-on, where the match held, and 0.15%
   *   grazing, where it broke and k restarted.) Contacts at rest (a resting
   *   or rolling ball, a ball under a heavy load) and on the ground keep the
   *   full floor; beta still ramps k in an impact.
   *   The cost: a heavy ball landing on a light body that rests on something
   *   else goes deeper, as the light body's own mass understates what backs
   *   it. A 510 kg steel ball dropped 1 m onto a 1 kg cube on the ground
   *   reaches 74.7 mm at 10 iterations (19.1 mm with kept anchors and the
   *   full floor); onto Keystone's 31 kg plaster cube, 24.6 mm (23.5 mm).
   */
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
      // A rolling contact (see above) is matched by a sphere's world lever arm: the smaller sphere's (b's if they are
      // equal; a box or the ground counts as infinitely large).
      const roll = p.rollingContacts && (B.desc.shape.kind === 'sphere' || A?.desc.shape.kind === 'sphere');
      // The load cap's reference: last step's largest normal force on a point of this pair.
      let pairLoad = 0;
      if (p.loadCap > 0) for (const c of prev) pairLoad = Math.max(pairLoad, Math.abs(c.lambda[0]));
      const radius = (s: BodyState | null) => (s?.desc.shape.kind === 'sphere' ? s.desc.shape.radius : Infinity);
      const onB = radius(B) <= radius(A);
      for (const pt of points) {
        // Surface points: a's is the one further along n (it reaches into b).
        const wa: Vec3 = [pt.point[0] + normal[0] * pt.depth / 2, pt.point[1] + normal[1] * pt.depth / 2, pt.point[2] + normal[2] * pt.depth / 2];
        const wb: Vec3 = [pt.point[0] - normal[0] * pt.depth / 2, pt.point[1] - normal[1] * pt.depth / 2, pt.point[2] - normal[2] * pt.depth / 2];
        let ra: Vec3 = A ? rotate(conj(A.rot), sub3(wa, A.pos)) : wa;
        let rb: Vec3 = rotate(conj(B.rot), sub3(wb, B.pos));
        const [t1, t2] = tangentBasis(normal);
        let lambda: Vec3 = [0, 0, 0], k: Vec3 = [p.penaltyMin, p.penaltyMin, p.penaltyMin], stick = false;
        let best: Contact | null = null, bestD = p.matchDistance;
        const key = roll ? (onB ? sub3(wb, B.pos) : sub3(wa, A!.pos)) : rb;
        for (const c of prev) {
          if (taken.has(c)) continue;
          const o = roll ? (onB ? c.rbw : c.raw) : c.rb;
          const d = Math.hypot(o[0] - key[0], o[1] - key[1], o[2] - key[2]);
          if (d < bestD) { best = c; bestD = d; }
        }
        let slip: [number, number] | null = null;
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
          if (p.restDepth > 0) {
            // Load floor. A rolling contact between two bodies that moved along its normal by restDepth
            // last step was in an impact, not at rest: its floor stops at sqrt(m_a m_b) / h^2 (see above).
            // Load cap (see the header): k_n is eased towards loadCap x the floor of the pair's largest load, falling
            // each step to no less than capFall x its uncapped value.
            let floor = Math.abs(best.lambda[0]) / p.restDepth;
            if (roll && A && Math.abs(dot(best.n, this.moveAfter(best))) >= p.restDepth) floor = Math.min(floor, Math.sqrt(A.mass * B.mass) / (this.scene.dt * this.scene.dt));
            if (p.loadCap > 0) k[0] = Math.max(p.penaltyMin, Math.min(k[0], Math.max(p.loadCap * (pairLoad / p.restDepth), p.capFall * k[0])));
            k[0] = Math.min(p.penaltyMax, Math.max(k[0], floor));
          }
          if (!p.postStabilize) lambda = [lambda[0] * p.alpha * p.gamma, lambda[1] * p.alpha * p.gamma, lambda[2] * p.alpha * p.gamma];
          // Static friction held at the end of last step: keep its anchors, unless they
          // have drifted apart along the surface by stickThreshold since (as the step's
          // stabilization pass would pull the bodies that far back).
          if (best.stick && roll) {
            // A rolling contact keeps its fresh points and carries last step's slip as c0_t.
            const s = this.slipAfter(best), s1 = dot(s, t1), s2 = dot(s, t2);
            if (Math.hypot(s1, s2) < p.stickThreshold) { stick = true; slip = [s1, s2]; }
          } else if (best.stick) {
            const pa = A ? add3(A.pos, rotate(A.rot, best.ra)) : best.ra, d = sub3(add3(B.pos, rotate(B.rot, best.rb)), pa);
            if (Math.hypot(dot(d, t1), dot(d, t2)) < p.stickThreshold) { stick = true; ra = best.ra; rb = best.rb; }
          }
        }
        // Start-of-step constraint and Jacobians, from the (possibly old) anchors.
        const raw = A ? rotate(A.rot, ra) : null; // lever arm of a, world
        const rbw = rotate(B.rot, rb);
        const pa = A ? add3(A.pos, raw!) : ra, pb = add3(B.pos, rbw);
        const d = sub3(pb, pa);
        const c0: Vec3 = [dot(d, normal) + p.slop, dot(d, t1), dot(d, t2)];
        if (slip) { c0[1] += slip[0]; c0[2] += slip[1]; }
        const ja = new Float64Array(18), jb = new Float64Array(18);
        [normal, t1, t2].forEach((u, r) => {
          const xb = cross(rbw, u);
          jb.set([u[0], u[1], u[2], xb[0], xb[1], xb[2]], 6 * r);
          if (raw) {
            const xa = cross(raw, u);
            ja.set([-u[0], -u[1], -u[2], -xa[0], -xa[1], -xa[2]], 6 * r);
          }
        });
        out.push({ a, b, ra, rb, raw: raw ?? [0, 0, 0], rbw, n: normal, t1, t2, mu, c0, ja, jb, lambda, k, stick });
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

  /** How far a contact's point on b moved relative to a's over last step, J dx as a world vector: (dp + phi x r) on b minus a. */
  moveAfter(c: Contact): Vec3 {
    const zero = new Float64Array(6);
    const db = this.lastDx[c.b] ?? zero, da = c.a === GROUND ? zero : this.lastDx[c.a] ?? zero;
    const ub = add3([db[0]!, db[1]!, db[2]!], cross([db[3]!, db[4]!, db[5]!], c.rbw));
    const ua = add3([da[0]!, da[1]!, da[2]!], cross([da[3]!, da[4]!, da[5]!], c.raw));
    return sub3(ub, ua);
  }
  /** A contact's slip at the end of last step, as a world vector: its tangential C at the final dx, c0_t + J_t dx. */
  slipAfter(c: Contact): Vec3 {
    const u = this.moveAfter(c), s1 = c.c0[1] + dot(c.t1, u), s2 = c.c0[2] + dot(c.t2, u);
    return [s1 * c.t1[0] + s2 * c.t2[0], s1 * c.t1[1] + s2 * c.t2[1], s1 * c.t1[2] + s2 * c.t2[2]];
  }

  /**
   * Restitution (AvbdParams.restitution): a velocity pass once the step's
   * velocities are final (after post-stabilization, which moves positions
   * only), as XPBD (Mueller et al. 2020) and Box2D v3 (applyRestitution) do.
   * Positions are not touched: the bounce shows from the next step on.
   *
   * - A contact point bounces if the coefficient of its pair, e =
   *   combineRestitution(SceneDesc.restitutionCombine, e_a, e_b) clamped to
   *   [0, 1] (the ground's e is SceneDesc.ground.restitution, default 0), is
   *   above 0, it approached at restitutionThreshold or faster at the start of
   *   the step (its normal relative velocity vn0 = J_n u0 from the
   *   start-of-step velocities, after the angular clamp, is -threshold or
   *   less), and it ended the step loaded (lambda_n < 0). A resting contact
   *   has vn0 ~ 0 (v = dx / h of a body at rest), so it never qualifies.
   * - Its target is the normal velocity -e vn0. Normal impulses P >= 0 per
   *   point (equal and opposite on the two bodies, so momentum is kept to
   *   rounding) raise each point's normal velocity to its target: the pass
   *   sets the rebound, it does not add e vn0 to whatever the solve left (a
   *   penalty rebound already above the target is left as it is). It never
   *   pulls bodies together, and acts along n only: friction is what the
   *   solve gave (bounded by mu |lambda_n|, as Box2D's restitution leaves it).
   * - Supports, depth 1: every other loaded point (lambda_n < 0) of a body in
   *   a bouncing manifold takes part too, as a one-sided constraint that keeps
   *   its normal velocity at no less than the solve left it (target vn, P >=
   *   0). Without them the struck body is free for the impulse: a 510 kg ball
   *   (e 0.9, 10 m/s) bouncing off a 1 kg cube on the ground drove the cube
   *   into the ground at 19 m/s, the two then threw each other about (a gain
   *   of 8.17 x the impact's energy, bodies at 81.8 m/s after 10 s); a 1 kg
   *   ball onto a 0.4 kg cube on the ground gained 2.45 x. With them: no
   *   gain, and both come to rest. The cost is a softer bounce off a body
   *   that rests on others: a ball of e 0.9 at 3 m/s rebounds off a resting
   *   cube at 0.15 of its approach with 4 rounds, 0.49 with 8 and 0.73 with
   *   16, against 0.45-0.49 in Rapier. They hold the struck body only as far
   *   as the rounds converge, and that takes longer the heavier the striker:
   *   a 5 kg ball gets 0.19 of its approach at 8 rounds, and drives the cube
   *   down at 1.75 m/s (0.07 with the switch off). The 510 kg ball above
   *   still drives the cube into the ground at 10.0 m/s after 8 rounds (9.5
   *   after 128), against 0.8 off, and comes back at 0.54 m/s against 1.61;
   *   from 2000 kg a ball can go through the cube (see the header).
   * - The points of one manifold are solved together: each round first takes
   *   the impulse at their centroid that brings the centroid's normal
   *   velocity to the mean target (exact line search along equal per-point
   *   impulses), then one Gauss-Seidel sweep over the points. A flat or
   *   balanced landing (equal targets, impulse through the centre of mass) is
   *   done by the centroid step with no spin; a sweep over the points alone
   *   would leave spin behind (the 4 corners of a unit cube, 1 m/s target:
   *   0.4 rad/s after one sweep, 8e-6 after 6), as Rapier's flat cubes show
   *   (3.6 rad/s). Each step is an exact minimization of the pass's convex
   *   quadratic along one direction, so it cannot overshoot.
   * - Manifolds are coupled by mass splitting (Tonge, Benevolenski and
   *   Voroshilov 2012): every round, each manifold solves against a copy of
   *   last round's velocities in which each of its bodies has its mass and
   *   inertia divided by the number of the pass's manifolds it is in, and
   *   then every body takes the sum of its manifolds' impulses with its own
   *   mass. That is Jacobi across manifolds (the GPU can run one thread per
   *   manifold, then one per body), and it converges where plain Jacobi would
   *   overshoot (two manifolds pushing one body the same way: two cubes
   *   striking a box side by side at e 1 gained 32% of the energy in one
   *   round). Below e 1 no probe gained energy from more rounds (up to 32;
   *   64 for the two cubes), so restitutionRounds trades bounce for work: a
   *   body held by its supports, or struck from two sides at once, needs
   *   several rounds. 8 by default (RESTITUTION_DEFAULTS), for the bounce
   *   off a resting cube above; the GPU will pay about 2 dispatches a round,
   *   and only with the switch on. More rounds are no cure for a heavy
   *   striker: the 5 kg ball at 10 m/s (e 0.9) gets 0.30 of e at 8 rounds,
   *   0.19 at 16 and 0.60 at 32, and a 144 kg ball sinks into a 10-cube
   *   column up to 0.12 m at 8 rounds, 0.21 m at 32 (rule max). At e 1 more
   *   rounds overshoot: the two cubes striking a box keep 0.99983 of the
   *   energy at 8 rounds, 1.0019 at 16 and 1.0034 at 64.
   * - A point that bounced and will separate (P > 0 and its target times h
   *   beyond restDepth) starts the next step with no force (lambda 0): its
   *   impact force carried as a warm start would push the bodies apart again
   *   (a ball of e 0.3 dropped at 5 m/s rebounded at 1.04 e). A point whose
   *   rebound stays within restDepth in a step keeps its force: a resting
   *   stack under restitutionThreshold 0 bounces nothing to speak of, but
   *   zeroing its forces dropped the load floor and cap, and S1 24 at e 0.9
   *   moved at 1.04 m/s and sank 3.13 m.
   * After post-stabilization, because that pass reads lambda; it moves
   * positions only, so before or after makes no other difference. Rolling
   * contacts need nothing more: a sphere's lever arm is along n, so its
   * impulse goes through the centre.
   */
  restitute(v0: Vec3[], w0: Vec3[], q0: Quat[]): void {
    const { p, bodies, contacts } = this;
    const h = this.scene.dt;
    const threshold = p.restitutionThreshold ?? RESTITUTION_DEFAULTS.restitutionThreshold;
    const rounds = p.restitutionRounds ?? RESTITUTION_DEFAULTS.restitutionRounds;
    const rule = this.scene.restitutionCombine ?? DEFAULT_RESTITUTION_COMBINE, groundE = this.scene.ground?.restitution ?? 0;
    const st: StepStats['restitution'] = { contacts: 0, impulse: 0, momentum: [0, 0, 0], groundImpulse: [0, 0, 0] };
    this.stats.restitution = st;
    const n = bodies.length;
    // Normal velocity of contact c (row 0 of its Jacobian): at the start of the step, and now.
    const vnStart = (c: Contact) => {
      let s = 0;
      for (let k = 0; k < 3; k++) s += c.jb[k]! * v0[c.b]![k]!;
      for (let k = 0; k < 3; k++) s += c.jb[3 + k]! * w0[c.b]![k]!;
      if (c.a !== GROUND) {
        for (let k = 0; k < 3; k++) s += c.ja[k]! * v0[c.a]![k]!;
        for (let k = 0; k < 3; k++) s += c.ja[3 + k]! * w0[c.a]![k]!;
      }
      return s;
    };
    const vnNow = (c: Contact) => {
      const B = bodies[c.b]!;
      let s = 0;
      for (let k = 0; k < 3; k++) s += c.jb[k]! * B.linVel[k]! + c.jb[3 + k]! * B.angVel[k]!;
      if (c.a !== GROUND) { const A = bodies[c.a]!; for (let k = 0; k < 3; k++) s += c.ja[k]! * A.linVel[k]! + c.ja[3 + k]! * A.angVel[k]!; }
      return s;
    };
    // The contact manifolds, [first, end) in contacts: collide() emits each manifold's points together, and a pair has one manifold.
    const manifolds: Array<[number, number]> = [];
    for (let i = 0; i < contacts.length;) {
      const c = contacts[i]!;
      let j = i + 1;
      while (j < contacts.length && contacts[j]!.a === c.a && contacts[j]!.b === c.b) j++;
      manifolds.push([i, j]);
      i = j;
    }
    // The pass's manifolds: the bouncing points of a manifold, then the supports of their bodies (bounce false).
    interface Rows { a: number; b: number; pts: Contact[]; target: number[]; P: Float64Array; dP: Float64Array; bounce: boolean }
    const ms: Rows[] = [];
    const rows = (a: number, b: number, pts: Contact[], target: number[], bounce: boolean): Rows => ({ a, b, pts, target, P: new Float64Array(pts.length), dP: new Float64Array(pts.length), bounce });
    for (const [i, j] of manifolds) {
      const c = contacts[i]!;
      const e = Math.min(1, Math.max(0, combineRestitution(rule, c.a === GROUND ? groundE : bodies[c.a]!.desc.restitution, bodies[c.b]!.desc.restitution)));
      if (!(e > 0)) continue;
      const pts: Contact[] = [], target: number[] = [];
      for (let k = i; k < j; k++) {
        const ck = contacts[k]!;
        if (!(ck.lambda[0] < 0)) continue;
        const u = vnStart(ck);
        if (u <= -threshold) { pts.push(ck); target.push(-e * u); }
      }
      if (pts.length) ms.push(rows(c.a, c.b, pts, target, true));
    }
    if (!ms.length) return;
    const taken = new Set<Contact>(), involved = new Set<number>();
    for (const m of ms) { for (const c of m.pts) taken.add(c); involved.add(m.b); if (m.a !== GROUND) involved.add(m.a); }
    for (const [i, j] of manifolds) {
      const c = contacts[i]!;
      if (!involved.has(c.b) && !(c.a !== GROUND && involved.has(c.a))) continue;
      const pts: Contact[] = [], target: number[] = [];
      for (let k = i; k < j; k++) {
        const ck = contacts[k]!;
        if (!taken.has(ck) && ck.lambda[0] < 0) { pts.push(ck); target.push(vnNow(ck)); }
      }
      if (pts.length) ms.push(rows(c.a, c.b, pts, target, false));
    }
    // The pass's manifolds per body (mass splitting), world inverse inertia at the start of the step (the Jacobians' pose).
    const split = new Int32Array(n);
    for (const m of ms) { split[m.b]!++; if (m.a !== GROUND) split[m.a]!++; }
    const invI: Float64Array[] = [];
    for (let i = 0; i < n; i++) {
      if (!split[i]) continue;
      const b = bodies[i]!, I = new Float64Array(9), q = q0[i]!;
      const ax = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) I[3 * r + c] = ax[0]![r]! * ax[0]![c]! / b.inertia[0] + ax[1]![r]! * ax[1]![c]! / b.inertia[1] + ax[2]![r]! * ax[2]![c]! / b.inertia[2];
      invI[i] = I;
    }
    // Velocities u = (v, w) per body.
    const u = new Float64Array(6 * n);
    for (let i = 0; i < n; i++) if (split[i]) { u.set(bodies[i]!.linVel, 6 * i); u.set(bodies[i]!.angVel, 6 * i + 3); }
    // Body i's velocity change per unit impulse along row J (6), with its mass and inertia divided by s: s M^-1 J.
    const resp = (i: number, J: ArrayLike<number>, s: number, out: Float64Array) => {
      const im = s / bodies[i]!.mass, I = invI[i]!;
      for (let k = 0; k < 3; k++) out[k] = J[k]! * im;
      for (let r = 0; r < 3; r++) out[3 + r] = s * (I[3 * r]! * J[3]! + I[3 * r + 1]! * J[4]! + I[3 * r + 2]! * J[5]!);
    };
    const dot6 = (x: ArrayLike<number>, y: ArrayLike<number>) => {
      let s = 0;
      for (let k = 0; k < 6; k++) s += x[k]! * y[k]!;
      return s;
    };
    const ra = new Float64Array(6), rb = new Float64Array(6), ja = new Float64Array(6), jb = new Float64Array(6);
    for (let round = 0; round < rounds; round++) {
      for (const m of ms) {
        const A = m.a !== GROUND, K = m.pts.length;
        const sa = A ? split[m.a]! : 0, sb = split[m.b]!;
        // This manifold's copy of last round's velocities.
        const la = A ? u.slice(6 * m.a, 6 * m.a + 6) : null, lb = u.slice(6 * m.b, 6 * m.b + 6);
        m.dP.fill(0);
        // For rows (ra6, rb6) of a and b: their normal velocity on the copies, an impulse d along them, their inverse effective mass.
        const vn = (ra6: ArrayLike<number>, rb6: ArrayLike<number>) => dot6(rb6, lb) + (la ? dot6(ra6, la) : 0);
        const kick = (ra6: ArrayLike<number>, rb6: ArrayLike<number>, d: number) => {
          resp(m.b, rb6, sb, rb);
          for (let k = 0; k < 6; k++) lb[k] = lb[k]! + rb[k]! * d;
          if (la) { resp(m.a, ra6, sa, ra); for (let k = 0; k < 6; k++) la[k] = la[k]! + ra[k]! * d; }
        };
        const inv = (ra6: ArrayLike<number>, rb6: ArrayLike<number>) => {
          resp(m.b, rb6, sb, rb);
          let w = dot6(rb6, rb);
          if (la) { resp(m.a, ra6, sa, ra); w += dot6(ra6, ra); }
          return w;
        };
        if (K > 1) {
          // Centroid step: equal impulses d / K on every point, d from an exact line search.
          ja.fill(0); jb.fill(0);
          let T = 0, minP = Infinity;
          m.pts.forEach((c, k) => {
            for (let r = 0; r < 6; r++) { ja[r] = ja[r]! + c.ja[r]!; jb[r] = jb[r]! + c.jb[r]!; }
            T += m.target[k]!;
            minP = Math.min(minP, m.P[k]!);
          });
          for (let r = 0; r < 6; r++) { ja[r] = ja[r]! / K; jb[r] = jb[r]! / K; }
          T /= K;
          let d = (T - vn(ja, jb)) / inv(ja, jb);
          if (d < 0) d = Math.max(d, -K * minP);
          kick(ja, jb, d);
          for (let k = 0; k < K; k++) { m.P[k] = m.P[k]! + d / K; m.dP[k] = m.dP[k]! + d / K; }
        }
        // One Gauss-Seidel sweep over the points, each point's total impulse kept >= 0.
        m.pts.forEach((c, k) => {
          const P = Math.max(0, m.P[k]! + (m.target[k]! - vn(c.ja, c.jb)) / inv(c.ja, c.jb)), d = P - m.P[k]!;
          m.P[k] = P;
          m.dP[k] = m.dP[k]! + d;
          kick(c.ja, c.jb, d);
        });
      }
      // Every body takes its manifolds' impulses with its own mass.
      for (const m of ms) {
        m.pts.forEach((c, k) => {
          const d = m.dP[k]!;
          resp(m.b, c.jb, 1, rb);
          for (let r = 0; r < 6; r++) u[6 * m.b + r] = u[6 * m.b + r]! + rb[r]! * d;
          if (m.a !== GROUND) { resp(m.a, c.ja, 1, ra); for (let r = 0; r < 6; r++) u[6 * m.a + r] = u[6 * m.a + r]! + ra[r]! * d; }
        });
      }
    }
    for (let i = 0; i < n; i++) {
      if (!split[i]) continue;
      const b = bodies[i]!, m = b.mass;
      for (let k = 0; k < 3; k++) st.momentum[k] = st.momentum[k]! + m * (u[6 * i + k]! - b.linVel[k]!);
      b.linVel = [u[6 * i]!, u[6 * i + 1]!, u[6 * i + 2]!];
      b.angVel = [u[6 * i + 3]!, u[6 * i + 4]!, u[6 * i + 5]!];
    }
    for (const m of ms) {
      m.pts.forEach((c, k) => {
        const P = m.P[k]!;
        st.impulse += P;
        if (m.a === GROUND) for (let r = 0; r < 3; r++) st.groundImpulse[r] = st.groundImpulse[r]! + P * c.n[r]!;
        if (!m.bounce || !(P > 0)) return;
        st.contacts++;
        // A bounced point that will separate starts the next step with no force (see above).
        if (m.target[k]! * h > p.restDepth) c.lambda = [0, 0, 0];
      });
    }
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
    // Restitution reads the start-of-step velocities (after the angular clamp) at the end of the step.
    const start = p.restitution ? { v: bodies.map((b) => [...b.linVel] as Vec3), w: bodies.map((b) => [...b.angVel] as Vec3) } : null;
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
    // Returns the clamp's scale s = min(1, bound / |z|): F_t = s z for the trial force z.
    const F = new Float64Array(3), K = new Float64Array(9);
    const evalF = (c: Contact) => {
      F[0] = Math.min(0, c.k[0] * C[0]! + c.lambda[0]);
      const bound = c.mu * Math.abs(c.lambda[0]);
      const f1 = c.k[1] * C[1]! + c.lambda[1], f2 = c.k[1] * C[2]! + c.lambda[2];
      const fl = Math.hypot(f1, f2);
      const s = fl > bound ? (fl > 0 ? bound / fl : 0) : 1;
      F[1] = f1 * s; F[2] = f2 * s;
      return s;
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
            const s = evalF(c);
            const J = c.b === i ? c.jb : c.ja;
            // Row stiffness K (3x3): k_n on the normal, k_t s on both tangents
            // (s from evalF; 1 inside the cone). Sliding, that is the secant of
            // the clamp F_t = s z, and the curvature of the half-quadratic
            // (IRLS) upper bound of the friction energy, a Huber function of z.
            // Across the slide it equals the clamp's derivative
            // k_t (bound / |z|) (I - z z^T / |z|^2); along it, where that
            // derivative is 0, it keeps k_t bound / |z|. So the stiffness is
            // continuous across the cone boundary and a step cannot overshoot
            // back through the cone. (With the derivative, contacts resting on
            // the boundary flipped between k_t and 0 along the slide and fell
            // into a period-2 cycle.) While clearly sliding it falls off like
            // bound / (k_t |C_t|), which keeps low iteration counts accurate.
            K.fill(0);
            K[0] = c.k[0];
            K[4] = K[8] = p.slidingHessian ? c.k[1] * s : c.k[1];
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
          // Trial force inside the cone: static friction held, or k_t is still too low to tell (a new
          // contact in an impact), which the drift check at reuse (collide) catches. The last main
          // iteration's answer stands.
          c.stick = fl < bound;
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
    // Restitution: after post-stabilization, on the final velocities.
    if (start) this.restitute(start.v, start.w, q0);
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!, d = dx[i]!;
      b.pos = [x0[i]![0] + d[0]!, x0[i]![1] + d[1]!, x0[i]![2] + d[2]!];
      b.rot = applyRotation(q0[i]!, [d[3]!, d[4]!, d[5]!]);
    }
    this.lastDx = dx;
  }
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Params for a world whose gravity is k times as strong, as when its cubes
 * stand for cubes 1/k the size (the viewer's scale). Stepped at the same dt,
 * that world moves exactly as the original stepped at dt sqrt(k): positions
 * equal step for step, velocities sqrt(k) times as fast. Forces scale by k,
 * so the penalties (force per length, and beta per length squared) do; the
 * spin cap is a speed, and so is restitution's threshold (scaled only while
 * restitution is on, from RESTITUTION_DEFAULTS when unset, so an off world
 * gains no key); lengths (margin, slop, restDepth, matchDistance,
 * stickThreshold, maxSweep) and the dimensionless rest stay. Fields of p
 * that are not set take DEFAULT_AVBD's.
 */
export function froudeParams(p: Partial<AvbdParams>, k: number): Partial<AvbdParams> {
  if (!(k > 0)) throw new Error(`froudeParams: k must be > 0: ${k}`);
  const q = { ...DEFAULT_AVBD, ...p };
  const out: Partial<AvbdParams> = { ...p, beta: q.beta * k, penaltyMin: q.penaltyMin * k, penaltyMax: q.penaltyMax * k, maxAngularSpeed: q.maxAngularSpeed * Math.sqrt(k) };
  if (q.restitution) out.restitutionThreshold = (q.restitutionThreshold ?? RESTITUTION_DEFAULTS.restitutionThreshold) * Math.sqrt(k);
  return out;
}
