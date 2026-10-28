// The shared blast case (engine-api blast.ts): every engine runs the same
// scene with and without one blast and must change exactly the velocities
// blastKick() says, and nothing else.
import { blastArea, blastKick, type BodyDesc, checkBlast, type InputEvent, massOf, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';

/** The blast step and centre: bodies fly free well above any ground, apart enough never to touch. */
export const BLAST_CASE = { step: 5, centre: [0, 50, 0] as Vec3, radius: 5 } as const;

const body = (shape: BodyDesc['shape'], pos: Vec3, linVel: Vec3, density: number): BodyDesc => ({
  shape, pos, rot: [0.1, 0.2, 0, Math.sqrt(0.95)], linVel, angVel: [0.3, 0, -0.2], density, friction: 0.5, restitution: 0, tag: 0,
});

/**
 * Bodies around the centre at distances 0 to 7 (radius 5), cubes, a slab and
 * spheres of several densities, some moving; at the blast step a body spawns
 * before the blast (pushed) and one after it (not pushed). Body 3 is excluded.
 * `withBlast` false gives the same scene without the blast, the baseline.
 */
export function blastScene(withBlast: boolean): SceneDesc {
  const [cx, cy, cz] = BLAST_CASE.centre;
  const cube = (h: number): BodyDesc['shape'] => ({ kind: 'box', half: [h, h, h] });
  const bodies: BodyDesc[] = [
    body(cube(0.5), [cx, cy, cz], [0, 0, 0], 1), // on the centre: straight up
    body(cube(0.5), [cx + 1.5, cy, cz], [1, 0, 0], 1),
    body(cube(0.25), [cx, cy + 2.5, cz], [0, 0, 0], 2),
    body(cube(0.5), [cx - 2, cy, cz], [0, 0, 0], 1), // excluded
    body({ kind: 'sphere', radius: 0.4 }, [cx, cy - 1.2, cz + 3], [0, 2, 0], 8),
    body({ kind: 'box', half: [1.2, 0.1, 0.3] }, [cx - 2.9, cy + 2.9, cz - 2.2], [0, 0, 0], 0.5),
    body(cube(0.5), [cx + 4.85, cy, cz], [0, 0, 0], 1), // just inside after it drifts: the edge
    body(cube(0.5), [cx, cy, cz - 6], [0, 0, 0], 1), // outside
    body({ kind: 'sphere', radius: 0.3 }, [cx + 7, cy + 1, cz], [0, 0, 0], 3), // outside
  ];
  const at = BLAST_CASE.step;
  const inputs: InputEvent[] = [
    { step: at, kind: 'spawn', body: body(cube(0.3), [cx + 1, cy + 1, cz + 1.5], [0, 0, 0], 1) },
    ...(withBlast ? [{ step: at, kind: 'blast' as const, blast: { centre: [cx, cy, cz] as Vec3, radius: BLAST_CASE.radius, impulse: 40, exclude: [3], maxDv: 30 } }] : []),
    { step: at, kind: 'spawn', body: body(cube(0.3), [cx - 1, cy - 1.5, cz + 1.5], [0, 0, 0], 1) },
  ];
  return { id: 'blast', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: null, sleep: false, bodies, inputs };
}

/**
 * The speed change per body (3 per body, 0 where none) that the blast should
 * give, from the baseline's state after BLAST_CASE.step steps (`atBlast`,
 * spawns of that step not yet in it) and the spawned bodies' own poses.
 */
export function expectedKicks(atBlast: Snapshot): Float64Array {
  const scene = blastScene(true), bodies = [...scene.bodies], pos: Vec3[] = [];
  for (let i = 0; i < atBlast.count; i++) pos.push([atBlast.pos[3 * i]!, atBlast.pos[3 * i + 1]!, atBlast.pos[3 * i + 2]!]);
  const out = new Float64Array(3 * (bodies.length + 2));
  for (const ev of scene.inputs) {
    if (ev.kind === 'spawn') { bodies.push(ev.body); pos.push(ev.body.pos); continue; }
    const b = checkBlast(ev.blast);
    bodies.forEach((d, id) => {
      const k = blastKick(b, id, pos[id]!, massOf(d), blastArea(d.shape));
      if (k) out.set(k, 3 * id);
    });
  }
  return out;
}

/**
 * Compares a run of blastScene(true) with the baseline one step after the
 * blast: the largest error of the velocity change against expectedKicks
 * (relative to the largest kick), and the bodies the blast should not touch
 * whose state differs from the baseline at all.
 */
export function blastErrors(atBlast: Snapshot, base: Snapshot, blasted: Snapshot): { relErr: number; maxKick: number; untouchedChanged: number[] } {
  const want = expectedKicks(atBlast);
  let err = 0, maxKick = 0;
  const untouchedChanged: number[] = [];
  for (let i = 0; i < base.count; i++) {
    const k = want.subarray(3 * i, 3 * i + 3);
    maxKick = Math.max(maxKick, Math.hypot(k[0]!, k[1]!, k[2]!));
    for (let a = 0; a < 3; a++) err = Math.max(err, Math.abs(blasted.linVel[3 * i + a]! - base.linVel[3 * i + a]! - k[a]!));
    if (k.every((x) => x === 0)) {
      const same = (f: 'pos' | 'rot' | 'linVel' | 'angVel', w: number) => blasted[f].subarray(w * i, w * i + w).every((x, j) => x === base[f][w * i + j]);
      if (!(same('pos', 3) && same('rot', 4) && same('linVel', 3) && same('angVel', 3))) untouchedChanged.push(i);
    }
  }
  return { relErr: err / maxKick, maxKick, untouchedChanged };
}
