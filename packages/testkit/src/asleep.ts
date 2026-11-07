// The shared spawn-asleep case (engine-api asleep.ts, roadmap C22): every
// engine runs the same scene. A row of dominoes given BodyDesc.asleep stands
// until a ball pushes the first; the wave runs to the end. On an engine that
// sleeps, each domino is asleep, at its given pose exactly, until the one
// behind it has leant far enough to reach it, and a cube spawned asleep far
// from the row never wakes. On an engine that does not, they are awake from
// the start and stand still until the push. Either way the row falls in order.
import type { BodyDesc, SceneDesc, Snapshot, Vec3 } from '@tb/engine-api';

const G = 9.81;

/**
 * Probe X1's domino at the game's 0.5 m h (1 m tall, 0.5 m wide, 0.15 m thick, model-scale plaster) and pitch (0.6 m). It
 * touches the next one when its top has moved by the gap, pitch - thickness: at a tilt of
 * asin(0.45 / 1) = 26.7 deg.
 */
export const ASLEEP_CASE = { dominoes: 12, pitch: 0.6, half: [0.25, 0.5, 0.075] as Vec3, push: 20, end: 260, cube: 12, ball: 13, reachDeg: 20 } as const;

const box = (half: Vec3, pos: Vec3, opts: Partial<BodyDesc> = {}): BodyDesc => ({
  shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 250, friction: 0.6, restitution: 0, tag: 0, ...opts,
});

/**
 * Bodies 0 to 11: the dominoes, along +z, each `asleep`. 12: a cube asleep 6 m to the side. 13: X1's pusher, a 0.1 m
 * ball at 1 m/s and 0.8 m up just behind the first domino, spawned at `push`. `asleep` false gives the same scene with
 * every body awake; `sleep` is SceneDesc.sleep. `ignored`: the first domino is described with a spin that would tip
 * it, which an engine that sleeps it must ignore (on one that does not, it would fall before the push).
 */
export function asleepScene(asleep = true, sleep = true, ignored = false): SceneDesc {
  const { dominoes, pitch, half } = ASLEEP_CASE;
  const bodies: BodyDesc[] = [];
  for (let k = 0; k < dominoes; k++) bodies.push(box(half, [0, half[1], k * pitch], { ...(asleep ? { asleep } : {}), ...(k === 0 && ignored ? { angVel: [3, 0, 0] as Vec3 } : {}) }));
  bodies.push(box([0.4, 0.4, 0.4], [6, 0.4, 3], asleep ? { asleep } : {}));
  const ball: BodyDesc = { shape: { kind: 'sphere', radius: 0.1 }, pos: [0, 0.8, -(half[2] + 0.1 + 0.02)], rot: [0, 0, 0, 1], linVel: [0, 0, 1], angVel: [0, 0, 0], density: 2000, friction: 0.5, restitution: 0, tag: -1 };
  return { id: 'asleep', params: {}, seed: 0, gravity: [0, -G, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep, bodies, inputs: [{ step: ASLEEP_CASE.push, kind: 'spawn', body: ball }] };
}

/** Tilt from upright of body i, degrees. */
export function tiltDeg(s: Snapshot, i: number): number {
  const x = s.rot[4 * i]!, z = s.rot[4 * i + 2]!;
  return (Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (x * x + z * z)))) * 180) / Math.PI;
}

export interface AsleepReport {
  /** Per domino, the first step it tilts past 15 deg (-1: never). */
  fallenAt: number[];
  /** Per domino, the first step it is reported awake (-1: never). */
  wokeAt: number[];
  /** Per domino, the first step the one behind it tilts past ASLEEP_CASE.reachDeg (-1: never; the first domino: the push step). */
  reachedAt: number[];
  /** The largest change of an asleep body's pose from step 0, over the steps before it woke (0 on an engine that sleeps). */
  asleepMoved: number;
  /** The largest speed reported for an asleep body before it woke. */
  asleepSpeed: number;
  /** The most any domino tilts before the push, degrees. */
  standingTilt: number;
  /** The far cube: steps it was awake, and how far it moved from step 0. */
  cubeAwake: number;
  cubeMoved: number;
}

