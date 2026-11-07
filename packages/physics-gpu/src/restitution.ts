// The restitution pass on the GPU (AvbdParams.restitution, opt-in): the
// reference's restitute() (physics-ref/src/avbd.ts, which documents the rule,
// its measurements and its limits) in f32, with the same semantics: after
// post-stabilization, a loaded point (lambdaN < 0) of a pair whose e =
// clamp(combineRestitution(SceneDesc.restitutionCombine, e_a, e_b), 0, 1) is
// above 0 (the ground's e is SceneDesc.ground.restitution) and whose normal
// velocity at the start of the step is -restitutionThreshold or less is
// raised to -e times it; the other loaded points of the bodies involved are
// one-sided supports (depth 1), or with restitutionAnchors (default on)
// anchors where the body sits on the ground or on a resting body (they hold
// it exactly: its response is M^-1/2 (1 - Q Q^T) M^-1/2 J, Q an orthonormal
// basis of its anchor rows in M^1/2 coordinates); restitutionRounds rounds of
// mass-split Jacobi, each manifold with a centroid step and one Gauss-Seidel
// sweep; with restitutionEnergyCap (default on) each island's change scaled
// so that it ends with no more invariant energy than at the start of the step
// or after the solve; then the conditional lambda reset.
//
// Encoding (AvbdSolver.solve(), after finalize, in the same compute pass):
//   restMark        per pair slot (indirect, as the dual): marks the points
//                   that bounce and their targets, counts them (an atomic)
//   restMarkBodies  per body: the same for its ground slot; whether the body
//                   is in a bouncing manifold (its pair slots' marks); with
//                   anchors, whether it rests (RESTS: in none, slow at the
//                   start of the step, sitting on something)
//   restArgs        one thread: the indirect arguments of everything below,
//                   0 workgroups if no point bounced this step
//   restSupport     per pair slot: the supports, target the solve's vn, or
//                   the anchors (the partner rests and the body sits on it)
//   restCount       per body: its ground slot's supports (with anchors, its
//                   anchors), and its mass split (the pass's manifolds it is in)
//   restAnchors     per body in the pass: its RestBody (mass, world inverse
//                   inertia at q0, and with anchors the basis of its anchor
//                   rows: Gram-Schmidt, ground slot first, then pair slots in
//                   slot order)
//   restIslandInit  (cap) per body: its own set, alpha 1, zero sums, and a
//                   copy of the solve's velocities (IslandBody)
//   restIslandHook  (cap) per pair slot with points: joins its bodies' sets
//                   (compare-exchange, the larger root under the smaller)
//   R x restManifold per pair slot: its groups (bouncing points, supports),
//                   each on a copy of last round's velocities with masses
//                   and inertias split; writes the round's impulses
//   R x restBodies  per body: its ground slot's groups (from last round's
//                   velocities too, so it is Jacobi), then the sum of every
//                   manifold's impulses, with its own mass
//   restIslandSum   (cap) per body: its root (stored: the island's least
//                   body), and its terms of the island's D, G and Q, added
//                   in fixed point
//   restIslandCap   (cap) per body in the pass: its island's alpha (capAlpha
//                   in f32); if under 1, scales its velocity change, and the
//                   targets and impulses of its ground slot and the pair slots
//                   where it is body b, by it
//   restFinish      per body: the lambda reset of its ground slot and of the
//                   pair slots where it is body b
// That is 11 + 2R dispatches a step while on (27 at the default 8 rounds; 2
// direct, 9 + 2R indirect), anchors or not, 7 + 2R without the energy cap,
// and none while off. When nothing bounces (a resting scene) only the first
// three do work: the others are indirect with 0 workgroups. Without anchors (restitutionAnchors false,
// a pipeline constant: the anchor code compiles out) the pass gives the
// floats it gave before anchors existed (on SwiftShader, 2026-11-05: S5
// knocks on records 1 and points, a 510 kg ball on a cube, a cube onto two;
// RestBody moved the world inverse inertia's rows out of restManifold and
// restBodies into restAnchors, the same expression). A body's slots are read through the
// colouring's rows (rowStart, rowLength, adjSlot: sorted by slot), so every
// sum is in a fixed order and the pass is bit-reproducible; the atomics are
// integers (the count of bouncing points; the cap's labels and sums), so any
// order gives the same values.
//
// Energy cap (restitutionEnergyCap; the rule, its rationale and its
// measurements are the reference's restitute(), "Energy cap"). Islands are
// connected components of the bodies joined by any pair slot with points
// (the ground joins nothing), labelled by lock-free union-find: the hook joins
// two roots by a compare-exchange that hangs the larger under the smaller and
// only succeeds while it is still a root, so every island's root ends as its
// least body in any order (the pattern of sleep.ts). The sums are fixed point
// with integer atomics, so their order cannot change a bit: each term x is
// hi = floor(CAP_FIX_HI x) as i32 and lo, the rest in units of
// 1 / (CAP_FIX_HI CAP_FIX_LO) J as u32 in [0, CAP_FIX_LO]; D rounded down, G
// and Q up, so an island gets at most its alpha in exact arithmetic (to
// within f32's error in the terms themselves). That holds while no sum's
// parts overflow: |sum| < 2^29 J and under 2^22 bodies (the solver refuses
// a larger capacity with the cap on). Outside that range the sums are not the island's, so the cap does not trust
// them: a term beyond +-2^29 J or not finite, or an addition that wraps a sum's hi part (atomicAdd's old value
// shows it), flags the island (IslandBody.over) and its alpha is 0, the solve's velocities (before 2026-11-06 a
// term was clamped, which rounds G and Q down: S5 at 10k on SwiftShader, a jammed cube at about 220 km/s, scaled
// by alpha 0.011 to 2,498 m/s, 3.4 times its island's bound).
// Alpha is solved in f32 (islandAlpha, capAlpha's formula). At alpha 1 the
// pass is untouched: the cap only reads, so a step it does not scale is the
// floats of the pass without it. f32 against the reference: the two-cube
// case of engine-restitution-cap.test.ts scales on the same step by an alpha
// within 3e-5 of the reference's.
//
// Contact layouts (AvbdParams.records): the kernels read a slot's points
// through a view (POINT_VIEW, RECORD_VIEW below) of SolverContact points
// (records 0) or of the slot's SolverRecord (records 1, the GPU default):
// the same fields, so the two give the same floats (on SwiftShader,
// engine-restitution-records.test.ts). The release zeroes the point's normal
// and friction forces, as the reference's lambda = 0. With lambdaN 0 the
// friction force is clamped to a cone of radius 0 at its next evaluation,
// so a mutant that kept lt passed every records case; it is not equivalent,
// though: where kT C_t is exactly 0 a kept lt still turns the sliding
// Hessian's tangent rows off (solver.ts, CONTACT_FORCE). Keep both writes.
// Centre-friction records (2) are not read here: the engine and the solver
// refuse restitution with them.
//
// Memory while on: one RestSlot (96 B; 80 B before the jam guard's linA) per
// contact slot, (maxPairs + capacity) x 96 B (pair slots, then one ground slot
// per body: 12.5% of the contact buffer with records 1, which holds 768 B per
// slot, and 9.4% with points, 1024 B), one RestBody (REST_BODY_BYTES, 288 B) per body, with the
// energy cap one IslandBody (ISLAND_BODY_BYTES, 64 B) per body, and 28 B
// of counters and arguments. Off: no buffer and no pipeline (the engine builds the pass only
// while the switch is on), and the other kernels are unchanged but for
// BodyProps.restitution, which takes the padding word BodyProps had (on
// SwiftShader the floats off are those before the port).
//
// f32 departures from the reference (beyond its arithmetic in f32):
// - The start-of-step velocities: v is SolverBody.prevVel, the copy the
//   velocities kernel makes of the step's starting velocity (exact; with 0
//   iterations it never runs, and v is taken from the inertial target tp
//   instead); w is SolverBody.tphi / h, the inertial target h w (after the
//   angular clamp) divided by h again, so within an ulp of it.
// - The world inverse inertia (at q0, the Jacobians' pose) is computed from
//   q0 and the principal moments wherever it is needed, not kept.
// - A body's velocity takes the sum of each round's impulses, sum dP J, times
//   M^-1, where the reference adds M^-1 J dP point by point.
// - The threshold test (<=) and the reset's target h > restDepth are taken
//   in f32, so speeds within rounding of the threshold may go either way.
// - WGSL lets an implementation assume that no NaN or infinity reaches a
//   shader (min and max of a NaN are unspecified; SwiftShader's returned the
//   other operand, as Metal's fmin and fmax are specified to, so a NaN e
//   bounced under min and max). The host keeps them out of BodyProps.restitution
//   (restitutionWord): a NaN e becomes NAN_RESTITUTION, which pairE reads as
//   no bounce under every rule, as the reference's arithmetic gives; an e
//   beyond f32's range (an infinity) becomes +-F32_MAX / 2, which every rule
//   combines and clamps to what the reference gives for the infinity (but
//   for a product with a subnormal e, which f32 may flush to 0; the product
//   of two overflows f32, to an infinity on IEEE hardware, which clamps to
//   1 as the reference's).
// - Anchors: the basis's rows are taken ground slot first, then pair slots in
//   slot order (the reference's in its contact order), so which of a body's
//   nearly dependent rows ANCHOR_TOL drops may differ; the held span is the
//   same. A round's velocity update projects the sum of its impulses, where
//   the reference projects each row's; the sums leave out the rows a side's
//   cut zeroes (Group, RestSlot.linA), as the reference's per-row cut does,
//   so they differ by rounding. (Before the jam guard the sums kept them,
//   which at the old cut of 1e-4 differed by rounding too; at 0.2 it threw a
//   seated cube at 29.8 m/s that the reference held: engine-restitution-
//   jam.test.ts.)
// - The combine rule is checked: while on, AvbdSolver rejects one outside
//   COMBINE_RULES at init. The reference does not check it (an unknown rule
//   gives it a NaN e, so nothing bounces).
//
// Not measured on hardware: the pass's cost while on (the cap's 4 dispatches
// among it; its atomics all land on an island's root, so a large island
// contends on one word). solveGroup indexes
// private arrays (the rows, P, T, dP) in loops, the shape solver.ts's header
// measured spilling on the M5 Max ('array' against 'registers', #40). If
// restManifold and restBodies show in a bench of an impact-heavy scene, unroll
// it over 4 named rows as registerSolveBody() does.
//
// Each kernel binds at most 8 storage buffers.
import type { CombineRule } from '@tb/engine-api';
import { RestSlot, wgslStruct } from '@tb/schema';

