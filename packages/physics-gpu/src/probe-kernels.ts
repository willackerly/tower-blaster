// Synthetic kernels for the solver probe (probe.ts): the per-point work of
// the primal sweep in isolation (P3), and the synchronization a chunked
// solver would use instead of a dispatch per colour (P4). Each comes with a
// CPU reference or a checkable result, so a timing is only reported for a
// kernel that computes what it claims to.
//
// P3: one thread per body walks P contact points. A point is a record of S
// bytes (S / 16 vec4s, AoS like SolverContact, or one stream per vec4 for
// coalescing) plus the other body's pose, read at an index the record holds.
// The math is the primal's accumulate() (constraint values, force clamp,
// J^T K J and the gradient), then a 6x6 LDL^T solve; the thread writes the
// 6 floats of the step. The record decodes into the fields the primal
// reads (96 bytes of them). A shorter record aliases the missing vec4s onto
// the ones it has (vec4 j reads stream j mod S/16), so every size does the
// same arithmetic and only the bytes loaded differ; at 128 bytes the two
// extra vec4s are mixed in (6 FMAs) so their loads are not dead.
//
// The pose (position, quaternion) is used as the other body's (dp, phi):
// the primal reads exactly two vec3s of the other body, and this keeps that.

/** Bodies a P3 workgroup preloads into shared memory ((c), (d)); every point's other body lies in its workgroup's window of this many. */
export const PROBE_TILE = 256;
const WG = 64;

export const P3_VARIANTS = ['a', 'b', 'c', 'd', 'e'] as const;
export type P3Variant = (typeof P3_VARIANTS)[number];
export const P3_VARIANT_INFO: Record<P3Variant, { label: string; registers: boolean; shared: boolean; soa: boolean }> = {
  a: { label: 'private lhs[36], dynamic loops (as solver.ts)', registers: false, shared: false, soa: false },
  b: { label: '21 named registers, unrolled', registers: true, shared: false, soa: false },
  c: { label: '(a), other pose from shared memory', registers: false, shared: true, soa: false },
  d: { label: '(b) + (c)', registers: true, shared: true, soa: false },
  e: { label: '(a), records split into SoA', registers: false, shared: false, soa: true },
};
export const RECORD_SIZES = [32, 64, 96, 128] as const;

/**
 * Uniforms shared by the P3 and P4(d) kernels (32 bytes). stride: records
 * per body in the buffer (P3: the largest P swept, so one buffer serves
 * every P); nposes: P3, bodies in the pose buffer (a multiple of
 * PROBE_TILE); P4(d), tiles that have their own records. iters: P4(d).
 */
export interface KernelParams { threads: number; points: number; stride: number; nposes: number; alpha: number; mh: number; ih: number; iters: number }
export const KERNEL_PARAMS_BYTES = 32;
export function kernelParams(k: KernelParams): ArrayBuffer {
  const u = new ArrayBuffer(KERNEL_PARAMS_BYTES);
  new Uint32Array(u, 0, 4).set([k.threads, k.points, k.stride, k.nposes]);
  new Float32Array(u, 16, 3).set([k.alpha, k.mh, k.ih]);
  new Uint32Array(u, 28, 1)[0] = k.iters;
  return u;
}
/** A cube of unit mass and side at 60 Hz: m / h^2 and (I / m = 1/6) / h^2. */
export const BODY_PARAMS = { alpha: 0.9, mh: 3600, ih: 600 };

const PARAMS_WGSL = /* wgsl */ `
struct Params { threads: u32, points: u32, stride: u32, nposes: u32, alpha: f32, mh: f32, ih: f32, iters: u32 }`;

/** Record vec4 j of body (thread) i, point k, in a buffer of `threads` bodies. */
const recIndex = (soa: boolean, V: number, j: number) =>
  soa ? `rec[${j}u * u.threads * u.stride + k * u.threads + i]` : `rec[(i * u.stride + k) * ${V}u + ${j}u]`;

