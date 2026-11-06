// WeaponRuntime (runtime.ts) on the f64 reference engine: a spec'd grenade
// replays bit for bit as Grenades' grenade, for every fuse and reader
// cadence; a firework splits at its apex and its stars burst on landing,
// spawning exactly its static budget, on the same steps at any cadence; and rules
// that spend the munition are released in step order, so nothing acts on a
// removed munition. A split's children are spawned relative to the munition
// (engine-api spawn.ts), so every cadence places them the same, bit for bit.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, freeFlight, type InputEvent, queueInputs, relativeBody, type SceneDesc, type ShapeDesc, type Snapshot, type SpawnEvent, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { DEFAULT_GRENADE, type GrenadeSpec, Grenades, grenadeAsSpec, type GrenadeWorld, splitDirections, validateWeapon, type WeaponSpec, weaponBudget, WeaponRuntime } from '../src/index.ts';

const DT = 1 / 60;
const body = (shape: ShapeDesc, pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ shape, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });
const BOX: ShapeDesc = { kind: 'box', half: [0.5, 0.5, 0.5] };
const BALL: ShapeDesc = { kind: 'sphere', radius: 0.2 };
const scene = (): SceneDesc => ({
  id: 'weapon', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: DT, sleep: false, inputs: [], ground: { y: 0, friction: 0.5 },
  bodies: [body(BOX, [12, 0.5, 0]), body(BOX, [0, 0.5, 40])],
});
const WORLD: GrenadeWorld = { dt: DT, substeps: 1, gravity: [0, -9.81, 0], groundY: 0 };
const LAUNCH = body(BALL, [0, 1.5, 0], [15, 3, 0]);

interface Runner { launch(id: number, step: number, w: never, shape: ShapeDesc): InputEvent[]; observe(s: Snapshot, step: number, shapes: readonly { shape: ShapeDesc }[], idOf?: (e: SpawnEvent) => number): InputEvent[]; readonly pending: number }

/** Fire `shell` at step 0 with `weapon`, observe every `cadence` steps, push what the runner returns; the engine's queue numbers spawns. */
async function run(make: (lookahead: number) => Runner, weapon: unknown, cadence: number, lookahead: number, steps: number, shell = LAUNCH) {
  const sc = scene(), e = new AvbdReferenceEngine();
  await e.init(sc);
  const r = make(lookahead), fired: SpawnEvent = { step: 0, kind: 'spawn', body: shell };
  let queue: InputEvent[] = [];
  const push = (evs: InputEvent[]) => { e.push(evs); queue = queueInputs(queue, evs); };
  push([fired]);
  const events = r.launch(sc.bodies.length, 0, weapon as never, shell.shape);
  push(events);
  const spawns = () => queue.filter((x): x is SpawnEvent => x.kind === 'spawn');
  const idOf = (ev: SpawnEvent) => { const i = spawns().indexOf(ev); if (i < 0) throw new Error('not pushed'); return sc.bodies.length + i; };
  const snaps = [e.snapshot()];
  for (let k = 1; k <= steps; k++) {
    e.step();
    snaps.push(e.snapshot());
    if (k % cadence) continue;
    const shapes = [...sc.bodies, ...spawns().map((x) => x.body)];
    const ev = r.observe(snaps[k]!, e.stepIndex, shapes, idOf);
    for (const x of ev) expect(x.step).toBeGreaterThan(k);
    push(ev);
    events.push(...ev);
  }
  return { events, queue, snaps, pending: r.pending, scene: sc };
}
const grenades = (l: number) => new Grenades(WORLD, l) as unknown as Runner;
const runtime = (l: number) => new WeaponRuntime(WORLD, l) as unknown as Runner;