const WG = 64;
/** The largest finite f32. */
const F32_MAX = 3.4028234663852886e38;

/** The pass's settings, fixed per solver: AvbdParams and the scene's ground and combine rule. */
export interface RestitutionConfig {
  /** AvbdParams.restitutionThreshold, m/s (a finite number >= 0). */
  threshold: number;
  /** AvbdParams.restitutionRounds (an integer >= 1). */
  rounds: number;
  /** SceneDesc.ground.restitution (in [0, 1]; 0 without a ground). */
  groundRestitution: number;
  /** SceneDesc.restitutionCombine. */
  combine: CombineRule;
  /** AvbdParams.restitutionAnchors: hold a struck body exactly by the ground and by resting bodies it sits on. */
  anchors: boolean;
  /** AvbdParams.restitutionAnchorSpeed, m/s (a finite number >= 0): the speed under which a body rests for anchors. */
  anchorSpeed: number;
  /** AvbdParams.restitutionAnchorCut (in [0, 1]): a row on an anchored body with under this fraction of it outside the held directions takes no bounce. */
  anchorCut: number;
  /** AvbdParams.restitutionEnergyCap: scale each island's change so it ends the pass with no more energy than at the step's start or after the solve. */
  energyCap: boolean;
}

/** Bytes of the counters and indirect arguments: [0] points bouncing this step (atomic), [1..3] per-slot and [4..6] per-body dispatch arguments. */
export const REST_INFO_BYTES = 28;
/** Byte offsets of the two indirect arguments in the info buffer. */
export const REST_SLOT_ARGS = 4, REST_BODY_ARGS = 16;
/** Bytes of a RestBody (one per body while on): the pass's view of a body in it, its held directions if anchored. */
export const REST_BODY_BYTES = 288;
/** Anchors: the least cosine between a support's normal into the body it holds and up (the reference's ANCHOR_UP). */
export const ANCHOR_UP = 0.5;
/** Anchors: a row whose part outside the held directions is under this fraction of its length is held (the reference's). */
export const ANCHOR_TOL = 1e-4;
/** Bytes of an IslandBody (one per body while the energy cap is on): union-find parent, the island's alpha and sums, the solve's velocities. */
export const ISLAND_BODY_BYTES = 64;
/**
 * The energy cap's fixed point: an energy x (J) is added to an island's sum as hi = floor(4 x) (an i32) and lo, the
 * rest in 1/4096 J (a u32 in [0, 1024]), each an atomic add of integers, so the sums are the same whatever the
 * order. Exact while an island's |sum| stays under 2^29 J and it has under 2^22 bodies.
 */
export const CAP_FIX_HI = 4, CAP_FIX_LO = 1024;

/** BodyProps.restitution for a NaN BodyDesc.restitution (restitutionWord): pairE gives it no bounce under every rule. */
export const NAN_RESTITUTION = -F32_MAX;

/**
 * BodyProps.restitution for a BodyDesc.restitution (the reference's
 * combineRestitution, clamped, decides the same bounce from either): e
 * itself, NAN_RESTITUTION for NaN (undefined too, which the reference's
 * arithmetic turns into NaN), and +-F32_MAX / 2 beyond that (infinities), so
 * no NaN or infinity reaches the shader. See the header.
 */
export function restitutionWord(e: number): number {
  const x = Number(e);
  if (Number.isNaN(x)) return NAN_RESTITUTION;
  return Math.min(F32_MAX / 2, Math.max(-F32_MAX / 2, x));
}

export type RestBinding = 'contacts' | 'contactsRw' | 'props' | 'solver' | 'bodies' | 'bodiesRw' | 'rest' | 'restRead' | 'info' | 'stepInfo' | 'rowStart' | 'rowLength' | 'adjSlot' | 'params' | 'restBody' | 'restBodyRead' | 'island';
/** The pass's pipeline constants. */
export type RestConstant = 'restThreshold' | 'groundRestitution' | 'restCombine' | 'restAnchorsOn' | 'restAnchorSpeed' | 'restAnchorCut';

export interface RestKernel {
  entry: string;
  code: string;
  bindings: RestBinding[];
  /** The pipeline constants it reads. */
  constants: RestConstant[];
  workgroup: number;
}

