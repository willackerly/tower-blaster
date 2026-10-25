// GPU narrowphase: one Manifold per broadphase pair (fixed slot, so the
// output is deterministic and needs no compaction), plus one ground manifold
// per body. A WGSL port of geom/src/manifold.ts, which is its test oracle.
// It follows the reference's order of operations (corner order, clipping
// sequence, first-index tie-breaks, face-axis tolerance and the previous
// axis as the first candidate) so the two agree, not merely look alike.
import { EDGE_ABS, EDGE_REL, FACE_ABS, FACE_INSET, FACE_REL } from '@tb/geom';
import { assertStorageFits } from '@tb/gpu';
import { Body, Manifold, Shape, wgslStruct } from '@tb/schema';

const WG = 64;
const NONE = 0xffffffff;

export const NARROWPHASE_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(Shape)}
${wgslStruct(Manifold)}

struct NP { n: u32, hasGround: u32, margin: f32, groundY: f32 }
@group(0) @binding(0) var<storage, read> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var<storage, read> pairs: array<vec2u>;
@group(0) @binding(3) var<storage, read> total: array<u32, 8>;
@group(0) @binding(4) var<storage, read_write> out: array<Manifold>;
@group(0) @binding(5) var<storage, read_write> ground: array<Manifold>;
@group(0) @binding(6) var<uniform> p: NP;
// Per-body speculative growth (how far the body can move this step); a
// pair's margin is p.margin + sweep[a] + sweep[b], a ground contact's p.margin + sweep[i].
@group(0) @binding(7) var<storage, read> sweep: array<f32>;
// Per pair slot: (last step's slot, last step's SAT axis), NONE when new; see AvbdSolver.match.
@group(0) @binding(8) var<storage, read> prev: array<vec2u>;
var<private> margin: f32;

const NONE = ${NONE}u;
// The reference's SAT tolerances (geom/src/manifold.ts).
const EDGE_REL = ${EDGE_REL};
const EDGE_ABS = ${EDGE_ABS};
const FACE_REL = ${FACE_REL};
const FACE_ABS = ${FACE_ABS};
const FACE_INSET = ${FACE_INSET};

struct Box { c: vec3f, ax: mat3x3f, h: vec3f }

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn boxOf(i: u32) -> Box {
  let b = bodies[i];
  return Box(b.pos, mat3x3f(qrot(b.rot, vec3f(1, 0, 0)), qrot(b.rot, vec3f(0, 1, 0)), qrot(b.rot, vec3f(0, 0, 1))), shapes[b.shape].half);
}

fn projR(b: Box, n: vec3f) -> f32 {
  return b.h.x * abs(dot(b.ax[0], n)) + b.h.y * abs(dot(b.ax[1], n)) + b.h.z * abs(dot(b.ax[2], n));
}

fn emptyManifold(a: u32, b: u32) -> Manifold {
  var m: Manifold;
  m.a = a;
  m.b = b;
  m.count = 0u;
  m.normal = vec3f(0.0, 1.0, 0.0);
  m.axis = NONE;
  return m;
}

fn setPoint(m: ptr<function, Manifold>, k: u32, v: vec4f) {
  switch k {
    case 0u: { (*m).p0 = v; }
    case 1u: { (*m).p1 = v; }
    case 2u: { (*m).p2 = v; }
    default: { (*m).p3 = v; }
  }
}

fn x2(u: vec3f, v: vec3f, n: vec3f) -> f32 { return abs(dot(cross(u, v), n)); }

// Twice the hull area of 4 points about n, as hull4x2 in the reference.
fn hull4x2(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f, n: vec3f) -> f32 {
  return max(max(max(x2(p2 - p0, p3 - p1, n), x2(p3 - p0, p2 - p1, n)), max(x2(p1 - p0, p3 - p2, n), x2(p1 - p0, p2 - p0, n))),
             max(max(x2(p1 - p0, p3 - p0, n), x2(p2 - p0, p3 - p0, n)), x2(p2 - p1, p3 - p1, n)));
}

