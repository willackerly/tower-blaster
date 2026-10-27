// Writes vitest.durations.json, the per-file times CI's shards are balanced
// on (planShards), from vitest JSON reports (several: one per shard). `pnpm
// test:durations` runs the suite and this; commit the result when files were
// added or got slower. --print writes the times as one JSON line instead
// (each CI shard logs its own, so the runners' times can be merged in).
import { readFileSync, writeFileSync } from 'node:fs';
import { type Durations, durationsFromReport } from './shard.ts';

const args = process.argv.slice(2);
const print = args.includes('--print');
const reports = args.filter((a) => a !== '--print');
const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const durations: Durations = Object.assign({}, ...(reports.length ? reports : ['.vitest-report.json']).map((r) => durationsFromReport(JSON.parse(readFileSync(r, 'utf8')), root)));
const sorted: Durations = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
if (print) console.log(`vitest-durations ${JSON.stringify(sorted)}`);
else {
  writeFileSync(`${root}/vitest.durations.json`, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(`vitest.durations.json: ${Object.keys(sorted).length} files, ${Math.round(total)} s in all`);
}