describe('WeaponRuntime: a spec\'d grenade is the grenade', () => {
  for (const fuse of ['timer', 'prox', 'proxTimer'] as const) {
    it(`${fuse}: the same events and, at every step, the same state, bit for bit, at every reader cadence`, async () => {
      const g: GrenadeSpec = { ...DEFAULT_GRENADE, fuse, delay: 0.25 };
      const spec = grenadeAsSpec(g, { shape: BALL, density: 1, speed: [5, 40] });
      for (const [c, l] of [[1, 1], [4, 4], [5, 8], [3, 0]] as const) {
        const want = await run(grenades, g, c, l, 90), asGrenade = await run(runtime, g, c, l, 90), asSpec = await run(runtime, spec, c, l, 90);
        expect(want.events.filter((x) => x.kind === 'blast')).toHaveLength(1);
        for (const got of [asGrenade, asSpec]) {
          expect(got.queue).toEqual(want.queue);
          expect(got.pending).toBe(0);
          got.snaps.forEach((s, k) => expect(s, `step ${k}`).toEqual(want.snaps[k]));
        }
      }
    });
  }
});

/** Up and over: at the apex 8 stars in a cone round its heading; each bursts and splits into 4 sparks as it lands; sparks fizzle after 1 s. */
const FIREWORK: WeaponSpec = {
  version: 1, name: 'firework',
  shell: { shape: { kind: 'sphere', radius: 0.4 }, density: 4, speed: [20, 35] },
  rules: [{ when: { any: [{ apex: true }, { after: 3 }] }, do: [{ split: { into: 8, child: 'star', pattern: 'cone', angle: 40, spread: 6, at: 0.9 } }] }],
  children: {
    star: {
      shell: { shape: BALL, density: 4 },
      rules: [
        { when: { near: 0.05, arm: 0.2 }, do: [{ blast: { radius: 1.5, impulse: 6 } }, { split: { into: 4, child: 'spark', pattern: 'ring', spread: 3 } }] },
        { when: { after: 4 }, do: [{ remove: true }] },
      ],
      children: { spark: { shell: { shape: { kind: 'sphere', radius: 0.05 }, density: 2 }, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 0.5, impulse: 1, falloff: 2 } }, { remove: true }] }] } },
    },
  },
};
const ROCKET = body({ kind: 'sphere', radius: 0.4 }, [-20, 1, 0], [6, 14, 0]);