// Keep at most 4 of n points (xyz point, w depth), as reduceContacts does:
// the deepest (first index on ties), then the 3 others with the widest
// support, searched over triples in the reference's order.
fn reduceInto(m: ptr<function, Manifold>, pts: ptr<function, array<vec4f, 8>>, n: u32, normal: vec3f) {
  if (n <= 4u) {
    for (var k = 0u; k < n; k++) { setPoint(m, k, (*pts)[k]); }
    (*m).count = n;
    return;
  }
  var d = 0u;
  for (var k = 1u; k < n; k++) { if ((*pts)[k].w > (*pts)[d].w) { d = k; } }
  let a = (*pts)[d].xyz;
  // Rest index r (the points without d) maps to point r + (r >= d).
  var best = -1.0;
  var pick = vec3u(0u, 1u, 2u);
  for (var i = 0u; i < n - 1u; i++) {
    for (var j = i + 1u; j < n - 1u; j++) {
      for (var k = j + 1u; k < n - 1u; k++) {
        let t = vec3u(i, j, k) + vec3u(vec3u(i, j, k) >= vec3u(d));
        let s = hull4x2(a, (*pts)[t.x].xyz, (*pts)[t.y].xyz, (*pts)[t.z].xyz, normal);
        if (s > best) { best = s; pick = t; }
      }
    }
  }
  setPoint(m, 0u, (*pts)[d]);
  setPoint(m, 1u, (*pts)[pick.x]);
  setPoint(m, 2u, (*pts)[pick.y]);
  setPoint(m, 3u, (*pts)[pick.z]);
  (*m).count = 4u;
}

// s beats best by abs + rel * |best| (see beats in @tb/geom: valid for gaps too).
fn beats(s: f32, best: f32, relTol: f32, absTol: f32) -> bool {
  return s > best + absTol + relTol * abs(best);
}

fn clipPoly(poly: ptr<function, array<vec3f, 8>>, n: u32, pn: vec3f, d: f32) -> u32 {
  var outp: array<vec3f, 8>;
  var c = 0u;
  for (var i = 0u; i < n; i++) {
    let a = (*poly)[i];
    let b = (*poly)[(i + 1u) % n];
    let da = dot(a, pn) - d;
    let db = dot(b, pn) - d;
    if (da <= 0.0 && c < 8u) { outp[c] = a; c++; }
    if (((da < 0.0 && db > 0.0) || (da > 0.0 && db < 0.0)) && c < 8u) { outp[c] = a + (b - a) * (da / (da - db)); c++; }
  }
  *poly = outp;
  return c;
}

fn supportEdge(b: Box, k: u32, n: vec3f) -> array<vec3f, 2> {
  var c = b.c;
  for (var i = 0u; i < 3u; i++) {
    if (i == k) { continue; }
    c += b.ax[i] * select(-1.0, 1.0, dot(b.ax[i], n) >= 0.0) * b.h[i];
  }
  let e = b.ax[k] * b.h[k];
  return array<vec3f, 2>(c - e, c + e);
}

fn segmentClosest(p1: vec3f, q1: vec3f, p2: vec3f, q2: vec3f) -> array<vec3f, 2> {
  let d1 = q1 - p1;
  let d2 = q2 - p2;
  let r = p1 - p2;
  let a = dot(d1, d1);
  let e = dot(d2, d2);
  let f = dot(d2, r);
  let c = dot(d1, r);
  let b = dot(d1, d2);
  let den = a * e - b * b;
  var s = 0.0;
  if (den > 1e-12) { s = clamp((b * f - c * e) / den, 0.0, 1.0); }
  var t = (b * s + f) / e;
  if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }
  else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }
  return array<vec3f, 2>(p1 + d1 * s, p2 + d2 * t);
}

