// The shared field-event cases (engine-api field.ts, roadmap C7): every engine
// runs the same scenes. In free flight, bodies must move exactly as
// semi-implicit Euler under the schedule and the kicks says (fieldFlight);
// on the ground, a cube under a tilted gravity must stick below the friction
// angle and slide at g (sin t - mu cos t) above it, the engines agreeing with
// the analytic answer and with each other (the node's verify: "reference, GPU
// and Rapier agree on a tilt test"). With sleep, the tilt must wake the cube
// that fell asleep before it.
import { type BodyDesc, type InputEvent, quantiseVec3, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';

const G: Vec3 = quantiseVec3([0, -9.81, 0]);

const body = (shape: BodyDesc['shape'], pos: Vec3, linVel: Vec3, opts: Partial<BodyDesc> = {}): BodyDesc => ({
  shape, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0.4, 0], density: 1, friction: 0.5, restitution: 0, tag: 0, ...opts,
});
const cube = (h: number): BodyDesc['shape'] => ({ kind: 'box', half: [h, h, h] });

/**
 * Free flight, every body far from every other and from the ground: at step 3 gravity turns (g1); at 4 body 3 is
 * removed; at 6 every moving body is kicked (k1), then a body spawns (id 5, not kicked); at 9 gravity turns again and a
 * second kick (g2, k2) lands with it. Body 2 is pinned: no gravity, no kick.
 */
export const FIELD_CASE = { end: 14, pinned: 2, removed: 3, spawned: 5 } as const;
const g1: Vec3 = quantiseVec3([3, -8, 1]), g2: Vec3 = quantiseVec3([-2, -12, 0]);
const k1: Vec3 = quantiseVec3([0.5, 1, -0.25]), k2: Vec3 = quantiseVec3([0, -0.75, 2]);

export function fieldScene(): SceneDesc {
  const y = 60;
  const bodies: BodyDesc[] = [
    body(cube(0.5), [-6, y, 0], [1, 0, 0]),
    body({ kind: 'sphere', radius: 0.4 }, [0, y, 0], [0, 2, 0], { density: 4 }),
    body(cube(0.5), [6, y, 0], [0, 0, 0], { pinned: true }),
    body(cube(0.3), [0, y, 6], [0, 0, 1]),
    body({ kind: 'box', half: [1, 0.2, 0.4] }, [0, y, -6], [-0.5, 0, 0]),
  ];
  const inputs: InputEvent[] = [
    { step: 3, kind: 'field', gravity: g1 },
    { step: 4, kind: 'remove', id: 3 },
    { step: 6, kind: 'field', kick: k1 },
    { step: 6, kind: 'spawn', body: body(cube(0.3), [0, y + 6, 0], [0, 0, 0]) },
    { step: 9, kind: 'field', gravity: g2, kick: k2 },
  ];
  return { id: 'field', params: {}, seed: 0, gravity: G, dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: false, bodies, inputs };
}

/**
 * Where the bodies of a contact-free scene are after each step: events applied at the start of their step in order
 * (spawn, remove, gravity, kick to every moving body), then `substeps` semi-implicit Euler substeps of dt / substeps
 * (engine-api freeFlight). Index k = after k steps; pos and linVel per body, NaN for one not spawned yet.
 */
export function fieldFlight(scene: SceneDesc, substeps: number, steps: number): Array<{ pos: Vec3[]; linVel: Vec3[] }> {
  const pos = scene.bodies.map((b) => [...b.pos] as Vec3), vel = scene.bodies.map((b) => (b.pinned ? [0, 0, 0] : [...b.linVel]) as Vec3);
  const pinned = scene.bodies.map((b) => !!b.pinned), gone = scene.bodies.map(() => false);
  let g: Vec3 = [...scene.gravity];
  const events = scene.inputs.map((e, i) => [e, i] as const).sort((a, b) => a[0].step - b[0].step || a[1] - b[1]).map(([e]) => e);
  const copy = () => ({ pos: pos.map((p) => [...p] as Vec3), linVel: vel.map((v) => [...v] as Vec3) });
  const out = [copy()];
  let next = 0;
  for (let s = 0; s < steps; s++) {
    for (; next < events.length && events[next]!.step <= s; next++) {
      const e = events[next]!;
      if (e.kind === 'spawn') { pos.push([...e.body.pos]); vel.push(e.body.pinned ? [0, 0, 0] : [...e.body.linVel]); pinned.push(!!e.body.pinned); gone.push(false); }
      else if (e.kind === 'remove') { gone[e.id] = true; vel[e.id] = [0, 0, 0]; }
      else if (e.kind === 'field') {
        if (e.gravity) g = [...e.gravity];
        if (e.kick) vel.forEach((v, i) => { if (!pinned[i] && !gone[i]) for (let k = 0; k < 3; k++) v[k] = v[k]! + e.kick![k]!; });
      } else throw new Error('fieldFlight: no blasts');
    }
    const h = scene.dt / substeps;
    for (let i = 0; i < pos.length; i++) {
      if (pinned[i] || gone[i]) continue;
      for (let u = 0; u < substeps; u++) for (let k = 0; k < 3; k++) { vel[i]![k] = vel[i]![k]! + h * g[k]!; pos[i]![k] = pos[i]![k]! + h * vel[i]![k]!; }
    }
    out.push(copy());
  }
  return out;
}

