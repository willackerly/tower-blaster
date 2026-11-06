// Grid reductions (docs/design/grid.md, capability C11): occupancy, heightmap
// and projection histograms of a snapshot on a 2-D grid, and the distance of
// what landed from a target mask (fill, spill, IoU, reach). Pure TS and
// integer throughout, on the reduce spec's fixed point (observe.ts quant and
// aabb extent), so any order, and a later GPU path with integer atomics, gives
// the same answer bit for bit.
import { extentQ, quant, type Scale } from './observe.ts';
import type { ShapeDesc, Snapshot } from './index.ts';
import { TIER_FREE } from './remove.ts';

export interface GridSpec {
  /** Low corner of cell (0, 0) on the grid's two axes, metres. */
  origin: readonly [number, number];
  /** Cell size on each axis, metres; quant(cell, s) must be at least 1. */
  cell: readonly [number, number];
  /** Cells on each axis, 1..MAX_GRID_SIDE, at most MAX_GRID_CELLS in all. */
  n: readonly [number, number];
  /** The two world axes the grid lies on, distinct (default [0, 2], a plan view). The third is depth: the heightmap's axis. */
  axes?: readonly [0 | 1 | 2, 0 | 1 | 2];
  /** Fixed-point exponent, 0..24 (default 16). */
  s?: Scale;
}

export const MAX_GRID_SIDE = 1024;
export const MAX_GRID_CELLS = 2 ** 18;
/** top[] of a cell no body covers: i32 min, the identity of a GPU atomicMax. */
export const EMPTY_TOP = -(2 ** 31);
const MAX_WEIGHT = 2 ** 31;

export interface GridInput {
  snap: Snapshot;
  /** Per id; only the ids reduced are read. */
  shapes: readonly ShapeDesc[];
  /** The bodies to reduce, each in 0 .. count − 1 (default all). A repeated id counts each time. */
  ids?: ArrayLike<number>;
  /** Per id (indexed by id, not by position in ids): an integer in [0, 2^31) (default 1 each). */
  weight?: ArrayLike<number>;
}

export interface Tally { n: number; weight: number }

export interface GridResult {
  /** The spec with defaults applied, and its fixed-point origin and cell. */
  axes: [number, number, number];
  s: number;
  n: [number, number];
  O: [number, number];
  C: [number, number];
  /** Per cell, k = j·n_u + i: bodies whose centre lies in it, and their weight. */
  count: Uint32Array;
  weight: Float64Array;
  /** Per cell: bodies whose AABB's half-open footprint [lo, hi) meets it. */
  cover: Uint32Array;
  /** Per cell: the highest AABB face on the depth axis among covering bodies, fixed point (EMPTY_TOP when none). */
  top: Int32Array;
  /** Centre counts and weights per column (u) and per row (v), over bodies inside that axis's range whatever the other says. */
  projU: { count: Uint32Array; weight: Float64Array };
  projV: { count: Uint32Array; weight: Float64Array };
  /** Valid bodies reduced (inside + outside). */
  total: Tally;
  /** Valid bodies whose centre is off the grid. */
  outside: Tally;
  /** Bodies with ⊥ in a quantity they need (NaN, infinite, beyond the fixed-point range). */
  invalid: number;
  /** Bodies skipped because their tier is TIER_FREE (removed). */
  removed: number;
}

const isInt = Number.isInteger;

/**
 * ⌊a / c⌋ for integers |a| < 2^31, 1 ≤ c < 2^29. The f64 quotient is already exact enough: when c does
 * not divide a, a / c sits at least 1/c from the next integer k, and rounding could only reach k if
 * 1/c < k·2^-53, i.e. |a| ≈ c·k > 2^53. (A WGSL i32 version needs its own floor for negative a.)
 */
export const floorDiv = (a: number, c: number): number => Math.floor(a / c);

