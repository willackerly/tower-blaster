// pnpm keystone:probe [B1 B2 ...] [--engine rapier|ref] [--iterations N] [--jobs N] [--json out.json]
// Runs the mechanics probe and prints each behaviour's success grid. Jobs
// default to one per core; results do not depend on them.
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { CASES } from './cases.ts';
import { engineLabel, labArgs } from './engines.ts';
import { gridText, POWER_NUDGES, runProbe, YAW_NUDGES } from './probe.ts';
import { makeRunner } from './runner.ts';

const { spec, jobs, flags, ids } = labArgs(process.argv.slice(2), availableParallelism());
const out = flags.get('json');
const cases = ids.length ? CASES.filter((c) => ids.includes(c.id)) : CASES;
const runner = makeRunner(spec, jobs);
console.log(`engine ${engineLabel(spec)}, ${runner.jobs} job(s)`);
const results = [];
try {
  for (const pc of cases) {
    const r = await runProbe(pc, runner);
    results.push(r);
    console.log(`${r.id} ${(100 * r.successRate).toFixed(0).padStart(3)}%  nominal ${r.nominal ? 'ok' : 'FAIL'}  ${(r.ms / 1000).toFixed(1)} s  ${r.title}`);
    console.log(gridText(r.grid).split('\n').map((l) => `      ${l}`).join('\n'));
  }
} finally {
  await runner.close();
}
const robust = results.filter((r) => r.successRate >= 0.8).length;
console.log(`\n${robust}/${results.length} behaviours robust (>= 80% of the ${YAW_NUDGES.length}x${POWER_NUDGES.length} nudge grid)`);
if (out) writeFileSync(out, JSON.stringify({ engine: spec.kind, iterations: spec.iterations, yaw: YAW_NUDGES, power: POWER_NUDGES, results }, null, 2));
