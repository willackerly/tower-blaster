// GPU broadphase: all pairs (i < j) whose bounding spheres overlap (plus a
// margin), via a sorted spatial hash.
//
//   1. hash: key = hash(cell of centre) & mask, value = body index
//   2. radix sort (key, index) on log2(table) bits; stable, so bodies in a
//      bucket stay in index order
//   3. cell ranges: [start, end) of each bucket in the sorted order
//   4. count: each body visits the 27 neighbouring cells and counts partners
//      j > i that overlap; 5. scan the counts into offsets
//   6. write: the same visit again, writing pairs at the offsets
//
// The cell size must be at least the largest overlap reach (2 r_max +
// margin), so every overlapping pair lies in adjacent cells. Each candidate's
// own cell is compared with the visited one, so hash collisions can neither
// duplicate nor invent pairs.
//
// Count-then-write runs the neighbour search twice, but the output is
// deterministic (grouped by i, a fixed order within each group) and its exact
// size is known before writing. The rejected alternative, atomic append
// followed by a sort, is faster when pairs are few but nondeterministic, and
// determinism is a project requirement (scenario S11).
//
// Box test (optional, BroadphaseBoxes; Kapla step K2.1): a pair of boxes
// whose spheres overlap is kept only if no SAT axis of the narrowphase's (the
// 6 face normals, the 9 edge crosses) separates them by more than the
// narrowphase's margin, p.margin + sweep[i] + sweep[j]. The narrowphase
// returns no contact for such a pair (geom boxBoxSeparation), so dropping it
// changes no manifold; a slack of SEP_SLACK times the projected extents
// covers f32 rounding the two kernels might do differently. Bounding spheres
// hold a plank (5 x 1 x 1/3) in 42 times its volume (a cube: 2.7), so in a
// Kapla pile most sphere pairs are not near touching. The pairs kept are the
// sphere pairs minus some, in the same order, so the narrowphase, colouring
// and solve see the same contacts in the same order.
//
// Overflow: write keeps the first maxPairs pairs and drops the rest. Pairs are
// grouped by their lower index, so what is dropped are the pairs between
// bodies latest in index order (pushed bodies, fired balls among them), which
// then pass through each other. finalize keeps two sticky counters for it,
// never cleared, so a read at any time covers every encode since the buffer
// was made (GpuAvbdEngine.init makes a new one): total[6], the most pairs an
// encode has required, and total[7], the encodes that required more than
// maxPairs. Nothing else reads them, so they change no float.
import { assertStorageFits, RadixSorter, Scanner } from '@tb/gpu';
import { Body, Shape, wgslStruct } from '@tb/schema';

const WG = 64;

/**
 * Throws unless one indirect dispatch of WG-thread workgroups can cover maxPairs pairs: the
 * narrowphase, colouring, solver and restitution kernels run over the pairs written with
 * total[0..2] as their arguments, and a dispatch past maxComputeWorkgroupsPerDimension does nothing
 * at all (4,194,240 pairs at the default limit of 65,535).
 */
export function assertPairDispatch(device: GPUDevice, maxPairs: number, who: string, remedy: string): void {
  const limit = device.limits.maxComputeWorkgroupsPerDimension;
  if (maxPairs > WG * limit) throw new Error(`${who}: ${maxPairs} pair slots exceed the ${WG * limit} one indirect dispatch covers (${WG} x maxComputeWorkgroupsPerDimension ${limit}); ${remedy}`);
}

/** Relative slack of the box test: about 80 f32 ulps of the larger of |d.n| and the projected extents. */
export const SEP_SLACK = 1e-5;

// The box test's code: a per-body box record and the SAT check (see the header).
const BOX_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(Shape)}
@group(1) @binding(0) var<storage, read> bodies: array<Body>;
@group(1) @binding(1) var<storage, read> shapes: array<Shape>;
@group(1) @binding(2) var<storage, read> sweep: array<f32>;
// Per body: (centre, sweep), then each unit axis with its half extent in w
// (the narrowphase's boxOf, so both test the same numbers); a sphere has w = -1.
@group(0) @binding(9) var<storage, read_write> boxes: array<vec4f>;

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

@compute @workgroup_size(${WG})
fn pack(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let b = bodies[i];
  let s = shapes[b.shape];
  let h = select(vec3f(-1.0), s.half, s.kind == 0u);
  boxes[4u * i] = vec4f(b.pos, sweep[i]);
  boxes[4u * i + 1u] = vec4f(qrot(b.rot, vec3f(1.0, 0.0, 0.0)), h.x);
  boxes[4u * i + 2u] = vec4f(qrot(b.rot, vec3f(0.0, 1.0, 0.0)), h.y);
  boxes[4u * i + 3u] = vec4f(qrot(b.rot, vec3f(0.0, 0.0, 1.0)), h.z);
}

