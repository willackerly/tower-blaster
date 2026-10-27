// The restitution pass on the GPU (AvbdParams.restitution, opt-in): the
// reference's restitute() (physics-ref/src/avbd.ts, which documents the rule,
// its measurements and its limits) in f32, with the same semantics: after
// post-stabilization, a loaded point (lambdaN < 0) of a pair whose e =
// clamp(combineRestitution(SceneDesc.restitutionCombine, e_a, e_b), 0, 1) is
// above 0 (the ground's e is SceneDesc.ground.restitution) and whose normal
// velocity at the start of the step is -restitutionThreshold or less is
// raised to -e times it; the other loaded points of the bodies involved are
// one-sided supports (depth 1); restitutionRounds rounds of mass-split
// Jacobi, each manifold with a centroid step and one Gauss-Seidel sweep;
// then the conditional lambda reset.
//
// Encoding (AvbdSolver.solve(), after finalize, in the same compute pass):
//   restMark        per pair slot (indirect, as the dual): marks the points
//                   that bounce and their targets, counts them (an atomic)
//   restMarkBodies  per body: the same for its ground slot; whether the body
//                   is in a bouncing manifold (its pair slots' marks)
//   restArgs        one thread: the indirect arguments of everything below,
//                   0 workgroups if no point bounced this step
//   restSupport     per pair slot: the supports, target the solve's vn
//   restCount       per body: its ground slot's supports, and its mass split
//                   (the pass's manifolds it is in)
//   R x restManifold per pair slot: its groups (bouncing points, supports),
//                   each on a copy of last round's velocities with masses
//                   and inertias split; writes the round's impulses
//   R x restBodies  per body: its ground slot's groups (from last round's
//                   velocities too, so it is Jacobi), then the sum of every
//                   manifold's impulses, with its own mass
//   restFinish      per body: the lambda reset of its ground slot and of the
//                   pair slots where it is body b
// That is 6 + 2R dispatches a step while on (22 at the default 8 rounds; 2
// direct, 4 + 2R indirect), and none while off. When nothing bounces (a
// resting scene) only the first three do work: the other 3 + 2R are
// indirect with 0 workgroups. A body's slots are read through the
// colouring's rows (rowStart, rowLength, adjSlot: sorted by slot), so every
// sum is in a fixed order and the pass is bit-reproducible; the only atomic
// is the count of bouncing points, an integer.
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
// Memory while on: one RestSlot (80 B) per contact slot, (maxPairs +
// capacity) x 80 B (pair slots, then one ground slot per body: 10.4% of the
// contact buffer with records 1, which holds 768 B per slot, and 7.8% with
// points, 1024 B), and 28 B of counters and arguments. Off: no buffer and no pipeline (the engine builds the pass only
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
// - The combine rule is checked: while on, AvbdSolver rejects one outside
//   COMBINE_RULES at init. The reference does not check it (an unknown rule
//   gives it a NaN e, so nothing bounces).
//
// Not measured on hardware: the pass's cost while on. solveGroup indexes
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
}

/** Bytes of the counters and indirect arguments: [0] points bouncing this step (atomic), [1..3] per-slot and [4..6] per-body dispatch arguments. */
export const REST_INFO_BYTES = 28;
/** Byte offsets of the two indirect arguments in the info buffer. */
export const REST_SLOT_ARGS = 4, REST_BODY_ARGS = 16;

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

export type RestBinding = 'contacts' | 'contactsRw' | 'props' | 'solver' | 'bodies' | 'bodiesRw' | 'rest' | 'restRead' | 'info' | 'stepInfo' | 'rowStart' | 'rowLength' | 'adjSlot' | 'params';

export interface RestKernel {
  entry: string;
  code: string;
  bindings: RestBinding[];
  /** The pipeline constants it reads. */
  constants: Array<'restThreshold' | 'groundRestitution' | 'restCombine'>;
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
};

