import { describe, expect, it } from 'vitest';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import {
  type BodyDesc, bodiesAt, gatherRows, type GpuBodies, type InputEvent, OBSERVER_CAPS, type Observation, type PhysicsEngine, type Pred, reduceRef,
  type ReduceSpec, type SceneDesc, type Snapshot, type StepReport, withSnapshotObserver,
} from '../src/index.ts';

const SCENE = buildScenario('S5', { N: 40, F: 2, H: 5, street: 2, radius: 1, speed: 15, massRatio: 10, fireStep: 30 });
const BALL = SCENE.bodies.length;
const structure: Pred = { cmp: { tag: 0, bits: 1 }, op: '==', k: 1 };
const SPEC_A: ReduceSpec = {
  outputs: [
    { op: 'count', where: 'awake' },
    { op: 'count', where: { cmp: { norm2: 'dv' }, op: '>=', k: 0 } },
    { op: 'max', x: { norm2: 'dv' }, where: 'all' },
    { op: 'count', where: { and: [structure, { cmp: { norm2: { disp: 0 } }, op: '>', k: 10_737_418 }] } },
    { op: 'sum', x: { comp: 'pos', axis: 1 }, weight: 1, shift: 16, where: structure },
    { op: 'hist', by: { x: { aabb: 'hi', axis: 1 }, edges: [0, 65536, 2 * 65536, 4 * 65536, 6 * 65536] }, where: structure },
    { op: 'hist', by: { tag: 0, shift: 8, bits: 6, bins: 8 }, where: 'all' },
    { op: 'max', x: { norm2: { disp: 1 } }, where: 'all' },
  ],
};
const SPEC_B: ReduceSpec = {
  outputs: [
    { op: 'max', x: { comp: 'dv', axis: 1, s: 20 }, where: 'awake' },
    { op: 'sum', x: { comp: 'linVel', axis: 0, s: 12 }, weight: 1, where: { not: structure } },
    { op: 'hist', by: { x: { aabb: 'lo', axis: 0, s: 10 }, edges: [-4096, 0, 4096] }, where: { or: [structure, 'awake'] } },
  ],
};
const TAGS = Uint32Array.from({ length: 2 * BALL }, (_, j) => (j % 2 ? 9810 : 1 | ((j >> 1) % 8) << 8));

/** What every observation must be: reduceRef over the engine's own consecutive snapshots. */
class Model {
  spec: ReduceSpec | null = null;
  prev = new Float64Array(0);
  prevCount = 0;
  watch = new Int32Array(0);
  tags = new Uint32Array(64 * 2);
  refs: (Float64Array | null)[] = [null, null];
  constructor(readonly scene: SceneDesc, public last: Snapshot) {}

  query(spec: ReduceSpec | null) {
    if (spec && !this.spec) [this.prev, this.prevCount] = [this.last.linVel.slice(), this.last.count];
    this.spec = spec;
  }
  captureRef(slot: number) { this.refs[slot] = this.last.pos.slice(); }
  setTags(first: number, words: Uint32Array) { this.tags.set(words, 2 * first); }

  /** The observation for the state after `step` steps, or null when no query is active. */
  advance(snap: Snapshot, step: number): Observation | null {
    this.last = snap;
    if (!this.spec) return null;
    const out = reduceRef(this.spec, {
      snap, prevLinVel: this.prev, prevCount: this.prevCount, shapes: bodiesAt(this.scene, step).map((b) => b.shape), tagWords: 2,
      tags: this.tags, refs: this.refs, gravity: this.scene.gravity, dt: this.scene.dt,
    });
    [this.prev, this.prevCount] = [snap.linVel.slice(), snap.count];
    return { step, count: snap.count, out, rows: gatherRows(snap, this.watch) };
  }
}

