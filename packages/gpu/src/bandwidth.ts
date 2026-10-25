// Memory bandwidth probe: the roofline the solver is measured against. The
// plan predicts a bandwidth-bound solver (bytes per body per step), so every
// GPU result should be read as a fraction of what this probe achieves on the
// same device.
//
// Kernel: each thread copies one vec4u (16 B) from src to dst, so one
// dispatch moves 2 * bytes. Reported as GB/s = 1e9 bytes per second.

const WG = 256;

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4u>;
struct Params { n: u32, rowStride: u32 }
@group(0) @binding(2) var<uniform> p: Params;
@compute @workgroup_size(${WG})
fn copy(@builtin(global_invocation_id) id: vec3u) {
  let i = id.y * p.rowStride + id.x;
  if (i < p.n) { dst[i] = src[i]; }
}`;

export class BandwidthProbe {
  readonly bytes: number;
  private readonly pipe: GPUComputePipeline;
  private readonly bind: GPUBindGroup;
  private readonly owned: GPUBuffer[];
  private readonly groups: [number, number];
  readonly src: GPUBuffer;
  readonly dst: GPUBuffer;

  /** @param bytes per buffer; rounded down to a multiple of 16 */
  constructor(private readonly device: GPUDevice, bytes: number) {
    const max = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    this.bytes = Math.floor(Math.min(bytes, max) / 16) * 16;
    const n = this.bytes / 16;
    // 2D dispatch: one dimension tops out at 65535 workgroups.
    const total = Math.ceil(n / WG);
    const gx = Math.min(total, device.limits.maxComputeWorkgroupsPerDimension);
    this.groups = [gx, Math.ceil(total / gx)];
    this.src = device.createBuffer({ size: this.bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.dst = device.createBuffer({ size: this.bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(u, 0, new Uint32Array([n, gx * WG]));
    this.owned = [this.src, this.dst, u];
    this.pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: SHADER, label: 'bandwidth' }), entryPoint: 'copy' } });
    this.bind = device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [this.src, this.dst, u].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  /** Record one full copy (2 * bytes of traffic) into an open pass. */
  encode(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bind);
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
  }

  /** Bytes moved by one encode(): read plus write. */
  get traffic(): number {
    return 2 * this.bytes;
  }

  destroy(): void {
    for (const b of this.owned) b.destroy();
  }
}

export const gbPerSecond = (bytes: number, ms: number) => bytes / (ms * 1e6);
