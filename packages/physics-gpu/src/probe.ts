// The solver probe (pnpm bench:probe), run in the page: where the GPU
// solver's time goes, and what the structures that could replace a
// dispatch per colour would cost on this device.
//
// P1  the adapter: limits that matter to compute, features, subgroup size.
// P2  the real solver on the S4 city: per-colour structure (bodies, W_c, the
//     points walked) read back from the engine's buffers at two checkpoints,
//     and each colour's primal dispatch timed on its own, R times back to
//     back, through AvbdSolver.encodeProbe (the real pipelines and bind
//     groups). Fits t_c = a + b W_c (+ e bodies_c), and checks the sum
//     against a timed solve pass of real steps.
// P3  synthetic per-point kernels (probe-kernels.ts): private array against
//     registers, global against shared poses, AoS against SoA records, record
//     size, gather order, threads per dispatch. Each variant is checked
//     against a CPU reference on every run.
// P4  synchronization: workgroupBarrier, a chain of dependent dispatches, a
//     grid barrier across workgroups (bounded spins), and the workgroup-tile
//     pattern (K colour phases x M iterations in one dispatch) against the
//     same work as K x M dispatches.
//
// Times are GPU timestamps around one compute pass per sample (each its own
// submit), median with p10/p90. Numbers from software adapters (SwiftShader)
// or without timestamps are not performance results; the result says so.
import { GpuProfiler, readBuffer, timeSubmit } from '@tb/gpu';
import { buildScenario, type Params } from '@tb/scenarios';
import { SolverContact } from '@tb/schema';
import { MAX_COLORS } from './coloring.ts';
import { GpuAvbdEngine } from './engine.ts';
import { DEFAULT_DISPATCH, type HessianForm } from './solver.ts';
import {
  barrierWgsl, BODY_PARAMS, exchangeRef, GRID_BARRIER_WGSL, KERNEL_PARAMS_BYTES, kernelParams, P3_EMPTY_WGSL, P3_VARIANT_INFO, P3_VARIANTS, p3Records,
  p3Reference, p3Wgsl, type P3Variant, type PoseOrder, posesFor, PROBE_TILE, probePoses, tileRecords, tileRef, tileWgsl,
} from './probe-kernels.ts';

export const PROBE_SECTIONS = ['p1', 'p2', 'p3', 'p4a', 'p4b', 'p4c', 'p4d'] as const;
export type ProbeSection = (typeof PROBE_SECTIONS)[number];

export interface ProbeOptions {
  sections: ProbeSection[];
  reps: number;
  warmup: number;
  /** P2: S4 city of N cubes (defaults otherwise), checkpoints in steps, R repeats per timed pass, solve passes timed before each checkpoint. */
  N: number;
  /** P2 on another scenario: its id and params (N is S4's only), scene gravity times gravityScale (S15 runs in plank-width units), and the engine's pairsPerBody. */
  scenario: string;
  params: Params;
  gravityScale: number;
  pairsPerBody: number | null;
  /** GpuEngineOptions.boxBroadphase. */
  boxBroadphase: boolean;
  seed: number;
  checkpoints: number[];
  R: number;
  solveSteps: number;
  /** P2: the primal's form (SolverDispatch.hessian), to time one against the other. */
  hessian: HessianForm;
  /** P3 sweep. inner: dispatches per timed pass (the time reported is per dispatch). */
  p3Variants: P3Variant[];
  p3Sizes: number[];
  p3Points: number[];
  p3Threads: number[];
  p3Orders: PoseOrder[];
  p3Inner: number;
  p3Reps: number;
  /** P4(a), (b): rounds, and workgroup sizes. */
  barrierRounds: number;
  barrierThreads: number[];
  /** P4(c): workgroup counts, rounds, and the bound on polls per wait. */
  gridGroups: number[];
  gridRounds: number;
  maxPolls: number;
  /** P4(d). */
  tileGroups: number[];
  tileThreads: number[];
  tileK: number[];
  tileIters: number[];
  tilePoints: number;
}

export const DEFAULT_PROBE: ProbeOptions = {
  sections: [...PROBE_SECTIONS],
  reps: 15,
  warmup: 3,
  N: 10000,
  scenario: 'S4',
  params: {},
  gravityScale: 1,
  pairsPerBody: null,
  boxBroadphase: false,
  seed: 1,
  checkpoints: [60, 300],
  R: 50,
  solveSteps: 10,
  hessian: DEFAULT_DISPATCH.hessian,
  p3Variants: [...P3_VARIANTS],
  p3Sizes: [32, 64, 96, 128],
  p3Points: [8, 16, 32, 56, 64],
  p3Threads: [64, 512, 2048, 10000],
  p3Orders: ['sorted', 'random'],
  p3Inner: 4,
  p3Reps: 10,
  barrierRounds: 1000,
  barrierThreads: [64, 256],
  // Past 128 to find where workgroups stop being co-resident.
  gridGroups: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
  gridRounds: 1000,
  maxPolls: 1_000_000,
  tileGroups: [8, 32, 128],
  tileThreads: [64, 128],
  tileK: [4, 8],
  tileIters: [1, 4, 8],
  tilePoints: 16,
};

/** --quick: every section, smaller (a couple of minutes on a real GPU). */
export const QUICK_PROBE: Partial<ProbeOptions> = {
  reps: 5, warmup: 2, N: 2000, checkpoints: [30, 90], R: 10, solveSteps: 4,
  p3Sizes: [32, 128], p3Points: [8, 56], p3Threads: [64, 2048], p3Inner: 2, p3Reps: 5,
  barrierRounds: 200, gridGroups: [1, 2, 8, 32, 128], gridRounds: 200,
  tileGroups: [8, 128], tileThreads: [64], tileK: [8], tileIters: [1, 8],
};

export interface Stat { median: number; p10: number; p90: number; samples: number }

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
const stat = (ms: number[]): Stat => ({ median: q(ms, 0.5), p10: q(ms, 0.1), p90: q(ms, 0.9), samples: ms.length });
const scale = (s: Stat, k: number): Stat => ({ ...s, median: s.median * k, p10: s.p10 * k, p90: s.p90 * k });

export interface P1Result {
  adapter: { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean };
  adapterFeatures: string[];
  deviceFeatures: string[];
  /** Every numeric limit: what the adapter offers, what the probe's device was granted (it asks for the adapter's). */
  limits: Record<string, { adapter: number; device: number }>;
  /** From GPUAdapterInfo, when the browser exposes it. */
  subgroupMinSize: number | null;
  subgroupMaxSize: number | null;
  /** subgroup_size seen by a 64-thread compute workgroup (needs the subgroups feature). */
  subgroupSizeObserved: number | null;
  requestedLimits: 'all' | 'compute' | 'default';
}

export interface ColourStat { colour: number; bodies: number; W: number; points: number; loads: number; t: Stat | null }
export interface Checkpoint {
  step: number;
  n: number;
  coloursUsed: number;
  uncolored: number;
  pairSlots: number;
  /** Pairs the broadphase found (bounding-sphere pairs, less those the box test drops when it is on) (written or not), and the slots whose manifold has at least one point. */
  pairsRequired: number;
  contactPairs: number;
  colorTail: number;
  tailThreads: number;
  direct: ColourStat[];
  /** Colours colorTail .. 62 by the tail workgroup (critical path: its slowest thread, summed over colours), then colour 63 by one thread. */
  tail: { colours: number; bodies: number; serialBodies: number; Wcrit: number; points: number; t: Stat | null };
  dual: Stat | null;
  /** The primal dispatch of an empty colour (one the sweep gives to the tail): the fixed cost of a direct colour's dispatch, every thread exiting at once. */
  emptyColour: number | null;
  emptyDispatch: Stat | null;
  /** The solve pass of the solveSteps steps up to the checkpoint (setup, every sweep, duals, velocities, finalize). */
  solvePass: Stat | null;
  sumW: number;
  totalPoints: number;
  check: { primal: number; predicted: number; measured: number | null } | null;
}
/** A least-squares fit of t_c (µs) on the named regressors (coefficients in µs per unit); null where they cannot be told apart. */
export interface Fit { model: string; coef: Record<string, number>; r2: number; adjR2: number; rmsUs: number; points: number }
export interface P2Result {
  scenario: string; params: Params; gravityScale: number; boxBroadphase: boolean; N: number; seed: number; iterations: number; R: number; checkpoints: Checkpoint[];
  /** The hessian form the engine built (SolverDispatch.hessian). */
  hessian: HessianForm;
  /** t = a + b W, t = a + b W + e bodies, t = a + e bodies, t = a + g Σpoints. */
  fits: Array<Fit | { model: string; singular: true }>;
  /** Over every direct colour with bodies: (t_c - empty dispatch) / W_c, in ns. */
  perPointNs: Stat | null;
  verdict: string[];
}