fn boxBox(a: Box, b: Box, m: ptr<function, Manifold>, prevAxis: u32) {
  let d = b.c - a.c;
  var faceBest = -3.4e38;
  var faceAxis = vec3f(0.0, 1.0, 0.0);
  var faceOwner = 0u;
  var faceK = 0u;
  // Last step's face axis first (another must beat it by the tolerance), then a's and b's in order.
  var first = 0u;
  if (prevAxis < 6u) { first = prevAxis; }
  for (var t = 0u; t < 6u; t++) {
    var id = first;
    if (t > 0u) { id = t - 1u + select(0u, 1u, t - 1u >= first); }
    let owner = id / 3u;
    let k = id % 3u;
    var n = a.ax[k];
    if (owner == 1u) { n = b.ax[k]; }
    let s = abs(dot(d, n)) - projR(a, n) - projR(b, n);
    if (s > margin) { return; }
    if (t == 0u || beats(s, faceBest, FACE_REL, FACE_ABS)) { faceBest = s; faceAxis = n; faceOwner = owner; faceK = k; }
  }
  var edgeBest = -3.4e38;
  var edgeAxis = vec3f(0.0, 1.0, 0.0);
  var edgeI = 0u;
  var edgeJ = 0u;
  for (var i = 0u; i < 3u; i++) {
    for (var j = 0u; j < 3u; j++) {
      let c = cross(a.ax[i], b.ax[j]);
      let len = length(c);
      if (len < 1e-6) { continue; }
      let n = c / len;
      let s = abs(dot(d, n)) - projR(a, n) - projR(b, n);
      if (s > margin) { return; }
      if (s > edgeBest) { edgeBest = s; edgeAxis = n; edgeI = i; edgeJ = j; }
    }
  }
  if (beats(edgeBest, faceBest, EDGE_REL, EDGE_ABS)) {
    var n = edgeAxis;
    if (dot(n, d) < 0.0) { n = -n; }
    let ea = supportEdge(a, edgeI, n);
    let eb = supportEdge(b, edgeJ, -n);
    let cp = segmentClosest(ea[0], ea[1], eb[0], eb[1]);
    (*m).normal = n;
    (*m).feature = 2u;
    (*m).axis = 6u + 3u * edgeI + edgeJ;
    (*m).p0 = vec4f(0.5 * (cp[0] + cp[1]), -edgeBest);
    (*m).count = 1u;
    return;
  }
  var rf = a;
  var inc = b;
  var toOther = d;
  if (faceOwner == 1u) { rf = b; inc = a; toOther = -d; }
  let nRef = faceAxis * select(-1.0, 1.0, dot(faceAxis, toOther) >= 0.0);
  // Incident face: the face of inc most anti-parallel to nRef.
  var ik = 0u;
  var isg = 1.0;
  var bestDot = 3.4e38;
  for (var k = 0u; k < 3u; k++) {
    let dd = dot(inc.ax[k], nRef);
    if (dd < bestDot) { bestDot = dd; ik = k; isg = 1.0; }
    if (-dd < bestDot) { bestDot = -dd; ik = k; isg = -1.0; }
  }
  let u = (ik + 1u) % 3u;
  let v = (ik + 2u) % 3u;
  // Clip in the reference box's frame (f32 far from the origin would round the inset away).
  let fc = (inc.c - rf.c) + inc.ax[ik] * (isg * inc.h[ik]);
  let eu = inc.ax[u] * inc.h[u];
  let ev = inc.ax[v] * inc.h[v];
  var poly: array<vec3f, 8>;
  if (isg > 0.0) {
    poly[0] = fc + eu + ev; poly[1] = fc - eu + ev; poly[2] = fc - eu - ev; poly[3] = fc + eu - ev;
  } else {
    poly[0] = fc + eu - ev; poly[1] = fc - eu - ev; poly[2] = fc - eu + ev; poly[3] = fc + eu + ev;
  }
  var count = 4u;
  for (var s = 1u; s <= 2u; s++) {
    let k = (faceK + s) % 3u;
    let ax = rf.ax[k];
    let h = rf.h[k] - min(FACE_INSET, 0.1 * rf.h[k]);
    count = clipPoly(&poly, count, ax, h);
    count = clipPoly(&poly, count, -ax, h);
  }
  var pts: array<vec4f, 8>;
  var np = 0u;
  for (var k = 0u; k < count; k++) {
    let q = poly[k];
    let s = dot(q, nRef) - rf.h[faceK];
    if (s <= margin) { pts[np] = vec4f(rf.c + (q - nRef * (s * 0.5)), -s); np++; }
  }
  if (np == 0u) { return; }
  var normal = nRef;
  if (faceOwner == 1u) { normal = -nRef; }
  (*m).normal = normal;
  (*m).feature = faceOwner;
  (*m).axis = 3u * faceOwner + faceK;
  reduceInto(m, &pts, np, normal);
}