describe('withSnapshotObserver on physics-ref (§2, §3.1)', () => {
  it('equals reduceRef on consecutive snapshots through spawn, refs, tags, watch changes and query swaps', async () => {
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(SCENE);
    const obs = await e.observe({ tagWords: 2 });
    const m = new Model(SCENE, await e.snapshot());
    const both = {
      query: (s: ReduceSpec | null) => { obs.query(s); m.query(s); },
      watch: (ids: number[]) => { obs.watch(Int32Array.from(ids)); m.watch = Int32Array.from(ids); },
      setTags: (first: number, w: Uint32Array) => { obs.setTags(first, w); m.setTags(first, w); },
      captureRef: (slot: number) => { obs.captureRef(slot); m.captureRef(slot); },
    };
    const plan: Record<number, () => void> = {
      0: () => { both.setTags(0, TAGS); both.watch([0, BALL, -1, BALL - 1, BALL + 5, 0]); both.query(SPEC_A); },
      10: () => both.captureRef(1), // before the ball spawns: ⊥ for it
      50: () => both.captureRef(0),
      80: () => { both.setTags(BALL, Uint32Array.of(3 << 8, 0x80000000)); both.setTags(5, Uint32Array.of(0, 0)); },
      100: () => both.watch([BALL, 3, 3, -7, 1000]),
      120: () => both.query(SPEC_B), // a swap: no re-prime
      150: () => both.query(null),
      160: () => both.query(SPEC_A), // re-primes from the state after 160
    };
    const seen = new Map<number, Observation>(), snaps = new Map<number, Snapshot>();
    for (let k = 0; k < 170; k++) {
      plan[k]?.();
      await e.step();
      expect(e.stepIndex).toBe(k + 1);
      const snap = await e.snapshot(), want = m.advance(snap, k + 1);
      snaps.set(k + 1, snap);
      if (want) {
        const got = await obs.result(k + 1);
        expect(got).toEqual(want);
        seen.set(k + 1, got);
      } else await expect(obs.result(k + 1)).rejects.toThrow(/no query was active/);
    }
    // The ball spawns in step 30: its id enters the domain and the watch list after it, with dv ⊥ once.
    expect(seen.get(30)!.count).toBe(BALL);
    expect(seen.get(30)!.rows.present[1]).toBe(0);
    expect(seen.get(31)!.count).toBe(BALL + 1);
    expect(seen.get(31)!.rows.present[1]).toBe(1);
    expect(seen.get(31)!.out[1]).toEqual({ n: BALL, invalid: 1 });
    expect(seen.get(32)!.out[1]).toEqual({ n: BALL + 1, invalid: 0 });
    expect(seen.get(60)!.out[7]).toMatchObject({ n: BALL, invalid: 1 }); // slot 1 was captured before it spawned
    expect(seen.get(119)!.out[3]!.n).toBeGreaterThan(0); // the impact moved structure since step 50
    // The re-prime at 160 measures dv from the state after 160, not the last evaluated state (150).
    const stale = reduceRef(SPEC_A, { ...inputOf(snaps.get(161)!, snaps.get(150)!), tags: m.tags, refs: m.refs });
    expect(stale[2]).not.toEqual(seen.get(161)!.out[2]);
    e.dispose();
  }, 120_000);

  it('a bad spec throws and changes nothing; the first query primes from the state at query()', async () => {
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(SCENE);
    for (let k = 0; k < 40; k++) await e.step();
    const obs = await e.observe({ tagWords: 2 });
    const m = new Model(SCENE, await e.snapshot());
    obs.query(SPEC_B);
    m.query(SPEC_B);
    await e.step();
    expect(await obs.result(41)).toEqual(m.advance(await e.snapshot(), 41));
    for (const bad of [{ outputs: [{ op: 'count', where: { cmp: { tag: 2 }, op: '>', k: 0 } }] }, { outputs: [{ op: 'sum', x: { norm2: 'dv' }, where: 'all' }] }]) {
      expect(() => obs.query(bad as ReduceSpec)).toThrow(/^spec\./);
    }
    await e.step();
    expect(await obs.result(42)).toEqual(m.advance(await e.snapshot(), 42));
    // Editing a spec after query() does not reach the observer.
    const mine = structuredClone(SPEC_A) as { outputs: { op: string; where: unknown }[] };
    obs.query(mine as ReduceSpec);
    m.query(SPEC_A);
    mine.outputs[0]!.where = { cmp: { tag: 3 }, op: '>', k: 0 };
    await e.step();
    expect(await obs.result(43)).toEqual(m.advance(await e.snapshot(), 43));
    e.dispose();
  });

  it('result(k) rejects k > stepIndex, k ≤ stepIndex − keep, a step with no query, and a non-integer', async () => {
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(tiny());
    const obs = await e.observe({ tagWords: 0 });
    expect(obs.caps).toEqual(OBSERVER_CAPS);
    expect([obs.caps.lag, obs.caps.keep]).toEqual([0, 64]);
    await expect(obs.result(0)).rejects.toThrow(/no query was active/);
    obs.query({ outputs: [{ op: 'count', where: 'all' }] });
    await expect(obs.result(0)).rejects.toThrow(/no query was active/);
    for (let k = 0; k < 70; k++) await e.step();
    await expect(obs.result(71)).rejects.toThrow(/only 70 steps taken/);
    await expect(obs.result(6)).rejects.toThrow(/older than keep/);
    expect((await obs.result(7)).step).toBe(7);
    expect((await obs.result(70)).out).toEqual([{ n: 3, invalid: 0 }]);
    await expect(obs.result(69.5)).rejects.toThrow(/integer/);
    obs.query(null);
    await e.step();
    await expect(obs.result(71)).rejects.toThrow(/no query was active/);
    expect((await obs.result(70)).step).toBe(70);
    e.dispose();
  });

  it('rejects bad arguments to observe, watch, setTags and captureRef', async () => {
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await expect(e.observe({ tagWords: 1 })).rejects.toThrow(/init\(\) first/);
    await e.init(tiny());
    for (const tagWords of [-1, 5, 1.5, NaN]) await expect(e.observe({ tagWords })).rejects.toThrow(RangeError);
    const obs = await e.observe({ tagWords: 2 });
    expect(() => obs.watch(new Int32Array(257))).toThrow(/maxWatch = 256/);
    expect(() => obs.watch(new Int32Array(256))).not.toThrow();
    expect(() => obs.setTags(-1, new Uint32Array(2))).toThrow(/first/);
    expect(() => obs.setTags(0.5, new Uint32Array(2))).toThrow(/first/);
    expect(() => obs.setTags(0, new Uint32Array(3))).toThrow(/whole number of ids/);
    expect(() => obs.setTags(2 ** 22 - 1, new Uint32Array(4))).toThrow(/maxBodies/);
    expect(() => obs.setTags(2 ** 22 - 1, new Uint32Array(2))).not.toThrow();
    for (const slot of [-1, 2, 0.5]) expect(() => obs.captureRef(slot)).toThrow(/refSlots = 2/);
    const none = await e.observe({ tagWords: 0 });
    expect(() => none.setTags(0, new Uint32Array(1))).toThrow(/tagWords = 0/);
    expect(() => none.setTags(5, new Uint32Array(0))).not.toThrow();
    const unsorted = tiny();
    unsorted.inputs = [unsorted.inputs[0]!, { ...unsorted.inputs[0]!, step: 0 }];
    await e.init(unsorted);
    await expect(e.observe({ tagWords: 0 })).rejects.toThrow(/sorted by step/);
    e.dispose();
  });

  it('watch() and setTags() copy their arguments', async () => {
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(tiny());
    const obs = await e.observe({ tagWords: 1 });
    const ids = Int32Array.of(1, 0), words = Uint32Array.of(5, 6);
    obs.watch(ids);
    obs.setTags(0, words);
    obs.query({ outputs: [{ op: 'hist', by: { tag: 0, bits: 3, bins: 8 }, where: 'all' }] });
    ids[0] = -1;
    words[0] = 7;
    await e.step();
    const o = await obs.result(1);
    expect([...o.rows.ids]).toEqual([1, 0]);
    expect([...o.rows.present]).toEqual([1, 1]);
    expect([...o.out[0]!.bins!]).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
    e.dispose();
  });

  it('init(), dispose() and a later observe() retire an observer', async () => {
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(tiny());
    const first = await e.observe({ tagWords: 0 });
    const second = await e.observe({ tagWords: 0 });
    expect(() => first.query(null)).toThrow(/replaced by a later observe/);
    second.query({ outputs: [{ op: 'count', where: 'all' }] });
    await e.step();
    expect((await second.result(1)).out).toEqual([{ n: 2, invalid: 0 }]);
    await e.init(tiny());
    expect(() => second.watch(new Int32Array(0))).toThrow(/re-initialized/);
    await expect(second.result(1)).rejects.toThrow(/re-initialized/);
    const third = await e.observe({ tagWords: 0 });
    e.dispose();
    expect(() => third.captureRef(0)).toThrow(/disposed/);
  });

  it('passes the engine through when unobserved', async () => {
    const inner = new AvbdReferenceEngine(), e = withSnapshotObserver(inner);
    expect(e.inner).toBe(inner);
    expect(e.info).toBe(inner.info);
    expect(e.finish).toBeUndefined();
    expect(e.gpu).toBeUndefined();
    await e.init(tiny());
    expect(e.step()).toBeUndefined();
    expect(e.stepIndex).toBe(1);
    expect(await e.snapshot()).toEqual(inner.snapshot());
    expect(withSnapshotObserver(new AsyncEngine(new AvbdReferenceEngine(), 'snapshot')).finish).toBeTypeOf('function');
    e.dispose();
    const bodies = { count: 7 } as GpuBodies, onGpu = Object.assign(new AvbdReferenceEngine(), { gpu: () => bodies });
    expect(withSnapshotObserver(onGpu).gpu!()).toBe(bodies);
  });

  it.each([['snapshot()', 'snapshot'], ['step()', 'step'], ['step() and snapshot()', 'both']] as const)('an engine with an async %s: step() returns a promise, observer calls wait or throw, results are the same', async (_, kind) => {
    const sync = withSnapshotObserver(new AvbdReferenceEngine()), e = withSnapshotObserver(new AsyncEngine(new AvbdReferenceEngine(), kind));
    for (const x of [sync, e]) await x.init(SCENE);
    const [a, b] = [await sync.observe({ tagWords: 2 }), await e.observe({ tagWords: 2 })];
    for (const o of [a, b]) {
      o.setTags(0, TAGS);
      o.watch(Int32Array.of(BALL, 2));
      o.query(SPEC_A);
    }
    for (let k = 0; k < 40; k++) {
      sync.step();
      const p = e.step();
      expect(p).toBeInstanceOf(Promise);
      expect(() => e.step()).toThrow(/still pending/);
      expect(() => b.captureRef(0)).toThrow(/still pending/);
      const r = b.result(k + 1); // waits for the pending evaluation
      await p;
      expect(await r).toEqual(await a.result(k + 1));
      if (k === 20) for (const o of [a, b]) o.captureRef(0);
    }
    // finish() settles the pending evaluation too, so the caller may step at once.
    void e.step();
    await e.finish!();
    await e.step();
    expect(e.stepIndex).toBe(42);
    sync.dispose();
    e.dispose();
  });

  it('an engine with more bodies than its scene fails the step and retires the observer', async () => {
    const inner = new AvbdReferenceEngine(), e = withSnapshotObserver(inner);
    await e.init(tiny());
    const obs = await e.observe({ tagWords: 0 });
    obs.query({ outputs: [{ op: 'count', where: 'all' }] });
    inner.world!.add(tiny().bodies[0]!); // a body the scene does not describe
    expect(() => e.step()).toThrow(/^3 bodies, but the scene and the spawns so far describe 2$/);
    await expect(obs.result(1)).rejects.toThrow(/observer failed after step 1/);
    // Detached as well: later steps run unobserved instead of failing again.
    expect(() => e.step()).not.toThrow();
    expect(e.stepIndex).toBe(2);
    expect(() => obs.query(null)).toThrow(/observer failed after step 1/);
  });

  it.each([['a sync engine', 'sync'], ['an async snapshot()', 'snapshot'], ['an async step() and snapshot()', 'both']] as const)('%s: a snapshot() that fails after an observed step retires and detaches the observer', async (_, kind) => {
    const inner = new AsyncEngine(new AvbdReferenceEngine(), kind), e = withSnapshotObserver(inner);
    await e.init(SCENE);
    const obs = await e.observe({ tagWords: 2 });
    obs.query(SPEC_B);
    for (let k = 0; k < 3; k++) await e.step();
    inner.failNext = true;
    const step = async () => e.step();
    await expect(step()).rejects.toThrow(/transient snapshot failure/);
    // Step 4 was never evaluated, so the next dv would span two steps: every call now fails with the reason.
    const why = /observer failed after step 4: transient snapshot failure/;
    expect(e.stepIndex).toBe(4);
    expect(() => obs.query(SPEC_B)).toThrow(why);
    await expect(obs.result(3)).rejects.toThrow(why);
    // Detached: the next step takes no snapshot, so a failure that persists cannot fail it.
    inner.failNext = true;
    await e.step();
    expect(inner.failNext).toBe(true);
    inner.failNext = false;
    const again = await e.observe({ tagWords: 2 }), m = new Model(SCENE, await e.snapshot());
    again.query(SPEC_B);
    m.query(SPEC_B);
    await e.step();
    expect(await again.result(6)).toEqual(m.advance(await e.snapshot(), 6));
    e.dispose();
  });

  it('observe() refuses while a step is pending, observed or not, and fails if init() or dispose() runs meanwhile', async () => {
    const e = withSnapshotObserver(new AsyncEngine(new AvbdReferenceEngine(), 'both'));
    await e.init(SCENE);
    // Unobserved: observe() would otherwise prime from the state this step replaces.
    const p = e.step();
    expect(() => e.step()).toThrow(/still pending/);
    await expect(e.observe({ tagWords: 2 })).rejects.toThrow(/observe\(\): a step\(\) is still pending/);
    await p;
    const obs = await e.observe({ tagWords: 2 }), m = new Model(SCENE, await e.snapshot());
    obs.query(SPEC_B);
    m.query(SPEC_B);
    const q = e.step();
    await expect(e.observe({ tagWords: 2 })).rejects.toThrow(/observe\(\): a step\(\) is still pending/);
    await q;
    expect(await obs.result(2)).toEqual(m.advance(await e.snapshot(), 2));
    // init() while observe() awaits its snapshot, even with the same scene: that snapshot is of the old run.
    const late = e.observe({ tagWords: 2 });
    await e.init(SCENE);
    await expect(late).rejects.toThrow(/init\(\) or dispose\(\) ran meanwhile/);
    const disposed = e.observe({ tagWords: 2 });
    e.dispose();
    await expect(disposed).rejects.toThrow(/init\(\) or dispose\(\) ran meanwhile/);
  });

  it('init() while an observed step is pending retires its observer, and that step still resolves', async () => {
    const e = withSnapshotObserver(new AsyncEngine(new AvbdReferenceEngine(), 'snapshot'));
    await e.init(SCENE);
    const obs = await e.observe({ tagWords: 2 });
    obs.query({ outputs: [{ op: 'count', where: 'all' }] });
    const p = e.step();
    // tiny() has 3 shapes: the old run's snapshot, evaluated against them, would throw.
    await e.init(tiny());
    await p;
    expect(() => obs.query(null)).toThrow(/re-initialized/);
    await expect(obs.result(1)).rejects.toThrow(/re-initialized/);
    e.dispose();
  });

  it('ids and shapes follow bodiesAt through spawns of different shapes', async () => {
    const scene = tiny();
    scene.inputs = [
      { step: 1, kind: 'spawn', body: { ...cube(6, 3), shape: { kind: 'sphere', radius: 2 } } },
      { step: 2, kind: 'spawn', body: { ...cube(9, 3), shape: { kind: 'box', half: [0.25, 1, 0.25] } } },
    ];
    const spec: ReduceSpec = {
      outputs: [
        { op: 'hist', by: { x: { aabb: 'hi', axis: 1 }, edges: [1, 2, 3, 4, 5].map((m) => m * 65536) }, where: 'all' },
        { op: 'hist', by: { x: { aabb: 'lo', axis: 0 }, edges: [2, 4, 6, 8].map((m) => m * 65536) }, where: 'all' },
      ],
    };
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(scene);
    const obs = await e.observe({ tagWords: 2 }), m = new Model(scene, await e.snapshot());
    obs.query(spec);
    m.query(spec);
    for (let k = 0; k < 6; k++) {
      await e.step();
      expect(await obs.result(k + 1)).toEqual(m.advance(await e.snapshot(), k + 1));
    }
    expect((await obs.result(6)).count).toBe(4);
    e.dispose();
  });

  it('ids and shapes follow push(): a past step applies at the next step, same-step pushes keep push order', async () => {
    const scene = tiny();
    const sphere = (x: number, radius: number): BodyDesc => ({ ...cube(x, 3), shape: { kind: 'sphere', radius } });
    const slab = (x: number): BodyDesc => ({ ...cube(x, 3), shape: { kind: 'box', half: [1, 0.25, 1] } });
    // Pushed before step() k. The scene's own input (a cube, step 2) lands between them.
    const plan: Record<number, InputEvent[]> = {
      1: [{ step: 0, kind: 'spawn', body: sphere(9, 2) }],
      3: [{ step: 4, kind: 'spawn', body: slab(12) }, { step: 4, kind: 'spawn', body: sphere(15, 0.5) }],
    };
    // The session as recorded: each event at the step it applied, in apply order, so bodiesAt gives the engine's ids.
    const recorded: SceneDesc = { ...scene, inputs: [...scene.inputs] };
    const record = (events: InputEvent[], now: number) => {
      for (const ev of events) {
        let i = recorded.inputs.length;
        while (i > 0 && recorded.inputs[i - 1]!.step > Math.max(ev.step, now)) i--;
        recorded.inputs.splice(i, 0, { ...ev, step: Math.max(ev.step, now) });
      }
    };
    const spec: ReduceSpec = {
      outputs: [
        { op: 'hist', by: { x: { aabb: 'hi', axis: 1 }, edges: [1, 2, 3, 4, 5].map((m) => m * 65536) }, where: 'all' },
        { op: 'hist', by: { x: { aabb: 'lo', axis: 0 }, edges: [2, 4, 6, 8, 10, 12, 14].map((m) => m * 65536) }, where: 'all' },
      ],
    };
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(scene);
    const obs = await e.observe({ tagWords: 2 }), m = new Model(recorded, await e.snapshot());
    obs.query(spec);
    m.query(spec);
    for (let k = 0; k < 7; k++) {
      if (plan[k]) {
        e.push(plan[k]!);
        record(plan[k]!, k);
      }
      await e.step();
      expect(await obs.result(k + 1)).toEqual(m.advance(await e.snapshot(), k + 1));
    }
    expect(recorded.inputs.map((ev) => ev.step)).toEqual([1, 2, 4, 4]);
    expect((await obs.result(7)).count).toBe(6);
    // The recording replays the live session.
    const replay = new AvbdReferenceEngine();
    await replay.init(recorded);
    for (let k = 0; k < 7; k++) replay.step();
    expect(replay.snapshot()).toEqual(await e.snapshot());
    e.dispose();
  });

  it('push() refuses while an async step() is still running, and is accepted once it settles', async () => {
    const e = withSnapshotObserver(new AsyncEngine(new AvbdReferenceEngine(), 'step'));
    await e.init(tiny());
    const ev: InputEvent = { step: 0, kind: 'spawn', body: cube(9, 3) };
    const p = e.step();
    expect(() => e.push([ev])).toThrow(/^push\(\): a step\(\) is still running/);
    await p;
    e.push([ev]);
    await e.step();
    expect((await e.snapshot()).count).toBe(3);
    e.dispose();
  });
});

