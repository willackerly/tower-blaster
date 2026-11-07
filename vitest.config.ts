import { existsSync, globSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { type Durations, planShards, shardLoad, SLOW_FLAG, slowCaseFiles } from '@tb/testkit/shard';

const root = import.meta.dirname;
const json = (name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const TESTS = 'packages/*/test/**/*.test.ts';

// Tiers (O5): PR and main CI run every file but the nightly-only ones, each
// file's slow cases off. PHYSICS_GPU_SLOW=1 turns both on. TB_TIER=slow (the
// nightly) runs only what that adds: the nightly-only files and the files
// with slow cases of their own, timed on vitest.durations.nightly.json.
const slow = process.env[SLOW_FLAG] === '1', nightlyTier = process.env.TB_TIER === 'slow';
if (nightlyTier && !slow) throw new Error(`TB_TIER=slow runs the slow cases: set ${SLOW_FLAG}=1 too`);
const nightlyOnly = Object.keys(json('vitest.nightly.json').only as Record<string, string>);
const read = (f: string) => { try { return readFileSync(`${root}/${f}`, 'utf8'); } catch { return undefined; } };
const nightlyFiles = () => [...new Set([...nightlyOnly, ...slowCaseFiles(globSync(TESTS, { cwd: root }), read)])].sort();
const durations: Durations = { ...json('vitest.durations.json'), ...(nightlyTier && existsSync(`${root}/vitest.durations.nightly.json`) ? json('vitest.durations.nightly.json') : {}) };
const rel = (s: TestSpecification) => relative(root, s.moduleId);

// --shard=i/n takes the i-th of n shards of about equal recorded time
// (planShards), and files run longest first, so the long GPU files start
// while the workers are free.
class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const mine = planShards(files.map(rel), durations, count)[index - 1]!;
    console.log(`shard ${index}/${count}: ${mine.length} files, ~${Math.round(shardLoad(mine, durations))} s recorded`);
    const set = new Set(mine);
    return files.filter((f) => set.has(rel(f)));
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => (durations[rel(b)] ?? 0) - (durations[rel(a)] ?? 0));
  }
}

export default defineConfig({
  test: {
    include: nightlyTier ? nightlyFiles() : [TESTS],
    exclude: slow ? configDefaults.exclude : [...configDefaults.exclude, ...nightlyOnly],
    testTimeout: 60_000,
    sequence: { sequencer: DurationSequencer },
  },
});