// The fields of a point, decoded from V vec4 loads (see the header).
function pointWgsl(S: number, soa: boolean): string {
  const V = S / 16;
  const R = (j: number) => `r${j % V}`;
  const loads = Array.from({ length: V }, (_, j) => `  let r${j} = ${recIndex(soa, V, j)};`).join('\n');
  return /* wgsl */ `
struct Pt { n: vec3f, t1: vec3f, raw: vec3f, rbw: vec3f, c0: vec3f, lt: vec2f, mu: f32, lambdaN: f32, kN: f32, kT: f32, onB: bool, other: u32 }
fn loadPt(i: u32, k: u32) -> Pt {
${loads}
  var p: Pt;
  p.n = ${R(0)}.xyz; p.other = u32(${R(0)}.w * 16777216.0);
  p.t1 = ${R(1)}.xyz; p.mu = ${R(1)}.w;
  p.raw = ${R(2)}.xyz; p.lambdaN = -100.0 * ${R(2)}.w;
  p.rbw = ${R(3)}.xyz; p.kN = 1000.0 + 10000.0 * ${R(3)}.w;
  p.c0 = 0.01 * ${R(4)}.xyz; p.kT = 1000.0 + 10000.0 * ${R(4)}.w;
  p.lt = 10.0 * ${R(5)}.xy; p.onB = ${R(5)}.z >= 0.0;${V === 8 ? `
  p.raw += 0.001 * r6.xyz; p.rbw += 0.001 * r7.xyz; p.lt += vec2f(r6.w, r7.w);` : ''}
  return p;
}
struct Pose { dp: vec3f, phi: vec3f }
// Constraint values and clamped forces, as the primal's evalC() and accumulate().
struct Force { F: vec3f, kn: f32, kt: f32 }
fn force(p: Pt, me: Pose, o: Pose) -> Force {
  let dpA = select(me.dp, o.dp, p.onB); let phiA = select(me.phi, o.phi, p.onB);
  let dpB = select(o.dp, me.dp, p.onB); let phiB = select(o.phi, me.phi, p.onB);
  let t2 = cross(p.n, p.t1);
  var c = vec3f(select(p.c0.x, (1.0 - u.alpha) * p.c0.x, p.c0.x < 0.0), (1.0 - u.alpha) * p.c0.y, (1.0 - u.alpha) * p.c0.z);
  c += vec3f(
    dot(p.n, dpB) + dot(cross(p.rbw, p.n), phiB),
    dot(p.t1, dpB) + dot(cross(p.rbw, p.t1), phiB),
    dot(t2, dpB) + dot(cross(p.rbw, t2), phiB));
  c -= vec3f(
    dot(p.n, dpA) + dot(cross(p.raw, p.n), phiA),
    dot(p.t1, dpA) + dot(cross(p.raw, p.t1), phiA),
    dot(t2, dpA) + dot(cross(p.raw, t2), phiA));
  let fn0 = min(0.0, p.kN * c.x + p.lambdaN);
  let bound = p.mu * abs(p.lambdaN);
  let z = p.kT * c.yz + p.lt;
  let fl = length(z);
  var s = 1.0;
  if (fl > bound) { s = select(0.0, bound / fl, fl > 0.0); }
  return Force(vec3f(fn0, s * z.x, s * z.y), p.kN, p.kT * s);
}`;
}

// (a), (c), (e): the Hessian in a private array, built and solved with
// dynamically indexed loops, line for line as solver.ts.
const ARRAY_SOLVE = /* wgsl */ `
var<private> lhs: array<f32, 36>;
var<private> rhs: array<f32, 6>;
fn jrow(p: Pt, r: u32) -> array<f32, 6> {
  var v = p.n;
  if (r == 1u) { v = p.t1; } else if (r == 2u) { v = cross(p.n, p.t1); }
  var w = cross(p.rbw, v);
  if (!p.onB) { w = -cross(p.raw, v); v = -v; }
  return array<f32, 6>(v.x, v.y, v.z, w.x, w.y, w.z);
}
fn accumulate(p: Pt, f: Force) {
  let F = array<f32, 3>(f.F.x, f.F.y, f.F.z);
  let K = array<f32, 9>(f.kn, 0.0, 0.0, 0.0, f.kt, 0.0, 0.0, 0.0, f.kt);
  let J = array<array<f32, 6>, 3>(jrow(p, 0u), jrow(p, 1u), jrow(p, 2u));
  for (var r = 0u; r < 3u; r++) {
    for (var v = 0u; v < 6u; v++) { rhs[v] += J[r][v] * F[r]; }
    for (var q = 0u; q < 3u; q++) {
      let k = K[3u * r + q];
      if (k == 0.0) { continue; }
      for (var a = 0u; a < 6u; a++) {
        let ja = k * J[r][a];
        for (var b = 0u; b < 6u; b++) { lhs[6u * a + b] += ja * J[q][b]; }
      }
    }
  }
}
fn solveBody(i: u32, me: Pose, base: u32) -> array<f32, 6> {
  for (var k = 0u; k < 36u; k++) { lhs[k] = 0.0; }
  for (var r = 0u; r < 3u; r++) {
    lhs[7u * r] = u.mh; lhs[7u * (r + 3u)] = u.ih;
    rhs[r] = u.mh * me.dp[r]; rhs[3u + r] = u.ih * me.phi[r];
  }
  for (var k = 0u; k < u.points; k++) {
    let p = loadPt(i, k);
    accumulate(p, force(p, me, fetchOther(p.other, base)));
  }
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
  return x;
}`;

