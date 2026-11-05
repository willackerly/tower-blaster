// The sleep probes (pnpm bench:probe --only p5,p6; roadmap E1, GPU sleep design):
// what a step costs stage by stage on a scene at rest, which bounds what sleep can
// save, and what the island bookkeeping of island sleep would add per step.
//
// P5  stages of the real step (GpuAvbdEngine.probeStages): after p5Settle steps,
//     p5Steps steps each with a marker pass at the start and after every stage
//     (STEP_STAGES). A marker is one 1-thread dispatch with a beginning-of-pass
//     timestamp; it reads the buffers the stages end by writing (bodies, spheres,
//     pair count, pairs, manifolds, colour order, solver bodies), so it cannot run
//     before the stage it closes. A stage's time is the gap between its markers;
//     the step's is the first marker to the last, which includes the markers
//     (6 near-empty dispatches, about 6 µs on the M5).
// P6  island labelling on the contact graph of that step (bodies joined by a
//     pair slot with contact points; the ground joins nothing): union-find over
//     the edges with lock-free hooking (larger root under smaller, by compare-
//     exchange) and full compression, then the per-island minimum of a body
//     counter and its broadcast back, the five dispatches island sleep would add
//     to every step. The labels are checked against a CPU union-find.
//
// As in probe.ts, times from a software adapter or without timestamps are not
// performance results.
import { readBuffer } from '@tb/gpu';
import type { InputEvent } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { GpuAvbdEngine, type GpuEngineOptions, STEP_STAGES, type StepStage } from './engine.ts';
import type { ProbeOptions, Stat } from './probe.ts';

export interface P5Result {
  scenario: string;
  params: Record<string, number | boolean>;
  /** Bodies in the engine after the timed steps: the scene's, plus any it spawned (S5's ball, S15's topple ball). */
  N: number;
  iterations: number;
  variant: Record<string, number | boolean | string>;
  settle: number;
  /** ms per stage over the timed steps (median, p10, p90), and the step from the first marker to the last. */
  stages: Record<StepStage, Stat>;
  step: Stat;
  /** The engine's diagnostics after the last timed step. */
  pairs: number;
  colors: number;
  uncolored: number;
  /** Whether stage times are GPU timestamps; without them only the step's wall time (submit to done) is measured. */
  timestamps: boolean;
  /** ProbeOptions.p5Blast (0: none), and the bodies awake after the last timed step (all of them without sleep). */
  blast: number;
  awake: number;
}

/** The impulse of P5's blast (ProbeOptions.p5Blast), as the sleep tests' blast on a city (engine-sleep-skip.test.ts). */
export const P5_BLAST_IMPULSE = 2;

