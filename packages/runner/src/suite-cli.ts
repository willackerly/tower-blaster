// pnpm bench:suite [--engine rapier] [--sizes 1000,2000,5000] [--channel chrome] [--headed] [--node-label NAME]
// Runs the standard suite in one browser, writes results/suite-<time>.jsonl
// and a Markdown summary next to it, and prints the summary.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { openRunner } from './orchestrate.ts';
import { caseResult, standardSuite, summaryMarkdown, type CaseResult } from './suite.ts';

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
const suite = standardSuite(engine, sizes);

let git = 'unknown';
try { git = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('results', { recursive: true });
const jsonl = `results/suite-${stamp}.jsonl`;

const runner = await openRunner({ headed: flag('headed') === true, ...(typeof channel === 'string' ? { channel } : {}) });
const results: CaseResult[] = [];
try {
  for (const [i, c] of suite.entries()) {
    process.stderr.write(`[${i + 1}/${suite.length}] ${c.name} … `);
    const record = await runner.run(c.config);
    appendFileSync(jsonl, JSON.stringify({ case: c.name, git, ...record }) + '\n');
    const r = caseResult(c, record);
    results.push(r);
    process.stderr.write(`${r.median.toFixed(2)} ms/step\n`);
  }
} finally {
  await runner.close();
}

const firstLine = readFileSync(jsonl, 'utf8').split('\n')[0];
const first = firstLine ? (JSON.parse(firstLine) as { env?: { browser?: { userAgent?: string; gpu?: { vendor: string; architecture: string } | null } } }) : {};
const b = first.env?.browser;
const header = [
  `## Benchmark suite, ${engine}, commit ${git}`,
  '',
  `${new Date().toISOString()} · ${hostname()} · ${cpus()[0]?.model ?? 'unknown CPU'} × ${cpus().length}`,
  `Browser: ${b?.userAgent ?? 'unknown'}`,
  `GPU adapter: ${b?.gpu ? `${b.gpu.vendor} ${b.gpu.architecture}` : 'none'}`,
].join('\n');
const md = summaryMarkdown(results, suite, header);
writeFileSync(jsonl.replace(/\.jsonl$/, '.md'), md + '\n');
console.log(md);
console.error(`\nwrote ${jsonl} and ${jsonl.replace(/\.jsonl$/, '.md')}`);
if (results.some((r) => !r.valid)) process.exitCode = 3;
