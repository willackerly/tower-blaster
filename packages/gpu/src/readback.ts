// Buffer readback through a pool of reusable MAP_READ staging buffers.
// readBuffer() creates and destroys a staging buffer on every call; a path
// that reads every step (snapshot(), observations) keeps them instead.
// Staging sizes are powers of two from 256 B, so reads of varying size
// settle on a few buffers, and a read takes the smallest free one that fits.
// A buffer is in the free list only while unmapped, so concurrent reads
// never share one. Nothing is freed before destroy(): the pool keeps as many
// buffers as were ever in flight at once.

const MIN_STAGING = 256;

export class Readback {
  /** Staging buffers created so far. */
  created = 0;
  /** Bytes copied out to the CPU so far. */
  bytesRead = 0;
  private free: GPUBuffer[] = [];
  private readonly all = new Set<GPUBuffer>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {}

  /**
   * Bytes [offset, offset + bytes) of src. The copy is submitted before this
   * returns, so the result is the state after exactly the work submitted
   * before the call. Rejects, counting nothing in bytesRead, if the copy
   * fails validation.
   */
  read(src: GPUBuffer, bytes = src.size, offset = 0): Promise<ArrayBuffer> {
    if (this.destroyed) throw new Error('Readback: destroyed');
    if (bytes % 4 !== 0 || offset % 4 !== 0 || bytes < 0 || offset < 0) throw new Error(`Readback: bytes (${bytes}) and offset (${offset}) must be non-negative multiples of 4`);
    // A copy that fails validation is dropped while the map still succeeds, so
    // a pooled staging buffer would hand back an earlier read's bytes as data.
    // What can be checked here throws; the error scope catches the rest (a
    // destroyed source, another device's buffer).
    if (offset + bytes > src.size) throw new Error(`Readback: ${bytes} bytes at ${offset} is past the end of a ${src.size}-byte buffer`);
    if (!(src.usage & GPUBufferUsage.COPY_SRC)) throw new Error('Readback: the source buffer has no COPY_SRC usage');
    if (src.mapState !== 'unmapped') throw new Error(`Readback: the source buffer is ${src.mapState}`);
    if (bytes === 0) return Promise.resolve(new ArrayBuffer(0));
    const staging = this.take(bytes);
    this.device.pushErrorScope('validation');
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, offset, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    return this.copyOut(staging, bytes, this.device.popErrorScope());
  }

  /** Destroy every staging buffer, including those of reads in flight (which then reject). */
  destroy(): void {
    this.destroyed = true;
    for (const b of this.all) b.destroy();
    this.all.clear();
    this.free = [];
  }

  private take(bytes: number): GPUBuffer {
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const size = this.free[i]!.size;
      if (size >= bytes && (best < 0 || size < this.free[best]!.size)) best = i;
    }
    if (best >= 0) return this.free.splice(best, 1)[0]!;
    let size = MIN_STAGING;
    while (size < bytes) size *= 2;
    // A power of two can pass maxBufferSize where the read itself fits.
    const b = this.device.createBuffer({ size: Math.max(bytes, Math.min(size, this.device.limits.maxBufferSize)), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'readback staging' });
    this.all.add(b);
    this.created++;
    return b;
  }

  private async copyOut(staging: GPUBuffer, bytes: number, copied: Promise<GPUError | null>): Promise<ArrayBuffer> {
    let error: GPUError | null;
    try {
      [, error] = await Promise.all([staging.mapAsync(GPUMapMode.READ, 0, bytes), copied]);
    } catch (err) {
      if (this.destroyed) throw new Error('Readback: destroyed during a read');
      // Its state is unknown (unmapped under us, device lost), so it never goes back in the pool.
      this.all.delete(staging);
      staging.destroy();
      throw err;
    }
    // A real map rejects once destroy() runs; this covers one that resolved first.
    if (this.destroyed) throw new Error('Readback: destroyed during a read');
    if (error) {
      // Only the copy was bad: the staging buffer is sound, just stale.
      staging.unmap();
      this.free.push(staging);
      throw new Error(`Readback: the copy failed: ${error.message}`);
    }
    const out = staging.getMappedRange(0, bytes).slice(0);
    staging.unmap();
    this.free.push(staging);
    this.bytesRead += bytes;
    return out;
  }
}
