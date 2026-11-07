// pnpm keystone:quake curves <tower,...> | levels <site,...> [--hz 3,5,10] [--sec 15,30,120] [--axes 0,45,90] [--peaks 15:75:5]
//                    [--nudges N] [--screen N] [--keep N] [--jobs N]
// Aftershock's design search (quake-search.ts) on the reference engine. `curves`: each tower's threshold curve at
// every (hz, sec, axis), on N nudged builds. `levels`: a candidate site (keystone QUAKE_SITES) screened over the
// grid and confirmed on N builds, with the choice-matters gate. Writes results/quake/<what>-<time>.json and prints
// Markdown.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { compileLevel, quakeCandidate, validateLevel } from '@tb/keystone';
import { quakeGrid, quakeStars, type QuakeStats, searchQuakeLevel, towerCurve } from './quake-search.ts';

const argv = process.argv.slice(2);
const [mode, list] = argv;
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const nums = (k: string, d: number[]) => { const v = flag(k); if (!v) return d; if (v.includes(':')) { const [a, b, s] = v.split(':').map(Number); const out: number[] = []; for (let x = a!; x <= b! + 1e-9; x += s!) out.push(x); return out; } return v.split(',').map(Number); };
const num = (k: string, d: number) => Number(flag(k) ?? d);
if ((mode !== 'curves' && mode !== 'levels') || !list) throw new Error('usage: pnpm keystone:quake curves <tower,...> | levels <site,...> [--hz] [--sec] [--axes] [--peaks a:b:step] [--nudges N] [--screen N] [--keep N] [--jobs N]');
const ids = list.split(',').filter(Boolean), jobs = num('jobs', availableParallelism());
const hz = nums('hz', [3, 5, 8, 10, 15]), sec = nums('sec', [10, 15, 30, 60, 120]), axes = nums('axes', [0]), peaks = nums('peaks', nums('peaks', [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75]));
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
mkdirSync('results/quake', { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

if (mode === 'curves') {
  const nudges = Array.from({ length: num('nudges', 4) }, (_, k) => k + 1);
  const combos = ids.flatMap((tower) => hz.flatMap((h) => sec.flatMap((s) => axes.map((a) => ({ tower, h, s, a })))));
  const out: Awaited<ReturnType<typeof towerCurve>>[] = [];
  // One combination per worker slot: towerCurve plays its builds in this thread, so run `jobs` at a time.
  for (let i = 0; i < combos.length; i += jobs) {
    const batch = combos.slice(i, i + jobs);
    const { Worker } = await import('node:worker_threads');
    void Worker;
    out.push(...(await Promise.all(batch.map((b) => towerCurve(b.tower, b.h, b.s, b.a, peaks, nudges)))));
    console.error(`  ${Math.min(i + jobs, combos.length)}/${combos.length}`);
  }
  const file = `results/quake/curves-${stamp()}.json`;
  writeFileSync(file, JSON.stringify({ commit, nudges: nudges.length, peaks, curves: out }, null, 1));
  console.log(['| tower | Hz | s | axis | down from | stands to | down share by peak |', '|---|---|---|---|---|---|---|',
    ...out.map((c) => `| ${c.tower} | ${c.hz / 10} | ${c.sec / 10} | ${c.axis} | ${c.downAt === null ? '-' : (c.downAt / 100).toFixed(2)} | ${c.holdsTo === null ? '-' : (c.holdsTo / 100).toFixed(2)} | ${c.points.map((p) => Math.round(10 * p.down)).join('')} |`),
    '', `wrote ${file} (${commit})`].join('\n'));
} else {
  const grid = quakeGrid({ peaks, hz, sec, axes });
  const row = (s: QuakeStats) => `| ${s.name} | ${s.n} | ${s.score.toFixed(3)} (${s.sd.toFixed(3)}) | ${(100 * s.met).toFixed(0)}% | ${Math.round(s.energy)} |`;
  for (const id of ids) {
    const level = quakeCandidate(id), issues = validateLevel(compileLevel(level)).filter((i) => !i.warning);
    if (issues.length) throw new Error(`${id}: ${issues.map((i) => i.message).join('; ')}`);
    const r = await searchQuakeLevel(level, grid, { jobs, keep: num('keep', 4), screenNudges: Array.from({ length: num('screen', 1) }, (_, k) => k + 1), confirmNudges: Array.from({ length: num('nudges', 8) }, (_, k) => k + 1), log: (l) => console.error(l) });
    const file = `results/quake/${id}-${stamp()}.json`;
    writeFileSync(file, JSON.stringify({ commit, ...r }, null, 1));
    const met = r.screen.filter((s) => s.met > 0);
    const top = [...r.screen.slice(1)].sort((a, b) => b.met - a.met || b.score - a.score || a.energy - b.energy).slice(0, 8);
    const st = quakeStars(r);
    console.log([`### ${id} ${level.name} (${r.bodies} bodies, hash ${r.hash}, ${r.wallS.toFixed(0)} s, ${commit})`, '', `Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}**: ${r.gate.detail}`, '',
      ...(st ? [`Stars (energy, lower is better): T2 ${st.t2} J, T3 ${st.t3} J, best ${Math.round(st.best)} J; budget ${st.budget} J.`, ''] : []),
      `Screen: ${met.length} of ${r.screen.length - 1} grid quakes meet the objective.`, '',
      '| quake | builds | towers (sd) | met | energy J |', '|---|---|---|---|---|', ...r.confirm.map(row), '', 'Screen, best 8 and the naive quake:', '',
      '| quake | builds | towers (sd) | met | energy J |', '|---|---|---|---|---|', row(r.screen[0]!), ...top.map(row), '', `wrote ${file}`, ''].join('\n'));
  }
}