const DECL: Record<RestBinding, (i: number) => string> = {
  contacts: (i) => `@group(0) @binding(${i}) var<storage, read> contacts: array<SolverContact>;`,
  contactsRw: (i) => `@group(0) @binding(${i}) var<storage, read_write> contacts: array<SolverContact>;`,
  props: (i) => `@group(0) @binding(${i}) var<storage, read> props: array<BodyProps>;`,
  solver: (i) => `@group(0) @binding(${i}) var<storage, read> solver: array<SolverBody>;`,
  bodies: (i) => `@group(0) @binding(${i}) var<storage, read> bodies: array<Body>;`,
  bodiesRw: (i) => `@group(0) @binding(${i}) var<storage, read_write> bodies: array<Body>;`,
  rest: (i) => `@group(0) @binding(${i}) var<storage, read_write> rest: array<RestSlot>;`,
  restRead: (i) => `@group(0) @binding(${i}) var<storage, read> rest: array<RestSlot>;`,
  info: (i) => `@group(0) @binding(${i}) var<storage, read_write> info: array<atomic<u32>, ${REST_INFO_BYTES / 4}>;`,
  stepInfo: (i) => `@group(0) @binding(${i}) var<storage, read> stepInfo: array<u32, 16>;`,
  rowStart: (i) => `@group(0) @binding(${i}) var<storage, read> rowStart: array<u32>;`,
  rowLength: (i) => `@group(0) @binding(${i}) var<storage, read> rowLength: array<u32>;`,
  adjSlot: (i) => `@group(0) @binding(${i}) var<storage, read> adjSlot: array<u32>;`,
  params: (i) => `@group(0) @binding(${i}) var<uniform> p: SolverParams;`,
  restBody: (i) => `@group(0) @binding(${i}) var<storage, read_write> restBody: array<RestBody>;`,
  restBodyRead: (i) => `@group(0) @binding(${i}) var<storage, read> restBody: array<RestBody>;`,
  island: (i) => `@group(0) @binding(${i}) var<storage, read_write> island: array<IslandBody>;`,
};

// Shared by every kernel: needs no binding but the uniforms p.
const HEAD = /* wgsl */ `
${wgslStruct(RestSlot)}
// AvbdParams.restitutionThreshold (m/s), SceneDesc.ground.restitution, SceneDesc.restitutionCombine (COMBINE_RULES order).
override restThreshold: f32 = 1.0;
override groundRestitution: f32 = 0.0;
override restCombine: u32 = 0u;
// AvbdParams.restitutionAnchors and restitutionAnchorSpeed (m/s).
override restAnchorsOn: bool = true;
override restAnchorSpeed: f32 = 0.25;
// AvbdParams.restitutionAnchorCut: the jam guard (resp()).
override restAnchorCut: f32 = 0.2;
const BIG = ${F32_MAX};
const ANCHOR_UP = ${ANCHOR_UP};
const ANCHOR_TOL = ${ANCHOR_TOL};
// BodyProps.restitution for a NaN e (NAN_RESTITUTION, restitutionWord on the host).
const NAN_E = ${-F32_MAX};
// RestSlot.flags: bits 0-3 bounce, 4-7 support, 8 (ground slots) the body is in a bouncing manifold, 9 (ground
// slots) it rests for anchors, 12-15 anchor (a loaded point that holds a body exactly), 16 (pair slots) the anchors
// hold body a (else b).
const BOUNCE = 15u;
const SUPPORT = 240u;
const IN_PASS = 256u;
const RESTS = 512u;
const ANCHOR = 61440u;
const ANCHOR_A = 65536u;

// Up (minus gravity's direction), or 0 in zero g: no normal is then within 60 degrees of it, so nothing anchors on a body.
fn upDir() -> vec3f {
  let gl = length(p.gravity);
  if (gl > 0.0) { return -p.gravity / gl; }
  return vec3f(0.0);
}

// A body of the pass (restAnchors writes it each step it runs): its mass and world inverse inertia at q0 (rows),
// and if anchors hold it (count > 0), its world inverse square-root inertia (rows) and an orthonormal basis of its
// anchor rows in M^1/2 coordinates, M^-1/2 J (linear, angular parts).
struct RestBody {
  i0: vec3f, m: f32,
  i1: vec3f, count: u32,
  i2: vec3f, rm: f32,
  s0: vec3f, pad0: f32,
  s1: vec3f, pad1: f32,
  s2: vec3f, pad2: f32,
  qv: array<vec3f, 6>,
  qw: array<vec3f, 6>,
}

// Body i's ground slot's record (pair slot k's is k).
fn groundRec(i: u32) -> u32 { return p.maxPairs + i; }

// The pair's e: combineRestitution under SceneDesc.restitutionCombine, clamped to [0, 1]; none if either e is
// NaN (NAN_E), whatever the rule, as on the reference.
fn pairE(ea: f32, eb: f32) -> f32 {
  if (ea == NAN_E || eb == NAN_E) { return 0.0; }
  var e = 0.5 * (ea + eb);
  switch (restCombine) {
    case 1u: { e = min(ea, eb); }
    case 2u: { e = max(ea, eb); }
    case 3u: { e = ea * eb; }
    default: {}
  }
  return min(1.0, max(0.0, e));
}

// A point's normal row (ptRow): b's (n, rbw x n), a's (-n, -(raw x n)).
struct NRow { n: vec3f, wb: vec3f, wa: vec3f }
// J u for b's velocities (vb, wb) and a's (va, wa; none for the ground).
fn vnOf(r: NRow, vb: vec3f, wb: vec3f, va: vec3f, wa: vec3f, hasA: bool) -> f32 {
  var s = dot(r.n, vb) + dot(r.wb, wb);
  if (hasA) { s += dot(-r.n, va) + dot(r.wa, wa); }
  return s;
}

// The number of the pass's manifolds a slot's record holds: its bouncing points and its supports are two.
fn groups(f: u32) -> u32 { return select(0u, 1u, (f & BOUNCE) != 0u) + select(0u, 1u, (f & SUPPORT) != 0u); }
`;

