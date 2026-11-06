// The shared force case (engine-api force.ts): every engine runs the same
// free-flight scene with and without its force events, and each step of each
// body must be one step of free flight from the engine's own state before it
// (forceErrors), after the step's blasts and, for a forced body, the kick
// h F / m with F from forceAt on that state. Bodies never forced stay bit for
// bit as in the run without forces, and nothing changes before the first force.
import { blastArea, blastCentre, blastVelocity, type BodyDesc, checkBlast, ForceTable, forceKicks, freeFlight, type InputEvent, massOf, type Quat, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { motionOf, spun } from './spawn.ts';

/**
 * At `start`: a blast under body 4, then forces on 0 (a world thrust), 1 (a thrust in its own spinning axes),
 * 2 (a thrust in its heading axes), 3 (a vibration) and 4 (a held pull with a dashpot, capped at first, which
 * reads 4's state after the blast). At `start + 2` body 6 is spawned and takes a world thrust in the same step.
 * At `start + 3` body 0's thrust is replaced by a vibration (its steps count from 0 again). At `start + 5` body 6
 * is removed, which ends its force; at `start + 6` body 3's force is ended (force: null). Body 5 is never forced.
 */
export const FORCE_CASE = { start: 3, end: 16, bodies: 6, control: 5 } as const;

const cube = (h: number): BodyDesc['shape'] => ({ kind: 'box', half: [h, h, h] });
const body = (shape: BodyDesc['shape'], pos: Vec3, linVel: Vec3, angVel: Vec3, density = 1, rot: Quat = [0.1, 0.2, 0, Math.sqrt(0.95)]): BodyDesc => ({
  shape, pos, rot, linVel, angVel, density, friction: 0.5, restitution: 0, tag: 0,
});

/** The case; `forces` false gives the same scene, spawn, blast and removal without the force events, the baseline. */
export function forceScene(forces: boolean): SceneDesc {
  const y = 50, { start } = FORCE_CASE;
  // Spinning bodies are cubes and spheres (isotropic inertia), so free flight keeps their spin on every engine.
  const bodies: BodyDesc[] = [
    body(cube(0.5), [-8, y, 0], [3, 2, -1], [0.5, 1.2, -0.3]),
    body(cube(0.4), [8, y, 0], [-1, 0.5, 0], [0.2, -0.4, 0.9], 2),
    body({ kind: 'sphere', radius: 0.4 }, [0, y, -8], [1, 2, 8], [0, 0, 0], 4, [0, 0, 0, 1]),
    body(cube(0.3), [0, y + 6, 8], [0, 0, 0], [0, 0, 0]),
    body({ kind: 'sphere', radius: 0.5 }, [0, y - 10, 0], [0, 1, 0], [0, 0, 0], 1, [0, 0, 0, 1]),
    body(cube(0.5), [0, y + 10, -12], [0.5, 0, 0], [0.1, 0, 0]),
  ];
  const f = (ev: InputEvent): InputEvent[] => (forces ? [ev] : []);
  const inputs: InputEvent[] = [
    { step: start, kind: 'blast', blast: { centre: [0, y - 12, 0], radius: 4, impulse: 10 } },
    ...f({ step: start, kind: 'force', id: 0, force: { steps: 6, thrust: [4, 12, -3] } }),
    ...f({ step: start, kind: 'force', id: 1, force: { steps: 8, thrust: [6, 0, 2], axes: 'body' } }),
    ...f({ step: start, kind: 'force', id: 2, force: { steps: 10, thrust: [1, 9, 0], axes: 'heading' } }),
    ...f({ step: start, kind: 'force', id: 3, force: { steps: 12, vibrate: [0, 15, 5], period: 0.1, phase: 0.25 } }),
    ...f({ step: start, kind: 'force', id: 4, force: { steps: 30, pull: [0, y - 6, 3], stiffness: 20, damping: 3, max: 25 } }),
    { step: start + 2, kind: 'spawn', body: body({ kind: 'sphere', radius: 0.3 }, [10, y, 10], [0, 0, 0], [0, 0, 0], 1, [0, 0, 0, 1]) },
    ...f({ step: start + 2, kind: 'force', id: 6, force: { steps: 20, thrust: [0, 0, 5] } }),
    ...f({ step: start + 3, kind: 'force', id: 0, force: { steps: 5, vibrate: [3, 0, 0], period: 0.05 } }),
    { step: start + 5, kind: 'remove', id: 6 },
    ...f({ step: start + 6, kind: 'force', id: 3, force: null }),
  ];
  return { id: 'force', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: null, sleep: false, bodies, inputs };
}

/**
 * Compares a run of forceScene(true) with the baseline, both with a snapshot after every step from 0 to
 * FORCE_CASE.end (index = steps taken). For every step k and every body not removed by then: the largest error
 * of its state after k + 1 steps against one step of free flight (freeFlight and a free spin, with the engine's
 * `substeps`) from its state after k steps, the step's blasts and its force's kick (forceKicks); the number of
 * forced body-steps checked; the steps at which body FORCE_CASE.control differs from the baseline at all; and
 * the first step at which anything differs from the baseline.
 */
export function forceErrors(base: Snapshot[], run: Snapshot[], substeps: number): { pos: number; rot: number; vel: number; forced: number; controlChanged: number[]; firstDiff: number } {
  const scene = forceScene(true), table = new ForceTable(), descs = [...scene.bodies], gone = new Set<number>();
  let pos = 0, rot = 0, vel = 0, forced = 0;
  for (let k = 0; k < FORCE_CASE.end; k++) {
    const at = run[k]!, states = Array.from({ length: at.count }, (_, i) => motionOf(at, i));
    for (const ev of scene.inputs.filter((e) => e.step === k)) {
      if (ev.kind === 'spawn') { descs.push(ev.body); states.push({ pos: [...ev.body.pos], rot: [...ev.body.rot], linVel: [...ev.body.linVel], angVel: [...ev.body.angVel] }); }
      else if (ev.kind === 'remove') { gone.add(ev.id); table.remove(ev.id); }
      else if (ev.kind === 'force') table.apply(ev, k);
      else {
        const b = checkBlast(ev.blast), c = blastCentre(b, b.body >= 0 ? states[b.body]!.pos : null);
        states.forEach((s, i) => { if (gone.has(i)) return; const v = blastVelocity(b, c, i, s.pos, s.linVel, massOf(descs[i]!), blastArea(descs[i]!.shape)); if (v) s.linVel = v; });
      }
    }
    const kicks = forceKicks(table.act(k), k, scene.dt, (i) => states[i]!, (i) => massOf(descs[i]!));
    for (const { id, dv } of kicks) { const v = states[id]!.linVel; states[id]!.linVel = [v[0] + dv[0], v[1] + dv[1], v[2] + dv[2]]; }
    forced += kicks.length;
    const next = run[k + 1]!;
    states.forEach((s, i) => {
      if (gone.has(i)) return;
      const f = freeFlight(s.pos, s.linVel, scene.gravity, scene.dt, substeps, 1), q = spun(s.rot, s.angVel, scene.dt), got = motionOf(next, i);
      for (let a = 0; a < 3; a++) {
        pos = Math.max(pos, Math.abs(got.pos[a]! - f.pos[a]!));
        vel = Math.max(vel, Math.abs(got.linVel[a]! - f.vel[a]!), Math.abs(got.angVel[a]! - s.angVel[a]!));
      }
      const sign = got.rot.reduce((t, x, a) => t + x * q[a]!, 0) < 0 ? -1 : 1;
      for (let a = 0; a < 4; a++) rot = Math.max(rot, Math.abs(sign * got.rot[a]! - q[a]!));
    });
  }
  const controlChanged: number[] = [];
  let firstDiff = -1;
  for (let k = 0; k <= FORCE_CASE.end; k++) {
    const b = base[k]!, r = run[k]!, i = FORCE_CASE.control;
    const same = (f: 'pos' | 'rot' | 'linVel' | 'angVel', w: number, from: number, to: number) => b[f].subarray(w * from, w * to).every((x, j) => x === r[f][w * from + j]);
    const all = (from: number, to: number) => same('pos', 3, from, to) && same('rot', 4, from, to) && same('linVel', 3, from, to) && same('angVel', 3, from, to);
    if (!all(i, i + 1)) controlChanged.push(k);
    if (firstDiff < 0 && !all(0, Math.min(b.count, r.count))) firstDiff = k;
  }
  return { pos, rot, vel, forced, controlChanged, firstDiff };
}

/**
 * The held-pull case: a column of three unit cubes resting on the ground (asleep, on an engine with sleep, by
 * `rest`), then at `rest` a pull drags the middle cube sideways to `target`, 3 units out, held for `hold` steps:
 * the middle cube must move out, and the cube above it must wake and fall (its neighbours wake as it moves). Then a
 * second pull presses it down onto the ground below `target` for `press` steps: quiet there (friction stops the
 * spin the drag gave it), it must still not fall asleep while the force acts.
 */
export const PULL_CASE = { rest: 240, hold: 180, press: 240, target: [3, 1.5, 0] as Vec3 } as const;

export function pullScene(): SceneDesc {
  const { rest, hold, press, target } = PULL_CASE;
  const bodies = [0.5, 1.5, 2.5].map((y) => body(cube(0.5), [0, y, 0], [0, 0, 0], [0, 0, 0], 1, [0, 0, 0, 1]));
  const inputs: InputEvent[] = [
    { step: rest, kind: 'force', id: 1, force: { steps: hold, pull: [...target], stiffness: 60, damping: 8, max: 40 } },
    { step: rest + hold, kind: 'force', id: 1, force: { steps: press, pull: [target[0], 0.2, target[2]], stiffness: 60, damping: 8, max: 40 } },
  ];
  return { id: 'pull', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: true, bodies, inputs };
}