/** Throws unless spec is a well-formed grid; returns it with defaults applied and in fixed point. */
export function checkGrid(spec: GridSpec): Pick<GridResult, 'axes' | 's' | 'n' | 'O' | 'C'> {
  const s = spec.s ?? 16;
  if (!(isInt(s) && s >= 0 && s <= 24)) throw new RangeError(`grid.s must be an integer 0..24, got ${s}`);
  const [u, v] = spec.axes ?? [0, 2];
  if (![u, v].every((a) => a === 0 || a === 1 || a === 2) || u === v) throw new RangeError(`grid.axes must be two distinct axes of 0, 1, 2, got ${JSON.stringify(spec.axes)}`);
  const [nu, nv] = spec.n;
  for (const x of [nu, nv]) if (!(isInt(x) && x >= 1 && x <= MAX_GRID_SIDE)) throw new RangeError(`grid.n must be integers 1..${MAX_GRID_SIDE}, got ${JSON.stringify(spec.n)}`);
  if (nu * nv > MAX_GRID_CELLS) throw new RangeError(`grid has ${nu * nv} cells, over ${MAX_GRID_CELLS}`);
  const O: [number, number] = [0, 0], C: [number, number] = [0, 0];
  for (let k = 0; k < 2; k++) {
    const o = quant(spec.origin[k]!, s), c = quant(spec.cell[k]!, s);
    if (o === null) throw new RangeError(`grid.origin[${k}] = ${spec.origin[k]} is out of the fixed-point range at s = ${s}`);
    if (c === null || c < 1) throw new RangeError(`grid.cell[${k}] = ${spec.cell[k]} is under one fixed-point unit (2^-${s}) or out of range`);
    // Every cell edge stays inside the quantized range, so cell indices are exact.
    if (Math.abs(o) + (k ? nv : nu) * c >= 2 ** 29) throw new RangeError(`grid axis ${k} reaches past the fixed-point range at s = ${s}`);
    O[k] = o;
    C[k] = c;
  }
  return { axes: [u, v, 3 - u - v], s, n: [nu, nv], O, C };
}

/** The grid reduction of the bodies `ids` of a snapshot (docs/design/grid.md). Throws on a bad spec, id or weight. */
export function reduceGrid(spec: GridSpec, inp: GridInput): GridResult {
  const g = checkGrid(spec), { snap, shapes } = inp, [u, v, w] = g.axes, [nu, nv] = g.n, [Ou, Ov] = g.O, [Cu, Cv] = g.C, s = g.s;
  const cells = nu * nv;
  const r: GridResult = {
    ...g, count: new Uint32Array(cells), weight: new Float64Array(cells), cover: new Uint32Array(cells), top: new Int32Array(cells).fill(EMPTY_TOP),
    projU: { count: new Uint32Array(nu), weight: new Float64Array(nu) }, projV: { count: new Uint32Array(nv), weight: new Float64Array(nv) },
    total: { n: 0, weight: 0 }, outside: { n: 0, weight: 0 }, invalid: 0, removed: 0,
  };
  const count = snap.count, ids = inp.ids, m = ids ? ids.length : count, wt = inp.weight;
  const q = (x: number) => {
    const t = quant(x, s);
    return t === null ? NaN : t;
  };
  for (let k = 0; k < m; k++) {
    const id = ids ? ids[k]! : k;
    if (!(isInt(id) && id >= 0 && id < count)) throw new RangeError(`reduceGrid: id ${id} is not a body (0 .. ${count - 1})`);
    const shape = shapes[id];
    if (!shape) throw new RangeError(`reduceGrid: no shape for body ${id}`);
    if (snap.tier?.[id] === TIER_FREE) {
      r.removed++;
      continue;
    }
    const wi = wt ? wt[id]! : 1;
    if (!(isInt(wi) && wi >= 0 && wi < MAX_WEIGHT)) throw new RangeError(`reduceGrid: weight of body ${id} must be an integer in [0, 2^31), got ${wi}`);
    const Pu = q(snap.pos[3 * id + u]!), Pv = q(snap.pos[3 * id + v]!), Pw = q(snap.pos[3 * id + w]!);
    const Eu = extentQ(shape, snap.rot, id, u, s), Ev = extentQ(shape, snap.rot, id, v, s), Ew = extentQ(shape, snap.rot, id, w, s);
    // NaN anywhere (⊥) poisons the sum.
    if (Number.isNaN(Pu + Pv + Pw + Eu + Ev + Ew)) {
      r.invalid++;
      continue;
    }
    r.total.n++;
    r.total.weight += wi;
    const i = floorDiv(Pu - Ou, Cu), j = floorDiv(Pv - Ov, Cv), inU = i >= 0 && i < nu, inV = j >= 0 && j < nv;
    if (inU) {
      r.projU.count[i]!++;
      r.projU.weight[i]! += wi;
    }
    if (inV) {
      r.projV.count[j]!++;
      r.projV.weight[j]! += wi;
    }
    if (inU && inV) {
      r.count[j * nu + i]!++;
      r.weight[j * nu + i]! += wi;
    } else {
      r.outside.n++;
      r.outside.weight += wi;
    }
    // Covered cells: [lo, hi) on each axis, a zero-width box as [lo, lo + 1).
    const loU = Pu - Eu, loV = Pv - Ev, hiU = Math.max(Pu + Eu, loU + 1), hiV = Math.max(Pv + Ev, loV + 1);
    const i0 = Math.max(0, floorDiv(loU - Ou, Cu)), i1 = Math.min(nu - 1, floorDiv(hiU - 1 - Ou, Cu));
    const j0 = Math.max(0, floorDiv(loV - Ov, Cv)), j1 = Math.min(nv - 1, floorDiv(hiV - 1 - Ov, Cv));
    const t = Pw + Ew;
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const c = jj * nu + ii;
        r.cover[c]!++;
        if (t > r.top[c]!) r.top[c] = t;
      }
    }
  }
  return r;
}

