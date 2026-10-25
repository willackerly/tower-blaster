import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type Observation, type ObservedEngine, type Observer, type PhysicsEngine, type ReduceSpec, type Snapshot, withSnapshotObserver } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { observerConformance } from '../src/index.ts';

/** e, with every observer it hands out replaced by edit(observer); before() runs ahead of every step. */
function reobserved(e: ObservedEngine, edit: (o: Observer) => Observer, before?: () => void): PhysicsEngine {
  return {
    get info() { return e.info; },
    get stepIndex() { return e.stepIndex; },
    init: (scene) => e.init(scene),
    push: (events) => e.push(events),
    step: () => {
      before?.();
      return e.step();
    },
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

  // Each wrong observer below is one that a single check of the harness must catch.
  const onRapier = (result: (o: Observer, e: ObservedEngine) => Observer['result']) => () => {
    const e = withSnapshotObserver(new RapierEngine());
    return reobserved(e, (o) => passthrough(o, result(o, e)));
  };

  it.each<[string, (r: Observation) => Observation, RegExp]>([
    ['a wrong row value', (r) => ({ ...r, rows: { ...r.rows, pos: r.rows.pos.map((v, i) => (i ? v : v + 1e-3)) } }), /^observerConformance: result\(1\)\.rows\.pos\[0\]: want /],
    ['reversed bins with the right n', (r) => ({ ...r, out: r.out.map((x) => (x.bins ? { ...x, bins: x.bins.slice().reverse() } : x)) }), /^observerConformance: result\(1\)\.out\.\d+\.bins\[\d+\]: want /],
    ['-0 for a sat of 0', (r) => ({ ...r, out: r.out.map((x) => (x.sat === 0 ? { ...x, sat: -0 } : x)) }), /^observerConformance: result\(1\)\.out\.5\.sat: want 0, got -0$/],
    ['-0 for a +0 row value', (r) => ({ ...r, rows: { ...r.rows, linVel: r.rows.linVel.map((v) => (v === 0 ? -0 : v)) } }), /^observerConformance: result\(1\)\.rows\.linVel\[\d+\]: want 0, got -0$/],
    ['an extra field', (r) => ({ ...r, extra: 1 }) as Observation, /^observerConformance: result\(1\)\.extra: want undefined, got 1$/],
  ])('fails an observer that returns %s', async (_, edit, msg) => {
    await expect(observerConformance(onRapier((o) => (k) => o.result(k).then(edit)))).rejects.toThrow(msg);
  });

  it.each<[string, (o: Observer, e: ObservedEngine) => Observer['result'], string]>([
    ['result(0)', (o) => (k) => (k === 0 ? Promise.resolve({} as Observation) : o.result(k)), 'result(0), before any query was evaluated, resolved'],
    ['a step with no query', (o) => (k) => o.result(k).catch((err: Error) => (k >= 1 && /no query/.test(err.message) ? o.result(150) : Promise.reject(err))), 'result(151), a step with no query, resolved'],
    ['a step older than keep', (o, e) => (k) => (k >= 1 && k <= e.stepIndex - 64 ? o.result(e.stepIndex) : o.result(k)), 'result(1), older than keep, resolved'],
  ])('fails an observer that resolves %s', async (_, result, what) => {
    await expect(observerConformance(onRapier(result))).rejects.toThrow(`observerConformance: ${what}; it must reject`);
  });

  it('fails an observer that forgets a step inside the keep window', async () => {
    const forgets = onRapier((o, e) => (k) => (k < e.stepIndex - 10 ? Promise.reject(new Error('gone')) : o.result(k)));
    await expect(observerConformance(forgets)).rejects.toThrow('observerConformance: result(1) rejected: gone');
  });

  it.each(['spec', 'watch ids', 'tag words'] as const)("fails an observer that keeps the caller's %s instead of a copy", async (what) => {
    // It reads the caller's object again before every step, as one that kept the reference would.
    const keeping = () => {
      let o: Observer, spec: ReduceSpec | null = null, ids: Int32Array | null = null;
      const tags: [number, Uint32Array][] = [];
      const again = () => {
        if (what === 'spec' && spec) o.query(spec);
        if (what === 'watch ids' && ids) o.watch(ids);
        if (what === 'tag words') for (const [first, words] of tags) o.setTags(first, words);
      };
      return reobserved(withSnapshotObserver(new RapierEngine()), (inner) => {
        o = inner;
        return {
          ...passthrough(inner, (k) => inner.result(k)),
          query: (s) => { spec = s; inner.query(s); },
          watch: (w) => { ids = w; inner.watch(w); },
          setTags: (first, words) => { tags.push([first, words]); inner.setTags(first, words); },
        };
      }, again);
    };
    await expect(observerConformance(keeping)).rejects.toThrow(/^observerConformance: result\(1\)\.(out|rows)\./);
  });

  it('fails an engine whose snapshots do not follow bodiesAt, though its observer agrees with them', async () => {
    // The ball never shows: the wrapper observes the engine's own snapshots exactly, so only the body count catches it.
    const hiding = () => {
      const r = new RapierEngine();
      let n = 0;
      return withSnapshotObserver({
        get info() { return r.info; },
        get stepIndex() { return r.stepIndex; },
        init: async (scene) => {
          n = scene.bodies.length;
          await r.init(scene);
        },
        push: (events) => r.push(events),
        step: () => r.step(),
        snapshot: (): Snapshot => ({ ...r.snapshot(), count: n }),
        dispose: () => r.dispose(),
      });
    };
    await expect(observerConformance(hiding)).rejects.toThrow(/^observerConformance: \d+ bodies after step 31, but bodiesAt gives \d+$/);
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
