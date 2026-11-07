// Charges (docs/design/charges.md): WeaponSpecs riding a host body, with the moved trigger and the
// removeTarget action, on the f64 reference engine and on Rapier. The same scene on both: a cutter
// on cube A (blast at its +x face, then A removed) knocks cube C, whose sympathetic charge (moved)
// removes C; B, which stood on A, falls. Checked on each engine: events released just in time (each
// returned by the observation one step before it is due, never sooner), moved firing at the step
// after the first observed state that shows it (recomputed here from the snapshots), removeTarget
// taking its host out (tier free), charges at rest sending the engine nothing, and dead hosts
// dropping their charges. The GPU runs the same verbs through Keystone's cast page
// (keystone-lab charges-gpu.test.ts).
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type BodyDesc, type InputEvent, type PhysicsEngine, type SceneDesc, type Snapshot, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { DETONATOR, type GrenadeWorld, type WeaponSpec, WeaponRuntime, WeaponSpecError } from '../src/index.ts';

const DT = 1 / 60;
const WORLD: GrenadeWorld = { dt: DT, substeps: 1, gravity: [0, -9.81, 0], groundY: 0 };
const cube = (pos: Vec3, rot: [number, number, number, number] = [0, 0, 0, 1]): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0,
});
/** A (0) on the ground, B (1) on A, C (2) 2.5 to A's +x, D (3) far away; sleep on, as Keystone levels play. */
const scene = (): SceneDesc => ({
  id: 'charges', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: DT, sleep: true, inputs: [], ground: { y: 0, friction: 0.5 },
  bodies: [cube([0, 0.5, 0]), cube([0, 1.5, 0]), cube([2.5, 0.5, 0]), cube([20, 0.5, 0])],
});
const A = 0, B = 1, C = 2, D = 3;
const SHELL = { shape: { kind: 'box' as const, half: [0.1, 0.1, 0.1] as Vec3 }, density: 1, speed: [0, 0] as [number, number] };
/** Goes off `after` s after it is armed: a blast at its point, then its host out. */
const cutter = (after: number): WeaponSpec => ({ version: 1, shell: SHELL, rules: [{ when: { after }, do: [{ blast: { radius: 3, impulse: 6, core: 0.2 } }, { removeTarget: true }] }] });
/** Fires once its host is 5 cm from where it was armed: its host out. */
const SYMPATHETIC: WeaponSpec = { version: 1, shell: SHELL, rules: [{ when: { moved: 0.05 }, do: [{ removeTarget: true }] }] };

type Make = () => PhysicsEngine;
const ENGINES: [string, Make][] = [['reference', () => new AvbdReferenceEngine()], ['rapier', () => new RapierEngine()]];

/**
 * Serial reader: rest `rest` steps, attach with `setup` (given the runtime, the state and its step, the
 * floor being that step), then step `steps` times observing each state; everything the runtime returns
 * is pushed. Returns every snapshot (index = steps taken) and every event with the step it was returned at.
 */
async function play(make: Make, setup: (r: WeaponRuntime, s: Snapshot, step: number) => InputEvent[], steps: number, rest = 30) {
  const e = make(), sc = scene();
  await e.init(sc);
  for (let i = 0; i < rest; i++) await e.step();
  const r = new WeaponRuntime(WORLD, 1), snaps: Snapshot[] = [];
  for (let i = 0; i < rest; i++) snaps.push(null as unknown as Snapshot);
  snaps.push(await e.snapshot());
  const got: { at: number; e: InputEvent }[] = [];
  const first = setup(r, snaps[rest]!, rest);
  for (const x of first) { expect(x.step).toBeGreaterThanOrEqual(rest); got.push({ at: rest, e: x }); }
  e.push(first);
  for (let k = rest + 1; k <= rest + steps; k++) {
    await e.step();
    const s = await e.snapshot();
    snaps.push(s);
    const ev = r.observe(s, k, sc.bodies);
    for (const x of ev) { expect(x.step).toBe(k + 1); got.push({ at: k, e: x }); }
    e.push(ev);
  }
  e.dispose();
  return { snaps, got, runtime: r };
}

