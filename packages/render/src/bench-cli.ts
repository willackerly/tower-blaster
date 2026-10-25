// pnpm bench:render [--channel chrome] [--headed] [--quick] [--batches N]
// Frame cost of the renderer on frozen 10k and 100k worlds (bench.ts) in a
// real browser; writes results/render-<time>.{json,md}. Use real Chrome on
// the target machine for numbers worth keeping; software adapters are
// flagged as invalid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { cpus, hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exitNow, loadBundle, openWebGPU } from '@tb/testkit';
import { QUICK_RENDER_BENCH, renderBenchMarkdown, type RenderBenchOptions, type RenderBenchResult } from './bench.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const opts: Partial<RenderBenchOptions> = { ...(flag('quick') ? QUICK_RENDER_BENCH : {}), ...(value('batches') ? { batches: Number(value('batches')) } : {}) };

// Developer features lift Chrome's 100 µs timestamp quantization.
const channel = value('channel');
const gpu = await openWebGPU(['--enable-webgpu-developer-features'], { ...(channel ? { channel } : {}), headless: !flag('headed') });
if (!gpu) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  await loadBundle(gpu.page, fileURLToPath(new URL('./bench-entry.ts', import.meta.url)), '__renderbench');
  const result = await gpu.page.evaluate((o) => (window as unknown as { __renderbench: { runRenderBench: (o: unknown) => Promise<RenderBenchResult> } }).__renderbench.runRenderBench(o), opts);
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const stamp = new Date().toISOString();
  const header = `## Renderer, commit ${commit}\n\n${stamp} · ${hostname()} · ${cpus()[0]?.model ?? '?'} × ${cpus().length} · ${platform()} · ${await gpu.page.evaluate(() => navigator.userAgent)}`;
  const md = renderBenchMarkdown(result, header);
  mkdirSync('results', { recursive: true });
  const base = `results/render-${stamp.replace(/[:.]/g, '-')}`;
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
