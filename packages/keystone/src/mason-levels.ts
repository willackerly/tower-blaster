// Mason's Trial's levels (M8, docs/game/masons-trial.md). Each is scenery
// (pinned cliffs, tables and walls: C8 via M10's pinned pieces), what the build
// protects (heritage) and a test (mason.ts MasonDef): a ball rolled over the
// gap, debris dropped on the shelter, boulders rolled at the berm, a weight
// dropped on the reach, the ground shaken under the bell tower. Lengths in h. The star points come from the author
// solutions (keystone-lab mason-solutions.ts), whose test re-derives them.
import type { Vec3 } from '@tb/engine-api';
import type { BuildDef, CatalogName } from './build.ts';
import type { LevelDef, Part, PiecePart } from './level.ts';
import type { MasonDef } from './mason.ts';
import type { MaterialName } from './materials.ts';
import { masonQuakeOf } from './mason.ts';
import { RETROFIT_QUAKE } from './aftershock-levels.ts';

/** A pinned box (cliff, table, wall), centre and half-extents in h. */
const fixed = (at: Vec3, half: Vec3, material: MaterialName = 'stone'): PiecePart => ({ kind: 'piece', at, half, pinned: true, material });
/** A heritage piece: what the build must keep from moving. */
const ward = (at: Vec3, half: Vec3 = [0.5, 0.5, 0.5]): PiecePart => ({ kind: 'piece', at, half, material: 'plaster', role: 'heritage' });

export interface MasonSpec {
  id: string;
  name: string;
  parts: Part[];
  build: BuildDef & { budget: number; pieces: CatalogName[] };
  mason: MasonDef;
  /** Lot half-size in cells around the origin. */
  lot: [number, number, number, number];
}

/** A Mason level from its spec: no rack (the test takes its place), the objective a trial, the build phase on. */
export function masonLevel(s: MasonSpec): LevelDef {
  return {
    id: s.id, name: s.name, version: 1, world: 6, parts: s.parts,
    lot: { min: [s.lot[0], s.lot[1]], max: [s.lot[2], s.lot[3]] },
    crownLine: 0, objective: { kind: 'trial' }, par: 0, rack: [],
    launcher: { radius: 16, y: 2, dropY: 10 },
    build: s.build,
    mason: s.mason,
  };
}

const CLIFF = 3, GAP = 4;
/**
 * MT1 Corbel Bridge: a 4 h gap between two pinned ledges 1 h wide and 3 h high. A stone ball rolls along an approach
 * flush with a slab laid on the left ledge (3.25 h) and must cross to the lower exit (2.5 h) beyond and stay up. A
 * piece goes where the pointer is, so nothing is laid across the gap in one go: slabs cantilevered from each
 * ledge tip unless weighted at the back (corbels), or piers stand in the gap. Every step on the ball's way is
 * down: a rolled ball does not climb a slab's edge at this speed.
 */
export const MT1: LevelDef = masonLevel({
  id: 'MT1', name: 'Corbel Bridge',
  parts: [
    fixed([-6.5, 1.625, 0], [5.5, 1.625, 2]),
    fixed([-0.5, CLIFF / 2, 0], [0.5, CLIFF / 2, 2]),
    fixed([GAP + 0.5, CLIFF / 2, 0], [0.5, CLIFF / 2, 2]),
    fixed([GAP + 6, 1.25, 0], [5, 1.25, 2]),
    fixed([GAP + 10.5, 3, 0], [0.5, 0.5, 2]),
  ],
  build: { budget: 12, pieces: ['cube', 'slab', 'beam', 'plank', 'pier3', 'course4'], brush: false },
  mason: {
    test: 'roll', run: 420,
    probes: [{ kind: 'ball', at: [-8, 3.25 + 0.45 + 1e-3, 0], radius: 0.45, vel: [5, 0, 0], material: 'stone' }],
    jitter: { probe: 0.04 },
    pass: [
      { who: 'probe', test: 'advanced', dir: '+x', d: GAP + 10, atLeast: 1 },
      { who: 'probe', test: 'dropped', d: 2.25, atMost: 0 },
    ],
    stars: [420, 630],
  },
  lot: [-12, -4, 18, 4],
});

/**
 * MT2 Shelter: a heritage urn on the ground; a collapse (eight stone blocks) falls on it from 8 h. Roof it so the urn
 * does not move a quarter h.
 */
