// GPU AVBD solver: a port of the reference (physics-ref/src/avbd.ts, which
// documents the method and every departure from the authors' 2D code). This
// file only adds what the GPU needs:
//
// - Bodies are swept colour by colour (Coloring), one thread per body; a
//   body reads its contacts through its slot-sorted contact row, so the
//   force sums are in a fixed order and results are bit-reproducible.
// - Contact state persists through a two-half history: this step's
//   contacts, pairs and pair-group offsets are written to half `cur`, last
//   step's are read from the other half. Before the narrowphase, match()
//   finds each pair's previous slot by scanning a's group in last step's
//   pair list (the broadphase groups pairs by a) and reads the SAT axis of
//   its previous manifold, which the narrowphase prefers; ground contacts
//   sit at a fixed per-body slot.
// - Rolling contacts (AvbdParams.rollingContacts) need last step's final
//   displacements: setup() runs before initBodies(), so they are still in
//   SolverBody.dp and phi, and setup reads them there.
// - Post-stabilization is always on (the reference's default).
// - The loaded-gap slop (AvbdParams.gapSlop, off by default) is the WGSL
//   override gapSlop, a pipeline constant fixed per AvbdSolver (the engine's
//   params are fixed at construction). At 0, its default, no constant is
//   passed, so every pipeline is built from the same descriptor as before
//   the port, and each use sits behind a test that is constant false (that
//   the compiler drops it is inferred, not inspected; on SwiftShader the
//   floats are those before the port, on 5 scenes in 7 runs). setup() marks
//   a point it applies to with bit 1 of SolverContact.used (LOADED_GAP), so
//   the contact stays 128 B, and evalC() recomputes the excused part,
//   min(c0.x, gapSlop): on, that is two compares, an and, a min, a subtract
//   and a select per evaluation, and no extra load (used is read anyway, for
//   the end of a slot's points). With records (AvbdParams.records) setup
//   keeps the mark in bit 8 + q of the record's flags (1) or stick (2) word
//   (LOADED_BIT), read behind gapSlop > 0.0; records 1 hands it to evalC()
//   as LOADED_GAP, records 2 to evalN(). In f32 an excused gap stops closing
//   a few um up, by an amount that depends on where the scene is: a 25 um lift
//   under the top 4 cubes of an 8-cube column ends 6.2 um up (3.5 um with the
//   scene 6 m lower), where the reference's keeps closing, and one cube on
//   the ground lifted 25 um ends 0.09 um up (engine-gapslop.test.ts). Which
//   f32 quantity sets it is not traced.
//
// - Restitution (AvbdParams.restitution, off by default) is a pass of its
//   own after finalize, in restitution.ts (its header has the kernels, the
//   dispatches and memory on, and the f32 departures). Its buffers and
//   pipelines exist only while it is on (AvbdSolver's restitution); off,
//   solve() encodes exactly what it did before the port, and no kernel here
//   reads BodyProps.restitution.
//
// Each kernel binds at most 8 storage buffers (the WebGPU default limit).
import type { CombineRule } from '@tb/engine-api';
import { assertStorageFits, readBuffer } from '@tb/gpu';
import { RECORD_MODES } from '@tb/physics-ref';
import { Body, BodyProps, CentreDual, CentreRecord, ColorParams, ContactDual, field, Manifold, RestSlot, SolverBody, SolverContact, SolverParams, SolverRecord, type StructLayout, wgslStruct } from '@tb/schema';
import { MAX_COLORS } from './coloring.ts';
import { REST_BODY_ARGS, REST_INFO_BYTES, REST_SLOT_ARGS, type RestBinding, type RestitutionConfig, restitutionConstants, restitutionKernels } from './restitution.ts';

const WG = 64;
/** Most threads the tail workgroup can have (SolverDispatch.tailThreads): WebGPU's default limit per workgroup. */
const MAX_TAIL = 256;
const NONE = 0xffffffff;
/** The largest finite f32. */
const F32_MAX = 3.4028234663852886e38;
/** Uniform buffer offset alignment for the per-colour dynamic uniforms. */
const DYN = 256;
/** The per-colour uniforms' passes: main iterations, stabilization, and with the fused dual the step's first fused main sweep and the later ones. */
const PASS = { main: 0, stab: 1, firstFused: 2, fused: 3 } as const;

const COMMON = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(BodyProps)}
${wgslStruct(SolverBody)}
${wgslStruct(SolverContact)}
${wgslStruct(SolverParams)}
const NONE = ${NONE}u;
// SolverContact.used bit 1: a loaded point under the loaded-gap slop (setup() sets it, evalC() reads it).
const LOADED_GAP = 2u;
// AvbdParams.gapSlop, m (AvbdSolver's gapSlop). 0, the default, is off: every use is behind gapSlop > 0.0.
override gapSlop: f32 = 0.0;

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn qconj(q: vec4f) -> vec4f { return vec4f(-q.xyz, q.w); }
fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
// q advanced by rotation vector phi (exponential map), normalized.
fn applyRotation(q: vec4f, phi: vec3f) -> vec4f {
  let t = length(phi);
  var s = 0.5 - t * t / 48.0;
  if (t > 1e-9) { s = sin(t * 0.5) / t; }
  return normalize(qmul(vec4f(phi * s, cos(t * 0.5)), q));
}
const E = vec3f(0.267261, 0.534522, 0.801784);
fn tangent1(n: vec3f) -> vec3f {
  let c = cross(n, E);
  let l = length(c);
  if (l > 1e-6) { return c / l; }
  if (abs(n.x) < 0.9) { return normalize(cross(n, vec3f(1.0, 0.0, 0.0))); }
  return normalize(cross(n, vec3f(0.0, 1.0, 0.0)));
}
// Contact half size in points: 4 per pair slot, then 4 per body (ground).
fn halfSize() -> u32 { return (p.maxPairs + p.capacity) * 4u; }
fn pairPoint(half: u32, slot: u32, q: u32) -> u32 { return half * halfSize() + slot * 4u + q; }
fn groundPoint(half: u32, body: u32, q: u32) -> u32 { return half * halfSize() + (p.maxPairs + body) * 4u + q; }
`;

// Constraint values (n, t1, t2) of a contact at the current displacements.
const EVAL = /* wgsl */ `
fn evalC(ct: SolverContact, alpha: f32, dpA: vec3f, phiA: vec3f, dpB: vec3f, phiB: vec3f) -> vec3f {
  let t2 = cross(ct.n, ct.t1);
  // Start-of-step penetration is error (scaled by 1 - alpha); a gap is not.
  var c = vec3f(select(ct.c0.x, (1.0 - alpha) * ct.c0.x, ct.c0.x < 0.0), (1.0 - alpha) * ct.c0.y, (1.0 - alpha) * ct.c0.z);
  // Loaded gaps ("Loaded gaps" in the reference's step()): in the main iterations (alpha 1: the primal's and
  // the dual's, never the stabilization pass) a point setup() marked counts its start gap less
  // min(c0.x, gapSlop), so never below 0 and the support never above the body's start.
  if (gapSlop > 0.0 && alpha == 1.0 && (ct.used & LOADED_GAP) != 0u) { c.x = ct.c0.x - min(ct.c0.x, gapSlop); }
  c += vec3f(
    dot(ct.n, dpB) + dot(cross(ct.rbw, ct.n), phiB),
    dot(ct.t1, dpB) + dot(cross(ct.rbw, ct.t1), phiB),
    dot(t2, dpB) + dot(cross(ct.rbw, t2), phiB));
  if (ct.a != NONE) {
    c -= vec3f(
      dot(ct.n, dpA) + dot(cross(ct.raw, ct.n), phiA),
      dot(ct.t1, dpA) + dot(cross(ct.raw, ct.t1), phiA),
      dot(t2, dpA) + dot(cross(ct.raw, t2), phiA));
  }
  return c;
}`;

// Before the broadphase: speculative sweep and inflated bounding spheres.
const PREP = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<storage, read> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> props: array<BodyProps>;
@group(0) @binding(2) var<storage, read_write> spheres: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> sweep: array<f32>;
@group(0) @binding(4) var<uniform> p: SolverParams;

@compute @workgroup_size(${WG})
fn prepare(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let b = bodies[i];
  let r = props[i].radius;
  let v = length(b.linVel) + p.dt * length(p.gravity) + length(b.angVel) * r;
  var s = 0.0;
  if (p.sweepOn != 0u) { s = min(p.maxSweep, p.dt * v); }
  sweep[i] = s;
  spheres[i] = vec4f(b.pos, r + s);
}`;

// Before the narrowphase: each pair's slot and SAT axis last step.
const MATCH = /* wgsl */ `
${COMMON}
${wgslStruct(Manifold)}
@group(0) @binding(0) var<storage, read> pairs: array<vec2u>;
@group(0) @binding(1) var<storage, read> total: array<u32, 8>;
@group(0) @binding(2) var<storage, read> stepInfo: array<u32, 16>;
@group(0) @binding(3) var<storage, read> pairHist: array<vec2u>;
@group(0) @binding(4) var<storage, read> offHist: array<u32>;
// Still last step's: the narrowphase has not run yet.
@group(0) @binding(5) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(6) var<storage, read_write> prev: array<vec2u>;
@group(0) @binding(7) var<uniform> p: SolverParams;

@compute @workgroup_size(${WG})
fn matchPairs(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let a = pairs[k].x;
  let b = pairs[k].y;
  let h = 1u - p.cur;
  let written = stepInfo[8u + h];
  var r = vec2u(NONE, NONE);
  if (a < p.prevN && b < p.prevN) {
    let start = min(offHist[h * p.capacity + a], written);
    var end = written;
    if (a + 1u < p.prevN) { end = min(offHist[h * p.capacity + a + 1u], written); }
    for (var s = start; s < end; s++) {
      if (pairHist[h * p.maxPairs + s].y == b) {
        let m = manifolds[s];
        r = vec2u(s, select(NONE, m.axis, m.count > 0u));
        break;
      }
    }
  }
  prev[k] = r;
}`;

// Contacts from manifolds, with state carried over from last step.
// Eight storage buffers, the WebGPU default limit (packages/gpu createDevice
// requests no more): another binding needs one freed first, e.g. stepInfo
// moved into a uniform.
const SETUP = /* wgsl */ `
${COMMON}
${wgslStruct(Manifold)}
@group(0) @binding(0) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(1) var<storage, read> groundManifolds: array<Manifold>;
@group(0) @binding(2) var<storage, read> bodies: array<Body>;
@group(0) @binding(3) var<storage, read> props: array<BodyProps>;
// [0..8) copy of the broadphase total ([3] = pair slots this step), [8 + h] = slots written in half h
@group(0) @binding(4) var<storage, read> stepInfo: array<u32, 16>;
// (last step's slot, axis) per pair, from match().
@group(0) @binding(5) var<storage, read> prev: array<vec2u>;
@group(0) @binding(6) var<storage, read_write> contacts: array<SolverContact>;
// Last step's final dp, phi per body (initBodies has not run yet): rolling contacts' slip and normal motion.
@group(0) @binding(7) var<storage, read> solver: array<SolverBody>;
@group(0) @binding(8) var<uniform> p: SolverParams;

fn point(m: Manifold, q: u32) -> vec4f {
  switch q {
    case 0u: { return m.p0; }
    case 1u: { return m.p1; }
    case 2u: { return m.p2; }
    default: { return m.p3; }
  }
}

// SceneDesc.frictionCombine, in COMBINE_RULES order.
fn combineFriction(a: f32, b: f32) -> f32 {
  switch (p.frictionCombine) {
    case 1u: { return min(a, b); }
    case 2u: { return max(a, b); }
    case 3u: { return a * b; }
    default: { return 0.5 * (a + b); }
  }
}

// Fill the 4 points of manifold m into contacts[dst + q]; old points (if
// any) are contacts[old + q].
//
// Rolling contacts (the reference's collide() says why): a contact on a
// sphere takes its points from this step's manifold, carries static friction
// as last step's slip (its tangential C at the final dx, c0_t + J_t dx)
// instead of its anchors, and is matched by the smaller sphere's lever arm in
// world space (b's if they are equal; a box or the ground counts as
// infinitely large). Between two bodies, a reused one that moved along its
// normal by restDepth or more last step was in an impact: its load floor
// stops at sqrt(m_a m_b) / h^2.
fn setup(m: Manifold, a: u32, b: u32, mu: f32, dst: u32, old: u32, hasOld: bool) {
  var taken = array<bool, 4>(false, false, false, false);
  let n = m.normal;
  let t1 = tangent1(n);
  let t2 = cross(n, t1);
  let sphereA = a != NONE && props[a].sphere != 0u;
  let sphereB = props[b].sphere != 0u;
  let roll = p.rollingContacts != 0u && (sphereA || sphereB);
  // The load cap's reference (AvbdParams.loadCap): last step's largest |lambdaN| on a point of this pair.
  var pairLoad = 0.0;
  if (hasOld && p.loadCap > 0.0) {
    for (var o = 0u; o < 4u; o++) {
      let oc = contacts[old + o];
      if (oc.used != 0u) { pairLoad = max(pairLoad, abs(oc.lambdaN)); }
    }
  }
  let onB = sphereB && (!sphereA || props[b].radius <= props[a].radius);
  // Last step's final displacements (zero for a body added since, and for the ground).
  var dpA = vec3f(0.0); var phiA = vec3f(0.0);
  if (roll && a != NONE) { dpA = solver[a].dp; phiA = solver[a].phi; }
  var dpB = vec3f(0.0); var phiB = vec3f(0.0);
  if (roll) { dpB = solver[b].dp; phiB = solver[b].phi; }
  for (var q = 0u; q < 4u; q++) {
    var ct: SolverContact;
    ct.used = 0u;
    if (q >= m.count) { contacts[dst + q] = ct; continue; }
    let pt = point(m, q);
    // Surface points: a's is the one further along n (it reaches into b).
    let wa = pt.xyz + n * (pt.w * 0.5);
    let wb = pt.xyz - n * (pt.w * 0.5);
    let B = bodies[b];
    var ra = wa;
    if (a != NONE) { ra = qrot(qconj(bodies[a].rot), wa - bodies[a].pos); }
    var rb = qrot(qconj(B.rot), wb - B.pos);
    ct.lambdaN = 0.0;
    ct.lt = vec2f(0.0);
    ct.kN = p.penaltyMin;
    ct.kT = p.penaltyMin;
    ct.stick = 0u;
    // A rolling contact's slip carried over (c0_t), if it held.
    var slip = vec2f(0.0);
    var carry = false;
    if (hasOld) {
      // Matched by b's anchor, or a rolling contact by the smaller sphere's world lever arm.
      var key = rb;
      if (roll) { if (onB) { key = wb - B.pos; } else { key = wa - bodies[a].pos; } }
      var best = 4u;
      var bestD = p.matchDistance;
      for (var o = 0u; o < 4u; o++) {
        let oc = contacts[old + o];
        if (oc.used == 0u || taken[o]) { continue; }
        var ok = oc.rb;
        if (roll) { ok = select(oc.raw, oc.rbw, onB); }
        let d = length(ok - key);
        if (d < bestD) { best = o; bestD = d; }
      }
      if (best < 4u) {
        taken[best] = true;
        let oc = contacts[old + best];
        // Friction force as a world vector, re-expressed in the new basis.
        let f = oc.lt.x * oc.t1 + oc.lt.y * cross(oc.n, oc.t1);
        ct.lambdaN = oc.lambdaN;
        ct.lt = vec2f(dot(f, t1), dot(f, t2));
        ct.kN = clamp(oc.kN * p.gamma, p.penaltyMin, p.penaltyMax);
        // How far its point on b moved relative to a's over last step, J dx as a world vector.
        var u = vec3f(0.0);
        if (roll) { u = dpB + cross(phiB, oc.rbw) - (dpA + cross(phiA, oc.raw)); }
        // Load floor (AvbdParams.restDepth): keeps a resting stack stiff enough not to lean over.
        // A rolling contact between two bodies that moved along its normal by restDepth was in an impact.
        // Load cap (AvbdParams.loadCap): eases kN towards loadCap x pairLoad / restDepth, to no less than capFall x its uncapped
        // value each step, so it forgets landings and the ramp (see the reference).
        if (p.restDepth > 0.0) {
          var kFloor = abs(oc.lambdaN) / p.restDepth;
          if (roll && a != NONE && abs(dot(oc.n, u)) >= p.restDepth) { kFloor = min(kFloor, sqrt(props[a].mass * props[b].mass) / (p.dt * p.dt)); }
          if (p.loadCap > 0.0) { ct.kN = max(min(ct.kN, max(p.loadCap * (pairLoad / p.restDepth), p.capFall * ct.kN)), p.penaltyMin); }
          ct.kN = min(max(ct.kN, kFloor), p.penaltyMax);
        }
        ct.kT = clamp(oc.kT * p.gamma, p.penaltyMin, p.penaltyMax);
        // Static friction held at the end of last step: keep its anchors, unless they
        // have drifted apart along the surface by stickThreshold since. A rolling
        // contact keeps its fresh points and carries last step's slip instead.
        if (oc.inCone != 0u && roll) {
          let t2o = cross(oc.n, oc.t1);
          let s = (oc.c0.y + dot(oc.t1, u)) * oc.t1 + (oc.c0.z + dot(t2o, u)) * t2o;
          let st = vec2f(dot(s, t1), dot(s, t2));
          if (length(st) < p.stickThreshold) { ct.stick = 1u; slip = st; carry = true; }
        } else if (oc.inCone != 0u) {
          var opa = oc.ra;
          if (a != NONE) { opa = bodies[a].pos + qrot(bodies[a].rot, oc.ra); }
          let od = B.pos + qrot(B.rot, oc.rb) - opa;
          if (length(vec2f(dot(od, t1), dot(od, t2))) < p.stickThreshold) { ct.stick = 1u; ra = oc.ra; rb = oc.rb; }
        }
      }
    }
    var raw = vec3f(0.0);
    var pa = ra;
    if (a != NONE) { raw = qrot(bodies[a].rot, ra); pa = bodies[a].pos + raw; }
    let rbw = qrot(B.rot, rb);
    let d = B.pos + rbw - pa;
    ct.n = n; ct.t1 = t1; ct.mu = mu; ct.used = 1u;
    ct.ra = ra; ct.rb = rb; ct.raw = raw; ct.rbw = rbw;
    ct.c0 = vec3f(dot(d, n) + p.slop, dot(d, t1), dot(d, t2));
    if (carry) { ct.c0 = vec3f(ct.c0.x, ct.c0.y + slip.x, ct.c0.z + slip.y); }
    // Loaded-gap slop (the reference's collide()): a point that bore load at the end of last step (its
    // warm-started lambdaN < 0; 0 for a fresh point), not a rolling contact, with a gap at the start of this one.
    if (gapSlop > 0.0 && !roll && ct.lambdaN < 0.0 && ct.c0.x > 0.0) { ct.used = 1u | LOADED_GAP; }
    ct.a = a; ct.b = b;
    contacts[dst + q] = ct;
  }
}

@compute @workgroup_size(${WG})
fn pairSetup(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  let m = manifolds[k];
  let a = m.a;
  let b = m.b;
  let ps = prev[k].x;
  let mu = combineFriction(props[a].friction, props[b].friction);
  setup(m, a, b, mu, pairPoint(p.cur, k, 0u), pairPoint(1u - p.cur, select(0u, ps, ps != NONE), 0u), ps != NONE);
}

@compute @workgroup_size(${WG})
fn groundSetup(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  var m = groundManifolds[i];
  if (p.hasGround == 0u) { m.count = 0u; }
  let mu = combineFriction(props[i].friction, p.groundFriction);
  setup(m, NONE, i, mu, groundPoint(p.cur, i, 0u), groundPoint(1u - p.cur, i, 0u), i < p.prevN);
}`;

