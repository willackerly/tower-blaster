// pnpm keystone:probe [B1 B2 ...] [--json out.json]
// Runs the mechanics probe on Rapier and prints each behaviour's success grid.
import { writeFileSync } from 'node:fs';
import { RapierEngine } from '@tb/adapter-rapier';
import { CASES } from './cases.ts';
import { gridText, POWER_NUDGES, runProbe, YAW_NUDGES } from './probe.ts';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const out = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const ids = args.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1));
const cases = ids.length ? CASES.filter((c) => ids.includes(c.id)) : CASES;
const results = [];
for (const pc of cases) {
  const r = await runProbe(pc, () => new RapierEngine());
  results.push(r);
  console.log(`${r.id} ${(100 * r.successRate).toFixed(0).padStart(3)}%  nominal ${r.nominal ? 'ok' : 'FAIL'}  ${(r.ms / 1000).toFixed(1)} s  ${r.title}`);
  console.log(gridText(r.grid).split('\n').map((l) => `      ${l}`).join('\n'));
}
const robust = results.filter((r) => r.successRate >= 0.8).length;
console.log(`\n${robust}/${results.length} behaviours robust (>= 80% of the ${YAW_NUDGES.length}x${POWER_NUDGES.length} nudge grid)`);
if (out) writeFileSync(out, JSON.stringify({ engine: 'rapier', yaw: YAW_NUDGES, power: POWER_NUDGES, results }, null, 2));
