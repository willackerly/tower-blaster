// C10, many worlds in one solve (islands.ts, island-observer.ts): the layout,
// the id map and event release, local reads, leaks and per-island counts.
// Engine runs (reference: islands against solo worlds) are in
// physics-ref/test/islands.test.ts; the GPU check is mode-probes' C10.
import { describe, expect, it } from 'vitest';
import {
  type BodyDesc, checkInputQueue, DEFAULT_ISLAND_REACH, emptySnapshot, type InputEvent, islandBits, islandCells, islandOffsets, Islands,
  islandSpec, MAX_ISLANDS, type Pred, reduceIslands, type SceneDesc, spawnedBodies, type Vec3, worldExtent,
} from '../src/index.ts';

const cube = (pos: Vec3, half = 0.25): BodyDesc => ({ shape: { kind: 'box', half: [half, half, half] }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1000, friction: 0.5, restitution: 0, tag: 0 });
const ball = (pos: Vec3, r = 0.1): BodyDesc => ({ ...cube(pos), shape: { kind: 'sphere', radius: r }, tag: -1 });
const scene = (id: string, bodies: BodyDesc[], inputs: InputEvent[] = [], extra: Partial<SceneDesc> = {}): SceneDesc => ({
  id, params: {}, seed: 1, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: true, bodies, inputs, ...extra,
});

describe('island layout', () => {
  it('island 0 is at the origin, then square rings, nearest first; every cell once', () => {
    const c = islandCells(MAX_ISLANDS);
    expect(c[0]).toEqual([0, 0]);
    expect(new Set(c.map((x) => x.join())).size).toBe(MAX_ISLANDS);
    // Rings fill in order: the first 9 are the 3 x 3 block, the first 25 the 5 x 5.
    for (const [n, r] of [[9, 1], [25, 2], [49, 3]] as const) expect(Math.max(...c.slice(0, n).flat().map(Math.abs))).toBe(r);
    // Within a ring, the edge midpoints come before the corners.
    expect(c.slice(1, 5).every(([x, z]) => Math.abs(x) + Math.abs(z) === 1)).toBe(true);
    // 64 islands reach ring 4 (cells 49..63 lie on it).
    expect(Math.max(...islandCells(64).flat().map(Math.abs))).toBe(4);
    expect(islandOffsets(3, 40)).toEqual([[0, 0, 0], [0, 0, -40], [-40, 0, 0]]);
    expect(() => islandCells(0)).toThrow(/K must be/);
    expect(() => islandCells(MAX_ISLANDS + 1)).toThrow(/K must be/);
  });

  it('the gap comes from the widest world plus the reach, rounded up to a whole metre', () => {
    const w = scene('w', [cube([1, 0.25, -2])], [{ step: 3, kind: 'spawn', body: ball([-4, 1, 0], 0.5) }, { step: 9, kind: 'blast', blast: { centre: [0, 0, 3], radius: 1.5, impulse: 10 } }]);
    // Bodies: |z| 2 + sqrt(3)/4; the ball: 4 + 0.5; the blast: 3 + 1.5. The ball and the blast tie at 4.5.
    expect(worldExtent(w)).toBeCloseTo(4.5, 12);
    const isl = new Islands([w, w]);
    expect(isl.gap).toBe(Math.ceil(2 * (4.5 + DEFAULT_ISLAND_REACH)));
    expect(isl.half).toBe(isl.gap / 2);
    expect(isl.reach).toBeCloseTo(isl.half - 4.5, 12);
    expect(new Islands([w], { reach: 0 }).gap).toBe(9);
    expect(() => new Islands([w], { gap: 8 })).toThrow(/narrower than the worlds/);
    expect(() => new Islands([w], { reach: -1 })).toThrow(/reach must be/);
  });

  it('refuses worlds that cannot share one solve', () => {
    const a = scene('a', [cube([0, 0.25, 0])]);
    expect(() => new Islands([a, { ...a, dt: 1 / 120 }])).toThrow(/world 1 differs from world 0 in dt/);
    expect(() => new Islands([a, { ...a, gravity: [0, -9.8, 0] }])).toThrow(/gravity/);
    expect(() => new Islands([a, { ...a, ground: { y: 0, friction: 0.6 } }])).toThrow(/ground/);
    expect(() => new Islands([a, { ...a, frictionCombine: 'min' }])).toThrow(/frictionCombine/);
    expect(() => new Islands([])).toThrow(/1 to 256 worlds/);
  });
});

