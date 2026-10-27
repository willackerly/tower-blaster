import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { type Durations, planShards, shardLoad } from '@tb/testkit/shard';

const root = import.meta.dirname;
const durations: Durations = JSON.parse(readFileSync(new URL('./vitest.durations.json', import.meta.url), 'utf8'));
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
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 60_000,
    sequence: { sequencer: DurationSequencer },
  },
});
