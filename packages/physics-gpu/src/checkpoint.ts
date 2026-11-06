// Checkpoints of the GPU engine (engine-api EngineCheckpoint; the game's undo takes one as each
// shot goes in). A step reads only a few of the engine's buffers as they were left by the step
// before; every other buffer is written by a step before that step reads it. A checkpoint copies
// just those carried ranges (StateRegion), on the GPU, into buffers of its own, and restore()
// copies them back: both are queue-ordered copies, so neither waits for the GPU.
//
// What carries over is declared by the stage that owns it (each stage's carried()), next to the
// code that reads it. The checkpoint tests (engine-checkpoint*.test.ts) hold that list complete:
// after a restore they overwrite every other storage buffer the engine made with garbage, and the
// run must still match, bit for bit, the run that never went back.
//
// The largest carried range is the contact history (AvbdSolver.contacts). It has two halves, one
// written by the last step and one written by the step before it; the next step reads the first
// and overwrites the second, so only the last step's half is carried: half the buffer.

/** Bytes [offset, offset + size) of `buffer`: a range a step reads as the step before left it. */
export interface StateRegion {
  buffer: GPUBuffer;
  offset: number;
  size: number;
}

/** The whole of `buffer`. */
export const whole = (buffer: GPUBuffer): StateRegion => ({ buffer, offset: 0, size: buffer.size });

/**
 * Copy buffers for checkpoints, by size: a checkpoint's buffers come back here when it is disposed
 * and the next checkpoint of the same engine takes them, so firing shot after shot (rapid fire)
 * does not create and free large buffers each time. Freed with the engine.
 */
export class CheckpointPool {
  private readonly free = new Map<number, GPUBuffer[]>();
  /** Buffers created so far (tests: reuse instead of growth). */
  created = 0;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {}

  take(size: number): GPUBuffer {
    if (this.destroyed) throw new Error('CheckpointPool: destroyed');
    const b = this.free.get(size)?.pop();
    if (b) return b;
    this.created++;
    return this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'checkpoint' });
  }

  give(b: GPUBuffer): void {
    if (this.destroyed) { b.destroy(); return; }
    const list = this.free.get(b.size);
    if (list) list.push(b);
    else this.free.set(b.size, [b]);
  }

  /** Bytes held by buffers waiting to be reused. */
  get spareBytes(): number {
    let s = 0;
    for (const [size, list] of this.free) s += size * list.length;
    return s;
  }

  destroy(): void {
    this.destroyed = true;
    for (const list of this.free.values()) for (const b of list) b.destroy();
    this.free.clear();
  }
}

/** Copy each region into a pooled buffer of its own size, in one submit; the copies, in region order. */
export function saveRegions(device: GPUDevice, pool: CheckpointPool, regions: readonly StateRegion[]): GPUBuffer[] {
  const enc = device.createCommandEncoder({ label: 'checkpoint save' });
  const out = regions.map((r) => {
    checkRegion(r);
    const b = pool.take(r.size);
    enc.copyBufferToBuffer(r.buffer, r.offset, b, 0, r.size);
    return b;
  });
  device.queue.submit([enc.finish()]);
  return out;
}

/** Copy saved buffers back over their regions, in one submit. */
export function restoreRegions(device: GPUDevice, regions: readonly StateRegion[], saved: readonly GPUBuffer[]): void {
  const enc = device.createCommandEncoder({ label: 'checkpoint restore' });
  regions.forEach((r, k) => enc.copyBufferToBuffer(saved[k]!, 0, r.buffer, r.offset, r.size));
  device.queue.submit([enc.finish()]);
}

function checkRegion(r: StateRegion): void {
  if (r.size <= 0 || r.size % 4 !== 0 || r.offset % 4 !== 0 || r.offset + r.size > r.buffer.size) throw new Error(`checkpoint: region ${r.offset}+${r.size} of ${r.buffer.label || 'a buffer'} (${r.buffer.size} B) is not a whole number of words inside it`);
  if (!(r.buffer.usage & GPUBufferUsage.COPY_SRC) || !(r.buffer.usage & GPUBufferUsage.COPY_DST)) throw new Error(`checkpoint: ${r.buffer.label || 'a carried buffer'} needs COPY_SRC and COPY_DST usage`);
}
