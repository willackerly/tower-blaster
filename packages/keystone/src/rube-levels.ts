// Rube Lab (M10, docs/game/rube-lab.md): contraption levels. A runner ball
// waits on a pinned trapdoor; the rack's one plunger fires a release charge
// (no blast: the trapdoor is taken out) and the ball rolls down a pinned ramp
// into whatever the player built in the build phase. The objective is a bell
// (objective kind 'bell'): a crown that must be hit (moved a quarter h) or
// must arrive in a sensor region. Scored par-style: the clear is binary, and
// the build's cost against the level's parts par is what the stars read
// (rubeStars). Everything here is plain level data in h; no joints (V6), so
// the vocabulary is balls, boxes, dominoes, fixed ramps and bumpers.
import type { Vec3 } from '@tb/engine-api';
import type { BuildDef, CatalogName } from './build.ts';
import type { BallPart, LevelDef, Objective, Part, PiecePart } from './level.ts';
import type { MaterialName } from './materials.ts';

/** Rounds to 1e-4 h: authored geometry made with trig is written out short, so a level reads the same everywhere. */
const r4 = (x: number) => Math.round(x * 1e4) / 1e4 + 0;

/** A pinned box (shelf, wall, trapdoor), centre and half-extents in h. */
export function fixed(at: Vec3, half: Vec3, material: MaterialName = 'stone', yaw = 0): PiecePart {
  return { kind: 'piece', at, half, ...(yaw ? { yaw } : {}), pinned: true, material };
}

/**
 * A pinned ramp whose top face's low end (its foot) is at `foot` (h), sloping down `deg` degrees toward
 * the heading `yaw` (0: toward +x; 90: toward -z, as pieceQuat turns +x), `length` h long along the slope,
 * `width` across and `thick` thick. Positions are rounded to 1e-4 h (r4): the trig runs once, here.
 */
export function rampTo(foot: Vec3, deg: number, length: number, opts: { yaw?: number; width?: number; thick?: number; material?: MaterialName } = {}): PiecePart {
  const th = (deg * Math.PI) / 180, t = opts.thick ?? 1 / 3, yaw = opts.yaw ?? 0, ya = (yaw * Math.PI) / 180;
  // In the ramp's unyawed frame (it descends toward +x): the top face's centre is half the length back up the
  // slope, and the body's centre half the thickness under it along the face's normal (sin th, cos th).
  const ox = -(length / 2) * Math.cos(th) - (t / 2) * Math.sin(th), oy = (length / 2) * Math.sin(th) - (t / 2) * Math.cos(th);
  // Turned by the yaw about +y: local +x goes to (cos, 0, -sin).
  const at: Vec3 = [r4(foot[0] + ox * Math.cos(ya)), r4(foot[1] + oy), r4(foot[2] - ox * Math.sin(ya))];
  return { kind: 'piece', at, half: [length / 2, t / 2, (opts.width ?? 1) / 2], ...(yaw ? { yaw } : {}), tilt: -deg, pinned: true, material: opts.material ?? 'stone' };
}

/** The runner: a 0.4 h stone ball (build.ts BALL_RADIUS) at `at`, optionally the level's bell (role crown). */
export function runner(at: Vec3, bell = false): BallPart {
  return { kind: 'ball', at, radius: 0.4, material: 'stone', ...(bell ? { role: 'crown' as const } : {}) };
}

/** A bell to hit: a crown domino (2 h tall, 1 h wide, 0.3 h thick) at `at` (its centre, h), turned by `yaw`. */
export function bellDomino(at: Vec3, yaw = 0): PiecePart {
  return { kind: 'piece', at, half: [0.5, 1, 0.15], ...(yaw ? { yaw } : {}), material: 'plaster', role: 'crown' };
}

export interface RubeSpec {
  id: string;
  name: string;
  /** Scenery and the bell; the trapdoor (the release charge's host) is added first, then the runner. */
  parts: Part[];
  /** The trapdoor's centre (h): a pinned 1.2 x 0.2 x 1.2 h stone slab; the runner sits on it. */
  trapdoor: Vec3;
  /** The runner's role: 'crown' makes it the bell (a region objective). */
  runnerBell?: boolean;
  objective: Extract<Objective, { kind: 'bell' }>;
  build: BuildDef & { budget: number; pieces: CatalogName[] };
  /** The least cost a bot found that clears (the parts par: rubeStars). */
  partsPar: number;
  /** Lot half-size in cells around the origin. */
  lot: [number, number, number, number];
}

/** The trapdoor's half-extents (h). */
export const TRAPDOOR_HALF: Vec3 = [0.6, 0.1, 0.6];

/**
 * A Rube Lab level from its spec: part 0 the pinned trapdoor (charge 0's host, a release), part 1 the runner
 * on it, then the spec's parts. Par scoring, one plunger, crowns are bells, nothing presettles but the bells.
 */