describe('WeaponRuntime: a firework', () => {
  it('splits at its apex into stars on a cone round its heading, from its state in the engine there; they burst on landing; everything it spawned is its budget, and spent', { timeout: 60_000 }, async () => {
    const r = await run(runtime, FIREWORK, 1, 1, 330, ROCKET);
    const n = r.scene.bodies.length, kinds = (k: string) => r.queue.filter((x) => x.kind === k).length;
    expect([kinds('spawn'), kinds('blast'), kinds('remove')]).toEqual([1 + 8 + 32, 8 + 32, 1 + 8 + 32]);
    expect(kinds('spawn')).toBe(weaponBudget(FIREWORK).bodies);
    expect(r.pending).toBe(0);
    const end = r.snaps.at(-1)!;
    expect(end.count).toBe(n + 41);
    for (let i = n; i < n + 41; i++) expect(end.tier![i]).toBe(TIER_FREE);
    // The apex: the first step whose state has the rocket's vertical speed <= 0.
    const apex = r.snaps.findIndex((s) => s.linVel[3 * n + 1]! <= 0);
    const split = r.queue.find((x) => x.kind === 'remove' && x.id === n)!;
    expect(split.step).toBe(apex);
    const s = r.snaps[apex]!, V: Vec3 = [s.linVel[3 * n]!, s.linVel[3 * n + 1]!, s.linVel[3 * n + 2]!];
    const parent = { pos: [s.pos[3 * n]!, s.pos[3 * n + 1]!, s.pos[3 * n + 2]!] as Vec3, rot: [0, 0, 0, 1] as [number, number, number, number], linVel: V, angVel: [s.angVel[3 * n]!, s.angVel[3 * n + 1]!, s.angVel[3 * n + 2]!] as Vec3 };
    const stars = r.queue.filter((x): x is SpawnEvent => x.kind === 'spawn').slice(1, 9);
    const axis = V.map((x) => x / Math.hypot(...V)) as Vec3;
    stars.forEach((st, i) => {
      expect(st.step).toBe(apex);
      expect(st.from).toEqual({ body: n, axes: 'heading' });
      // The engine placed it from the rocket's state as the step started, then flew it one step.
      const want = relativeBody(parent, st.body, 'heading'), f = freeFlight(want.pos, want.linVel, [0, -9.81, 0], DT, 1, 1), got = r.snaps[apex + 1]!, id = n + 1 + i;
      const d = splitDirections(8, 'cone', 40, axis)[i]!;
      for (let k = 0; k < 3; k++) {
        expect(got.pos[3 * id + k]).toBeCloseTo(f.pos[k]!, 12);
        expect(got.linVel[3 * id + k]).toBeCloseTo(f.vel[k]!, 12);
        expect(want.pos[k]).toBeCloseTo(parent.pos[k]! + 0.9 * d[k]!, 12);
        expect(want.linVel[k]).toBeCloseTo(V[k]! + 6 * d[k]!, 12);
      }
      expect(d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 12);
    });
    // Stars burst near the ground: each blast's step has its star within 0.05 + radius of y 0.
    for (const b of r.queue.filter((x) => x.kind === 'blast').slice(0, 8)) {
      const id = (b as { blast: { centre: { body: number } } }).blast.centre.body;
      expect(r.snaps[b.step]!.pos[3 * id + 1]!).toBeLessThan(0.2 + 0.05 + 0.5);
    }
  });

  it('the same events at every reader cadence, and the same states bit for bit: children are placed by the engine from the live state', { timeout: 60_000 }, async () => {
    const a = await run(runtime, FIREWORK, 1, 1, 330, ROCKET), b = await run(runtime, FIREWORK, 4, 4, 330, ROCKET);
    expect(b.queue).toEqual(a.queue);
    b.snaps.forEach((s, k) => expect(s, `step ${k}`).toEqual(a.snaps[k]));
  });

  it('a split child must be numbered: observe without idOf refuses once one has spawned', async () => {
    const sc = scene(), e = new AvbdReferenceEngine();
    await e.init(sc);
    const rt = new WeaponRuntime(WORLD, 1);
    const spec: WeaponSpec = { ...FIREWORK, rules: [{ when: { after: 0.1 }, do: [{ split: { into: 2, child: 'star', pattern: 'ring', at: 1 } }] }] };
    e.push([{ step: 0, kind: 'spawn', body: ROCKET }]);
    // A timer's split goes out at launch: the engine will place its children when it is due.
    const now = rt.launch(2, 0, spec, ROCKET.shape);
    expect(now.map((x) => x.kind)).toEqual(['spawn', 'spawn', 'remove']);
    e.push(now);
    let thrown: unknown = null;
    for (let k = 1; k <= 12 && !thrown; k++) {
      e.step();
      try {
        const ev = rt.observe(e.snapshot(), e.stepIndex, [...sc.bodies, ROCKET, { shape: BALL }, { shape: BALL }]);
        e.push(ev);
      } catch (err) { thrown = err; }
    }
    expect(String(thrown)).toMatch(/pass idOf/);
  });
});

