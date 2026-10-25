// Stable LSD radix sort of u32 keys with u32 values, 4 bits per pass.
//
// Per pass (Satish, Harris & Garland 2009, "Designing efficient sorting
// algorithms for manycore GPUs"):
//   1. local: each 256-thread workgroup sorts its block by the 4-bit digit
//      with four stable 1-bit splits in shared memory, writes the sorted
//      block to a staging buffer, and writes its digit histogram to
//      hist[digit * blocks + block] (digit-major, so one scan yields global
//      offsets) and the start of each digit within the block.
//   2. scan hist (exclusive, in place).
//   3. scatter: element t of block b with digit d goes to
//      hist[d * blocks + b] + (t - localStart[b][d]). Stable because blocks
//      are in order and each block is stable.
// Keys ping-pong between the caller's buffers and internal ones; with an odd
// pass count the result is copied back, so it always ends in the caller's.
//
// Rejected alternative: Onesweep (Adinets & Merrill 2022), one pass per digit
// with decoupled look-back. Same forward-progress problem as single-pass scan
// on WebGPU (see scan.ts).
import { Scanner } from './scan.ts';

export const SORT_BLOCK = 256;

const SHADER = /* wgsl */ `
struct Params { n: u32, shift: u32, blocks: u32 }
@group(0) @binding(0) var<storage, read> srcKeys: array<u32>;
@group(0) @binding(1) var<storage, read> srcVals: array<u32>;
@group(0) @binding(2) var<storage, read_write> dstKeys: array<u32>;
@group(0) @binding(3) var<storage, read_write> dstVals: array<u32>;
@group(0) @binding(4) var<storage, read_write> stageKeys: array<u32>;
@group(0) @binding(5) var<storage, read_write> stageVals: array<u32>;
@group(0) @binding(6) var<storage, read_write> hist: array<u32>;
@group(0) @binding(7) var<storage, read_write> localStart: array<u32>;
@group(0) @binding(8) var<uniform> p: Params;

const B = ${SORT_BLOCK}u;
var<workgroup> sk: array<u32, ${SORT_BLOCK}>;
var<workgroup> sv: array<u32, ${SORT_BLOCK}>;
// digit in bits 0-3, bit 4 set for elements past n (sorted last, never scattered)
var<workgroup> sd: array<u32, ${SORT_BLOCK}>;
var<workgroup> scan: array<u32, ${SORT_BLOCK}>;
var<workgroup> counts: array<atomic<u32>, 16>;

@compute @workgroup_size(${SORT_BLOCK})
fn local(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let t = lid.x;
  let i = wid.x * B + t;
  var key = 0u;
  var val = 0u;
  var d = 31u; // invalid: digit 15 plus the invalid bit
  if (i < p.n) {
    key = srcKeys[i];
    val = srcVals[i];
    d = (key >> p.shift) & 15u;
  }
  if (t < 16u) { atomicStore(&counts[t], 0u); }
  // Four stable 1-bit splits on the digit, least significant bit first.
  // Splitting on bit 4 is unnecessary: invalid elements have digit 15 and
  // sit at the end of the block already, so stability keeps them last.
  for (var bit = 0u; bit < 4u; bit++) {
    let zero = 1u - ((d >> bit) & 1u);
    scan[t] = zero;
    workgroupBarrier();
    for (var off = 1u; off < B; off = off << 1u) {
      var v = scan[t];
      if (t >= off) { v = v + scan[t - off]; }
      workgroupBarrier();
      scan[t] = v;
      workgroupBarrier();
    }
    let zerosBefore = scan[t] - zero;
    let totalZeros = scan[B - 1u];
    var dst = totalZeros + (t - zerosBefore);
    if (zero == 1u) { dst = zerosBefore; }
    workgroupBarrier();
    sk[dst] = key;
    sv[dst] = val;
    sd[dst] = d;
    workgroupBarrier();
    key = sk[t];
    val = sv[t];
    d = sd[t];
    workgroupBarrier();
  }
  let digit = d & 15u;
  if (d < 16u) { atomicAdd(&counts[digit], 1u); }
  stageKeys[i] = key;
  stageVals[i] = val;
  if (t == 0u || (sd[t - 1u] & 15u) != digit) { localStart[wid.x * 16u + digit] = t; }
  workgroupBarrier();
  if (t < 16u) { hist[t * p.blocks + wid.x] = atomicLoad(&counts[t]); }
}

@compute @workgroup_size(${SORT_BLOCK})
fn scatter(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let t = lid.x;
  let i = wid.x * B + t;
  // The staged block is sorted with invalid elements last, so the valid
  // ones are exactly the first min(B, n - block start) slots.
  if (i >= p.n) { return; }
  let key = stageKeys[i];
  let digit = (key >> p.shift) & 15u;
  let dst = hist[digit * p.blocks + wid.x] + (t - localStart[wid.x * 16u + digit]);
  dstKeys[dst] = key;
  dstVals[dst] = stageVals[i];
}`;

