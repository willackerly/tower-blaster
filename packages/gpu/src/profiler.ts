// Per-pass GPU timing from timestamp queries. Each frame: begin(), pass(label)
// for every compute pass, resolve(encoder) before finish(), then collect()
// (async, after submit). Readback buffers are pooled so collecting frame k
// never blocks recording frame k+1.
//
// Without timestamp-query (or with Chrome's default 100 µs quantization) the
// numbers are absent or coarse; the runner launches Chromium with
// --enable-webgpu-developer-features to lift the quantization.

interface Pending { buffer: GPUBuffer; labels: string[] }

export class GpuProfiler {
  readonly supported: boolean;
  private readonly querySet: GPUQuerySet | null;
  private readonly resolveBuf: GPUBuffer | null;
  private labels: string[] = [];
  private pool: GPUBuffer[] = [];
  private pending: Pending[] = [];

  constructor(private readonly device: GPUDevice, readonly maxPasses = 64) {
    this.supported = device.features.has('timestamp-query');
    this.querySet = this.supported ? device.createQuerySet({ type: 'timestamp', count: maxPasses * 2 }) : null;
    this.resolveBuf = this.supported
      ? device.createBuffer({ size: maxPasses * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      : null;
  }

  begin(): void {
    this.labels = [];
  }

  /** Spread into a pass descriptor: `beginComputePass({ ...prof.pass('scan') })`. */
  pass(label: string): { timestampWrites?: GPUComputePassTimestampWrites } {
    if (!this.querySet) return {};
    const i = this.labels.length;
    if (i >= this.maxPasses) throw new Error(`GpuProfiler: more than ${this.maxPasses} passes in one frame`);
    this.labels.push(label);
    return { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } };
  }

  resolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuf || this.labels.length === 0) return;
    const bytes = this.labels.length * 16;
    const buffer = this.pool.pop() ?? this.device.createBuffer({ size: this.maxPasses * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.resolveQuerySet(this.querySet, 0, this.labels.length * 2, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, buffer, 0, bytes);
    this.pending.push({ buffer, labels: this.labels });
    this.labels = [];
  }

  /**
   * Milliseconds per label for the oldest resolved frame (labels used more
   * than once are summed). Empty when timestamps are unsupported.
   */
  async collect(): Promise<Record<string, number>> {
    const p = this.pending.shift();
    if (!p) return {};
    await p.buffer.mapAsync(GPUMapMode.READ, 0, p.labels.length * 16);
    const t = new BigUint64Array(p.buffer.getMappedRange(0, p.labels.length * 16));
    const out: Record<string, number> = {};
    p.labels.forEach((label, i) => {
      // Timestamps may be reordered or zeroed by the implementation; clamp
      // rather than report negative time.
      const ns = t[2 * i + 1]! > t[2 * i]! ? Number(t[2 * i + 1]! - t[2 * i]!) : 0;
      out[label] = (out[label] ?? 0) + ns / 1e6;
    });
    p.buffer.unmap();
    this.pool.push(p.buffer);
    return out;
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolveBuf?.destroy();
    for (const b of [...this.pool, ...this.pending.map((p) => p.buffer)]) b.destroy();
  }
}

/** Wall time from submit to completion: the fallback when timestamps are absent. */
export async function timeSubmit(device: GPUDevice, record: (enc: GPUCommandEncoder) => void): Promise<number> {
  const enc = device.createCommandEncoder();
  record(enc);
  const t0 = performance.now();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  return performance.now() - t0;
}