// (b), (d), P4(d): the upper triangle of the Hessian in 21 named scalars and
// the gradient in 6, the per-point update and the LDL^T solve fully unrolled.
function registerSolveWgsl(): string {
  const h = (a: number, b: number) => (a <= b ? `h${a}${b}` : `h${b}${a}`);
  const decl: string[] = [];
  for (let a = 0; a < 6; a++) for (let b = a; b < 6; b++) decl.push(`  var h${a}${b} = ${a === b ? (a < 3 ? 'u.mh' : 'u.ih') : '0.0'};`);
  for (let a = 0; a < 6; a++) decl.push(`  var g${a} = ${a < 3 ? `u.mh * me.dp.${'xyz'[a]}` : `u.ih * me.phi.${'xyz'[a - 3]}`};`);
  const J: string[] = [];
  for (let r = 0; r < 3; r++) for (let a = 0; a < 6; a++) J.push(`    let j${r}${a} = ${a < 3 ? `a${r}` : `w${r}`}.${'xyz'[a % 3]};`);
  const acc: string[] = [];
  for (let a = 0; a < 6; a++) acc.push(`    g${a} += j0${a} * f.F.x + j1${a} * f.F.y + j2${a} * f.F.z;`);
  for (let a = 0; a < 6; a++) for (let b = a; b < 6; b++) acc.push(`    h${a}${b} += f.kn * j0${a} * j0${b} + f.kt * (j1${a} * j1${b} + j2${a} * j2${b});`);
  const ldl: string[] = [];
  for (let j = 0; j < 6; j++) {
    const dj = [h(j, j), ...Array.from({ length: j }, (_, k) => ` - l${j}${k} * l${j}${k} * d${k}`)].join('');
    ldl.push(`  let d${j} = ${dj};`);
    for (let r = j + 1; r < 6; r++) {
      const s = [h(r, j), ...Array.from({ length: j }, (_, k) => ` - l${r}${k} * l${j}${k} * d${k}`)].join('');
      ldl.push(`  let l${r}${j} = (${s}) / d${j};`);
    }
  }
  for (let r = 0; r < 6; r++) ldl.push(`  let z${r} = g${r}${Array.from({ length: r }, (_, k) => ` - l${r}${k} * z${k}`).join('')};`);
  for (let r = 0; r < 6; r++) ldl.push(`  let y${r} = z${r} / d${r};`);
  for (let r = 5; r >= 0; r--) ldl.push(`  let x${r} = y${r}${Array.from({ length: 5 - r }, (_, m) => ` - l${r + 1 + m}${r} * x${r + 1 + m}`).join('')};`);
  return /* wgsl */ `
fn solveBody(i: u32, me: Pose, base: u32) -> array<f32, 6> {
${decl.join('\n')}
  for (var k = 0u; k < u.points; k++) {
    let p = loadPt(i, k);
    let f = force(p, me, fetchOther(p.other, base));
    let sg = select(-1.0, 1.0, p.onB);
    let lev = select(p.raw, p.rbw, p.onB);
    let t2 = cross(p.n, p.t1);
    let a0 = sg * p.n; let w0 = sg * cross(lev, p.n);
    let a1 = sg * p.t1; let w1 = sg * cross(lev, p.t1);
    let a2 = sg * t2; let w2 = sg * cross(lev, t2);
${J.join('\n')}
${acc.join('\n')}
  }
${ldl.join('\n')}
  return array<f32, 6>(x0, x1, x2, x3, x4, x5);
}`;
}