/**
 * Chessboard distance (in cells) from every cell to the nearest set cell of mask (nu × nv, row-major);
 * -1 everywhere when the mask is empty. Exact: a multi-source breadth-first search over 8 neighbours.
 */
export function chessDistance(mask: ArrayLike<number>, nu: number, nv: number): Int32Array {
  const d = new Int32Array(nu * nv).fill(-1), queue = new Int32Array(nu * nv);
  let head = 0, tail = 0;
  for (let k = 0; k < nu * nv; k++) if (mask[k]) {
    d[k] = 0;
    queue[tail++] = k;
  }
  while (head < tail) {
    const k = queue[head++]!, i = k % nu, j = (k - i) / nu, dk = d[k]! + 1;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nv) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nu) continue;
        const c = jj * nu + ii;
        if (d[c] === -1) {
          d[c] = dk;
          queue[tail++] = c;
        }
      }
    }
  }
  return d;
}

/** The mask grown by r cells in every direction, diagonals included (chessboard). */
export function dilate(mask: ArrayLike<number>, nu: number, nv: number, r: number): Uint8Array {
  if (!(isInt(r) && r >= 0)) throw new RangeError(`dilate: r must be an integer ≥ 0, got ${r}`);
  const d = chessDistance(mask, nu, nv);
  return Uint8Array.from(d, (x) => (x >= 0 && x <= r ? 1 : 0));
}

export interface MaskScore {
  /** Cells in the mask, cells occupied (cover ≥ minCover), and cells both. */
  maskCells: number;
  occCells: number;
  hitCells: number;
  /** hit / mask. */
  fill: number;
  /** hit / (mask ∪ occupied); 1 when both are empty. */
  iou: number;
  /** Weight of centres in mask cells, and of every other valid body (off-grid included). */
  inWeight: number;
  outWeight: number;
  /** outWeight / total weight; 0 when there is no weight. */
  spill: number;
  /** Largest chessboard distance in cells from an occupied cell to the mask (0 when all are inside). */
  reach: number;
  /** Highest top (fixed point) over occupied cells in the mask, and outside it; EMPTY_TOP when none. */
  topIn: number;
  topOut: number;
}

/** Scores a grid against a target mask (one byte per cell, non-zero = in). Throws on an empty or mis-sized mask. */
export function maskScore(g: GridResult, mask: ArrayLike<number>, minCover = 1): MaskScore {
  const [nu, nv] = g.n, cells = nu * nv;
  if (mask.length !== cells) throw new RangeError(`maskScore: mask has ${mask.length} cells, the grid ${cells}`);
  if (!(isInt(minCover) && minCover >= 1)) throw new RangeError(`maskScore: minCover must be an integer ≥ 1, got ${minCover}`);
  const d = chessDistance(mask, nu, nv);
  let maskCells = 0, occCells = 0, hitCells = 0, inWeight = 0, reach = 0, topIn = EMPTY_TOP, topOut = EMPTY_TOP;
  for (let k = 0; k < cells; k++) {
    const inM = !!mask[k], occ = g.cover[k]! >= minCover;
    if (inM) {
      maskCells++;
      inWeight += g.weight[k]!;
    }
    if (!occ) continue;
    occCells++;
    if (inM) {
      hitCells++;
      if (g.top[k]! > topIn) topIn = g.top[k]!;
    } else {
      if (g.top[k]! > topOut) topOut = g.top[k]!;
      if (d[k]! > reach) reach = d[k]!;
    }
  }
  if (!maskCells) throw new RangeError('maskScore: the mask is empty');
  const union = maskCells + occCells - hitCells, outWeight = g.total.weight - inWeight;
  return {
    maskCells, occCells, hitCells, fill: hitCells / maskCells, iou: union ? hitCells / union : 1,
    inWeight, outWeight, spill: g.total.weight ? outWeight / g.total.weight : 0, reach, topIn, topOut,
  };
}

/** A fixed-point grid value (top) in metres; null for EMPTY_TOP. */
export const gridMetres = (q: number, s = 16): number | null => (q === EMPTY_TOP ? null : q / 2 ** s);
