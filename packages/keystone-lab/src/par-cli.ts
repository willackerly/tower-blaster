// pnpm keystone:par [L1 ...] [--engine ref|rapier] [--iterations N] [--jobs N]
// Audits each level's recorded par line over the nudge grid: does it clear,
// how robust is it, and where the gold line falls against the level's lGold.
import { availableParallelism } from 'node:os';
import { LEVELS, type Shot } from '@tb/keystone';
import { audit, goldLine } from './bot.ts';
import { engineLabel, labArgs } from './engines.ts';
import { gridText } from './probe.ts';
import { makeRunner } from './runner.ts';

const { spec, jobs, ids } = labArgs(process.argv.slice(2), availableParallelism());
const runner = makeRunner(spec, jobs);
console.log(`engine ${engineLabel(spec)}, ${runner.jobs} job(s)`);
try {
  for (const def of LEVELS.filter((l) => !ids.length || ids.includes(l.id))) {
    const a = await audit(def, (def.solutions?.par ?? []) as Shot[], runner);
    console.log(`${def.id} ${def.name}: nominal ${a.nominal ? 'clears' : 'FAILS'}, ${(100 * a.successRate).toFixed(0)}% robust, gold line ${goldLine(a)} (lGold ${def.lGold ?? 'default'}), ${(a.ms / 1000).toFixed(0)} s`);
    console.log(gridText(a.grid).split('\n').map((l) => `      ${l}`).join('\n'));
  }
} finally {
  await runner.close();
}
