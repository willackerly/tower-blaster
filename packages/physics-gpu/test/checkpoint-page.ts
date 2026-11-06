// Page side of the GPU checkpoint tests (engine-checkpoint*.test.ts), bundled by loadBundle.
//
// Every case runs a scene twice on its own device: once straight through (the reference), and
// once with a checkpoint after `at` steps, a different future played from there (`diverge`:
// extra inputs and steps), then restore() and the same steps as the reference. The restored run
// must match the reference bit for bit at every step, and so must a second restore of the same
// checkpoint. With `poison`, every storage buffer the engine made, other than the ranges the
// checkpoint carries, is overwritten with garbage right after each restore, so a buffer a step
// reads before writing that the checkpoint does not carry breaks the match.
import type { InputEvent, SceneDesc, Snapshot } from '@tb/engine-api';
import { createDevice } from '@tb/gpu';
import type { AvbdParams } from '@tb/physics-ref';
import { GpuAvbdEngine, type GpuEngineOptions, type StateRegion } from '../src/index.ts';

export interface CheckpointCase {
  scene: SceneDesc;
  params?: Partial<AvbdParams>;
  opts?: Omit<GpuEngineOptions, 'device'>;
  /** Steps before the checkpoint. */
  at: number;
  /** The future thrown away: inputs pushed right after the checkpoint (steps are absolute), and how many steps it runs. */
  diverge: InputEvent[];
  divergeSteps: number;
  /** Steps compared after each restore. */
  after: number;
  /** Overwrite every uncarried storage range with garbage after each restore. */
  poison: boolean;
  /** The garbage, one u32 repeated (default POISON). A small integer is a valid index or axis, where pi's bits are not. */
  pattern?: number;
  /** Negative control: also overwrite this carried buffer (by label) after the restore; the run must then differ. */
  corrupt?: string;
  /** How many times the one checkpoint is restored and replayed (default 2). */
  restores?: number;
}

/** FNV-1a over every field of a snapshot (pose, velocities, awake, tier): equal states hash equal. */
function digest(s: Snapshot): string {
  let h = 0x811c9dc5;
  const arrays: ArrayBufferView[] = [s.pos, s.rot, s.linVel, s.angVel, s.awake, ...(s.tier ? [s.tier] : [])];
  for (const a of arrays) {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  }
  return `${s.count}:${h.toString(16).padStart(8, '0')}`;
}

/** The pattern written over uncarried ranges: pi as an f32 (a large u32 too). */
const POISON = new Uint32Array(Float32Array.of(Math.PI).buffer)[0]!;

export async function checkpointCase(c: CheckpointCase) {
  const { device } = await createDevice({ timestamps: false });
  // Every buffer the engines make on this device, until destroyed (a step can create one: BlastPass grows).
  const live = new Set<GPUBuffer>();
  const create = device.createBuffer.bind(device);
  device.createBuffer = (d: GPUBufferDescriptor) => {
    const b = create(d), destroy = b.destroy.bind(b);
    live.add(b);
    b.destroy = () => { live.delete(b); destroy(); };
    return b;
  };
  device.pushErrorScope('validation');
  // Room for the thrown-away future's spawns (the game's engines reserve the whole rack the same way).
  const opts = { spare: 4, ...(c.opts ?? {}), device };
  const trace = async (e: GpuAvbdEngine, steps: number) => {
    const out: string[] = [];
    for (let i = 0; i < steps; i++) {
      e.step();
      out.push(digest(await e.snapshot()));
    }
    const d = await e.diagnostics();
    // The sleep skip's count is left out of diag: how soon a skip starts depends on when an awake count comes back, never the floats.
    return { steps: out, step: e.stepIndex, skipped: d.sleepSkippedSteps, diag: { pairsRequiredPeak: d.pairsRequiredPeak, pairsOverflowSteps: d.pairsOverflowSteps, pairsWritten: d.pairsWritten } };
  };

  const ref = new GpuAvbdEngine(c.params ?? {}, opts);
  await ref.init(c.scene);
  for (let i = 0; i < c.at; i++) ref.step();
  const reference = await trace(ref, c.after);
  ref.dispose();

  const e = new GpuAvbdEngine(c.params ?? {}, opts);
  const before = new Set(live);
  await e.init(c.scene);
  for (let i = 0; i < c.at; i++) e.step();
  const atCheckpoint = digest(await e.snapshot());
  const cp = e.checkpoint();
  if (c.diverge.length) e.push(c.diverge);
  const thrown = await trace(e, c.divergeSteps);
  const runs: Awaited<ReturnType<typeof trace>>[] = [];
  const poisoned: Record<string, number> = {};
  const restoredAt: string[] = [];
  for (let r = 0; r < (c.restores ?? 2); r++) {
    cp.restore();
    restoredAt.push(digest(await e.snapshot()));
    if (c.poison || c.corrupt) {
      const mine = [...live].filter((b) => !before.has(b) && (b.usage & GPUBufferUsage.STORAGE) && (b.usage & GPUBufferUsage.COPY_DST));
      for (const b of mine) {
        const keep = c.corrupt && b.label === c.corrupt ? [] : cp.regions.filter((x: StateRegion) => x.buffer === b);
        if (!c.poison && !(c.corrupt && b.label === c.corrupt)) continue;
        for (const [lo, hi] of gaps(b.size, keep)) {
          device.queue.writeBuffer(b, lo, new Uint32Array((hi - lo) / 4).fill(c.pattern ?? POISON));
          poisoned[b.label || '(unlabelled)'] = (poisoned[b.label || '(unlabelled)'] ?? 0) + (hi - lo);
        }
      }
    }
    runs.push(await trace(e, c.after));
  }
  const pool = e.checkpointPool();
  cp.dispose();
  const poolAfter = e.checkpointPool();
  let restoreAfterDispose = '';
  try { cp.restore(); } catch (x) { restoreAfterDispose = (x as Error).message; }
  // A second checkpoint takes the first one's buffers back from the pool.
  const cp2 = e.checkpoint();
  const reused = e.checkpointPool().created === poolAfter.created;
  await e.init(c.scene);
  let restoreAfterInit = '';
  try { cp2.restore(); } catch (x) { restoreAfterInit = (x as Error).message; }
  cp2.dispose();
  e.dispose();
  const error = await device.popErrorScope();
  device.destroy();
  return {
    error: error?.message ?? null, reference, thrown, runs, atCheckpoint, restoredAt, poisoned,
    step: cp.step, bytes: cp.bytes, regions: cp.regions.map((r: StateRegion) => ({ label: r.buffer.label, offset: r.offset, size: r.size })),
    pool, poolAfter, reused, restoreAfterDispose, restoreAfterInit,
  };
}

/** The ranges of [0, size) outside `keep`, as [lo, hi) word-aligned pairs. */
function gaps(size: number, keep: readonly StateRegion[]): Array<[number, number]> {
  const sorted = [...keep].sort((a, b) => a.offset - b.offset), out: Array<[number, number]> = [];
  let at = 0;
  for (const r of sorted) {
    if (r.offset > at) out.push([at, r.offset]);
    at = Math.max(at, r.offset + r.size);
  }
  const end = size - (size % 4);
  if (end > at) out.push([at, end]);
  return out;
}