// Sphere (centre c, radius r) vs box: normal from the box to the sphere.
fn sphereBox(c: vec3f, r: f32, b: Box, m: ptr<function, Manifold>) {
  let d = c - b.c;
  let local = transpose(b.ax) * d;
  if (all(abs(local) <= b.h)) {
    var k = 0u;
    var best = 3.4e38;
    for (var i = 0u; i < 3u; i++) { let g = b.h[i] - abs(local[i]); if (g < best) { best = g; k = i; } }
    let n = b.ax[k] * select(-1.0, 1.0, local[k] >= 0.0);
    (*m).normal = n;
    (*m).p0 = vec4f(c - n * r, r + best);
    (*m).count = 1u;
    return;
  }
  let q = b.c + b.ax * clamp(local, -b.h, b.h);
  let v = c - q;
  let dist = length(v);
  if (dist - r > margin) { return; }
  let n = v / dist;
  (*m).normal = n;
  (*m).p0 = vec4f(0.5 * (q + c - n * r), r - dist);
  (*m).count = 1u;
}

fn sphereSphere(c1: vec3f, r1: f32, c2: vec3f, r2: f32, m: ptr<function, Manifold>) {
  let v = c2 - c1;
  let dist = length(v);
  if (dist - r1 - r2 > margin) { return; }
  var n = vec3f(0.0, 1.0, 0.0);
  if (dist > 1e-12) { n = v / dist; }
  (*m).normal = n;
  (*m).p0 = vec4f(0.5 * ((c1 + n * r1) + (c2 - n * r2)), r1 + r2 - dist);
  (*m).count = 1u;
}

@compute @workgroup_size(${WG})
fn pairsMain(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let ij = pairs[k];
  margin = p.margin + sweep[ij.x] + sweep[ij.y];
  var m = emptyManifold(ij.x, ij.y);
  let sa = shapes[bodies[ij.x].shape];
  let sb = shapes[bodies[ij.y].shape];
  let pa = bodies[ij.x].pos;
  let pb = bodies[ij.y].pos;
  if (sa.kind == 0u && sb.kind == 0u) {
    boxBox(boxOf(ij.x), boxOf(ij.y), &m, prev[k].y);
  } else if (sa.kind == 1u && sb.kind == 1u) {
    sphereSphere(pa, sa.half.x, pb, sb.half.x, &m);
  } else if (sa.kind == 1u) {
    sphereBox(pa, sa.half.x, boxOf(ij.y), &m);
    m.normal = -m.normal; // reference gives box -> sphere; we need a -> b
  } else {
    sphereBox(pb, sb.half.x, boxOf(ij.x), &m);
  }
  out[k] = m;
}