export interface P6Result {
  N: number;
  /** Contact edges (pair slots with points) and the islands they make. */
  edges: number;
  islands: number;
  largest: number;
  /** The five dispatches as one pass. */
  t: Stat;
  /** Every body's label equals its CPU component's smallest id. */
  correct: boolean;
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
const stat = (ms: number[]): Stat => ({ median: q(ms, 0.5), p10: q(ms, 0.1), p90: q(ms, 0.9), samples: ms.length });

const MARKER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(1) var<storage, read> b: array<u32>;
@group(0) @binding(2) var<storage, read> c: array<u32>;
@group(0) @binding(3) var<storage, read> d: array<u32>;
@group(0) @binding(4) var<storage, read> e: array<u32>;
@group(0) @binding(5) var<storage, read> f: array<u32>;
@group(0) @binding(6) var<storage, read> g: array<u32>;
@group(0) @binding(7) var<storage, read_write> sink: array<u32>;
@compute @workgroup_size(1) fn main() { sink[0] = a[0] ^ b[0] ^ c[0] ^ d[0] ^ e[0] ^ f[0] ^ g[0]; }
`;

/** P5: the step's stages on o.scenario after o.p5Settle steps (the engine variant as P2 builds it). */
export async function runP5(device: GPUDevice, timestamps: boolean, o: ProbeOptions, engineOpts: Omit<GpuEngineOptions, 'device'>): Promise<{ result: P5Result; engine: GpuAvbdEngine }> {
  const built = buildScenario(o.scenario, o.scenario === 'S4' ? { N: o.N, ...o.params } : o.params, o.seed);
  if (!(Number.isFinite(o.p5Blast) && o.p5Blast >= 0)) throw new Error(`P5: p5Blast must be a finite number >= 0, got ${o.p5Blast}`);
  const p0 = built.bodies[0]?.pos ?? [0, 0, 0];
  const blast: InputEvent[] = o.p5Blast > 0 ? [{ step: o.p5Settle, kind: 'blast', blast: { centre: [p0[0], p0[1], p0[2]], radius: o.p5Blast, impulse: P5_BLAST_IMPULSE } }] : [];
  const scene = { ...built, gravity: built.gravity.map((g) => g * o.gravityScale) as typeof built.gravity, inputs: [...(built.inputs ?? []), ...blast] };
  const e = new GpuAvbdEngine(o.engine?.params ?? {}, { ...engineOpts, device });
  await e.init(scene);
  for (let s = 0; s < o.p5Settle; s++) {
    e.step();
    if (s % 20 === 19) await e.finish();
  }
  await e.finish();
  const pp = e.probeParts();
  const sink = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE, label: 'p5 marker sink' });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: MARKER_WGSL, label: 'p5 marker' }), entryPoint: 'main' } });
  const bind = device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [pp.bodies, pp.spheres, pp.total, pp.pairs, pp.manifolds, pp.col.order, pp.solver.solver, sink].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const marks = 1 + STEP_STAGES.length;
  const qs = timestamps ? device.createQuerySet({ type: 'timestamp', count: marks }) : null;
  const resolve = timestamps ? device.createBuffer({ size: marks * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const per: Record<StepStage, number[]> = Object.fromEntries(STEP_STAGES.map((s) => [s, []])) as unknown as Record<StepStage, number[]>;
  const steps: number[] = [];
  for (let s = 0; s < o.p5Steps; s++) {
    let k = 0;
    const t0 = performance.now();
    e.probeStages((enc, at) => {
      if (at === 'solve' && resolve && qs) {
        // The last marker, then the resolve, in the step's own command buffer.
        const pass = enc.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: k++ } });
        pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end();
        enc.resolveQuerySet(qs, 0, marks, resolve, 0);
        return;
      }
      const pass = enc.beginComputePass(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: k++ } } : {});
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end();
    });
    await e.finish();
    const wall = performance.now() - t0;
    if (!resolve) { steps.push(wall); continue; }
    const t = new BigUint64Array(await readBuffer(device, resolve, marks * 8));
    const ms = (i: number) => (t[i]! > t[i - 1]! ? Number(t[i]! - t[i - 1]!) / 1e6 : 0);
    STEP_STAGES.forEach((stage, i) => per[stage].push(ms(i + 1)));
    steps.push(t[marks - 1]! > t[0]! ? Number(t[marks - 1]! - t[0]!) / 1e6 : 0);
  }
  qs?.destroy(); resolve?.destroy(); sink.destroy();
  const d = await e.diagnostics();
  const awake = (await e.snapshot()).awake.reduce((a, x) => a + (x ? 1 : 0), 0);
  const empty: Stat = { median: NaN, p10: NaN, p90: NaN, samples: 0 };
  return {
    engine: e,
    result: {
      scenario: o.scenario, params: scene.params as Record<string, number | boolean>, N: e.probeParts().n, iterations: pp.iterations, variant: e.info.variant, settle: o.p5Settle,
      stages: Object.fromEntries(STEP_STAGES.map((s) => [s, per[s].length ? stat(per[s]) : empty])) as Record<StepStage, Stat>,
      step: stat(steps), pairs: d.pairsWritten, colors: d.colors, uncolored: d.uncolored, timestamps: !!resolve, blast: o.p5Blast, awake,
    },
  };
}

const ISLANDS_WGSL = /* wgsl */ `
struct U { n: u32, m: u32, rest: u32, pad: u32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> edges: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> parent: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> quiet: array<u32>;
@group(0) @binding(4) var<storage, read_write> islandQuiet: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> asleep: array<u32>;
// Bounded walks: a root is reached in far fewer steps; the bound only keeps a bug from hanging the GPU.
const BOUND = 1048576u;
fn find(x0: u32) -> u32 {
  var x = x0;
  for (var i = 0u; i < BOUND; i++) {
    let p = atomicLoad(&parent[x]);
    if (p == x) { return x; }
    let gp = atomicLoad(&parent[p]);
    // Path halving: x skips to its grandparent (still in its set, so any interleaving is safe).
    if (gp != p) { _ = atomicCompareExchangeWeak(&parent[x], p, gp); }
    x = gp;
  }
  return x;
}
@compute @workgroup_size(64) fn init(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.n) { return; }
  atomicStore(&parent[g.x], g.x);
  atomicStore(&islandQuiet[g.x], 0xffffffffu);
}
// Each edge joins its endpoints' sets: the larger root goes under the smaller, by a compare-exchange that
// only succeeds while it is still a root; on failure both roots are found again.
@compute @workgroup_size(64) fn hook(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.m) { return; }
  let e = edges[g.x];
  var a = find(e.x);
  var b = find(e.y);
  for (var i = 0u; i < BOUND; i++) {
    if (a == b) { return; }
    let hi = max(a, b);
    let lo = min(a, b);
    if (atomicCompareExchangeWeak(&parent[hi], hi, lo).exchanged) { return; }
    a = find(hi);
    b = find(lo);
  }
}
@compute @workgroup_size(64) fn compress(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.n) { return; }
  atomicStore(&parent[g.x], find(g.x));
}
// Island sleep's per-step bookkeeping: the island's least quiet count, and each body asleep when it reaches rest.
@compute @workgroup_size(64) fn least(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.n) { return; }
  atomicMin(&islandQuiet[atomicLoad(&parent[g.x])], quiet[g.x]);
}
@compute @workgroup_size(64) fn broadcast(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= u.n) { return; }
  asleep[g.x] = select(0u, 1u, atomicLoad(&islandQuiet[atomicLoad(&parent[g.x])]) >= u.rest);
}
`;

/** CPU union-find: each body's component as its smallest id. */
export function componentsCpu(n: number, edges: Uint32Array): Uint32Array {
  const parent = Uint32Array.from({ length: n }, (_, i) => i);
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  for (let k = 0; k < edges.length; k += 2) {
    const a = find(edges[k]!), b = find(edges[k + 1]!);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  return Uint32Array.from({ length: n }, (_, i) => find(i));
}

/** The contact edges of the engine's last step: pair slots with contact points. */
export async function contactEdges(e: GpuAvbdEngine): Promise<Uint32Array> {
  const pp = e.probeParts();
  const d = await e.diagnostics();
  const slots = d.pairsWritten;
  const pairs = new Uint32Array(await readBuffer(pp.device, pp.pairs, Math.max(8, slots * 8)));
  const { pairs: pts } = await pp.solver.slotPoints(slots, pp.n);
  const out: number[] = [];
  for (let k = 0; k < slots; k++) if (pts[k]! > 0) out.push(pairs[2 * k]!, pairs[2 * k + 1]!);
  return Uint32Array.from(out);
}

/**
 * P6: the island pass on the contact graph `edges` of n bodies, `reps` times (each from init), timed by
 * `sample` (probe.ts Timer.stat); its labels checked against componentsCpu.
 */
export async function runP6(device: GPUDevice, n: number, edges: Uint32Array, sample: (record: (pass: GPUComputePassEncoder) => void) => Promise<Stat>): Promise<P6Result> {
  const m = edges.length / 2;
  // An id past n would read and write outside the island buffers (and miscount on the CPU side too).
  const bad = edges.findIndex((v) => v >= n);
  if (bad >= 0) throw new Error(`P6: edge ${bad >> 1} names body ${edges[bad]}, but there are ${n}`);
  const buf = (bytes: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST) => device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage });
  const uni = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uni, 0, new Uint32Array([n, m, 60, 0]));
  const edgeBuf = buf(edges.byteLength);
  if (m) device.queue.writeBuffer(edgeBuf, 0, edges);
  const parent = buf(n * 4), quiet = buf(n * 4), islandQuiet = buf(n * 4), asleep = buf(n * 4);
  // Every body quiet for 100 steps: the whole graph falls asleep (the pass does the same work either way).
  device.queue.writeBuffer(quiet, 0, new Uint32Array(n).fill(100));
  const module = device.createShaderModule({ code: ISLANDS_WGSL, label: 'p6 islands' });
  const layout = device.createBindGroupLayout({
    entries: (['uniform', 'read-only-storage', 'storage', 'read-only-storage', 'storage', 'storage'] as GPUBufferBindingType[]).map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })),
  });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = (entryPoint: string) => device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
  const pipes = { init: pipe('init'), hook: pipe('hook'), compress: pipe('compress'), least: pipe('least'), broadcast: pipe('broadcast') };
  const bind = device.createBindGroup({ layout, entries: [uni, edgeBuf, parent, quiet, islandQuiet, asleep].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const gn = Math.max(1, Math.ceil(n / 64)), gm = Math.max(1, Math.ceil(m / 64));
  const record = (pass: GPUComputePassEncoder) => {
    pass.setBindGroup(0, bind);
    pass.setPipeline(pipes.init); pass.dispatchWorkgroups(gn);
    pass.setPipeline(pipes.hook); pass.dispatchWorkgroups(gm);
    pass.setPipeline(pipes.compress); pass.dispatchWorkgroups(gn);
    pass.setPipeline(pipes.least); pass.dispatchWorkgroups(gn);
    pass.setPipeline(pipes.broadcast); pass.dispatchWorkgroups(gn);
  };
  const t = await sample(record);
  const labels = new Uint32Array(await readBuffer(device, parent, n * 4));
  const sleeping = new Uint32Array(await readBuffer(device, asleep, n * 4));
  const cpu = componentsCpu(n, edges);
  let correct = sleeping.every((s) => s === 1);
  for (let i = 0; i < n && correct; i++) if (labels[i] !== cpu[i]) correct = false;
  const size = new Map<number, number>();
  for (const r of cpu) size.set(r, (size.get(r) ?? 0) + 1);
  for (const b of [uni, edgeBuf, parent, quiet, islandQuiet, asleep]) b.destroy();
  return { N: n, edges: m, islands: size.size, largest: Math.max(0, ...size.values()), t, correct };
}