// Start-of-step body state: targets and warm-started guesses.
const INIT = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read_write> solver: array<SolverBody>;
@group(0) @binding(2) var<uniform> p: SolverParams;

@compute @workgroup_size(${WG})
fn initBodies(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  var b = bodies[i];
  let ws = length(b.angVel);
  if (ws > p.maxAngularSpeed) { b.angVel = b.angVel * (p.maxAngularSpeed / ws); bodies[i].angVel = b.angVel; }
  var s = solver[i];
  let h = p.dt;
  let g = p.gravity;
  let gl2 = dot(g, g);
  // Adaptive warm start (VBD): expect gravity only as far as the body was accelerating with it.
  var wAcc = 0.0;
  if (gl2 > 0.0) { wAcc = clamp(dot((b.linVel - s.prevVel) / h, g) / gl2, 0.0, 1.0); }
  s.x0 = b.pos;
  s.q0 = b.rot;
  s.tp = h * b.linVel + h * h * g;
  s.tphi = h * b.angVel;
  s.dp = h * b.linVel + h * h * g * wAcc;
  s.phi = h * b.angVel;
  solver[i] = s;
}`;

// The primal sweep. Each body's 6x6 system is built and solved in one of two
// forms (SolverDispatch.hessian), both generated here by solveWgsl() from the
// same pieces: 'array', the original, in private arrays with dynamically
// indexed loops, kept unchanged for A/B timing and as the tests' oracle; and
// 'registers' (registerSolveBody()), the same floating-point operations in
// the same order in named scalars, every loop unrolled. On the M5 Max the
// solver probe (PR #40, probe-kernels.ts) measured a contact point at
// 1450-1690 ns in the array form's shape and 357-556 ns in registers: the
// private array spills.
const SOLVE_HEAD = /* wgsl */ `
${COMMON}
${wgslStruct(ColorParams)}
${EVAL}
@group(0) @binding(0) var<storage, read> props: array<BodyProps>;
@group(0) @binding(1) var<storage, read_write> solver: array<SolverBody>;
@group(0) @binding(2) var<storage, read> contacts: array<SolverContact>;
@group(0) @binding(3) var<storage, read> order: array<u32>;
@group(0) @binding(4) var<storage, read> colorStart: array<u32>;
@group(0) @binding(5) var<storage, read> rowStart: array<u32>;
@group(0) @binding(6) var<storage, read> rowLength: array<u32>;
@group(0) @binding(7) var<storage, read> adjSlot: array<u32>;
@group(0) @binding(8) var<uniform> p: SolverParams;
@group(0) @binding(9) var<uniform> cp: ColorParams;
`;

// The array form's system: module-scope private arrays, zeroed or assigned by each solveBody().
const ARRAY_STORAGE = /* wgsl */ `
var<private> lhs: array<f32, 36>;
var<private> rhs: array<f32, 6>;
`;

// Row r (n, t1, t2) of the contact Jacobian for body b, or for body a.
const JROW = /* wgsl */ `
fn jrow(ct: SolverContact, r: u32, onB: bool) -> array<f32, 6> {
  var u = ct.n;
  if (r == 1u) { u = ct.t1; } else if (r == 2u) { u = cross(ct.n, ct.t1); }
  // Body b: (u, rbw x u); body a: -(u, raw x u).
  var w = cross(ct.rbw, u);
  if (!onB) { w = -cross(ct.raw, u); u = -u; }
  return array<f32, 6>(u.x, u.y, u.z, w.x, w.y, w.z);
}
`;

// One contact's constraint values, clamped forces F (n, t1, t2) and tangent
// stiffness kt, for body i: the head of the array form's accumulate(), shared
// by both forms. Declares onB, me, C, F, kt and the temporaries they need.
const CONTACT_FORCE = /* wgsl */ `  let onB = ct.b == i;
  let me = solver[i];
  var dpA = vec3f(0.0); var phiA = vec3f(0.0); var dpB = vec3f(0.0); var phiB = vec3f(0.0);
  if (onB) {
    dpB = me.dp; phiB = me.phi;
    if (ct.a != NONE) { let o = solver[ct.a]; dpA = o.dp; phiA = o.phi; }
  } else {
    dpA = me.dp; phiA = me.phi;
    let o = solver[ct.b]; dpB = o.dp; phiB = o.phi;
  }
  let C = evalC(ct, cp.alpha, dpA, phiA, dpB, phiB);
  // Clamped forces: normal compressive only, friction inside the cone.
  let fn0 = min(0.0, ct.kN * C.x + ct.lambdaN);
  let bound = ct.mu * abs(ct.lambdaN);
  let z = ct.kT * C.yz + ct.lt;
  let fl = length(z);
  // The clamp's scale: F_t = s z, s = min(1, bound / |z|).
  var s = 1.0;
  if (fl > bound) { s = select(0.0, bound / fl, fl > 0.0); }
  let F = array<f32, 3>(fn0, s * z.x, s * z.y);
  // Row stiffness K: k_n on the normal, k_t s on both tangents. Sliding, that
  // is the secant of the clamp (the half-quadratic upper bound of the friction
  // energy), continuous across the cone boundary; see the reference's step().
  let kt = select(ct.kT, ct.kT * s, p.slidingHessian != 0u);`;

/**
 * Where the fused dual (SolverDispatch.dualFusion) keeps a contact's dual
 * state during the sweeps: off; 'side', a ContactDual array beside the
 * contacts, so the solve kernel binds them read-only; 'record', the contact
 * records themselves, which the solve kernel then binds read_write.
 */
type Fusion = 'off' | 'side' | 'record';
const fusionOf = (d: Pick<SolverDispatch, 'dualFusion' | 'solveContactsRW'>): Fusion => (!d.dualFusion ? 'off' : d.solveContactsRW ? 'record' : 'side');

/** Replace `from`, which must occur exactly `count` times in `text`, by `to`. */
function swap(text: string, from: string, to: string, count = 1): string {
  const n = text.split(from).length - 1;
  if (n !== count) throw new Error(`solver.ts: expected ${count} of ${JSON.stringify(from.slice(0, 60))} in a shader piece, found ${n}`);
  return text.split(from).join(to);
}

/**
 * CONTACT_FORCE with the fused dual: before its force, the first visit this
 * sweep of a contact runs the dual update the last sweep deferred to it
 * (dualPoint()'s arithmetic), and both visits read the dual state from du. A
 * contact's C depends only on its two bodies, and neither has moved since the
 * last sweep ended: the first visit is the earlier body in the colour order
 * (SolverBody.visit; the body itself for a ground contact), and the other is
 * solved a colour or more later. In the main sweeps cp.alpha is the dual's
 * alpha (1), so this C is the one dualPoint() would evaluate, bit for bit.
 * Needs ci, the contact's index, in scope.
 */
function contactForce(fusion: Fusion): string {
  if (fusion === 'off') return CONTACT_FORCE;
  const visit = swap(swap(CONTACT_FORCE,
    '    if (ct.a != NONE) { let o = solver[ct.a]; dpA = o.dp; phiA = o.phi; }',
    '    if (ct.a != NONE) { let o = solver[ct.a]; dpA = o.dp; phiA = o.phi; first = me.visit < o.visit; }'),
    '    let o = solver[ct.b]; dpB = o.dp; phiB = o.phi;',
    '    let o = solver[ct.b]; dpB = o.dp; phiB = o.phi; first = me.visit < o.visit;');
  const withFirst = swap(visit, '\n  if (onB) {', '\n  // The contact\'s first visit this sweep: the other body comes later in the colour order, or is the ground.\n  var first = true;\n  if (onB) {');
  const load = fusion === 'side'
    ? `  // Until the step's first fused update, the dual state is the record's (setup, warm start); then duals[di], which the
  // first visit writes and the second reads.
  let di = ci - p.cur * halfSize();
  if (cp.fuse == 2u || (cp.fuse == 1u && !first)) { du = duals[di]; }`
    : '  // The record holds the dual state (the solve kernel binds contacts read_write).';
  const store = fusion === 'side' ? '    duals[di] = du;' : '    contacts[ci].lt = du.lt; contacts[ci].lambdaN = du.lambdaN; contacts[ci].kN = du.kN; contacts[ci].kT = du.kT;';
  return deferredDual(withFirst, load, store);
}

/**
 * A point's force with the fused dual, from CONTACT_FORCE's text up to and
 * including its C (`force`, with first in scope): du takes the point's dual
 * state from ct, and `load` may take it from where the step's fused updates
 * keep it; at the first visit the update the last sweep deferred runs on du
 * (dualPoint()'s arithmetic) and `store` keeps it; the clamped forces read du.
 */
function deferredDual(force: string, load: string, store: string): string {
  const [head, clamped] = force.split('\n  // Clamped forces:');
  return `${head}
  var du = ContactDual(ct.lt, ct.lambdaN, ct.kN, ct.kT);
${load}
  if (cp.fuse != 0u && first) {
    // The last sweep's dual update, deferred to here (dualPoint()).
    let dbound = ct.mu * abs(du.lambdaN);
    du.lambdaN = min(0.0, du.kN * C.x + du.lambdaN);
    if (du.lambdaN < 0.0) { du.kN = min(du.kN + p.beta * abs(C.x), p.penaltyMax); }
    let dz = du.kT * C.yz + du.lt;
    let dfl = length(dz);
    if (dfl < dbound) {
      du.lt = dz;
      du.kT = min(du.kT + p.beta * length(C.yz), p.penaltyMax);
    } else {
      du.lt = select(vec2f(0.0), dz * (dbound / dfl), dfl > 0.0);
    }
${store}
  }
  // Clamped forces:${clamped!.replace(/ct\.(kN|lambdaN|kT|lt)\b/g, 'du.$1')}`;
}