export interface P3Row { variant: P3Variant; S: number; P: number; T: number; order: PoseOrder; t: Stat; nsPerPoint: number; GBs: number }
export interface P3Check { variant: P3Variant; S: number; order: PoseOrder; maxRelErr: number }
export interface P3Slope { variant: P3Variant; S: number; T: number; order: PoseOrder; nsPerPoint: number; interceptUs: number }
export interface P3Result { empty: Record<number, Stat>; rows: P3Row[]; slopes: P3Slope[]; checks: P3Check[] }

export interface P4Result {
  barrier: Array<{ threads: number; rounds: number; withBarriers: Stat; without: Stat; nsPerBarrier: number; correct: boolean }>;
  chain: Array<{ threads: number; dispatches: number; t: Stat; nsPerDispatch: number; nsPerBarrierRound: number | null; correct: boolean }>;
  grid: Array<{ groups: number; rounds: number; completed: boolean; timedOut: boolean; skipped?: boolean; t: Stat | null; base: Stat | null; nsPerBarrier: number | null; pollsPerWait: number | null }>;
  tile: Array<{ threads: number; K: number; G: number; M: number; points: number; recordSets: number; tile: Stat; split: Stat; ratio: number; usPerPhaseTile: number; usPerPhaseSplit: number; tileErr: number | null; splitDiff: number }>;
  tileSkipped: string[];
}

export interface ProbeResult {
  software: boolean;
  timestamps: boolean;
  /** Timings are performance results: a hardware adapter with GPU timestamps. */
  valid: boolean;
  options: ProbeOptions;
  p1: P1Result;
  p2?: P2Result;
  p3?: P3Result;
  p4: Partial<P4Result>;
  errors: Array<{ section: string; message: string }>;
  wallSeconds: Record<string, number>;
}

const log = (msg: string) => console.log(`[probe] ${msg}`);
const NONE = 0xffffffff;

// --- P1 and the device -----------------------------------------------------

const COMPUTE_LIMITS = [
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension', 'maxStorageBuffersPerShaderStage', 'maxStorageBufferBindingSize', 'maxBufferSize', 'maxUniformBuffersPerShaderStage',
  'maxUniformBufferBindingSize', 'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout', 'maxBindGroups', 'maxBindingsPerBindGroup',
  'minStorageBufferOffsetAlignment', 'minUniformBufferOffsetAlignment',
];

async function openDevice(): Promise<{ device: GPUDevice; adapter: GPUAdapter; timestamps: boolean; p1: Omit<P1Result, 'subgroupSizeObserved'> }> {
  if (!('gpu' in navigator)) throw new Error('WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const al = adapter.limits as unknown as Record<string, number>;
  const all: Record<string, number> = {};
  for (const k in adapter.limits) if (typeof al[k] === 'number') all[k] = al[k];
  const features = (['timestamp-query', 'subgroups', 'shader-f16'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
  let device: GPUDevice | null = null;
  let requested: P1Result['requestedLimits'] = 'all';
  for (const [kind, limits] of [['all', all], ['compute', Object.fromEntries(COMPUTE_LIMITS.filter((k) => k in all).map((k) => [k, all[k]!]))], ['default', {}]] as const) {
    try {
      device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: limits });
      requested = kind;
      break;
    } catch (e) {
      log(`requestDevice with ${kind} limits failed: ${(e as Error).message}`);
    }
  }
  if (!device) throw new Error('requestDevice failed');
  const dl = device.limits as unknown as Record<string, number>;
  const limits: P1Result['limits'] = {};
  for (const k of Object.keys(all).sort()) limits[k] = { adapter: all[k]!, device: dl[k] ?? NaN };
  const info = adapter.info as GPUAdapterInfo & { subgroupMinSize?: number; subgroupMaxSize?: number; isFallbackAdapter?: boolean };
  return {
    device, adapter, timestamps: device.features.has('timestamp-query'),
    p1: {
      adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: !!info.isFallbackAdapter },
      adapterFeatures: [...adapter.features].sort() as string[],
      deviceFeatures: [...device.features].sort() as string[],
      limits,
      subgroupMinSize: info.subgroupMinSize ?? null,
      subgroupMaxSize: info.subgroupMaxSize ?? null,
      requestedLimits: requested,
    },
  };
}

async function observeSubgroupSize(device: GPUDevice): Promise<number | null> {
  if (!device.features.has('subgroups' as GPUFeatureName)) return null;
  const code = `enable subgroups;
@group(0) @binding(0) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(subgroup_size) sg: u32, @builtin(local_invocation_index) l: u32) { if (l == 0u) { o[0] = sg; } }`;
  const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] }));
  pass.dispatchWorkgroups(1);
  pass.end();
  device.queue.submit([enc.finish()]);
  const v = new Uint32Array(await readBuffer(device, buf, 16))[0]!;
  buf.destroy();
  return v;
}

// --- Timing ----------------------------------------------------------------

class Timer {
  private readonly prof: GpuProfiler;
  constructor(private readonly device: GPUDevice, readonly timestamps: boolean) {
    this.prof = new GpuProfiler(device, 4);
  }

  /** ms of one compute pass recorded by `record`; `before` runs in the same command buffer ahead of it (resets), untimed with timestamps. */
  async sample(record: (pass: GPUComputePassEncoder) => void, before?: (enc: GPUCommandEncoder) => void, after?: (enc: GPUCommandEncoder) => void): Promise<number> {
    const { device, prof } = this;
    if (!this.timestamps) {
      return timeSubmit(device, (enc) => {
        before?.(enc);
        const pass = enc.beginComputePass();
        record(pass);
        pass.end();
        after?.(enc);
      });
    }
    prof.begin();
    const enc = device.createCommandEncoder();
    before?.(enc);
    const pass = enc.beginComputePass(prof.pass('t'));
    record(pass);
    pass.end();
    after?.(enc);
    prof.resolve(enc);
    device.queue.submit([enc.finish()]);
    return (await prof.collect()).t ?? NaN;
  }

  async stat(record: (pass: GPUComputePassEncoder) => void, reps: number, warmup: number, before?: (enc: GPUCommandEncoder) => void): Promise<Stat> {
    const ms: number[] = [];
    for (let r = 0; r < warmup + reps; r++) {
      const t = await this.sample(record, before);
      if (r >= warmup) ms.push(t);
    }
    return stat(ms);
  }

  /** The profiler's timestampWrites for a pass recorded elsewhere (one per frame), then its ms. */
  frame(): { writes: GPUComputePassTimestampWrites | undefined; collect: () => Promise<number> } {
    const { device, prof } = this;
    if (!this.timestamps) return { writes: undefined, collect: async () => NaN };
    prof.begin();
    const writes = prof.pass('t').timestampWrites;
    return {
      writes,
      collect: async () => {
        const enc = device.createCommandEncoder();
        prof.resolve(enc);
        device.queue.submit([enc.finish()]);
        return (await prof.collect()).t ?? NaN;
      },
    };
  }

