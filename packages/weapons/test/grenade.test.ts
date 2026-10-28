// Grenades (grenade.ts) on the f64 reference engine: when each fuse sets the
// blast off, and that a reader observing every few steps with enough
// lookahead detonates at the same step, bit for bit, as one observing every step.
import { describe, expect, it } from 'vitest';
import { type BlastEvent, type BodyDesc, freeFlight, type SceneDesc, type ShapeDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { checkGrenade, DEFAULT_GRENADE, type GrenadeSpec, Grenades, type GrenadeWorld, surfaceDistance } from '../src/index.ts';

const DT = 1 / 60;
const body = (shape: ShapeDesc, pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ shape, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });
const BOX: ShapeDesc = { kind: 'box', half: [0.5, 0.5, 0.5] };
const BALL: ShapeDesc = { kind: 'sphere', radius: 0.2 };
/** A cube resting on the ground 12 m down range, and one far off to the side. */
const scene = (ground = true): SceneDesc => ({
  id: 'grenade', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: DT, sleep: false, inputs: [],
  ground: ground ? { y: 0, friction: 0.5 } : null,
  bodies: [body(BOX, [12, 0.5, 0]), body(BOX, [0, 0.5, 40])],
});
const world = (ground = true): GrenadeWorld => ({ dt: DT, substeps: 1, gravity: [0, -9.81, 0], groundY: ground ? 0 : null });
const LAUNCH = body(BALL, [0, 1.5, 0], [15, 3, 0]);
const spec = (g: Partial<GrenadeSpec> = {}): GrenadeSpec => ({ ...DEFAULT_GRENADE, ...g });

interface Run { blasts: BlastEvent[]; snaps: Snapshot[]; pending: number }

/** Fire `grenade` at step 0, observe the state every `cadence` steps, push what Grenades returns. */
async function run(g: GrenadeSpec, cadence: number, lookahead: number, steps: number, opts: { grenade?: BodyDesc; ground?: boolean } = {}): Promise<Run> {
  const sc = scene(opts.ground ?? true), grenade = opts.grenade ?? LAUNCH, id = sc.bodies.length;
  const e = new AvbdReferenceEngine();
  await e.init(sc);
  const grenades = new Grenades(world(opts.ground ?? true), lookahead);
  const blasts = grenades.launch(id, 0, g, grenade.shape);
  e.push([{ step: 0, kind: 'spawn', body: grenade }, ...blasts]);
  const shapes = [...sc.bodies, grenade], snaps = [e.snapshot()];
  for (let k = 1; k <= steps; k++) {
    e.step();
    snaps.push(e.snapshot());
    if (k % cadence) continue;
    const ev = grenades.observe(snaps[k]!, e.stepIndex, shapes);
    for (const b of ev) expect(b.step).toBeGreaterThan(k);
    e.push(ev);
    blasts.push(...ev);
  }
  return { blasts, snaps, pending: grenades.pending };
}

/** The first step at which the free-flying grenade is within prox of the target cube's surface (or the ground), from the scene alone. */
function predicted(prox: number, from = 0, launch = LAUNCH, ground = true): number {
  const r = (launch.shape as { radius: number }).radius;
  const still = { count: 1, pos: Float64Array.from([12, 0.5, 0]), rot: Float64Array.from([0, 0, 0, 1]) } as Snapshot;
  for (let j = from; j < 600; j++) {
    const p = freeFlight(launch.pos, launch.linVel, [0, -9.81, 0], DT, 1, j).pos;
    const gap = Math.min(surfaceDistance(BOX, still, 0, p), ground ? p[1] : Infinity) - r;
    if (gap <= prox) return j;
  }
  throw new Error('never');
}