// accumulate() and solveBody() in the array form.
const ARRAY_SOLVE = /* wgsl */ `
// Add one contact's force and stiffness to body i's system.
fn accumulate(ct: SolverContact, i: u32) {
${CONTACT_FORCE}
  let K = array<f32, 9>(ct.kN, 0.0, 0.0, 0.0, kt, 0.0, 0.0, 0.0, kt);
  let J = array<array<f32, 6>, 3>(jrow(ct, 0u, onB), jrow(ct, 1u, onB), jrow(ct, 2u, onB));
  for (var r = 0u; r < 3u; r++) {
    for (var u = 0u; u < 6u; u++) { rhs[u] += J[r][u] * F[r]; }
    for (var q = 0u; q < 3u; q++) {
      let k = K[3u * r + q];
      if (k == 0.0) { continue; }
      for (var u = 0u; u < 6u; u++) {
        let ju = k * J[r][u];
        for (var v = 0u; v < 6u; v++) { lhs[6u * u + v] += ju * J[q][v]; }
      }
    }
  }
}

// One primal update of body i: its 6x6 system from inertia and contacts, solved and applied.
fn solveBody(i: u32) {
  let me = solver[i];
  let pr = props[i];
  let h2 = p.dt * p.dt;
  for (var k = 0u; k < 36u; k++) { lhs[k] = 0.0; }
  let mh = pr.mass / h2;
  let ax = array<vec3f, 3>(qrot(me.q0, vec3f(1.0, 0.0, 0.0)), qrot(me.q0, vec3f(0.0, 1.0, 0.0)), qrot(me.q0, vec3f(0.0, 0.0, 1.0)));
  let dphi = me.phi - me.tphi;
  for (var r = 0u; r < 3u; r++) {
    lhs[7u * r] = mh;
    rhs[r] = mh * (me.dp[r] - me.tp[r]);
    var s = 0.0;
    for (var c = 0u; c < 3u; c++) {
      let Irc = pr.inertia.x * ax[0][r] * ax[0][c] + pr.inertia.y * ax[1][r] * ax[1][c] + pr.inertia.z * ax[2][r] * ax[2][c];
      lhs[6u * (3u + r) + 3u + c] = Irc / h2;
      s += Irc * dphi[c];
    }
    rhs[3u + r] = s / h2;
  }
  let rs = rowStart[i];
  let rl = rowLength[i];
  for (var e = rs; e < rs + rl; e++) {
    let slot = adjSlot[e];
    for (var q = 0u; q < 4u; q++) {
      let ct = contacts[pairPoint(p.cur, slot, q)];
      if (ct.used == 0u) { break; }
      accumulate(ct, i);
    }
  }
  for (var q = 0u; q < 4u; q++) {
    let ct = contacts[groundPoint(p.cur, i, q)];
    if (ct.used == 0u) { break; }
    accumulate(ct, i);
  }
  // Solve the 6x6 SPD system with LDL^T and step.
  var L: array<f32, 36>;
  var D: array<f32, 6>;
  var x: array<f32, 6>;
  for (var j = 0u; j < 6u; j++) {
    var d = lhs[7u * j];
    for (var k = 0u; k < j; k++) { d -= L[6u * j + k] * L[6u * j + k] * D[k]; }
    D[j] = d;
    for (var r = j + 1u; r < 6u; r++) {
      var s = lhs[6u * r + j];
      for (var k = 0u; k < j; k++) { s -= L[6u * r + k] * L[6u * j + k] * D[k]; }
      L[6u * r + j] = s / d;
    }
  }
  for (var r = 0u; r < 6u; r++) {
    var s = rhs[r];
    for (var k = 0u; k < r; k++) { s -= L[6u * r + k] * x[k]; }
    x[r] = s;
  }
  for (var r = 0u; r < 6u; r++) { x[r] = x[r] / D[r]; }
  for (var rr = 0u; rr < 6u; rr++) {
    let r = 5u - rr;
    var s = x[r];
    for (var k = r + 1u; k < 6u; k++) { s -= L[6u * k + r] * x[k]; }
    x[r] = s;
  }
  solver[i].dp = me.dp - vec3f(x[0], x[1], x[2]);
  solver[i].phi = me.phi - vec3f(x[3], x[4], x[5]);
}
`;

/** ARRAY_SOLVE with the fused dual: accumulate() also takes the contact's index. */
function arraySolve(fusion: Fusion): string {
  if (fusion === 'off') return ARRAY_SOLVE;
  let a = swap(ARRAY_SOLVE, CONTACT_FORCE, contactForce(fusion));
  a = swap(a, 'fn accumulate(ct: SolverContact, i: u32)', 'fn accumulate(ct: SolverContact, ci: u32, i: u32)');
  a = swap(a, 'let K = array<f32, 9>(ct.kN,', 'let K = array<f32, 9>(du.kN,');
  a = swap(a, 'let ct = contacts[pairPoint(p.cur, slot, q)];', 'let ci = pairPoint(p.cur, slot, q);\n      let ct = contacts[ci];');
  a = swap(a, 'let ct = contacts[groundPoint(p.cur, i, q)];', 'let ci = groundPoint(p.cur, i, q);\n    let ct = contacts[ci];');
  return swap(a, 'accumulate(ct, i);', 'accumulate(ct, ci, i);', 2);
}

// The entry points, the same in both forms.
const SOLVE_TAIL = /* wgsl */ `
// Colour cp.color, one thread per body, dispatched with enough groups for every body.
@compute @workgroup_size(${WG})
fn primal(@builtin(global_invocation_id) id: vec3u) {
  let start = colorStart[cp.color];
  if (id.x >= colorStart[cp.color + 1u] - start) { return; }
  solveBody(order[start + id.x]);
}

// The tail workgroup's size (SolverDispatch.tailThreads).
override tailThreads: u32 = ${MAX_TAIL}u;

// Colour c by the first "threads" threads of the tail workgroup, in strides.
fn solveColour(c: u32, threads: u32, lid: u32) {
  if (lid < threads) {
    let end = colorStart[c + 1u];
    for (var k = colorStart[c] + lid; k < end; k += threads) { solveBody(order[k]); }
  }
}

// Colours cp.color .. ${MAX_COLORS - 1}, in order, by one workgroup: a small colour
// then costs a barrier instead of a dispatch. The loop stops after the last
// colour below ${MAX_COLORS - 1} that has bodies, so empty colours cost nothing (on
// SwiftShader, looping over all of them made the GPU tests 3-10x slower). colorStart
// is read-only here, so every thread finds that colour itself, and the loop
// bound is uniform without a barrier. The last colour takes the bodies the
// colouring could not colour (uncoloured, or out of colours), which may touch
// each other, so one thread solves those, in order.
@compute @workgroup_size(tailThreads)
fn primalTail(@builtin(local_invocation_index) lid: u32) {
  var end = cp.color;
  for (var c = cp.color; c < ${MAX_COLORS - 1}u; c++) { if (colorStart[c + 1u] > colorStart[c]) { end = c + 1u; } }
  for (var c = cp.color; c < end; c++) {
    solveColour(c, tailThreads, lid);
    storageBarrier();
  }
  solveColour(${MAX_COLORS - 1}u, 1u, lid);
}`;

/**
 * solveBody() in the 'registers' form: the array form's solveBody() and
 * accumulate() with lhs, rhs, L, D and x in named scalars and every loop
 * unrolled, doing the same floating-point operations in the same order, so
 * the two agree bit for bit wherever the compiler does not reassociate or
 * contract one differently from the other. In detail:
 * - Only the lower triangle of lhs is kept, hRC for row R >= column C: the
 *   LDL^T reads nothing else. Entry (R, C) accumulates what lhs[6R + C]
 *   does, (k J[r][R]) J[r][C]; the upper entry would round k J[r][C] instead.
 * - K is diagonal (kN, kt, kt), so the array form's rows q != r are always
 *   skipped; row r is skipped when its k is 0, as there (adding (0 a) b
 *   instead can turn a -0 entry into +0, or 0 into NaN).
 * - The gradient adds row 0, then 1, then 2, one addition per row.
 * - The inertia seeds are the array form's lhs[7r] = mh and the rotational
 *   block's I[r][c] / h2 with I[r][c] evaluated row first, as there.
 * - The contacts are read in the same order (the body's pair slots, then
 *   its ground slot), in one loop, so the update below is inlined once.
 */
function registerSolveBody(fusion: Fusion = 'off', records: RecordMode = 0): string {
  const xyz = (k: number) => 'xyz'[k]!;
  const upTo = (n: number) => Array.from({ length: n }, (_, k) => k);
  const lower: Array<[number, number]> = upTo(6).flatMap((r) => upTo(r + 1).map((c): [number, number] => [r, c]));
  // I[r][c] as the array form's Irc: sum over k of I_k ax_k[r] ax_k[c], left to right.
  const inertia = upTo(3).flatMap((r) => upTo(3).map((c) =>
    `  let i${r}${c} = ${upTo(3).map((k) => `pr.inertia.${xyz(k)} * ax${k}.${xyz(r)} * ax${k}.${xyz(c)}`).join(' + ')};`));
  const seed = (r: number, c: number) => (r === c && r < 3 ? 'mh' : r >= 3 && c >= 3 ? `i${r - 3}${c - 3} / h2` : '0.0');
  const hessian = upTo(6).map((r) => `  ${lower.filter(([a]) => a === r).map(([a, c]) => `var h${a}${c} = ${seed(a, c)};`).join(' ')}`);
  const gradient = [
    ...upTo(3).map((r) => `  var g${r} = mh * (me.dp.${xyz(r)} - me.tp.${xyz(r)});`),
    ...upTo(3).map((r) => `  var g${3 + r} = 0.0;${upTo(3).map((c) => ` g${3 + r} += i${r}${c} * dphi.${xyz(c)};`).join('')} g${3 + r} = g${3 + r} / h2;`),
  ];
  const ind = '      ';
  const update: string[] = [];
  for (let r = 0; r < 3; r++) update.push(`${ind}let J${r} = jrow(ct, ${r}u, onB);`);
  for (let r = 0; r < 3; r++) update.push(`${ind}${upTo(6).map((u) => `g${u} += J${r}[${u}] * F[${r}];`).join(' ')}`);
  for (let r = 0; r < 3; r++) {
    const k = r === 0 ? (fusion === 'off' ? 'ct.kN' : 'du.kN') : 'kt';
    update.push(`${ind}if (${k} != 0.0) {`);
    update.push(`${ind}  ${upTo(6).map((u) => `let k${u} = ${k} * J${r}[${u}];`).join(' ')}`);
    for (let a = 0; a < 6; a++) update.push(`${ind}  ${upTo(a + 1).map((c) => `h${a}${c} += k${a} * J${r}[${c}];`).join(' ')}`);
    update.push(`${ind}}`);
  }
  const ldl: string[] = [];
  for (let j = 0; j < 6; j++) {
    ldl.push(`  let d${j} = h${j}${j}${upTo(j).map((k) => ` - l${j}${k} * l${j}${k} * d${k}`).join('')};`);
    for (let r = j + 1; r < 6; r++) {
      const s = `h${r}${j}${upTo(j).map((k) => ` - l${r}${k} * l${j}${k} * d${k}`).join('')}`;
      ldl.push(`  let l${r}${j} = ${j ? `(${s})` : s} / d${j};`);
    }
  }
  for (let r = 0; r < 6; r++) ldl.push(`  let z${r} = g${r}${upTo(r).map((k) => ` - l${r}${k} * z${k}`).join('')};`);
  for (let r = 0; r < 6; r++) ldl.push(`  let y${r} = z${r} / d${r};`);
  for (let r = 5; r >= 0; r--) ldl.push(`  let x${r} = y${r}${upTo(5 - r).map((m) => ` - l${r + 1 + m}${r} * x${r + 1 + m}`).join('')};`);
  const pointLoop = `  // Pair slots first, then the ground slot (e == re).
  let rs = rowStart[i];
  let re = rs + rowLength[i];
  for (var e = rs; e <= re; e++) {
    var base = groundPoint(p.cur, i, 0u);
    if (e < re) { base = pairPoint(p.cur, adjSlot[e], 0u); }
    for (var q = 0u; q < 4u; q++) {
${fusion === 'off' ? '' : '      let ci = base + q;\n'}      let ct = contacts[${fusion === 'off' ? 'base + q' : 'ci'}];
      if (ct.used == 0u) { break; }
      // (The body's own state is read again here, as accumulate() does.)
${contactForce(fusion).replace(/^/gm, '    ')}
${update.join('\n')}
    }
  }`;
  const loop = records === 0 ? pointLoop : records === 1 ? exactRecordLoop(update, fusion) : centreRecordLoop(fusion);
  return /* wgsl */ `
// One primal update of body i, 'registers' form: the array form's solveBody()
// and accumulate() in named scalars (registerSolveBody() in solver.ts).
fn solveBody(i: u32) {
  let me = solver[i];
  let pr = props[i];
  let h2 = p.dt * p.dt;
  let mh = pr.mass / h2;
  let ax0 = qrot(me.q0, vec3f(1.0, 0.0, 0.0));
  let ax1 = qrot(me.q0, vec3f(0.0, 1.0, 0.0));
  let ax2 = qrot(me.q0, vec3f(0.0, 0.0, 1.0));
  let dphi = me.phi - me.tphi;
${inertia.join('\n')}
  // The system's lower triangle, hRC = lhs[6R + C], and its right-hand side.
${hessian.join('\n')}
${gradient.join('\n')}
${loop}
  // LDL^T, forward substitution, D^-1, back substitution.
${ldl.join('\n')}
  solver[i].dp = me.dp - vec3f(x0, x1, x2);
  solver[i].phi = me.phi - vec3f(x3, x4, x5);
}
`;
}

/** The two forms of the primal's 6x6 solve (SolverDispatch.hessian). */
export const HESSIAN_FORMS = ['registers', 'array'] as const;
export type HessianForm = (typeof HESSIAN_FORMS)[number];

/** Colour starts in the uniform that replaces the colorStart storage binding when the fused dual keeps a side array. */
const COLOR_STARTS = Math.ceil((MAX_COLORS + 1) / 4);

/**
 * SOLVE_HEAD and SOLVE_TAIL for the fused dual and the contacts binding
 * (SolverDispatch.dualFusion, solveContactsRW). 'side' adds the duals
 * binding; the kernel already binds the default limit of 8 storage buffers,
 * so colorStart becomes a uniform copy (solve() copies it each step). The
 * fused kernels also get visitOrder(), which writes SolverBody.visit. `dual`
 * is the dual state's struct: ContactDual per point (also records = 1), or
 * CentreDual per record (records = 2).
 */
function solveHead(fusion: Fusion, rw: boolean, dual: StructLayout = ContactDual): string {
  let h = rw ? swap(SOLVE_HEAD, 'var<storage, read> contacts', 'var<storage, read_write> contacts') : SOLVE_HEAD;
  if (fusion === 'off') return h;
  h = swap(h, `${wgslStruct(ColorParams)}\n`, `${wgslStruct(ColorParams)}\n${wgslStruct(dual)}\n`);
  if (fusion === 'record') return h;
  h = swap(h, '@group(0) @binding(4) var<storage, read> colorStart: array<u32>;', `// colorStart (u32 x ${MAX_COLORS + 1}) as a uniform: a ninth storage binding would pass the default limit.
@group(0) @binding(4) var<uniform> colorStarts: array<vec4u, ${COLOR_STARTS}>;
fn colorStartAt(c: u32) -> u32 { return colorStarts[c / 4u][c % 4u]; }`);
  return `${h}// Each ${dual === ContactDual ? 'contact point' : 'record'}'s dual state while the fused dual updates it, indexed within this step's half.
@group(0) @binding(10) var<storage, read_write> duals: array<${dual.name}>;
`;
}
function solveTail(fusion: Fusion): string {
  if (fusion === 'off') return SOLVE_TAIL;
  const t = fusion === 'side' ? SOLVE_TAIL.replace(/colorStart\[([^\]]*)\]/g, 'colorStartAt($1)') : SOLVE_TAIL;
  return `${t}

// Each body's position in this step's colour order (SolverBody.visit), which
// tells the fused dual which visit of a contact comes first. Colour 63's bodies
// are solved in this order too, one after another.
@compute @workgroup_size(${WG})
fn visitOrder(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.n) { return; }
  solver[order[id.x]].visit = id.x;
}`;
}

/**
 * The primal shader (entry points primal and primalTail, and visitOrder with
 * the fused dual) with the system in the given form. With dualFusion and
 * solveContactsRW absent or false it is the shader without either.
 */
export function solveWgsl(hessian: HessianForm, d: Pick<SolverDispatch, 'dualFusion' | 'solveContactsRW'> = {}): string {
  if (!HESSIAN_FORMS.includes(hessian)) throw new Error(`solveWgsl: hessian must be one of ${HESSIAN_FORMS.join(', ')}, got ${hessian}`);
  const fusion = fusionOf(d), head = solveHead(fusion, !!d.solveContactsRW), tail = solveTail(fusion);
  return hessian === 'array' ? head + ARRAY_STORAGE + JROW + arraySolve(fusion) + tail : head + JROW + registerSolveBody(fusion) + tail;
}

