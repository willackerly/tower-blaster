// GPU primitive benchmarks, run in the page. Each case reports GPU time from
// timestamp queries (median of reps, each its own submit) and throughput.
// "Effective GB/s" uses a nominal traffic model per primitive (below), so it
// can be compared with the copy roofline measured on the same device.
//
// Numbers from SwiftShader or CI runners are not performance results
// (CLAUDE.md); the result records whether the adapter is software.
import { BandwidthProbe } from './bandwidth.ts';
import { Compactor } from './compact.ts';
import { createDevice, uploadU32 } from './device.ts';
import { GpuProfiler, timeSubmit } from './profiler.ts';
import { RadixSorter } from './radix-sort.ts';
import { Scanner } from './scan.ts';

export interface GpuBenchOptions {
  reps: number;
  warmup: number;
  copyBytes: number;
  scanSizes: number[];
  compactSizes: number[];
  sortSizes: number[];
  dispatches: number;
}

export const DEFAULT_GPU_BENCH: GpuBenchOptions = {
  reps: 25,
  warmup: 5,
  copyBytes: 256 * 2 ** 20,
  scanSizes: [10_000, 100_000, 1_000_000, 16_000_000],
  compactSizes: [100_000, 1_000_000],
  sortSizes: [10_000, 100_000, 1_000_000, 4_000_000],
  dispatches: 200,
};

export interface GpuCase {
  name: string;
  /** Elements processed (bytes for copy, dispatches for overhead). */
  n: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
  /** Nominal bytes moved per run. */
  traffic: number;
  effectiveGBs: number;
  /** Million elements per second. */
  melemS: number;
  source: 'timestamp' | 'wall';
}

export interface GpuBenchResult {
  adapter: { vendor: string; architecture: string; description: string };
  software: boolean;
  timestamps: boolean;
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  cases: GpuCase[];
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};

