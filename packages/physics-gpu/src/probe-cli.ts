// pnpm bench:probe [--channel chrome] [--headed] [--quick] [--only p1,p2,...] [--reps N] [--polls N] [--hessian registers|array]
// The solver probe (probe.ts): adapter limits (P1), the real solver's
// per-colour structure and times on the S4 city (P2), synthetic per-point
// kernels (P3) and synchronization costs (P4: a = workgroupBarrier,
// b = dispatch chain, c = grid barrier, d = workgroup tile; p4 = all four).
// --hessian sets the primal's form for P2 (default array, the engine's
// default; registers is plan step 2b's form, to time against it).
// Writes results/probe-<time>.{json,md}. Use real Chrome on the target
// machine for numbers worth keeping; software adapters are flagged as invalid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { cpus, hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exitNow, loadBundle, openWebGPU } from '@tb/testkit';
import { PROBE_SECTIONS, type ProbeOptions, type ProbeResult, type ProbeSection, probeMarkdown, QUICK_PROBE } from './probe.ts';
import { HESSIAN_FORMS, type HessianForm } from './solver.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const opts: Partial<ProbeOptions> = { ...(flag('quick') ? QUICK_PROBE : {}) };
const only = value('only');
if (only) {
  const want = only.split(',').map((s) => s.trim().toLowerCase()).flatMap((s) => (s === 'p4' ? ['p4a', 'p4b', 'p4c', 'p4d'] : [s]));
  const bad = want.filter((s) => !(PROBE_SECTIONS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`--only: unknown section(s) ${bad.join(', ')}; known: ${PROBE_SECTIONS.join(', ')}, p4`);
  opts.sections = want as ProbeSection[];
}
if (value('reps')) opts.reps = Number(value('reps'));
if (value('polls')) opts.maxPolls = Number(value('polls'));
const hessian = value('hessian');
if (hessian !== undefined) {
  if (!(HESSIAN_FORMS as readonly string[]).includes(hessian)) throw new Error(`--hessian: must be one of ${HESSIAN_FORMS.join(', ')}, got ${hessian}`);
  opts.hessian = hessian as HessianForm;
}

// Developer features lift Chrome's 100 µs timestamp quantization.
const extra = ['--enable-webgpu-developer-features'];
const channel = value('channel');
const gpu = await openWebGPU(extra, { ...(channel ? { channel } : {}), headless: !flag('headed') });
if (!gpu) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  gpu.page.on('console', (m) => { if (m.text().startsWith('[probe]')) console.error(m.text()); });
  await loadBundle(gpu.page, fileURLToPath(new URL('./probe-entry.ts', import.meta.url)), '__probe');
  const result = await gpu.page.evaluate((o) => (window as unknown as { __probe: { runProbe: (o: unknown) => Promise<ProbeResult> } }).__probe.runProbe(o), opts);
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const stamp = new Date().toISOString();
  const header = `## Solver probe, commit ${commit}${flag('quick') ? ' (quick)' : ''}\n\n${stamp} · ${hostname()} · ${cpus()[0]?.model ?? '?'} × ${cpus().length} · ${platform()} · ${await gpu.page.evaluate(() => navigator.userAgent)}`;
  const md = probeMarkdown(result, header);
  mkdirSync('results', { recursive: true });
  const base = `results/probe-${stamp.replace(/[:.]/g, '-')}`;
  writeFileSync(`${base}.json`, JSON.stringify({ commit, stamp, argv, ...result }, null, 2));
  writeFileSync(`${base}.md`, md + '\n');
  console.log(md);
  console.error(`\nwrote ${base}.json and ${base}.md`);
  if (!result.valid) console.error('warning: software adapter or no timestamps; these timings are not performance results');
  if (result.errors.length) process.exitCode = 1;
} finally {
  stuck = await gpu.close();
}
// A browser that did not close keeps Node alive; the results are already written.
if (stuck.length) await exitNow();