// Dual update (forces and penalties) and the end-of-step body updates.
const DUAL = /* wgsl */ `
${COMMON}
${EVAL}
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read_write> solver: array<SolverBody>;
@group(0) @binding(2) var<storage, read_write> contacts: array<SolverContact>;
@group(0) @binding(3) var<storage, read> stepInfo: array<u32, 16>;
@group(0) @binding(4) var<uniform> p: SolverParams;

fn dualPoint(idx: u32) {
  var ct = contacts[idx];
  if (ct.used == 0u) { return; }
  let B = solver[ct.b];
  var dpA = vec3f(0.0); var phiA = vec3f(0.0);
  if (ct.a != NONE) { let A = solver[ct.a]; dpA = A.dp; phiA = A.phi; }
  let C = evalC(ct, 1.0, dpA, phiA, B.dp, B.phi);
  let bound = ct.mu * abs(ct.lambdaN);
  ct.lambdaN = min(0.0, ct.kN * C.x + ct.lambdaN);
  if (ct.lambdaN < 0.0) { ct.kN = min(ct.kN + p.beta * abs(C.x), p.penaltyMax); }
  let z = ct.kT * C.yz + ct.lt;
  let fl = length(z);
  // Static friction held if the trial force is inside the cone; the last main iteration's answer stands.
  ct.inCone = select(0u, 1u, fl < bound);
  if (fl < bound) {
    ct.lt = z;
    ct.kT = min(ct.kT + p.beta * length(C.yz), p.penaltyMax);
  } else {
    ct.lt = select(vec2f(0.0), z * (bound / fl), fl > 0.0);
  }
  contacts[idx] = ct;
}

@compute @workgroup_size(${WG})
fn dualPairs(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  for (var q = 0u; q < 4u; q++) { dualPoint(pairPoint(p.cur, k, q)); }
}

@compute @workgroup_size(${WG})
fn dualGround(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  for (var q = 0u; q < 4u; q++) { dualPoint(groundPoint(p.cur, i, q)); }
}

// Velocities from the last main iteration (BDF1).
@compute @workgroup_size(${WG})
fn velocities(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let s = solver[i];
  solver[i].prevVel = bodies[i].linVel;
  bodies[i].linVel = s.dp / p.dt;
  bodies[i].angVel = s.phi / p.dt;
}

@compute @workgroup_size(${WG})
fn finalize(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let s = solver[i];
  bodies[i].pos = s.x0 + s.dp;
  bodies[i].rot = applyRotation(s.q0, s.phi);
}`;

/**
 * DUAL with the fused dual's side array (SolverDispatch.dualFusion without
 * solveContactsRW): dualPairsSide and dualGroundSide run the step's last
 * dual update from the state the sweeps left in duals, and write it to the
 * records, where the stabilization sweep and the next step's setup read it.
 */
function dualWgsl(fusion: Fusion): string {
  if (fusion !== 'side') return DUAL;
  let d = swap(DUAL, `${EVAL}\n`, `${EVAL}\n${wgslStruct(ContactDual)}\n`);
  d = swap(d, '@group(0) @binding(4) var<uniform> p: SolverParams;', `@group(0) @binding(4) var<uniform> p: SolverParams;
// The fused dual's state (ContactDual) per contact point of this step's half.
@group(0) @binding(5) var<storage, read> duals: array<ContactDual>;`);
  d = swap(d, `fn dualPoint(idx: u32) {
  var ct = contacts[idx];
  if (ct.used == 0u) { return; }`, `fn dualPoint(idx: u32, fromSide: bool) {
  var ct = contacts[idx];
  if (ct.used == 0u) { return; }
  if (fromSide) {
    let du = duals[idx - p.cur * halfSize()];
    ct.lt = du.lt; ct.lambdaN = du.lambdaN; ct.kN = du.kN; ct.kT = du.kT;
  }`);
  d = swap(d, 'dualPoint(pairPoint(p.cur, k, q));', 'dualPoint(pairPoint(p.cur, k, q), false);');
  d = swap(d, 'dualPoint(groundPoint(p.cur, i, q));', 'dualPoint(groundPoint(p.cur, i, q), false);');
  return swap(d, '\n// Velocities from the last main iteration (BDF1).', `
@compute @workgroup_size(${WG})
fn dualPairsSide(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  for (var q = 0u; q < 4u; q++) { dualPoint(pairPoint(p.cur, k, q), true); }
}

@compute @workgroup_size(${WG})
fn dualGroundSide(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  for (var q = 0u; q < 4u; q++) { dualPoint(groundPoint(p.cur, i, q), true); }
}

// Velocities from the last main iteration (BDF1).`);
}

// Manifold records (AvbdParams.records; perf-competition round 2). The
// contact buffer then holds one record per pair slot and ground slot instead
// of their 4 SolverContact points (packages/schema: SolverRecord,
// CentreRecord), so a body's walk loads its partner's state once per touching
// pair and reads the pair's points from the record's hot block instead of from
// 4 separate structs. Records are 384 B, so the hot block (256 B or 232 B) is
// two 128 B lines in every slot; the primal and the dual read nothing else.
// - 1, the exact record: each point keeps every SolverContact field. Setup,
//   primal and dual do the point form's floating-point operations in the same
//   order (t1 is recomputed from n as tangent1(n), which is how setup made
//   it), so on SwiftShader the state is bit-identical to points; a compiler
//   that contracts tangent1() differently in two kernels (Metal compiles with
//   relaxed math) could round it differently in the last bit.
// - 2, the centre-friction record: the reference's FrictionRecord
//   (AvbdParams.records says what it does): normal rows per point, one
//   friction state of three rows at the centre.
// Both run in the register form of the primal only. With the fused dual
// (SolverDispatch.dualFusion) a record's first visit runs its deferred update
// as a point's does: records 1 per point (a ContactDual per point in the side
// array), records 2 for the whole record (a CentreDual).

/** AvbdParams.records (physics-ref RECORD_MODES) on the GPU: 0 points (SolverContact), 1 the exact record (SolverRecord), 2 centre friction (CentreRecord). */
export { RECORD_MODES };
export type RecordMode = (typeof RECORD_MODES)[number];

const seq = (n: number) => Array.from({ length: n }, (_, k) => k);

const RECORD_COMMON = /* wgsl */ `
// Record half size: one record per pair slot, then one per body (ground).
fn recordHalf() -> u32 { return p.maxPairs + p.capacity; }
fn pairRecord(half: u32, slot: u32) -> u32 { return half * recordHalf() + slot; }
fn groundRecord(half: u32, body: u32) -> u32 { return half * recordHalf() + p.maxPairs + body; }
// Point q's lever arms on a and b.
fn recRaw(r: u32, q: u32) -> vec3f { return vec3f(records[r].rawX[q], records[r].rawY[q], records[r].rawZ[q]); }
fn recRbw(r: u32, q: u32) -> vec3f { return vec3f(records[r].rbwX[q], records[r].rbwY[q], records[r].rbwZ[q]); }
// Point q's loaded-gap mark (SolverContact.used's LOADED_GAP): bit LOADED_BIT + q of SolverRecord.flags or
// CentreRecord.stick, free bits of a word the walk's line holds anyway, so the records keep their size and hot block.
const LOADED_BIT = 8u;
// Whether point q of a record whose flags (records 1) or stick (records 2) word is w is marked. Callers read w
// behind gapSlop > 0.0, so off it is never loaded.
fn recLoaded(w: u32, q: u32) -> bool { return ((w >> (LOADED_BIT + q)) & 1u) != 0u; }
`;

// records = 2: a point's normal row at the current displacements (the x of
// evalC, a loaded point's gapSlop included), the centre's friction rows T1, T2 and twist (the twist row starts at
// 0), and row r of those for body b: (u, rbc x u), the twist (0, rt n); for
// body a, minus that with rac.
const CENTRE_EVAL = /* wgsl */ `
fn evalN(n: vec3f, c0n: f32, loaded: bool, raw: vec3f, rbw: vec3f, hasA: bool, alpha: f32, dpA: vec3f, phiA: vec3f, dpB: vec3f, phiB: vec3f) -> f32 {
  var c = select(c0n, (1.0 - alpha) * c0n, c0n < 0.0);
  // A loaded point's excused gap, as evalC()'s (the reference's evalC0).
  if (gapSlop > 0.0 && alpha == 1.0 && loaded) { c = c0n - min(c0n, gapSlop); }
  c += dot(n, dpB) + dot(cross(rbw, n), phiB);
  if (hasA) { c -= dot(n, dpA) + dot(cross(raw, n), phiA); }
  return c;
}
fn evalT(n: vec3f, t1: vec3f, t2: vec3f, c0t: vec2f, rac: vec3f, rbc: vec3f, rt: f32, hasA: bool, alpha: f32, dpA: vec3f, phiA: vec3f, dpB: vec3f, phiB: vec3f) -> vec3f {
  var c = vec3f((1.0 - alpha) * c0t, 0.0);
  c += vec3f(dot(t1, dpB) + dot(cross(rbc, t1), phiB), dot(t2, dpB) + dot(cross(rbc, t2), phiB), rt * dot(n, phiB));
  if (hasA) { c -= vec3f(dot(t1, dpA) + dot(cross(rac, t1), phiA), dot(t2, dpA) + dot(cross(rac, t2), phiA), rt * dot(n, phiA)); }
  return c;
}
fn frow(n: vec3f, t1: vec3f, t2: vec3f, rac: vec3f, rbc: vec3f, rt: f32, r: u32, onB: bool) -> array<f32, 6> {
  if (r == 2u) {
    let w = select(-rt * n, rt * n, onB);
    return array<f32, 6>(0.0, 0.0, 0.0, w.x, w.y, w.z);
  }
  var u = t1;
  if (r == 1u) { u = t2; }
  var w = cross(rbc, u);
  if (!onB) { w = -cross(rac, u); u = -u; }
  return array<f32, 6>(u.x, u.y, u.z, w.x, w.y, w.z);
}
`;

/**
 * Point q of records = 1 record `rec` into the SolverContact ct (declared by the caller), with n, t1, mu, ia, ib
 * read once per record; a point setup marked gets LOADED_GAP, so evalC() excuses its gap as the point form's.
 */
const exactPoint = (rec: string, ind: string) => [
  `ct.n = n; ct.t1 = t1; ct.mu = mu; ct.a = ia; ct.b = ib; ct.used = 1u;`,
  `if (gapSlop > 0.0 && recLoaded(records[${rec}].flags, q)) { ct.used = 1u | LOADED_GAP; }`,
  `ct.raw = recRaw(${rec}, q);`,
  `ct.rbw = recRbw(${rec}, q);`,
  `ct.c0 = vec3f(records[${rec}].c0N[q], records[${rec}].c0T1[q], records[${rec}].c0T2[q]);`,
  `ct.kN = records[${rec}].kN[q]; ct.lambdaN = records[${rec}].lambdaN[q]; ct.kT = records[${rec}].kT[q];`,
  `ct.lt = vec2f(records[${rec}].lt1[q], records[${rec}].lt2[q]);`,
].map((l) => ind + l).join('\n');

// The primal's walk over body i's records starts the same in both modes: the
// record, then its partner's state once (the point form reads it per point).
const RECORD_WALK = /* wgsl */ `  // Pair records first, then the ground record (e == re).
  let rs = rowStart[i];
  let re = rs + rowLength[i];
  for (var e = rs; e <= re; e++) {
    var slot = groundRecord(p.cur, i);
    if (e < re) { slot = pairRecord(p.cur, adjSlot[e]); }
    let count = records[slot].count;
    if (count == 0u) { continue; }
    let ia = records[slot].a;
    let ib = records[slot].b;
    let onB = ib == i;
    var dpA = vec3f(0.0); var phiA = vec3f(0.0); var dpB = vec3f(0.0); var phiB = vec3f(0.0);
    if (onB) {
      dpB = me.dp; phiB = me.phi;
      if (ia != NONE) { let o = solver[ia]; dpA = o.dp; phiA = o.phi; }
    } else {
      dpA = me.dp; phiA = me.phi;
      let o = solver[ib]; dpB = o.dp; phiB = o.phi;
    }
    let n = records[slot].n;`;

/** RECORD_WALK with the fused dual: also whether this is the record's first visit this sweep (contactForce()'s first). */
function recordWalk(fusion: Fusion): string {
  if (fusion === 'off') return RECORD_WALK;
  const visit = swap(swap(RECORD_WALK,
    '      if (ia != NONE) { let o = solver[ia]; dpA = o.dp; phiA = o.phi; }',
    '      if (ia != NONE) { let o = solver[ia]; dpA = o.dp; phiA = o.phi; first = me.visit < o.visit; }'),
    '      let o = solver[ib]; dpB = o.dp; phiB = o.phi;',
    '      let o = solver[ib]; dpB = o.dp; phiB = o.phi; first = me.visit < o.visit;');
  return swap(visit, '\n    if (onB) {', '\n    // The record\'s first visit this sweep: the other body comes later in the colour order, or is the ground.\n    var first = true;\n    if (onB) {');
}

/** registerSolveBody()'s update for one row J (6 values) with force f and stiffness k: g += J f, and h += k J J^T unless k is 0. */
function rowUpdate(J: string, f: string, k: string, ind: string): string[] {
  return [
    `${ind}${seq(6).map((u) => `g${u} += ${J}[${u}] * ${f};`).join(' ')}`,
    `${ind}if (${k} != 0.0) {`,
    `${ind}  ${seq(6).map((u) => `let k${u} = ${k} * ${J}[${u}];`).join(' ')}`,
    ...seq(6).map((a) => `${ind}  ${seq(a + 1).map((c) => `h${a}${c} += k${a} * ${J}[${c}];`).join(' ')}`),
    `${ind}}`,
  ];
}

/**
 * records = 1: each point as a SolverContact in registers, then the point
 * form's force (CONTACT_FORCE after the partner) and update; with the fused
 * dual, the point form's deferred update too (deferredDual()), its state in a
 * ContactDual per point (side array) or in the record's lanes (in place).
 */
function exactRecordLoop(update: string[], fusion: Fusion = 'off'): string {
  const C = CONTACT_FORCE.slice(CONTACT_FORCE.indexOf('  let C = evalC('));
  const force = fusion === 'off' ? C : deferredDual(C, fusion === 'side'
    ? `  // Until the step's first fused update, the dual state is the record's; then duals[di], a ContactDual per point.
  let di = (slot - p.cur * recordHalf()) * 4u + q;
  if (cp.fuse == 2u || (cp.fuse == 1u && !first)) { du = duals[di]; }`
    : '  // The record holds the dual state (the solve kernel binds the records read_write).',
  fusion === 'side' ? '    duals[di] = du;'
    : '    records[slot].kN[q] = du.kN; records[slot].lambdaN[q] = du.lambdaN; records[slot].kT[q] = du.kT; records[slot].lt1[q] = du.lt.x; records[slot].lt2[q] = du.lt.y;');
  return `${recordWalk(fusion)}
    let t1 = tangent1(n);
    let mu = records[slot].mu;
    for (var q = 0u; q < count; q++) {
      var ct: SolverContact;
${exactPoint('slot', '      ')}
${force.replace(/^/gm, '    ')}
${update.join('\n')}
    }
  }`;
}

/**
 * records = 2: the points' normal rows, then the centre's three friction rows
 * clamped together. With the fused dual the record's first visit runs the
 * update the last sweep deferred (CENTRE_DUAL's arithmetic on the C's the
 * forces use): each point's normal row in their loop, then the friction
 * against the ball of the points' forces before it.
 */
