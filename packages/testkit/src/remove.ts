// The shared removal case (engine-api remove.ts): every engine runs the same
// scenes with and without removals and must take the removed bodies out
// (frozen where they were removed, at rest, tier free) and leave every other
// body as it was, and a body whose support is removed must fall.
import { type BodyDesc, type InputEvent, type SceneDesc, type Snapshot, TIER_FREE, type Vec3 } from '@tb/engine-api';

/**
 * Free flight: bodies well above the ground, apart enough never to touch.
 * At `step` a body spawns (id `spawned`), a blast around body 2 pushes 1, 2
 * and 4, then 2 and the new body are removed; at `later` body 0 is removed,
 * then a blast centred on body 1 reaches 0 and 2, which it must not push.
 */
export const REMOVE_CASE = { step: 5, later: 8, end: 14, spawned: 6, removed: [2, 6, 0] } as const;

const body = (shape: BodyDesc['shape'], pos: Vec3, linVel: Vec3, density = 1): BodyDesc => ({
  shape, pos, rot: [0.1, 0.2, 0, Math.sqrt(0.95)], linVel, angVel: [0.3, 0, -0.2], density, friction: 0.5, restitution: 0, tag: 0,
});
const cube = (h: number): BodyDesc['shape'] => ({ kind: 'box', half: [h, h, h] });

/** The free-flight case; `withRemove` false gives the same scene and blasts without the removals, the baseline. */
export function removeScene(withRemove: boolean): SceneDesc {
  const y = 50;
  const bodies: BodyDesc[] = [
    body(cube(0.5), [-3, y, 0], [0.5, 0, 0]),
    body(cube(0.5), [0, y, 0], [0, 1, 0]),
    body({ kind: 'sphere', radius: 0.4 }, [2, y, 0], [0, 0, 0], 4),
    body(cube(0.3), [0, y, -8], [0, 0, 0]),
    body({ kind: 'box', half: [1, 0.2, 0.4] }, [4, y + 1, 1], [-0.2, 0, 0], 0.5),
    body({ kind: 'sphere', radius: 0.3 }, [-8, y, 3], [1, 0, 0], 3),
  ];
  const { step, later } = REMOVE_CASE;
  const rm = (at: number, id: number): InputEvent[] => (withRemove ? [{ step: at, kind: 'remove', id }] : []);
  const inputs: InputEvent[] = [
    { step, kind: 'spawn', body: body(cube(0.3), [2, y + 3, 2], [0, 0, 0]) },
    { step, kind: 'blast', blast: { centre: [2, y - 0.5, 0], radius: 4, impulse: 10 } },
    ...rm(step, 2),
    ...rm(step, REMOVE_CASE.spawned),
    ...rm(later, 0),
    { step: later, kind: 'blast', blast: { centre: { body: 1 }, radius: 6, impulse: 10, exclude: [1] } },
  ];
  return { id: 'remove', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: false, bodies, inputs };
}

/** Where each removed body must stay: its state when it was removed (from the baseline's snapshots, by step), or its spawn's. */
function frozenAt(base: Snapshot[], id: number): { pos: Vec3; rot: [number, number, number, number] } {
  const scene = removeScene(true);
  const ev = scene.inputs.find((e) => e.kind === 'remove' && e.id === id)!;
  if (id >= scene.bodies.length) {
    const spawn = scene.inputs.filter((e) => e.kind === 'spawn')[id - scene.bodies.length]!;
    if (spawn.kind !== 'spawn') throw new Error('unreachable');
    return { pos: spawn.body.pos, rot: spawn.body.rot };
  }
  const s = base[ev.step]!;
  return { pos: [s.pos[3 * id]!, s.pos[3 * id + 1]!, s.pos[3 * id + 2]!], rot: [s.rot[4 * id]!, s.rot[4 * id + 1]!, s.rot[4 * id + 2]!, s.rot[4 * id + 3]!] };
}

/**
 * Compares the snapshots of a run of removeScene(true) with the baseline's,
 * both taken after every step from 0 to REMOVE_CASE.end (index = steps taken):
 * - kept: the largest difference of any state of a body that is never removed,
 *   over every step (0 for an engine whose bodies do not interact here);
 * - removed: for each removed body once it is gone, the largest distance from
 *   where it was removed, and its largest speed;
 * - tiers: the steps whose snapshot does not report exactly the removed bodies
 *   as TIER_FREE and asleep (and every other body active).
 */
export function removeErrors(base: Snapshot[], run: Snapshot[]): { kept: number; removedMoved: number; removedSpeed: number; badTiers: number[] } {
  const scene = removeScene(true);
  const removeStep = new Map(scene.inputs.flatMap((e) => (e.kind === 'remove' ? [[e.id, e.step] as const] : [])));
  let kept = 0, removedMoved = 0, removedSpeed = 0;
  const badTiers: number[] = [];
  for (let k = 0; k <= REMOVE_CASE.end; k++) {
    const b = base[k]!, r = run[k]!;
    if (b.count !== r.count) throw new Error(`step ${k}: ${r.count} bodies, the baseline has ${b.count}`);
    let tiersOk = true;
    for (let i = 0; i < r.count; i++) {
      const at = removeStep.get(i);
      // A removal due at step s applies during the step() call made with
      // stepIndex s, so the snapshot after s steps still has the body.
      const gone = at !== undefined && k > at;
      const tier = r.tier?.[i] ?? 0;
      if (gone ? tier !== TIER_FREE || r.awake[i] !== 0 : tier !== 0) tiersOk = false;
      if (at === undefined) {
        for (const [f, w] of [['pos', 3], ['rot', 4], ['linVel', 3], ['angVel', 3]] as const) {
          for (let j = 0; j < w; j++) kept = Math.max(kept, Math.abs(r[f][w * i + j]! - b[f][w * i + j]!));
        }
      } else if (gone) {
        const f = frozenAt(base, i);
        for (let j = 0; j < 3; j++) removedMoved = Math.max(removedMoved, Math.abs(r.pos[3 * i + j]! - f.pos[j]!));
        for (let j = 0; j < 4; j++) removedMoved = Math.max(removedMoved, Math.abs(r.rot[4 * i + j]! - f.rot[j]!));
        removedSpeed = Math.max(removedSpeed, Math.hypot(r.linVel[3 * i]!, r.linVel[3 * i + 1]!, r.linVel[3 * i + 2]!), Math.hypot(r.angVel[3 * i]!, r.angVel[3 * i + 1]!, r.angVel[3 * i + 2]!));
      }
    }
    if (!tiersOk) badTiers.push(k);
  }
  return { kept, removedMoved, removedSpeed, badTiers };
}

/**
 * Contacts: a cube standing on another on the ground, and a third cube beside
 * them. At `step` the bottom cube (0) is removed, so the top one (1) falls
 * through where it was and lands on the ground; the third (2) stands as it
 * stood. `withRemove` false: the baseline, nothing removed.
 */
export const STACK_CASE = { step: 30, end: 120 } as const;

export function stackScene(withRemove: boolean): SceneDesc {
  const flat = (pos: Vec3): BodyDesc => ({ shape: cube(0.5), pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });
  return {
    id: 'remove-stack', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: false,
    bodies: [flat([0, 0.5, 0]), flat([0, 1.5, 0]), flat([3, 0.5, 0])],
    inputs: withRemove ? [{ step: STACK_CASE.step, kind: 'remove', id: 0 }] : [],
  };
}
