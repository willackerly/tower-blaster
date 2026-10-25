// The six loose-stack behaviours puzzles are built from, each as a tiny level
// with a nominal shot and an outcome test. The grammar is "loose lattice":
// cubes rest on the cube below and columns 1 cm apart do not touch, so
// columns are independent and only slabs couple them.
import { type CompiledLevel, type LevelDef, type Shot, aimAt, compileLevel } from '@tb/keystone';
import type { ProbeCase } from './probe.ts';
import type { PlayResult } from './runner.ts';

type V3 = [number, number, number];

const base = (id: string, parts: LevelDef['parts'], extra: Partial<LevelDef> = {}): LevelDef => ({
  id, name: id, version: 1, world: 0, parts, lot: { min: [-12, -12], max: [12, 12] }, crownLine: 2,
  objective: { kind: 'crowns' }, par: 1, rack: ['marble', 'cannonball', 'cue', 'drop'], launcher: { radius: 14, y: 2, dropY: 12 }, ...extra,
});

/** Settled-home to final displacement of body i, in h. */
export function moved(r: PlayResult, c: CompiledLevel, i: number): V3 {
  const h = c.frame.unit, s = r.snapshot, home = r.session.home;
  return [0, 1, 2].map((k) => (s.pos[3 * i + k]! - home[3 * i + k]!) / h) as V3;
}
const norm = (v: V3) => Math.hypot(...v);

/** Structure bodies of a part, optionally on course k (by authored height). */
export function bodies(c: CompiledLevel, part: number, course?: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.meta.n; i++) {
    if (c.meta.part[i] !== part) continue;
    if (course !== undefined && Math.floor(c.meta.home[3 * i + 1]! / c.frame.unit) !== course) continue;
    out.push(i);
  }
  return out;
}
/** Of those, the one whose home x (in cells) is closest to cx. */
const atX = (c: CompiledLevel, ids: number[], cx: number) => ids.reduce((b, i) => (Math.abs(c.meta.home[3 * i]! / (c.frame.unit * c.frame.pitch) - cx) < Math.abs(c.meta.home[3 * b]! / (c.frame.unit * c.frame.pitch) - cx) ? i : b));
const crownsDown = (r: PlayResult) => r.session.crownDown.reduce((a, x) => a + x, 0);

/** Rapier integrates in one substep per solver iteration (4 by default). */
export const RAPIER_SUBSTEPS = 4;

/**
 * Aim a launch shot from azimuth az (0.5 deg) at a point given in cells
 * (x, y, z), for an engine integrating in `substeps` substeps per step.
 */
export function aimCells(level: LevelDef, ammo: 'marble' | 'cannonball', az: number, at: V3, power = 100, y = 8, substeps = RAPIER_SUBSTEPS): Shot {
  const c = compileLevel(level), h = c.frame.unit, p = h * c.frame.pitch;
  return aimAt(c.frame, ammo, { az, y, power }, [at[0] * p, at[1] * h, at[2] * p], { substeps }).shot;
}

// B1. Knock one cube out of the bottom of a wall: the column above drops one
// course and stays upright. A marble works where a cue doesn't: the rod stays
// in the slot it opened and the column lands on it.
const B1L = base('B1', [{ kind: 'block', at: [-1.5, 0, -0.5], size: [3, 6, 1], material: 'plaster' }]);
export const B1: ProbeCase = {
  id: 'B1', title: 'Column drop: knock a cube out, the column above drops one course', level: B1L,
  shots: (n) => [aimCells(B1L, 'marble', 540, [0, 1.5, -0.5], 100, 6, n)],
  success(r, c) {
    const target = atX(c, bodies(c, 0, 1), 0);
    if (norm(moved(r, c, target)) < 0.6) return false;
    for (let k = 2; k < 6; k++) {
      const d = moved(r, c, atX(c, bodies(c, 0, k), 0));
      if (Math.abs(d[1] + 1) > 0.25 || Math.hypot(d[0], d[2]) > 0.35) return false;
    }
    return [-1, 1].every((x) => bodies(c, 0).filter((i) => Math.abs(c.meta.home[3 * i]! / (c.frame.unit * c.frame.pitch) - x) < 0.1).every((i) => norm(moved(r, c, i)) < 0.2));
  },
};