function centreRecordLoop(fusion: Fusion = 'off'): string {
  const friction = seq(3).flatMap((r) => [`    let T${r} = frow(n, t1, t2, rac, rbc, rt, ${r}u, onB);`, ...rowUpdate(`T${r}`, `FT[${r}]`, 'kt', '    ')]);
  const loop = `${RECORD_WALK}
    // The points' normal rows (row 0 of jrow() on a SolverContact holding n and the lever arms).
    var ct: SolverContact;
    ct.n = n;
    var sumN = 0.0;
    for (var q = 0u; q < count; q++) {
      ct.raw = recRaw(slot, q);
      ct.rbw = recRbw(slot, q);
      let kN = records[slot].kN[q];
      let lambdaN = records[slot].lambdaN[q];
      sumN += lambdaN;
      let fN = min(0.0, kN * evalN(n, records[slot].c0N[q], gapSlop > 0.0 && recLoaded(records[slot].stick, q), ct.raw, ct.rbw, ia != NONE, cp.alpha, dpA, phiA, dpB, phiB) + lambdaN);
      let J0 = jrow(ct, 0u, onB);
${rowUpdate('J0', 'fN', 'kN', '      ').join('\n')}
    }
    // The friction at the centre: rows T1, T2 and twist, clamped together to the ball mu |sum of lambda_n|, the
    // sliding Hessian as a point's (k_t s on all three rows).
    let t1 = tangent1(n);
    let t2 = cross(n, t1);
    let rac = records[slot].rac;
    let rbc = records[slot].rbc;
    let rt = records[slot].rt;
    let kT = records[slot].kT;
    let CT = evalT(n, t1, t2, records[slot].c0t, rac, rbc, rt, ia != NONE, cp.alpha, dpA, phiA, dpB, phiB);
    let bound = records[slot].mu * abs(sumN);
    let z = kT * CT + records[slot].lamT;
    let zl = length(z);
    var s = 1.0;
    if (zl > bound) { s = select(0.0, bound / zl, zl > 0.0); }
    let FT = array<f32, 3>(s * z.x, s * z.y, s * z.z);
    let kt = select(kT, kT * s, p.slidingHessian != 0u);
${friction.join('\n')}
  }`;
  if (fusion === 'off') return loop;
  const store = fusion === 'side' ? '      duals[di] = du;'
    : '      records[slot].kN = du.kN; records[slot].lambdaN = du.lambdaN; records[slot].lamT = du.lamT; records[slot].kT = du.kT;';
  let f = swap(loop, RECORD_WALK, recordWalk(fusion));
  f = swap(f, "\n    // The points' normal rows (row 0 of jrow()", `
    // The record's dual state: the record's until the step's first fused update${fusion === 'side' ? ', then duals[di]' : ''}.
    var du = CentreDual(records[slot].kN, records[slot].lambdaN, records[slot].lamT, records[slot].kT);${fusion === 'side' ? `
    let di = slot - p.cur * recordHalf();
    if (cp.fuse == 2u || (cp.fuse == 1u && !first)) { du = duals[di]; }` : ''}
    let deferred = cp.fuse != 0u && first;
    var sumOld = 0.0;
    // The points' normal rows (row 0 of jrow()`);
  f = swap(f, `      let kN = records[slot].kN[q];
      let lambdaN = records[slot].lambdaN[q];
      sumN += lambdaN;
      let fN = min(0.0, kN * evalN(n, records[slot].c0N[q], gapSlop > 0.0 && recLoaded(records[slot].stick, q), ct.raw, ct.rbw, ia != NONE, cp.alpha, dpA, phiA, dpB, phiB) + lambdaN);`,
  `      let cn = evalN(n, records[slot].c0N[q], gapSlop > 0.0 && recLoaded(records[slot].stick, q), ct.raw, ct.rbw, ia != NONE, cp.alpha, dpA, phiA, dpB, phiB);
      if (deferred) {
        // The point's deferred normal update (dualRecord()).
        sumOld += du.lambdaN[q];
        du.lambdaN[q] = min(0.0, du.kN[q] * cn + du.lambdaN[q]);
        if (du.lambdaN[q] < 0.0) { du.kN[q] = min(du.kN[q] + p.beta * abs(cn), p.penaltyMax); }
      }
      let kN = du.kN[q];
      let lambdaN = du.lambdaN[q];
      sumN += lambdaN;
      let fN = min(0.0, kN * cn + lambdaN);`);
  f = swap(f, `    let kT = records[slot].kT;
    let CT = evalT(n, t1, t2, records[slot].c0t, rac, rbc, rt, ia != NONE, cp.alpha, dpA, phiA, dpB, phiB);`,
  `    let CT = evalT(n, t1, t2, records[slot].c0t, rac, rbc, rt, ia != NONE, cp.alpha, dpA, phiA, dpB, phiB);
    if (deferred) {
      // The friction's deferred update (dualRecord()), against the ball of the points' forces before it.
      let dbound = records[slot].mu * abs(sumOld);
      let dz = du.kT * CT + du.lamT;
      let dzl = length(dz);
      let nc = f32(count);
      if (dzl < dbound) {
        du.lamT = dz;
        du.kT = min(du.kT + nc * p.beta * length(CT), nc * p.penaltyMax);
      } else {
        du.lamT = select(vec3f(0.0), dz * (dbound / dzl), dzl > 0.0);
      }
${store}
    }
    let kT = du.kT;`);
  return swap(f, '    let z = kT * CT + records[slot].lamT;', '    let z = kT * CT + du.lamT;');
}

// setup() on records: SETUP's bindings, helpers and entry points, with the
// contact buffer read as records and each manifold's points kept in one.
const SETUP_HEAD = SETUP.slice(0, SETUP.indexOf('// Fill the 4 points of manifold m'));
const SETUP_ENTRY = SETUP.slice(SETUP.indexOf('@compute @workgroup_size'));

// records = 1: setup() of the point form, the same operations per point, last
// step's point o read from record old (in use if o < its count) and this
// step's points written to record dst.
const EXACT_SETUP = /* wgsl */ `
fn setup(m: Manifold, a: u32, b: u32, mu: f32, dst: u32, old: u32, hasOld: bool) {
  var taken = array<bool, 4>(false, false, false, false);
  let n = m.normal;
  let t1 = tangent1(n);
  let t2 = cross(n, t1);
  let sphereA = a != NONE && props[a].sphere != 0u;
  let sphereB = props[b].sphere != 0u;
  let roll = p.rollingContacts != 0u && (sphereA || sphereB);
  var oldCount = 0u;
  if (hasOld) { oldCount = records[old].count; }
  let on = records[old].n;
  let ot1 = tangent1(on);
  let oflags = records[old].flags;
  // The load cap's reference (AvbdParams.loadCap): last step's largest |lambdaN| on a point of this pair.
  var pairLoad = 0.0;
  if (hasOld && p.loadCap > 0.0) {
    for (var o = 0u; o < 4u; o++) {
      if (o < oldCount) { pairLoad = max(pairLoad, abs(records[old].lambdaN[o])); }
    }
  }
  let onB = sphereB && (!sphereA || props[b].radius <= props[a].radius);
  var dpA = vec3f(0.0); var phiA = vec3f(0.0);
  if (roll && a != NONE) { dpA = solver[a].dp; phiA = solver[a].phi; }
  var dpB = vec3f(0.0); var phiB = vec3f(0.0);
  if (roll) { dpB = solver[b].dp; phiB = solver[b].phi; }
  var flags = 0u;
  for (var q = 0u; q < m.count; q++) {
    let pt = point(m, q);
    let wa = pt.xyz + n * (pt.w * 0.5);
    let wb = pt.xyz - n * (pt.w * 0.5);
    let B = bodies[b];
    var ra = wa;
    if (a != NONE) { ra = qrot(qconj(bodies[a].rot), wa - bodies[a].pos); }
    var rb = qrot(qconj(B.rot), wb - B.pos);
    var lambdaN = 0.0;
    var lt = vec2f(0.0);
    var kN = p.penaltyMin;
    var kT = p.penaltyMin;
    var stick = 0u;
    var slip = vec2f(0.0);
    var carry = false;
    if (hasOld) {
      var key = rb;
      if (roll) { if (onB) { key = wb - B.pos; } else { key = wa - bodies[a].pos; } }
      var best = 4u;
      var bestD = p.matchDistance;
      for (var o = 0u; o < 4u; o++) {
        if (o >= oldCount || taken[o]) { continue; }
        var ok = vec3f(records[old].rbX[o], records[old].rbY[o], records[old].rbZ[o]);
        if (roll) { ok = select(recRaw(old, o), recRbw(old, o), onB); }
        let d = length(ok - key);
        if (d < bestD) { best = o; bestD = d; }
      }
      if (best < 4u) {
        taken[best] = true;
        let o = best;
        let olambdaN = records[old].lambdaN[o];
        let f = records[old].lt1[o] * ot1 + records[old].lt2[o] * cross(on, ot1);
        lambdaN = olambdaN;
        lt = vec2f(dot(f, t1), dot(f, t2));
        kN = clamp(records[old].kN[o] * p.gamma, p.penaltyMin, p.penaltyMax);
        var u = vec3f(0.0);
        if (roll) { u = dpB + cross(phiB, recRbw(old, o)) - (dpA + cross(phiA, recRaw(old, o))); }
        if (p.restDepth > 0.0) {
          var kFloor = abs(olambdaN) / p.restDepth;
          if (roll && a != NONE && abs(dot(on, u)) >= p.restDepth) { kFloor = min(kFloor, sqrt(props[a].mass * props[b].mass) / (p.dt * p.dt)); }
          if (p.loadCap > 0.0) { kN = max(min(kN, max(p.loadCap * (pairLoad / p.restDepth), p.capFall * kN)), p.penaltyMin); }
          kN = min(max(kN, kFloor), p.penaltyMax);
        }
        kT = clamp(records[old].kT[o] * p.gamma, p.penaltyMin, p.penaltyMax);
        let inCone = (oflags >> (4u + o)) & 1u;
        if (inCone != 0u && roll) {
          let t2o = cross(on, ot1);
          let sv = (records[old].c0T1[o] + dot(ot1, u)) * ot1 + (records[old].c0T2[o] + dot(t2o, u)) * t2o;
          let st = vec2f(dot(sv, t1), dot(sv, t2));
          if (length(st) < p.stickThreshold) { stick = 1u; slip = st; carry = true; }
        } else if (inCone != 0u) {
          let ora = vec3f(records[old].raX[o], records[old].raY[o], records[old].raZ[o]);
          let orb = vec3f(records[old].rbX[o], records[old].rbY[o], records[old].rbZ[o]);
          var opa = ora;
          if (a != NONE) { opa = bodies[a].pos + qrot(bodies[a].rot, ora); }
          let od = B.pos + qrot(B.rot, orb) - opa;
          if (length(vec2f(dot(od, t1), dot(od, t2))) < p.stickThreshold) { stick = 1u; ra = ora; rb = orb; }
        }
      }
    }
    var raw = vec3f(0.0);
    var pa = ra;
    if (a != NONE) { raw = qrot(bodies[a].rot, ra); pa = bodies[a].pos + raw; }
    let rbw = qrot(B.rot, rb);
    let d = B.pos + rbw - pa;
    var c0 = vec3f(dot(d, n) + p.slop, dot(d, t1), dot(d, t2));
    if (carry) { c0 = vec3f(c0.x, c0.y + slip.x, c0.z + slip.y); }
    // Loaded-gap slop: the point form's mark (LOADED_GAP), on the warm-started lambdaN, kept in flags.
    if (gapSlop > 0.0 && !roll && lambdaN < 0.0 && c0.x > 0.0) { flags |= 1u << (LOADED_BIT + q); }
    records[dst].rawX[q] = raw.x; records[dst].rawY[q] = raw.y; records[dst].rawZ[q] = raw.z;
    records[dst].rbwX[q] = rbw.x; records[dst].rbwY[q] = rbw.y; records[dst].rbwZ[q] = rbw.z;
    records[dst].c0N[q] = c0.x; records[dst].c0T1[q] = c0.y; records[dst].c0T2[q] = c0.z;
    records[dst].kN[q] = kN; records[dst].lambdaN[q] = lambdaN; records[dst].kT[q] = kT;
    records[dst].lt1[q] = lt.x; records[dst].lt2[q] = lt.y;
    records[dst].raX[q] = ra.x; records[dst].raY[q] = ra.y; records[dst].raZ[q] = ra.z;
    records[dst].rbX[q] = rb.x; records[dst].rbY[q] = rb.y; records[dst].rbZ[q] = rb.z;
    flags |= stick << q;
  }
  records[dst].n = n; records[dst].mu = mu; records[dst].a = a; records[dst].b = b;
  records[dst].count = m.count; records[dst].flags = flags;
}
`;