  destroy(): void {
    this.prof.destroy();
  }
}

const storage = (device: GPUDevice, bytes: number, label: string, extra = 0) =>
  device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra, label });
function upload(device: GPUDevice, data: ArrayBufferView & { byteLength: number }, label: string): GPUBuffer {
  const b = storage(device, data.byteLength, label);
  device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
  return b;
}
const uniform = (device: GPUDevice, bytes: number, label: string) => device.createBuffer({ size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label });
type Kind = 'r' | 'rw' | 'u' | 'ud';
function layoutOf(device: GPUDevice, kinds: Kind[], dynSize = 16): GPUPipelineLayout {
  return device.createPipelineLayout({
    bindGroupLayouts: [device.createBindGroupLayout({
      entries: kinds.map((k, binding) => ({
        binding, visibility: GPUShaderStage.COMPUTE,
        buffer: k === 'r' ? { type: 'read-only-storage' as const } : k === 'rw' ? { type: 'storage' as const } : k === 'u' ? { type: 'uniform' as const } : { type: 'uniform' as const, hasDynamicOffset: true, minBindingSize: dynSize },
      })),
    })],
  });
}
function pipeline(device: GPUDevice, layout: GPUPipelineLayout, code: string, entryPoint: string, label: string): GPUComputePipeline {
  return device.createComputePipeline({ layout, label, compute: { module: device.createShaderModule({ code, label }), entryPoint } });
}
const bind = (device: GPUDevice, layout: GPUBindGroupLayout, buffers: Array<GPUBuffer | [GPUBuffer, number]>) =>
  device.createBindGroup({ layout, entries: buffers.map((b, binding) => ({ binding, resource: Array.isArray(b) ? { buffer: b[0], size: b[1] } : { buffer: b } })) });

/** Least squares y = X c (columns of X given), with R^2, adjusted R^2 and the RMS residual. */
function lsq(cols: number[][], y: number[]): { c: number[]; r2: number; adjR2: number; rms: number } | null {
  const m = cols.length, n = y.length;
  if (n <= m) return null;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (j < m ? cols[i]!.reduce((s, v, k) => s + v * cols[j]![k]!, 0) : cols[i]!.reduce((s, v, k) => s + v * y[k]!, 0))));
  // Collinear regressors (a W_c that never varies) leave a pivot that is rounding error next to its diagonal.
  const diag = A.map((row, i) => Math.abs(row[i]!));
  for (let i = 0; i < m; i++) {
    let p = i;
    for (let r = i + 1; r < m; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[p]![i]!)) p = r;
    [A[i], A[p]] = [A[p]!, A[i]!];
    if (!(Math.abs(A[i]![i]!) > 1e-9 * Math.max(...diag))) return null;
    for (let r = 0; r < m; r++) if (r !== i) { const f = A[r]![i]! / A[i]![i]!; for (let j = i; j <= m; j++) A[r]![j]! -= f * A[i]![j]!; }
  }
  const c = A.map((row, i) => row[m]! / row[i]!);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  let ssr = 0, sst = 0;
  y.forEach((v, k) => { const f = cols.reduce((s, col, i) => s + c[i]! * col[k]!, 0); ssr += (v - f) ** 2; sst += (v - mean) ** 2; });
  const r2 = sst > 0 ? 1 - ssr / sst : 1;
  return { c, r2, adjR2: 1 - ((1 - r2) * (n - 1)) / (n - m), rms: Math.sqrt(ssr / n) };
}

// --- P2 --------------------------------------------------------------------

async function colourStructure(e: GpuAvbdEngine): Promise<Omit<Checkpoint, 'step' | 'dual' | 'solvePass' | 'check' | 'emptyDispatch'>> {
  const pp = e.probeParts();
  const { device, n, solver, col, maxPairs, capacity, dispatch } = pp;
  const d = await e.diagnostics();
  const u32 = async (b: GPUBuffer, bytes: number, offset = 0) => new Uint32Array(await readBuffer(device, b, Math.max(4, bytes), offset));
  const colorStart = await u32(col.colorStart, (MAX_COLORS + 1) * 4);
  const order = await u32(col.order, n * 4);
  const rowStart = await u32(col.rowStart, n * 4);
  const rowLength = await u32(col.rowLength, n * 4);
  let edges = 0;
  for (let i = 0; i < n; i++) edges = Math.max(edges, rowStart[i]! + rowLength[i]!);
  // Past maxEdges (an overflowed fill) the row holds nothing the probe can read; those entries count no points.
  edges = Math.min(edges, col.maxEdges);
  const adjSlot = await u32(col.adjSlot, edges * 4);
  const CS = SolverContact.size, usedAt = SolverContact.fields.find((f) => f.name === 'used')!.offset / 4;
  const half = solver.lastHalf, halfSize = (maxPairs + capacity) * 4;
  const slots = d.pairsWritten;
  const pairPts = await u32(solver.contacts, slots * 4 * CS, half * halfSize * CS);
  const groundPts = await u32(solver.contacts, n * 4 * CS, (half * halfSize + maxPairs * 4) * CS);
  // Points a body's primal walks: used points of each slot in its row, then its ground slot; loads add the read that ends a partial slot.
  const walk = (pts: Uint32Array, slot: number) => {
    let k = 0;
    while (k < 4 && pts[(slot * 4 + k) * (CS / 4) + usedAt] !== 0) k++;
    return k;
  };
  const pointsOf = new Uint32Array(n), loadsOf = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0, l = 0;
    for (let e2 = rowStart[i]!; e2 < rowStart[i]! + rowLength[i]!; e2++) {
      const s = adjSlot[e2] ?? NONE;
      const k = s < slots ? walk(pairPts, s) : 0;
      p += k; l += Math.min(4, k + 1);
    }
    const g = walk(groundPts, i);
    p += g; l += Math.min(4, g + 1);
    pointsOf[i] = p; loadsOf[i] = l;
  }
  const bodiesOf = (c: number) => Array.from(order.subarray(colorStart[c]!, colorStart[c + 1]!));
  const direct: ColourStat[] = [];
  const nd = dispatch.indirectColors ? MAX_COLORS - 1 : dispatch.colorTail;
  for (let c = 0; c < nd; c++) {
    const bs = bodiesOf(c);
    direct.push({ colour: c, bodies: bs.length, W: bs.reduce((m, b) => Math.max(m, pointsOf[b]!), 0), points: bs.reduce((s, b) => s + pointsOf[b]!, 0), loads: bs.reduce((m, b) => Math.max(m, loadsOf[b]!), 0), t: null });
  }
  let tailColours = 0, tailBodies = 0, Wcrit = 0, tailPoints = 0;
  for (let c = nd; c < MAX_COLORS - 1; c++) {
    const bs = bodiesOf(c);
    if (!bs.length) continue;
    tailColours++; tailBodies += bs.length;
    const perThread = new Array<number>(dispatch.tailThreads).fill(0);
    bs.forEach((b, k) => { perThread[k % dispatch.tailThreads]! += pointsOf[b]!; tailPoints += pointsOf[b]!; });
    Wcrit += Math.max(...perThread);
  }
  let emptyColour: number | null = null;
  for (let c = nd; c < MAX_COLORS - 1 && emptyColour === null; c++) if (colorStart[c + 1] === colorStart[c]) emptyColour = c;
  const serial = bodiesOf(MAX_COLORS - 1);
  for (const b of serial) { Wcrit += pointsOf[b]!; tailPoints += pointsOf[b]!; }
  const totalPoints = pointsOf.reduce((s, v) => s + v, 0);
  let contactPairs = 0;
  for (let k = 0; k < slots; k++) if (walk(pairPts, k) > 0) contactPairs++;
  return {
    n, coloursUsed: d.colors, uncolored: d.uncolored, pairSlots: slots, pairsRequired: d.pairsRequired, contactPairs, colorTail: nd, tailThreads: dispatch.tailThreads, direct,
    tail: { colours: tailColours, bodies: tailBodies, serialBodies: serial.length, Wcrit, points: tailPoints, t: null },
    sumW: direct.reduce((s, c) => s + c.W, 0) + Wcrit, totalPoints, emptyColour,
  };
}