struct Obb { c: vec3f, s: f32, ax: mat3x3f, h: vec3f }
fn obbOf(i: u32) -> Obb {
  let r0 = boxes[4u * i];
  let r1 = boxes[4u * i + 1u];
  let r2 = boxes[4u * i + 2u];
  let r3 = boxes[4u * i + 3u];
  return Obb(r0.xyz, r0.w, mat3x3f(r1.xyz, r2.xyz, r3.xyz), vec3f(r1.w, r2.w, r3.w));
}
fn projR(o: Obb, n: vec3f) -> f32 { return o.h.x * abs(dot(o.ax[0], n)) + o.h.y * abs(dot(o.ax[1], n)) + o.h.z * abs(dot(o.ax[2], n)); }
// Does axis n separate a and b by more than margin m (plus the slack)?
fn apart(a: Obb, b: Obb, d: vec3f, n: vec3f, m: f32) -> bool {
  let dn = abs(dot(d, n));
  let r = projR(a, n) + projR(b, n);
  return dn - r > m + ${SEP_SLACK} * max(dn, r);
}
// Can the narrowphase find a contact between a and b? false only when one of its axes separates them by more than its margin.
fn mayTouch(a: Obb, b: Obb) -> bool {
  if (a.h.x < 0.0 || b.h.x < 0.0) { return true; } // a sphere: the sphere test was exact
  let d = b.c - a.c;
  let m = p.margin + a.s + b.s;
  for (var k = 0u; k < 3u; k++) {
    if (apart(a, b, d, a.ax[k], m) || apart(a, b, d, b.ax[k], m)) { return false; }
  }
  for (var i = 0u; i < 3u; i++) {
    for (var j = 0u; j < 3u; j++) {
      let c = cross(a.ax[i], b.ax[j]);
      let len = length(c);
      if (len >= 1e-6 && apart(a, b, d, c / len, m)) { return false; }
    }
  }
  return true;
}
`;

function shader(boxes: boolean): string {
  return /* wgsl */ `
struct Params { n: u32, mask: u32, maxPairs: u32, invCell: f32, margin: f32 }
@group(0) @binding(0) var<storage, read> spheres: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> keys: array<u32>;
@group(0) @binding(2) var<storage, read_write> vals: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellEnd: array<u32>;
@group(0) @binding(5) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> pairs: array<vec2u>;
// [groupsX, 1, 1, written, lastCount, required, requiredPeak, overflowSteps] (the last two sticky; see the header)
@group(0) @binding(7) var<storage, read_write> total: array<u32, 8>;
@group(0) @binding(8) var<uniform> p: Params;

fn cellOf(c: vec3f) -> vec3i { return vec3i(floor(c * p.invCell)); }
fn hashOf(c: vec3i) -> u32 {
  let u = bitcast<vec3u>(c);
  return ((u.x * 73856093u) ^ (u.y * 19349663u) ^ (u.z * 83492791u)) & p.mask;
}

@compute @workgroup_size(${WG})
fn hash(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  keys[i] = hashOf(cellOf(spheres[i].xyz));
  vals[i] = i;
}

@compute @workgroup_size(${WG})
fn ranges(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= p.n) { return; }
  let key = keys[k];
  // Stored as index + 1 so that the cleared value 0 means "empty".
  if (k == 0u || keys[k - 1u] != key) { cellStart[key] = k + 1u; }
  if (k == p.n - 1u || keys[k + 1u] != key) { cellEnd[key] = k + 1u; }
}

// Visit every partner j > i of body i in a fixed order. write = false counts.
fn visit(i: u32, write: bool, base: u32) -> u32 {
  let si = spheres[i];
  let ci = cellOf(si.xyz);${boxes ? '\n  let oi = obbOf(i);' : ''}
  var found = 0u;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let nc = ci + vec3i(dx, dy, dz);
        let h = hashOf(nc);
        let st = cellStart[h];
        if (st == 0u) { continue; }
        let en = cellEnd[h];
        for (var k = st - 1u; k < en; k++) {
          let j = vals[k];
          if (j <= i) { continue; }
          let sj = spheres[j];
          if (any(cellOf(sj.xyz) != nc)) { continue; }
          let d = sj.xyz - si.xyz;
          let reach = si.w + sj.w + p.margin;
          if (dot(d, d) <= reach * reach${boxes ? ' && mayTouch(oi, obbOf(j))' : ''}) {
            if (write && base + found < p.maxPairs) { pairs[base + found] = vec2u(i, j); }
            found++;
          }
        }
      }
    }
  }
  return found;
}