/** P3 kernel `variant` at record size S, entry point main. */
export function p3Wgsl(variant: P3Variant, S: number): string {
  const v = P3_VARIANT_INFO[variant];
  return /* wgsl */ `
${PARAMS_WGSL}
@group(0) @binding(0) var<storage, read> rec: array<vec4f>;
@group(0) @binding(1) var<storage, read> pose: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@group(0) @binding(3) var<uniform> u: Params;
${pointWgsl(S, v.soa)}
${v.shared ? `var<workgroup> sh: array<vec4f, ${2 * PROBE_TILE}>;
fn fetchOther(o: u32, base: u32) -> Pose { let j = 2u * (o - base); return Pose(sh[j].xyz, sh[j + 1u].xyz); }`
    : `fn fetchOther(o: u32, base: u32) -> Pose { return Pose(pose[2u * o].xyz, pose[2u * o + 1u].xyz); }`}
${v.registers ? registerSolveWgsl() : ARRAY_SOLVE}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let base = (wid.x * ${PROBE_TILE}u) % u.nposes;
${v.shared ? `  for (var j = lid; j < ${2 * PROBE_TILE}u; j += ${WG}u) { sh[j] = pose[2u * base + j]; }
  workgroupBarrier();` : ''}
  let i = gid.x;
  if (i >= u.threads) { return; }
  let s = i % u.nposes;
  let x = solveBody(i, Pose(pose[2u * s].xyz, pose[2u * s + 1u].xyz), base);
  for (var r = 0u; r < 6u; r++) { out[6u * i + r] = x[r]; }
}`;
}

/** The empty-dispatch baseline for P3: same bindings and threads, one write each. */
export const P3_EMPTY_WGSL = /* wgsl */ `
${PARAMS_WGSL}
@group(0) @binding(0) var<storage, read> rec: array<vec4f>;
@group(0) @binding(1) var<storage, read> pose: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@group(0) @binding(3) var<uniform> u: Params;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u.threads) { return; }
  out[6u * gid.x] = u.alpha;
}`;

// --- P3 data and CPU reference -------------------------------------------