async function runP2(device: GPUDevice, timer: Timer, o: ProbeOptions): Promise<P2Result> {
  const built = buildScenario(o.scenario, o.scenario === 'S4' ? { N: o.N, ...o.params } : o.params, o.seed);
  const scene = { ...built, gravity: built.gravity.map((g) => g * o.gravityScale) as typeof built.gravity };
  const checkpoints: Checkpoint[] = [];
  let iterations = 0, hessian = o.hessian;
  for (const step of o.checkpoints) {
    // A fresh engine per checkpoint: the probes below change contact state (the dual), which would carry into later steps.
    const e = new GpuAvbdEngine({}, { device, hessian: o.hessian, ...(o.pairsPerBody ? { pairsPerBody: o.pairsPerBody } : {}), ...(o.boxBroadphase ? { boxBroadphase: true } : {}) });
    await e.init(scene);
    iterations = e.probeParts().iterations;
    hessian = e.probeParts().dispatch.hessian;
    const timedFrom = Math.max(0, step - o.solveSteps);
    for (let s = 0; s < timedFrom; s++) {
      e.step();
      if (s % 20 === 19) await e.finish();
    }
    await e.finish();
    const solveMs: number[] = [];
    for (let s = timedFrom; s < step; s++) {
      if (timer.timestamps) {
        const f = timer.frame();
        e.probeStep(f.writes!);
        solveMs.push(await f.collect());
      } else {
        const t0 = performance.now();
        e.step();
        await e.finish();
        solveMs.push(performance.now() - t0);
      }
    }
    await e.finish();
    log(`P2 step ${step}: reading the colour structure`);
    const st = await colourStructure(e);
    const { solver, n } = e.probeParts();
    const per = (piece: Parameters<typeof solver.encodeProbe>[2]) => timer.stat((pass) => solver.encodeProbe(pass, n, piece, o.R), o.reps, o.warmup).then((s) => scale(s, 1 / o.R));
    for (const c of st.direct) c.t = await per({ primal: c.colour });
    st.tail.t = await per('tail');
    const emptyDispatch = st.emptyColour === null ? null : await per({ primal: st.emptyColour });
    // Last: it changes the contact state (the others only dp and phi).
    const dual = await per('dual');
    await e.finish();
    e.dispose();
    const solvePass = solveMs.length ? stat(solveMs) : null;
    const sumC = st.direct.reduce((s, c) => s + (c.t?.median ?? 0), 0);
    const check = {
      primal: (iterations + 1) * sumC,
      predicted: (iterations + 1) * (sumC + (st.tail.t?.median ?? 0)) + iterations * dual.median,
      measured: solvePass?.median ?? null,
    };
    checkpoints.push({ step, ...st, dual, emptyDispatch, solvePass, check });
    log(`P2 step ${step}: ΣW ${st.sumW}, solve ${solvePass?.median.toFixed(3)} ms, predicted ${check.predicted.toFixed(3)} ms`);
  }
  // t_c against W_c, bodies_c and the colour's points, over the direct colours of every checkpoint, in µs.
  const pts = checkpoints.flatMap((c) => c.direct.filter((d) => d.t).map((d) => ({ ...d, t: d.t!.median * 1000, empty: c.emptyDispatch ? c.emptyDispatch.median * 1000 : null })));
  const one = pts.map(() => 1), y = pts.map((p) => p.t);
  const col = (k: 'W' | 'bodies' | 'points') => pts.map((p) => p[k]);
  const fits: P2Result['fits'] = [];
  const fit = (model: string, names: string[], cols: number[][]) => {
    const r = lsq([one, ...cols], y);
    const out = r ? { model, coef: Object.fromEntries(['a', ...names].map((k, i) => [k, r.c[i]!])), r2: r.r2, adjR2: r.adjR2, rmsUs: r.rms, points: pts.length } : null;
    fits.push(out ?? { model, singular: true });
    return out;
  };
  const fW = fit('t = a + b·W', ['b'], [col('W')]);
  const fWB = fit('t = a + b·W + e·bodies', ['b', 'e'], [col('W'), col('bodies')]);
  const fB = fit('t = a + e·bodies', ['e'], [col('bodies')]);
  fit('t = a + g·Σpoints', ['g'], [col('points')]);
  const per = pts.filter((p) => p.bodies > 0 && p.W > 0 && p.empty !== null).map((p) => ((p.t - p.empty!) / p.W) * 1000);
  const perPointNs = per.length ? stat(per) : null;
  const verdict: string[] = [];
  const Ws = col('W').filter((_, i) => pts[i]!.bodies > 0);
  const spread = Ws.length ? Math.max(...Ws) - Math.min(...Ws) : 0;
  if (!pts.length) verdict.push('No colour was timed.');
  else if (!fW || spread === 0) verdict.push(`W_c is ${Ws[0] ?? 0} in every direct colour with bodies, so t = a + b·W cannot tell b from a here.`);
  else if (fWB) {
    const better = fWB.adjR2 - fW.adjR2 > 0.02 && fWB.rmsUs < 0.8 * fW.rmsUs;
    verdict.push(better
      ? `W_c alone leaves structure the body count explains: adjusted R² ${fW.adjR2.toFixed(3)} -> ${fWB.adjR2.toFixed(3)}, RMS ${fW.rmsUs.toFixed(2)} -> ${fWB.rmsUs.toFixed(2)} µs; a colour's size costs ${(fWB.coef.e! * 1000).toFixed(1)} ns per body beyond its slowest thread.`
      : `W_c explains the colour times (adjusted R² ${fW.adjR2.toFixed(3)}, RMS ${fW.rmsUs.toFixed(2)} µs, ${(fW.coef.b! * 1000).toFixed(0)} ns per point); adding the body count does not help (adjusted R² ${fWB.adjR2.toFixed(3)}), so the slowest thread's walk sets the time.`);
  }
  if (fB) {
    const big = pts.reduce((m, p) => (p.bodies > m.bodies ? p : m), pts[0]!);
    const share = (fB.coef.e! * big.bodies) / big.t;
    verdict.push(`Against the body count: t_c = ${fB.coef.a!.toFixed(2)} µs + ${(fB.coef.e! * 1000).toFixed(1)} ns × bodies_c (R² ${fB.r2.toFixed(3)}); in the largest colour (${big.bodies} bodies, ${big.t.toFixed(1)} µs) the size term is ${(100 * share).toFixed(0)}% of the time. ${share > 0.5
      ? 'Most of a big colour\'s time grows with its size, so the sweep is throughput-bound (the GPU is full), not one thread\'s serial walk.'
      : share < 0.2 ? 'A colour costs about the same whatever its size: the slowest thread\'s serial walk (latency) sets it.' : 'Both the size and the slowest thread matter.'}`);
  }
  if (perPointNs) verdict.push(`Per critical-path point, (t_c − empty dispatch) / W_c = ${perPointNs.median.toFixed(0)} ns (p10 ${perPointNs.p10.toFixed(0)}, p90 ${perPointNs.p90.toFixed(0)}) over ${per.length} colours.`);
  return { scenario: o.scenario, params: scene.params as Params, gravityScale: o.gravityScale, boxBroadphase: o.boxBroadphase, N: scene.bodies.length, seed: o.seed, iterations, R: o.R, checkpoints, hessian, fits, perPointNs, verdict };
}

// --- P3 --------------------------------------------------------------------

