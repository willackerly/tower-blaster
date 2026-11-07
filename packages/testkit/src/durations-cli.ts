// vitest.durations.json holds the per-file times CI's shards are balanced on
// (planShards), in seconds on a CI runner. This merges new times into it:
//
//   pnpm durations .vitest-report.json ...   vitest JSON reports (--reporter=json)
//   pnpm durations --from-log shard-*.log    CI shard logs: each "Shard file times"
//                                             step prints a `vitest-durations {...}` line
//   --scale 1.4                              multiply the new times (a run on a cloud
//                                             VM takes ~1/1.4 of a runner's time)
//
// Files the input does not mention keep their times; times for files that no
// longer exist are dropped. `pnpm test:durations` runs the suite and merges its
// report. --print writes a report's times as one `vitest-durations` line
// instead; --drift (with --print) also warns, as GitHub annotations, about
// files that took much longer than recorded.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Durations, drifted, durationsFromLog, durationsFromReport, mergeDurations } from './shard.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const value = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const print = flag('--print'), drift = flag('--drift'), fromLog = flag('--from-log');
const scale = Number(value('--scale') ?? 1);
if (!(scale > 0)) throw new Error('--scale must be a positive number');

const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const file = `${root}/vitest.durations.json`;
const measured: Durations = {};
for (const input of args.length ? args : ['.vitest-report.json']) {
  const text = readFileSync(input, 'utf8');
  const times = fromLog ? durationsFromLog(text) : durationsFromReport(JSON.parse(text), root);
  if (!Object.keys(times).length) throw new Error(`${input}: no times in it`);
  Object.assign(measured, times);
}
for (const k of Object.keys(measured)) measured[k] = Math.round(measured[k]! * scale * 10) / 10;

if (print) {
  console.log(`vitest-durations ${JSON.stringify(mergeDurations({}, measured, () => true))}`);
  if (drift) {
    for (const d of drifted(measured, JSON.parse(readFileSync(file, 'utf8')))) {
      console.log(`::warning file=${d.file}::took ${d.took} s here, ${d.recorded} s recorded in vitest.durations.json (merge this shard's times: pnpm durations --from-log)`);
    }
  }
} else {
  const old: Durations = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged = mergeDurations(old, measured, (f) => existsSync(`${root}/${f}`));
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  const total = Object.values(merged).reduce((a, b) => a + b, 0);
  console.log(`vitest.durations.json: ${Object.keys(measured).length} files measured, ${Object.keys(merged).length} in all, ${Math.round(total)} s`);
}