// The rounds' solve (restManifold, restBodies; restBody bound).
const SOLVE = /* wgsl */ `
// A body in one manifold of the pass: its velocities, its mass, its world inverse inertia at the start of the
// step (q0, the Jacobians' pose), as rows, its split s, and k: the body if anchors hold it (its RestBody has their
// basis), else NONE. The velocity change per unit impulse along a row J is s M^-1 J, or with anchors
// s M^-1/2 (1 - Q Q^T) M^-1/2 J (resp).
struct Side { v: vec3f, w: vec3f, s: f32, m: f32, i0: vec3f, i1: vec3f, i2: vec3f, k: u32 }
fn sideAt(i: u32, v: vec3f, w: vec3f, s: f32) -> Side {
  let held = select(NONE, i, restBody[i].count > 0u);
  return Side(v, w, s, restBody[i].m, restBody[i].i0, restBody[i].i1, restBody[i].i2, held);
}
// A velocity change (linear, angular).
struct Resp { v: vec3f, w: vec3f }
// The side's velocity change per unit impulse along the row (jv, jw). With anchors, as the reference's resp(): the
// row in M^1/2 coordinates less its part along the held directions, 0 if that leaves under restAnchorCut of it (cut,
// the jam guard: the rest would move the body 1/f times as fast as a free row to meet its target, f that fraction;
// the velocity update of a round's summed impulses projects without the cut).
fn resp(sd: Side, jv: vec3f, jw: vec3f, cut: bool) -> Resp {
  if (sd.k == NONE) { return Resp(jv * (sd.s / sd.m), sd.s * vec3f(dot(sd.i0, jw), dot(sd.i1, jw), dot(sd.i2, jw))); }
  let k = sd.k;
  let rm = restBody[k].rm;
  let s0 = restBody[k].s0; let s1 = restBody[k].s1; let s2 = restBody[k].s2;
  var xv = jv * rm;
  var xw = vec3f(dot(s0, jw), dot(s1, jw), dot(s2, jw));
  let n0 = sqrt(dot(xv, xv) + dot(xw, xw));
  for (var c = 0u; c < restBody[k].count; c++) {
    let qv = restBody[k].qv[c]; let qw = restBody[k].qw[c];
    let d = dot(qv, xv) + dot(qw, xw);
    xv -= d * qv; xw -= d * qw;
  }
  if (cut && !(sqrt(dot(xv, xv) + dot(xw, xw)) > restAnchorCut * n0)) { return Resp(vec3f(0.0), vec3f(0.0)); }
  return Resp(xv * (rm * sd.s), sd.s * vec3f(dot(s0, xw), dot(s1, xw), dot(s2, xw)));
}
// The row's inverse effective mass under the split.
fn invOf(r: NRow, A: Side, B: Side, hasA: bool) -> f32 {
  let ob = resp(B, r.n, r.wb, true);
  var w = dot(r.n, ob.v) + dot(r.wb, ob.w);
  if (hasA) { let oa = resp(A, -r.n, r.wa, true); w += dot(-r.n, oa.v) + dot(r.wa, oa.w); }
  return w;
}
// An impulse d along the row on the copies of the velocities.
fn kick(r: NRow, A: Side, B: Side, hasA: bool, d: f32, vb: ptr<function, vec3f>, wb: ptr<function, vec3f>, va: ptr<function, vec3f>, wa: ptr<function, vec3f>) {
  let ob = resp(B, r.n, r.wb, true);
  *vb += ob.v * d; *wb += ob.w * d;
  if (hasA) { let oa = resp(A, -r.n, r.wa, true); *va += oa.v * d; *wa += oa.w * d; }
}

// What one group of a manifold's points did in a round: their impulses so far, and the round's impulse on b
// (lin, angB) and on a (linA, angA), the sum of dP J over the rows the side's anchors do not cut (cutOf): a cut row
// moves its side neither in the rounds (resp) nor in the update, as on the reference.
struct Group { P: vec4f, lin: vec3f, angB: vec3f, linA: vec3f, angA: vec3f }
// Whether the jam guard cuts the row (jv, jw) on side sd (resp()'s test; never on a side anchors do not hold).
fn cutOf(sd: Side, jv: vec3f, jw: vec3f) -> bool {
  if (sd.k == NONE) { return false; }
  let o = resp(sd, jv, jw, true);
  return all(o.v == vec3f(0.0)) && all(o.w == vec3f(0.0));
}

// One round of one group of a manifold's points (mask: its bouncing points, or its supports), on copies of last
// round's velocities (A unused without hasA): the centroid step (equal impulses on every point, from an exact
// line search; a step towards less impulse never takes a point's below 0), then one Gauss-Seidel sweep over the
// points, each point's total impulse kept >= 0.
fn solveGroup(mask: u32, rows: array<NRow, 4>, T: vec4f, P0: vec4f, A: Side, B: Side, hasA: bool) -> Group {
  var rs = rows;
  var P = P0;
  var dP = vec4f(0.0);
  var va = A.v; var wa = A.w; var vb = B.v; var wb = B.w;
  let K = countOneBits(mask);
  if (K > 1u) {
    var n = vec3f(0.0); var jwb = vec3f(0.0); var jwa = vec3f(0.0);
    var Tm = 0.0; var minP = BIG;
    for (var q = 0u; q < 4u; q++) {
      if (((mask >> q) & 1u) == 0u) { continue; }
      n += rs[q].n; jwb += rs[q].wb; jwa += rs[q].wa;
      Tm += T[q];
      minP = min(minP, P[q]);
    }
    let kf = f32(K);
    let r = NRow(n / kf, jwb / kf, jwa / kf);
    // A row the anchors hold entirely (inverse mass 0) takes no impulse, as on the reference.
    let w = invOf(r, A, B, hasA);
    var d = 0.0;
    if (w > 0.0) { d = (Tm / kf - vnOf(r, vb, wb, va, wa, hasA)) / w; }
    if (d < 0.0) { d = max(d, -kf * minP); }
    kick(r, A, B, hasA, d, &vb, &wb, &va, &wa);
    for (var q = 0u; q < 4u; q++) {
      if (((mask >> q) & 1u) == 0u) { continue; }
      P[q] = P[q] + d / kf;
      dP[q] = dP[q] + d / kf;
    }
  }
  for (var q = 0u; q < 4u; q++) {
    if (((mask >> q) & 1u) == 0u) { continue; }
    let r = rs[q];
    let w = invOf(r, A, B, hasA);
    if (!(w > 0.0)) { continue; }
    let Pq = max(0.0, P[q] + (T[q] - vnOf(r, vb, wb, va, wa, hasA)) / w);
    let d = Pq - P[q];
    P[q] = Pq;
    dP[q] = dP[q] + d;
    kick(r, A, B, hasA, d, &vb, &wb, &va, &wa);
  }
  var g = Group(P, vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  for (var q = 0u; q < 4u; q++) {
    if (((mask >> q) & 1u) == 0u || dP[q] == 0.0) { continue; }
    if (!cutOf(B, rs[q].n, rs[q].wb)) { g.lin += dP[q] * rs[q].n; g.angB += dP[q] * rs[q].wb; }
    if (hasA && !cutOf(A, -rs[q].n, rs[q].wa)) { g.linA -= dP[q] * rs[q].n; g.angA += dP[q] * rs[q].wa; }
  }
  return g;
}

`;

// The pass's view of a slot's points in the bound contact buffer, one per contact layout: slotOf(k) and groundOf(i)
// are where pair slot k and body i's ground slot are (their first point, or their record), and the rest read
// point q of the slot there, or release it. Points are in use from q = 0 up, so the walks stop at the first
// unused one.
const POINT_VIEW = /* wgsl */ `
fn slotOf(k: u32) -> u32 { return pairPoint(p.cur, k, 0u); }
fn groundOf(i: u32) -> u32 { return groundPoint(p.cur, i, 0u); }
fn slotA(s: u32) -> u32 { return contacts[s].a; }
fn slotB(s: u32) -> u32 { return contacts[s].b; }
fn ptUsed(s: u32, q: u32) -> bool { return contacts[s + q].used != 0u; }
// Loaded at the end of the step: pushing apart (lambdaN < 0).
fn ptLoaded(s: u32, q: u32) -> bool { return contacts[s + q].lambdaN < 0.0; }
// The point's normal row, the reference's jb and ja row 0: b's (n, rbw x n), a's (-n, -(raw x n)).
fn ptRow(s: u32, q: u32) -> NRow { let ct = contacts[s + q]; return NRow(ct.n, cross(ct.rbw, ct.n), -cross(ct.raw, ct.n)); }
`;
// AvbdParams.records 1: the slot's SolverRecord (the same fields, point q in lane q of each vec4f; the solver's
// pairRecord, groundRecord, recRaw and recRbw).
const RECORD_VIEW = /* wgsl */ `
fn slotOf(k: u32) -> u32 { return pairRecord(p.cur, k); }
fn groundOf(i: u32) -> u32 { return groundRecord(p.cur, i); }
fn slotA(s: u32) -> u32 { return records[s].a; }
fn slotB(s: u32) -> u32 { return records[s].b; }
fn ptUsed(s: u32, q: u32) -> bool { return q < records[s].count; }
fn ptLoaded(s: u32, q: u32) -> bool { return records[s].lambdaN[q] < 0.0; }
fn ptRow(s: u32, q: u32) -> NRow { let n = records[s].n; return NRow(n, cross(recRbw(s, q), n), -cross(recRaw(s, q), n)); }
`;
// restFinish's write: a released point starts the next step with no force (normal and friction).
const POINT_RELEASE = /* wgsl */ `
fn ptRelease(s: u32, q: u32) { contacts[s + q].lambdaN = 0.0; contacts[s + q].lt = vec2f(0.0); }
`;
const RECORD_RELEASE = /* wgsl */ `
fn ptRelease(s: u32, q: u32) { records[s].lambdaN[q] = 0.0; records[s].lt1[q] = 0.0; records[s].lt2[q] = 0.0; }
`;

