// C10, many worlds in one solve, on the f64 reference (engine-api islands.ts).
//
// Islands share the solve, so a world in an islands run is not bit for bit its
// solo run: the colouring's priority is a hash of the GLOBAL body index
// (coloring.ts), so the order bodies in contact are swept in changes with the
// island's place in the body list (a struck 36-cube block: island 0 matched its
// solo run exactly, islands 1 to 3 ended 1 to 35 cm apart after 150 steps;
// docs/design/islands.md). Where no two bodies touch, the order cannot matter,
// so there every world must match its solo run (solo(k), at its island's
// position) bit for bit. That pins the whole id map: spawned bodies' ids, a
// blast centred on a spawned body with it excluded, the removal of that body,
// a push during play, and per-island counts from the observer.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type InputEvent, IslandObserver, Islands, type Pred, type SceneDesc, type Snapshot, type Vec3, withSnapshotObserver } from '@tb/engine-api';
import { AvbdReferenceEngine } from '../src/index.ts';

const cube = (pos: Vec3): BodyDesc => ({ shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1000, friction: 0.6, restitution: 0, tag: 0 });
const ball = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ shape: { kind: 'sphere', radius: 0.1 }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 7800, friction: 0.4, restitution: 0, tag: -1 });

/** World k: four cubes 1.5 m apart dropped from k-dependent heights; a ball dropped between the middle two at step 10, a blast on it at 40 that spares it, its removal at 41. */
function world(k: number): SceneDesc {
  const bodies = [-2.25, -0.75, 0.75, 2.25].map((x, i) => cube([x, 0.25 + 0.05 * ((k + i) % 3), 0.1 * k]));
  const inputs: InputEvent[] = [
    { step: 10, kind: 'spawn', body: ball([0, 2, 0.1 * k]) },
    { step: 40, kind: 'blast', blast: { centre: { body: 4, offset: [0, -0.2, 0] }, radius: 1.4, impulse: 1000 + 200 * k, exclude: [4] } },
    { step: 41, kind: 'remove', id: 4 },
  ];
  return { id: `iso${k}`, params: {}, seed: 1, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: false, bodies, inputs };
}

const STEPS = 90;
/** Bodies above 0.3 m (mid-air or toppled onto an edge), and moving faster than 0.5 m/s. */
const PREDS: Pred[] = [
  { cmp: { comp: 'pos', axis: 1, s: 10 }, op: '>', k: Math.round(0.3 * 1024) },
  { cmp: { norm2: 'linVel', s: 10 }, op: '>', k: Math.round((0.5 * 1024) ** 2) },
];

async function soloRun(scene: SceneDesc, steps = STEPS): Promise<Snapshot> {
  const e = new AvbdReferenceEngine();
  await e.init(scene);
  for (let i = 0; i < steps; i++) e.step();
  return e.snapshot();
}