@compute @workgroup_size(${WG})
fn groundMain(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  var m = emptyManifold(i, NONE);
  if (p.hasGround == 0u) { ground[i] = m; return; }
  margin = p.margin + sweep[i];
  let s = shapes[bodies[i].shape];
  let c = bodies[i].pos;
  if (s.kind == 1u) {
    let sep = c.y - s.half.x - p.groundY;
    if (sep <= margin) { m.p0 = vec4f(c.x, c.y - s.half.x - sep * 0.5, c.z, -sep); m.count = 1u; }
  } else {
    let b = boxOf(i);
    var pts: array<vec4f, 8>;
    var np = 0u;
    for (var sx = -1.0; sx <= 1.0; sx += 2.0) {
      for (var sy = -1.0; sy <= 1.0; sy += 2.0) {
        for (var sz = -1.0; sz <= 1.0; sz += 2.0) {
          let q = b.c + b.ax[0] * (sx * b.h.x) + b.ax[1] * (sy * b.h.y) + b.ax[2] * (sz * b.h.z);
          let sep = q.y - p.groundY;
          if (sep <= margin) { pts[np] = vec4f(q.x, q.y - sep * 0.5, q.z, -sep); np++; }
        }
      }
    }
    if (np > 0u) { reduceInto(&m, &pts, np, vec3f(0.0, 1.0, 0.0)); }
  }
  ground[i] = m;
}`;

export interface NarrowphaseParams { margin: number; ground: { y: number } | null }

export class Narrowphase {
  /** Manifold per broadphase pair slot (count 0 = no contact). */
  readonly manifolds: GPUBuffer;
  /** Manifold per body against the ground (b = 0xffffffff). */
  readonly groundManifolds: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly pairPipe: GPUComputePipeline;
  private readonly groundPipe: GPUComputePipeline;
  private readonly bind: GPUBindGroup;
  private readonly zeroSweep: GPUBuffer | null;
  private readonly noPrev: GPUBuffer | null = null;

  /**
   * @param bodies Body records; @param shapes Shape table indexed by Body.shape
   * @param pairs, total the Broadphase outputs (total[0..2] are indirect args)
   */
  /**
   * @param sweep optional f32 per body added to the margin (see the shader); zero when omitted
   * @param prev optional vec2u per pair slot, (last step's slot, last step's axis) from AvbdSolver.match; no history when omitted
   */
  constructor(private readonly device: GPUDevice, bodies: GPUBuffer, shapes: GPUBuffer, pairs: GPUBuffer, private readonly total: GPUBuffer, readonly capacity: number, readonly maxPairs: number, sweep?: GPUBuffer, prev?: GPUBuffer) {
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(Manifold.size, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label }));
    this.manifolds = buf(maxPairs * Manifold.size, 'np manifolds');
    this.groundManifolds = buf(capacity * Manifold.size, 'np ground manifolds');
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.zeroSweep = sweep ? null : device.createBuffer({ size: Math.max(16, capacity * 4), usage: GPUBufferUsage.STORAGE, label: 'np zero sweep' });
    if (!prev) {
      this.noPrev = device.createBuffer({ size: Math.max(16, maxPairs * 8), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true, label: 'np no history' });
      new Uint32Array(this.noPrev.getMappedRange()).fill(NONE);
      this.noPrev.unmap();
    }
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding <= 3 || binding >= 7 ? 'read-only-storage' : binding === 6 ? 'uniform' : 'storage' },
      })),
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: NARROWPHASE_WGSL, label: 'narrowphase' });
    this.pairPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'pairsMain' } });
    this.groundPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'groundMain' } });
    this.bind = device.createBindGroup({
      layout,
      entries: [bodies, shapes, pairs, total, this.manifolds, this.groundManifolds, this.uniform, sweep ?? this.zeroSweep!, prev ?? this.noPrev!].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  /** Record into an open compute pass, after the broadphase has written pairs and total. */
  encode(pass: GPUComputePassEncoder, n: number, params: NarrowphaseParams): void {
    const u = new ArrayBuffer(16);
    new Uint32Array(u, 0, 2).set([n, params.ground ? 1 : 0]);
    new Float32Array(u, 8, 2).set([params.margin, params.ground?.y ?? 0]);
    this.device.queue.writeBuffer(this.uniform, 0, u);
    pass.setBindGroup(0, this.bind);
    pass.setPipeline(this.pairPipe);
    pass.dispatchWorkgroupsIndirect(this.total, 0);
    if (n > 0) {
      pass.setPipeline(this.groundPipe);
      pass.dispatchWorkgroups(Math.ceil(n / WG));
    }
  }

  destroy(): void {
    for (const b of [this.manifolds, this.groundManifolds, this.uniform]) b.destroy();
    this.zeroSweep?.destroy();
    this.noPrev?.destroy();
  }
}