// B2. A cannonball low on a slender tower shears it; the top comes down.
const B2L = base('B2', [{ kind: 'block', at: [-1, 0, -1], size: [2, 10, 2], material: 'plaster', courses: [{ k: 9, role: 'crown' }] }]);
export const B2: ProbeCase = {
  id: 'B2', title: 'Shear: a low cannonball brings a slender tower down', level: B2L,
  shots: (n) => [aimCells(B2L, 'cannonball', 360, [-1, 3.5, 0], 100, 8, n)],
  success: (r) => crownsDown(r) === 4,
};

// B3. Pick-off: a marble takes the crown off the top of a wall between two
// heritage cubes without touching them.
const B3L = base('B3', [{ kind: 'block', at: [-1.5, 0, -0.5], size: [3, 8, 1], material: 'plaster', courses: [{ k: 7, role: 'heritage' }, { k: 7, cells: [[1, 0]], role: 'crown' }] }]);
export const B3: ProbeCase = {
  id: 'B3', title: 'Pick-off: a marble takes the crown from between two heritage cubes', level: B3L,
  shots: (n) => [aimCells(B3L, 'marble', 540, [0, 7.5, -0.5], 100, 30, n)],
  success: (r) => crownsDown(r) === 1 && r.session.heritageBroken.every((x) => !x),
};

// B4. A lintel on two columns: take the top off one column and the lintel tips, shedding its crowns.
const B4L = base('B4', [
  { kind: 'block', at: [-4, 0, -1], size: [2, 12, 2], material: 'plaster' },
  { kind: 'block', at: [2, 0, -1], size: [2, 12, 2], material: 'plaster' },
  { kind: 'slab', at: [0, 12, 0], half: [4, 0.125, 1], material: 'stone' },
  { kind: 'block', at: [-1.5, 12.25, -1], size: [3, 1, 2], material: 'plaster', role: 'crown' },
]);
export const B4: ProbeCase = {
  id: 'B4', title: 'Lintel tip: fell one column and the lintel sheds its load', level: B4L,
  shots: (n) => [aimCells(B4L, 'cannonball', 0, [4, 9.5, 0], 100, 8, n)],
  success: (r) => crownsDown(r) >= 5,
};

// B5. A catapult: a slab on a central pier, its crown end resting on a prop.
// Drop an anvil on the free end and the crown end flips up and throws them.
const B5L = base('B5', [
  { kind: 'block', at: [5.5, 0, -1.5], size: [1, 4, 3], material: 'plaster' },
  { kind: 'block', at: [11, 0, -0.5], size: [1, 4, 1], material: 'plaster' },
  { kind: 'slab', at: [6, 4, 0], half: [6, 0.125, 1.5], material: 'plaster' },
  { kind: 'block', at: [9, 4.25, -1.5], size: [3, 1, 3], material: 'plaster', role: 'crown' },
], { lot: { min: [-3, -6], max: [14, 6] } });
export const B5: ProbeCase = {
  id: 'B5', title: 'Catapult: an anvil on the free end throws the crowns off the other', level: B5L,
  shots: () => [{ ammo: 'drop', x: 2, z: 0 }],
  success: (r) => crownsDown(r) >= 7,
};

// B6. Dominoes: topple the first slender column into the next; the crown on the last one falls.
const B6L = base('B6', [0, 1, 2, 3, 4].map((k) => ({ kind: 'block' as const, at: [-8 + 4 * k, 0, -0.5] as V3, size: [1, 9, 1] as V3, material: 'plaster' as const, courses: k === 4 ? [{ k: 8, role: 'crown' as const }] : [] })), { lot: { min: [-14, -8], max: [14, 8] } });
export const B6: ProbeCase = {
  id: 'B6', title: 'Dominoes: a toppling column knocks the next one over', level: B6L,
  shots: (n) => [aimCells(B6L, 'marble', 360, [-8, 7.5, 0], 100, 8, n)],
  success: (r) => crownsDown(r) === 1,
};

export const CASES: readonly ProbeCase[] = [B1, B2, B3, B4, B5, B6];
