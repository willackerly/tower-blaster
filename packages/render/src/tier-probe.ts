// The measurements behind the game's quality tiers (roadmap P1,
// docs/game/quality-tiers.md): what a frame of this renderer costs on this
// device at a given size and set of toggles, and how long one dependent
// compute dispatch takes (the physics step's proxy: the GPU solver is
// latency bound, a chain of small dependent dispatches, docs/benchmarks).
//
// Both are wall times to queue.onSubmittedWorkDone, so they work without
// timestamp-query (the game asks for none). Each runs its own warmup first:
// a frame's first draw compiles the renderer's pipelines and bakes its
// textures, which the game's own renderer then finds in the device's cache.
import { emptySnapshot } from '@tb/engine-api';
import { buildWorld } from './bench-world.ts';
import type { LookParams } from './look.ts';
import { lookAt, multiply, perspective } from './math.ts';
import { Renderer, type FrameParams } from './renderer.ts';
import { SnapshotSource } from './source.ts';

export interface FrameProbeOptions {
  width: number;
  height: number;
  /** The renderer's toggles for the frames (the rest stay at their defaults). */
  toggles?: Partial<Renderer['toggles']>;
  look?: LookParams;
  /** Bodies in the probe's world: the bench's 'near' heap, the worst overdraw (default 1000). */
  bodies?: number;
  /** Timed frames at most (default 5). */
  frames?: number;
  /** Stop timing once this much wall time (ms) has gone on timed frames (default 400). */
  budgetMs?: number;
  /** Stop after a timed frame slower than this (ms): one is enough to rule the size out (default Infinity). */
  stopAboveMs?: number;
}

export interface FrameProbe {
  width: number;
  height: number;
  /** Wall ms of each timed frame, submit to done. */
  frameMs: number[];
  /** Wall ms of the warmup frame (pipelines, bakes). */
  warmupMs: number;
}

/** The median of xs (NaN when empty). */
export function medianOf(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/** Time frames of an offscreen renderer drawing the bench's frozen 'near' heap (bench-world.ts) at width x height. */
export async function probeFrames(device: GPUDevice, o: FrameProbeOptions): Promise<FrameProbe> {
  const rend = new Renderer(device, { size: [o.width, o.height] });
  const src = new SnapshotSource(device);
  try {
    if (o.look) rend.look = o.look;
    rend.toggles = { ...rend.toggles, ...o.toggles };
    const w = buildWorld('near', o.bodies ?? 1000);
    const snap = emptySnapshot(w.descs.length);
    w.descs.forEach((b, i) => { snap.pos.set(b.pos, 3 * i); snap.rot.set(b.rot, 4 * i); });
    src.reset(w.descs);
    src.update(snap, w.descs);
    rend.setSource(src);
    rend.setShadowBounds(w.center, w.radius);
    const f: FrameParams = { viewProj: multiply(perspective(0.9, o.width / o.height, 0.5, 2000), lookAt(w.eye, w.target)), eye: w.eye, focus: w.target, groundY: 0, time: 1, alpha: 1 };
    const frame = async () => {
      const t0 = performance.now();
      await rend.render(f);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    const warmupMs = await frame();
    const frameMs: number[] = [], budget = o.budgetMs ?? 400, stop = o.stopAboveMs ?? Infinity;
    let spent = 0;
    while (frameMs.length < (o.frames ?? 5) && spent < budget) {
      const ms = await frame();
      frameMs.push(ms);
      spent += ms;
      if (ms > stop) break;
    }
    return { width: o.width, height: o.height, frameMs, warmupMs };
  } finally {
    rend.destroy();
    for (const b of [src.bodies, src.prev, src.shapes, src.looks]) b.destroy();
  }
}

/** One step of the chain: every thread reads and writes the same word, so each dispatch waits for the last. */
const CHAIN_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = data[id.x] ^ data[(id.x * 7u + 1u) % arrayLength(&data)];
  for (var i = 0u; i < 16u; i++) { x = x * 1664525u + 1013904223u; }
  data[id.x] = x;
}`;

export interface DispatchProbe {
  /** Wall ms per dependent dispatch: the median round's time over its dispatches. */
  msPerDispatch: number;
  /** Wall ms of each timed round (each round is `dispatches` dispatches in one submit). */
  roundMs: number[];
  dispatches: number;
  threads: number;
  warmupMs: number;
}

/**
 * Time chains of dependent compute dispatches: `dispatches` of them in one
 * compute pass, each `threads` wide (default 64 x 4096, about a solver
 * colour's width at 1k-10k bodies), after one warmup round.
 */
export async function probeDispatch(device: GPUDevice, o: { dispatches?: number; threads?: number; rounds?: number; budgetMs?: number } = {}): Promise<DispatchProbe> {
  const dispatches = o.dispatches ?? 64, threads = o.threads ?? 4096, budget = o.budgetMs ?? 200;
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: CHAIN_WGSL }), entryPoint: 'main' } });
  const data = device.createBuffer({ size: threads * 4, usage: GPUBufferUsage.STORAGE });
  try {
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: data } }] });
    const round = async () => {
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      for (let i = 0; i < dispatches; i++) pass.dispatchWorkgroups(Math.ceil(threads / 64));
      pass.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    const warmupMs = await round();
    const roundMs: number[] = [];
    let spent = 0;
    while (roundMs.length < (o.rounds ?? 3) && spent < budget) { const ms = await round(); roundMs.push(ms); spent += ms; }
    return { msPerDispatch: medianOf(roundMs) / dispatches, roundMs, dispatches, threads, warmupMs };
  } finally {
    data.destroy();
  }
}
