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
// - Post-stabilization is always on (the reference's default).
//
// Each kernel binds at most 8 storage buffers (the WebGPU default limit).
import type { CombineRule } from '@tb/engine-api';
import { assertStorageFits } from '@tb/gpu';
import { Body, BodyProps, ColorParams, Manifold, SolverBody, SolverContact, SolverParams, wgslStruct } from '@tb/schema';
import { MAX_COLORS } from './coloring.ts';

const WG = 64;
/** Most threads the tail workgroup can have (SolverDispatch.tailThreads): WebGPU's default limit per workgroup. */
const MAX_TAIL = 256;
const NONE = 0xffffffff;
/** Uniform buffer offset alignment for the per-colour dynamic uniforms. */
const DYN = 256;

const COMMON = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(BodyProps)}
${wgslStruct(SolverBody)}
${wgslStruct(SolverContact)}
${wgslStruct(SolverParams)}
const NONE = ${NONE}u;

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
@group(0) @binding(7) var<uniform> p: SolverParams;

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
fn setup(m: Manifold, a: u32, b: u32, mu: f32, dst: u32, old: u32, hasOld: bool) {
  var taken = array<bool, 4>(false, false, false, false);
  let n = m.normal;
  let t1 = tangent1(n);
  let t2 = cross(n, t1);
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
    if (hasOld) {
      var best = 4u;
      var bestD = p.matchDistance;
      for (var o = 0u; o < 4u; o++) {
        let oc = contacts[old + o];
        if (oc.used == 0u || taken[o]) { continue; }
        let d = length(oc.rb - rb);
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
        // Load floor (AvbdParams.restDepth): keeps a resting stack stiff enough not to lean over.
        if (p.restDepth > 0.0) { ct.kN = min(max(ct.kN, abs(oc.lambdaN) / p.restDepth), p.penaltyMax); }
        ct.kT = clamp(oc.kT * p.gamma, p.penaltyMin, p.penaltyMax);
        // Static friction held at the end of last step: keep its anchors, unless they
        // have drifted apart along the surface by stickThreshold since.
        if (oc.inCone != 0u) {
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

const SOLVE = /* wgsl */ `
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

var<private> lhs: array<f32, 36>;
var<private> rhs: array<f32, 6>;

fn jrow(ct: SolverContact, r: u32, onB: bool) -> array<f32, 6> {
  var u = ct.n;
  if (r == 1u) { u = ct.t1; } else if (r == 2u) { u = cross(ct.n, ct.t1); }
  // Body b: (u, rbw x u); body a: -(u, raw x u).
  var w = cross(ct.rbw, u);
  if (!onB) { w = -cross(ct.raw, u); u = -u; }
  return array<f32, 6>(u.x, u.y, u.z, w.x, w.y, w.z);
}

// Add one contact's force and stiffness to body i's system.
fn accumulate(ct: SolverContact, i: u32) {
  let onB = ct.b == i;
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
  let kt = select(ct.kT, ct.kT * s, p.slidingHessian != 0u);
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

export const SOLVER_WGSL = { PREP, MATCH, SETUP, INIT, SOLVE, DUAL };

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
}

/**
 * How the primal sweep is dispatched. Every choice does the same arithmetic
 * per body, colour after colour; within a colour the bodies share no contact,
 * so which thread takes which body does not change the result.
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
   * The tail workgroup's size, 1-256. Default 64: at most 2 strides for the
   * largest tail colour measured so far; and on SwiftShader a 256-thread tail
   * measured about 0.9 ms per dispatch, which slowed the GPU tests by a fifth.
   * 1 makes the tail serial; with colorTail 0 the whole sweep is then serial,
   * which the tests use as an oracle for every other split.
   */
  tailThreads: number;
}

export const DEFAULT_DISPATCH: SolverDispatch = { colorTail: 8, indirectColors: false, tailThreads: 64 };

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
  /** Size of the contact buffer, the pipeline's largest (4 points per pair slot and ground slot, two history halves). */
  static contactBytes(capacity: number, maxPairs: number): number {
    return 2 * (maxPairs + capacity) * 4 * SolverContact.size;
  }

  readonly solver: GPUBuffer;
  /** Two halves of (maxPairs + capacity) * 4 contact points. */
  readonly contacts: GPUBuffer;
  readonly meta: GPUBuffer;
  private readonly pairHist: GPUBuffer;
  private readonly offHist: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly colorUniform: GPUBuffer;
  private readonly pipes: Record<string, GPUComputePipeline> = {};
  private readonly binds: Record<string, GPUBindGroup> = {};
  private cur = 0;
  private prevN = 0;

  constructor(private readonly device: GPUDevice, readonly capacity: number, readonly maxPairs: number, private readonly b: SolverBuffers, private readonly dispatch: SolverDispatch = DEFAULT_DISPATCH) {
    if (!(Number.isInteger(dispatch.colorTail) && dispatch.colorTail >= 0 && dispatch.colorTail < MAX_COLORS)) throw new Error(`AvbdSolver: colorTail must be an integer from 0 to ${MAX_COLORS - 1}, got ${dispatch.colorTail}`);
    if (!(Number.isInteger(dispatch.tailThreads) && dispatch.tailThreads >= 1 && dispatch.tailThreads <= MAX_TAIL)) throw new Error(`AvbdSolver: tailThreads must be an integer from 1 to ${MAX_TAIL}, got ${dispatch.tailThreads}`);
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label }));
    this.solver = buf(capacity * SolverBody.size, 'avbd solver bodies');
    this.contacts = buf(AvbdSolver.contactBytes(capacity, maxPairs), 'avbd contacts');
    this.meta = buf(64, 'avbd meta');
    this.pairHist = buf(2 * maxPairs * 8, 'avbd pair history');
    this.offHist = buf(2 * capacity * 4, 'avbd offset history');
    this.uniform = device.createBuffer({ size: SolverParams.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'avbd params' });
    // One entry per (colour, pass): alpha 1 for the main iterations, 0 for stabilization.
    this.colorUniform = device.createBuffer({ size: 2 * MAX_COLORS * DYN, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'avbd colour params' });
    const cu = new ArrayBuffer(2 * MAX_COLORS * DYN);
    for (let stab = 0; stab < 2; stab++) for (let c = 0; c < MAX_COLORS; c++) {
      new Uint32Array(cu, (stab * MAX_COLORS + c) * DYN, 1)[0] = c;
      new Float32Array(cu, (stab * MAX_COLORS + c) * DYN + 4, 1)[0] = stab ? 0 : 1;
    }
    device.queue.writeBuffer(this.colorUniform, 0, cu);
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
      for (const [, ...eps] of entries) for (const ep of eps) this.pipes[ep] = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: ep, ...(constants[ep] ? { constants: constants[ep] } : {}) } });
      for (const [g, buffers] of groups) {
        this.binds[g] = device.createBindGroup({
          layout,
          entries: buffers.map((buffer, binding) => ({ binding, resource: kinds[binding] === 'ud' ? { buffer, size: ColorParams.size } : { buffer } })),
        });
      }
    };
    const B = b;
    mk('avbd prepare', PREP, [['', 'prepare']], ['r', 'r', 'rw', 'rw', 'u'], [['prep', [B.bodies, B.props, B.spheres, B.sweep, this.uniform]]]);
    mk('avbd match', MATCH, [['', 'matchPairs']], ['r', 'r', 'r', 'r', 'r', 'r', 'rw', 'u'],
      [['match', [B.pairs, B.total, this.meta, this.pairHist, this.offHist, B.manifolds, B.prev, this.uniform]]]);
    mk('avbd setup', SETUP, [['', 'pairSetup', 'groundSetup']], ['r', 'r', 'r', 'r', 'r', 'r', 'rw', 'u'],
      [['setup', [B.manifolds, B.groundManifolds, B.bodies, B.props, this.meta, B.prev, this.contacts, this.uniform]]]);
    mk('avbd init', INIT, [['', 'initBodies']], ['rw', 'rw', 'u'], [['init', [B.bodies, this.solver, this.uniform]]]);
    mk('avbd solve', SOLVE, [['', 'primal', 'primalTail']], ['r', 'rw', 'r', 'r', 'r', 'r', 'r', 'r', 'u', 'ud'],
      [['solve', [B.props, this.solver, this.contacts, B.order, B.colorStart, B.rowStart, B.rowLength, B.adjSlot, this.uniform, this.colorUniform]]],
      { primalTail: { tailThreads: dispatch.tailThreads } });
    mk('avbd dual', DUAL, [['', 'dualPairs', 'dualGround', 'velocities', 'finalize']], ['rw', 'rw', 'rw', 'r', 'u'],
      [['dual', [B.bodies, this.solver, this.contacts, this.meta, this.uniform]]]);
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
      // Colours below `direct` get a dispatch each; the tail workgroup does the rest.
      const { indirectColors } = this.dispatch;
      const direct = indirectColors ? MAX_COLORS - 1 : this.dispatch.colorTail;
      for (let it = 0; it <= iterations; it++) {
        const stab = it === iterations ? 1 : 0;
        const colour = (c: number) => [(stab * MAX_COLORS + c) * DYN];
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
        if (it < iterations) {
          pass.setPipeline(this.pipes.dualPairs!);
          pass.dispatchWorkgroupsIndirect(b.total, 0);
          pass.setPipeline(this.pipes.dualGround!);
          pass.dispatchWorkgroups(groups);
        }
        if (it === iterations - 1) {
          pass.setPipeline(this.pipes.velocities!);
          pass.dispatchWorkgroups(groups);
        }
      }
      pass.setPipeline(this.pipes.finalize!);
      pass.dispatchWorkgroups(groups);
    }
    pass.end();
    this.prevN = n;
    this.cur = 1 - this.cur;
  }

  destroy(): void {
    for (const x of [this.solver, this.contacts, this.meta, this.pairHist, this.offHist, this.uniform, this.colorUniform]) x.destroy();
  }
}
