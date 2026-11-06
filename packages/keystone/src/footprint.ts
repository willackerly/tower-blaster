// Footprints (docs/design/grid.md, capability C11, for M5 Fuse & Fold): where
// a structure's mass ended up against where it stood. A grid on the level's
// lattice (lotGrid), the cells a group of bodies covers at home grown by k
// cells (the target mask), and the facts a goal reads off the end snapshot:
// spill (mass share whose centre left the mask), fill and IoU of the covered
// cells, reach (how many cells beyond the mask rubble lies) and rubble height.
// The reductions are @tb/engine-api's exact integer grid, so a later GPU path
// gives the same answers.
//
// Like groups.ts, a footprint is not part of a level: a lot sheet (or a mode)
// names one, so adding it never changes a level's hash or drops its stars.
import { dilate, emptySnapshot, type GridResult, type GridSpec, gridMetres, maskScore, reduceGrid, type Snapshot } from '@tb/engine-api';
import { type GroupSel, selectGroup } from './groups.ts';
import type { CompiledLevel } from './level.ts';

/** Grid options: res sub-cells per lattice cell on each axis (1 to 4), margin lattice cells around the lot (0 to 16). */
export interface LotGridOpts { res?: number; margin?: number }

/**
 * A plan-view grid on the level's lattice: grid cells are lattice cells (cell i spans [i, i + 1)
 * pitches, so a cube at home sits in one), covering the lot (whose corners are lattice cell edges)
 * grown by `margin` cells (default 4: rubble that leaves the lot is still seen).
 */
export function lotGrid(c: CompiledLevel, { res = 1, margin = 4 }: LotGridOpts = {}): GridSpec {
  if (!(Number.isInteger(res) && res >= 1 && res <= 4)) throw new RangeError(`lotGrid: res must be 1 to 4, got ${res}`);
  if (!(Number.isInteger(margin) && margin >= 0 && margin <= 16)) throw new RangeError(`lotGrid: margin must be 0 to 16, got ${margin}`);
  const p = c.frame.pitch * c.frame.unit, { min, max } = c.def.lot;
  return {
    origin: [(min[0] - margin) * p, (min[1] - margin) * p],
    cell: [p / res, p / res],
    n: [(max[0] - min[0] + 2 * margin) * res, (max[1] - min[1] + 2 * margin) * res],
    axes: [0, 2],
  };
}

/** The structure at home: the authored poses (or `home`, 3 per structure body) as a snapshot of the level's scene. */
export function homeSnapshot(c: CompiledLevel, home: ArrayLike<number> = c.meta.home): Snapshot {
  const n = c.meta.n, s = emptySnapshot(n);
  for (let i = 0; i < n; i++) {
    s.pos.set([home[3 * i]!, home[3 * i + 1]!, home[3 * i + 2]!], 3 * i);
    s.rot.set(c.scene.bodies[i]!.rot, 4 * i);
  }
  return s;
}

/** Integer grams per structure body: the weight spill is measured in. */
export function gramsOf(c: CompiledLevel): Float64Array {
  return Float64Array.from(c.meta.mass, (m) => Math.round(m * 1000));
}

/**
 * A footprint a lot sheet names: the bodies of one of its groups (default the whole structure), the
 * mask of the cells they cover at home grown by `grow` lattice cells (0 to 8, default 1: probe X2's
 * skill gate), on lotGrid(res, margin).
 */
export interface FootprintDef { group?: string; grow?: number; res?: number; margin?: number }

/** A footprint ready to judge: its bodies, grid, mask and weights. */
export interface Footprint { idx: Int32Array; grid: GridSpec; mask: Uint8Array; grams: Float64Array; res: number }

/** Facts of a footprint at one snapshot. Shares are 0 to 1, reach in lattice cells, heights in h. */
export const FOOTPRINT_FACTS = ['spill', 'fill', 'iou', 'reach', 'height', 'heightOut'] as const;
export type FootprintFact = (typeof FOOTPRINT_FACTS)[number];
export type FootprintFacts = Record<FootprintFact, number>;

