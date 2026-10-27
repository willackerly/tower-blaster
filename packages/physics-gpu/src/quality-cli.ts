// pnpm bench:quality [--channel chrome] [--headed] [--iterations 20] [--cases Q1,Q2,...] [--arms "spec;spec;..."]
// The brief's quality protocol Q1-Q5 (quality.ts) on the GPU engine in a
// browser, for a base and its variants: each case's metrics and gates, and
// whether each variant is equivalent to the base (the first arm): a
// variant's quality gate on the target machine, where its result need not be
// bit-identical (Metal's relaxed math). The default arm is avbd-gpu at
// --iterations alone (the gates only). Arms are engine specs as for pnpm
// bench (engines.ts), separated by ';', e.g. --arms
// "avbd-gpu:iterations=20;avbd-gpu:iterations=20,records=2". Writes results/quality-<time>.{json,md}; exits 1 if a
// variant is not equivalent, or a run fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exitNow, loadBundle, openWebGPU } from '@tb/testkit';
import { probeEngine } from './probe-engine.ts';
import { type ArmResult, armOk, caseScene, equivalent, evaluate, gates, QUALITY_CASES, qualityMarkdown } from './quality.ts';
import type * as Entry from './quality-entry.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const iterations = Number(value('iterations') ?? 20);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error(`--iterations: a positive integer, got ${value('iterations')}`);
const want = (value('cases') ?? 'Q1,Q2,Q3,Q4,Q5').split(',').map((s) => s.trim().toUpperCase());
const cases = QUALITY_CASES.filter((c) => want.includes(c.id));
if (cases.length !== want.length) throw new Error(`--cases: known cases are ${QUALITY_CASES.map((c) => c.id).join(', ')}, got ${want.join(', ')}`);
const base = `avbd-gpu:iterations=${iterations}`;
const specs = (value('arms') ?? base).split(';').map((s) => s.trim()).filter(Boolean);
const arms = specs.map((s) => probeEngine(s));
for (const a of arms) if ((a.params.iterations ?? 10) !== iterations) throw new Error(`--arms: ${a.spec} runs ${a.params.iterations ?? 10} iterations, but the gates are for --iterations ${iterations}`);

const channel = value('channel');
const gpu = await openWebGPU([], { ...(channel ? { channel } : {}), headless: !flag('headed') });
if (!gpu) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  await loadBundle(gpu.page, fileURLToPath(new URL('./quality-entry.ts', import.meta.url)), '__quality');
  const results: ArmResult[] = [];
  for (const a of arms) {
    const r: ArmResult = { spec: a.spec, backend: '', cases: [] };
    for (const c of cases) {
      console.error(`[quality] ${a.spec} ${c.id} (${c.steps} steps)`);
      const out = await gpu.page.evaluate(([s, st, ev, p, o]) => (window as unknown as { __quality: typeof Entry }).__quality.runGpuCase(s, st, ev, p, o), [caseScene(c), c.steps, c.every, a.params, a.opts] as const);
      r.backend = out.backend;
      const metrics = out.run ? evaluate(c, out.run) : null;
      const baseCase = results[0]?.cases.find((x) => x.id === c.id);
      r.cases.push({
        id: c.id, metrics, error: out.error, gates: metrics ? gates(metrics, iterations) : {},
        equivalent: results.length === 0 ? null : metrics && baseCase?.metrics ? equivalent(baseCase.metrics, metrics, iterations) : { ran: false },
      });
    }
    results.push(r);
  }
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const stamp = new Date().toISOString();
  const ua = await gpu.page.evaluate(() => navigator.userAgent);
  const md = qualityMarkdown(results, iterations, `## Quality protocol, commit ${commit}\n\n${stamp} · ${hostname()} · ${platform()} · ${ua} · ${results[0]?.backend ?? ''}`);
  mkdirSync('results', { recursive: true });
  const file = `results/quality-${stamp.replace(/[:.]/g, '-')}`;
  writeFileSync(`${file}.json`, JSON.stringify({ commit, stamp, argv, iterations, results }, null, 2));
  writeFileSync(`${file}.md`, md + '\n');
  console.log(md);
  console.error(`\nwrote ${file}.json and ${file}.md`);
  if (!results.slice(1).every(armOk) || results[0]!.cases.some((c) => c.error)) process.exitCode = 1;
} finally {
  stuck = await gpu.close();
}
if (stuck.length) await exitNow();
