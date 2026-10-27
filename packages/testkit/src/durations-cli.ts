// Writes vitest.durations.json, the per-file times CI's shards are balanced
// on (planShards), from a vitest JSON report. `pnpm test:durations` runs the
// suite and this; commit the result when files were added or got slower.
import { readFileSync, writeFileSync } from 'node:fs';
import { durationsFromReport } from './shard.ts';

const [report = '.vitest-report.json'] = process.argv.slice(2);
const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const durations = durationsFromReport(JSON.parse(readFileSync(report, 'utf8')), root);
writeFileSync(`${root}/vitest.durations.json`, `${JSON.stringify(durations, null, 2)}\n`);
const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`vitest.durations.json: ${Object.keys(durations).length} files, ${Math.round(total)} s in all`);
