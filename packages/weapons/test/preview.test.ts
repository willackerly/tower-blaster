// previewWeapon (preview.ts) against a real firing on the f64 reference
// engine (C12's verify: "arc preview matches the fired path"): every munition
// the engine spawns has a track, on the same steps; while a munition flies
// free its track is the engine's path to 1e-9; every split and blast is on
// the engine's step, and centred where the engine has the munition then. After
// a munition first touches something the preview holds it still, an
// approximation: there only its blasts' steps must agree, and their centres
// to within a step's travel.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type InputEvent, queueInputs, type SceneDesc, type ShapeDesc, type Snapshot, type SpawnEvent, type Vec3 } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { CLUSTER, DEFAULT_GRENADE, FIREWORK, GRENADE_M, grenadeAsSpec, type GrenadeWorld, previewWeapon, type PreviewLaunch, weaponBudget, type WeaponSpec, WeaponRuntime } from '../src/index.ts';

const DT = 1 / 60;
const WORLD: GrenadeWorld = { dt: DT, substeps: 1, gravity: [0, -9.81, 0], groundY: 0 };
const BALL: ShapeDesc = { kind: 'sphere', radius: 0.2 };
const box = (pos: Vec3): BodyDesc => ({ shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });

/** Fires `spec` as `launch` on the reference engine over `bodies` (none: the ground only), reading every step as the viewer does; every body's position at every step. */
async function fire(spec: WeaponSpec, launch: PreviewLaunch, steps: number, bodies: BodyDesc[] = []) {
  const sc: SceneDesc = { id: 'preview', params: {}, seed: 0, gravity: WORLD.gravity, dt: DT, sleep: false, inputs: [], ground: { y: 0, friction: 0.5 }, bodies };
  const e = new AvbdReferenceEngine();
  await e.init(sc);
  expect(e.info.integrator?.substeps ?? 1).toBe(WORLD.substeps);
  const shell: BodyDesc = { shape: launch.shape, pos: launch.pos, rot: [0, 0, 0, 1], linVel: launch.vel, angVel: [0, 0, 0], density: launch.density, friction: 0.5, restitution: 0, tag: 0 };
  const rt = new WeaponRuntime(WORLD, 1);
  let queue: InputEvent[] = [];
  const all: InputEvent[] = [];
  const push = (evs: InputEvent[]) => { e.push(evs); queue = queueInputs(queue, evs); all.push(...evs); };
  push([{ step: 0, kind: 'spawn', body: shell }]);
  push(rt.launch(bodies.length, 0, spec, shell.shape));
  const spawns = () => queue.filter((x): x is SpawnEvent => x.kind === 'spawn');
  const idOf = (ev: SpawnEvent) => bodies.length + spawns().indexOf(ev);
  const snaps: Snapshot[] = [e.snapshot()];
  for (let k = 1; k <= steps; k++) {
    e.step();
    const s = e.snapshot();
    snaps.push(s);
    push(rt.observe(s, k, [...bodies, ...spawns().map((x) => x.body)], idOf));
  }
  return { snaps, events: all, spawns: spawns() };
}

const near = (a: readonly number[], b: readonly number[], tol: number) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) <= tol;
const at = (s: Snapshot, id: number): Vec3 => [s.pos[3 * id]!, s.pos[3 * id + 1]!, s.pos[3 * id + 2]!];

/**
 * The preview and the firing agree (header); returns how many blasts were checked exactly. With
 * obstacles, only up to the first blast: from there the engine moves them and the preview does not.
 */
async function agree(spec: WeaponSpec, launch: PreviewLaunch, steps: number, bodies: BodyDesc[] = []) {
  const shot = await fire(spec, launch, steps, bodies);
  const pre = previewWeapon(spec, launch, WORLD, { steps, obstacles: bodies.length ? { s: shot.snaps[0]!, shapes: bodies } : undefined });
  const n0 = bodies.length;
  const fired = shot.events.filter((x) => x.kind === 'blast');
  const until = bodies.length && fired.length ? fired[0]!.step : Infinity;
  // One track per spawn, in the engine's id order, from the same step.
  expect(pre.tracks.map((t) => t.start)).toEqual(shot.spawns.map((x) => x.step));
  expect(pre.tracks.length).toBe(weaponBudget(spec).bodies);
  let exact = 0;
  pre.tracks.forEach((t, k) => {
    const id = n0 + k;
    // Removal: on the engine's step.
    const gone = shot.events.find((x) => x.kind === 'remove' && x.id === id);
    const end = t.end === 'open' ? Infinity : t.start + t.points.length - 1;
    if (Math.min(end, gone?.step ?? Infinity) <= until) expect(end).toBe(gone?.step ?? Infinity);
    // In free flight (up to the step before first contact) the engine's path.
    const free = Math.min(t.contact === null ? t.points.length : t.contact - t.start, until + 1 - t.start);
    for (let j = 1; j < free; j++) {
      const s = shot.snaps[t.start + j]!;
      if (!near(t.points[j]!, at(s, id), 1e-9)) throw new Error(`track ${k} (${t.path || 'shell'}) step ${t.start + j}: preview ${t.points[j]} vs engine ${at(s, id)}`);
    }
  });
  // Blasts: the same ones on the same steps; centred where the engine has the munition then.
  const mine = pre.blasts.filter((b) => b.step <= until), theirs = fired.filter((x) => x.step <= until);
  expect(mine.map((b) => b.step)).toEqual(theirs.map((x) => x.step));
  mine.forEach((b, i) => {
    const ev = theirs[i]!;
    if (ev.kind !== 'blast' || typeof ev.blast.centre !== 'object' || !('body' in ev.blast.centre)) throw new Error('blast not on a body');
    const id = ev.blast.centre.body, t = pre.tracks[id - n0]!;
    expect(b.track).toBe(id - n0);
    const want = at(shot.snaps[b.step]!, id);
    if (t.contact === null || b.step < t.contact) {
      expect(near(b.centre, want, 1e-9)).toBe(true);
      exact++;
    } else {
      // Held still from contact: off by at most what it moves in a couple of steps.
      expect(near(b.centre, want, 0.6)).toBe(true);
    }
  });
  return { pre, exact, checked: mine.length, shot };
}

