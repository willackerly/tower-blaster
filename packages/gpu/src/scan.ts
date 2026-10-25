// In-place exclusive prefix sum of u32 (wrapping), for any n up to the
// capacity given at construction.
//
// Algorithm: hierarchical reduce-then-scan. Each 256-thread workgroup scans a
// 512-element block in shared memory and writes the block total to the next
// level; levels recurse until one block remains, then block offsets are added
// back down. About 2n reads and 2n writes at level 0, plus 1/512 of that per
// level above.
//
// Rejected alternative: single-pass decoupled look-back (Merrill & Garland
// 2016), which moves about half the memory. It needs workgroups to make
// forward progress while spinning on a predecessor, and WebGPU guarantees no
// such thing; on Apple GPUs it can deadlock or stall. Revisit only behind a
// measured win and a fallback.
//
// One Scanner holds one uniform per level, written at encode time, so each
// submit sees the n of the last encode() before it. Use one Scanner per
// distinct n in a submit.

export const SCAN_BLOCK = 512;
const WG = 256;

const SHADER = /* wgsl */ `
struct Params { n: u32 }
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> sums: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;
var<workgroup> sh: array<u32, ${WG}>;

@compute @workgroup_size(${WG})
fn scanBlocks(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let t = lid.x;
  let base = wid.x * ${SCAN_BLOCK}u + 2u * t;
  var a = 0u;
  var b = 0u;
  if (base < p.n) { a = data[base]; }
  if (base + 1u < p.n) { b = data[base + 1u]; }
  sh[t] = a + b;
  workgroupBarrier();
  // Hillis-Steele inclusive scan of the 256 pair sums.
  for (var off = 1u; off < ${WG}u; off = off << 1u) {
    var v = sh[t];
    if (t >= off) { v = v + sh[t - off]; }
    workgroupBarrier();
    sh[t] = v;
    workgroupBarrier();
  }
  let excl = sh[t] - (a + b);
  if (base < p.n) { data[base] = excl; }
  if (base + 1u < p.n) { data[base + 1u] = excl + a; }
  if (t == ${WG - 1}u) { sums[wid.x] = sh[t]; }
}

@compute @workgroup_size(${WG})
fn addSums(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let s = sums[wid.x];
  let base = wid.x * ${SCAN_BLOCK}u + 2u * lid.x;
  if (base < p.n) { data[base] = data[base] + s; }
  if (base + 1u < p.n) { data[base + 1u] = data[base + 1u] + s; }
}`;

/** Element counts per level for n (level 0 is n itself; the last fits one block). */
export function scanLevels(n: number): number[] {
  const levels = [n];
  while (levels[levels.length - 1]! > SCAN_BLOCK) levels.push(Math.ceil(levels[levels.length - 1]! / SCAN_BLOCK));
  return levels;
}

export class Scanner {
  private readonly scanPipe: GPUComputePipeline;
  private readonly addPipe: GPUComputePipeline;
  private readonly binds: GPUBindGroup[] = [];
  private readonly uniforms: GPUBuffer[] = [];
  private readonly owned: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice, data: GPUBuffer, readonly capacity: number) {
    const maxGroups = device.limits.maxComputeWorkgroupsPerDimension;
    if (Math.ceil(capacity / SCAN_BLOCK) > maxGroups) throw new Error(`Scanner: capacity ${capacity} exceeds ${maxGroups * SCAN_BLOCK}`);
    if (data.size < capacity * 4) throw new Error('Scanner: data buffer smaller than capacity');
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const module = device.createShaderModule({ code: SHADER, label: 'scan' });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.scanPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'scanBlocks' } });
    this.addPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'addSums' } });
    const levels = scanLevels(Math.max(1, capacity));
    let cur = data;
    for (let i = 0; i < levels.length; i++) {
      // The top level's block total is written but never read.
      const sums = device.createBuffer({ size: Math.max(16, Math.ceil(levels[i]! / SCAN_BLOCK) * 4), usage: GPUBufferUsage.STORAGE, label: `scan sums L${i + 1}` });
      const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.owned.push(sums, uniform);
      this.uniforms.push(uniform);
      this.binds.push(device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: cur } }, { binding: 1, resource: { buffer: sums } }, { binding: 2, resource: { buffer: uniform } }] }));
      cur = sums;
    }
  }

  /** Record the scan of data[0, n) into an open compute pass. */
  encode(pass: GPUComputePassEncoder, n: number): void {
    if (n > this.capacity) throw new Error(`Scanner: n ${n} exceeds capacity ${this.capacity}`);
    if (n === 0) return;
    const levels = scanLevels(n);
    levels.forEach((m, i) => this.device.queue.writeBuffer(this.uniforms[i]!, 0, new Uint32Array([m])));
    pass.setPipeline(this.scanPipe);
    for (let i = 0; i < levels.length; i++) {
      pass.setBindGroup(0, this.binds[i]!);
      pass.dispatchWorkgroups(Math.ceil(levels[i]! / SCAN_BLOCK));
    }
    pass.setPipeline(this.addPipe);
    for (let i = levels.length - 2; i >= 0; i--) {
      pass.setBindGroup(0, this.binds[i]!);
      pass.dispatchWorkgroups(Math.ceil(levels[i]! / SCAN_BLOCK));
    }
  }

  destroy(): void {
    for (const b of this.owned) b.destroy();
  }
}