/** Measures a run of asleepScene() (snapshots after every step from 0 to ASLEEP_CASE.end, index = steps taken). */
export function asleepReport(run: Snapshot[]): AsleepReport {
  const { dominoes, push, end, cube, reachDeg } = ASLEEP_CASE;
  const fallenAt = new Array<number>(dominoes).fill(-1), wokeAt = new Array<number>(dominoes).fill(-1), reachedAt = new Array<number>(dominoes).fill(-1);
  reachedAt[0] = push;
  const s0 = run[0]!;
  let asleepMoved = 0, asleepSpeed = 0, standingTilt = 0, cubeAwake = 0, cubeMoved = 0;
  const moved = (s: Snapshot, i: number) => {
    let m = 0;
    for (let j = 0; j < 3; j++) m = Math.max(m, Math.abs(s.pos[3 * i + j]! - s0.pos[3 * i + j]!));
    for (let j = 0; j < 4; j++) m = Math.max(m, Math.abs(s.rot[4 * i + j]! - s0.rot[4 * i + j]!));
    return m;
  };
  const speed = (s: Snapshot, i: number) => Math.max(Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!), Math.hypot(s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!));
  for (let k = 0; k <= end; k++) {
    const s = run[k]!;
    for (let i = 0; i < dominoes; i++) {
      const t = tiltDeg(s, i);
      if (k <= push) standingTilt = Math.max(standingTilt, t);
      if (fallenAt[i]! < 0 && t > 15) fallenAt[i] = k;
      if (i + 1 < dominoes && reachedAt[i + 1]! < 0 && t > reachDeg) reachedAt[i + 1] = k;
      if (wokeAt[i]! < 0 && s.awake[i]) wokeAt[i] = k;
      if (wokeAt[i]! < 0) { asleepMoved = Math.max(asleepMoved, moved(s, i)); asleepSpeed = Math.max(asleepSpeed, speed(s, i)); }
    }
    if (s.awake[cube]) cubeAwake++;
    cubeMoved = Math.max(cubeMoved, moved(s, cube));
  }
  return { fallenAt, wokeAt, reachedAt, asleepMoved, asleepSpeed, standingTilt, cubeAwake, cubeMoved };
}

/**
 * What every engine must show (an empty list when it does). `sleeps`: the engine slept the scene, so the asleep bodies
 * must have been asleep, exactly still, until reached. Otherwise they ran awake and only had to stand.
 */
export function asleepFailures(r: AsleepReport, sleeps: boolean): string[] {
  const out: string[] = [];
  const { dominoes, push } = ASLEEP_CASE;
  r.fallenAt.forEach((f, i) => { if (f < 0) out.push(`domino ${i} never fell`); });
  for (let i = 1; i < dominoes; i++) if (r.fallenAt[i]! >= 0 && r.fallenAt[i]! < r.fallenAt[i - 1]! - 5) out.push(`domino ${i} fell at ${r.fallenAt[i]} before domino ${i - 1} (${r.fallenAt[i - 1]})`);
  if (r.standingTilt > 0.5) out.push(`a domino tilted ${r.standingTilt.toFixed(3)} deg before the push`);
  if (sleeps) {
    if (r.asleepMoved !== 0) out.push(`an asleep body moved ${r.asleepMoved} before it woke`);
    if (r.asleepSpeed !== 0) out.push(`an asleep body reported speed ${r.asleepSpeed} before it woke`);
    r.wokeAt.forEach((w, i) => {
      if (w < 0) out.push(`domino ${i} never woke`);
      else if (w <= push) out.push(`domino ${i} awake at step ${w}, before the push (${push})`);
      else if (r.reachedAt[i]! < 0 || w < r.reachedAt[i]!) out.push(`domino ${i} woke at step ${w}, before the one behind reached it (${r.reachedAt[i]})`);
    });
    if (r.cubeAwake) out.push(`the far cube was awake for ${r.cubeAwake} steps`);
    if (r.cubeMoved !== 0) out.push(`the far cube moved ${r.cubeMoved}`);
  } else {
    r.wokeAt.forEach((w, i) => { if (w !== 0) out.push(`domino ${i} not awake at step 0 on an engine that does not sleep it (first awake ${w})`); });
    if (r.cubeMoved > 1e-3) out.push(`the far cube moved ${r.cubeMoved}`);
  }
  return out;
}