// Shared by every kernel: needs no binding but the uniforms p.
const HEAD = /* wgsl */ `
${wgslStruct(RestSlot)}
// AvbdParams.restitutionThreshold (m/s), SceneDesc.ground.restitution, SceneDesc.restitutionCombine (COMBINE_RULES order).
override restThreshold: f32 = 1.0;
override groundRestitution: f32 = 0.0;
override restCombine: u32 = 0u;
const BIG = ${F32_MAX};
// BodyProps.restitution for a NaN e (NAN_RESTITUTION, restitutionWord on the host).
const NAN_E = ${-F32_MAX};
// RestSlot.flags: bits 0-3 bounce, 4-7 support, 8 (ground slots) the body is in a bouncing manifold.
const BOUNCE = 15u;
const SUPPORT = 240u;
const IN_PASS = 256u;

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

// A body in one manifold of the pass: its velocities, its mass, its world inverse inertia at the start of the
// step (q0, the Jacobians' pose), as rows, and its split s: the velocity change per unit impulse is s M^-1 J.
struct Side { v: vec3f, w: vec3f, s: f32, m: f32, i0: vec3f, i1: vec3f, i2: vec3f }
fn sideOf(v: vec3f, w: vec3f, s: f32, m: f32, q0: vec4f, inertia: vec3f) -> Side {
  let ax0 = qrot(q0, vec3f(1.0, 0.0, 0.0));
  let ax1 = qrot(q0, vec3f(0.0, 1.0, 0.0));
  let ax2 = qrot(q0, vec3f(0.0, 0.0, 1.0));
  // Row r of sum_k ax_k ax_k^T / I_k, each entry (ax_k[r] ax_k[c]) / I_k summed over k, as the reference's.
  return Side(v, w, s, m,
    ax0.x * ax0 / inertia.x + ax1.x * ax1 / inertia.y + ax2.x * ax2 / inertia.z,
    ax0.y * ax0 / inertia.x + ax1.y * ax1 / inertia.y + ax2.y * ax2 / inertia.z,
    ax0.z * ax0 / inertia.x + ax1.z * ax1 / inertia.y + ax2.z * ax2 / inertia.z);
}
fn respV(sd: Side, j: vec3f) -> vec3f { return j * (sd.s / sd.m); }
fn respW(sd: Side, j: vec3f) -> vec3f { return sd.s * vec3f(dot(sd.i0, j), dot(sd.i1, j), dot(sd.i2, j)); }
// The row's inverse effective mass under the split.
fn invOf(r: NRow, A: Side, B: Side, hasA: bool) -> f32 {
  var w = dot(r.n, respV(B, r.n)) + dot(r.wb, respW(B, r.wb));
  if (hasA) { w += dot(-r.n, respV(A, -r.n)) + dot(r.wa, respW(A, r.wa)); }
  return w;
}

// What one group of a manifold's points did in a round: their impulses so far, and the round's impulse on b
// (lin, angB) and on a (-lin, angA), the sum of dP J.
struct Group { P: vec4f, lin: vec3f, angB: vec3f, angA: vec3f }

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
    var d = (Tm / kf - vnOf(r, vb, wb, va, wa, hasA)) / invOf(r, A, B, hasA);
    if (d < 0.0) { d = max(d, -kf * minP); }
    vb += respV(B, r.n) * d; wb += respW(B, r.wb) * d;
    if (hasA) { va += respV(A, -r.n) * d; wa += respW(A, r.wa) * d; }
    for (var q = 0u; q < 4u; q++) {
      if (((mask >> q) & 1u) == 0u) { continue; }
      P[q] = P[q] + d / kf;
      dP[q] = dP[q] + d / kf;
    }
  }
  for (var q = 0u; q < 4u; q++) {
    if (((mask >> q) & 1u) == 0u) { continue; }
    let r = rs[q];
    let Pq = max(0.0, P[q] + (T[q] - vnOf(r, vb, wb, va, wa, hasA)) / invOf(r, A, B, hasA));
    let d = Pq - P[q];
    P[q] = Pq;
    dP[q] = dP[q] + d;
    vb += respV(B, r.n) * d; wb += respW(B, r.wb) * d;
    if (hasA) { va += respV(A, -r.n) * d; wa += respW(A, r.wa) * d; }
  }
  var g = Group(P, vec3f(0.0), vec3f(0.0), vec3f(0.0));
  for (var q = 0u; q < 4u; q++) {
    if (((mask >> q) & 1u) == 0u) { continue; }
    g.lin += dP[q] * rs[q].n;
    g.angB += dP[q] * rs[q].wb;
    g.angA += dP[q] * rs[q].wa;
  }
  return g;
}

// The number of the pass's manifolds a slot's record holds: its bouncing points and its supports are two.
fn groups(f: u32) -> u32 { return select(0u, 1u, (f & BOUNCE) != 0u) + select(0u, 1u, (f & SUPPORT) != 0u); }
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
// one-sided constraints that keep the normal velocity the solve left (target J u, P >= 0).
@compute @workgroup_size(${WG})
fn restSupport(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  let s = slotOf(k);
  if (!ptUsed(s, 0u)) { return; }
  let a = slotA(s);
  let b = slotB(s);
  if (((rest[groundRec(a)].flags | rest[groundRec(b)].flags) & IN_PASS) == 0u) { return; }
  var r = rest[k];
  let A = bodies[a];
  let B = bodies[b];
  var sm = 0u;
  for (var q = 0u; q < 4u; q++) {
    if (!ptUsed(s, q)) { break; }
    if (((r.flags >> q) & 1u) != 0u || !ptLoaded(s, q)) { continue; }
    sm |= 1u << q;
    r.vnTarget[q] = vnOf(ptRow(s, q), B.linVel, B.angVel, A.linVel, A.angVel, true);
  }
  if (sm != 0u) {
    rest[k].flags = r.flags | (sm << 4u);
    rest[k].vnTarget = r.vnTarget;
  }
}`,
  restCount: /* wgsl */ `
// A body's ground supports (if it is in the pass), and its mass split: the pass's manifolds it is in.
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
      r.vnTarget[q] = vnOf(ptRow(gs, q), B.linVel, B.angVel, vec3f(0.0), vec3f(0.0), false);
    }
    r.flags |= sm << 4u;
  }
  var s = groups(r.flags);
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) { s += groups(rest[adjSlot[e]].flags); }
  rest[gi].flags = r.flags;
  rest[gi].vnTarget = r.vnTarget;
  rest[gi].split = s;
}`,
  restManifold: /* wgsl */ `
fn sideAt(i: u32, s: u32) -> Side {
  let b = bodies[i];
  let pr = props[i];
  return sideOf(b.linVel, b.angVel, f32(s), pr.mass, solver[i].q0, pr.inertia);
}

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
  let A = sideAt(a, rest[groundRec(a)].split);
  let B = sideAt(r.b, rest[groundRec(r.b)].split);
  var P = r.P;
  var lin = vec3f(0.0); var angB = vec3f(0.0); var angA = vec3f(0.0);
  if (bm != 0u) { let g = solveGroup(bm, rows, r.vnTarget, P, A, B, true); P = g.P; lin += g.lin; angB += g.angB; angA += g.angA; }
  if (sm != 0u) { let g = solveGroup(sm, rows, r.vnTarget, P, A, B, true); P = g.P; lin += g.lin; angB += g.angB; angA += g.angA; }
  rest[k].P = P;
  rest[k].lin = lin;
  rest[k].angB = angB;
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
  let pr = props[i];
  let q0 = solver[i].q0;
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
    let B = sideOf(b.linVel, b.angVel, f32(s), pr.mass, q0, pr.inertia);
    var P = g.P;
    if (bm != 0u) { let o = solveGroup(bm, rows, g.vnTarget, P, B, B, false); P = o.P; lin += o.lin; ang += o.angB; }
    if (sm != 0u) { let o = solveGroup(sm, rows, g.vnTarget, P, B, B, false); P = o.P; lin += o.lin; ang += o.angB; }
    rest[gi].P = P;
  }
  let rs = rowStart[i];
  for (var e = rs; e < rs + rowLength[i]; e++) {
    let r = rest[adjSlot[e]];
    if ((r.flags & (BOUNCE | SUPPORT)) == 0u) { continue; }
    if (r.b == i) { lin += r.lin; ang += r.angB; } else { lin -= r.lin; ang += r.angA; }
  }
  let full = sideOf(b.linVel, b.angVel, 1.0, pr.mass, q0, pr.inertia);
  bodies[i].linVel = b.linVel + respV(full, lin);
  bodies[i].angVel = b.angVel + respW(full, ang);
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

const KERNELS: Array<Omit<RestKernel, 'code'> & { mark?: boolean }> = [
  { entry: 'restMark', bindings: ['contacts', 'props', 'solver', 'rest', 'info', 'stepInfo', 'params'], constants: ['restThreshold', 'restCombine'], workgroup: WG, mark: true },
  { entry: 'restMarkBodies', bindings: ['contacts', 'props', 'solver', 'rest', 'info', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: ['restThreshold', 'groundRestitution', 'restCombine'], workgroup: WG, mark: true },
  { entry: 'restArgs', bindings: ['info', 'stepInfo', 'params'], constants: [], workgroup: 1 },
  { entry: 'restSupport', bindings: ['contacts', 'bodies', 'rest', 'stepInfo', 'params'], constants: [], workgroup: WG },
  { entry: 'restCount', bindings: ['contacts', 'bodies', 'rest', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: [], workgroup: WG },
  { entry: 'restManifold', bindings: ['contacts', 'bodies', 'props', 'solver', 'rest', 'stepInfo', 'params'], constants: [], workgroup: WG },
  { entry: 'restBodies', bindings: ['bodiesRw', 'props', 'solver', 'contacts', 'rest', 'rowStart', 'rowLength', 'adjSlot', 'params'], constants: [], workgroup: WG },
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
export function restitutionKernels(common: string, layout: RestLayout = { records: 0 }): RestKernel[] {
  const rec = layout.records === 1;
  return KERNELS.map(({ mark, ...k }) => {
    const reads = k.bindings.includes('contacts'), writes = k.bindings.includes('contactsRw');
    const decls = k.bindings.map((b, i) => (rec && (b === 'contacts' || b === 'contactsRw') ? recordDecl(i, b === 'contactsRw') : DECL[b](i)));
    const view = !(reads || writes) ? '' : (rec ? `${layout.head}\n${RECORD_VIEW}` : POINT_VIEW) + (writes ? (rec ? RECORD_RELEASE : POINT_RELEASE) : '');
    return { ...k, code: `${common}\n${HEAD}\n${decls.join('\n')}\n${view}\n${mark ? MARK : ''}\n${ENTRY[k.entry]!}\n` };
  });
}

const recordDecl = (i: number, rw: boolean) => `@group(0) @binding(${i}) var<storage, ${rw ? 'read_write' : 'read'}> records: array<SolverRecord>;`;

/** The pipeline constants' values: threshold past f32's range is f32's largest (no approach is that fast). */
export function restitutionConstants(c: RestitutionConfig, combineIndex: number): Record<'restThreshold' | 'groundRestitution' | 'restCombine', number> {
  return { restThreshold: Math.min(c.threshold, F32_MAX), groundRestitution: c.groundRestitution, restCombine: combineIndex };
}