/** Lay the canonical 128-byte AoS records out at size S, AoS or SoA. */
function relayout(canon: Float32Array, threads: number, stride: number, S: number, soa: boolean): Float32Array {
  const V = S / 16;
  if (V === 8 && !soa) return canon;
  const out = new Float32Array(threads * stride * V * 4);
  for (let id = 0; id < threads * stride; id++) {
    const i = Math.floor(id / stride), k = id % stride;
    for (let j = 0; j < V; j++) out.set(canon.subarray((id * 8 + j) * 4, (id * 8 + j) * 4 + 4), soa ? (j * threads * stride + k * threads + i) * 4 : (id * V + j) * 4);
  }
  return out;
}
function p3Canon(threads: number, stride: number, order: PoseOrder): Float32Array {
  return p3Records(threads, stride, 128, order, false);
}

async function runP3(device: GPUDevice, timer: Timer, o: ProbeOptions): Promise<P3Result> {
  const layout = layoutOf(device, ['r', 'r', 'rw', 'u']);
  const pipes = new Map<string, GPUComputePipeline>();
  const pipe = (v: P3Variant | 'empty', S: number) => {
    const key = `${v}-${S}`;
    if (!pipes.has(key)) pipes.set(key, pipeline(device, layout, v === 'empty' ? P3_EMPTY_WGSL : p3Wgsl(v, S), 'main', `probe p3 ${key}`));
    return pipes.get(key)!;
  };
  const ub = uniform(device, KERNEL_PARAMS_BYTES, 'p3 params');
  const params = (threads: number, points: number, stride: number) => device.queue.writeBuffer(ub, 0, kernelParams({ threads, points, stride, nposes: posesFor(threads), ...BODY_PARAMS, iters: 0 }));
  const variants = o.p3Variants;

  // Every variant against the CPU reference: 96 threads (one full workgroup and one partial), 8 points.
  const checks: P3Check[] = [];
  {
    const T = 96, P = 8;
    const poses = probePoses(posesFor(T));
    const pb = upload(device, poses, 'p3 check poses'), out = storage(device, 6 * T * 4, 'p3 check out');
    for (const order of o.p3Orders) {
      const canon = p3Canon(T, P, order);
      for (const S of o.p3Sizes) for (const soa of [false, true]) {
        const vs = variants.filter((v) => P3_VARIANT_INFO[v].soa === soa);
        if (!vs.length) continue;
        const recs = relayout(canon, T, P, S, soa);
        const rb = upload(device, recs, 'p3 check records');
        const ref = p3Reference(recs, poses, T, P, P, S, soa);
        const scaleRef = ref.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
        for (const v of vs) {
          params(T, P, P);
          const p = pipe(v, S);
          const enc = device.createCommandEncoder();
          enc.clearBuffer(out);
          const pass = enc.beginComputePass();
          pass.setPipeline(p);
          pass.setBindGroup(0, bind(device, p.getBindGroupLayout(0), [rb, pb, out, ub]));
          pass.dispatchWorkgroups(Math.ceil(T / 64));
          pass.end();
          device.queue.submit([enc.finish()]);
          const got = new Float32Array(await readBuffer(device, out, 6 * T * 4));
          let err = 0;
          got.forEach((g, k) => { err = Math.max(err, Number.isFinite(g) ? Math.abs(g - ref[k]!) / scaleRef : Infinity); });
          checks.push({ variant: v, S, order, maxRelErr: err });
        }
        rb.destroy();
      }
    }
    pb.destroy(); out.destroy();
  }
  log(`P3 checks: worst relative error ${Math.max(...checks.map((c) => c.maxRelErr)).toExponential(2)}`);

  const stride = Math.max(...o.p3Points);
  const rows: P3Row[] = [];
  const empty: Record<number, Stat> = {};
  for (const T of o.p3Threads) {
    const groups = Math.ceil(T / 64);
    const poses = probePoses(posesFor(T));
    const pb = upload(device, poses, 'p3 poses'), out = storage(device, 6 * T * 4, 'p3 out');
    const emptyPipe = pipe('empty', 32);
    {
      const rb = storage(device, 16, 'p3 empty records');
      params(T, 0, stride);
      const bg = bind(device, emptyPipe.getBindGroupLayout(0), [rb, pb, out, ub]);
      empty[T] = scale(await timer.stat((pass) => { pass.setPipeline(emptyPipe); pass.setBindGroup(0, bg); for (let r = 0; r < o.p3Inner; r++) pass.dispatchWorkgroups(groups); }, o.p3Reps, o.warmup), 1 / o.p3Inner);
      rb.destroy();
    }
    for (const order of o.p3Orders) {
      const canon = p3Canon(T, stride, order);
      for (const S of o.p3Sizes) for (const soa of [false, true]) {
        const vs = variants.filter((v) => P3_VARIANT_INFO[v].soa === soa);
        if (!vs.length) continue;
        const rb = upload(device, relayout(canon, T, stride, S, soa), 'p3 records');
        for (const v of vs) {
          const p = pipe(v, S);
          const bg = bind(device, p.getBindGroupLayout(0), [rb, pb, out, ub]);
          for (const P of o.p3Points) {
            params(T, P, stride);
            const t = scale(await timer.stat((pass) => { pass.setPipeline(p); pass.setBindGroup(0, bg); for (let r = 0; r < o.p3Inner; r++) pass.dispatchWorkgroups(groups); }, o.p3Reps, o.warmup), 1 / o.p3Inner);
            const shared = P3_VARIANT_INFO[v].shared;
            const bytes = T * P * (S + (shared ? 0 : 32)) + T * (32 + 24) + (shared ? groups * PROBE_TILE * 32 : 0);
            rows.push({ variant: v, S, P, T, order, t, nsPerPoint: ((t.median - empty[T]!.median) / P) * 1e6, GBs: bytes / (t.median * 1e6) });
          }
        }
        rb.destroy();
      }
      log(`P3 T=${T} ${order} done`);
    }
    pb.destroy(); out.destroy();
  }
  ub.destroy();
  // Marginal cost per point: the slope of dispatch time over P.
  const slopes: P3Slope[] = [];
  const groupsOf = new Map<string, P3Row[]>();
  for (const r of rows) {
    const k = `${r.variant}|${r.S}|${r.T}|${r.order}`;
    groupsOf.set(k, [...(groupsOf.get(k) ?? []), r]);
  }
  for (const rs of groupsOf.values()) {
    const f = lsq([rs.map(() => 1), rs.map((r) => r.P)], rs.map((r) => r.t.median * 1e6));
    const r0 = rs[0]!;
    if (f) slopes.push({ variant: r0.variant, S: r0.S, T: r0.T, order: r0.order, nsPerPoint: f.c[1]!, interceptUs: f.c[0]! / 1000 });
    else if (rs.length === 2) {
      const [a, b] = rs as [P3Row, P3Row];
      const s = ((b.t.median - a.t.median) * 1e6) / (b.P - a.P);
      slopes.push({ variant: r0.variant, S: r0.S, T: r0.T, order: r0.order, nsPerPoint: s, interceptUs: (a.t.median * 1e6 - s * a.P) / 1000 });
    }
  }
  return { empty, rows, slopes, checks };
}

// --- P4 --------------------------------------------------------------------

