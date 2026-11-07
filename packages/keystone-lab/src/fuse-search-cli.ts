// pnpm keystone:fuse FC-1[,FC-2...] [--jobs N] [--nudges N] [--keep N] [--spacing N] [--screen N]
// Fuse & Fold's design search (fuse-search.ts) on the reference engine: every sweep line on the screen
// builds, the best few and the naive line on the confirm builds, and the order-matters gate. Writes
// results/fuse/<id>-<time>.json and prints a Markdown table per level.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { foldCandidate } from '@tb/keystone';
import { searchLevel, type LineStats } from './fuse-search.ts';

const argv = process.argv.slice(2);
const value = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const ids = (argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? '').split(',').filter(Boolean);
if (!ids.length) throw new Error('usage: pnpm keystone:fuse FC-1[,FC-2...] [--jobs N] [--nudges N] [--keep N] [--spacing N] [--screen N]');
const jobs = value('jobs', availableParallelism()), nudges = value('nudges', 8), keep = value('keep', 4), spacing = value('spacing', 10), screen = value('screen', 1);
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
mkdirSync('results/fuse', { recursive: true });
const row = (s: LineStats) => `| ${s.name} | ${s.n} | ${s.fold.toFixed(3)} (${s.sd.toFixed(3)}) | ${s.collapse.toFixed(3)} | ${(100 * s.met).toFixed(0)}% | ${(100 * s.heritage).toFixed(0)}% |`;
for (const id of ids) {
  const r = await searchLevel(foldCandidate(id), { jobs, keep, maxSpacing: spacing, screenNudges: Array.from({ length: screen }, (_, k) => k + 1), confirmNudges: Array.from({ length: nudges }, (_, k) => k + 1), log: (l) => console.error(l) });
  const file = `results/fuse/${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ commit, ...r }, null, 1));
  const top = [...r.screen].sort((a, b) => b.met - a.met || b.fold - a.fold).slice(0, 8);
  console.log([`### ${id} (${r.bodies} bodies, ${r.charges} charges, hash ${r.hash}, ${r.wallS.toFixed(0)} s, ${commit})`, '', `Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}**: ${r.gate.detail}`, '',
    '| line | builds | fold mean (sd) | collapse | met | heritage hit |', '|---|---|---|---|---|---|', ...r.confirm.map(row), '', 'Screen, best 8 and the naive line:', '',
    '| line | builds | fold mean (sd) | collapse | met | heritage hit |', '|---|---|---|---|---|---|', row(r.screen[0]!), ...top.map(row), '', `wrote ${file}`, ''].join('\n'));
}