// The marks (restMark, restMarkBodies): contacts, props and solver bound.
const MARK = /* wgsl */ `
// A body's linear velocity at the start of the step: velocities() copied it into prevVel (with 0 iterations it
// never runs, and the inertial target tp = h v + h^2 g gives it back instead).
fn startVel(s: SolverBody) -> vec3f {
  if (p.iterations == 0u) { return (s.tp - p.dt * p.dt * p.gravity) / p.dt; }
  return s.prevVel;
}

// The points of a slot (at s in the contact buffer, bodies b and a, a NONE for the ground) that bounce, with their targets:
// loaded at the end of the step (lambdaN < 0) and approaching at restThreshold or faster at its start (J u0 <=
// -restThreshold, u0 the start-of-step velocities after the angular clamp), if e > 0. Target -e J u0.
fn mark(s: u32, e: f32, b: u32, a: u32) -> RestSlot {
  var r: RestSlot;
  r.b = b;
  if (!(e > 0.0)) { return r; }
  let hasA = a != NONE;
  let sb = solver[b];
  let vb = startVel(sb);
  let wb = sb.tphi / p.dt;
  var va = vec3f(0.0); var wa = vec3f(0.0);
  if (hasA) { let sa = solver[a]; va = startVel(sa); wa = sa.tphi / p.dt; }
  for (var q = 0u; q < 4u; q++) {
    if (!ptUsed(s, q)) { break; }
    if (!ptLoaded(s, q)) { continue; }
    let u = vnOf(ptRow(s, q), vb, wb, va, wa, hasA);
    if (u <= -restThreshold) {
      r.flags |= 1u << q;
      r.vnTarget[q] = -e * u;
    }
  }
  return r;
}
`;

// The energy cap's kernels (restIsland*; island bound).
const ISLAND = /* wgsl */ `
// A body's view in the energy cap: its union-find parent (after restIslandSum, its island's root, the island's least
// body), and on the root the island's alpha (f32 bits) and its sums in fixed point (CAP_FIX_HI, CAP_FIX_LO): D, the
// energy the solve took from the island, and G and Q, the pass's added energy alpha G + alpha^2 Q / 2; and the
// solve's velocities, before the rounds.
struct IslandBody {
  parent: atomic<u32>,
  alpha: atomic<u32>,
  dHi: atomic<i32>, dLo: atomic<u32>,
  gHi: atomic<i32>, gLo: atomic<u32>,
  qHi: atomic<i32>, qLo: atomic<u32>,
  v: vec3f,
  // Set when a term left the fixed point's range or an addition to a sum's hi part wrapped: the sums are then not
  // the island's, so its alpha is 0 (islandAlpha).
  over: atomic<u32>,
  w: vec3f, pad1: f32,
}
// Bounded walks: a root is reached in far fewer steps; the bound only keeps a bug from hanging the GPU.
const FIND_BOUND = 1048576u;
fn find(x0: u32) -> u32 {
  var x = x0;
  for (var i = 0u; i < FIND_BOUND; i++) {
    let p = atomicLoad(&island[x].parent);
    if (p == x) { return x; }
    let gp = atomicLoad(&island[p].parent);
    // Path halving: x skips to its grandparent (still in its set, so any interleaving is safe).
    if (gp != p) { _ = atomicCompareExchangeWeak(&island[x].parent, p, gp); }
    x = gp;
  }
  return x;
}
// x (J) in fixed point: hi = floor(4 x), clamped to i32, and the rest in 1/4096 J, rounded down, or up if up; over
// if x was out of range (|4 x| over FIX_MAX, or not finite), so the clamped value is not x.
const FIX_HI = ${CAP_FIX_HI}.0;
const FIX_LO = ${CAP_FIX_LO}.0;
const FIX_MAX = 2147483520.0;
struct Fix { hi: i32, lo: u32, over: bool }
fn fixOf(x: f32, up: bool) -> Fix {
  let over = !(abs(x * FIX_HI) <= FIX_MAX);
  let y = select(clamp(x * FIX_HI, -FIX_MAX, FIX_MAX), 0.0, over);
  let h = floor(y);
  let f = (y - h) * FIX_LO;
  return Fix(i32(h), u32(select(floor(f), ceil(f), up)), over);
}
// Whether old + h wrapped in i32 (atomicAdd's old value and the addend): both of one sign, the sum of the other.
fn wrapped(old: i32, h: i32) -> bool {
  let s = bitcast<i32>(bitcast<u32>(old) + bitcast<u32>(h));
  return (old < 0) == (h < 0) && (s < 0) != (old < 0);
}
// Adds a term to island r's D, G or Q (k 0, 1, 2), flagging the island if the term or the sum left the range.
fn addFix(r: u32, k: u32, t: Fix) {
  var old = 0;
  switch (k) {
    case 0u: { old = atomicAdd(&island[r].dHi, t.hi); atomicAdd(&island[r].dLo, t.lo); }
    case 1u: { old = atomicAdd(&island[r].gHi, t.hi); atomicAdd(&island[r].gLo, t.lo); }
    default: { old = atomicAdd(&island[r].qHi, t.hi); atomicAdd(&island[r].qLo, t.lo); }
  }
  if (t.over || wrapped(old, t.hi)) { atomicStore(&island[r].over, 1u); }
}
fn fixValue(hi: i32, lo: u32) -> f32 { return f32(hi) / FIX_HI + f32(lo) / (FIX_HI * FIX_LO); }
// The island's alpha (the reference's capAlpha): the largest in [0, 1] with alpha G + alpha^2 Q / 2 <= max(0, D).
fn islandAlpha(r: u32) -> f32 {
  if (atomicLoad(&island[r].over) != 0u) { return 0.0; }
  let D = fixValue(atomicLoad(&island[r].dHi), atomicLoad(&island[r].dLo));
  let G = fixValue(atomicLoad(&island[r].gHi), atomicLoad(&island[r].gLo));
  let Q = fixValue(atomicLoad(&island[r].qHi), atomicLoad(&island[r].qLo));
  let B = max(0.0, D);
  if (G + 0.5 * Q <= B) { return 1.0; }
  let s = sqrt(G * G + 2.0 * Q * B);
  var a = 0.0;
  if (G > 0.0) { a = 2.0 * B / (G + s); } else { a = (s - G) / Q; }
  if (!(a > 0.0)) { return 0.0; }
  return min(a, 1.0);
}
// 1/2 w.I(q) w', I(q) the world inertia at pose q of principal moments m.
fn spinDot(q: vec4f, m: vec3f, w: vec3f, x: vec3f) -> f32 {
  let a0 = qrot(q, vec3f(1.0, 0.0, 0.0));
  let a1 = qrot(q, vec3f(0.0, 1.0, 0.0));
  let a2 = qrot(q, vec3f(0.0, 0.0, 1.0));
  return 0.5 * (m.x * dot(a0, w) * dot(a0, x) + m.y * dot(a1, w) * dot(a1, x) + m.z * dot(a2, w) * dot(a2, x));
}
`;