export const MT2: LevelDef = masonLevel({
  id: 'MT2', name: 'Shelter',
  parts: [ward([0, 0.8, 0], [0.3, 0.8, 0.3])],
  build: { budget: 12, pieces: ['cube', 'slab', 'beam', 'plank', 'pier3', 'course4'], brush: false },
  mason: {
    test: 'drop', run: 300,
    probes: ([[0.15, 8, 0.1], [-0.7, 9.2, 0.55], [0.75, 10.4, -0.6], [0.55, 11.6, 0.8], [-0.6, 12.8, -0.7]] as Vec3[]).map((at) => ({ kind: 'box' as const, at, half: [0.5, 0.5, 0.5] as Vec3, vel: [0, -2, 0] as Vec3, material: 'stone' as const })),
    pass: [{ who: 'heritage', test: 'moved', d: 0.25, atMost: 0 }],
    stars: [550, 600],
  },
  lot: [-6, -6, 6, 6],
});

/**
 * MT3 Berm: two heritage huts; five boulders roll at them across the plain. Build a berm that turns or stops them.
 */
export const MT3: LevelDef = masonLevel({
  id: 'MT3', name: 'Berm',
  parts: [ward([2, 0.5, -1.5]), ward([2, 0.5, 1.5])],
  build: { budget: 16, pieces: ['cube', 'beam', 'course4', 'wall4x2', 'pier3', 'slab'], brush: false },
  mason: {
    test: 'flood', run: 360,
    probes: [[-14, -2.5], [-16, 0], [-18, 2.5], [-20, -1], [-22, 1.5]].map(([x, z]) => ({ kind: 'ball' as const, at: [x!, 0.7 + 1e-3, z!] as Vec3, radius: 0.7, vel: [10, 0, 0] as Vec3, material: 'stone' as const })),
    pass: [{ who: 'heritage', test: 'moved', d: 0.25, atMost: 0 }],
    stars: [450, 670],
  },
  lot: [-24, -6, 8, 6],
});

/**
 * MT4 Overhang Reach: a pinned table 3 h high ends at x = 0; a stone weight will drop at x = 2.5, 1.6 h above it. Reach
 * out under it and catch it (it must not fall to the floor).
 */
export const MT4: LevelDef = masonLevel({
  id: 'MT4', name: 'Overhang Reach',
  parts: [fixed([-4, CLIFF / 2, 0], [4, CLIFF / 2, 2])],
  build: { budget: 10, pieces: ['cube', 'slab', 'beam', 'plank', 'course4'], brush: false },
  mason: {
    test: 'reach', run: 240,
    probes: [{ kind: 'box', at: [2.5, 4.6, 0], half: [0.4, 0.4, 0.4], material: 'plaster' }],
    pass: [{ who: 'probe', test: 'dropped', d: 2.25, atMost: 0 }],
    stars: [630, 670],
  },
  lot: [-8, -4, 8, 4],
});

/** A plain piece of masonry (the column's lower courses), centre and half-extents in h. */
const course = (at: Vec3, half: Vec3 = [0.5, 0.5, 0.5]): PiecePart => ({ kind: 'piece', at, half, material: 'plaster' });

/**
 * MT5 Bell Tower: a tower of six plaster cubes on open ground, its bell (the top cube) the heritage, and the test is
 * Aftershock's retrofit quake (RETROFIT_QUAKE: 0.3 g at 1 Hz for 1 s, here along x; one profile for both modes,
 * masonQuakeOf). The bell must not move half a cell. Bare, the tower falls on every world: the quake's strong swing
 * throws it toward -x. A pier of three against it on that side is enough (the clever build: read which way the bare
 * tower falls); a pier on each side is the plain one. A pier on the +x side, or one half a cell off the tower, mostly
 * fails: the tower falls away from the first and rocks into the second hard enough to knock it over. Only the placed
 * pieces are jittered (the quake is world-wide), so the spread across worlds is the build's own.
 */
export const MT5: LevelDef = masonLevel({
  id: 'MT5', name: 'Bell Tower',
  parts: [...[0, 1, 2, 3, 4].map((k) => course([0, 0.5 + k, 0])), ward([0, 5.5, 0])],
  build: { budget: 10, pieces: ['cube', 'slab', 'beam', 'plank', 'pier3', 'course4'], brush: false },
  mason: {
    test: 'quake', run: 180, probes: [],
    quake: masonQuakeOf({ ...RETROFIT_QUAKE, axis: 0 }),
    pass: [{ who: 'heritage', test: 'moved', d: 0.5, atMost: 0 }],
    stars: [630, 760],
  },
  lot: [-6, -4, 6, 4],
});

/** Mason's Trial's series, in door order. */
export const MASON_LEVELS: readonly LevelDef[] = [MT1, MT2, MT3, MT4, MT5];