@compute @workgroup_size(${WG})
fn count(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let c = visit(i, false, 0u);
  offsets[i] = c;
  if (i == p.n - 1u) { total[4] = c; }
}

@compute @workgroup_size(1)
fn finalize() {
  var t = 0u;
  if (p.n > 0u) { t = offsets[p.n - 1u] + total[4]; }
  let w = min(t, p.maxPairs);
  total[0] = (w + ${WG - 1}u) / ${WG}u;
  total[1] = 1u;
  total[2] = 1u;
  total[3] = w;
  total[5] = t;
  total[6] = max(total[6], t);
  if (t > p.maxPairs) { total[7] = total[7] + 1u; }
}

@compute @workgroup_size(${WG})
fn emit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  visit(i, true, offsets[i]);
}${boxes ? BOX_WGSL : ''}`;
}

export interface BroadphaseParams {
  /** Cell edge; must be >= 2 * (largest bounding radius) + margin. */
  cellSize: number;
  /** Added to the sum of the spheres' radii; with the box test, also the narrowphase's margin (before the sweeps). */
  margin: number;
}

/** The narrowphase's inputs the box test reads (see the header): Body and Shape records, f32 sweep per body. */
export interface BroadphaseBoxes { bodies: GPUBuffer; shapes: GPUBuffer; sweep: GPUBuffer }

export class Broadphase {
  /** vec2u (i, j) with i < j, grouped by i. */
  readonly pairs: GPUBuffer;
  /**
   * u32 x 8: [groupsX, 1, 1, written, -, required, requiredPeak, overflowSteps]; offset 0 feeds
   * dispatchWorkgroupsIndirect at 64 threads per group. The last two count every encode since the
   * buffer was made: the most pairs one required, and how many required more than maxPairs.
   */
  readonly total: GPUBuffer;
  readonly keyBits: number;
  private readonly keys: GPUBuffer;
  private readonly vals: GPUBuffer;
  private readonly cellStart: GPUBuffer;
  private readonly cellEnd: GPUBuffer;
  /** u32 per body after encode(): start of body i's group in `pairs` (exclusive scan of its partner count). */
  readonly offsets: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly sorter: RadixSorter;
  private readonly scanner: Scanner;
  private readonly pipes: Record<'hash' | 'ranges' | 'count' | 'finalize' | 'emit', GPUComputePipeline>;
  private readonly bind: GPUBindGroup;
  /** The box test's per-body records, its pack pipeline and the bind groups of pack and of count and emit; null without it. */
  private readonly box: { records: GPUBuffer; pack: GPUComputePipeline; packBind: [GPUBindGroup, GPUBindGroup]; visitBind: GPUBindGroup } | null = null;

  /**
   * @param spheres vec4f per body: centre xyz, bounding radius w
   * @param capacity maximum bodies
   * @param maxPairs pair buffer size; more pairs are counted in `required` but not written. At most
   *   WG x maxComputeWorkgroupsPerDimension (assertPairDispatch).
   * @param tableBits hash table size override (tests use a tiny table to force collisions)
   * @param boxes the box test's inputs (header); without them, sphere pairs only
   */
  constructor(private readonly device: GPUDevice, spheres: GPUBuffer, readonly capacity: number, readonly maxPairs: number, tableBits?: number, boxes?: BroadphaseBoxes) {
    assertPairDispatch(device, maxPairs, 'Broadphase', 'lower maxPairs');
    // Table of at least 2 buckets per body keeps chains short.
    this.keyBits = tableBits ?? Math.max(4, Math.ceil(Math.log2(Math.max(2, 2 * capacity))));
    const table = 2 ** this.keyBits;
    const buf = (bytes: number, label: string, extra = 0) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra, label }));
    this.keys = buf(capacity * 4, 'bp keys');
    this.vals = buf(capacity * 4, 'bp vals');
    this.cellStart = buf(table * 4, 'bp cell start');
    this.cellEnd = buf(table * 4, 'bp cell end');
    this.offsets = buf(capacity * 4, 'bp offsets');
    this.pairs = buf(maxPairs * 8, 'bp pairs');
    this.total = buf(32, 'bp total', GPUBufferUsage.INDIRECT);
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sorter = new RadixSorter(device, this.keys, this.vals, capacity);
    this.scanner = new Scanner(device, this.offsets, capacity);
    const layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 0 ? 'read-only-storage' : binding === 8 ? 'uniform' : 'storage' },
      })),
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: shader(!!boxes), label: boxes ? 'broadphase (box test)' : 'broadphase' });
    const mk = (entryPoint: string, l = pl) => device.createComputePipeline({ layout: l, compute: { module, entryPoint } });
    const all = [spheres, this.keys, this.vals, this.cellStart, this.cellEnd, this.offsets, this.pairs, this.total, this.uniform];
    this.bind = device.createBindGroup({ layout, entries: all.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    if (!boxes) {
      this.pipes = { hash: mk('hash'), ranges: mk('ranges'), count: mk('count'), finalize: mk('finalize'), emit: mk('emit') };
      return;
    }
    // Count and emit read the records instead of the keys, which keeps them at
    // eight storage buffers (the default limit); pack reads the narrowphase's
    // inputs from a second group.
    const records = buf(capacity * 64, 'bp boxes');
    const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const visitIds = [0, 2, 3, 4, 5, 6, 7, 8, 9];
    const visitLayout = device.createBindGroupLayout({ entries: visitIds.map((b) => entry(b, b === 0 ? 'read-only-storage' : b === 8 ? 'uniform' : 'storage')) });
    const packLayout = device.createBindGroupLayout({ entries: [entry(8, 'uniform'), entry(9, 'storage')] });
    const inputLayout = device.createBindGroupLayout({ entries: [0, 1, 2].map((b) => entry(b, 'read-only-storage')) });
    const visit = device.createPipelineLayout({ bindGroupLayouts: [visitLayout] });
    this.pipes = { hash: mk('hash'), ranges: mk('ranges'), count: mk('count', visit), finalize: mk('finalize'), emit: mk('emit', visit) };
    const withRecords = [...all, records];
    this.box = {
      records,
      pack: mk('pack', device.createPipelineLayout({ bindGroupLayouts: [packLayout, inputLayout] })),
      packBind: [
        device.createBindGroup({ layout: packLayout, entries: [8, 9].map((binding) => ({ binding, resource: { buffer: withRecords[binding]! } })) }),
        device.createBindGroup({ layout: inputLayout, entries: [boxes.bodies, boxes.shapes, boxes.sweep].map((buffer, binding) => ({ binding, resource: { buffer } })) }),
      ],
      visitBind: device.createBindGroup({ layout: visitLayout, entries: visitIds.map((binding) => ({ binding, resource: { buffer: withRecords[binding]! } })) }),
    };
  }

  encode(encoder: GPUCommandEncoder, n: number, params: BroadphaseParams, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (n > this.capacity) throw new Error(`Broadphase: n ${n} exceeds capacity ${this.capacity}`);
    if (!(params.cellSize > 0)) throw new Error('Broadphase: cellSize must be positive');
    const u = new ArrayBuffer(32);
    new Uint32Array(u, 0, 3).set([n, 2 ** this.keyBits - 1, this.maxPairs]);
    new Float32Array(u, 12, 2).set([1 / params.cellSize, params.margin]);
    this.device.queue.writeBuffer(this.uniform, 0, u);
    encoder.clearBuffer(this.cellStart);
    const groups = Math.max(1, Math.ceil(n / WG));
    let pass = encoder.beginComputePass();
    pass.setBindGroup(0, this.bind);
    if (n > 0) {
      pass.setPipeline(this.pipes.hash);
      pass.dispatchWorkgroups(groups);
      if (this.box) {
        pass.setBindGroup(0, this.box.packBind[0]);
        pass.setBindGroup(1, this.box.packBind[1]);
        pass.setPipeline(this.box.pack);
        pass.dispatchWorkgroups(groups);
      }
    }
    pass.end();
    this.sorter.encode(encoder, n, this.keyBits);
    pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : {});
    pass.setBindGroup(0, this.bind);
    if (n > 0) {
      pass.setPipeline(this.pipes.ranges);
      pass.dispatchWorkgroups(groups);
      if (this.box) pass.setBindGroup(0, this.box.visitBind);
      pass.setPipeline(this.pipes.count);
      pass.dispatchWorkgroups(groups);
      this.scanner.encode(pass, n);
      pass.setBindGroup(0, this.bind);
    }
    pass.setPipeline(this.pipes.finalize);
    pass.dispatchWorkgroups(1);
    if (n > 0) {
      if (this.box) pass.setBindGroup(0, this.box.visitBind);
      pass.setPipeline(this.pipes.emit);
      pass.dispatchWorkgroups(groups);
    }
    pass.end();
  }

  destroy(): void {
    this.sorter.destroy();
    this.scanner.destroy();
    for (const b of [this.keys, this.vals, this.cellStart, this.cellEnd, this.offsets, this.pairs, this.total, this.uniform]) b.destroy();
    this.box?.records.destroy();
  }
}
