// pnpm probe:modes X1[,X2...] [--size ci|full] [--channel chrome] [--headed] [--only regex]
// Runs mode probes (docs/game/modes-roadmap.md section 7) on the GPU engine in
// a browser: Playwright's Chromium (SwiftShader on Linux, valid physics but
// no performance results), or --channel chrome for the installed Chrome and
// the real GPU (Metal on the M5 Max). --only keeps the cases whose label
// matches the regular expression (e.g. "line.*nudge [0-3]$"). Writes results/mode-probes/<id>-<size>-<time>.{json,md}
// per probe and prints the Markdown; exits 1 when a decided probe fails or a
// run errors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { exitNow } from '@tb/testkit';
import { SIZES, type Size } from './probe.ts';
import { probeById } from './probes.ts';
import { probeMarkdown } from './report.ts';
import { openProbePage, runProbe } from './session.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const ids = (argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? '').split(',').filter(Boolean);
if (!ids.length) throw new Error('usage: pnpm probe:modes X1[,X2...] [--size ci|full] [--channel chrome] [--headed] [--only regex]');
const size = (value('size') ?? 'full') as Size;
if (!SIZES.includes(size)) throw new Error(`--size: ${SIZES.join(' or ')}, got ${size}`);
const probes = ids.map(probeById), only = value('only'), channel = value('channel');

let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const page = await openProbePage({ ...(channel ? { channel } : {}), headless: !flag('headed') });
if (!page) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  console.error(`adapter: ${page.adapter}${page.software ? ' (software)' : ''}`);
  mkdirSync('results/mode-probes', { recursive: true });
  for (const p of probes) {
    const t0 = performance.now(), stamp = new Date().toISOString();
    const run = await runProbe(page, p, size, { log: (l) => console.error(l), ...(only ? { only: (label: string) => new RegExp(only).test(label) } : {}) });
    const info = { commit, stamp, adapter: page.adapter, software: page.software, host: hostname(), size, wallS: (performance.now() - t0) / 1000, runs: run.runs.length };
    const md = probeMarkdown(p, run.verdict, info);
    const file = `results/mode-probes/${p.id}-${size}-${stamp.replace(/[:.]/g, '-')}`;
    writeFileSync(`${file}.json`, JSON.stringify({ ...info, probe: p.id, only: only ?? null, verdict: run.verdict, runs: run.runs }, null, 1));
    writeFileSync(`${file}.md`, md + '\n');
    console.log(md + '\n');
    console.error(`wrote ${file}.json and ${file}.md`);
    if (run.verdict.pass === false) process.exitCode = 1;
  }
} finally {
  stuck = await page.close();
}
if (stuck.length) await exitNow();
