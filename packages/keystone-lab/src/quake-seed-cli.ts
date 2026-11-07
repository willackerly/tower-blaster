// pnpm keystone:quake-seed <level,...> [--jobs N]
// Each Aftershock level's seeded dial (quake-seed.ts) on the reference engine: prints the search and the seed.
import { availableParallelism } from 'node:os';
import { levelById } from '@tb/keystone';
import { searchSeed } from './quake-seed.ts';

const argv = process.argv.slice(2), list = argv[0];
if (!list || list.startsWith('--')) throw new Error('usage: pnpm keystone:quake-seed <level,...> [--jobs N]');
const ji = argv.indexOf('--jobs'), jobs = ji >= 0 ? Number(argv[ji + 1]) : availableParallelism();
for (const id of list.split(',').filter(Boolean)) {
  const r = await searchSeed(levelById(id), { jobs, log: (l) => console.error(l) });
  console.log(JSON.stringify(r));
}