/**
 * Two worlds whose events interleave: world 0 spawns at 5 and removes that spawn at 10; world 1 spawns at 3,
 * blasts around that spawn at 7 (excluding it) and spawns again at 5. Released step by step, the global ids
 * follow the engine's order: by step, then island.
 */
function twoWorlds(): [SceneDesc, SceneDesc] {
  const w0 = scene('w0', [cube([0, 0.25, 0]), cube([0.6, 0.25, 0])], [
    { step: 5, kind: 'spawn', body: ball([-2, 0.5, 0]) },
    { step: 10, kind: 'remove', id: 2 },
  ]);
  const w1 = scene('w1', [cube([0, 0.25, 0]), cube([0, 0.75, 0]), cube([0, 1.25, 0])], [
    { step: 3, kind: 'spawn', body: ball([1, 2, 0.5]) },
    { step: 7, kind: 'blast', blast: { centre: { body: 3 }, radius: 2, impulse: 50, exclude: [3] } },
    { step: 5, kind: 'spawn', body: ball([2, 0.5, -1]) },
  ]);
  return [w0, w1];
}

describe('the id map and event release', () => {
  it('packs every world at its offset, island by island, and releases each event at its step with global ids and coordinates', () => {
    const [w0, w1] = twoWorlds(), isl = new Islands([w0, w1], { gap: 20 }), o1 = isl.offsets[1]!;
    expect(isl.scene.bodies).toHaveLength(5);
    expect(isl.scene.inputs).toEqual([]);
    expect(isl.scene.bodies.slice(2).map((b) => b.pos)).toEqual(w1.bodies.map((b) => [b.pos[0] + o1[0], b.pos[1], b.pos[2] + o1[2]]));
    expect([0, 1, 2, 3, 4].map((id) => [isl.islandOf(id), isl.localOf(id)])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1], [1, 2]]);
    const byStep: InputEvent[][] = [];
    for (let s = 0; s <= 12; s++) byStep.push(isl.due(s));
    expect(byStep.map((e) => e.length)).toEqual([0, 0, 0, 1, 0, 2, 0, 1, 0, 0, 1, 0, 0]);
    // Step 3: world 1's ball is id 5. Step 5: world 0's ball (6), then world 1's second ball (7).
    expect([5, 6, 7].map((id) => [isl.islandOf(id), isl.localOf(id)])).toEqual([[1, 3], [0, 2], [1, 4]]);
    expect(isl.idOf(1, 3)).toBe(5);
    expect(isl.bodiesOf(0)).toBe(3);
    const ball1 = (w1.inputs[0] as Extract<InputEvent, { kind: 'spawn' }>).body;
    expect(byStep[3]![0]).toEqual({ step: 3, kind: 'spawn', body: { ...ball1, pos: [1 + o1[0], 2, 0.5 + o1[2]] } });
    expect(byStep[7]![0]).toEqual({ step: 7, kind: 'blast', blast: { centre: { body: 5 }, radius: 2, impulse: 50, exclude: [5] } });
    expect(byStep[10]![0]).toEqual({ step: 10, kind: 'remove', id: 6 });
    // The record is a valid queue, and an engine assigns its spawns exactly the ids the map did.
    const rec = isl.record();
    checkInputQueue(rec.bodies.length, rec.inputs);
    spawnedBodies(rec.inputs).forEach((b, i) => {
      const id = rec.bodies.length + i, k = isl.islandOf(id), o = isl.offsets[k]!, w = [w0, w1][k]!;
      const local = spawnedBodies(queueOrder(w.inputs))[isl.localOf(id) - w.bodies.length]!;
      expect(b.pos).toEqual([local.pos[0] + o[0], local.pos[1] + o[1], local.pos[2] + o[2]]);
    });
    expect(() => isl.due(12)).toThrow(/once per step/);
    expect(() => isl.idOf(0, 9)).toThrow(/island 0 has no body 9/);
    expect(() => isl.islandOf(99)).toThrow(/no body 99/);
  });

  it('pack() gives the same scene as releasing step by step', () => {
    const a = new Islands(twoWorlds(), { gap: 20 }), b = new Islands(twoWorlds(), { gap: 20 });
    for (let s = 0; s <= 12; s++) b.due(s);
    expect(a.pack()).toEqual(b.record());
    expect(a.count).toBe(b.count);
    // Packed steps release nothing; a later push is released at its step.
    expect(a.due(4)).toEqual([]);
    a.push(1, [{ step: 20, kind: 'remove', id: 4 }]);
    expect(a.due(19)).toEqual([]);
    expect(a.due(20)).toEqual([{ step: 20, kind: 'remove', id: 7 }]);
    // A push due inside the packed range would be late: refused.
    const c = new Islands(twoWorlds(), { gap: 20 });
    c.pack();
    c.push(0, [{ step: 6, kind: 'remove', id: 0 }]);
    expect(() => c.due(6)).toThrow(/pushed after pack\(\) sealed/);
    // An event pushed late (due before the next step) is packed at the next step.
    const d = new Islands(twoWorlds(), { gap: 20 });
    for (let s = 0; s <= 12; s++) d.due(s);
    d.push(1, [{ step: 2, kind: 'remove', id: 0 }]);
    expect(d.pack().inputs.at(-1)).toEqual({ step: 13, kind: 'remove', id: 2 });
    // A world's own body-centred blast is checked like a pushed one.
    const big = twoWorlds();
    expect(() => new Islands(big, { gap: 5.6 })).toThrow(/island 1's blast \(radius 2 m\) can reach past its cell/);
  });

  it('a push applies as on a solo engine: a past step means the next due(), in push order after events due at the same step', () => {
    const isl = new Islands([scene('a', [cube([0, 0.25, 0])])], { gap: 20 });
    isl.push(0, [{ step: 4, kind: 'spawn', body: ball([1, 1, 0]) }, { step: 2, kind: 'spawn', body: ball([2, 1, 0]) }]);
    expect(isl.due(0)).toEqual([]);
    expect(isl.due(3).map((e) => (e as { body: BodyDesc }).body.pos[0])).toEqual([2]);
    isl.push(0, [{ step: 1, kind: 'spawn', body: ball([3, 1, 0]) }]);
    expect(isl.due(4).map((e) => (e as { body: BodyDesc }).body.pos[0])).toEqual([3, 1]);
  });

  it('refuses a blast that could reach past its island', () => {
    const isl = new Islands([scene('a', [cube([0, 0.25, 0])])], { gap: 10 });
    expect(() => isl.push(0, [{ step: 1, kind: 'blast', blast: { centre: [4, 0, 0], radius: 1.5, impulse: 1 } }])).toThrow(/can reach past its cell/);
    expect(() => isl.push(0, [{ step: 1, kind: 'blast', blast: { centre: { body: 0 }, radius: 4.8, impulse: 1 } }])).toThrow(/can reach past its cell/);
    isl.push(0, [{ step: 1, kind: 'blast', blast: { centre: [3, 0, 0], radius: 1.5, impulse: 1 } }]);
    expect(() => isl.push(3, [])).toThrow(/no island 3/);
  });

  it('a relative spawn keeps its parent\'s frame and a force its body: only ids move, and a pull\'s world point with the island', () => {
    const w = scene('a', [cube([0, 0.25, 0]), cube([1, 0.25, 0])]);
    const isl = new Islands([w, w], { gap: 10 }), o = isl.offsets[1]!;
    const child = ball([0, 0.5, 0]);
    const thrust = { thrust: [0, 5, 0] as Vec3, axes: 'heading' as const, steps: 4 };
    const pull = { pull: [2, 1, -1] as Vec3, stiffness: 50, steps: 3 };
    isl.push(1, [
      { step: 1, kind: 'spawn', body: child, from: { body: 1, axes: 'body' } },
      { step: 2, kind: 'force', id: 2, force: thrust },
      { step: 2, kind: 'force', id: 0, force: pull },
      { step: 3, kind: 'force', id: 2, force: null },
    ]);
    const out = [0, 1, 2, 3].flatMap((s) => isl.due(s));
    expect(isl.idOf(1, 2)).toBe(4);
    expect(out).toEqual([
      { step: 1, kind: 'spawn', body: child, from: { body: isl.idOf(1, 1), axes: 'body' } },
      { step: 2, kind: 'force', id: 4, force: thrust },
      { step: 2, kind: 'force', id: isl.idOf(1, 0), force: { ...pull, pull: [2 + o[0], 1, -1 + o[2]] } },
      { step: 3, kind: 'force', id: 4, force: null },
    ]);
    // solo(1) is in local ids, with the pull point and plain spawns offset, the relative spawn as written.
    const solo = isl.solo(1).inputs;
    expect(solo[0]).toEqual({ step: 1, kind: 'spawn', body: child, from: { body: 1, axes: 'body' } });
    expect(solo[2]).toEqual({ step: 2, kind: 'force', id: 0, force: { ...pull, pull: [2 + o[0], 1, -1 + o[2]] } });
    // A relative spawn does not widen the world (its parent is already in it); a pull point must fit the cell.
    expect(worldExtent(scene('b', [cube([0, 0.25, 0])], [{ step: 1, kind: 'spawn', body: ball([30, 0, 0]), from: { body: 0 } }]))).toBe(worldExtent(scene('c', [cube([0, 0.25, 0])])));
    expect(() => isl.push(0, [{ step: 5, kind: 'force', id: 0, force: { ...pull, pull: [6, 0, 0] } }])).toThrow(/outside its cell/);
  });

  it('refuses field events: gravity and kicks belong to the whole solve, not one island', () => {
    const isl = new Islands([scene('a', [cube([0, 0.25, 0])]), scene('b', [cube([0, 0.25, 0])])], { gap: 10 });
    expect(() => isl.push(1, [{ step: 2, kind: 'field', gravity: [1, -9.75, 0] }])).toThrow(/field event at step 2.*world-wide/);
    expect(() => isl.push(0, [{ step: 2, kind: 'field', kick: [0, 1, 0] }])).toThrow(/world-wide/);
    expect(() => new Islands([scene('c', [cube([0, 0.25, 0])], [{ step: 5, kind: 'field', kick: [0, 1, 0] }])])).toThrow(/world-wide/);
  });

  it('solo(k) is world k alone at its island, with its own events in local ids', () => {
    const [w0, w1] = twoWorlds(), isl = new Islands([w0, w1], { gap: 20 }), o = isl.offsets[1]!;
    for (let s = 0; s <= 4; s++) isl.due(s);
    const solo = isl.solo(1);
    expect(solo.bodies.map((b) => b.pos)).toEqual(w1.bodies.map((b) => [b.pos[0] + o[0], b.pos[1], b.pos[2] + o[2]]));
    // Released (step 3) and queued (5, 7) events, local ids, offset coordinates.
    expect(solo.inputs.map((e) => [e.step, e.kind])).toEqual([[3, 'spawn'], [5, 'spawn'], [7, 'blast']]);
    expect((solo.inputs[2] as Extract<InputEvent, { kind: 'blast' }>).blast).toMatchObject({ centre: { body: 3 }, exclude: [3] });
    expect((solo.inputs[0] as { body: BodyDesc }).body.pos).toEqual([1 + o[0], 2, 0.5 + o[2]]);
  });
});

