// The shared relative-spawn case (engine-api spawn.ts): every engine runs the
// same free-flight scene with and without relative spawns, and must start each
// child exactly where relativeBody() puts it from the parent's state as the
// step starts (then fly it one step), and leave every other body bit for bit as
// it was.
import { blastArea, blastCentre, blastVelocity, type BodyDesc, type BodyMotion, checkBlast, freeFlight, type InputEvent, massOf, type Quat, relativeBody, type SceneDesc, type Snapshot, type SpawnEvent, type Vec3 } from '@tb/engine-api';

/**
 * Parents in free flight high above the ground, apart enough never to touch. At `step`, in event order: a
 * blast pushes body 0 (so a child of 0 still inherits its state from before it); a child of 0 in world axes;
 * a child of 2 in body axes; a child of 1 in heading axes, then 1 is removed (a split); a child of 3, at
 * rest, in heading axes (+y); a blast that pushes the children of 0 and 2 (spawned before it). At `later`
 * a child of the first child (spawned at `step`), in body axes. Body 4 is never touched.
 */
export const SPAWN_CASE = { step: 5, later: 8, end: 12, bodies: 5 } as const;

const cube = (h: number): BodyDesc['shape'] => ({ kind: 'box', half: [h, h, h] });
const body = (shape: BodyDesc['shape'], pos: Vec3, linVel: Vec3, angVel: Vec3, rot: Quat = [0.1, 0.2, 0, Math.sqrt(0.95)], density = 1): BodyDesc => ({
  shape, pos, rot, linVel, angVel, density, friction: 0.5, restitution: 0, tag: 0,
});
/** 45 degrees about y. */
const R45: Quat = [0, 0.3826834323650898, 0, 0.9238795325112867];

