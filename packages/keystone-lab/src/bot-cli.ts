// pnpm keystone:bot L1 [--shots 2] [--every 2] [--audit 5]
// Searches solutions for each level on Rapier, audits the best few by
// leverage over the nudge grid, and prints the most robust as the par line.
import { RapierEngine } from '@tb/adapter-rapier';
import { LEVELS } from '@tb/keystone';
import { audit, solve } from './bot.ts';
import { gridText } from './probe.ts';

const args = process.argv.slice(2);
const opt = (name: string, d: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : d; };
const ids = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const engine = () => new RapierEngine();
for (const def of LEVELS.filter((l) => !ids.length || ids.includes(l.id))) {
  const t0 = performance.now();
  const { tried, solutions } = await solve(def, engine, { maxShots: opt('shots', def.par), every: opt('every', 2) });
  const clean = solutions.filter((s) => s.heritage === 0);
  console.log(`${def.id} ${def.name} (par ${def.par}): ${solutions.length} solutions (${clean.length} without heritage damage) from ${tried} attempts, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const audited = [];
  for (const s of clean.slice(0, opt('audit', 5))) {
    const a = await audit(def, s.shots, engine);
    const lev = a.successRate;
    audited.push({ s, a });
    console.log(`  ${(100 * lev).toFixed(0).padStart(3)}% robust  L=${s.leverage.toFixed(1)}  ${s.shots.length} shot(s), last: ${s.label}`);
  }
  audited.sort((x, y) => y.a.successRate - x.a.successRate || y.s.leverage - x.s.leverage);
  const best = audited[0];
  if (best) {
    console.log(`  par line: ${JSON.stringify(best.s.shots)}`);
    console.log(gridText(best.a.grid).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
