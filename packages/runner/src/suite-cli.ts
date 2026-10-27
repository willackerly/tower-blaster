// pnpm bench:suite [--engine rapier] [--sizes 1000,2000,5000] [--cases kapla,city] [--timing-mode latency|throughput] [--channel chrome] [--headed] [--node-label NAME]
// Runs the standard suite in one browser, writes results/suite-<time>.jsonl
// and a Markdown summary next to it, and prints the summary.
import { mkdirSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { exitNow } from '@tb/testkit';
import { openRunner } from './orchestrate.ts';
import { selectCases, standardSuite } from './suite.ts';
import { runSuite } from './suite-run.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const engine = typeof flag('engine') === 'string' ? (flag('engine') as string) : 'rapier';
const sizes = typeof flag('sizes') === 'string' ? (flag('sizes') as string).split(',').map(Number) : undefined;
const channel = flag('channel');
const mode = flag('timing-mode') ?? 'latency';
if (mode !== 'latency' && mode !== 'throughput') throw new Error(`--timing-mode must be latency or throughput, got "${String(mode)}"`);
const cases = flag('cases');
const suite = selectCases(standardSuite(engine, sizes, mode), typeof cases === 'string' ? cases : undefined);

let git = 'unknown';
try { git = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('results', { recursive: true });
const jsonl = `results/suite-${stamp}.jsonl`;

const runner = await openRunner({ headed: flag('headed') === true, ...(typeof channel === 'string' ? { channel } : {}) });
const header = (first: Record<string, unknown>) => {
  const b = (first as { env?: { browser?: { userAgent?: string; gpu?: { vendor: string; architecture: string } | null } } }).env?.browser;
  return [
    `## Benchmark suite, ${engine}, commit ${git}`,
    '',
    `${new Date().toISOString()} · ${hostname()} · ${cpus()[0]?.model ?? 'unknown CPU'} × ${cpus().length}`,
    `Browser: ${b?.userAgent ?? 'unknown'}`,
    `GPU adapter: ${b?.gpu ? `${b.gpu.vendor} ${b.gpu.architecture}` : 'none'}`,
    mode === 'throughput'
      ? 'Timing: throughput (each block waits for the GPU once; the sustained cost per step, no per-step tail)'
      : 'Timing: latency (every step waits for its work to finish)',
  ].join('\n');
};
const { results, md, summary, stuck } = await runSuite(runner, suite, { jsonl, git, header });
console.log(md);
console.error(`\nwrote ${jsonl} and ${summary}`);
if (results.some((r) => !r.valid)) process.exitCode = 3;
// A browser or server that did not close keeps Node alive.
if (stuck.length) await exitNow();
