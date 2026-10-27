// Every level's recorded par line clears at par with no heritage broken, on
// the engine par lines are pinned on: the f64 AVBD reference at Keystone's
// settings. A physics change that breaks a level's solution fails here; rerun
// pnpm keystone:bot for the level and re-pin it.
import { afterAll, describe, expect, it } from 'vitest';
import { availableParallelism } from 'node:os';
import { LEVELS, type Shot } from '@tb/keystone';
import { engineLabel, makeRunner } from '@tb/keystone-lab';

describe(`par lines on the reference (${engineLabel({ kind: 'ref' })})`, () => {
  // L1 alone is about a minute of f64 solving: play the levels side by side.
  const runner = makeRunner({ kind: 'ref' }, Math.min(LEVELS.length, Math.max(2, availableParallelism())));
  const played = new Map(LEVELS.map((def) => {
    const p = runner.play(def, (def.solutions?.par ?? []) as Shot[]);
    p.catch(() => {}); // rejections surface in the level's own test
    return [def.id, p];
  }));
  afterAll(() => runner.close());

  it.each(LEVELS.map((l) => [l.id, l] as const))('%s: the par line clears at par with no heritage broken', async (_id, def) => {
    expect(def.solutions?.par?.length).toBe(def.par);
    const r = await played.get(def.id)!;
    expect(r.session.phase).toBe('cleared');
    expect(r.session.outcomes).toHaveLength(def.par);
    expect(r.session.heritageBroken.every((x) => !x)).toBe(true);
    expect(r.session.score!.stars).toBeGreaterThanOrEqual(2);
  }, 600_000);
});