/** Throws unless def is well formed against the sheet's group names, naming `where` and the field at fault. */
export function checkFootprint(def: FootprintDef, groups: readonly string[], where = 'footprint'): void {
  for (const k of Object.keys(def)) if (!['group', 'grow', 'res', 'margin'].includes(k)) throw new Error(`${where}: unknown field ${k}`);
  if (def.group !== undefined && !groups.includes(def.group)) throw new Error(`${where}.group: no group ${def.group} in the sheet`);
  if (def.grow !== undefined && !(Number.isInteger(def.grow) && def.grow >= 0 && def.grow <= 8)) throw new Error(`${where}.grow: must be an integer 0 to 8, got ${def.grow}`);
  if (def.res !== undefined && !(Number.isInteger(def.res) && def.res >= 1 && def.res <= 4)) throw new Error(`${where}.res: must be an integer 1 to 4, got ${def.res}`);
  if (def.margin !== undefined && !(Number.isInteger(def.margin) && def.margin >= 0 && def.margin <= 16)) throw new Error(`${where}.margin: must be an integer 0 to 16, got ${def.margin}`);
}

/** The footprint of the bodies idx: lotGrid(opts), their home cover grown by `grow` lattice cells. */
export function makeFootprint(c: CompiledLevel, idx: Int32Array, grow = 1, opts: LotGridOpts = {}, home?: ArrayLike<number>): Footprint {
  const res = opts.res ?? 1, grid = lotGrid(c, opts), grams = gramsOf(c), [nu, nv] = grid.n;
  if (!idx.length) throw new Error('footprint: holds no bodies');
  const shapes = c.scene.bodies.map((b) => b.shape);
  const at = reduceGrid(grid, { snap: homeSnapshot(c, home), shapes, ids: idx });
  const covered = Uint8Array.from(at.cover, (k) => (k > 0 ? 1 : 0));
  return { idx, grid, mask: dilate(covered, nu, nv, grow * res), grams, res };
}

/** Selects every footprint a sheet names (`groups` from its GroupSels), naming the footprint in any error. */
export function selectFootprints(c: CompiledLevel, sheet: { groups?: Record<string, GroupSel>; footprints?: Record<string, FootprintDef> }): Record<string, Footprint> {
  const groups = sheet.groups ?? {}, names = Object.keys(groups);
  return Object.fromEntries(Object.entries(sheet.footprints ?? {}).map(([k, def]) => {
    const where = `footprints.${k}`;
    checkFootprint(def, names, where);
    const idx = def.group === undefined ? Int32Array.from({ length: c.meta.n }, (_, i) => i) : selectGroup(c, groups[def.group]!, `groups.${def.group}`);
    return [k, makeFootprint(c, idx, def.grow ?? 1, { res: def.res, margin: def.margin })];
  }));
}

/** The grid of a footprint's bodies in snapshot s (removed bodies skipped, ammo never counted). */
export function footprintGrid(c: CompiledLevel, f: Footprint, s: Snapshot): GridResult {
  return reduceGrid(f.grid, { snap: s, shapes: c.scene.bodies.map((b) => b.shape), ids: f.idx, weight: f.grams });
}

/** What a footprint reads in snapshot s. */
export function footprintFacts(c: CompiledLevel, f: Footprint, s: Snapshot): FootprintFacts {
  const g = footprintGrid(c, f, s), sc = maskScore(g, f.mask), h = c.frame.unit;
  const inH = gridMetres(sc.topIn, g.s), outH = gridMetres(sc.topOut, g.s);
  return {
    spill: sc.spill, fill: sc.fill, iou: sc.iou, reach: sc.reach / f.res,
    height: Math.max(inH ?? 0, outH ?? 0) / h, heightOut: (outH ?? 0) / h,
  };
}