const NOOP = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> x: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_id) l: vec3u) { if (l.x == 0u) { x[0] = x[0] + 1u; } }`;

export async function runGpuBench(opts: Partial<GpuBenchOptions> = {}): Promise<GpuBenchResult> {
  const o = { ...DEFAULT_GPU_BENCH, ...opts };
  const { device, adapter, timestamps } = await createDevice();
  const prof = new GpuProfiler(device, 4);
  const cases: GpuCase[] = [];

  /** Time `record` reps times; record gets the pass timestampWrites to use. */
  async function time(name: string, n: number, traffic: number, record: (enc: GPUCommandEncoder, ts: { timestampWrites?: GPUComputePassTimestampWrites }) => void) {
    const ms: number[] = [];
    for (let r = 0; r < o.warmup + o.reps; r++) {
      let t: number;
      if (timestamps) {
        prof.begin();
        const enc = device.createCommandEncoder();
        record(enc, prof.pass(name));
        prof.resolve(enc);
        device.queue.submit([enc.finish()]);
        t = (await prof.collect())[name] ?? NaN;
      } else {
        t = await timeSubmit(device, (enc) => record(enc, {}));
      }
      if (r >= o.warmup) ms.push(t);
    }
    const med = q(ms, 0.5);
    cases.push({ name, n, medianMs: med, p10Ms: q(ms, 0.1), p90Ms: q(ms, 0.9), traffic, effectiveGBs: traffic / (med * 1e6), melemS: n / (med * 1e3), source: timestamps ? 'timestamp' : 'wall' });
  }
  const inPass = (fn: (p: GPUComputePassEncoder) => void) => (enc: GPUCommandEncoder, ts: { timestampWrites?: GPUComputePassTimestampWrites }) => {
    const p = enc.beginComputePass(ts);
    fn(p);
    p.end();
  };

  // Roofline: a straight vec4 copy.
  const bw = new BandwidthProbe(device, o.copyBytes);
  await time(`copy-${Math.round(bw.bytes / 2 ** 20)}MiB`, bw.bytes, bw.traffic, inPass((p) => bw.encode(p)));
  bw.destroy();

  // Fixed cost per dispatch: tiny kernels back to back in one pass.
  {
    const buf = uploadU32(device, new Uint32Array(4));
    const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: NOOP }), entryPoint: 'main' } });
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
    await time(`dispatch-x${o.dispatches}`, o.dispatches, 0, inPass((p) => {
      p.setPipeline(pipe);
      p.setBindGroup(0, bind);
      for (let i = 0; i < o.dispatches; i++) p.dispatchWorkgroups(1);
    }));
    buf.destroy();
  }

  for (const n of o.scanSizes) {
    const buf = uploadU32(device, new Uint32Array(n).fill(1));
    const s = new Scanner(device, buf, n);
    // scanBlocks reads and writes n words, addSums reads and writes n words.
    await time(`scan-${n}`, n, 16 * n, inPass((p) => s.encode(p, n)));
    s.destroy();
    buf.destroy();
  }

  for (const n of o.compactSizes) {
    const flags = new Uint32Array(n);
    for (let i = 0; i < n; i++) flags[i] = (i * 2654435761) % 10 < 3 ? 1 : 0;
    const fb = uploadU32(device, flags), out = uploadU32(device, new Uint32Array(n));
    const c = new Compactor(device, fb, out, n);
    // normalize 8n, scan 16n, scatter reads 8n and writes 0.3 * 4n.
    await time(`compact-${n}-30pct`, n, 33.2 * n, inPass((p) => c.encode(p, n)));
    c.destroy();
    fb.destroy();
    out.destroy();
  }

  for (const n of o.sortSizes) {
    const keys = new Uint32Array(n);
    let x = 1;
    for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; keys[i] = x; }
    const kb = uploadU32(device, keys), vb = uploadU32(device, new Uint32Array(n));
    const s = new RadixSorter(device, kb, vb, n);
    // Per 4-bit pass: local reads keys+vals and writes the staged block
    // (16n), scatter reads it and writes keys+vals (16n). Keys get
    // re-randomized between reps by re-uploading, so every rep sorts the
    // same input rather than an already sorted one.
    for (const bits of [32, 20]) {
      const passes = Math.ceil(bits / 4);
      await time(`sort-${n}-${bits}bit`, n, 32 * n * passes, (enc, ts) => {
        device.queue.writeBuffer(kb, 0, keys);
        s.encode(enc, n, bits, ts.timestampWrites);
      });
    }
    s.destroy();
    kb.destroy();
    vb.destroy();
  }

  prof.destroy();
  const info = adapter.info;
  const software = /swiftshader|llvmpipe|lavapipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
  const result: GpuBenchResult = {
    adapter: { vendor: info.vendor, architecture: info.architecture, description: info.description },
    software,
    timestamps,
    limits: { maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxBufferSize: device.limits.maxBufferSize },
    cases,
  };
  device.destroy();
  return result;
}

export function gpuBenchMarkdown(r: GpuBenchResult, header: string): string {
  const copy = r.cases.find((c) => c.name.startsWith('copy-'));
  const roof = copy?.effectiveGBs ?? NaN;
  const f = (x: number) => (!Number.isFinite(x) ? '–' : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(3));
  const lines = [
    header, '',
    `Adapter: ${r.adapter.vendor} ${r.adapter.architecture} ${r.adapter.description}`.trim() + (r.software ? ' — **software adapter: not a performance result**' : ''),
    `Timing: ${r.timestamps ? 'GPU timestamp queries' : 'wall clock around submit (no timestamp-query; includes submit overhead)'}`,
    '',
    '| Case | n | Median ms | p10 | p90 | M elem/s | Effective GB/s | % of copy |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const c of r.cases) {
    const pct = c.traffic && Number.isFinite(roof) ? `${((100 * c.effectiveGBs) / roof).toFixed(0)}%` : '';
    lines.push(`| ${c.name} | ${c.n.toLocaleString('en-US')} | ${f(c.medianMs)} | ${f(c.p10Ms)} | ${f(c.p90Ms)} | ${c.traffic ? f(c.melemS) : ''} | ${c.traffic ? f(c.effectiveGBs) : ''} | ${pct} |`);
  }
  const d = r.cases.find((c) => c.name.startsWith('dispatch-'));
  if (d) lines.push('', `**Dispatch overhead**: ${f((1000 * d.medianMs) / d.n)} µs per back-to-back dispatch in one pass.`);
  lines.push('', 'Effective GB/s uses a nominal traffic model per primitive (see packages/gpu/src/bench.ts); "% of copy" compares it with the straight copy on the same device.');
  return lines.join('\n');
}