// records = 2: the reference's collide() for one manifold, then its
// frictionRecord(). The points take this step's narrowphase points and keep
// only their normal force and penalty, matched as the point form's (load floor
// and cap included; they never stick). The centre: the mean of the points'
// lever arms and anchors, rt their RMS distance from it in the plane; its force
// warm-started as a world vector (the twist as a torque about n), its penalty
// decayed within [nc penaltyMin, nc penaltyMax]; static friction keeps its
// anchors unless they drifted apart by stickThreshold, or for a rolling
// contact carries its slip c0_t + J_t dx.
const CENTRE_SETUP = /* wgsl */ `
fn setup(m: Manifold, a: u32, b: u32, mu: f32, dst: u32, old: u32, hasOld: bool) {
  var taken = array<bool, 4>(false, false, false, false);
  let n = m.normal;
  let t1 = tangent1(n);
  let t2 = cross(n, t1);
  let sphereA = a != NONE && props[a].sphere != 0u;
  let sphereB = props[b].sphere != 0u;
  let roll = p.rollingContacts != 0u && (sphereA || sphereB);
  var oldCount = 0u;
  if (hasOld) { oldCount = records[old].count; }
  let on = records[old].n;
  var pairLoad = 0.0;
  if (p.loadCap > 0.0) {
    for (var o = 0u; o < oldCount; o++) { pairLoad = max(pairLoad, abs(records[old].lambdaN[o])); }
  }
  let onB = sphereB && (!sphereA || props[b].radius <= props[a].radius);
  var dpA = vec3f(0.0); var phiA = vec3f(0.0);
  if (roll && a != NONE) { dpA = solver[a].dp; phiA = solver[a].phi; }
  var dpB = vec3f(0.0); var phiB = vec3f(0.0);
  if (roll) { dpB = solver[b].dp; phiB = solver[b].phi; }
  let B = bodies[b];
  var sumRaw = vec3f(0.0); var sumRbw = vec3f(0.0); var sumRa = vec3f(0.0); var sumRb = vec3f(0.0);
  var marks = 0u;
  for (var q = 0u; q < m.count; q++) {
    let pt = point(m, q);
    let wa = pt.xyz + n * (pt.w * 0.5);
    let wb = pt.xyz - n * (pt.w * 0.5);
    var ra = wa;
    if (a != NONE) { ra = qrot(qconj(bodies[a].rot), wa - bodies[a].pos); }
    let rb = qrot(qconj(B.rot), wb - B.pos);
    var lambdaN = 0.0;
    var kN = p.penaltyMin;
    var key = rb;
    if (roll) { if (onB) { key = wb - B.pos; } else { key = wa - bodies[a].pos; } }
    var best = 4u;
    var bestD = p.matchDistance;
    for (var o = 0u; o < oldCount; o++) {
      if (taken[o]) { continue; }
      var ok = vec3f(records[old].rbX[o], records[old].rbY[o], records[old].rbZ[o]);
      if (roll) { ok = select(recRaw(old, o), recRbw(old, o), onB); }
      let d = length(ok - key);
      if (d < bestD) { best = o; bestD = d; }
    }
    if (best < 4u) {
      taken[best] = true;
      let olambdaN = records[old].lambdaN[best];
      lambdaN = olambdaN;
      kN = clamp(records[old].kN[best] * p.gamma, p.penaltyMin, p.penaltyMax);
      if (p.restDepth > 0.0) {
        var kFloor = abs(olambdaN) / p.restDepth;
        if (roll && a != NONE) {
          let u = dpB + cross(phiB, recRbw(old, best)) - (dpA + cross(phiA, recRaw(old, best)));
          if (abs(dot(on, u)) >= p.restDepth) { kFloor = min(kFloor, sqrt(props[a].mass * props[b].mass) / (p.dt * p.dt)); }
        }
        if (p.loadCap > 0.0) { kN = max(min(kN, max(p.loadCap * (pairLoad / p.restDepth), p.capFall * kN)), p.penaltyMin); }
        kN = min(max(kN, kFloor), p.penaltyMax);
      }
    }
    var raw = vec3f(0.0);
    var pa = ra;
    if (a != NONE) { raw = qrot(bodies[a].rot, ra); pa = bodies[a].pos + raw; }
    let rbw = qrot(B.rot, rb);
    let d = B.pos + rbw - pa;
    let c0n = dot(d, n) + p.slop;
    // Loaded-gap slop (the reference's collide()): the point form's mark, on the warm-started lambdaN, kept in stick.
    if (gapSlop > 0.0 && !roll && lambdaN < 0.0 && c0n > 0.0) { marks |= 1u << (LOADED_BIT + q); }
    records[dst].rawX[q] = raw.x; records[dst].rawY[q] = raw.y; records[dst].rawZ[q] = raw.z;
    records[dst].rbwX[q] = rbw.x; records[dst].rbwY[q] = rbw.y; records[dst].rbwZ[q] = rbw.z;
    records[dst].c0N[q] = c0n;
    records[dst].kN[q] = kN; records[dst].lambdaN[q] = lambdaN;
    records[dst].rbX[q] = rb.x; records[dst].rbY[q] = rb.y; records[dst].rbZ[q] = rb.z;
    sumRaw += raw; sumRbw += rbw; sumRa += ra; sumRb += rb;
  }
  var rac = vec3f(0.0); var rbc = vec3f(0.0); var cra = vec3f(0.0); var crb = vec3f(0.0); var rt = 0.0;
  var lamT = vec3f(0.0); var kT = p.penaltyMin; var stick = 0u; var c0t = vec2f(0.0);
  if (m.count > 0u) {
    let nc = f32(m.count);
    rac = sumRaw / nc; rbc = sumRbw / nc; cra = sumRa / nc; crb = sumRb / nc;
    var rt2 = 0.0;
    for (var q = 0u; q < m.count; q++) {
      let o = recRbw(dst, q) - rbc;
      rt2 += dot(o, t1) * dot(o, t1) + dot(o, t2) * dot(o, t2);
    }
    rt = sqrt(rt2 / nc);
    var slip = vec2f(0.0);
    var carry = false;
    if (oldCount > 0u) {
      let ot1 = tangent1(on);
      let ot2 = cross(on, ot1);
      let olam = records[old].lamT;
      let f = olam.x * ot1 + olam.y * ot2;
      var tw = 0.0;
      if (rt > 0.0) { tw = (olam.z * records[old].rt * dot(on, n)) / rt; }
      lamT = vec3f(dot(f, t1), dot(f, t2), tw);
      kT = min(nc * p.penaltyMax, max(nc * p.penaltyMin, records[old].kT * p.gamma));
      let ostick = (records[old].stick & 1u) != 0u;
      if (ostick && roll) {
        let u = dpB + cross(phiB, records[old].rbc) - (dpA + cross(phiA, records[old].rac));
        let oc0t = records[old].c0t;
        let sv = (oc0t.x + dot(ot1, u)) * ot1 + (oc0t.y + dot(ot2, u)) * ot2;
        let st = vec2f(dot(sv, t1), dot(sv, t2));
        if (length(st) < p.stickThreshold) { stick = 1u; slip = st; carry = true; }
      } else if (ostick) {
        let ora = records[old].ra;
        let orb = records[old].rb;
        var opa = ora;
        if (a != NONE) { opa = bodies[a].pos + qrot(bodies[a].rot, ora); }
        let od = B.pos + qrot(B.rot, orb) - opa;
        if (length(vec2f(dot(od, t1), dot(od, t2))) < p.stickThreshold) { stick = 1u; cra = ora; crb = orb; }
      }
    }
    var pa = cra;
    if (a != NONE) { pa = bodies[a].pos + qrot(bodies[a].rot, cra); }
    let d = B.pos + qrot(B.rot, crb) - pa;
    c0t = vec2f(dot(d, t1), dot(d, t2));
    if (carry) { c0t += slip; }
  }
  records[dst].n = n; records[dst].mu = mu; records[dst].a = a; records[dst].b = b;
  records[dst].count = m.count; records[dst].stick = stick | marks;
  records[dst].rac = rac; records[dst].rt = rt; records[dst].rbc = rbc; records[dst].kT = kT;
  records[dst].lamT = lamT; records[dst].c0t = c0t; records[dst].ra = cra; records[dst].rb = crb;
}
`;

const DUAL_HEAD = DUAL.slice(0, DUAL.indexOf('fn dualPoint('));
const DUAL_BODIES = DUAL.slice(DUAL.indexOf('// Velocities from the last main iteration (BDF1).'));
const RECORD_DUAL_ENTRY = /* wgsl */ `
@compute @workgroup_size(${WG})
fn dualPairs(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  dualRecord(pairRecord(p.cur, k));
}

@compute @workgroup_size(${WG})
fn dualGround(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  dualRecord(groundRecord(p.cur, i));
}

`;

// records = 1: dualPoint() of the point form on each point, the partners' state read once.
const EXACT_DUAL = /* wgsl */ `fn dualRecord(idx: u32) {
  let count = records[idx].count;
  if (count == 0u) { return; }
  let ia = records[idx].a;
  let ib = records[idx].b;
  let B = solver[ib];
  var dpA = vec3f(0.0); var phiA = vec3f(0.0);
  if (ia != NONE) { let A = solver[ia]; dpA = A.dp; phiA = A.phi; }
  let n = records[idx].n;
  let t1 = tangent1(n);
  let mu = records[idx].mu;
  // The stick bits and the loaded-gap marks stay; the inCone bits are this update's.
  var flags = records[idx].flags & 0xf0fu;
  for (var q = 0u; q < count; q++) {
    var ct: SolverContact;
${exactPoint('idx', '    ')}
    let C = evalC(ct, 1.0, dpA, phiA, B.dp, B.phi);
    let bound = ct.mu * abs(ct.lambdaN);
    ct.lambdaN = min(0.0, ct.kN * C.x + ct.lambdaN);
    if (ct.lambdaN < 0.0) { ct.kN = min(ct.kN + p.beta * abs(C.x), p.penaltyMax); }
    let z = ct.kT * C.yz + ct.lt;
    let fl = length(z);
    // Static friction held if the trial force is inside the cone; the last main iteration's answer stands.
    if (fl < bound) {
      flags |= 1u << (4u + q);
      ct.lt = z;
      ct.kT = min(ct.kT + p.beta * length(C.yz), p.penaltyMax);
    } else {
      ct.lt = select(vec2f(0.0), z * (bound / fl), fl > 0.0);
    }
    records[idx].lambdaN[q] = ct.lambdaN;
    records[idx].kN[q] = ct.kN;
    records[idx].kT[q] = ct.kT;
    records[idx].lt1[q] = ct.lt.x;
    records[idx].lt2[q] = ct.lt.y;
  }
  records[idx].flags = flags;
}
`;

// records = 2: the reference's dual for a record: the points' normal rows, then
// the centre's friction against the ball of the points' forces before this
// update, its penalty ramping by nc beta up to nc penaltyMax.
const CENTRE_DUAL = /* wgsl */ `fn dualRecord(idx: u32) {
  let count = records[idx].count;
  if (count == 0u) { return; }
  let ia = records[idx].a;
  let ib = records[idx].b;
  let B = solver[ib];
  var dpA = vec3f(0.0); var phiA = vec3f(0.0);
  if (ia != NONE) { let A = solver[ia]; dpA = A.dp; phiA = A.phi; }
  let n = records[idx].n;
  // The loaded-gap marks, which stay (bit 0 is this update's); off, never loaded.
  var marks = 0u;
  if (gapSlop > 0.0) { marks = records[idx].stick & ~1u; }
  var sumN = 0.0;
  for (var q = 0u; q < count; q++) { sumN += records[idx].lambdaN[q]; }
  let bound = records[idx].mu * abs(sumN);
  for (var q = 0u; q < count; q++) {
    let cn = evalN(n, records[idx].c0N[q], gapSlop > 0.0 && recLoaded(marks, q), recRaw(idx, q), recRbw(idx, q), ia != NONE, 1.0, dpA, phiA, B.dp, B.phi);
    var kN = records[idx].kN[q];
    let lambdaN = min(0.0, kN * cn + records[idx].lambdaN[q]);
    if (lambdaN < 0.0) { kN = min(kN + p.beta * abs(cn), p.penaltyMax); }
    records[idx].lambdaN[q] = lambdaN;
    records[idx].kN[q] = kN;
  }
  let t1 = tangent1(n);
  let t2 = cross(n, t1);
  let CT = evalT(n, t1, t2, records[idx].c0t, records[idx].rac, records[idx].rbc, records[idx].rt, ia != NONE, 1.0, dpA, phiA, B.dp, B.phi);
  let kT = records[idx].kT;
  let z = kT * CT + records[idx].lamT;
  let zl = length(z);
  let nc = f32(count);
  // Static friction held if the trial force is inside the ball; the last main iteration's answer stands.
  if (zl < bound) {
    records[idx].stick = marks | 1u;
    records[idx].lamT = z;
    records[idx].kT = min(kT + nc * p.beta * length(CT), nc * p.penaltyMax);
  } else {
    records[idx].stick = marks;
    records[idx].lamT = select(vec3f(0.0), z * (bound / zl), zl > 0.0);
  }
}
`;

/**
 * The record dual pass with the fused dual's side array (dualWgsl() for
 * records): dualPairsSide and dualGroundSide first take the state the sweeps
 * left in duals (a ContactDual per point, or a CentreDual per record) into the
 * record, then run the step's last dual update on it.
 */
function sideRecordDual(records: 1 | 2): string {
  let d = swap(records === 1 ? EXACT_DUAL : CENTRE_DUAL, 'fn dualRecord(idx: u32) {', 'fn dualRecord(idx: u32, fromSide: bool) {');
  d = records === 1
    ? swap(d, '    let C = evalC(ct, 1.0, dpA, phiA, B.dp, B.phi);', `    if (fromSide) {
      let du = duals[(idx - p.cur * recordHalf()) * 4u + q];
      ct.lt = du.lt; ct.lambdaN = du.lambdaN; ct.kN = du.kN; ct.kT = du.kT;
    }
    let C = evalC(ct, 1.0, dpA, phiA, B.dp, B.phi);`)
    : swap(d, '  if (count == 0u) { return; }\n', `  if (count == 0u) { return; }
  if (fromSide) {
    let du = duals[idx - p.cur * recordHalf()];
    records[idx].kN = du.kN; records[idx].lambdaN = du.lambdaN; records[idx].lamT = du.lamT; records[idx].kT = du.kT;
  }
`);
  const entry = swap(swap(RECORD_DUAL_ENTRY, 'dualRecord(pairRecord(p.cur, k));', 'dualRecord(pairRecord(p.cur, k), false);'), 'dualRecord(groundRecord(p.cur, i));', 'dualRecord(groundRecord(p.cur, i), false);');
  return `${d}${entry}@compute @workgroup_size(${WG})
fn dualPairsSide(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= stepInfo[3]) { return; }
  dualRecord(pairRecord(p.cur, k), true);
}

@compute @workgroup_size(${WG})
fn dualGroundSide(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  dualRecord(groundRecord(p.cur, i), true);
}

`;
}

/**
 * The setup, primal and dual shaders of a record mode and dispatch. 0 is the
 * point form (SOLVER_WGSL, solveWgsl(), dualWgsl()); 1 and 2 need the
 * register form.
 */
export function recordWgsl(records: RecordMode, hessian: HessianForm = 'registers', d: Pick<SolverDispatch, 'dualFusion' | 'solveContactsRW'> = {}): { setup: string; solve: string; dual: string } {
  if (!RECORD_MODES.includes(records)) throw new Error(`recordWgsl: records must be one of ${RECORD_MODES.join(', ')}, got ${records}`);
  const fusion = fusionOf(d);
  if (records === 0) return { setup: SETUP, solve: solveWgsl(hessian, d), dual: dualWgsl(fusion) };
  if (hessian !== 'registers') throw new Error(`recordWgsl: records ${records} needs hessian registers, got ${hessian}`);
  const rw = d.solveContactsRW === true;
  const struct = records === 1 ? SolverRecord : CentreRecord, dual = records === 1 ? ContactDual : CentreDual;
  const decl = (code: string, access: string) =>
    swap(code, `var<storage, ${access}> contacts: array<SolverContact>;`, `var<storage, ${access}> records: array<${struct.name}>;`) + wgslStruct(struct) + RECORD_COMMON + (records === 2 ? CENTRE_EVAL : '');
  const entry = swap(swap(swap(swap(SETUP_ENTRY,
    'pairPoint(p.cur, k, 0u)', 'pairRecord(p.cur, k)'), 'pairPoint(1u - p.cur, select(0u, ps, ps != NONE), 0u)', 'pairRecord(1u - p.cur, select(0u, ps, ps != NONE))'),
    'groundPoint(p.cur, i, 0u)', 'groundRecord(p.cur, i)'), 'groundPoint(1u - p.cur, i, 0u)', 'groundRecord(1u - p.cur, i)');
  const dualHead = fusion !== 'side' ? DUAL_HEAD : swap(DUAL_HEAD, '@group(0) @binding(4) var<uniform> p: SolverParams;', `@group(0) @binding(4) var<uniform> p: SolverParams;
// The fused dual's state (${dual.name}) per ${records === 1 ? 'contact point' : 'record'} of this step's half.
@group(0) @binding(5) var<storage, read> duals: array<${dual.name}>;
${wgslStruct(dual)}`);
  return {
    setup: decl(SETUP_HEAD, 'read_write') + (records === 1 ? EXACT_SETUP : CENTRE_SETUP) + entry,
    solve: decl(solveHead(fusion, rw, dual), rw ? 'read_write' : 'read') + JROW + registerSolveBody(fusion, records) + solveTail(fusion),
    dual: decl(dualHead, 'read_write') + (fusion === 'side' ? sideRecordDual(records) : (records === 1 ? EXACT_DUAL : CENTRE_DUAL) + RECORD_DUAL_ENTRY) + DUAL_BODIES,
  };
}

/** The other kernels' shaders (DUAL without the fused dual's side array: dualWgsl(); without records: recordWgsl()); the primal's is solveWgsl(). */
export const SOLVER_WGSL = { PREP, MATCH, SETUP, INIT, DUAL };

/** Index = SolverParams.frictionCombine; combineFriction in the setup kernels follows this order. */
export const COMBINE_RULES: readonly CombineRule[] = ['average', 'min', 'max', 'multiply'];

export interface GpuSolverParams {
  iterations: number;
  beta: number;
  gamma: number;
  penaltyMin: number;
  penaltyMax: number;
  margin: number;
  slop: number;
  stickThreshold: number;
  matchDistance: number;
  maxAngularSpeed: number;
  maxSweep: number;
  sweep: boolean;
  slidingHessian: boolean;
  restDepth: number;
  rollingContacts: boolean;
  loadCap: number;
  capFall: number;
}

/**
 * How the primal sweep is dispatched and compiled. Every choice does the same
 * arithmetic per body, colour after colour; within a colour the bodies share
 * no contact, so which thread takes which body does not change the result.
 */