async function runBarriers(device: GPUDevice, timer: Timer, o: ProbeOptions, out: Partial<P4Result>, which: { a: boolean; b: boolean }): Promise<void> {
  const layout = layoutOf(device, ['rw', 'rw', 'u']);
  out.barrier = [];
  out.chain = [];
  for (const threads of o.barrierThreads) {
    if (threads > device.limits.maxComputeInvocationsPerWorkgroup) continue;
    const code = barrierWgsl(threads);
    const N = o.barrierRounds;
    const init = Uint32Array.from({ length: threads }, (_, l) => l);
    const A = upload(device, init, 'p4 A'), B = storage(device, threads * 4, 'p4 B'), I = upload(device, init, 'p4 init');
    const ub = uniform(device, 16, 'p4 q');
    device.queue.writeBuffer(ub, 0, new Uint32Array([N, 1, 0, 0]));
    const expect = exchangeRef(threads, N);
    const same = (got: Uint32Array) => got.every((v, k) => v === expect[k]);
    let perRound: number | null = null;
    if (which.a) {
      const pb = pipeline(device, layout, code, 'barriers', 'p4 barriers'), pn = pipeline(device, layout, code, 'nobarriers', 'p4 no barriers');
      const bg = bind(device, pb.getBindGroupLayout(0), [A, B, ub]);
      const run = (p: GPUComputePipeline) => (pass: GPUComputePassEncoder) => { pass.setPipeline(p); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(1); };
      const withB = await timer.stat(run(pb), o.reps, o.warmup);
      const correct = same(new Uint32Array(await readBuffer(device, B, threads * 4)));
      const without = await timer.stat(run(pn), o.reps, o.warmup);
      perRound = withB.median / N;
      out.barrier.push({ threads, rounds: N, withBarriers: withB, without, nsPerBarrier: ((withB.median - without.median) / (2 * N)) * 1e6, correct });
    }
    if (which.b) {
      const px = pipeline(device, layout, code, 'exchange', 'p4 exchange');
      const ab = bind(device, px.getBindGroupLayout(0), [A, B, ub]), ba = bind(device, px.getBindGroupLayout(0), [B, A, ub]);
      const t = await timer.stat((pass) => {
        pass.setPipeline(px);
        for (let j = 0; j < N; j++) { pass.setBindGroup(0, j % 2 ? ba : ab); pass.dispatchWorkgroups(1); }
      }, o.reps, o.warmup, (enc) => enc.copyBufferToBuffer(I, 0, A, 0, threads * 4));
      const correct = same(new Uint32Array(await readBuffer(device, N % 2 ? B : A, threads * 4)));
      out.chain.push({ threads, dispatches: N, t, nsPerDispatch: (t.median / N) * 1e6, nsPerBarrierRound: perRound === null ? null : perRound * 1e6, correct });
    }
    for (const b of [A, B, I, ub]) b.destroy();
  }
}

async function runGrid(device: GPUDevice, timer: Timer, o: ProbeOptions, out: Partial<P4Result>): Promise<void> {
  const layout = layoutOf(device, ['rw', 'rw', 'u']);
  const p = pipeline(device, layout, GRID_BARRIER_WGSL, 'grid', 'p4 grid barrier');
  const s = storage(device, 16, 'p4 grid sync');
  const staging = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const ub = uniform(device, 16, 'p4 grid q');
  out.grid = [];
  let failedAt: number | null = null;
  for (const W of o.gridGroups) {
    const N = o.gridRounds;
    if (failedAt !== null) { out.grid.push({ groups: W, rounds: N, completed: false, timedOut: false, skipped: true, t: null, base: null, nsPerBarrier: null, pollsPerWait: null }); continue; }
    const ob = storage(device, W * 64 * 4, 'p4 grid out');
    const bg = bind(device, p.getBindGroupLayout(0), [s, ob, ub]);
    const run = (pass: GPUComputePassEncoder) => { pass.setPipeline(p); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(W); };
    device.queue.writeBuffer(ub, 0, new Uint32Array([N, W, o.maxPolls, 0]));
    const base = await timer.stat(run, o.reps, o.warmup, (enc) => enc.clearBuffer(s));
    device.queue.writeBuffer(ub, 0, new Uint32Array([N, W, o.maxPolls, 1]));
    const ms: number[] = [];
    let completed = true, timedOut = false, polls = 0, waits = 0;
    for (let r = 0; r < o.warmup + o.reps; r++) {
      const t = await timer.sample(run, (enc) => enc.clearBuffer(s), (enc) => enc.copyBufferToBuffer(s, 0, staging, 0, 16));
      await staging.mapAsync(GPUMapMode.READ);
      const [arrivals, failed, spent, finished] = new Uint32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      const ok = failed === 0 && arrivals === N * W && finished === W;
      if (!ok) { completed = false; timedOut = failed !== 0; ms.push(t); break; }
      // One wait per workgroup per round (the last to arrive finds the count reached at once).
      polls += spent!; waits += N * W;
      if (r >= o.warmup) ms.push(t);
    }
    const t = ms.length ? stat(ms) : null;
    out.grid.push({ groups: W, rounds: N, completed, timedOut, t, base, nsPerBarrier: completed && t ? ((t.median - base.median) / N) * 1e6 : null, pollsPerWait: completed && waits ? polls / waits : null });
    log(`P4c W=${W}: ${completed ? 'completed' : timedOut ? 'timed out' : 'incomplete'}`);
    ob.destroy();
    if (!completed) failedAt = W;
  }
  for (const b of [s, staging, ub]) b.destroy();
}

async function runTile(device: GPUDevice, timer: Timer, o: ProbeOptions, out: Partial<P4Result>): Promise<void> {
  out.tile = [];
  out.tileSkipped = [];
  const layout = layoutOf(device, ['r', 'rw', 'u', 'ud']);
  const DYN = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
  const P = o.tilePoints;
  const maxBytes = Math.min(device.limits.maxStorageBufferBindingSize, 128 * 2 ** 20);
  for (const threads of o.tileThreads) for (const K of o.tileK) {
    const B = threads * K;
    if (32 * B > device.limits.maxComputeWorkgroupStorageSize || threads > device.limits.maxComputeInvocationsPerWorkgroup) {
      out.tileSkipped.push(`${threads} threads x K=${K}: ${32 * B} bytes of shared memory, the device allows ${device.limits.maxComputeWorkgroupStorageSize}`);
      continue;
    }
    const code = tileWgsl(threads, K);
    const pt = pipeline(device, layout, code, 'tile', `p4 tile ${threads}x${K}`), ps = pipeline(device, layout, code, 'split', `p4 split ${threads}x${K}`);
    const phases = uniform(device, K * DYN, 'p4 phases');
    for (let k = 0; k < K; k++) device.queue.writeBuffer(phases, k * DYN, new Uint32Array([k, 0, 0, 0]));
    let checkedRef = false;
    for (const G of o.tileGroups) {
      const sets = Math.max(1, Math.min(G, Math.floor(maxBytes / (B * P * 128))));
      const records = tileRecords(threads, K, P, sets);
      const poses = probePoses(G * B, 3);
      const rb = upload(device, records, 'p4 tile records'), pristine = upload(device, poses, 'p4 tile poses 0');
      const pb = storage(device, poses.byteLength, 'p4 tile poses'), pb2 = storage(device, poses.byteLength, 'p4 split poses');
      const ub = uniform(device, KERNEL_PARAMS_BYTES, 'p4 tile params');
      const bgT = bind(device, pt.getBindGroupLayout(0), [rb, pb, ub, [phases, 16]]), bgS = bind(device, ps.getBindGroupLayout(0), [rb, pb2, ub, [phases, 16]]);
      const reset = (dst: GPUBuffer) => (enc: GPUCommandEncoder) => enc.copyBufferToBuffer(pristine, 0, dst, 0, poses.byteLength);
      for (const M of o.tileIters) {
        device.queue.writeBuffer(ub, 0, kernelParams({ threads, points: P, stride: P, nposes: sets, ...BODY_PARAMS, iters: M }));
        const tile = await timer.stat((pass) => { pass.setPipeline(pt); pass.setBindGroup(0, bgT, [0]); pass.dispatchWorkgroups(G); }, o.reps, o.warmup, reset(pb));
        const split = await timer.stat((pass) => {
          pass.setPipeline(ps);
          for (let m = 0; m < M; m++) for (let k = 0; k < K; k++) { pass.setBindGroup(0, bgS, [k * DYN]); pass.dispatchWorkgroups(G); }
        }, o.reps, o.warmup, reset(pb2));
        // The last samples of each left one clean run in pb and pb2.
        const gotT = new Float32Array(await readBuffer(device, pb, poses.byteLength)), gotS = new Float32Array(await readBuffer(device, pb2, poses.byteLength));
        const scaleT = gotT.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        let diff = 0;
        gotT.forEach((v, k) => { diff = Math.max(diff, Number.isFinite(v) && Number.isFinite(gotS[k]!) ? Math.abs(v - gotS[k]!) / (scaleT || 1) : Infinity); });
        let tileErr: number | null = null;
        if (!checkedRef || o.tileGroups.length === 1) {
          // Tile 0 against the CPU, at the smallest G of each shape (it costs B * P * K * M point updates on the CPU).
          const ref = tileRef(records, poses, 0, threads, K, P, sets, M);
          const sc = ref.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
          tileErr = 0;
          for (let k = 0; k < ref.length; k++) tileErr = Math.max(tileErr, Number.isFinite(gotT[k]!) ? Math.abs(gotT[k]! - ref[k]!) / sc : Infinity);
        }
        out.tile.push({
          threads, K, G, M, points: P, recordSets: sets, tile, split, ratio: split.median / tile.median,
          usPerPhaseTile: (tile.median * 1000) / (K * M), usPerPhaseSplit: (split.median * 1000) / (K * M), tileErr, splitDiff: diff,
        });
      }
      checkedRef = true;
      for (const b of [rb, pristine, pb, pb2, ub]) b.destroy();
      log(`P4d ${threads}x${K} G=${G} done`);
    }
    phases.destroy();
  }
}