export function rubeLevel(s: RubeSpec): LevelDef {
  const [tx, ty, tz] = s.trapdoor;
  const parts: Part[] = [fixed(s.trapdoor, TRAPDOOR_HALF), runner([tx, r4(ty + TRAPDOOR_HALF[1] + 0.4), tz], s.runnerBell), ...s.parts];
  return {
    id: s.id, name: s.name, version: 1, world: 6, parts,
    lot: { min: [s.lot[0], s.lot[1]], max: [s.lot[2], s.lot[3]] },
    crownLine: 0, objective: s.objective, par: 1, rack: ['plunger'],
    launcher: { radius: 16, y: 2, dropY: 10 },
    // In the order a level file reads them back (viewer level-file.ts): the hash follows key order.
    build: s.build,
    charges: [{ host: 0, weapon: 'release' }],
    rube: { partsPar: s.partsPar },
  };
}

/**
 * Stars for a cleared Rube Lab level (docs/game/rube-lab.md, scoring): 3 at or under the parts par (what
 * the bot's cheapest clear cost), 2 within half again, 1 for any clear; 0 uncleared. Binary clear, no cast.
 */
export function rubeStars(cleared: boolean, spent: number, partsPar: number): 0 | 1 | 2 | 3 {
  if (!cleared) return 0;
  if (spent <= partsPar) return 3;
  if (spent <= Math.ceil(1.5 * partsPar)) return 2;
  return 1;
}

// ---- The gate's three puzzles (docs/game/rube-lab.md, the gate) ----

const GAP = 1.5, TOP = 3;
/**
 * RL1 Mind the Gap: the runner rolls along shelf A and must reach the far end of shelf B (the region, a
 * stop at its end), but a 1.5 h gap, 3 h deep, lies between them: too wide to hop (at 1 h the ball
 * crosses on its own). Fill it (a pier, flush with the shelves, leaves half-cell cracks the ball rolls
 * over) or span it (a slab, whose 0.25 h edge the ball climbs); a plank's 1/3 h step stops the ball,
 * and a cube in the bottom of the gap does nothing (the obvious wrong builds).
 */
export const RL1: LevelDef = rubeLevel({
  id: 'RL1', name: 'Mind the Gap', trapdoor: [-9.3, TOP + 1.6, 0], runnerBell: true,
  parts: [
    fixed([-6, TOP / 2, 0], [6, TOP / 2, 1.5]),
    fixed([GAP + 6, TOP / 2, 0], [6, TOP / 2, 1.5]),
    fixed([GAP + 12.25, TOP + 0.5, 0], [0.25, 0.5, 1.5]),
    rampTo([-4, TOP, 0], 12, 6, { width: 2 }),
  ],
  objective: { kind: 'bell', region: { min: [GAP + 4, TOP, -1.5], max: [GAP + 12, TOP + 3, 1.5] } },
  build: { budget: 6, pieces: ['cube', 'pier3', 'plank', 'slab', 'beam'], brush: false },
  partsPar: 2, lot: [-13, -4, 16, 4],
});

/**
 * RL2 Round the Corner: the runner rolls along +x into a backstop; the bell (a big light ball, 1.6 h
 * across, plaster) waits 6.5 h off to the side of the ball's line. Turn the ball (a wall or bumper at an angle) or carry the push round with a domino run.
 */
export const RL2: LevelDef = rubeLevel({
  id: 'RL2', name: 'Round the Corner', trapdoor: [-5.4, 1.7, 0],
  parts: [
    rampTo([0, 0, 0], 14, 6, { width: 2 }),
    fixed([18, 1, 0], [0.5, 1, 4]),
    { kind: 'ball', at: [12, 0.8, 6.5], radius: 0.8, material: 'plaster', role: 'crown' },
  ],
  objective: { kind: 'bell' },
  build: { budget: 12, pieces: ['domino', 'cube', 'beam', 'wall4x2', 'bumper'], brush: true },
  partsPar: 3, lot: [-8, -8, 20, 10],
});

/**
 * RL3 Top Shelf: the bell (a domino facing the ball) stands on a pinned shelf 1.5 h up; the runner arrives fast along the
 * ground and stops dead against the shelf's face. Roll it up a fixed ramp, or fell something tall onto
 * the bell; a stair of cubes stops the ball (the obvious wrong build).
 */
export const RL3: LevelDef = rubeLevel({
  id: 'RL3', name: 'Top Shelf', trapdoor: [-15.9, 6.3, 0],
  parts: [
    rampTo([0, 0, 0], 20, 6 / Math.sin((20 * Math.PI) / 180), { width: 2 }),
    fixed([14, 0.75, 0], [2, 0.75, 2]),
    bellDomino([12.6, 2.5, 0], 90),
  ],
  objective: { kind: 'bell' },
  build: { budget: 12, pieces: ['domino', 'cube', 'plank', 'pier3', 'ramp'], brush: true },
  partsPar: 3, lot: [-18, -6, 18, 6],
});

/** The gate's puzzles, in order. */
export const RUBE_GATE: readonly LevelDef[] = [RL1, RL2, RL3];
/** Rube Lab's series, in door order. */
export const RUBE_LEVELS: readonly LevelDef[] = [...RUBE_GATE];