export interface SolverDispatch {
  /**
   * Colours below this get one dispatch each, sized for all n bodies (threads
   * past the colour's end exit); the rest are solved in order by one workgroup
   * of tailThreads threads, in a single dispatch. 0-63. Default 8: in the
   * scenes measured so far (towers, city, rain, impact), colours 8 and up held
   * at most 121 bodies.
   */
  colorTail: number;
  /** The previous dispatch, for timing it against: colours 0-62 by indirect dispatch, sized by the colouring. Colour 63 still goes to the tail. */
  indirectColors: boolean;
  /**
   * The tail workgroup's size, 1-256. Default 256 (MAX_TAIL) on a hardware GPU:
   * on the M5 Max it was never slower than 64, and late in the 10k city, where
   * the colours from 8 up hold hundreds of bodies, it saved 5.6 ms a step.
   * SOFTWARE_TAIL_THREADS on a software adapter, where a 256-thread tail
   * measured about 0.9 ms per dispatch and slowed the GPU tests by a fifth.
   * 1 makes the tail serial; with colorTail 0 the whole sweep is then serial,
   * which the tests use as an oracle for every other split.
   */
  tailThreads: number;
  /**
   * How each body's 6x6 system is held and solved (solveWgsl). 'registers'
   * (default): named scalars, unrolled (plan step 2b); on the M5 Max it
   * builds at 256 tail threads and halves the step (about 2x in every bench
   * suite case). 'array': the earlier private arrays and loops, which spill,
   * kept as the tests' oracle and for A/B runs. Both do the same
   * floating-point operations in the same order; on SwiftShader the results
   * are bit-identical. A compiler that contracts or reassociates them
   * differently could round differently (Metal compiles with relaxed math),
   * so on other GPUs they may differ in the last bits.
   */
  hessian: HessianForm;
  /**
   * Fused dual (AvbdParams.dualFusion; absent or false: off). Each contact's
   * dual update after main sweep k < I - 1 runs instead at the contact's first
   * visit in sweep k + 1 (contactForce()), and the dual dispatches between
   * those sweeps go: 2 (I - 1) fewer dual dispatches (2I - 3 fewer in all,
   * as visitOrder() adds one), and no pass that re-reads
   * every contact and both its bodies. The update after the last main sweep
   * still runs as a pass, as without fusion. visitOrder() writes each body's
   * position in the colour order once per step, which decides which visit is
   * first: the earlier colour, or within colour 63 (uncoloured bodies, solved
   * one after another in that order) the earlier body. Every split between
   * direct colours and the tail visits a contact's bodies in that order, so
   * none changes the result. Same arithmetic on the same values as the
   * separate pass: bit-identical on SwiftShader. Assumes every used contact
   * point is walked by both its bodies each sweep (true of the rows the
   * colouring builds: maxEdges = 2 maxPairs, and setup marks the used points
   * as a prefix). A walk that skipped one would be wrong, not just stale: in
   * the side array the last pass copies duals[] for every used point, so a
   * point no body walked would take whatever that entry last held. Any
   * pruning or early-out in the walk must keep it complete or turn fusion off.
   * With records (AvbdParams.records) the same holds per record in use:
   * records 1 fuses each point's update (a ContactDual per point in the side
   * array), records 2 the record's, its points' normal rows and its centre
   * friction (a CentreDual per record).
   */
  dualFusion?: boolean;
  /**
   * The solve kernel binds the contacts read_write (absent or false: read-only).
   * With dualFusion the fused update then writes the records in place;
   * without, the state lives in a side array (ContactDual, 24 B per point)
   * and colorStart moves to a uniform, so the kernel stays at 8 storage
   * buffers. Without dualFusion only the binding changes (to time the
   * read-only path against it), not the result.
   */
  solveContactsRW?: boolean;
}

export const DEFAULT_DISPATCH: SolverDispatch = { colorTail: 8, indirectColors: false, tailThreads: MAX_TAIL, hessian: 'registers' };

/** The default tail width on a software adapter (SwiftShader in tests and CI); see SolverDispatch.tailThreads. */
export const SOFTWARE_TAIL_THREADS = 64;

/** The default tail width for an adapter: every width gives the same result, so this only sets the speed. */
export function defaultTailThreads(software: boolean): number {
  return software ? SOFTWARE_TAIL_THREADS : DEFAULT_DISPATCH.tailThreads;
}

export interface SolverBuffers {
  bodies: GPUBuffer;
  props: GPUBuffer;
  /** Written by prepare(): vec4f per body (centre, bounding radius + sweep) for the broadphase, f32 sweep per body for the narrowphase. */
  spheres: GPUBuffer;
  sweep: GPUBuffer;
  /** Narrowphase outputs. */
  manifolds: GPUBuffer;
  groundManifolds: GPUBuffer;
  /** vec2u per pair slot, written by match(): (last step's slot, last step's SAT axis), read by the narrowphase too. */
  prev: GPUBuffer;
  /** Broadphase outputs: pairs, total, per-body group offsets. */
  pairs: GPUBuffer;
  total: GPUBuffer;
  offsets: GPUBuffer;
  /** Colouring outputs. */
  order: GPUBuffer;
  colorStart: GPUBuffer;
  dispatch: GPUBuffer;
  rowStart: GPUBuffer;
  rowLength: GPUBuffer;
  adjSlot: GPUBuffer;
}

type Kind = 'r' | 'rw' | 'u' | 'ud';

/**
 * The solver's own buffers and kernels. The engine runs prepare() before
 * the broadphase (it writes the inflated spheres and sweeps the broadphase
 * and narrowphase read), then solve() after the colouring.
 */
export class AvbdSolver {
  /**
   * Size of the contact buffer, the pipeline's largest (4 points per pair slot and ground slot, two history halves;
   * with records, one record per slot).
   */
  static contactBytes(capacity: number, maxPairs: number, records: RecordMode = 0): number {
    const slot = records === 0 ? 4 * SolverContact.size : records === 1 ? SolverRecord.size : CentreRecord.size;
    return 2 * (maxPairs + capacity) * slot;
  }

  readonly solver: GPUBuffer;
  /** Two halves of (maxPairs + capacity) * 4 contact points, or with records (AvbdParams.records) of maxPairs + capacity records. */
  readonly contacts: GPUBuffer;
  readonly meta: GPUBuffer;
  private readonly pairHist: GPUBuffer;
  private readonly offHist: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly colorUniform: GPUBuffer;
  /** The restitution pass's buffers (restitution.ts), only while it is on: a RestSlot per contact slot, and its counters and indirect arguments. */
  readonly restSlots: GPUBuffer | null = null;
  readonly restInfo: GPUBuffer | null = null;
  /** The fused dual's (SolverDispatch.dualFusion) mode, side array and colorStart copy; null when unused. */
  private readonly fusion: Fusion;
  private readonly duals: GPUBuffer | null = null;
  private readonly colorStarts: GPUBuffer | null = null;
  /** solve()'s last iteration count, for encodeProbe(). */
  private iterations = 0;
  private readonly pipes: Record<string, GPUComputePipeline> = {};
  private readonly binds: Record<string, GPUBindGroup> = {};
  private cur = 0;
  private prevN = 0;

