// pnpm keystone:bot L1 [--shots 2] [--every 2] [--audit 5] [--engine ref|rapier] [--iterations N] [--jobs N]
// Searches solutions for each level, audits the best few by leverage over the
// nudge grid, and prints the most robust as the par line with its gold line.
// Jobs default to one per core; results do not depend on them.
import { availableParallelism } from 'node:os';
import { LEVELS } from '@tb/keystone';
import { audit, goldLine, solve } from './bot.ts';
import { engineLabel, labArgs } from './engines.ts';
import { gridText } from './probe.ts';
import { makeRunner } from './runner.ts';

const { spec, jobs, flags, ids } = labArgs(process.argv.slice(2), availableParallelism());
const opt = (name: string, d: number) => (flags.has(name) ? Number(flags.get(name)) : d);
const runner = makeRunner(spec, jobs);
console.log(`engine ${engineLabel(spec)}, ${runner.jobs} job(s)`);
try {
  for (const def of LEVELS.filter((l) => !ids.length || ids.includes(l.id))) {
    const t0 = performance.now();
    const { tried, solutions } = await solve(def, runner, { maxShots: opt('shots', def.par), every: opt('every', 2) });
    const clean = solutions.filter((s) => s.heritage === 0);
    console.log(`${def.id} ${def.name} (par ${def.par}): ${solutions.length} solutions (${clean.length} without heritage damage) from ${tried} attempts, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    const audited = [];
    for (const s of clean.slice(0, opt('audit', 5))) {
      const a = await audit(def, s.shots, runner);
      audited.push({ s, a });
      console.log(`  ${(100 * a.successRate).toFixed(0).padStart(3)}% robust  L=${s.leverage.toFixed(1)}  ${s.shots.length} shot(s), last: ${s.label}`);
    }
    audited.sort((x, y) => y.a.successRate - x.a.successRate || y.s.leverage - x.s.leverage);
    const best = audited[0];
    if (best) {
      console.log(`  par line: ${JSON.stringify(best.s.shots)}`);
      console.log(`  gold line: ${goldLine(best.a)} (lower quartile of ${best.a.values.length} clean grid leverages)`);
      console.log(gridText(best.a.grid).split('\n').map((l) => `      ${l}`).join('\n'));
    }
  }
} finally {
  await runner.close();
}
