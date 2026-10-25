// Where the renderer gets bodies from. Either way it sees the same four
// buffers: Body[] and Shape[] in the @tb/schema layouts, the previous step's
// Body[] (for interpolation), and one BodyLook u32 per slot.
//
// - SnapshotSource: CPU engines. Each update() writes a snapshot into
//   renderer-owned buffers.
// - GpuBodySource: GPU engines. Body[] and Shape[] are the engine's own
//   buffers; the only per-step work is a GPU copy into prev before each step.
import { emptySnapshot, TAG_BALL, type BodyDesc, type GpuBodies, type Snapshot } from '@tb/engine-api';
import { Body, FLAG_AWAKE, Shape, TIER } from '@tb/schema';
import { lookOf, lookRange, type LookRange } from './looks.ts';

export interface BodySource {
  readonly bodies: GPUBuffer;
  readonly prev: GPUBuffer;
  readonly shapes: GPUBuffer;
  readonly looks: GPUBuffer;
  readonly capacity: number;
  readonly count: number;
  /** Bumped whenever a buffer above is replaced, so users rebind. */
  readonly version: number;
  /** Slots of balls (TAG_BALL), in slot order: they carry the ball lights and trails. */
  readonly balls?: readonly number[];
}

/** Ball slots among descs[from..]. */
function ballSlots(descs: BodyDesc[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (descs[i]!.tag === TAG_BALL) out.push(i);
  return out;
}

const BODY_WORDS = Body.size / 4;
const SHAPE_WORDS = Shape.size / 4;
const BO = Object.fromEntries(Body.fields.map((f) => [f.name, f.offset / 4])) as Record<'pos' | 'invMass' | 'rot' | 'linVel' | 'flags' | 'angVel' | 'shape', number>;
const SO = Object.fromEntries(Shape.fields.map((f) => [f.name, f.offset / 4])) as Record<'half' | 'kind', number>;

// A function, not a constant: GPUBufferUsage does not exist in Node, where the packing helpers are tested.
const storage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

/** Body[] words for a snapshot (slot i = body i, Body.shape = i). */
export function packBodies(s: Snapshot, descs: BodyDesc[], out?: ArrayBuffer): ArrayBuffer {
  const bytes = Math.max(Body.size, s.count * Body.size);
  const data = out && out.byteLength >= bytes ? out : new ArrayBuffer(bytes);
  const f = new Float32Array(data), u = new Uint32Array(data);
  for (let i = 0; i < s.count; i++) {
    const o = i * BODY_WORDS;
    for (let k = 0; k < 3; k++) {
      f[o + BO.pos + k] = s.pos[3 * i + k]!;
      f[o + BO.linVel + k] = s.linVel[3 * i + k]!;
      f[o + BO.angVel + k] = s.angVel[3 * i + k]!;
    }
    for (let k = 0; k < 4; k++) f[o + BO.rot + k] = s.rot[4 * i + k]!;
    f[o + BO.invMass] = descs[i]!.density > 0 ? 1 : 0;
    u[o + BO.flags] = (s.awake[i] ? FLAG_AWAKE : 0) | (TIER.active << 8);
    u[o + BO.shape] = i;
  }
  return data;
}

/** Shape[] words, one per body. */
export function packShapes(descs: BodyDesc[], from = 0): Uint32Array {
  const n = descs.length - from;
  const data = new ArrayBuffer(Math.max(Shape.size, n * Shape.size));
  const f = new Float32Array(data), u = new Uint32Array(data);
  for (let j = 0; j < n; j++) {
    const s = descs[from + j]!.shape, o = j * SHAPE_WORDS;
    if (s.kind === 'box') {
      f[o + SO.half] = s.half[0]; f[o + SO.half + 1] = s.half[1]; f[o + SO.half + 2] = s.half[2];
      u[o + SO.kind] = 0;
    } else {
      f[o + SO.half] = f[o + SO.half + 1] = f[o + SO.half + 2] = s.radius;
      u[o + SO.kind] = 1;
    }
  }
  return u;
}

function packLooks(descs: BodyDesc[], from: number, range: LookRange): Uint32Array {
  const out = new Uint32Array(Math.max(1, descs.length - from));
  for (let i = from; i < descs.length; i++) out[i - from] = lookOf(descs[i]!, i, range);
  return out;
}

export class SnapshotSource implements BodySource {
  bodies!: GPUBuffer;
  prev!: GPUBuffer;
  shapes!: GPUBuffer;
  looks!: GPUBuffer;
  capacity = 0;
  count = 0;
  version = 0;
  balls: number[] = [];
  private described = 0;
  private range: LookRange | null = null;
  private scratch: ArrayBuffer | undefined;

  constructor(private readonly device: GPUDevice) {
    this.allocate(1024);
  }

  /**
   * Set the ramp range from the scene's initial bodies; call once per scene
   * before update(). Spawned bodies reuse it.
   */
  reset(initial: BodyDesc[]): void {
    this.range = lookRange(initial);
    this.count = 0;
    this.described = 0;
    this.balls = [];
  }

  private allocate(capacity: number): void {
    for (const b of [this.bodies, this.prev, this.shapes, this.looks]) b?.destroy();
    const make = (bytes: number, label: string) => this.device.createBuffer({ size: Math.max(16, bytes), usage: storage(), label });
    this.bodies = make(capacity * Body.size, 'snapshot bodies');
    this.prev = make(capacity * Body.size, 'snapshot prev bodies');
    this.shapes = make(capacity * Shape.size, 'snapshot shapes');
    this.looks = make(capacity * 4, 'snapshot looks');
    this.capacity = capacity;
    this.described = 0;
    this.balls = [];
    this.version++;
  }

  /** The current state becomes prev, then the snapshot becomes current. */
  update(s: Snapshot, descs: BodyDesc[]): void {
    if (descs.length < s.count) throw new Error(`SnapshotSource: ${s.count} bodies but ${descs.length} descriptions`);
    this.range ??= lookRange(descs.slice(0, s.count));
    const fresh = s.count > this.capacity;
    if (fresh) this.allocate(Math.ceil(s.count * 1.5));
    const q = this.device.queue;
    if (s.count > this.described) {
      const d = descs.slice(0, s.count);
      q.writeBuffer(this.shapes, this.described * Shape.size, packShapes(d, this.described));
      q.writeBuffer(this.looks, this.described * 4, packLooks(d, this.described, this.range));
      this.balls.push(...ballSlots(descs, this.described, s.count));
    }
    this.scratch = packBodies(s, descs, this.scratch);
    const bytes = s.count * Body.size;
    if (fresh || this.count === 0) {
      // No previous state on the GPU: prev = current, so nothing interpolates.
      if (bytes) q.writeBuffer(this.prev, 0, this.scratch, 0, bytes);
    } else {
      const enc = this.device.createCommandEncoder({ label: 'snapshot prev' });
      enc.copyBufferToBuffer(this.bodies, 0, this.prev, 0, this.count * Body.size);
      q.submit([enc.finish()]);
      // Newly spawned slots have no prev: mark them invalid (zero quaternion).
      if (s.count > this.count) q.writeBuffer(this.prev, this.count * Body.size, new Uint8Array((s.count - this.count) * Body.size));
    }
    if (bytes) q.writeBuffer(this.bodies, 0, this.scratch, 0, bytes);
    this.described = Math.max(this.described, s.count);
    this.count = s.count;
  }
}

/**
 * A GPU engine's own buffers, drawn in place. prev and looks are the
 * renderer's; call beforeStep() before every engine step so prev holds the
 * state the step starts from.
 */
export class GpuBodySource implements BodySource {
  readonly bodies: GPUBuffer;
  readonly shapes: GPUBuffer;
  readonly prev: GPUBuffer;
  readonly looks: GPUBuffer;
  readonly capacity: number;
  readonly version = 1;
  readonly balls: number[] = [];
  private described = 0;
  private readonly range: LookRange;

  constructor(private readonly gpu: GpuBodies, initial: BodyDesc[]) {
    const d = gpu.device;
    this.bodies = gpu.bodies;
    this.shapes = gpu.shapes;
    this.capacity = gpu.capacity;
    this.prev = d.createBuffer({ size: Math.max(16, gpu.capacity * Body.size), usage: storage(), label: 'gpu prev bodies' });
    this.looks = d.createBuffer({ size: Math.max(16, gpu.capacity * 4), usage: storage(), label: 'gpu looks' });
    this.range = lookRange(initial);
    this.beforeStep();
  }

  get count(): number {
    return this.gpu.count;
  }

  /** Copy the current state into prev; submit before the engine's step. */
  beforeStep(): void {
    const enc = this.gpu.device.createCommandEncoder({ label: 'prev bodies' });
    enc.copyBufferToBuffer(this.bodies, 0, this.prev, 0, this.capacity * Body.size);
    this.gpu.device.queue.submit([enc.finish()]);
  }

  /** Upload looks for bodies spawned since the last call (descs in slot order). */
  describe(descs: BodyDesc[]): void {
    const n = Math.min(descs.length, this.capacity);
    if (n <= this.described) return;
    this.gpu.device.queue.writeBuffer(this.looks, this.described * 4, packLooks(descs.slice(0, n), this.described, this.range));
    this.balls.push(...ballSlots(descs, this.described, n));
    this.described = n;
  }

  destroy(): void {
    this.prev.destroy();
    this.looks.destroy();
  }
}

/** Test helper: an engine-like GpuBodies built from descriptions (CPU-authored, same layouts). */
export function makeGpuBodies(device: GPUDevice, descs: BodyDesc[], capacity = descs.length): GpuBodies & { write(s: Snapshot): void } {
  const bodies = device.createBuffer({ size: Math.max(16, capacity * Body.size), usage: storage(), label: 'test bodies' });
  const shapes = device.createBuffer({ size: Math.max(16, capacity * Shape.size), usage: storage(), label: 'test shapes' });
  device.queue.writeBuffer(shapes, 0, packShapes(descs));
  const g = {
    device, bodies, shapes, capacity, count: descs.length,
    write(s: Snapshot) {
      g.count = s.count;
      device.queue.writeBuffer(bodies, 0, packBodies(s, descs), 0, s.count * Body.size);
    },
  };
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  g.write(s);
  return g;
}