const ENTRY: Record<string, string> = {
  restMark: /* wgsl */ `
@compute @workgroup_size(${WG})
fn restMark(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  let s = slotOf(k);
  var r: RestSlot;
  if (ptUsed(s, 0u)) {
    let a = slotA(s);
    let b = slotB(s);
    r = mark(s, pairE(props[a].restitution, props[b].restitution), b, a);
  }
  rest[k] = r;
  let m = countOneBits(r.flags);
  if (m > 0u) { atomicAdd(&info[0], m); }
}`,
  restMarkBodies: /* wgsl */ `
// Anchors: whether body i rests (restSupport anchors a body in the pass on it): it is in no bouncing manifold, its
// start-of-step speed plus spin times bounding radius is restAnchorSpeed or less, and it sits on something (a loaded
// point pushes it within 60 degrees of up, ANCHOR_UP).
fn rests(i: u32, inPass: bool) -> bool {
  if (!restAnchorsOn || inPass) { return false; }
  let sb = solver[i];
  if (!(length(startVel(sb)) + length(sb.tphi / p.dt) * props[i].radius <= restAnchorSpeed)) { return false; }
  let up = upDir();
  let gs = groundOf(i);
  for (var q = 0u; q < 4u; q++) {
    if (!ptUsed(gs, q)) { break; }
    if (ptLoaded(gs, q) && dot(ptRow(gs, q).n, up) >= ANCHOR_UP) { return true; }
  }
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) {
    let s = slotOf(adjSlot[e]);
    // n pushes b; a the other way.
    let sign = select(-1.0, 1.0, slotB(s) == i);
    for (var q = 0u; q < 4u; q++) {
      if (!ptUsed(s, q)) { break; }
      if (ptLoaded(s, q) && sign * dot(ptRow(s, q).n, up) >= ANCHOR_UP) { return true; }
    }
  }
  return false;
}

@compute @workgroup_size(${WG})
fn restMarkBodies(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  var r = mark(groundOf(i), pairE(groundRestitution, props[i].restitution), i, NONE);
  let m = countOneBits(r.flags);
  // The body is in the pass if one of its manifolds bounces: its other loaded points are then supports.
  var inPass = m > 0u;
  let rs = rowStart[i];
  let re = rs + rowLength[i];
  for (var e = rs; e < re && !inPass; e++) { inPass = (rest[adjSlot[e]].flags & BOUNCE) != 0u; }
  if (inPass) { r.flags |= IN_PASS; }
  if (rests(i, inPass)) { r.flags |= RESTS; }
  rest[groundRec(i)] = r;
  if (m > 0u) { atomicAdd(&info[0], m); }
}`,
  restArgs: /* wgsl */ `
// The indirect arguments of the rest of the pass: every slot (as the broadphase's) and every body, or nothing if
// no point bounced. Resets the count for the next step.
@compute @workgroup_size(1)
fn restArgs() {
  let c = atomicLoad(&info[0]);
  atomicStore(&info[0], 0u);
  let on = c > 0u;
  atomicStore(&info[1], select(0u, stepInfo[0], on));
  atomicStore(&info[2], stepInfo[1]);
  atomicStore(&info[3], stepInfo[2]);
  atomicStore(&info[4], select(0u, (p.n + ${WG - 1}u) / ${WG}u, on));
  atomicStore(&info[5], 1u);
  atomicStore(&info[6], 1u);
}`,
  restSupport: /* wgsl */ `
// The supports of a pair slot one of whose bodies is in the pass: its loaded points that do not bounce, as
// one-sided constraints that keep the normal velocity the solve left (target J u, P >= 0). Or, with anchors, if
// only one body is in the pass and it sits on the other (the normal into it within 60 degrees of up), which rests
// (RESTS): anchors, which hold it exactly (restAnchors; the reference's holdsB and holdsA).
@compute @workgroup_size(${WG})
fn restSupport(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  let s = slotOf(k);
  if (!ptUsed(s, 0u)) { return; }
  let a = slotA(s);
  let b = slotB(s);
  let fa = rest[groundRec(a)].flags;
  let fb = rest[groundRec(b)].flags;
  if (((fa | fb) & IN_PASS) == 0u) { return; }
  // 1: the points hold b, 2: they hold a, 0: they are supports.
  var holds = 0u;
  if (restAnchorsOn) {
    let aIn = (fa & IN_PASS) != 0u;
    let bIn = (fb & IN_PASS) != 0u;
    let nu = dot(ptRow(s, 0u).n, upDir());
    if (bIn && !aIn && nu >= ANCHOR_UP && (fa & RESTS) != 0u) { holds = 1u; }
    else if (aIn && !bIn && -nu >= ANCHOR_UP && (fb & RESTS) != 0u) { holds = 2u; }
  }
  var r = rest[k];
  let A = bodies[a];
  let B = bodies[b];
  var sm = 0u;
  for (var q = 0u; q < 4u; q++) {
    if (!ptUsed(s, q)) { break; }
    if (((r.flags >> q) & 1u) != 0u || !ptLoaded(s, q)) { continue; }
    sm |= 1u << q;
    if (holds == 0u) { r.vnTarget[q] = vnOf(ptRow(s, q), B.linVel, B.angVel, A.linVel, A.angVel, true); }
  }
  if (sm != 0u) {
    if (holds == 0u) { rest[k].flags = r.flags | (sm << 4u); }
    else { rest[k].flags = r.flags | (sm << 12u) | select(0u, ANCHOR_A, holds == 2u); }
    rest[k].vnTarget = r.vnTarget;
  }
}`,
  restCount: /* wgsl */ `
// A body's ground supports (if it is in the pass; with anchors, its ground anchors), and its mass split: the pass's
// manifolds it is in.
@compute @workgroup_size(${WG})
fn restCount(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let gi = groundRec(i);
  var r = rest[gi];
  if ((r.flags & IN_PASS) != 0u) {
    let B = bodies[i];
    let gs = groundOf(i);
    var sm = 0u;
    for (var q = 0u; q < 4u; q++) {
      if (!ptUsed(gs, q)) { break; }
      if (((r.flags >> q) & 1u) != 0u || !ptLoaded(gs, q)) { continue; }
      sm |= 1u << q;
      if (!restAnchorsOn) { r.vnTarget[q] = vnOf(ptRow(gs, q), B.linVel, B.angVel, vec3f(0.0), vec3f(0.0), false); }
    }
    r.flags |= select(sm << 4u, sm << 12u, restAnchorsOn);
  }
  var s = groups(r.flags);
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) { s += groups(rest[adjSlot[e]].flags); }
  rest[gi].flags = r.flags;
  rest[gi].vnTarget = r.vnTarget;
  rest[gi].split = s;
}`,
  restAnchors: /* wgsl */ `
// Row J of an anchor (linear, angular parts) into body b's basis (modified Gram-Schmidt in M^1/2 coordinates, as the
// reference's): none if it is within ANCHOR_TOL of the span already, or the basis is full.
fn addRow(b: ptr<function, RestBody>, jv: vec3f, jw: vec3f) {
  if ((*b).count == 6u) { return; }
  var xv = jv * (*b).rm;
  var xw = vec3f(dot((*b).s0, jw), dot((*b).s1, jw), dot((*b).s2, jw));
  let n0 = sqrt(dot(xv, xv) + dot(xw, xw));
  for (var c = 0u; c < (*b).count; c++) {
    let qv = (*b).qv[c]; let qw = (*b).qw[c];
    let d = dot(qv, xv) + dot(qw, xw);
    xv -= d * qv; xw -= d * qw;
  }
  let nv = sqrt(dot(xv, xv) + dot(xw, xw));
  if (!(nv > ANCHOR_TOL * n0)) { return; }
  let c = (*b).count;
  (*b).qv[c] = xv / nv;
  (*b).qw[c] = xw / nv;
  (*b).count = c + 1u;
}

// A body of the pass (split > 0): its RestBody, from its mass and inertia at q0, and with anchors the basis of the
// rows that hold it: its ground slot's anchors, then its pair slots' (in slot order) that hold it.
@compute @workgroup_size(${WG})
fn restAnchors(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let g = rest[groundRec(i)];
  if (g.split == 0u) { return; }
  let pr = props[i];
  let inertia = pr.inertia;
  let q0 = solver[i].q0;
  let ax0 = qrot(q0, vec3f(1.0, 0.0, 0.0));
  let ax1 = qrot(q0, vec3f(0.0, 1.0, 0.0));
  let ax2 = qrot(q0, vec3f(0.0, 0.0, 1.0));
  var b: RestBody;
  b.m = pr.mass;
  // Row r of sum_k ax_k ax_k^T / I_k, each entry (ax_k[r] ax_k[c]) / I_k summed over k, as the reference's.
  b.i0 = ax0.x * ax0 / inertia.x + ax1.x * ax1 / inertia.y + ax2.x * ax2 / inertia.z;
  b.i1 = ax0.y * ax0 / inertia.x + ax1.y * ax1 / inertia.y + ax2.y * ax2 / inertia.z;
  b.i2 = ax0.z * ax0 / inertia.x + ax1.z * ax1 / inertia.y + ax2.z * ax2 / inertia.z;
  if (restAnchorsOn) {
    let si = sqrt(inertia);
    b.rm = 1.0 / sqrt(pr.mass);
    b.s0 = ax0.x * ax0 / si.x + ax1.x * ax1 / si.y + ax2.x * ax2 / si.z;
    b.s1 = ax0.y * ax0 / si.x + ax1.y * ax1 / si.y + ax2.y * ax2 / si.z;
    b.s2 = ax0.z * ax0 / si.x + ax1.z * ax1 / si.y + ax2.z * ax2 / si.z;
    let gs = groundOf(i);
    let gm = (g.flags & ANCHOR) >> 12u;
    for (var q = 0u; q < 4u; q++) {
      if (((gm >> q) & 1u) != 0u) { let r = ptRow(gs, q); addRow(&b, r.n, r.wb); }
    }
    let rs = rowStart[i];
    for (var e = rs; e < rs + rowLength[i]; e++) {
      let slot = adjSlot[e];
      let f = rest[slot].flags;
      let am = (f & ANCHOR) >> 12u;
      if (am == 0u) { continue; }
      // The anchors hold a (ANCHOR_A) or b: only that body takes them.
      let onA = (f & ANCHOR_A) != 0u;
      if (onA == (rest[slot].b == i)) { continue; }
      let s = slotOf(slot);
      for (var q = 0u; q < 4u; q++) {
        if (((am >> q) & 1u) == 0u) { continue; }
        let r = ptRow(s, q);
        if (onA) { addRow(&b, -r.n, r.wa); } else { addRow(&b, r.n, r.wb); }
      }
    }
  }
  restBody[i] = b;
}`,
  restManifold: /* wgsl */ `
// One round of a pair slot's groups, each from last round's velocities (Jacobi across manifolds).
@compute @workgroup_size(${WG})
fn restManifold(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  let r = rest[k];
  let bm = r.flags & BOUNCE;
  let sm = (r.flags & SUPPORT) >> 4u;
  if ((bm | sm) == 0u) { return; }
  let s = slotOf(k);
  var rows: array<NRow, 4>;
  for (var q = 0u; q < 4u; q++) {
    if (!ptUsed(s, q)) { break; }
    rows[q] = ptRow(s, q);
  }
  let a = slotA(s);
  let A = sideAt(a, bodies[a].linVel, bodies[a].angVel, f32(rest[groundRec(a)].split));
  let B = sideAt(r.b, bodies[r.b].linVel, bodies[r.b].angVel, f32(rest[groundRec(r.b)].split));
  var P = r.P;
  var lin = vec3f(0.0); var angB = vec3f(0.0); var linA = vec3f(0.0); var angA = vec3f(0.0);
  if (bm != 0u) { let g = solveGroup(bm, rows, r.vnTarget, P, A, B, true); P = g.P; lin += g.lin; angB += g.angB; linA += g.linA; angA += g.angA; }
  if (sm != 0u) { let g = solveGroup(sm, rows, r.vnTarget, P, A, B, true); P = g.P; lin += g.lin; angB += g.angB; linA += g.linA; angA += g.angA; }
  rest[k].P = P;
  rest[k].lin = lin;
  rest[k].angB = angB;
  rest[k].linA = linA;
  rest[k].angA = angA;
}`,
  restBodies: /* wgsl */ `
// One round's end for a body in the pass: its ground slot's groups from last round's velocities (as the pair
// slots' were), then the sum of every manifold's impulses on it, with its own mass.
@compute @workgroup_size(${WG})
fn restBodies(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let gi = groundRec(i);
  let g = rest[gi];
  let s = g.split;
  if (s == 0u) { return; }
  let b = bodies[i];
  var lin = vec3f(0.0); var ang = vec3f(0.0);
  let bm = g.flags & BOUNCE;
  let sm = (g.flags & SUPPORT) >> 4u;
  if ((bm | sm) != 0u) {
    let gs = groundOf(i);
    var rows: array<NRow, 4>;
    for (var q = 0u; q < 4u; q++) {
      if (!ptUsed(gs, q)) { break; }
      rows[q] = ptRow(gs, q);
    }
    let B = sideAt(i, b.linVel, b.angVel, f32(s));
    var P = g.P;
    if (bm != 0u) { let o = solveGroup(bm, rows, g.vnTarget, P, B, B, false); P = o.P; lin += o.lin; ang += o.angB; }
    if (sm != 0u) { let o = solveGroup(sm, rows, g.vnTarget, P, B, B, false); P = o.P; lin += o.lin; ang += o.angB; }
    rest[gi].P = P;
  }
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) {
    let r = rest[adjSlot[e]];
    if ((r.flags & (BOUNCE | SUPPORT)) == 0u) { continue; }
    if (r.b == i) { lin += r.lin; ang += r.angB; } else { lin += r.linA; ang += r.angA; }
  }
  // With its own mass (and with anchors, projected; the rows its anchors cut are not in the sums: Group).
  let o = resp(sideAt(i, b.linVel, b.angVel, 1.0), lin, ang, false);
  bodies[i].linVel = b.linVel + o.v;
  bodies[i].angVel = b.angVel + o.w;
}`,
  restIslandInit: /* wgsl */ `
// The energy cap, before the rounds: every body its own island, alpha 1, sums 0, and the solve's velocities kept.
@compute @workgroup_size(${WG})
fn restIslandInit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  atomicStore(&island[i].parent, i);
  atomicStore(&island[i].alpha, bitcast<u32>(1.0));
  atomicStore(&island[i].dHi, 0); atomicStore(&island[i].dLo, 0u);
  atomicStore(&island[i].gHi, 0); atomicStore(&island[i].gLo, 0u);
  atomicStore(&island[i].qHi, 0); atomicStore(&island[i].qLo, 0u);
  atomicStore(&island[i].over, 0u);
  island[i].v = bodies[i].linVel;
  island[i].w = bodies[i].angVel;
}`,
  restIslandHook: /* wgsl */ `
// Islands: each pair slot with points joins its bodies' sets, the larger root under the smaller (by a
// compare-exchange that only succeeds while it is still a root; on failure both roots are found again), so each
// island's root ends as its least body whatever the order.
@compute @workgroup_size(${WG})
fn restIslandHook(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  let s = slotOf(k);
  if (!ptUsed(s, 0u)) { return; }
  var a = find(slotA(s));
  var b = find(slotB(s));
  for (var i = 0u; i < FIND_BOUND; i++) {
    if (a == b) { return; }
    let hi = max(a, b);
    let lo = min(a, b);
    if (atomicCompareExchangeWeak(&island[hi].parent, hi, lo).exchanged) { return; }
    a = find(hi);
    b = find(lo);
  }
}`,
  restIslandSum: /* wgsl */ `
// After the rounds: each body's root, and its terms of its island's sums (integers: the same in any order). D: semi-
// implicit Euler's invariant energy, 1/2 m |v + g h/2|^2 + 1/2 w.I w - m g.x, at the start of the step less after
// the solve (the potential's change is m g.(x - x0)), rounded down; for a body in the pass, G = du.M u' and
// Q = du.M du (du the pass's change, u' the solve's velocities with v + g h/2, M at the step's end pose), rounded up.
@compute @workgroup_size(${WG})
fn restIslandSum(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let r = find(i);
  atomicStore(&island[i].parent, r);
  let sb = solver[i];
  let b = bodies[i];
  let m = props[i].mass;
  let I = props[i].inertia;
  let hg = 0.5 * p.dt * p.gravity;
  var v0 = sb.prevVel;
  if (p.iterations == 0u) { v0 = (sb.tp - p.dt * p.dt * p.gravity) / p.dt; }
  let w0 = sb.tphi / p.dt;
  let vp = island[i].v + hg;
  let wp = island[i].w;
  let vs = v0 + hg;
  let d = 0.5 * m * (dot(vs, vs) - dot(vp, vp)) + spinDot(sb.q0, I, w0, w0) - spinDot(b.rot, I, wp, wp) + m * dot(p.gravity, b.pos - sb.x0);
  addFix(r, 0u, fixOf(d, false));
  if (rest[groundRec(i)].split == 0u) { return; }
  let dv = b.linVel - island[i].v;
  let dw = b.angVel - wp;
  addFix(r, 1u, fixOf(m * dot(dv, vp) + 2.0 * spinDot(b.rot, I, dw, wp), true));
  addFix(r, 2u, fixOf(m * dot(dv, dv) + 2.0 * spinDot(b.rot, I, dw, dw), true));
}`,
  restIslandCap: /* wgsl */ `
// A body of the pass whose island's alpha is under 1: its velocity the solve's plus alpha times the pass's change,
// and its ground slot's and its pair slots' (where it is b, so each once) impulses and targets times alpha (the
// release and the stats read them). Its island's alpha is kept on the root (every body of the pass in it writes the
// same bits).
@compute @workgroup_size(${WG})
fn restIslandCap(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let gi = groundRec(i);
  if (rest[gi].split == 0u) { return; }
  let r = atomicLoad(&island[i].parent);
  let a = islandAlpha(r);
  atomicStore(&island[r].alpha, bitcast<u32>(a));
  if (!(a < 1.0)) { return; }
  // At alpha 0 the solve's values are assigned, not scaled: an island flagged for a non-finite term (a pass that
  // made a NaN or an infinity) would otherwise keep it, as 0 * NaN is NaN.
  let none = a == 0.0;
  let v = island[i].v;
  let w = island[i].w;
  bodies[i].linVel = select(v + a * (bodies[i].linVel - v), v, none);
  bodies[i].angVel = select(w + a * (bodies[i].angVel - w), w, none);
  rest[gi].P = select(a * rest[gi].P, vec4f(0.0), none);
  rest[gi].vnTarget = select(a * rest[gi].vnTarget, vec4f(0.0), none);
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) {
    let slot = adjSlot[e];
    if (rest[slot].b != i) { continue; }
    rest[slot].P = select(a * rest[slot].P, vec4f(0.0), none);
    rest[slot].vnTarget = select(a * rest[slot].vnTarget, vec4f(0.0), none);
  }
}`,
  restFinish: /* wgsl */ `
// A bounced point that will separate (P > 0 and its target times h beyond restDepth) starts the next step with
// no force.
fn release(r: RestSlot, s: u32) {
  for (var q = 0u; q < 4u; q++) {
    if (((r.flags >> q) & 1u) != 0u && r.P[q] > 0.0 && r.vnTarget[q] * p.dt > p.restDepth) { ptRelease(s, q); }
  }
}

// A body's ground slot, and the pair slots where it is body b (each pair slot once).
@compute @workgroup_size(${WG})
fn restFinish(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  release(rest[groundRec(i)], groundOf(i));
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) {
    let slot = adjSlot[e];
    let r = rest[slot];
    if (r.b == i) { release(r, slotOf(slot)); }
  }
}`,
};

