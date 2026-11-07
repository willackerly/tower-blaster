// pnpm keystone:retrofit <site,...> [--jobs N]
// Aftershock's retrofit search and gate (retrofit-search.ts) on the reference engine, for candidate sites (keystone
// RETROFIT_SITES). Writes results/retrofit/<site>-<time>.json and prints Markdown.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { compileLevel, RETROFIT_SITES, retrofitCandidate, validateLevel } from '@tb/keystone';
import { braceName, familyOf, searchRetrofit, type Verdict } from './retrofit-search.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const list = argv[0];
if (!list || list.startsWith('--')) throw new Error(`usage: pnpm keystone:retrofit <site,...> [--jobs N]; sites: ${Object.keys(RETROFIT_SITES).join(', ')}`);
const jobs = Number(flag('jobs') ?? availableParallelism());
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
mkdirSync('results/retrofit', { recursive: true });
const v = (x: Verdict | null) => (x ? `${x.met}/${x.n}` : 'refused');
for (const id of list.split(',').filter(Boolean)) {
  const def = retrofitCandidate(id), issues = validateLevel(compileLevel(def)).filter((i) => !i.warning);
  if (issues.length) throw new Error(`${id}: ${issues.map((i) => i.message).join('; ')}`);
  const r = await searchRetrofit(def, RETROFIT_SITES[id]!, { jobs, log: (l) => console.error(l) });
  const file = `results/retrofit/${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ commit, ...r }, null, 1));
  console.log([`### ${id} ${def.name} (${r.bodies} bodies, hash ${r.hash}, ${r.wallS.toFixed(0)} s, ${commit})`, '',
    `Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}**: ${r.gate.detail}`, '',
    '| bracing | family | cost | met |', '|---|---|---|---|',
    `| bare | - | 0 | ${v(r.bare)} |`,
    ...r.families.flatMap((f) => [`| ${f.family} start | ${familyOf(f.start)} | ${f.start.length} braces | ${v(f.startVerdict)} |`, `| ${f.family} cheapest: ${f.best.map(braceName).join('; ')} | ${familyOf(f.best)} | ${f.bestCost} | ${v(f.bestVerdict)} |`]),
    ...r.wrong.map((w) => `| wrong: ${w.name} | - | - | ${v(w.verdict)} |`), '', `wrote ${file}`, ''].join('\n'));
}
