// Wavefront's Lay levels (M6, docs/game/wavefront.md): draw a domino run from the
// push to the bells with the brush (C9), on a budget. They play as contraptions
// (Rube Lab's rubeLevel): the Go button releases a ball down a fixed ramp, the
// ball knocks the first domino of the player's run, and every bell (a crown
// domino) must be hit. Stars read the build's cost against the parts par
// (build.par, rules.ts partsStars), which is the cheapest build Wavefront's Lay
// bot found by perturbing authored solutions (keystone-lab lay.ts).
//
// What building them found (Rapier, lay-levels.test.ts):
// - A fork is two strokes starting side by side, 0.6 h either side of the line,
//   one gap (1.1 h) past the parent's last domino. That gap is measured from the
//   last domino, not from the end of the parent's path: the brush lays a domino
//   every pitch (1.2 h) and stops short of the path's end by up to a pitch, so a
//   fork placed from the path's end can sit 2.3 h off and the wave dies there.
// - A fork holds when the parent runs straight into it for a few dominoes; the
//   ends of a hand-drawn run (where it starts, and the bell it runs to) are what
//   a player lines up on the ghost, and the route between is what varies.
import type { LevelDef, Part } from './level.ts';
import { bellDomino, fixed, rampTo, rubeLevel } from './rube-levels.ts';
import { DOMINO_HALF, DOMINO_PITCH, type P2, runCentres, smoothStroke } from './stroke.ts';

/** The fixed start of every Lay level: the trapdoor up the ramp, and the ramp, whose foot is at the origin heading +x. */
const TRAPDOOR: [number, number, number] = [-5.4, 1.7, 0];
const RAMP = rampTo([0, 0, 0], 14, 6, { width: 2 });

/** A Lay level from its scenery: a Rube Lab contraption in world 7 that sleeps on the GPU, its structure asleep. */
function layLevel(id: string, name: string, parts: Part[], budget: number, partsPar: number, lot: [number, number, number, number], extra: Partial<LevelDef> = {}): LevelDef {
  const base = rubeLevel({ id, name, trapdoor: TRAPDOOR, parts: [RAMP, ...parts], objective: { kind: 'bell' }, build: { budget, pieces: ['domino'], brush: true }, partsPar, lot });
  return { ...base, world: 7, physics: { sleep: true, asleep: true }, ...extra };
}

/**
 * W1 First Run: a wall stops the ball 6.5 h down the line, and the bell stands behind it. Lay a run from the
 * ramp's foot round either end of the wall to the bell. Straight into the wall, the wave dies there.
 */
export const W1: LevelDef = layLevel('W1', 'First Run', [fixed([7, 1, 0], [0.5, 1, 3]), bellDomino([12, 1, 0])], 30, 11, [-8, -8, 16, 8]);

/**
 * W2 Two Bells: one bell to the north and one to the south, the wall between them on the ball's line. One
 * run cannot ring both: fork it (a second and third stroke side by side off the end of the first).
 */
export const W2: LevelDef = layLevel('W2', 'Two Bells', [fixed([10, 1, 0], [0.5, 1, 2]), bellDomino([13, 1, 7]), bellDomino([13, 1, -7])], 50, 19, [-8, -10, 16, 10]);

/** A pre-laid domino run (authored, not placed) along a brush path. */
const run = (pts: P2[]): Part & { kind: 'run' } => ({ kind: 'run', path: smoothStroke(pts), pitch: DOMINO_PITCH, half: [...DOMINO_HALF], material: 'plaster' });
/** The last domino's centre of a run. */
const lastOf = (p: { path: P2[] }): P2 => runCentres(p.path, DOMINO_PITCH).at(-1)!;

/** The Orchard's shape: a fork's gap past the parent's last domino and its side offset; its branches' straight runs before the next fork, and the leaves' length (h). */
export const ORCHARD = { gap: 1.1, side: 0.6, straight: 12, leaf: 48, spread: 12, depth: 4 } as const;

/**
 * The Orchard's field: a trunk, then a binary tree of forks four deep (each branch curves out half as far as its
 * parent's), sixteen leaves running 48 h to a bell each. About 1,000 dominoes; the wave reaches every bell in
 * about 32 s on Rapier. Pure + - * / sqrt (smoothStroke, runCentres), so the bodies hash the same everywhere.
 */
export function orchardField(trunkFrom: P2 = [24, 0], trunkTo: P2 = [36, 0]): { runs: Part[]; bells: Part[] } {
  const runs: Part[] = [], bells: Part[] = [];
  const o = ORCHARD;
  const grow = ([px, pz]: P2, d: number, depth: number) => {
    const x = px + o.gap;
    for (const s of [1, -1]) {
      const L = Math.max(2.2 * d, 4);
      const r = run([[x, pz + s * o.side], [x + 1.2, pz + s * (o.side + 0.3)], [x + L * 0.5, pz + s * d * 0.7], [x + L, pz + s * d], [x + L + (depth === 1 ? o.leaf : o.straight), pz + s * d]]);
      runs.push(r);
      const end = lastOf(r);
      if (depth === 1) bells.push(bellDomino([Math.round((end[0] + DOMINO_PITCH) * 1e3) / 1e3, 1, Math.round(end[1] * 1e3) / 1e3]));
      else grow(end, d / 2, depth - 1);
    }
  };
  const trunk = run([trunkFrom, trunkTo]);
  runs.push(trunk);
  grow(lastOf(trunk), o.spread, o.depth);
  return { runs, bells };
}

/** Where the Orchard's pre-laid trunk starts: the player's run must reach it from the ramp, round the wall. */
export const ORCHARD_TRUNK: P2 = [24, 0];

/**
 * W6 Orchard (Lay at 1k): a field of about 1,000 dominoes, forking four times into sixteen bells, waits behind a
 * wall on the ball's line. Lay the run from the ramp round the wall to the field's trunk; one bell left standing
 * fails the level, so the field is a 1k-domino test of every fork. Asleep from the start, in a 60 s window.
 */
const orchard = orchardField(ORCHARD_TRUNK);
export const W6: LevelDef = layLevel('W6', 'Orchard', [fixed([8, 1, 0], [0.5, 1, 3]), ...orchard.runs, ...orchard.bells], 40, 21, [-8, -26, 140, 26], { runWindow: 60 });

/** The Lay levels, in door order among Wavefront's. */
export const LAY_LEVELS: readonly LevelDef[] = [W1, W2, W6];