const cube = (x: number, y: number): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos: [x, y, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0],
  density: 1, friction: 0.5, restitution: 0, tag: 0,
});

/** Two cubes and a third spawned at step 2. */
function tiny(): SceneDesc {
  return {
    id: 'tiny', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: false,
    bodies: [cube(0, 0.5), cube(3, 0.5)], inputs: [{ step: 2, kind: 'spawn', body: cube(6, 2) }],
  };
}

function inputOf(snap: Snapshot, prev: Snapshot) {
  return {
    snap, prevLinVel: prev.linVel, prevCount: prev.count, shapes: bodiesAt(SCENE, 200).map((b) => b.shape), tagWords: 2,
    gravity: SCENE.gravity, dt: SCENE.dt,
  };
}

/**
 * An engine whose snapshot(), step() or both resolve a task later, as a GPU engine's would
 * (SlowedEngine(GpuAvbdEngine) has both). failNext makes the next snapshot() fail.
 */
class AsyncEngine implements PhysicsEngine {
  failNext = false;
  constructor(private readonly e: PhysicsEngine, private readonly kind: 'sync' | 'snapshot' | 'step' | 'both') {}
  get info() { return this.e.info; }
  get stepIndex() { return this.e.stepIndex; }
  init(scene: SceneDesc) { return this.e.init(scene); }
  push(events: InputEvent[]) { this.e.push(events); }
  step(): StepReport | void | Promise<StepReport | void> {
    if (this.kind !== 'step' && this.kind !== 'both') return this.e.step();
    return new Promise((done) => setTimeout(() => done(this.e.step())));
  }
  snapshot(): Snapshot | Promise<Snapshot> {
    const later = this.kind === 'snapshot' || this.kind === 'both', fail = this.failNext;
    this.failNext = false;
    if (fail && !later) throw new Error('transient snapshot failure');
    const s = this.e.snapshot();
    if (!later) return s;
    return new Promise((done, reject) => setTimeout(() => (fail ? reject(new Error('transient snapshot failure')) : done(s))));
  }
  async finish(): Promise<void> {}
  dispose() { this.e.dispose(); }
}

