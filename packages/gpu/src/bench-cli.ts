// pnpm bench:gpu [--channel chrome] [--headed] [--quick] [--reps N]
// Measures the GPU primitives (copy roofline, dispatch overhead, scan,
// compaction, radix sort) and readback latency (fresh against pooled
// staging buffers) in a real browser and writes
// results/gpu-<time>.{json,md}. Use real Chrome on the target machine for
// numbers worth keeping; software adapters are flagged as invalid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { cpus, hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exitNow, loadBundle, openWebGPU } from '@tb/testkit';
import { DEFAULT_GPU_BENCH, gpuBenchMarkdown, type GpuBenchOptions, type GpuBenchResult } from './bench.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const quick: Partial<GpuBenchOptions> = { reps: 5, warmup: 2, copyBytes: 16 * 2 ** 20, scanSizes: [10_000, 100_000], compactSizes: [100_000], sortSizes: [10_000, 100_000], dispatches: 50 };
const opts: Partial<GpuBenchOptions> = { ...(flag('quick') ? quick : DEFAULT_GPU_BENCH), ...(value('reps') ? { reps: Number(value('reps')) } : {}) };

// Developer features lift Chrome's 100 µs timestamp quantization.
const extra = ['--enable-webgpu-developer-features'];
const channel = value('channel');
const gpu = await openWebGPU(extra, { ...(channel ? { channel } : {}), headless: !flag('headed') });
if (!gpu) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  await loadBundle(gpu.page, fileURLToPath(new URL('./bench-entry.ts', import.meta.url)), '__gpubench');
  const result = await gpu.page.evaluate((o) => (window as unknown as { __gpubench: { runGpuBench: (o: unknown) => Promise<GpuBenchResult> } }).__gpubench.runGpuBench(o), opts);
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const stamp = new Date().toISOString();
  const header = `## GPU primitives, commit ${commit}\n\n${stamp} · ${hostname()} · ${cpus()[0]?.model ?? '?'} × ${cpus().length} · ${platform()} · ${await gpu.page.evaluate(() => navigator.userAgent)}`;
  const md = gpuBenchMarkdown(result, header);
  mkdirSync('results', { recursive: true });
  const base = `results/gpu-${stamp.replace(/[:.]/g, '-')}`;
  writeFileSync(`${base}.json`, JSON.stringify({ commit, stamp, opts, ...result }, null, 2));
  writeFileSync(`${base}.md`, md + '\n');
  console.log(md);
  console.error(`\nwrote ${base}.json and ${base}.md`);
  if (result.software) console.error('warning: software adapter; these timings are not performance results');
} finally {
  stuck = await gpu.close();
}
// A browser that did not close keeps Node alive; the results are already written.
if (stuck.length) await exitNow();
