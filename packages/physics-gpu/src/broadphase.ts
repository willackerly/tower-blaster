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
import { RadixSorter, Scanner } from '@tb/gpu';

const WG = 64;

const SHADER = /* wgsl */ `
struct Params { n: u32, mask: u32, maxPairs: u32, invCell: f32, margin: f32 }
@group(0) @binding(0) var<storage, read> spheres: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> keys: array<u32>;
@group(0) @binding(2) var<storage, read_write> vals: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellEnd: array<u32>;
@group(0) @binding(5) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> pairs: array<vec2u>;
// [groupsX, 1, 1, written, lastCount, required]
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
  let ci = cellOf(si.xyz);
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
          if (dot(d, d) <= reach * reach) {
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
}

@compute @workgroup_size(${WG})
fn emit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  visit(i, true, offsets[i]);
}`;

export interface BroadphaseParams {
  /** Cell edge; must be >= 2 * (largest bounding radius) + margin. */
  cellSize: number;
  margin: number;
}

export class Broadphase {
  /** vec2u (i, j) with i < j, grouped by i. */
  readonly pairs: GPUBuffer;
  /** u32 x 8: [groupsX, 1, 1, written, -, required]; offset 0 feeds dispatchWorkgroupsIndirect at 64 threads per group. */
  readonly total: GPUBuffer;
  readonly keyBits: number;
  private readonly keys: GPUBuffer;
  private readonly vals: GPUBuffer;
  private readonly cellStart: GPUBuffer;
  private readonly cellEnd: GPUBuffer;
  private readonly offsets: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly sorter: RadixSorter;
  private readonly scanner: Scanner;
  private readonly pipes: Record<'hash' | 'ranges' | 'count' | 'finalize' | 'emit', GPUComputePipeline>;
  private readonly bind: GPUBindGroup;

  /**
   * @param spheres vec4f per body: centre xyz, bounding radius w
   * @param capacity maximum bodies
   * @param maxPairs pair buffer size; more pairs are counted in `required` but not written
   * @param tableBits hash table size override (tests use a tiny table to force collisions)
   */
  constructor(private readonly device: GPUDevice, spheres: GPUBuffer, readonly capacity: number, readonly maxPairs: number, tableBits?: number) {
    // Table of at least 2 buckets per body keeps chains short.
    this.keyBits = tableBits ?? Math.max(4, Math.ceil(Math.log2(Math.max(2, 2 * capacity))));
    const table = 2 ** this.keyBits;
    const buf = (bytes: number, label: string, extra = 0) => device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra, label });
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
    const module = device.createShaderModule({ code: SHADER, label: 'broadphase' });
    const mk = (entryPoint: string) => device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
    this.pipes = { hash: mk('hash'), ranges: mk('ranges'), count: mk('count'), finalize: mk('finalize'), emit: mk('emit') };
    this.bind = device.createBindGroup({
      layout,
      entries: [spheres, this.keys, this.vals, this.cellStart, this.cellEnd, this.offsets, this.pairs, this.total, this.uniform].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
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
    }
    pass.end();
    this.sorter.encode(encoder, n, this.keyBits);
    pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : {});
    pass.setBindGroup(0, this.bind);
    if (n > 0) {
      pass.setPipeline(this.pipes.ranges);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(this.pipes.count);
      pass.dispatchWorkgroups(groups);
      this.scanner.encode(pass, n);
      pass.setBindGroup(0, this.bind);
    }
    pass.setPipeline(this.pipes.finalize);
    pass.dispatchWorkgroups(1);
    if (n > 0) {
      pass.setPipeline(this.pipes.emit);
      pass.dispatchWorkgroups(groups);
    }
    pass.end();
  }

  destroy(): void {
    this.sorter.destroy();
    this.scanner.destroy();
    for (const b of [this.keys, this.vals, this.cellStart, this.cellEnd, this.offsets, this.pairs, this.total, this.uniform]) b.destroy();
  }
}