describe('previewWeapon: the arc preview is the fired path', () => {
  it('a timer grenade: its arc and its blast, in the air, exactly', async () => {
    const spec = grenadeAsSpec({ ...DEFAULT_GRENADE, fuse: 'timer', delay: 0.8 }, { shape: BALL, density: 8, speed: [5, 40] });
    const { pre, exact } = await agree(spec, { shape: BALL, pos: [0, 1.5, 0], vel: [12, 8, 0], density: 8 }, 120);
    expect(pre.tracks).toHaveLength(1);
    expect(pre.tracks[0]!.contact).toBeNull();
    expect(pre.tracks[0]!.end).toBe('removed');
    expect(pre.blasts.map((b) => b.step)).toEqual([48]);
    expect(exact).toBe(1);
  });

  it('the firework: shell to its apex, 12 stars on a cone, each blowing near the ground', async () => {
    const { pre, exact } = await agree(FIREWORK, { shape: { kind: 'sphere', radius: 0.5 }, pos: [0, 1, 0], vel: [10, 20, 0], density: 4 }, 400);
    expect(pre.tracks.map((t) => t.path)).toEqual(['', ...Array(12).fill('star')]);
    expect(pre.tracks[0]!.end).toBe('split');
    expect(pre.tracks.slice(1).every((t) => t.end === 'removed')).toBe(true);
    expect(pre.blasts).toHaveLength(12);
    // Stars falling 0.3 units a step touch the ground on the step their 0.1 fuse sees it: those are
    // checked to within that step's travel; the rest (blown clear by a neighbour) exactly.
    expect(exact).toBeGreaterThan(0);
  });

  it('the cluster against a wall: splits on nearing it, the bomblets scatter, and the preview still agrees', async () => {
    const wall = [box([10, 0.5, 0]), box([10, 1.5, 0]), box([10, 2.5, 0])];
    const { pre, checked, shot } = await agree(CLUSTER, { shape: { kind: 'sphere', radius: 0.5 }, pos: [0, 2, 0], vel: [20, 3, 0], density: 6 }, 300, wall);
    expect(pre.tracks[0]!.end).toBe('split');
    // Up to the first blast (a bomblet on the wall, so within a step's travel) the preview is the
    // firing; that blast moves the wall, which the preview holds still.
    expect(checked).toBe(1);
    expect(shot.events.filter((x) => x.kind === 'blast')).toHaveLength(6);
    // It split on nearing the wall (near 3), well before the 6 s timer.
    expect(pre.tracks[0]!.points.length - 1).toBeLessThan(30);
    expect(pre.blasts).toHaveLength(6);
  });

  it('the M grenade fired flat: a proximity fuse on the ground', async () => {
    const shell = GRENADE_M.shell;
    const { pre } = await agree(GRENADE_M, { shape: shell.shape, pos: [0, 1, 0], vel: [15, 2, 0], density: shell.density }, 200);
    expect(pre.blasts).toHaveLength(1);
    expect(pre.blasts[0]!.step).toBeLessThan(40);
  });

  it('stops once nothing is left, and holds a never-spent munition to the step cap', () => {
    const p = previewWeapon(FIREWORK, { shape: { kind: 'sphere', radius: 0.5 }, pos: [0, 1, 0], vel: [10, 20, 0], density: 4 }, WORLD);
    expect(p.steps).toBeLessThan(600);
    const lump: WeaponSpec = { version: 1, shell: { shape: BALL, density: 1, speed: [1, 2] }, rules: [{ when: { after: 50 }, do: [{ blast: { radius: 1, impulse: 1 } }] }] };
    const q = previewWeapon(lump, { shape: BALL, pos: [0, 1, 0], vel: [1, 1, 0], density: 1 }, WORLD, { steps: 90 });
    expect(q.steps).toBe(90);
    expect(q.tracks[0]!.end).toBe('open');
    expect(q.tracks[0]!.points).toHaveLength(91);
    // Resting on the ground after it lands.
    expect(q.tracks[0]!.contact).not.toBeNull();
    expect(q.tracks[0]!.points.at(-1)![1]).toBeCloseTo(0.2, 12);
  });
});
