// Driver.reset(pace): the pre-settle in batches that let frames in (keystone PresettlePace,
// docs/game/level-start.md). Paced or not, the same steps run, so the state after reset is the same.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { compileLevel, Driver, L1, L2, PRESETTLE_STEPS, presettlePaced, snapshotHash } from '@tb/keystone';

const now = () => performance.now();

async function settled(level: typeof L1, pace?: { batchMs: number; maxBatch?: number }) {
  const d = new Driver(new RapierEngine(), compileLevel(level));
  await d.reset({ now, ...(pace ? { pace } : {}) });
  const out = { step: d.snapshotStep, hash: snapshotHash(d.snapshot), resetMs: d.resetMs };
  d.engine.dispose();
  return out;
}

/** An engine that only counts: steps, and the steps done at each finish() (the batch boundaries). */
function counting(finish: boolean) {
  const marks: number[] = [];
  const e = { stepIndex: 0, step() { e.stepIndex++; }, ...(finish ? { async finish() { marks.push(e.stepIndex); } } : {}) };
  return { engine: e as unknown as PhysicsEngine, marks, steps: () => e.stepIndex };
}

describe('paced pre-settle', () => {
  for (const level of [L1, L2]) {
    it(`${level.id}: the same state as an unpaced reset, at any batch size`, async () => {
      const plain = await settled(level);
      expect(plain.step).toBe(PRESETTLE_STEPS);
      expect(plain.resetMs.steps).toBe(PRESETTLE_STEPS);
      for (const pace of [{ batchMs: 8 }, { batchMs: 0.001 }, { batchMs: 1e6, maxBatch: 7 }]) {
        const paced = await settled(level, pace);
        expect({ step: paced.step, hash: paced.hash }, JSON.stringify(pace)).toEqual({ step: plain.step, hash: plain.hash });
      }
    });
  }

  it('runs exactly the steps asked, two batches in flight, batches growing at most twofold up to maxBatch', async () => {
    const c = counting(true);
    await presettlePaced(c.engine, 300, { batchMs: 1e6, maxBatch: 16 }, now);
    expect(c.steps()).toBe(300);
    expect(c.marks.at(-1)).toBe(300);
    const sizes = c.marks.map((m, i) => m - (c.marks[i - 1] ?? 0));
    // The second batch goes in before the first is waited for, so it is sized from nothing yet (1).
    expect(sizes.slice(0, 7)).toEqual([1, 1, 2, 4, 8, 16, 16]);
    expect(Math.max(...sizes)).toBe(16);
  });

  it('keeps batches at one step when each overruns the batch time', async () => {
    const c = counting(true);
    await presettlePaced(c.engine, 20, { batchMs: 0 }, now);
    expect(c.marks).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('yields a task between batches on an engine without finish()', async () => {
    const c = counting(false);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    await presettlePaced(c.engine, 50, { batchMs: 1e6, maxBatch: 4 }, now);
    clearInterval(timer);
    expect(c.steps()).toBe(50);
    expect(ticks).toBeGreaterThan(0);
  });

  it('needs a clock to pace, and times nothing without one', async () => {
    const d = new Driver(new RapierEngine(), compileLevel(L1));
    await expect(d.reset({ pace: { batchMs: 8 } })).rejects.toThrow(/needs a clock/);
    await d.reset();
    expect(d.resetMs).toEqual({ init: 0, presettle: 0, steps: PRESETTLE_STEPS });
    d.engine.dispose();
  });
});
