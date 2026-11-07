// `pnpm ci:guard` (CI's static job): fails when vitest.durations.json is
// stale (a test file with no time, or a time for a file that is gone), when a
// file CI runs has a recorded time over what one file may take, or when a
// shard of the plan ci.yml runs is estimated over the limit. Prints the plan
// either way.
import { globSync, readFileSync } from 'node:fs';
import { checkShards, type Durations, planShards, shardLoad, shardWall } from './shard.ts';

/**
 * The limits O5 sets (docs/plan.md): shards stay under 10 min on a runner. On 48 shards of three main runs
 * (2bbff1c, c749b6c, 9252c58) a shard took 0.68-1.31x its estimate from per-file medians (runner speed and
 * which files share its workers), so an estimate over 7.5 min (x1.31 = 9.8) is an error: add shards in ci.yml.
 */
export const LIMITS = { shard: 7.5 * 60, file: 300 };

const root = new URL('../../../', import.meta.url).pathname;
const durations: Durations = JSON.parse(readFileSync(`${root}vitest.durations.json`, 'utf8'));
const all = globSync('packages/*/test/**/*.test.ts', { cwd: root }).sort();
// PR and main CI leave out the nightly-only files (vitest.config.ts); the durations file still names them.
const nightlyOnly = Object.keys(JSON.parse(readFileSync(`${root}vitest.nightly.json`, 'utf8')).only as Record<string, string>);
const files = all.filter((f) => !nightlyOnly.includes(f));
const ci = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8');

const problems: string[] = [];
for (const f of nightlyOnly) if (!all.includes(f)) problems.push(`vitest.nightly.json: ${f} is not a test file`);
const count = Number(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci)?.[1]);
const matrix = /^\s*shard:\s*\[([^\]]*)\]/m.exec(ci)?.[1]?.split(',').map((x) => Number(x.trim()));
if (!Number.isInteger(count) || count < 1) problems.push('ci.yml: no `--shard=${{ matrix.shard }}/N` in the test step');
else if (!matrix || matrix.join() !== Array.from({ length: count }, (_, i) => i + 1).join()) problems.push(`ci.yml: the shard matrix is [${matrix?.join(', ')}], not 1..${count}`);
else {
  planShards(files, durations, count).forEach((s, i) => {
    console.log(`shard ${i + 1}/${count}: ${String(s.length).padStart(3)} files, ${String(Math.round(shardLoad(s, durations))).padStart(5)} s recorded, ~${(shardWall(s, durations) / 60).toFixed(1)} min estimated`);
  });
  for (const p of checkShards(files, durations, count, LIMITS, all)) problems.push(p.kind === 'stale' ? `stale: ${p.message}` : p.message);
}
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s). Record times in CI-runner seconds (each shard's "Shard file times" step logs them; \`pnpm durations --from-log\` merges them), split files over ${LIMITS.file} s, or add shards in ci.yml.`);
  process.exit(1);
}
console.log(`ok: ${files.length} test files (${nightlyOnly.length} more nightly only), ${count} shards, none over ${LIMITS.shard / 60} min estimated, no file over ${LIMITS.file} s`);
