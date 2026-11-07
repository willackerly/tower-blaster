// Rube Lab's recorded builds (M10, docs/game/rube-lab.md): for each gate puzzle, one
// build program per solution family the gate search found robust (rube-gate.ts, at
// least 6 of 8 nudged builds clear on the reference), the cheapest of its family, and
// the obvious wrong builds that must fail. Programs, not part lists: each one goes
// through the real build tool (BuildSession: face hits, snap, overlap and budget), so
// a test that replays them checks the bin as well as the level. The tests replay them
// on the reference (test/rube.test.ts) and on the GPU (test/rube-gpu-RL*.test.ts).
import type { BuildSession, Hit, P2 } from '@tb/keystone';
import { type BuildStep, ground, top } from './rube.ts';

export interface RubeBuild { label: string; family: string; steps: BuildStep[] | ((s: BuildSession) => BuildStep[]) }

/** A straight mouse stroke from (x0, z0) to (x1, z1) h, sampled every 2%. */
export const line = (x0: number, z0: number, x1: number, z1: number): P2[] => {
  const p: P2[] = [];
  for (let i = 0; i <= 50; i++) p.push([x0 + ((x1 - x0) * i) / 50, z0 + ((z1 - z0) * i) / 50]);
  return p;
};

/** A quarter-ellipse stroke from (x0, z0) heading +x to (x1, z1) heading +z or -z, sampled as a mouse would. */
export function arc(x0: number, z0: number, x1: number, z1: number): P2[] {
  const p: P2[] = [];
  for (let i = 0; i <= 100; i++) { const a = (i / 100) * (Math.PI / 2); p.push([x0 + (x1 - x0) * Math.sin(a), z0 + (z1 - z0) * (1 - Math.cos(a))]); }
  return p;
}

/** One robust build per family, by level id (the first of each list is the cheapest: the level's parts par). */
export const RUBE_SOLUTIONS: Record<string, RubeBuild[]> = {
  RL1: [
    { label: 'a slab laid from shelf A, overhanging the gap', family: 'span', steps: (s) => [{ place: 'slab', hit: top(s, 2, -0.5, 0) }] },
    { label: 'a pier of three standing in the gap, flush with the shelves', family: 'fill', steps: (s) => [{ place: 'pier3', hit: ground(s, 0.5, 0) }] },
  ],
  RL2: [
    { label: 'a fixed bumper at -45 degrees on the ball’s line', family: 'turn', steps: (s) => [{ place: 'bumper', hit: ground(s, 6, 0), yaw: -45 }] },
    { label: 'a domino run curving from the ball’s line to the bell', family: 'relay', steps: [{ stroke: arc(3, 0, 11, 5) }] },
  ],
  RL3: [
    { label: 'a fixed ramp up onto the shelf', family: 'ramp', steps: (s) => [{ place: 'ramp', hit: ground(s, 7, 0) }] },
    { label: 'a domino run into a plank on end, which falls onto the bell', family: 'topple', steps: (s) => [{ place: 'plank', hit: ground(s, 9, 0), tip: 1 }, { stroke: line(3, 0, 9 - 0.9 - 0.2, 0) }] },
  ],
};

/** The obvious wrong builds, by level id: every one must fail. */
export const RUBE_WRONG: Record<string, RubeBuild[]> = {
  RL1: [
    { label: 'nothing (the ball cannot jump the gap)', family: 'none', steps: [] },
    { label: 'a plank laid across from shelf A (its 1/3 h step is too tall for the ball)', family: 'span', steps: (s) => [{ place: 'plank', hit: top(s, 2, -0.1, 0) }] },
    { label: 'a cube in the bottom of the gap', family: 'fill', steps: (s) => [{ place: 'cube', hit: ground(s, 0.75, 0) }] },
  ],
  RL2: [
    { label: 'nothing (the ball runs into the backstop)', family: 'none', steps: [] },
    { label: 'a straight run along the ball’s line (it runs into the backstop)', family: 'relay', steps: [{ stroke: line(4, 0, 14, 0) }] },
  ],
  RL3: [
    { label: 'nothing (the ball stops at the shelf)', family: 'none', steps: [] },
    {
      label: 'a stair of cubes (the ball cannot climb steps)', family: 'stairs',
      // Steps 1 h, 2 h, 2 h up to the 1.5 h shelf: each second cube sits on the one placed just before it (body n + 1, n + 3).
      steps: (s) => {
        const n = s.compiled().meta.n, on = (b: number, x: number): Hit => ({ body: b, point: [x * s.h, s.h, 0], normal: [0, 1, 0], t: 0 });
        return [{ place: 'cube', hit: ground(s, 9, 0) }, { place: 'cube', hit: ground(s, 10, 0) }, { place: 'cube', hit: on(n + 1, 10) }, { place: 'cube', hit: ground(s, 11, 0) }, { place: 'cube', hit: on(n + 3, 11) }];
      },
    },
  ],
};