  /**
   * gapSlop: AvbdParams.gapSlop, m (a finite number >= 0; 0, the default, is
   * off). It goes to the setup, primal and dual pipelines as the WGSL
   * override gapSlop, an f32, so it is fixed for this solver; writeParams()
   * does not take it. A value under f32's normal range (1.2e-38) may act as 0
   * here (rounded or flushed); on the reference such a value changed no float
   * of the kicked column either (1e-50 to 1e-38; 1e-20 changed 92 of 104,
   * 2026-10-27), so the two agree in effect while EngineInfo.variant lists it.
   * With records 1 or 2 setup marks a point in the record's word (LOADED_BIT).
   *
   * restitution: the restitution pass's settings (restitution.ts) while
   * AvbdParams.restitution is on, else null (the default): then the pass has
   * no buffer and no pipeline, and solve() encodes no dispatch of it. It reads
   * and resets the point form's contacts, so it throws with records 1 or 2. It
   * also throws with the fused dual (SolverDispatch.dualFusion), which was
   * never built or tested with it.
   */
  constructor(private readonly device: GPUDevice, readonly capacity: number, readonly maxPairs: number, private readonly b: SolverBuffers, private readonly dispatch: SolverDispatch = DEFAULT_DISPATCH, readonly records: RecordMode = 0, readonly gapSlop = 0, readonly restitution: RestitutionConfig | null = null) {
    if (!(Number.isFinite(gapSlop) && gapSlop >= 0)) throw new Error(`AvbdSolver: gapSlop must be a finite number >= 0, got ${gapSlop}`);
    if (restitution) {
      const { threshold: t, rounds: r, groundRestitution: g, combine: c } = restitution;
      if (!(Number.isFinite(t) && t >= 0)) throw new Error(`AvbdSolver: restitution.threshold must be a finite number >= 0, got ${t}`);
      if (!(Number.isInteger(r) && r >= 1)) throw new Error(`AvbdSolver: restitution.rounds must be an integer >= 1, got ${r}`);
      if (!(g >= 0 && g <= 1)) throw new Error(`AvbdSolver: restitution.groundRestitution must be in [0, 1], got ${g}`);
      if (!COMBINE_RULES.includes(c)) throw new Error(`AvbdSolver: restitution.combine must be one of ${COMBINE_RULES.join(', ')}, got ${c}`);
      if (records !== 0) throw new Error(`AvbdSolver: restitution is not implemented with records ${records} yet (the pass reads the point form's contacts)`);
      if (dispatch.dualFusion) throw new Error('AvbdSolver: restitution is not implemented with dualFusion yet');
    }
    if (!(Number.isInteger(dispatch.colorTail) && dispatch.colorTail >= 0 && dispatch.colorTail < MAX_COLORS)) throw new Error(`AvbdSolver: colorTail must be an integer from 0 to ${MAX_COLORS - 1}, got ${dispatch.colorTail}`);
    if (!(Number.isInteger(dispatch.tailThreads) && dispatch.tailThreads >= 1 && dispatch.tailThreads <= MAX_TAIL)) throw new Error(`AvbdSolver: tailThreads must be an integer from 1 to ${MAX_TAIL}, got ${dispatch.tailThreads}`);
    if (!HESSIAN_FORMS.includes(dispatch.hessian)) throw new Error(`AvbdSolver: hessian must be one of ${HESSIAN_FORMS.join(', ')}, got ${dispatch.hessian}`);
    for (const k of ['dualFusion', 'solveContactsRW'] as const) if (dispatch[k] !== undefined && typeof dispatch[k] !== 'boolean') throw new Error(`AvbdSolver: ${k} must be a boolean, got ${dispatch[k]}`);
    if (!RECORD_MODES.includes(records)) throw new Error(`AvbdSolver: records must be one of ${RECORD_MODES.join(', ')}, got ${records}`);
    if (records !== 0 && dispatch.hessian !== 'registers') throw new Error(`AvbdSolver: records ${records} needs hessian registers, got ${dispatch.hessian}`);
    this.fusion = fusionOf(dispatch);
    const code = recordWgsl(records, dispatch.hessian, dispatch);
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label }));
    this.solver = buf(capacity * SolverBody.size, 'avbd solver bodies');
    this.contacts = buf(AvbdSolver.contactBytes(capacity, maxPairs, records), 'avbd contacts');
    this.meta = buf(64, 'avbd meta');
    this.pairHist = buf(2 * maxPairs * 8, 'avbd pair history');
    this.offHist = buf(2 * capacity * 4, 'avbd offset history');
    this.uniform = device.createBuffer({ size: SolverParams.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'avbd params' });
    // One entry per (colour, pass): alpha 1 for the main iterations, 0 for stabilization. With the
    // fused dual, two more passes of main iterations: the step's first fused sweep and the later ones
    // (ColorParams.fuse 1 and 2; PASS).
    const passes = this.fusion === 'off' ? 2 : 4;
    this.colorUniform = device.createBuffer({ size: passes * MAX_COLORS * DYN, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'avbd colour params' });
    const cu = new ArrayBuffer(passes * MAX_COLORS * DYN);
    for (let pass = 0; pass < passes; pass++) for (let c = 0; c < MAX_COLORS; c++) {
      new Uint32Array(cu, (pass * MAX_COLORS + c) * DYN, 1)[0] = c;
      new Float32Array(cu, (pass * MAX_COLORS + c) * DYN + 4, 1)[0] = pass === PASS.stab ? 0 : 1;
      if (pass >= PASS.firstFused) new Uint32Array(cu, (pass * MAX_COLORS + c) * DYN + 8, 1)[0] = pass === PASS.firstFused ? 1 : 2;
    }
    device.queue.writeBuffer(this.colorUniform, 0, cu);
    if (this.fusion === 'side') {
      this.duals = buf((maxPairs + capacity) * (records === 2 ? CentreDual.size : 4 * ContactDual.size), 'avbd fused dual state');
      this.colorStarts = device.createBuffer({ size: COLOR_STARTS * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'avbd colour starts' });
    }
    const mk = (name: string, code: string, entries: Array<[string, ...string[]]>, kinds: Kind[], groups: Array<[string, GPUBuffer[]]>, constants: Record<string, Record<string, number>> = {}) => {
      const layout = device.createBindGroupLayout({
        label: name,
        entries: kinds.map((k, binding) => ({
          binding, visibility: GPUShaderStage.COMPUTE,
          buffer: k === 'r' ? { type: 'read-only-storage' as const } : k === 'rw' ? { type: 'storage' as const } : k === 'u' ? { type: 'uniform' as const } : { type: 'uniform' as const, hasDynamicOffset: true, minBindingSize: ColorParams.size },
        })),
      });
      const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const module = device.createShaderModule({ code, label: name });
      for (const [, ...eps] of entries) for (const ep of eps) this.pipes[ep] = device.createComputePipeline({ label: `${name}: ${ep}`, layout: pl, compute: { module, entryPoint: ep, ...(constants[ep] ? { constants: constants[ep] } : {}) } });
      for (const [g, buffers] of groups) {
        this.binds[g] = device.createBindGroup({
          layout,
          entries: buffers.map((buffer, binding) => ({ binding, resource: kinds[binding] === 'ud' ? { buffer, size: ColorParams.size } : { buffer } })),
        });
      }
    };
    const B = b;
    // The loaded-gap slop's pipeline constant, for the entry points that read it; left at its default (0) while off,
    // so the pipelines are built exactly as without it. Past f32's range it is f32's largest: no gap is that large.
    const gs = gapSlop > 0 ? { gapSlop: Math.min(gapSlop, F32_MAX) } : null;
    const slop = (...eps: string[]): Record<string, Record<string, number>> => (gs ? Object.fromEntries(eps.map((ep) => [ep, gs])) : {});
    mk('avbd prepare', PREP, [['', 'prepare']], ['r', 'r', 'rw', 'rw', 'u'], [['prep', [B.bodies, B.props, B.spheres, B.sweep, this.uniform]]]);
    mk('avbd match', MATCH, [['', 'matchPairs']], ['r', 'r', 'r', 'r', 'r', 'r', 'rw', 'u'],
      [['match', [B.pairs, B.total, this.meta, this.pairHist, this.offHist, B.manifolds, B.prev, this.uniform]]]);
    mk('avbd setup', code.setup, [['', 'pairSetup', 'groundSetup']], ['r', 'r', 'r', 'r', 'r', 'r', 'rw', 'r', 'u'],
      [['setup', [B.manifolds, B.groundManifolds, B.bodies, B.props, this.meta, B.prev, this.contacts, this.solver, this.uniform]]],
      slop('pairSetup', 'groundSetup'));
    mk('avbd init', INIT, [['', 'initBodies']], ['rw', 'rw', 'u'], [['init', [B.bodies, this.solver, this.uniform]]]);
    // The solve kernel: 8 storage buffers. The fused dual's side array takes colorStart's place among them (as a uniform copy).
    const side = this.fusion === 'side';
    const solveKinds: Kind[] = ['r', 'rw', dispatch.solveContactsRW ? 'rw' : 'r', 'r', side ? 'u' : 'r', 'r', 'r', 'r', 'u', 'ud', ...(side ? ['rw' as const] : [])];
    mk('avbd solve', code.solve, [['', 'primal', 'primalTail', ...(this.fusion === 'off' ? [] : ['visitOrder'])]], solveKinds,
      [['solve', [B.props, this.solver, this.contacts, B.order, side ? this.colorStarts! : B.colorStart, B.rowStart, B.rowLength, B.adjSlot, this.uniform, this.colorUniform, ...(side ? [this.duals!] : [])]]],
      { ...slop('primal'), primalTail: { tailThreads: dispatch.tailThreads, ...gs } });
    mk('avbd dual', code.dual, [['', 'dualPairs', 'dualGround', 'velocities', 'finalize', ...(side ? ['dualPairsSide', 'dualGroundSide'] : [])]], ['rw', 'rw', 'rw', 'r', 'u', ...(side ? ['r' as const] : [])],
      [['dual', [B.bodies, this.solver, this.contacts, this.meta, this.uniform, ...(side ? [this.duals!] : [])]]],
      slop('dualPairs', 'dualGround', ...(side ? ['dualPairsSide', 'dualGroundSide'] : [])));
    if (restitution) {
      const slots = buf((maxPairs + capacity) * RestSlot.size, 'avbd restitution slots');
      const info = device.createBuffer({ size: REST_INFO_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'avbd restitution info' });
      this.restSlots = slots;
      this.restInfo = info;
      const values = restitutionConstants(restitution, COMBINE_RULES.indexOf(restitution.combine));
      const res: Record<RestBinding, [Kind, GPUBuffer]> = {
        contacts: ['r', this.contacts], contactsRw: ['rw', this.contacts], props: ['r', B.props], solver: ['r', this.solver],
        bodies: ['r', B.bodies], bodiesRw: ['rw', B.bodies], rest: ['rw', slots], restRead: ['r', slots], info: ['rw', info],
        stepInfo: ['r', this.meta], rowStart: ['r', B.rowStart], rowLength: ['r', B.rowLength], adjSlot: ['r', B.adjSlot], params: ['u', this.uniform],
      };
      for (const k of restitutionKernels(COMMON)) {
        const constants = k.constants.length ? { [k.entry]: Object.fromEntries(k.constants.map((c) => [c, values[c]])) } : {};
        mk(`avbd ${k.entry}`, k.code, [['', k.entry]], k.bindings.map((x) => res[x][0]), [[k.entry, k.bindings.map((x) => res[x][1])]], constants);
      }
    }
  }

  /** Per-step uniforms; call once per step before prepare(). */
  writeParams(n: number, dt: number, gravity: readonly number[], ground: { y: number; friction: number } | null, sp: GpuSolverParams, frictionCombine: CombineRule = 'average'): void {
    const u = new ArrayBuffer(SolverParams.size);
    const f = new Float32Array(u), i = new Uint32Array(u);
    const at = (name: string) => SolverParams.fields.find((x) => x.name === name)!.offset / 4;
    f.set(gravity, at('gravity'));
    f[at('dt')] = dt;
    i[at('n')] = n; i[at('prevN')] = this.prevN; i[at('cur')] = this.cur; i[at('iterations')] = sp.iterations;
    f[at('beta')] = sp.beta; f[at('gamma')] = sp.gamma; f[at('penaltyMin')] = sp.penaltyMin; f[at('penaltyMax')] = sp.penaltyMax;
    f[at('margin')] = sp.margin; f[at('slop')] = sp.slop; f[at('stickThreshold')] = sp.stickThreshold; f[at('matchDistance')] = sp.matchDistance;
    f[at('maxAngularSpeed')] = sp.maxAngularSpeed; f[at('maxSweep')] = sp.maxSweep;
    f[at('groundY')] = ground?.y ?? 0; i[at('hasGround')] = ground ? 1 : 0; f[at('groundFriction')] = ground?.friction ?? 0;
    i[at('maxPairs')] = this.maxPairs; i[at('capacity')] = this.capacity;
    i[at('slidingHessian')] = sp.slidingHessian ? 1 : 0; i[at('sweepOn')] = sp.sweep ? 1 : 0;
    i[at('frictionCombine')] = COMBINE_RULES.indexOf(frictionCombine);
    f[at('restDepth')] = sp.restDepth;
    i[at('rollingContacts')] = sp.rollingContacts ? 1 : 0;
    f[at('loadCap')] = sp.loadCap;
    f[at('capFall')] = sp.capFall;
    this.device.queue.writeBuffer(this.uniform, 0, u);
  }

  prepare(pass: GPUComputePassEncoder, n: number): void {
    if (n === 0) return;
    pass.setPipeline(this.pipes.prepare!);
    pass.setBindGroup(0, this.binds.prep!);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
  }

  /** After the broadphase, before the narrowphase (it reads last step's manifolds): fills prev. */
  match(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.pipes.matchPairs!);
    pass.setBindGroup(0, this.binds.match!);
    pass.dispatchWorkgroupsIndirect(this.b.total, 0);
  }

  /** After broadphase, narrowphase and colouring: one full AVBD step. */
  solve(encoder: GPUCommandEncoder, n: number, iterations: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const { b } = this;
    // This step's history half: pairs, group offsets, slot count.
    encoder.copyBufferToBuffer(b.pairs, 0, this.pairHist, this.cur * this.maxPairs * 8, this.maxPairs * 8);
    encoder.copyBufferToBuffer(b.offsets, 0, this.offHist, this.cur * this.capacity * 4, this.capacity * 4);
    encoder.copyBufferToBuffer(b.total, 0, this.meta, 0, 32);
    encoder.copyBufferToBuffer(b.total, 12, this.meta, 32 + 4 * this.cur, 4);
    if (this.colorStarts) encoder.copyBufferToBuffer(b.colorStart, 0, this.colorStarts, 0, (MAX_COLORS + 1) * 4);
    this.iterations = iterations;
    const fused = this.fusion !== 'off';
    const groups = Math.max(1, Math.ceil(n / WG));
    const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : {});
    if (n > 0) {
      pass.setBindGroup(0, this.binds.setup!);
      pass.setPipeline(this.pipes.pairSetup!);
      pass.dispatchWorkgroupsIndirect(b.total, 0);
      pass.setPipeline(this.pipes.groundSetup!);
      pass.dispatchWorkgroups(groups);
      pass.setBindGroup(0, this.binds.init!);
      pass.setPipeline(this.pipes.initBodies!);
      pass.dispatchWorkgroups(groups);
      if (fused) {
        pass.setBindGroup(0, this.binds.solve!, [0]);
        pass.setPipeline(this.pipes.visitOrder!);
        pass.dispatchWorkgroups(groups);
      }
      // Colours below `direct` get a dispatch each; the tail workgroup does the rest.
      const { indirectColors } = this.dispatch;
      const direct = indirectColors ? MAX_COLORS - 1 : this.dispatch.colorTail;
      for (let it = 0; it <= iterations; it++) {
        // The fused dual runs the last sweep's dual update in main sweeps 1 .. I - 1.
        const at = it === iterations ? PASS.stab : !fused || it === 0 ? PASS.main : it === 1 ? PASS.firstFused : PASS.fused;
        const colour = (c: number) => [(at * MAX_COLORS + c) * DYN];
        pass.setPipeline(this.pipes.primal!);
        for (let c = 0; c < direct; c++) {
          pass.setBindGroup(0, this.binds.solve!, colour(c));
          if (indirectColors) pass.dispatchWorkgroupsIndirect(b.dispatch, 12 * c);
          else pass.dispatchWorkgroups(groups);
        }
        pass.setPipeline(this.pipes.primalTail!);
        pass.setBindGroup(0, this.binds.solve!, colour(direct));
        pass.dispatchWorkgroups(1);
        pass.setBindGroup(0, this.binds.dual!);
        // With the fused dual, only the last main sweep's dual update is a pass; from the side array once a sweep has fused.
        if (it < iterations && (!fused || it === iterations - 1)) {
          const fromSide = this.fusion === 'side' && it > 0;
          pass.setPipeline(fromSide ? this.pipes.dualPairsSide! : this.pipes.dualPairs!);
          pass.dispatchWorkgroupsIndirect(b.total, 0);
          pass.setPipeline(fromSide ? this.pipes.dualGroundSide! : this.pipes.dualGround!);
          pass.dispatchWorkgroups(groups);
        }
        if (it === iterations - 1) {
          pass.setPipeline(this.pipes.velocities!);
          pass.dispatchWorkgroups(groups);
        }
      }
      pass.setPipeline(this.pipes.finalize!);
      pass.dispatchWorkgroups(groups);
      if (this.restitution) this.encodeRestitution(pass, groups, this.restitution.rounds);
    }
    pass.end();
    this.prevN = n;
    this.cur = 1 - this.cur;
  }

  /** The restitution pass (restitution.ts), after finalize: 6 + 2 rounds dispatches, all but 3 of them indirect and empty when no point bounces. */
  private encodeRestitution(pass: GPUComputePassEncoder, groups: number, rounds: number): void {
    const info = this.restInfo!;
    const run = (entry: string, args: { direct: number } | { indirect: GPUBuffer; at: number }) => {
      pass.setPipeline(this.pipes[entry]!);
      pass.setBindGroup(0, this.binds[entry]!);
      if ('direct' in args) pass.dispatchWorkgroups(args.direct);
      else pass.dispatchWorkgroupsIndirect(args.indirect, args.at);
    };
    const slots = { indirect: info, at: REST_SLOT_ARGS }, bodies = { indirect: info, at: REST_BODY_ARGS };
    run('restMark', { indirect: this.b.total, at: 0 });
    run('restMarkBodies', { direct: groups });
    run('restArgs', { direct: 1 });
    run('restSupport', slots);
    run('restCount', bodies);
    for (let r = 0; r < rounds; r++) {
      run('restManifold', slots);
      run('restBodies', bodies);
    }
    run('restFinish', bodies);
  }

  /** The contact history half the last solve() read and wrote (p.cur in the uniforms it left). */
  get lastHalf(): number {
    return 1 - this.cur;
  }

  /**
   * Bench and tests only (the solver probe's colour structure, probe.ts; the
   * test pages): the points in use in the first `slots` pair slots and the
   * first `n` ground slots of lastHalf, read back. A slot's SolverContact
   * points are in use up to the first unused one; with records, its record
   * holds the count.
   */
  async slotPoints(slots: number, n: number): Promise<{ pairs: Uint32Array; ground: Uint32Array }> {
    const read = async (bytes: number, offset: number) => new Uint32Array(await readBuffer(this.device, this.contacts, Math.max(4, bytes), offset));
    const half = this.lastHalf, pairs = new Uint32Array(slots), ground = new Uint32Array(n);
    if (this.records === 0) {
      const CS = SolverContact.size, usedAt = field(SolverContact, 'used').offset / 4, halfSize = (this.maxPairs + this.capacity) * 4;
      const used = (pts: Uint32Array, slot: number) => {
        let k = 0;
        while (k < 4 && pts[(slot * 4 + k) * (CS / 4) + usedAt] !== 0) k++;
        return k;
      };
      const p = await read(slots * 4 * CS, half * halfSize * CS), g = await read(n * 4 * CS, (half * halfSize + this.maxPairs * 4) * CS);
      for (let k = 0; k < slots; k++) pairs[k] = used(p, k);
      for (let i = 0; i < n; i++) ground[i] = used(g, i);
    } else {
      const rec = this.records === 1 ? SolverRecord : CentreRecord, RS = rec.size, countAt = field(rec, 'count').offset / 4, halfSize = this.maxPairs + this.capacity;
      const p = await read(slots * RS, half * halfSize * RS), g = await read(n * RS, (half * halfSize + this.maxPairs) * RS);
      for (let k = 0; k < slots; k++) pairs[k] = p[k * (RS / 4) + countAt]!;
      for (let i = 0; i < n; i++) ground[i] = g[i * (RS / 4) + countAt]!;
    }
    return { pairs, ground };
  }

  /**
   * Bench and tests only (the solver probe, probe.ts; the primal kernel test,
   * test/page.ts primalKernel); solve() never calls this. Encode
   * `reps` copies of one piece of the last solve()'s main-iteration sweep,
   * issued exactly as solve() issues it, with its pipelines, bind groups and
   * the uniforms it left: colour c's primal dispatch, the tail workgroup, or
   * one dual update (pairs and ground). The primal dispatch can also be
   * issued for a colour the sweep gives to the tail (c up to 62): for an
   * empty one, that is the dispatch's fixed cost. They run on the state the
   * last step left and change it: primal pieces only touch dp and phi, which
   * the next step's initBodies overwrites; the dual changes contact state,
   * which the next step warm-starts from. With the fused dual, the primal
   * pieces run as a main sweep after the step's first fused one does (each
   * contact's first visit runs a dual update), and the dual is the step's one
   * dual pass, as solve() issued it. The fused update in a primal piece
   * writes the side array, which the next step writes before it reads it, or
   * in place (solveContactsRW) the contacts: there each rep of a primal piece
   * changes contact state too.
   */
  encodeProbe(pass: GPUComputePassEncoder, n: number, piece: { primal: number } | 'tail' | 'dual', reps: number): void {
    if (n === 0) return;
    const { b } = this;
    const groups = Math.max(1, Math.ceil(n / WG));
    const direct = this.dispatch.indirectColors ? MAX_COLORS - 1 : this.dispatch.colorTail;
    if (piece === 'dual') {
      const fromSide = this.fusion === 'side' && this.iterations > 1;
      pass.setBindGroup(0, this.binds.dual!);
      for (let r = 0; r < reps; r++) {
        pass.setPipeline(fromSide ? this.pipes.dualPairsSide! : this.pipes.dualPairs!);
        pass.dispatchWorkgroupsIndirect(b.total, 0);
        pass.setPipeline(fromSide ? this.pipes.dualGroundSide! : this.pipes.dualGround!);
        pass.dispatchWorkgroups(groups);
      }
      return;
    }
    const c = piece === 'tail' ? direct : piece.primal;
    if (piece !== 'tail' && !(Number.isInteger(c) && c >= 0 && c < MAX_COLORS - 1)) throw new Error(`AvbdSolver.encodeProbe: colour ${c} has no primal dispatch (colours 0-${MAX_COLORS - 2} do; ${MAX_COLORS - 1} is solved serially)`);
    pass.setPipeline(piece === 'tail' ? this.pipes.primalTail! : this.pipes.primal!);
    const at = this.fusion !== 'off' && this.iterations > 1 ? PASS.fused : PASS.main;
    pass.setBindGroup(0, this.binds.solve!, [(at * MAX_COLORS + c) * DYN]);
    for (let r = 0; r < reps; r++) {
      if (piece === 'tail') pass.dispatchWorkgroups(1);
      else if (this.dispatch.indirectColors) pass.dispatchWorkgroupsIndirect(b.dispatch, 12 * c);
      else pass.dispatchWorkgroups(groups);
    }
  }

  destroy(): void {
    for (const x of [this.solver, this.contacts, this.meta, this.pairHist, this.offHist, this.uniform, this.colorUniform, this.duals, this.colorStarts, this.restSlots, this.restInfo]) x?.destroy();
  }
}