/** Inputs in the order an engine queues them (stable by step). */
const queueOrder = (xs: readonly InputEvent[]) => [...xs].sort((a, b) => a.step - b.step);

/** A snapshot of the islands' bodies at their scene positions, `move` applied. */
function snapAt(isl: Islands, move: (id: number, p: number[]) => void = () => {}) {
  const s = emptySnapshot(isl.count);
  const bodies = [...isl.scene.bodies, ...spawnedBodies(isl.record().inputs)];
  bodies.forEach((b, id) => { const p = [...b.pos]; move(id, p); s.pos.set(p, 3 * id); s.rot.set(b.rot, 4 * id); s.awake[id] = 1; });
  return s;
}

describe('reads per island', () => {
  it('local() is each world in its own ids and coordinates; leaks() finds bodies that left their cell', () => {
    const [w0, w1] = twoWorlds(), isl = new Islands([w0, w1], { gap: 20 });
    isl.pack();
    const s = snapAt(isl);
    const l1 = isl.local(s, 1);
    expect(l1.count).toBe(5);
    expect(Array.from(l1.pos.slice(0, 9))).toEqual(w1.bodies.flatMap((b) => b.pos));
    expect(isl.leaks(s)).toEqual([]);
    // Island 1's second ball (local 4, global 7) rolls 9 m past its own offset: out of its cell.
    const moved = snapAt(isl, (id, p) => { if (id === 7) p[2] = isl.offsets[1]![2] - 10.5; });
    expect(isl.leaks(moved).map((l) => [l.island, l.local, l.id])).toEqual([[1, 4, 7]]);
    // NaN is a leak too; margin tightens the cell.
    expect(isl.leaks(snapAt(isl, (id, p) => { if (id === 0) p[0] = NaN; }))[0]).toMatchObject({ island: 0, local: 0, id: 0 });
    expect(isl.leaks(s, 9.3).map((l) => l.id)).toContain(7);
    expect(Array.from(isl.tags())).toEqual([0, 0, 1, 1, 1, 1, 0, 1]);
    expect(Array.from(isl.tags(5, 7))).toEqual([1, 0]);
  });

  it('per-island counts are one histogram per question and equal counting each island alone', () => {
    // Four worlds of 1..4 stacked cubes; in world k, the cubes above y = 0.6 are k.
    const ws = [1, 2, 3, 4].map((n) => scene(`t${n}`, Array.from({ length: n }, (_, i) => cube([0, 0.25 + 0.5 * i, 0]))));
    const isl = new Islands(ws, { gap: 10 });
    const high: Pred = { cmp: { comp: 'pos', axis: 1, s: 8 }, op: '>', k: Math.round(0.6 * 256) };
    const spec = islandSpec(4, ['all', high]);
    expect(spec.outputs[0]).toEqual({ op: 'hist', by: { tag: 0, bits: 2, bins: 4 }, where: 'all' });
    expect(islandBits(1)).toBe(1);
    expect(islandBits(64)).toBe(6);
    expect(islandBits(65)).toBe(7);
    const s = snapAt(isl), r = reduceIslands(isl, s, ['all', high]);
    expect(Array.from(r.counts[0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(r.counts[1]!)).toEqual([0, 1, 2, 3]);
    expect(r.invalid).toEqual([0, 0]);
    // Each island alone, through its local snapshot moved back to world coordinates.
    for (let k = 0; k < 4; k++) {
      const l = isl.local(s, k);
      let n = 0;
      for (let i = 0; i < l.count; i++) if (Math.round(l.pos[3 * i + 1]! * 256) > Math.round(0.6 * 256)) n++;
      expect(r.counts[1]![k]).toBe(n);
    }
  });
});