// --- The run ---------------------------------------------------------------

export async function runProbe(opts: Partial<ProbeOptions> = {}): Promise<ProbeResult> {
  const o: ProbeOptions = { ...DEFAULT_PROBE, ...opts };
  const t0 = performance.now();
  const { device, timestamps, p1: p1base } = await openDevice();
  const errors: ProbeResult['errors'] = [];
  let lost: string | null = null;
  void device.lost.then((i) => { lost = `device lost (${i.reason}): ${i.message}`; });
  device.addEventListener('uncapturederror', (ev) => errors.push({ section: 'uncaptured', message: (ev as GPUUncapturedErrorEvent).error.message }));
  const software = /swiftshader|llvmpipe|lavapipe|software/i.test(`${p1base.adapter.vendor} ${p1base.adapter.architecture} ${p1base.adapter.description}`) || p1base.adapter.isFallbackAdapter;
  const timer = new Timer(device, timestamps);
  const wallSeconds: Record<string, number> = {};
  const has = (s: ProbeSection) => o.sections.includes(s);
  async function section<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    if (lost) { errors.push({ section: name, message: `skipped: ${lost}` }); return undefined; }
    const s0 = performance.now();
    log(`${name} ...`);
    device.pushErrorScope('validation');
    try {
      return await run();
    } catch (e) {
      errors.push({ section: name, message: (e as Error).message });
      return undefined;
    } finally {
      const err = await device.popErrorScope();
      if (err) errors.push({ section: name, message: err.message });
      wallSeconds[name] = (performance.now() - s0) / 1000;
    }
  }
  const p1: P1Result = { ...p1base, subgroupSizeObserved: (await section('p1', () => observeSubgroupSize(device))) ?? null };
  const p2 = has('p2') ? await section('p2', () => runP2(device, timer, o)) : undefined;
  const p3 = has('p3') ? await section('p3', () => runP3(device, timer, o)) : undefined;
  const p4: Partial<P4Result> = {};
  if (has('p4a') || has('p4b')) await section('p4ab', () => runBarriers(device, timer, o, p4, { a: has('p4a'), b: has('p4b') }));
  if (has('p4d')) await section('p4d', () => runTile(device, timer, o, p4));
  // Last: the only section that could, if a bound were missing, keep the GPU busy.
  if (has('p4c')) await section('p4c', () => runGrid(device, timer, o, p4));
  timer.destroy();
  wallSeconds.total = (performance.now() - t0) / 1000;
  device.destroy();
  return { software, timestamps, valid: !software && timestamps, options: o, p1, ...(p2 ? { p2 } : {}), ...(p3 ? { p3 } : {}), p4, errors, wallSeconds };
}

// --- Markdown --------------------------------------------------------------

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(d));
const us = (s: Stat | null | undefined) => (s ? `${f(s.median * 1000)} (${f(s.p10 * 1000)}–${f(s.p90 * 1000)})` : '–');