/** q turned by angular velocity w for h seconds (the exponential map, normalised): a free spin, as every engine integrates one. */
export function spun(q: Quat, w: Vec3, h: number): Quat {
  const phi: Vec3 = [w[0] * h, w[1] * h, w[2] * h], t = Math.hypot(...phi);
  const s = t > 1e-12 ? Math.sin(t / 2) / t : 0.5, d: Quat = [phi[0] * s, phi[1] * s, phi[2] * s, Math.cos(t / 2)];
  const r: Quat = [
    d[3] * q[0] + d[0] * q[3] + d[1] * q[2] - d[2] * q[1],
    d[3] * q[1] - d[0] * q[2] + d[1] * q[3] + d[2] * q[0],
    d[3] * q[2] + d[0] * q[1] - d[1] * q[0] + d[2] * q[3],
    d[3] * q[3] - d[0] * q[0] - d[1] * q[1] - d[2] * q[2],
  ];
  const l = Math.hypot(...r);
  return [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
}

/** The case; `relative` false gives the same scene, blasts and removal without the relative spawns, the baseline. */
export function spawnScene(relative: boolean): SceneDesc {
  const y = 50;
  // Spinning parents are cubes and spheres (isotropic inertia), so free flight keeps their spin as it is on every engine.
  const bodies: BodyDesc[] = [
    body(cube(0.5), [-6, y, 0], [3, 2, -1], [0.5, 1.2, -0.3]),
    body({ kind: 'sphere', radius: 0.4 }, [0, y, -6], [1, 2, 8], [0, 0, 0], [0, 0, 0, 1], 4),
    body(cube(0.4), [6, y, 0], [-1, 0.5, 0], [0.2, -0.4, 0.9]),
    body(cube(0.3), [0, y + 6, 6], [0, 0, 0], [0, 0, 0]),
    body(cube(0.5), [0, y - 10, 0], [0, 1, 0], [0.1, 0, 0]),
  ];
  const { step, later } = SPAWN_CASE;
  const rel = (at: number, parent: number, axes: 'world' | 'body' | 'heading', child: BodyDesc): InputEvent[] => (relative ? [{ step: at, kind: 'spawn', body: child, from: { body: parent, axes } }] : []);
  const inputs: InputEvent[] = [
    { step, kind: 'blast', blast: { centre: { body: 0, offset: [0, -1, 0] }, radius: 2.5, impulse: 20 } },
    ...rel(step, 0, 'world', body(cube(0.3), [1.5, 0, 0], [0, 1, 0], [0, 0, 1], R45)),
    ...rel(step, 2, 'body', body({ kind: 'sphere', radius: 0.25 }, [0, 1, 0.2], [0.5, 0, 0], [0, 0.3, 0], R45, 2)),
    ...rel(step, 1, 'heading', body(cube(0.2), [0.9, 0.5, 0], [2, 0, -1], [0, 0, 0], [0, 0, 0, 1], 3)),
    { step, kind: 'remove', id: 1 },
    ...rel(step, 3, 'heading', body({ kind: 'sphere', radius: 0.2 }, [0, 1.1, 0], [0, 3, 0], [0, 0, 0], [0, 0, 0, 1])),
    { step, kind: 'blast', blast: { centre: [0, y, 0], radius: 7.8, impulse: 4, exclude: [0, 2] } },
    ...rel(later, SPAWN_CASE.bodies, 'body', body(cube(0.2), [0, 0, 1.2], [0, 0, 0.5], [0, 0, 0], [0, 0, 0, 1])),
  ];
  return { id: 'spawn', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: null, sleep: false, bodies, inputs };
}

/** Body i of a snapshot as a BodyMotion. */
export const motionOf = (s: Snapshot, i: number): BodyMotion => ({
  pos: [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!],
  rot: [s.rot[4 * i]!, s.rot[4 * i + 1]!, s.rot[4 * i + 2]!, s.rot[4 * i + 3]!],
  linVel: [s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!],
  angVel: [s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!],
});

/**
 * Each child's state one step after it spawned, as an engine with `substeps` (EngineInfo.integrator) must
 * have it: relativeBody() of its parent in the run's own snapshots (`run[k]`: after k steps), the blasts due
 * after it at its step, then one step of free flight (freeFlight, and a free spin).
 */
export function expectedChildren(run: Snapshot[], substeps: number): { id: number; step: number; state: BodyMotion }[] {
  const scene = spawnScene(true), out: { id: number; step: number; state: BodyMotion }[] = [];
  let id = scene.bodies.length;
  const steps = [...new Set(scene.inputs.map((e) => e.step))];
  for (const k of steps) {
    const at = run[k]!, events = scene.inputs.filter((e) => e.step === k);
    // Bodies as the step goes: every body of the snapshot, then each child as it is added.
    const pos: Vec3[] = [], vel: Vec3[] = [], descs: BodyDesc[] = [];
    const all = [...scene.bodies, ...scene.inputs.filter((e): e is SpawnEvent => e.kind === 'spawn').map((e) => e.body)];
    for (let i = 0; i < at.count; i++) { const m = motionOf(at, i); pos.push(m.pos); vel.push(m.linVel); descs.push(all[i]!); }
    const born: { id: number; desc: BodyDesc }[] = [];
    for (const ev of events) {
      if (ev.kind === 'spawn') {
        const desc = relativeBody(motionOf(at, ev.from!.body), ev.body, ev.from!.axes);
        born.push({ id, desc });
        pos.push(desc.pos); vel.push([...desc.linVel]); descs.push(desc);
        id++;
      } else if (ev.kind === 'blast') {
        const b = checkBlast(ev.blast), c = blastCentre(b, b.body >= 0 ? pos[b.body]! : null);
        descs.forEach((d, i) => { const v = blastVelocity(b, c, i, pos[i]!, vel[i]!, massOf(d), blastArea(d.shape)); if (v) vel[i] = v; });
      }
    }
    for (const { id: c, desc } of born) {
      const f = freeFlight(desc.pos, vel[c]!, scene.gravity, scene.dt, substeps, 1);
      out.push({ id: c, step: k, state: { pos: f.pos, rot: spun(desc.rot, desc.angVel, scene.dt), linVel: f.vel, angVel: desc.angVel } });
    }
  }
  return out;
}

/**
 * Compares a run of spawnScene(true) with the baseline, both with a snapshot after every step from 0 to
 * SPAWN_CASE.end (index = steps taken): the largest error of each child's position, rotation (each
 * quaternion component, sign-matched) and velocities one step after it spawned (expectedChildren), and the
 * steps at which any of the scene's own bodies differs from the baseline at all.
 */
export function spawnErrors(base: Snapshot[], run: Snapshot[], substeps: number): { pos: number; rot: number; vel: number; children: number; othersChanged: number[] } {
  let pos = 0, rot = 0, vel = 0;
  const want = expectedChildren(run, substeps);
  for (const { id, step, state } of want) {
    const got = motionOf(run[step + 1]!, id);
    for (let a = 0; a < 3; a++) {
      pos = Math.max(pos, Math.abs(got.pos[a]! - state.pos[a]!));
      vel = Math.max(vel, Math.abs(got.linVel[a]! - state.linVel[a]!), Math.abs(got.angVel[a]! - state.angVel[a]!));
    }
    const sign = got.rot.reduce((s, x, a) => s + x * state.rot[a]!, 0) < 0 ? -1 : 1;
    for (let a = 0; a < 4; a++) rot = Math.max(rot, Math.abs(sign * got.rot[a]! - state.rot[a]!));
  }
  const othersChanged: number[] = [];
  for (let k = 0; k <= SPAWN_CASE.end; k++) {
    const b = base[k]!, r = run[k]!;
    const n = SPAWN_CASE.bodies;
    const same = (f: 'pos' | 'rot' | 'linVel' | 'angVel', w: number) => b[f].subarray(0, w * n).every((x, j) => x === r[f][j]);
    if (!(same('pos', 3) && same('rot', 4) && same('linVel', 3) && same('angVel', 3))) othersChanged.push(k);
  }
  return { pos, rot, vel, children: want.length, othersChanged };
}

/**
 * A momentum-conserving burst (@tb/weapons split with conserve): a spinning, moving cube of mass 8 splits at
 * BURST_CASE.step into 8 children of mass 1 whose offsets and own velocities (in heading axes) sum to zero, and
 * is removed. Free flight, so the children's total momentum one step on must be the parent's at the split plus
 * the step's gravity impulse.
 */
export const BURST_CASE = { step: 4, children: 8 } as const;

export function burstScene(): SceneDesc {
  const parent = body(cube(0.5), [0, 50, 0], [6, 3, -2], [0.8, -1.5, 0.6], [0.1, 0.2, 0, Math.sqrt(0.95)], 8);
  const inputs: InputEvent[] = [];
  for (let i = 0; i < BURST_CASE.children; i++) {
    // The corners of a cube of side 2: they sum to zero; the velocities are the offsets times 3.
    const d: Vec3 = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
    inputs.push({ step: BURST_CASE.step, kind: 'spawn', body: body(cube(0.25), [0.7 * d[0], 0.7 * d[1], 0.7 * d[2]], [3 * d[0], 3 * d[1], 3 * d[2]], [0, 0, 0], [0, 0, 0, 1], 8), from: { body: 0, axes: 'heading' } });
  }
  inputs.push({ step: BURST_CASE.step, kind: 'remove', id: 0 });
  return { id: 'burst', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: null, sleep: false, bodies: [parent], inputs };
}

/** The burst's momentum error: |sum m v of the children one step after the split - M (V + h g)| / |M V| (`at`: the snapshot after BURST_CASE.step steps, `after`: one step on). */
export function burstMomentumError(at: Snapshot, after: Snapshot): number {
  const s = burstScene(), M = massOf(s.bodies[0]!), m = massOf((s.inputs[0] as SpawnEvent).body), h = s.dt;
  const want: Vec3 = [0, 1, 2].map((k) => M * (at.linVel[k]! + h * s.gravity[k]!)) as Vec3;
  const got: Vec3 = [0, 0, 0];
  for (let i = 1; i <= BURST_CASE.children; i++) for (let k = 0; k < 3; k++) got[k]! += m * after.linVel[3 * i + k]!;
  return Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]) / (M * Math.hypot(at.linVel[0]!, at.linVel[1]!, at.linVel[2]!));
}