const posOf = (s: Snapshot, i: number): Vec3 => [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('charges: validation', () => {
  it('a thrown weapon cannot removeTarget, and a charge cannot near, apex or split', () => {
    const r = new WeaponRuntime(WORLD, 1);
    expect(() => r.launch(9, 0, { ...cutter(0), shell: { ...SHELL, speed: [1, 2] } }, SHELL.shape)).toThrow(WeaponSpecError);
    expect(() => r.launch(9, 0, { ...cutter(0), shell: { ...SHELL, speed: [1, 2] } }, SHELL.shape)).toThrow(/target/);
    const near: WeaponSpec = { version: 1, shell: SHELL, rules: [{ when: { any: [{ after: 1 }, { near: 0.1 }] }, do: [{ remove: true }] }] };
    expect(() => r.attach(0, 0, near)).toThrow(/near/);
    const apex: WeaponSpec = { version: 1, shell: SHELL, rules: [{ when: { then: [{ apex: true }, { after: 1 }] }, do: [{ remove: true }] }] };
    expect(() => r.attach(0, 0, apex)).toThrow(/apex/);
    const split: WeaponSpec = {
      version: 1, shell: SHELL, rules: [{ when: { after: 1 }, do: [{ split: { into: 2, child: 'b', pattern: 'ring', at: 1 } }] }],
      children: { b: { shell: SHELL, rules: [{ when: { after: 1 }, do: [{ remove: true }] }] } },
    };
    expect(() => r.attach(0, 0, split)).toThrow(/split/);
    expect(r.pending).toBe(0);
  });
});

for (const [name, make] of ENGINES) {
  describe(`charges on ${name}`, () => {
    it('a cutter goes off at once when armed with delay 0, its events at the floor step', async () => {
      const { got, snaps } = await play(make, (r, s, step) => r.attach(A, step, cutter(0), [0.5, 0, 0], { s, step, floor: step }), 60);
      expect(got.map((g) => [g.at, g.e.step, g.e.kind])).toEqual([[30, 30, 'blast'], [30, 30, 'remove']]);
      const blast = got[0]!.e;
      if (blast.kind !== 'blast') throw new Error('unreachable');
      // Not excluding its host, centred on it at its +x face (the host is unturned).
      const c = blast.blast.centre as { body: number; offset: Vec3 };
      expect(c.body).toBe(A);
      [0.5, 0, 0].forEach((x, i) => expect(c.offset[i]).toBeCloseTo(x, 5));
      expect(blast.blast.exclude).toBeUndefined();
      const end = snaps.at(-1)!;
      expect(end.tier![A]).toBe(TIER_FREE);
      // B was thrown off where A held it; C was pushed away along +x.
      expect(dist(posOf(end, B), [0, 1.5, 0])).toBeGreaterThan(0.3);
      expect(end.pos[3 * C]!).toBeGreaterThan(2.6);
    });

    it('a timed charge is released by the observation one step before it is due, never sooner', async () => {
      const { got } = await play(make, (r, s, step) => r.attach(A, step + 10, cutter(0.25), [0, 0, 0], { s, step, floor: step }), 60);
      // Armed 10 steps on, 15 steps (0.25 s) of fuse: due at 30 + 25.
      expect(got.map((g) => [g.at, g.e.step, g.e.kind])).toEqual([[54, 55, 'blast'], [54, 55, 'remove']]);
      const blast = got[0]!.e;
      if (blast.kind !== 'blast') throw new Error('unreachable');
      expect(blast.blast.centre).toEqual({ body: A });
    });

    it('moved fires at the step after the first state that shows it, and removeTarget takes its host out', async () => {
      const { got, snaps, runtime } = await play(make, (r, s, step) => [
        ...r.attach(C, step, SYMPATHETIC, [0, 0, 0], { s, step, floor: step }),
        ...r.attach(A, step + 20, cutter(0), [0.5, 0, 0], { s, step, floor: step }),
      ], 90);
      // Its reference: C in the first state observed once armed (the state it was armed in).
      const ref = posOf(snaps[30]!, C);
      let first = -1;
      for (let k = 31; k < snaps.length; k++) if (dist(posOf(snaps[k]!, C), ref) >= 0.05) { first = k; break; }
      expect(first).toBeGreaterThan(50);
      const sym = got.filter((g) => g.e.kind === 'remove' && g.e.id === C);
      expect(sym.map((g) => [g.at, g.e.step])).toEqual([[first, first + 1]]);
      expect(snaps.at(-1)!.tier![C]).toBe(TIER_FREE);
      expect(runtime.pending).toBe(0);
    });

    it('watch: a charge reads another body (Fuse & Fold fuses): D goes when C, which it watches, moves; C stays', async () => {
      const { got, snaps, runtime } = await play(make, (r, s, step) => [
        ...r.attach(D, step, SYMPATHETIC, [0, 0, 0], { s, step, floor: step }, C),
        ...r.attach(A, step + 20, cutter(0), [0.5, 0, 0], { s, step, floor: step }),
      ], 90);
      // The watched body's reference: C in the state it was armed in; D's own motion plays no part (it has none).
      const ref = posOf(snaps[30]!, C);
      let first = -1;
      for (let k = 31; k < snaps.length; k++) if (dist(posOf(snaps[k]!, C), ref) >= 0.05) { first = k; break; }
      expect(first).toBeGreaterThan(50);
      expect(dist(posOf(snaps[first]!, D), posOf(snaps[30]!, D))).toBeLessThan(1e-3);
      expect(got.filter((g) => g.e.kind === 'remove' && g.e.id === D).map((g) => [g.at, g.e.step])).toEqual([[first, first + 1]]);
      expect(got.some((g) => g.e.kind === 'remove' && g.e.id === C)).toBe(false);
      expect(snaps.at(-1)!.tier![D]).toBe(TIER_FREE);
      expect(snaps.at(-1)!.tier![C]).not.toBe(TIER_FREE);
      expect(runtime.pending).toBe(0);
    });

    it('a detonator (moved, or stand down after its wait) holds a shot while its timer runs, and a dead fuse sends nothing', async () => {
      // DETONATOR's rules with a 0.5 s wait: nothing near D moves, so it never fires and stands down at 30 + 30.
      const det: WeaponSpec = { ...DETONATOR, shell: SHELL, rules: [DETONATOR.rules[0]!, { when: { after: 0.5 }, do: [{ remove: true }] }] };
      let waiting = -1;
      const { got, runtime } = await play(make, (r, s, step) => { const out = r.attach(B, step, det, [0, 0, 0], { s, step, floor: step }, D); waiting = r.waiting; return out; }, 60);
      expect(waiting).toBe(1);
      expect(got).toEqual([]);
      expect(runtime.pending).toBe(0);
      expect(runtime.waiting).toBe(0);
    });

    it('speed: a charge watching speed fires on the first state moving that fast, before it has moved far', async () => {
      const watch: WeaponSpec = { version: 1, shell: SHELL, rules: [{ when: { moved: 5, speed: 0.5 }, do: [{ removeTarget: true }] }] };
      const { got, snaps } = await play(make, (r, s, step) => [...r.attach(C, step, watch), ...r.attach(A, step + 5, cutter(0), [0.5, 0, 0], { s, step, floor: step })], 40);
      let first = -1;
      for (let k = 31; k < snaps.length; k++) {
        const v = snaps[k]!.linVel;
        if (Math.hypot(v[3 * C]!, v[3 * C + 1]!, v[3 * C + 2]!) >= 0.5) { first = k; break; }
      }
      expect(first).toBeGreaterThan(30);
      expect(got.filter((g) => g.e.kind === 'remove' && g.e.id === C).map((g) => g.e.step)).toEqual([first + 1]);
    });

    it('charges at rest send nothing: the run is the run without them, state for state', async () => {
      const watchers = (r: WeaponRuntime, _s: Snapshot, step: number) => [
        ...r.attach(A, step, SYMPATHETIC), ...r.attach(B, step, SYMPATHETIC), ...r.attach(C, step, SYMPATHETIC),
        // A mine: settles 0.5 s, then watches; it never holds a shot open once watching.
        ...r.attach(D, step, { version: 1, shell: SHELL, rules: [{ when: { then: [{ after: 0.5 }, { moved: 0.01 }] }, do: [{ blast: { radius: 2, impulse: 5 } }] }] }),
      ];
      const withCharges = await play(make, watchers, 120), without = await play(make, () => [], 120);
      expect(withCharges.got).toEqual([]);
      for (let k = 30; k < without.snaps.length; k++) {
        const a = withCharges.snaps[k]!, b = without.snaps[k]!;
        expect([...a.pos]).toEqual([...b.pos]);
        expect([...a.awake]).toEqual([...b.awake]);
      }
      expect(withCharges.runtime.pending).toBe(4);
      expect(withCharges.runtime.waiting).toBe(0);
    });

    it('a charge rides its host: dropped with it, or once the host shows as removed', async () => {
      const { got, runtime } = await play(make, (r, s, step) => {
        r.attach(B, step + 40, cutter(0));
        const out = r.attach(A, step, cutter(0), [0, 0, 0], { s, step, floor: step });
        // B's charge is still waiting on its timer: it holds a shot open.
        expect(r.waiting).toBe(1);
        expect(r.drop(B)).toBe(1);
        r.attach(A, step + 30, cutter(0));
        return out;
      }, 60);
      // A was removed at once; its second charge (due at 60) saw the tombstone and went with it.
      expect(got.map((g) => g.e.step)).toEqual([30, 30]);
      expect(runtime.pending).toBe(0);
    });
  });
}

describe('charges: the blast point turns with its host', () => {
  it('a charge on a host turned a quarter about y blasts from where its point now is', async () => {
    const e = new AvbdReferenceEngine(), sc = scene(), s2 = Math.SQRT1_2;
    sc.bodies[A] = cube([0, 0.5, 0], [0, s2, 0, s2]);
    sc.sleep = false;
    await e.init(sc);
    const r = new WeaponRuntime(WORLD, 1), s = e.snapshot();
    const [blast] = r.attach(A, 0, cutter(0), [0.5, 0, 0], { s, step: 0, floor: 0 });
    if (blast?.kind !== 'blast') throw new Error('want a blast');
    const c = blast.blast.centre as { body: number; offset: Vec3 };
    expect(c.body).toBe(A);
    // +x in the host's frame is -z in the world after a quarter turn about +y.
    expect(c.offset[0]).toBeCloseTo(0, 12);
    expect(c.offset[1]).toBeCloseTo(0, 12);
    expect(c.offset[2]).toBeCloseTo(-0.5, 12);
  });
});