export function probeMarkdown(r: ProbeResult, header: string): string {
  const L: string[] = [header, ''];
  const a = r.p1.adapter;
  L.push(`Adapter: ${a.vendor} ${a.architecture} ${a.device} ${a.description}`.replace(/\s+/g, ' ').trim());
  if (!r.valid) L.push('', `**Not a performance result**: ${r.software ? 'software adapter' : ''}${r.software && !r.timestamps ? ', ' : ''}${!r.timestamps ? 'no GPU timestamps (wall clock around submit)' : ''}. The numbers below only show that the probe runs and its kernels compute what they claim.`);
  if (r.errors.length) { L.push('', '**Errors**:', ''); for (const e of r.errors) L.push(`- ${e.section}: ${e.message}`); }
  L.push('', 'Times are µs, median (p10–p90), from GPU timestamps around one compute pass per sample.');

  L.push('', '## P1 Adapter', '');
  L.push(`Features (adapter): ${r.p1.adapterFeatures.join(', ') || 'none'}`, '', `Features (probe device): ${r.p1.deviceFeatures.join(', ') || 'none'}; limits requested: ${r.p1.requestedLimits}`, '');
  L.push(`Subgroup size: adapter info min ${r.p1.subgroupMinSize ?? '–'}, max ${r.p1.subgroupMaxSize ?? '–'}; observed in a 64-thread workgroup ${r.p1.subgroupSizeObserved ?? '– (no subgroups feature)'}`, '');
  L.push('| Limit | Adapter | Granted |', '|---|---|---|');
  for (const k of COMPUTE_LIMITS) { const v = r.p1.limits[k]; if (v) L.push(`| ${k} | ${v.adapter.toLocaleString('en-US')} | ${v.device.toLocaleString('en-US')} |`); }
  const rest = Object.keys(r.p1.limits).filter((k) => !COMPUTE_LIMITS.includes(k));
  if (rest.length) L.push('', `Other limits (adapter = granted unless noted): ${rest.map((k) => { const v = r.p1.limits[k]!; return `${k} ${v.adapter}${v.device !== v.adapter ? ` (granted ${v.device})` : ''}`; }).join('; ')}`);

  if (r.p2) {
    const p = r.p2;
    L.push('', `## P2 Real solver: ${p.scenario} ${JSON.stringify(p.params)}${p.gravityScale !== 1 ? ` gravity x${p.gravityScale}` : ''}${p.boxBroadphase ? ' box broadphase' : ''} N=${p.N} seed ${p.seed}, ${p.iterations} iterations (${p.iterations + 1} sweeps), hessian ${p.hessian}, R=${p.R} dispatches per timed pass`);
    for (const c of p.checkpoints) {
      L.push('', `### Step ${c.step}: ${c.n} bodies, ${c.coloursUsed} colours (${c.uncolored} uncoloured), ${c.pairSlots} pair slots of ${c.pairsRequired} broadphase pairs, ${c.contactPairs} in contact, ${c.totalPoints} contact points`, '');
      const e0 = c.emptyDispatch?.median;
      L.push('| Colour | Bodies | W_c (max points) | Max loads | Σ points | t_c µs | (t_c − empty) / W_c ns |', '|---|---|---|---|---|---|---|');
      for (const d of c.direct) L.push(`| ${d.colour} | ${d.bodies} | ${d.W} | ${d.loads} | ${d.points} | ${us(d.t)} | ${d.t && d.W && e0 !== undefined ? f(((d.t.median - e0) * 1e6) / d.W) : '–'} |`);
      L.push(`| tail (${c.colorTail}+, ${c.tailThreads} threads) | ${c.tail.bodies} in ${c.tail.colours} colours + ${c.tail.serialBodies} serial | ${c.tail.Wcrit} (critical path) | | ${c.tail.points} | ${us(c.tail.t)} | ${c.tail.t && c.tail.Wcrit ? f((c.tail.t.median * 1e6) / c.tail.Wcrit) : '–'} (t / W, no baseline) |`);
      L.push('', `ΣW (direct W_c + tail critical path) = **${c.sumW}**. Empty colour ${c.emptyColour ?? '–'}'s primal dispatch (the fixed cost): ${us(c.emptyDispatch)} µs. Dual update (pairs + ground): ${us(c.dual)} µs.`);
      if (c.check) L.push('', `Consistency: (I+1)·Σ_c t_c = ${f(c.check.primal * 1000)} µs; (I+1)·(Σ_c t_c + t_tail) + I·t_dual = ${f(c.check.predicted * 1000)} µs; measured solve pass of steps ${c.step - (c.solvePass?.samples ?? 0)}–${c.step} = ${us(c.solvePass)} µs${c.check.measured ? ` (measured / predicted = ${f(c.check.measured / c.check.predicted)})` : ''}.`);
    }
    L.push('', '### Fits over the direct colours of every checkpoint (t in µs; b, e, g in ns)', '');
    for (const x of p.fits) {
      if ('singular' in x) { L.push(`- ${x.model}: not identifiable (the regressors do not vary independently)`); continue; }
      L.push(`- ${x.model}: ${Object.entries(x.coef).map(([k, v]) => (k === 'a' ? `a = ${f(v)} µs` : `${k} = ${f(v * 1000)} ns`)).join(', ')}; R² ${f(x.r2)}, adjusted ${f(x.adjR2)}, RMS ${f(x.rmsUs)} µs (${x.points} colours)`);
    }
    L.push('');
    for (const v of p.verdict) L.push(`- ${v}`);
  }

  if (r.p3) {
    const p = r.p3;
    L.push('', '## P3 Synthetic per-point kernels', '');
    L.push('Variants: ' + P3_VARIANTS.map((v) => `(${v}) ${P3_VARIANT_INFO[v].label}`).join('; ') + '.', '');
    L.push(`CPU reference check (96 threads, 8 points; max |GPU − CPU| / max |CPU|): worst ${f(Math.max(...p.checks.map((c) => c.maxRelErr)), 7)}`);
    const worst = new Map<string, number>();
    for (const c of p.checks) worst.set(c.variant, Math.max(worst.get(c.variant) ?? 0, c.maxRelErr));
    L.push('', [...worst].map(([v, e]) => `(${v}) ${e.toExponential(1)}`).join(', '));
    L.push('', `Empty-dispatch baseline: ${Object.entries(p.empty).map(([T, s]) => `${T} threads ${us(s)}`).join('; ')}.`);
    L.push('', '### Marginal ns per point (slope of dispatch time over P)', '');
    const Ts = [...new Set(p.slopes.map((s) => s.T))].sort((a, b) => a - b);
    L.push(`| Variant | S | Order | ${Ts.map((T) => `T=${T}`).join(' | ')} |`, `|---|---|---|${Ts.map(() => '---').join('|')}|`);
    const keys = [...new Set(p.slopes.map((s) => `${s.variant}|${s.S}|${s.order}`))];
    for (const k of keys) {
      const [v, S, order] = k.split('|');
      L.push(`| ${v} | ${S} | ${order} | ${Ts.map((T) => f(p.slopes.find((s) => `${s.variant}|${s.S}|${s.order}` === k && s.T === T)?.nsPerPoint)).join(' | ')} |`);
    }
    L.push('', '### Every configuration', '', '| Variant | S | P | T | Order | Dispatch µs | ns/point (− empty) | GB/s |', '|---|---|---|---|---|---|---|---|');
    for (const x of p.rows) L.push(`| ${x.variant} | ${x.S} | ${x.P} | ${x.T} | ${x.order} | ${us(x.t)} | ${f(x.nsPerPoint)} | ${f(x.GBs)} |`);
    L.push('', 'GB/s counts records and global pose reads per point (shared variants: the tile preload instead), the own pose and the output, over the dispatch time.');
  }

  const q4 = r.p4;
  if (q4.barrier?.length || q4.chain?.length) {
    L.push('', '## P4(a, b) workgroupBarrier against a chain of dispatches', '');
    if (q4.barrier?.length) {
      L.push('| Threads | Rounds | With barriers µs | Without µs | ns per barrier | Correct |', '|---|---|---|---|---|---|');
      for (const b of q4.barrier) L.push(`| ${b.threads} | ${b.rounds} | ${us(b.withBarriers)} | ${us(b.without)} | ${f(b.nsPerBarrier)} | ${b.correct ? 'yes' : '**no**'} |`);
    }
    if (q4.chain?.length) {
      L.push('', '| Threads | Dispatches | Pass µs | ns per dispatch | ns per barrier round (a) | Correct |', '|---|---|---|---|---|---|');
      for (const c of q4.chain) L.push(`| ${c.threads} | ${c.dispatches} | ${us(c.t)} | ${f(c.nsPerDispatch)} | ${f(c.nsPerBarrierRound)} | ${c.correct ? 'yes' : '**no**'} |`);
      L.push('', 'A round is one neighbour exchange: two workgroupBarriers in (a), one dispatch in (b).');
    }
  }
  if (q4.grid?.length) {
    L.push('', `## P4(c) Grid barrier across workgroups (64 threads each, at most ${r.options.maxPolls.toLocaleString('en-US')} polls per wait)`, '');
    L.push('| Workgroups | Rounds | Result | Pass µs | No-barrier µs | ns per barrier | Polls per wait |', '|---|---|---|---|---|---|---|');
    for (const g of q4.grid) L.push(`| ${g.groups} | ${g.rounds} | ${g.skipped ? 'skipped (a smaller count failed)' : g.completed ? 'completed' : g.timedOut ? '**timed out**' : '**incomplete**'} | ${us(g.t)} | ${us(g.base)} | ${f(g.nsPerBarrier)} | ${f(g.pollsPerWait, 1)} |`);
    const ok = q4.grid.filter((g) => g.completed).map((g) => g.groups);
    L.push('', `Largest count that completed: ${ok.length ? Math.max(...ok) : 'none'}. A completed count means that many workgroups were co-resident; the first failure bounds it.`);
  }
  if (q4.tile?.length || q4.tileSkipped?.length) {
    L.push('', '## P4(d) Workgroup tile: K colour phases x M iterations in one dispatch, against K x M dispatches', '');
    L.push('| Threads | K | G | M | Points | One dispatch µs | K·M dispatches µs | Split / tile | µs per phase (tile) | µs per phase (split) | Tile vs CPU | Split vs tile |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const t of q4.tile ?? []) L.push(`| ${t.threads} | ${t.K} | ${t.G} | ${t.M} | ${t.points} | ${us(t.tile)} | ${us(t.split)} | ${f(t.ratio)} | ${f(t.usPerPhaseTile)} | ${f(t.usPerPhaseSplit)} | ${t.tileErr === null ? '' : t.tileErr.toExponential(1)} | ${t.splitDiff.toExponential(1)} |`);
    for (const s of q4.tileSkipped ?? []) L.push(`- skipped: ${s}`);
    L.push('', 'Each workgroup owns K·threads bodies (poses in shared memory in the tile kernel, in global memory in the split one); each body walks its points with the (d) math. Split / tile above 1 is what the chunked solver saves.');
  }
  L.push('', `Wall time: ${Object.entries(r.wallSeconds).map(([k, v]) => `${k} ${v.toFixed(1)} s`).join(', ')}.`);
  return L.join('\n');
}