const KERNELS: Array<Omit<RestKernel, 'code'> & { mark?: boolean; solve?: boolean; cap?: boolean }> = [
  { entry: 'restMark', bindings: ['contacts', 'props', 'solver', 'rest', 'info', 'stepInfo', 'params'], constants: ['restThreshold', 'restCombine'], workgroup: WG, mark: true },
  { entry: 'restMarkBodies', bindings: ['contacts', 'props', 'solver', 'rest', 'info', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: ['restThreshold', 'groundRestitution', 'restCombine', 'restAnchorsOn', 'restAnchorSpeed'], workgroup: WG, mark: true },
  { entry: 'restArgs', bindings: ['info', 'stepInfo', 'params'], constants: [], workgroup: 1 },
  { entry: 'restSupport', bindings: ['contacts', 'bodies', 'rest', 'stepInfo', 'params'], constants: ['restAnchorsOn'], workgroup: WG },
  { entry: 'restCount', bindings: ['contacts', 'bodies', 'rest', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: ['restAnchorsOn'], workgroup: WG },
  { entry: 'restAnchors', bindings: ['contacts', 'props', 'solver', 'restRead', 'rowStart', 'rowLength', 'adjSlot', 'restBody', 'params'], constants: ['restAnchorsOn'], workgroup: WG },
  { entry: 'restManifold', bindings: ['contacts', 'bodies', 'rest', 'restBodyRead', 'stepInfo', 'params'], constants: ['restAnchorCut'], workgroup: WG, solve: true },
  { entry: 'restBodies', bindings: ['bodiesRw', 'contacts', 'rest', 'restBodyRead', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: ['restAnchorCut'], workgroup: WG, solve: true },
  { entry: 'restIslandInit', bindings: ['bodies', 'island', 'params'], constants: [], workgroup: WG, cap: true },
  { entry: 'restIslandHook', bindings: ['contacts', 'island', 'stepInfo', 'params'], constants: [], workgroup: WG, cap: true },
  { entry: 'restIslandSum', bindings: ['bodies', 'props', 'solver', 'restRead', 'island', 'params'], constants: [], workgroup: WG, cap: true },
  { entry: 'restIslandCap', bindings: ['bodiesRw', 'rest', 'island', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: [], workgroup: WG, cap: true },
  { entry: 'restFinish', bindings: ['contactsRw', 'restRead', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: [], workgroup: WG },
];

/**
 * The contact layout the pass reads (AvbdParams.records): 0, SolverContact
 * points; 1, SolverRecord records, with `head` the WGSL their accessors need
 * (the SolverRecord struct and the solver's record indexing: pairRecord,
 * groundRecord, recRaw, recRbw). Records 2 (centre friction) is not
 * implemented.
 */
export type RestLayout = { records: 0 } | { records: 1; head: string };

/**
 * The pass's kernels in encoding order (each its own module and layout, so
 * each binds only what it reads): `common` is the solver's shared WGSL (its
 * structs, NONE, qrot, pairPoint and groundPoint, which read the uniforms p).
 * A kernel that binds the contacts reads them through the layout's view.
 */
export function restitutionKernels(common: string, layout: RestLayout = { records: 0 }, energyCap = false): RestKernel[] {
  const rec = layout.records === 1;
  return KERNELS.filter((k) => energyCap || !k.cap).map(({ mark, solve, cap, ...k }) => {
    const reads = k.bindings.includes('contacts'), writes = k.bindings.includes('contactsRw');
    const decls = k.bindings.map((b, i) => (rec && (b === 'contacts' || b === 'contactsRw') ? recordDecl(i, b === 'contactsRw') : DECL[b](i)));
    const view = !(reads || writes) ? '' : (rec ? `${layout.head}\n${RECORD_VIEW}` : POINT_VIEW) + (writes ? (rec ? RECORD_RELEASE : POINT_RELEASE) : '');
    return { ...k, code: `${common}\n${HEAD}\n${decls.join('\n')}\n${view}\n${mark ? MARK : ''}\n${solve ? SOLVE : ''}\n${cap ? ISLAND : ''}\n${ENTRY[k.entry]!}\n` };
  });
}

const recordDecl = (i: number, rw: boolean) => `@group(0) @binding(${i}) var<storage, ${rw ? 'read_write' : 'read'}> records: array<SolverRecord>;`;

/** The pipeline constants' values: threshold past f32's range is f32's largest (no approach is that fast). */
export function restitutionConstants(c: RestitutionConfig, combineIndex: number): Record<RestConstant, number> {
  return {
    restThreshold: Math.min(c.threshold, F32_MAX), groundRestitution: c.groundRestitution, restCombine: combineIndex,
    restAnchorsOn: c.anchors ? 1 : 0, restAnchorSpeed: Math.min(c.anchorSpeed, F32_MAX), restAnchorCut: c.anchorCut,
  };
}
