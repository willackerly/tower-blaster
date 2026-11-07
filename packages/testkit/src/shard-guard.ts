// `pnpm ci:guard` (CI's static job): fails when vitest.durations.json is
// stale (a test file with no time, or a time for a file that is gone) or when
// a shard of the plan ci.yml runs is estimated over the limit, and warns about
// files whose recorded time is over what one file may take (an error once O5
// has brought them all under it). Prints the plan either way.
import { globSync, readFileSync } from 'node:fs';
import { checkShards, type Durations, planShards, shardLoad, shardWall } from './shard.ts';

/** The limits O5 sets (docs/plan.md): shards stay under 10 min on a runner, so an estimate over 12 is an error. */
export const LIMITS = { shard: 12 * 60, file: 300 };

const root = new URL('../../../', import.meta.url).pathname;
const durations: Durations = JSON.parse(readFileSync(`${root}vitest.durations.json`, 'utf8'));
const files = globSync('packages/*/test/**/*.test.ts', { cwd: root }).sort();
const ci = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8');

const problems: string[] = [], warnings: string[] = [];
const count = Number(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci)?.[1]);
const matrix = /^\s*shard:\s*\[([^\]]*)\]/m.exec(ci)?.[1]?.split(',').map((x) => Number(x.trim()));
if (!Number.isInteger(count) || count < 1) problems.push('ci.yml: no `--shard=${{ matrix.shard }}/N` in the test step');
else if (!matrix || matrix.join() !== Array.from({ length: count }, (_, i) => i + 1).join()) problems.push(`ci.yml: the shard matrix is [${matrix?.join(', ')}], not 1..${count}`);
else {
  planShards(files, durations, count).forEach((s, i) => {
    console.log(`shard ${i + 1}/${count}: ${String(s.length).padStart(3)} files, ${String(Math.round(shardLoad(s, durations))).padStart(5)} s recorded, ~${(shardWall(s, durations) / 60).toFixed(1)} min estimated`);
  });
  for (const p of checkShards(files, durations, count, LIMITS)) (p.kind === 'file' ? warnings : problems).push(p.kind === 'stale' ? `stale: ${p.message}` : p.message);
}
for (const w of warnings) console.log(`::warning::${w}`);
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s). Record times in CI-runner seconds (each shard's "Shard file times" step logs them; \`pnpm durations --from-log\` merges them), split files over ${LIMITS.file} s, or add shards in ci.yml.`);
  process.exit(1);
}
console.log(`ok: ${files.length} test files, ${count} shards, none over ${LIMITS.shard / 60} min estimated${warnings.length ? `; ${warnings.length} file(s) over ${LIMITS.file} s (warnings above)` : `, no file over ${LIMITS.file} s`}`);
