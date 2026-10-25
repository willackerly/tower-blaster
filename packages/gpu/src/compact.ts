// Stream compaction: indices of the nonzero flags, in order, plus a count
// stored as ready-made indirect dispatch arguments. This is how the engine
// turns "which bodies are awake" into a dense work list without a CPU
// round trip.
//
// Passes: normalize flags to 0/1 into offsets, scan offsets in place, then
// scatter each kept index to its offset. Cost is about 4n words of traffic
// plus the scan's.
import { Scanner } from './scan.ts';

const WG = 256;

const SHADER = /* wgsl */ `
struct Params { n: u32, groupSize: u32 }
@group(0) @binding(0) var<storage, read> flags: array<u32>;
@group(0) @binding(1) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
// [groupsX, 1, 1, count]: dispatchWorkgroupsIndirect(count, 0) runs one
// thread per kept element at workgroup size p.groupSize.
@group(0) @binding(3) var<storage, read_write> count: array<u32, 4>;
@group(0) @binding(4) var<uniform> p: Params;

@compute @workgroup_size(${WG})
fn normalize(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < p.n) { offsets[id.x] = select(0u, 1u, flags[id.x] != 0u); }
}

@compute @workgroup_size(${WG})
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i < p.n && flags[i] != 0u) { out[offsets[i]] = i; }
  if (i == 0u) {
    var c = 0u;
    if (p.n > 0u) { c = offsets[p.n - 1u] + select(0u, 1u, flags[p.n - 1u] != 0u); }
    count[0] = (c + p.groupSize - 1u) / p.groupSize;
    count[1] = 1u;
    count[2] = 1u;
    count[3] = c;
  }
}`;

export class Compactor {
  /** 16 bytes: [groupsX, 1, 1, count]; usable with dispatchWorkgroupsIndirect. */
  readonly count: GPUBuffer;
  private readonly offsets: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly scanner: Scanner;
  private readonly normalizePipe: GPUComputePipeline;
  private readonly scatterPipe: GPUComputePipeline;
  private readonly bind: GPUBindGroup;

  /**
   * @param flags u32 per element, nonzero means keep
   * @param out receives kept indices; needs capacity u32s
   * @param indirectGroupSize workgroup size the indirect arguments are computed for
   */
  constructor(private readonly device: GPUDevice, flags: GPUBuffer, out: GPUBuffer, readonly capacity: number, readonly indirectGroupSize = 64) {
    if (Math.ceil(Math.max(1, capacity) / WG) > device.limits.maxComputeWorkgroupsPerDimension) throw new Error(`Compactor: capacity ${capacity} too large`);
    this.offsets = device.createBuffer({ size: Math.max(16, capacity * 4), usage: GPUBufferUsage.STORAGE, label: 'compact offsets' });
    this.count = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC, label: 'compact count' });
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.scanner = new Scanner(device, this.offsets, capacity);
    const module = device.createShaderModule({ code: SHADER, label: 'compact' });
    // One explicit layout: normalize alone would not declare bindings 2 and 3.
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.normalizePipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'normalize' } });
    this.scatterPipe = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'scatter' } });
    this.bind = device.createBindGroup({
      layout,
      entries: [flags, this.offsets, out, this.count, this.uniform].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  /** Record compaction of flags[0, n) into an open compute pass. */
  encode(pass: GPUComputePassEncoder, n: number): void {
    if (n > this.capacity) throw new Error(`Compactor: n ${n} exceeds capacity ${this.capacity}`);
    this.device.queue.writeBuffer(this.uniform, 0, new Uint32Array([n, this.indirectGroupSize]));
    const groups = Math.max(1, Math.ceil(n / WG));
    pass.setBindGroup(0, this.bind);
    if (n > 0) {
      pass.setPipeline(this.normalizePipe);
      pass.dispatchWorkgroups(groups);
      this.scanner.encode(pass, n);
      pass.setBindGroup(0, this.bind);
    }
    pass.setPipeline(this.scatterPipe);
    pass.dispatchWorkgroups(groups);
  }

  destroy(): void {
    this.scanner.destroy();
    for (const b of [this.offsets, this.count, this.uniform]) b.destroy();
  }
}