/** The largest difference between a run's snapshots (after every step, 0 to FIELD_CASE.end) and fieldFlight, relative to each body's distance travelled and speed, and the bodies' count each step. */
export function fieldErrors(run: Snapshot[], substeps: number): { pos: number; vel: number; counts: number[] } {
  const want = fieldFlight(fieldScene(), substeps, FIELD_CASE.end);
  let pos = 0, vel = 0;
  const counts: number[] = [];
  for (let k = 0; k <= FIELD_CASE.end; k++) {
    const s = run[k]!, w = want[k]!;
    counts.push(s.count);
    for (let i = 0; i < s.count; i++) {
      for (let j = 0; j < 3; j++) {
        pos = Math.max(pos, Math.abs(s.pos[3 * i + j]! - w.pos[i]![j]!));
        vel = Math.max(vel, Math.abs(s.linVel[3 * i + j]! - w.linVel[i]![j]!));
      }
    }
  }
  return { pos, vel, counts };
}

/**
 * The tilt: a cube (0.5 m half, friction 0.6 on it and the ground) rests on the ground; at `at` gravity turns by
 * `degrees` about z toward +x, keeping 9.81. Below the friction angle (atan 0.6 = 31 deg) it must stay; above it, slide
 * along +x with acceleration g (sin t - 0.6 cos t) from rest. With `sleep`, the scene sleeps and the cube has fallen
 * asleep before the tilt, which must wake it.
 */
export const TILT_CASE = { at: 90, end: 150, mu: 0.6 } as const;

export function tiltScene(degrees: number, sleep = false): SceneDesc {
  const t = (degrees * Math.PI) / 180, m = 9.81;
  return {
    id: `tilt-${degrees}`, params: { degrees }, seed: 0, gravity: G, dt: 1 / 60, ground: { y: 0, friction: TILT_CASE.mu }, sleep,
    bodies: [{ shape: cube(0.5), pos: [0, 0.5, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: TILT_CASE.mu, restitution: 0, tag: 0 }],
    inputs: [{ step: TILT_CASE.at, kind: 'field', gravity: quantiseVec3([m * Math.sin(t), -m * Math.cos(t), 0]) }],
  };
}

/** The analytic slide over the case's window: 0 below the friction angle, else (1/2) a T^2 with a = g (sin t - mu cos t). */
export function tiltExpected(degrees: number): number {
  const t = (degrees * Math.PI) / 180, a = 9.81 * (Math.sin(t) - TILT_CASE.mu * Math.cos(t)), T = (TILT_CASE.end - TILT_CASE.at) / 60;
  return a > 0 ? 0.5 * a * T * T : 0;
}

/** From snapshots at TILT_CASE.at and TILT_CASE.end: the slide along x, the drift across (z) and up (y), and whether the cube was asleep at the tilt (awake 0). */
export function tiltResult(atTilt: Snapshot, end: Snapshot): { slide: number; across: number; lift: number; asleepAtTilt: boolean } {
  return {
    slide: end.pos[0]! - atTilt.pos[0]!, across: Math.abs(end.pos[2]! - atTilt.pos[2]!), lift: Math.abs(end.pos[1]! - atTilt.pos[1]!),
    asleepAtTilt: atTilt.awake[0] === 0,
  };
}