describe('AVBD reference: islands', () => {
  it('with no body-body contact every island matches its solo run bit for bit, and per-island counts match each world counted alone', async () => {
    const K = 4, isl = new Islands(Array.from({ length: K }, (_, k) => world(k)), { gap: 24 });
    const e = withSnapshotObserver(new AvbdReferenceEngine());
    await e.init(isl.scene);
    const obs = new IslandObserver(await e.observe({ tagWords: 1 }), isl);
    obs.query(PREDS);
    for (let i = 0; i < STEPS; i++) {
      // During play, island 2 rolls a second ball past its cubes at step 50 (pushed at 45, released when due).
      if (i === 45) isl.push(2, [{ step: 50, kind: 'spawn', body: ball([-4, 0.5, 2], [3, 0, 0]) }]);
      e.push(isl.due(e.stepIndex));
      obs.sync();
      await e.step();
    }
    const s = await e.snapshot(), counts = await obs.result(STEPS);
    expect(isl.count).toBe(4 * K + K + 1);
    // The second ball is island 2's local body 5 and the last global id.
    expect([isl.islandOf(isl.count - 1), isl.localOf(isl.count - 1)]).toEqual([2, 5]);
    expect(isl.leaks(s)).toEqual([]);
    for (let k = 0; k < K; k++) {
      const solo = isl.solo(k), far = await soloRun(solo), ids = isl.idsOf(k);
      expect(far.count, `island ${k}`).toBe(ids.length);
      for (const [f, g] of ids.entries()) {
        expect(Array.from(s.pos.slice(3 * g, 3 * g + 3)), `island ${k} body ${f} pos`).toEqual(Array.from(far.pos.slice(3 * f, 3 * f + 3)));
        expect(Array.from(s.rot.slice(4 * g, 4 * g + 4)), `island ${k} body ${f} rot`).toEqual(Array.from(far.rot.slice(4 * f, 4 * f + 4)));
        expect(s.tier?.[g] ?? 0, `island ${k} body ${f} tier`).toBe(far.tier?.[f] ?? 0);
      }
      // The blast pushed the inner cubes (its impulse grows with k) and not the outer ones, the ball was removed, and the counts are this world's.
      const local = isl.local(s, k);
      expect(Math.abs(local.pos[3]!) - 0.75, `island ${k} inner cube pushed out`).toBeGreaterThan(0.05);
      expect(Math.abs(local.pos[0]!) - 2.25, `island ${k} outer cube out of reach`).toBeLessThan(1e-3);
      const high = Array.from({ length: far.count }, (_, i) => Math.round(Math.fround(far.pos[3 * i + 1]!) * 1024) > Math.round(0.3 * 1024)).filter(Boolean).length;
      expect(counts.counts[0]![k], `island ${k} high`).toBe(high);
    }
    expect(counts.invalid).toEqual([0, 0]);
  }, 120_000);

  it('world-wide field events (pushField): a tilt and a kick shake identical worlds alike, a same-step spawn is kicked in none, solo(k) matches', async () => {
    // Two identical worlds: cubes on the ground, a tilt from step 5, a kick at step 20 and a ball spawned at step 20 in each.
    const w = (): SceneDesc => ({ ...world(0), id: 'field', bodies: [cube([-1.5, 0.25, 0]), cube([1.5, 0.25, 0])], inputs: [{ step: 20, kind: 'spawn', body: ball([0, 1, 0]) }] });
    const isl = new Islands([w(), w()], { gap: 24 });
    isl.pushField([{ step: 5, kind: 'field', gravity: [2, -9.5, 0] }, { step: 20, kind: 'field', kick: [0, 1, 0.5] }]);
    const e = new AvbdReferenceEngine();
    await e.init(isl.scene);
    for (let i = 0; i < 40; i++) { e.push(isl.due(e.stepIndex)); e.step(); }
    const s = e.snapshot(), a = isl.local(s, 0), b = isl.local(s, 1);
    // The same up to the rounding of island 1's 24 m offset (AVBD reads velocities off positions, so both carry it;
    // f64 ulps at 24 m are 4e-15 m): every island shook alike. Bit for bit is solo(k)'s check, at the same coordinates.
    a.pos.forEach((x, i) => expect(Math.abs(b.pos[i]! - x), `pos ${i}`).toBeLessThan(1e-9));
    a.linVel.forEach((x, i) => expect(Math.abs(b.linVel[i]! - x), `linVel ${i}`).toBeLessThan(1e-7));
    // The tilt pushed the cubes along +x; the ball spawned at the kick's step was not kicked (it fell straight, z velocity 0, as did nothing on z).
    expect(a.pos[0]!).toBeGreaterThan(-1.5 + 0.01);
    expect(a.linVel[3 * 2 + 2]).toBe(0);
    for (const k of [0, 1]) {
      const far = await soloRun({ ...isl.solo(k) }, 40), ids = isl.idsOf(k);
      for (const [f, g] of ids.entries()) expect(Array.from(s.pos.slice(3 * g, 3 * g + 3)), `island ${k} body ${f}`).toEqual(Array.from(far.pos.slice(3 * f, 3 * f + 3)));
    }
  }, 60_000);
});