function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
/** A small PRNG for one record, so a record's values do not depend on the layout or size it is written in. */
function rng(seed: number) {
  let s = hash32(seed) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** The window of PROBE_TILE poses thread i's points refer to: its workgroup's (P3). */
export const windowBase = (i: number, nposes: number) => (Math.floor(i / WG) * PROBE_TILE) % nposes;
export const posesFor = (threads: number) => PROBE_TILE * Math.ceil(Math.max(threads, PROBE_TILE) / PROBE_TILE);

/**
 * The 8 vec4s of record (body, point) as the probe writes them; `other` is
 * the other body's index (exact in f32 as other * 2^-24).
 */
function recordVec4s(seed: number, other: number): number[] {
  const r = rng(seed);
  const u = () => 2 * r() - 1;
  let n = [u(), u(), u()];
  let l = Math.hypot(...n) || 1;
  n = n.map((x) => x / l);
  // t1: n x e, normalized (e a random direction).
  const e = [u(), u(), u()];
  let t = [n[1]! * e[2]! - n[2]! * e[1]!, n[2]! * e[0]! - n[0]! * e[2]!, n[0]! * e[1]! - n[1]! * e[0]!];
  l = Math.hypot(...t) || 1;
  t = t.map((x) => x / l);
  return [
    n[0]!, n[1]!, n[2]!, other * 2 ** -24,
    t[0]!, t[1]!, t[2]!, 0.3 + 0.5 * r(),
    0.7 * u(), 0.7 * u(), 0.7 * u(), r(),
    0.7 * u(), 0.7 * u(), 0.7 * u(), r(),
    u(), u(), u(), r(),
    u(), u(), u(), 0,
    u(), u(), u(), u(),
    u(), u(), u(), u(),
  ];
}

export type PoseOrder = 'sorted' | 'random';

/**
 * P3 records for `threads` bodies of `stride` points each at record size S,
 * AoS or SoA. A point's other body is in the thread's window: sorted, the
 * neighbouring pose (lanes of a SIMD group read consecutive poses);
 * random, anywhere in it.
 */
export function p3Records(threads: number, stride: number, S: number, order: PoseOrder, soa: boolean, seed = 1): Float32Array {
  const V = S / 16, nposes = posesFor(threads);
  const out = new Float32Array(threads * stride * V * 4);
  for (let i = 0; i < threads; i++) {
    const base = windowBase(i, nposes);
    for (let k = 0; k < stride; k++) {
      const id = i * stride + k;
      const other = base + (order === 'sorted' ? ((i % WG) + k) % PROBE_TILE : hash32(id * 2 + 1 + seed * 0x9e3779b9) % PROBE_TILE);
      const v = recordVec4s(id + seed * 0x51ed27, other);
      for (let j = 0; j < V; j++) {
        const at = soa ? (j * threads * stride + k * threads + i) * 4 : (id * V + j) * 4;
        for (let c = 0; c < 4; c++) out[at + c] = v[4 * j + c]!;
      }
    }
  }
  return out;
}

/** Poses (dp in xyz of vec4 2b, phi in xyz of vec4 2b + 1), small: displacements within a step. */
export function probePoses(count: number, seed = 1): Float32Array {
  const r = rng(seed * 7919 + 13);
  const out = new Float32Array(count * 8);
  for (let b = 0; b < count; b++) {
    for (let c = 0; c < 3; c++) { out[8 * b + c] = 0.02 * r() - 0.01; out[8 * b + 4 + c] = 0.02 * r() - 0.01; }
    out[8 * b + 7] = 1;
  }
  return out;
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Record vec4 j as the kernel reads it (aliasing included), from a buffer laid out by p3Records. */
type RecordReader = (j: number) => [number, number, number, number];

/**
 * One body's update, in f64, as the kernels compute it: me is (dp, phi);
 * point k's record via read(k), the other body's (dp, phi) via other(index).
 */
export function solveBodyRef(me: { dp: V3; phi: V3 }, points: number, read: (k: number) => RecordReader, V: number, other: (o: number) => { dp: V3; phi: V3 }, p = BODY_PARAMS): number[] {
  const H = new Float64Array(36), g = new Float64Array(6);
  for (let r = 0; r < 3; r++) { H[7 * r] = p.mh; H[7 * (r + 3)] = p.ih; g[r] = p.mh * me.dp[r]!; g[3 + r] = p.ih * me.phi[r]!; }
  for (let k = 0; k < points; k++) {
    const rd = read(k);
    const R = (j: number) => rd(j % V);
    const r0 = R(0), r1 = R(1), r2 = R(2), r3 = R(3), r4 = R(4), r5 = R(5);
    const n: V3 = [r0[0], r0[1], r0[2]], t1: V3 = [r1[0], r1[1], r1[2]];
    const o = other(Math.round(r0[3] * 2 ** 24));
    let raw: V3 = [r2[0], r2[1], r2[2]], rbw: V3 = [r3[0], r3[1], r3[2]];
    let lt = [10 * r5[0], 10 * r5[1]];
    if (V === 8) {
      const r6 = rd(6), r7 = rd(7);
      raw = [raw[0] + 0.001 * r6[0], raw[1] + 0.001 * r6[1], raw[2] + 0.001 * r6[2]];
      rbw = [rbw[0] + 0.001 * r7[0], rbw[1] + 0.001 * r7[1], rbw[2] + 0.001 * r7[2]];
      lt = [lt[0]! + r6[3], lt[1]! + r7[3]];
    }
    const mu = r1[3], lambdaN = -100 * r2[3], kN = 1000 + 10000 * r3[3], kT = 1000 + 10000 * r4[3];
    const c0 = [0.01 * r4[0], 0.01 * r4[1], 0.01 * r4[2]];
    const onB = r5[2] >= 0;
    const A = onB ? o : me, B = onB ? me : o;
    const t2 = cross(n, t1);
    const a = p.alpha;
    const C = [c0[0]! < 0 ? (1 - a) * c0[0]! : c0[0]!, (1 - a) * c0[1]!, (1 - a) * c0[2]!];
    const rows = [n, t1, t2];
    for (let r = 0; r < 3; r++) C[r]! += dot(rows[r]!, B.dp) + dot(cross(rbw, rows[r]!), B.phi) - dot(rows[r]!, A.dp) - dot(cross(raw, rows[r]!), A.phi);
    const fn0 = Math.min(0, kN * C[0]! + lambdaN);
    const bound = mu * Math.abs(lambdaN);
    const z = [kT * C[1]! + lt[0]!, kT * C[2]! + lt[1]!];
    const fl = Math.hypot(z[0]!, z[1]!);
    let s = 1;
    if (fl > bound) s = fl > 0 ? bound / fl : 0;
    const F = [fn0, s * z[0]!, s * z[1]!], K = [kN, kT * s, kT * s];
    const sg = onB ? 1 : -1, lev = onB ? rbw : raw;
    for (let r = 0; r < 3; r++) {
      const w = cross(lev, rows[r]!);
      const j = [...rows[r]!, ...w].map((x) => sg * x);
      for (let u = 0; u < 6; u++) {
        g[u]! += j[u]! * F[r]!;
        for (let v = 0; v < 6; v++) H[6 * u + v]! += K[r]! * j[u]! * j[v]!;
      }
    }
  }
  return ldlSolve(H, g);
}

function ldlSolve(H: Float64Array, g: Float64Array): number[] {
  const L = new Float64Array(36), D = new Float64Array(6), x = new Array<number>(6).fill(0);
  for (let j = 0; j < 6; j++) {
    let d = H[7 * j]!;
    for (let k = 0; k < j; k++) d -= L[6 * j + k]! ** 2 * D[k]!;
    D[j] = d;
    for (let r = j + 1; r < 6; r++) {
      let s = H[6 * r + j]!;
      for (let k = 0; k < j; k++) s -= L[6 * r + k]! * L[6 * j + k]! * D[k]!;
      L[6 * r + j] = s / d;
    }
  }
  for (let r = 0; r < 6; r++) { let s = g[r]!; for (let k = 0; k < r; k++) s -= L[6 * r + k]! * x[k]!; x[r] = s; }
  for (let r = 0; r < 6; r++) x[r] = x[r]! / D[r]!;
  for (let r = 5; r >= 0; r--) { let s = x[r]!; for (let k = r + 1; k < 6; k++) s -= L[6 * k + r]! * x[k]!; x[r] = s; }
  return x;
}

/** The P3 kernels' output for every thread, in f64. */
export function p3Reference(records: Float32Array, poses: Float32Array, threads: number, points: number, stride: number, S: number, soa: boolean): Float64Array {
  const V = S / 16, nposes = posesFor(threads);
  const pose = (b: number) => ({ dp: [poses[8 * b]!, poses[8 * b + 1]!, poses[8 * b + 2]!] as V3, phi: [poses[8 * b + 4]!, poses[8 * b + 5]!, poses[8 * b + 6]!] as V3 });
  const out = new Float64Array(6 * threads);
  for (let i = 0; i < threads; i++) {
    const read = (k: number): RecordReader => (j) => {
      const at = soa ? (j * threads * stride + k * threads + i) * 4 : ((i * stride + k) * V + j) * 4;
      return [records[at]!, records[at + 1]!, records[at + 2]!, records[at + 3]!];
    };
    out.set(solveBodyRef(pose(i % nposes), points, read, V, pose), 6 * i);
  }
  return out;
}

// --- P4 ------------------------------------------------------------------

/**
 * P4(a): `rounds` rounds of a neighbour exchange through shared memory,
 * two workgroupBarriers each (entry `barriers`), and the same work on the
 * thread's own slot with no barrier (entry `nobarriers`), its baseline.
 * Both write each thread's final value to out; the first is checkable
 * (exchangeRef).
 */
export function barrierWgsl(threads: number): string {
  return /* wgsl */ `
struct Q { rounds: u32, groups: u32, maxPolls: u32, sync: u32 }
@group(0) @binding(0) var<storage, read_write> buf: array<u32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> q: Q;
var<workgroup> sh: array<u32, ${threads}>;
@compute @workgroup_size(${threads})
fn barriers(@builtin(local_invocation_index) lid: u32) {
  var v = lid;
  sh[lid] = v;
  workgroupBarrier();
  for (var r = 0u; r < q.rounds; r++) {
    v = sh[(lid + 1u) % ${threads}u] + v * 3u + 1u;
    workgroupBarrier();
    sh[lid] = v;
    workgroupBarrier();
  }
  out[lid] = v;
}
@compute @workgroup_size(${threads})
fn nobarriers(@builtin(local_invocation_index) lid: u32) {
  var v = lid;
  sh[lid] = v;
  for (var r = 0u; r < q.rounds; r++) {
    v = sh[lid] + v * 3u + 1u;
    sh[lid] = v;
  }
  out[lid] = v;
}
// P4(b): one round per dispatch, through global memory: reads buf, writes out (ping-pong).
@compute @workgroup_size(${threads})
fn exchange(@builtin(local_invocation_index) lid: u32) {
  out[lid] = buf[(lid + 1u) % ${threads}u] + buf[lid] * 3u + 1u;
}`;
}

/** What `barriers` writes (and N `exchange` dispatches leave): v_l <- v_{l+1} + 3 v_l + 1, from v_l = l. */
export function exchangeRef(threads: number, rounds: number): Uint32Array {
  let v = Uint32Array.from({ length: threads }, (_, l) => l);
  for (let r = 0; r < rounds; r++) {
    const w = new Uint32Array(threads);
    for (let l = 0; l < threads; l++) w[l] = (v[(l + 1) % threads]! + Math.imul(v[l]!, 3) + 1) >>> 0;
    v = w;
  }
  return v;
}

/**
 * P4(c): W workgroups of 64 run q.rounds rounds, each a grid barrier on one
 * global atomic counter: a workgroup arrives (atomicAdd) and waits until the
 * counter reaches (round + 1) W. The count encodes the generation, so it is
 * the sense-reversing barrier with no reset; and since arrival and wait
 * touch one location, it is correct under WGSL's relaxed atomics (a reset
 * and a separate sense flag would need ordering across two locations).
 * Every wait is bounded by q.maxPolls polls: a workgroup that runs out sets
 * the failure flag, and every waiter checks it, so the kernel always ends.
 * sync = 0 runs the same rounds without the barrier (the baseline).
 * s: [0] arrivals, [1] failure flag, [2] polls spent waiting, [3] workgroups finished.
 */
export const GRID_BARRIER_WGSL = /* wgsl */ `
struct Q { rounds: u32, groups: u32, maxPolls: u32, sync: u32 }
@group(0) @binding(0) var<storage, read_write> s: array<atomic<u32>, 4>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> q: Q;
var<workgroup> stop: u32;
@compute @workgroup_size(64)
fn grid(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  var v = lid + wid.x;
  for (var r = 0u; r < q.rounds; r++) {
    v = v * 3u + 1u;
    workgroupBarrier();
    if (lid == 0u) {
      var failed = 0u;
      if (q.sync != 0u) {
        let goal = (r + 1u) * q.groups;
        atomicAdd(&s[0], 1u);
        var polls = 0u;
        loop {
          if (atomicLoad(&s[0]) >= goal) { break; }
          if (atomicLoad(&s[1]) != 0u) { failed = 1u; break; }
          polls++;
          if (polls >= q.maxPolls) { atomicStore(&s[1], 1u); failed = 1u; break; }
        }
        atomicAdd(&s[2], polls);
      }
      stop = failed;
    }
    if (workgroupUniformLoad(&stop) != 0u) { break; }
  }
  out[64u * wid.x + lid] = v;
  if (lid == 0u) { atomicAdd(&s[3], 1u); }
}`;

/**
 * P4(d): G workgroups of `threads`, each owning a tile of K * threads bodies
 * in K colours of `threads` (colour k = bodies k * threads ..). A body's
 * points refer to bodies of other colours of its tile only, so a colour's
 * bodies can update together (the Gauss-Seidel colouring). Entry `tile`:
 * load the tile's poses into shared memory, run u.iters iterations of K
 * colour phases with a workgroupBarrier after each, store them back, all in
 * one dispatch. Entry `split`: one colour phase (ph.phase) of one
 * iteration, poses read from and written to global memory, so K * iters
 * dispatches do the same work. Both use the (d)-style register math.
 */
export function tileWgsl(threads: number, K: number): string {
  const B = threads * K;
  return /* wgsl */ `
${PARAMS_WGSL}
struct Phase { phase: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> rec: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> pose: array<vec4f>;
@group(0) @binding(2) var<uniform> u: Params;
@group(0) @binding(3) var<uniform> ph: Phase;
${pointWgsl(128, false)}
var<workgroup> sh: array<vec4f, ${2 * B}>;
fn fetchShared(o: u32) -> Pose { return Pose(sh[2u * o].xyz, sh[2u * o + 1u].xyz); }
fn fetchGlobal(o: u32, base: u32) -> Pose { return Pose(pose[2u * (base + o)].xyz, pose[2u * (base + o) + 1u].xyz); }
${registerSolveWgsl().replace('fn solveBody(', 'fn solveTile(').replace('fetchOther(p.other, base)', 'fetchShared(p.other)')}
${registerSolveWgsl().replace('fn solveBody(', 'fn solveSplit(').replace('fetchOther(p.other, base)', 'fetchGlobal(p.other, base)')}

// Records: u.points per body (u.stride = u.points), for u.nposes tiles; tiles past that reuse them.
fn recBody(g: u32, b: u32) -> u32 { return (g % u.nposes) * ${B}u + b; }

@compute @workgroup_size(${threads})
fn tile(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let g = wid.x;
  for (var j = lid; j < ${2 * B}u; j += ${threads}u) { sh[j] = pose[2u * g * ${B}u + j]; }
  workgroupBarrier();
  for (var m = 0u; m < u.iters; m++) {
    for (var k = 0u; k < ${K}u; k++) {
      let b = k * ${threads}u + lid;
      let me = Pose(sh[2u * b].xyz, sh[2u * b + 1u].xyz);
      let x = solveTile(recBody(g, b), me, 0u);
      sh[2u * b] = vec4f(me.dp - vec3f(x[0], x[1], x[2]), 0.0);
      sh[2u * b + 1u] = vec4f(me.phi - vec3f(x[3], x[4], x[5]), 1.0);
      workgroupBarrier();
    }
  }
  for (var j = lid; j < ${2 * B}u; j += ${threads}u) { pose[2u * g * ${B}u + j] = sh[j]; }
}

@compute @workgroup_size(${threads})
fn split(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let g = wid.x;
  let base = g * ${B}u;
  let b = ph.phase * ${threads}u + lid;
  let me = Pose(pose[2u * (base + b)].xyz, pose[2u * (base + b) + 1u].xyz);
  let x = solveSplit(recBody(g, b), me, base);
  pose[2u * (base + b)] = vec4f(me.dp - vec3f(x[0], x[1], x[2]), 0.0);
  pose[2u * (base + b) + 1u] = vec4f(me.phi - vec3f(x[3], x[4], x[5]), 1.0);
}`;
}

/**
 * Records for P4(d): `sets` tiles of K * threads bodies, `points` each
 * (AoS, 128 bytes), every point's other body in another colour of the tile
 * (its tile-local index).
 */
export function tileRecords(threads: number, K: number, points: number, sets: number, seed = 1): Float32Array {
  const B = threads * K;
  const out = new Float32Array(sets * B * points * 32);
  for (let t = 0; t < sets; t++) for (let b = 0; b < B; b++) {
    const colour = Math.floor(b / threads);
    for (let k = 0; k < points; k++) {
      const id = (t * B + b) * points + k;
      const h = hash32(id * 2 + 1 + seed * 0x9e3779b9);
      const oc = (colour + 1 + (h % (K - 1))) % K;
      const other = oc * threads + (hash32(h) % threads);
      out.set(recordVec4s(id + seed * 0x2545f491, other), id * 32);
    }
  }
  return out;
}

/** What `tile` (and K * iters `split` dispatches) leave in tile g's poses, in f64. */
export function tileRef(records: Float32Array, poses: Float32Array, g: number, threads: number, K: number, points: number, sets: number, iters: number): Float64Array {
  const B = threads * K;
  const st = Float64Array.from(poses.subarray(8 * g * B, 8 * (g + 1) * B));
  const pose = (b: number) => ({ dp: [st[8 * b]!, st[8 * b + 1]!, st[8 * b + 2]!] as V3, phi: [st[8 * b + 4]!, st[8 * b + 5]!, st[8 * b + 6]!] as V3 });
  for (let m = 0; m < iters; m++) for (let k = 0; k < K; k++) {
    const next: Array<[number, number[]]> = [];
    for (let l = 0; l < threads; l++) {
      const b = k * threads + l, rb = (g % sets) * B + b;
      const read = (q: number): RecordReader => (j) => {
        const at = ((rb * points + q) * 8 + j) * 4;
        return [records[at]!, records[at + 1]!, records[at + 2]!, records[at + 3]!];
      };
      next.push([b, solveBodyRef(pose(b), points, read, 8, pose)]);
    }
    for (const [b, x] of next) for (let c = 0; c < 3; c++) { st[8 * b + c] = st[8 * b + c]! - x[c]!; st[8 * b + 4 + c] = st[8 * b + 4 + c]! - x[3 + c]!; }
  }
  return st;
}