describe('WeaponRuntime: momentum-conserving splits', () => {
  it('a conserving fan of 4 children weighing what the shell weighed: total momentum one step on is the shell\'s, plus gravity\'s impulse', async () => {
    // A 0.8 m cube (0.512) into 4 boxes of a quarter of it (0.128).
    const spec: WeaponSpec = {
      version: 1, shell: { shape: { kind: 'box', half: [0.4, 0.4, 0.4] }, density: 1, speed: [5, 40] },
      rules: [{ when: { after: 0.2 }, do: [{ split: { into: 4, child: 'slug', pattern: 'fan', angle: 40, spread: 5, at: 3, conserve: true } }] }],
      children: { slug: { shell: { shape: { kind: 'box', half: [0.2, 0.2, 0.4] }, density: 1 }, rules: [{ when: { after: 2 }, do: [{ remove: true }] }] } },
    };
    expect(validateWeapon(spec).issues).toEqual([]);
    const shell = { ...body(spec.shell.shape, [0, 3, 0], [12, 6, 2]), angVel: [0.5, -2, 1] as Vec3 };
    const r = await run(runtime, spec, 1, 1, 20, shell);
    const n = r.scene.bodies.length, split = r.queue.find((x) => x.kind === 'remove')!.step, M = 0.512, m = 0.128;
    const at = r.snaps[split]!, after = r.snaps[split + 1]!;
    const P = [0, 1, 2].map((k) => M * (at.linVel[3 * n + k]! + DT * -9.81 * (k === 1 ? 1 : 0)));
    const got = [0, 1, 2].map((k) => [1, 2, 3, 4].reduce((a, c) => a + m * after.linVel[3 * (n + c) + k]!, 0));
    const err = Math.hypot(...got.map((g, k) => g - P[k]!)) / Math.hypot(...P);
    expect(err).toBeLessThan(1e-12);
    // And the burst did spread them: the outer two leave 5 x sin 40 deg across the heading, less the mean.
    expect(Math.hypot(after.linVel[3 * (n + 1)]! - after.linVel[3 * (n + 4)]!, after.linVel[3 * (n + 1) + 2]! - after.linVel[3 * (n + 4) + 2]!)).toBeGreaterThan(5);
  });
});

describe('WeaponRuntime: rule order', () => {
  const shell = { shape: BALL, density: 1, speed: [5, 40] as [number, number] };
  it('a timer that removes the munition first drops a later rule\'s blast (it would act on a removed body)', async () => {
    const spec: WeaponSpec = { version: 1, shell, rules: [{ when: { after: 0.5 }, do: [{ blast: { radius: 2, impulse: 5 } }] }, { when: { after: 0.25 }, do: [{ remove: true }] }] };
    const r = await run(runtime, spec, 1, 1, 60);
    expect(r.queue.slice(1)).toEqual([{ step: 15, kind: 'remove', id: 2 }]);
    expect(r.pending).toBe(0);
  });

  it('a timer waits while a proximity rule that spends the munition could still come first, and goes off when it does not', async () => {
    const near = { near: 0.75 } as const, blast = { radius: 2, impulse: 5 };
    // Thrown at the cube: proximity first (as the grenade's fuse); the 3 s timer never goes out.
    const spec: WeaponSpec = { version: 1, shell, rules: [{ when: { after: 3 }, do: [{ remove: true }] }, { when: near, do: [{ blast }, { remove: true }] }] };
    const hit = await run(runtime, spec, 1, 1, 60);
    const g = await run(grenades, { ...DEFAULT_GRENADE, arm: 0, blast: { ...DEFAULT_GRENADE.blast, radius: 2, impulse: 5, falloff: 1, core: 0 } }, 1, 1, 60);
    const step = g.queue.find((x) => x.kind === 'remove')!.step;
    expect(hit.queue.slice(1).map((x) => [x.kind, x.step])).toEqual([['blast', step], ['remove', step]]);
    // Thrown straight up with the ground not sensed: nothing near, so the timer goes out, once the reader sees it is due.
    const up = await run(runtime, { ...spec, rules: [spec.rules[0]!, { when: { near: 0.75, ground: false }, do: [{ remove: true }] }] }, 1, 1, 200, body(BALL, [0, 30, -20], [0, 5, 0]));
    expect(up.queue.slice(1)).toEqual([{ step: 180, kind: 'remove', id: 2 }]);
  });
});
