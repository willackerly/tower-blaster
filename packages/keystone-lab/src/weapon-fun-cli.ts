// pnpm keystone:fun [L1 ...] [--items marble,cannonball,w-scatter] [--engine ref|rapier] [--jobs N]
// The weapon fun check (weapon-fun.ts) on L1 to L5 (or the levels named): each item alone, one shot at every
// candidate the par bot aims, and the summary table docs/game/weapon-trials.md records.
import { availableParallelism } from 'node:os';
import { isLaunchItem, type LaunchItem, LEVELS } from '@tb/keystone';
import { engineLabel, labArgs } from './engines.ts';
import { makeRunner } from './runner.ts';
import { funTable, weaponFun } from './weapon-fun.ts';

const argv = process.argv.slice(2), at = argv.indexOf('--items');
const items = (at >= 0 ? argv.splice(at, 2)[1]!.split(',') : ['marble', 'cannonball', 'w-scatter']).map((x) => {
  if (!isLaunchItem(x)) throw new Error(`--items: ${x} is not a launch item`);
  return x as LaunchItem;
});
const { spec, jobs, ids } = labArgs(argv, availableParallelism());
const levels = LEVELS.filter((l) => (ids.length ? ids.includes(l.id) : /^L[1-5]$/.test(l.id)));
const runner = makeRunner(spec, jobs);
console.log(`engine ${engineLabel(spec)}, ${runner.jobs} job(s), ${levels.map((l) => l.id).join(' ')}, items ${items.join(' ')}`);
const t0 = performance.now();
try {
  console.log(funTable(await weaponFun(levels, items, runner)));
  console.log(`${((performance.now() - t0) / 1000).toFixed(0)} s`);
} finally {
  await runner.close();
}