export class RadixSorter {
  private readonly localPipe: GPUComputePipeline;
  private readonly scatterPipe: GPUComputePipeline;
  private readonly scanner: Scanner;
  private readonly hist: GPUBuffer;
  private readonly owned: GPUBuffer[] = [];
  /** binds[parity][pass]: parity 0 reads the caller's buffers. */
  private readonly binds: GPUBindGroup[][] = [[], []];
  private readonly uniforms: GPUBuffer[] = [];
  private readonly altKeys: GPUBuffer;
  private readonly altVals: GPUBuffer;

  constructor(private readonly device: GPUDevice, readonly keys: GPUBuffer, readonly vals: GPUBuffer, readonly capacity: number) {
    const blocks = Math.max(1, Math.ceil(capacity / SORT_BLOCK));
    if (blocks > device.limits.maxComputeWorkgroupsPerDimension) throw new Error(`RadixSorter: capacity ${capacity} too large`);
    const words = blocks * SORT_BLOCK;
    const mk = (n: number, label: string) => {
      const b = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label });
      this.owned.push(b);
      return b;
    };
    this.altKeys = mk(words, 'sort keys B');
    this.altVals = mk(words, 'sort vals B');
    const stageKeys = mk(words, 'sort stage keys');
    const stageVals = mk(words, 'sort stage vals');
    this.hist = mk(blocks * 16, 'sort hist');
    const localStart = mk(blocks * 16, 'sort local start');
    this.scanner = new Scanner(device, this.hist, blocks * 16);
    const entries: GPUBindGroupLayoutEntry[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding < 2 ? 'read-only-storage' : binding === 8 ? 'uniform' : 'storage' },
    }));
    const layout = device.createBindGroupLayout({ entries });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: SHADER, label: 'radix sort' });
    this.localPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'local' } });
    this.scatterPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'scatter' } });
    for (let pass = 0; pass < 8; pass++) {
      const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.owned.push(u);
      this.uniforms.push(u);
      for (const parity of [0, 1]) {
        const [sk, sv, dk, dv] = parity === 0 ? [keys, vals, this.altKeys, this.altVals] : [this.altKeys, this.altVals, keys, vals];
        this.binds[parity]!.push(device.createBindGroup({
          layout,
          entries: [sk, sv, dk, dv, stageKeys, stageVals, this.hist, localStart, u].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }));
      }
    }
  }

  /**
   * Sort keys[0, n) and carry vals along, by the low keyBits bits (rounded up
   * to a multiple of 4; higher bits must be zero or are ignored for order).
   * Opens its own compute pass; pass timestampWrites to profile it.
   */
  encode(encoder: GPUCommandEncoder, n: number, keyBits = 32, timestampWrites?: GPUComputePassTimestampWrites): void {
    if (n > this.capacity) throw new Error(`RadixSorter: n ${n} exceeds capacity ${this.capacity}`);
    if (n <= 1) return;
    const passes = Math.ceil(Math.min(32, Math.max(4, keyBits)) / 4);
    const blocks = Math.ceil(n / SORT_BLOCK);
    const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : {});
    for (let k = 0; k < passes; k++) {
      this.device.queue.writeBuffer(this.uniforms[k]!, 0, new Uint32Array([n, 4 * k, blocks]));
      const bind = this.binds[k % 2]![k]!;
      pass.setPipeline(this.localPipe);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(blocks);
      this.scanner.encode(pass, blocks * 16);
      pass.setPipeline(this.scatterPipe);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(blocks);
    }
    pass.end();
    if (passes % 2 === 1) {
      encoder.copyBufferToBuffer(this.altKeys, 0, this.keys, 0, n * 4);
      encoder.copyBufferToBuffer(this.altVals, 0, this.vals, 0, n * 4);
    }
  }

  destroy(): void {
    this.scanner.destroy();
    for (const b of this.owned) b.destroy();
  }
}
