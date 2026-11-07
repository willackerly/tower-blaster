// Bodies that start asleep (engine-api asleep.ts, roadmap C22) on the f64 reference, which does not sleep: the shared
// case of @tb/testkit's asleep.ts. The hint changes nothing here: the dominoes run awake from the start, stand until
// the push, and fall in order, bit for bit as the same scene without the flag.
import { describe, expect, it } from 'vitest';
import type { SceneDesc, Snapshot } from '@tb/engine-api';
import { ASLEEP_CASE, asleepFailures, asleepReport, asleepScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '../src/index.ts';

async function run(scene: SceneDesc): Promise<Snapshot[]> {
  // Keystone's settings (keystone driver.ts AVBD_ITERATIONS, AVBD_GAP_SLOP).
  const e = new AvbdReferenceEngine({ iterations: 40, gapSlop: 3e-5 });
  await e.init(scene);
  const out = [e.snapshot()];
  for (let i = 0; i < ASLEEP_CASE.end; i++) { e.step(); out.push(e.snapshot()); }
  return out;
}

describe('AVBD reference: bodies that start asleep', () => {
  it('runs them awake (it does not sleep): the row stands, then falls in order, as the scene without the flag', async () => {
    const a = await run(asleepScene(true)), b = await run(asleepScene(false));
    const r = asleepReport(a);
    expect(asleepFailures(r, false)).toEqual([]);
    expect(a.at(-1)!.pos).toEqual(b.at(-1)!.pos);
  }, 120_000);
});
