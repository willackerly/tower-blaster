// Observer conformance (docs/design/reduce.md §8 item 5): every observer,
// native or wrapped, must report exactly what reduceRef computes from the
// engine's own consecutive snapshots.
import {
  bodiesAt, gatherRows, type Observation, type Observer, type PhysicsEngine, type Pred, reduceRef, type ReduceSpec, type SceneDesc,
  type Snapshot,
} from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';

const STRUCTURE: Pred = { cmp: { tag: 0, bits: 1 }, op: '==', k: 1 };

/** Every scalar kind, refs captured before and after the spawn, all three tag uses, dv at its default s. */
const SPEC_A: ReduceSpec = {
  outputs: [
    { op: 'count', where: 'awake' },
    { op: 'count', where: { cmp: { norm2: 'dv' }, op: '>=', k: 0 } },
    { op: 'max', x: { norm2: 'dv' }, where: 'all' },
    { op: 'max', x: { norm2: 'linVel' }, where: { and: ['awake', { or: [STRUCTURE, { cmp: { comp: 'pos', axis: 1 }, op: '>=', k: 19661 }] }] } },
    { op: 'count', where: { and: [STRUCTURE, { cmp: { norm2: { disp: 0 } }, op: '>', k: 10_737_418 }] } },
    { op: 'sum', x: { comp: 'pos', axis: 1 }, weight: 1, shift: 16, where: STRUCTURE },
    { op: 'hist', by: { x: { aabb: 'hi', axis: 1 }, edges: [0, 65536, 2 * 65536, 4 * 65536, 6 * 65536] }, where: STRUCTURE },
    { op: 'hist', by: { tag: 0, shift: 8, bits: 6, bins: 8 }, where: { not: { cmp: { norm2: 'angVel' }, op: '<', k: 171_798_692 } } },
    { op: 'max', x: { norm2: { disp: 1 } }, where: 'all' },
  ],
};

/** The swap: other scales, a dv component at s 20, aabb lo, a weighted sum of velocity. */
const SPEC_B: ReduceSpec = {
  outputs: [
    { op: 'max', x: { comp: 'dv', axis: 1, s: 20 }, where: 'awake' },
    { op: 'sum', x: { comp: 'linVel', axis: 0, s: 12 }, weight: 1, where: { not: STRUCTURE } },
    { op: 'hist', by: { x: { aabb: 'lo', axis: 0, s: 10 }, edges: [-4096, 0, 4096] }, where: { or: [STRUCTURE, 'awake'] } },
    { op: 'max', x: { comp: { disp: 0 }, axis: 0, s: 8 }, where: STRUCTURE },
  ],
};

export interface ConformanceReport {
  /** The observer's caps.lag. */
  lag: number;
  steps: number;
  /** Observations compared. */
  observations: number;
}

/** String(v), but -0 shows as -0. */
const show = (v: unknown) => (Object.is(v, -0) ? '-0' : String(v));

