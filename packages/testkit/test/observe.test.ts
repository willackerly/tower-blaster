import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type ObservedEngine, type Observer, type PhysicsEngine, withSnapshotObserver } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { observerConformance } from '../src/index.ts';

/** e, with every observer it hands out replaced by edit(observer). */
function reobserved(e: ObservedEngine, edit: (o: Observer) => Observer): PhysicsEngine {
  return {
    get info() { return e.info; },
    get stepIndex() { return e.stepIndex; },
    init: (scene) => e.init(scene),
    step: () => e.step(),
    snapshot: () => e.snapshot(),
    dispose: () => e.dispose(),
    observe: async (opts) => edit(await e.observe(opts)),
  };
}

const passthrough = (o: Observer, result: Observer['result'], caps = o.caps): Observer => ({
  caps,
  query: (s) => o.query(s),
  watch: (ids) => o.watch(ids),
  setTags: (first, words) => o.setTags(first, words),
  captureRef: (slot) => o.captureRef(slot),
  result,
});

describe('observerConformance', () => {
  // 150 steps with SPEC_A or SPEC_B, none from 151 to 160, SPEC_A again from 161.
  const observed = 190;

  it('passes on physics-ref, wrapped', async () => {
    expect(await observerConformance(() => withSnapshotObserver(new AvbdReferenceEngine()))).toEqual({ lag: 0, steps: 200, observations: observed });
  });

  it('passes on Rapier, wrapped', async () => {
    expect(await observerConformance(() => withSnapshotObserver(new RapierEngine()))).toEqual({ lag: 0, steps: 200, observations: observed });
  });

  it('reads at stepIndex − lag: an exact observer reporting lag 2 passes, its last two steps checked at the end', async () => {
    const lagged = () => reobserved(withSnapshotObserver(new RapierEngine()), (o) => passthrough(o, (k) => o.result(k), { ...o.caps, lag: 2 }));
    expect(await observerConformance(lagged)).toEqual({ lag: 2, steps: 200, observations: observed });
  });

  it('fails an observer one step behind', async () => {
    // Bounds still right, so the values are what must catch it.
    const behind = () => {
      const e = withSnapshotObserver(new RapierEngine());
      return reobserved(e, (o) => passthrough(o, async (k) => (k <= 1 || k > e.stepIndex ? o.result(k) : { ...(await o.result(k - 1)), step: k })));
    };
    await expect(observerConformance(behind)).rejects.toThrow(/^observerConformance: result\(\d+\)\.(count|out|rows)/);
  });

  it('fails an observer that resolves where §2 says reject', async () => {
    const lenient = () => {
      const e = withSnapshotObserver(new RapierEngine());
      return reobserved(e, (o) => passthrough(o, (k) => (k > e.stepIndex ? o.result(e.stepIndex) : o.result(k))));
    };
    await expect(observerConformance(lenient)).rejects.toThrow('observerConformance: result(2), a step not yet taken, resolved; it must reject');
  });

  it('fails an engine without observe(), and disposes every engine it was given', async () => {
    let disposed = 0;
    const counted = <E extends PhysicsEngine>(e: E): E => {
      const dispose = e.dispose.bind(e);
      e.dispose = () => { disposed++; dispose(); };
      return e;
    };
    await expect(observerConformance(() => counted(new RapierEngine()))).rejects.toThrow(/has no observe\(\); wrap it with withSnapshotObserver/);
    await expect(observerConformance(() => counted(withSnapshotObserver(new RapierEngine())), { steps: 5 })).resolves.toEqual({ lag: 0, steps: 5, observations: 5 });
    expect(disposed).toBe(2);
  });
});