describe('grenades', () => {
  it('a timer fuse is known at launch: its blast is due delay s after the spawn, centred on the grenade', async () => {
    const r = await run(spec({ fuse: 'timer', delay: 0.5 }), 1, 1, 40);
    expect(r.blasts).toEqual([{ step: 30, kind: 'blast', blast: { centre: { body: 2 }, exclude: [2], ...DEFAULT_GRENADE.blast } }]);
    expect(r.pending).toBe(0);
  });

  it('a proximity fuse goes off at the first step within prox of the target, whatever the reader cadence (given lookahead)', async () => {
    const j = predicted(DEFAULT_GRENADE.prox);
    expect(j).toBeGreaterThan(20); // a real flight, not set off at launch
    const runs = await Promise.all([[1, 1], [4, 4], [5, 8], [3, 3]].map(([c, l]) => run(spec(), c!, l!, j + 30)));
    for (const r of runs) {
      expect(r.blasts.map((b) => b.step)).toEqual([j]);
      expect(r.pending).toBe(0);
      expect(r.snaps.at(-1)).toEqual(runs[0]!.snaps.at(-1));
    }
    // The blast threw the target cube away from the grenade, hard (DEFAULT_GRENADE is meant to be special).
    const v = runs[0]!.snaps[j + 1]!.linVel;
    expect(v[0]).toBeGreaterThan(10);
  });

  it('without lookahead a reader observing every step goes off one step late; a sparse one late by up to its gap', async () => {
    const j = predicted(DEFAULT_GRENADE.prox);
    expect((await run(spec(), 1, 0, j + 5)).blasts.map((b) => b.step)).toEqual([j + 1]);
    const sparse = (await run(spec(), 4, 0, j + 8)).blasts[0]!.step;
    expect(sparse).toBeGreaterThan(j);
    expect(sparse).toBeLessThanOrEqual(j + 4);
  });

  it('proxTimer: delay s after proximity is reached', async () => {
    const j = predicted(DEFAULT_GRENADE.prox);
    const r = await run(spec({ fuse: 'proxTimer', delay: 0.25 }), 2, 2, j + 30);
    expect(r.blasts.map((b) => b.step)).toEqual([j + 15]);
  });

  it('a larger prox goes off sooner', async () => {
    const near = predicted(0.25), far = predicted(1); // the grenade starts 1.3 m above the ground
    expect(far).toBeLessThan(near);
    expect((await run(spec({ prox: 1 }), 1, 1, far + 2)).blasts.map((b) => b.step)).toEqual([far]);
    expect((await run(spec({ prox: 0.25 }), 1, 1, near + 2)).blasts.map((b) => b.step)).toEqual([near]);
  });

  it('arm: a grenade launched next to the cube waits until it is armed', async () => {
    const close = body(BALL, [11.2, 0.5, 0]); // 0.1 m from the cube's face
    expect((await run(spec({ arm: 0 }), 1, 1, 5, { grenade: close })).blasts.map((b) => b.step)).toEqual([2]);
    expect((await run(spec({ arm: 0.5 }), 1, 1, 40, { grenade: close })).blasts.map((b) => b.step)).toEqual([30]);
  });

  it('the ground counts as a surface unless ground is off; with nothing near, the fuse keeps waiting', async () => {
    const lob = body(BALL, [-20, 6, 0], [0, 0, 0]); // straight down, far from both cubes
    const j = predicted(0.5, 0, lob);
    expect((await run(spec({ prox: 0.5 }), 1, 1, j + 2, { grenade: lob })).blasts.map((b) => b.step)).toEqual([j]);
    const none = await run(spec({ prox: 0.5, ground: false }), 1, 1, 90, { grenade: lob, ground: false });
    expect(none.blasts).toEqual([]);
    expect(none.pending).toBe(1);
  });

  it('surface distance: spheres, rotated boxes, zero inside', () => {
    const s = { count: 1, pos: Float64Array.from([1, 2, 3]), rot: Float64Array.from([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]) } as Snapshot;
    // A unit cube turned 45 degrees about y: its vertical edge points along +x, sqrt(2)/2 from the centre.
    expect(surfaceDistance(BOX, s, 0, [3, 2, 3])).toBeCloseTo(2 - Math.SQRT1_2, 12);
    expect(surfaceDistance(BOX, s, 0, [1, 4, 3])).toBeCloseTo(1.5, 12);
    expect(surfaceDistance(BOX, s, 0, [1.2, 2.1, 3])).toBe(0);
    expect(surfaceDistance({ kind: 'sphere', radius: 1 }, s, 0, [1, 2, 6])).toBe(2);
    expect(surfaceDistance({ kind: 'sphere', radius: 1 }, s, 0, [1, 2, 3.5])).toBe(0);
  });

  it('refuses specs and worlds no grenade should have', () => {
    expect(checkGrenade(DEFAULT_GRENADE)).toBe(DEFAULT_GRENADE);
    expect(() => checkGrenade(spec({ fuse: 'sticky' as never }))).toThrow(/fuse/);
    expect(() => checkGrenade(spec({ prox: -1 }))).toThrow(/prox/);
    expect(() => checkGrenade(spec({ delay: NaN }))).toThrow(/delay/);
    expect(() => checkGrenade(spec({ blast: { ...DEFAULT_GRENADE.blast, falloff: 1.5 } }))).toThrow(/falloff/);
    expect(() => checkGrenade(spec({ blast: { ...DEFAULT_GRENADE.blast, radius: 0 } }))).toThrow(/radius/);
    expect(() => new Grenades(world(), -1)).toThrow(/lookahead/);
    expect(() => new Grenades({ ...world(), substeps: 0 })).toThrow(/world/);
  });
});