/** The first difference between two observations, as a path, or null. Numbers compare with Object.is. */
function difference(want: unknown, got: unknown, path: string): string | null {
  if (typeof want === 'number' || want === null || want === undefined) return Object.is(want, got) ? null : `${path}: want ${show(want)}, got ${show(got)}`;
  if (ArrayBuffer.isView(want)) {
    const w = want as unknown as ArrayLike<number>, g = got as ArrayLike<number> | undefined;
    if (!ArrayBuffer.isView(got) || want.constructor !== got.constructor || w.length !== g!.length) return `${path}: want ${want.constructor.name}(${w.length}), got ${String(got)}`;
    for (let i = 0; i < w.length; i++) if (!Object.is(w[i], g![i])) return `${path}[${i}]: want ${show(w[i])}, got ${show(g![i])}`;
    return null;
  }
  if (typeof want !== 'object' || typeof got !== 'object' || got === null) return `${path}: want ${JSON.stringify(want)}, got ${String(got)}`;
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const k of keys) {
    const d = difference((want as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

async function rejects(p: Promise<unknown>, what: string): Promise<void> {
  const settled = await p.then(() => 'resolved', () => 'rejected');
  if (settled !== 'rejected') throw new Error(`observerConformance: ${what} resolved; it must reject`);
}

/**
 * Drives a 200-step S5 run through every observer operation and checks that
 * result(k) equals reduceRef(snapshot_k, prev = snapshot_{k−1}) at every step
 * with a query, read at stepIndex − lag, again as the oldest of the keep window,
 * and that result() rejects where §2 says it must (a step not yet taken, one
 * older than keep, one with no query). The run covers:
 * - the ball spawns in step 30 (dv ⊥ for it once; watched before it exists);
 * - captureRef(1) at 10, before the spawn, and captureRef(0) at 50;
 * - setTags at 0 and at 80 (the ball, and an untagged structure body);
 * - watch lists at 0 and 100 with negative, out-of-range, duplicate and unspawned ids;
 * - a query swap at 120 (no re-prime), query(null) at 150 and a re-query at 160 (re-prime);
 * - every spec, tag and watch argument overwritten right after the call.
 * The factory returns an engine that has observe() (native, or withSnapshotObserver).
 * Throws on the first difference; disposes the engine either way.
 */
export async function observerConformance(factory: () => PhysicsEngine | Promise<PhysicsEngine>, opts: { steps?: number } = {}): Promise<ConformanceReport> {
  const steps = opts.steps ?? 200;
  const scene: SceneDesc = buildScenario('S5', { N: 40, F: 2, H: 5, street: 2, radius: 1, speed: 15, massRatio: 10, fireStep: 30 });
  const ball = scene.bodies.length, tagWords = 2;
  const e = await factory();
  try {
    if (!e.observe) throw new Error('observerConformance: the engine has no observe(); wrap it with withSnapshotObserver()');
    await e.init(scene);
    const obs: Observer = await e.observe({ tagWords });
    const { caps } = obs, lag = caps.lag;
    if (!(Number.isInteger(lag) && lag >= 0 && caps.keep > lag && caps.maxTagWords >= tagWords && caps.refSlots >= 2 && caps.maxWatch >= 6))
      throw new Error(`observerConformance: caps cannot run the scenario: ${JSON.stringify(caps)}`);

    // The model: what the observer was told, applied to the engine's own snapshots.
    // Every argument is overwritten after the call, so an observer that keeps it instead of a copy diverges.
    let spec: ReduceSpec | null = null, prev = new Float64Array(0), prevCount = 0, watch = new Int32Array(0), last: Snapshot = await e.snapshot();
    const tags = new Uint32Array(tagWords * (ball + 8)), refs: (Float64Array | null)[] = [null, null];
    const query = (s: ReduceSpec | null) => {
      const given = structuredClone(s);
      obs.query(given);
      if (given) (given.outputs as unknown[]).reverse();
      if (s && !spec) [prev, prevCount] = [last.linVel.slice(0, 3 * last.count), last.count];
      spec = s;
    };
    const setTags = (first: number, words: Uint32Array) => {
      const given = words.slice();
      obs.setTags(first, given);
      given.fill(0xffffffff);
      tags.set(words, tagWords * first);
    };
    const setWatch = (ids: number[]) => {
      const given = Int32Array.from(ids);
      obs.watch(given);
      given.fill(0);
      watch = Int32Array.from(ids);
    };
    const captureRef = (slot: number) => {
      obs.captureRef(slot);
      refs[slot] = last.pos.slice(0, 3 * last.count);
    };
    const plan: Record<number, () => void> = {
      0: () => {
        setTags(0, Uint32Array.from({ length: tagWords * ball }, (_, j) => (j % 2 ? 9810 : 1 | (((j >> 1) % 8) << 8))));
        setWatch([0, ball, -1, ball - 1, ball + 5, 0]);
        query(SPEC_A);
      },
      10: () => captureRef(1),
      50: () => captureRef(0),
      80: () => {
        setTags(ball, Uint32Array.of(3 << 8, 0x80000000));
        setTags(5, Uint32Array.of(0, 0));
      },
      100: () => setWatch([ball, 3, 3, -7, 1000, -(2 ** 31)]),
      120: () => query(SPEC_B),
      150: () => query(null),
      160: () => query(SPEC_A),
    };

    const expected = new Map<number, Observation>();
    let observations = 0;
    /** again: a step already compared, read once more as the oldest kept. */
    const check = async (k: number, again = false) => {
      const want = expected.get(k);
      if (!want) return rejects(obs.result(k), `result(${k}), a step with no query,`);
      const got = await obs.result(k).catch((err: unknown) => {
        throw new Error(`observerConformance: result(${k}) rejected: ${(err as Error).message}`);
      });
      const d = difference(want, got, `result(${k})`);
      if (d) throw new Error(`observerConformance: ${d}`);
      if (!again) observations++;
    };
    await rejects(obs.result(0), 'result(0), before any query was evaluated,');
    for (let k = 0; k < steps; k++) {
      plan[k]?.();
      await e.step();
      const now = e.stepIndex;
      if (now !== k + 1) throw new Error(`observerConformance: stepIndex ${now} after ${k + 1} steps`);
      const snap = await e.snapshot(), shapes = bodiesAt(scene, now).map((b) => b.shape);
      if (snap.count !== shapes.length) throw new Error(`observerConformance: ${snap.count} bodies after step ${now}, but bodiesAt gives ${shapes.length}`);
      if (spec) {
        const out = reduceRef(spec, {
          snap, prevLinVel: prev, prevCount, shapes, tagWords, tags, refs,
          gravity: scene.gravity, dt: scene.dt,
        });
        expected.set(now, { step: now, count: snap.count, out, rows: gatherRows(snap, watch) });
        [prev, prevCount] = [snap.linVel.slice(0, 3 * snap.count), snap.count];
      }
      last = snap;
      if (now - lag >= 1) await check(now - lag);
      await rejects(obs.result(now + 1), `result(${now + 1}), a step not yet taken,`);
      // The window's ends: the oldest kept still reads as it did, the one before it rejects.
      const oldest = now - caps.keep + 1;
      if (oldest >= 1 && oldest < now - lag) await check(oldest, true);
      if (oldest > 1) await rejects(obs.result(oldest - 1), `result(${oldest - 1}), older than keep,`);
      expected.delete(oldest - 1);
    }
    await e.finish?.();
    for (let k = Math.max(1, steps - lag + 1); k <= steps; k++) await check(k);
    return { lag, steps, observations };
  } finally {
    e.dispose();
  }
}
