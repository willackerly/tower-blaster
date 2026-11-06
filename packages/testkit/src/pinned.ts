// The shared pinned-body cases (engine-api pinned.ts, roadmap C8): every
// engine runs the same scenes and must hold a pinned body exactly where it was
// given, at rest and awake 0, under gravity, a falling load, a ball, a blast
// and a removal of its neighbour; and a body sliding on a pinned slab must move
// as it moves on the ground plane at the slab's height (probe X5's frame
// test, with the real flag).
import { type BodyDesc, type InputEvent, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';

const G = 9.81;

const box = (half: Vec3, pos: Vec3, opts: Partial<BodyDesc> = {}): BodyDesc => ({
  shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0, ...opts,
});

/**
 * Solid: a pinned slab tilted 10 degrees about z, floating 3 m above the
 * ground, given a velocity it must ignore (body 0); a second pinned box beside
 * it (1) that a cube rests on (2), removed at `remove` so the cube falls; a
 * cube dropped onto the slab (3); a ball fired at the slab (4); a blast at the
 * slab's edge at `blast` that pushes the bodies around it but not the pins.
 */
export const PIN_CASE = { blast: 40, remove: 60, end: 120, pins: [0, 1], cube: 2, dropped: 3, ball: 4 } as const;

const tilt = (deg: number): [number, number, number, number] => { const a = (deg * Math.PI) / 360; return [0, 0, Math.sin(a), Math.cos(a)]; };

export function pinScene(): SceneDesc {
  const bodies: BodyDesc[] = [
    box([3, 0.25, 1.5], [0, 3, 0], { rot: tilt(10), linVel: [1, 2, 3], angVel: [0.5, 0, 0], pinned: true, friction: 0.6 }),
    box([0.5, 0.5, 0.5], [6, 2, 0], { pinned: true }),
    box([0.4, 0.4, 0.4], [6, 2.9, 0]),
    box([0.4, 0.4, 0.4], [0.5, 4.5, 0.2], { rot: [0.1, 0.2, 0, Math.sqrt(0.95)] }),
    { shape: { kind: 'sphere', radius: 0.3 }, pos: [-6, 4.5, 0], rot: [0, 0, 0, 1], linVel: [8, 0, 0], angVel: [0, 0, 0], density: 4, friction: 0.5, restitution: 0, tag: 0 },
  ];
  const inputs: InputEvent[] = [
    { step: PIN_CASE.blast, kind: 'blast', blast: { centre: [3, 3, 0], radius: 3, impulse: 20 } },
    { step: PIN_CASE.remove, kind: 'remove', id: 1 },
  ];
  return { id: 'pinned', params: {}, seed: 0, gravity: [0, -G, 0], dt: 1 / 60, ground: { y: 0, friction: 0.5 }, sleep: false, bodies, inputs };
}

/**
 * Checks a run of pinScene() (snapshots after every step from 0 to PIN_CASE.end, index = steps taken):
 * - pinMoved: the largest change of a pinned body's pose from its own at step 0, over every step while it is in the
 *   world (0 for solid), and pinSpeed its largest speed;
 * - pinAwake: steps where a pinned body was reported awake;
 * - cubeDrop: how far the cube on the removed pin fell by the end (it must fall);
 * - droppedRests: whether the dropped cube ends resting on the slab (within 0.7 m above the slab's top under its
 *   centre, not through it or on the ground) and moving under 1 m/s; droppedY its height.
 */
export function pinErrors(run: Snapshot[]): { pinMoved: number; pinSpeed: number; pinAwake: number[]; cubeDrop: number; droppedRests: boolean; droppedY: number } {
  let pinMoved = 0, pinSpeed = 0;
  const pinAwake: number[] = [];
  const s0 = run[0]!;
  for (let k = 0; k <= PIN_CASE.end; k++) {
    const s = run[k]!;
    for (const i of PIN_CASE.pins) {
      // The removed pin is a tombstone from the step after its removal (remove.ts): still, but checked there.
      for (let j = 0; j < 3; j++) pinMoved = Math.max(pinMoved, Math.abs(s.pos[3 * i + j]! - s0.pos[3 * i + j]!));
      for (let j = 0; j < 4; j++) pinMoved = Math.max(pinMoved, Math.abs(s.rot[4 * i + j]! - s0.rot[4 * i + j]!));
      pinSpeed = Math.max(pinSpeed, Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!), Math.hypot(s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!));
      if (s.awake[i]) pinAwake.push(k);
    }
  }
  const end = run[PIN_CASE.end]!, c = PIN_CASE.cube, d = PIN_CASE.dropped;
  const cubeDrop = s0.pos[3 * c + 1]! - end.pos[3 * c + 1]!;
  const droppedY = end.pos[3 * d + 1]!;
  const speed = Math.hypot(end.linVel[3 * d]!, end.linVel[3 * d + 1]!, end.linVel[3 * d + 2]!);
  // The slab's top, 0.25 above its centre plane, at the cube's x, along the 10 degree tilt.
  const x = end.pos[3 * d]!, top = 3 + Math.tan((10 * Math.PI) / 180) * x + 0.25 / Math.cos((10 * Math.PI) / 180);
  const droppedRests = Math.abs(x) < 3 && droppedY > top && droppedY < top + 0.7 && speed < 1;
  return { pinMoved, pinSpeed, pinAwake, cubeDrop, droppedRests, droppedY };
}

/**
 * The frame test: a cube slides along a pinned slab whose top is at y = H, from v0; the reference is the same cube
 * on the ground plane moved up to y = H. Friction 0.5 on every surface. `pinned` false gives the reference.
 */
export const PIN_SLIDE_CASE = { H: 2, v0: 4, end: 90, cube: 0 } as const;

export function pinSlideScene(pinned: boolean): SceneDesc {
  const { H, v0 } = PIN_SLIDE_CASE;
  const cube = box([0.5, 0.5, 0.5], [-4, H + 0.5, 0], { linVel: [v0, 0, 0.5] });
  const slab = box([10, 0.5, 4], [0, H - 0.5, 0], { pinned: true });
  return {
    id: pinned ? 'pinned-slide' : 'pinned-slide-ground', params: {}, seed: 0, gravity: [0, -G, 0], dt: 1 / 60, sleep: false,
    ground: pinned ? { y: 0, friction: 0.5 } : { y: H, friction: 0.5 },
    bodies: pinned ? [cube, slab] : [cube], inputs: [],
  };
}

/** The cube's largest distance from the reference over the run, and the path it slid in the reference (m). */
export function pinSlideErrors(pinned: Snapshot[], ground: Snapshot[]): { diff: number; path: number } {
  let diff = 0, path = 0;
  for (let k = 0; k <= PIN_SLIDE_CASE.end; k++) {
    const p = pinned[k]!, g = ground[k]!;
    diff = Math.max(diff, Math.hypot(p.pos[0]! - g.pos[0]!, p.pos[1]! - g.pos[1]!, p.pos[2]! - g.pos[2]!));
    if (k > 0) path += Math.hypot(g.pos[0]! - ground[k - 1]!.pos[0]!, g.pos[2]! - ground[k - 1]!.pos[2]!);
  }
  return { diff, path };
}
