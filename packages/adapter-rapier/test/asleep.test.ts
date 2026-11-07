// Bodies that start asleep (engine-api asleep.ts, roadmap C22) on Rapier: the shared case of @tb/testkit's asleep.ts.
// Rapier runs them awake, as an engine that does not sleep them: a body Rapier creates sleeping has no contacts until
// it wakes, and fell 5 cm into the ground before they caught it (measured 2026-11-07, sleeping on creation; the
// adapter's add()). Awake, the row stands until the push and falls in order, as the scene without the flag.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { ASLEEP_CASE, asleepFailures, asleepReport, asleepScene } from '@tb/testkit';
import { RapierEngine } from '../src/index.ts';

async function run(scene: SceneDesc): Promise<Snapshot[]> {
  const e = new RapierEngine();
  await e.init(scene);
  const out = [e.snapshot()];
  for (let i = 0; i < ASLEEP_CASE.end; i++) { e.step(); out.push(e.snapshot()); }
  e.dispose();
  return out;
}

describe('RapierEngine: bodies that start asleep', () => {
  it.for([true, false])('runs them awake (scene sleep %s): the row stands, falls in order, and matches the scene without the flag', async (sleep) => {
    const a = await run(asleepScene(true, sleep)), b = await run(asleepScene(false, sleep));
    expect(asleepFailures(asleepReport(a), false)).toEqual([]);
    expect(a.at(-1)!.pos).toEqual(b.at(-1)!.pos);
  });
});
