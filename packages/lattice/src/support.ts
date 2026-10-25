// Which lattice cells can stay dormant. A support model decides; the lattice
// only stores. Loose cubes (gravity and friction only) use the exact column
// rule below; glued towers will plug in a bonded model behind the same
// interface.
import { type Lattice } from './lattice.ts';

export interface SupportModel {
  readonly name: string;
  /** Whether a cube placed at (i, j, k) now would be supported. */
  canInsert(lat: Lattice, i: number, j: number, k: number): boolean;
  /**
   * Cells that are no longer supported after cells in `columns` changed
   * (cubes left them). The result is closed: removing these cells leaves a
   * legal lattice. Flat cell indices, ascending.
   */
  unsupported(lat: Lattice, columns: Iterable<[number, number]>): number[];
  /** Every illegal cell in the lattice, ascending; empty when legal. */
  violations(lat: Lattice): number[];
}

/**
 * Loose cubes under gravity on a rigid base. With no lateral prestress the
 * side faces of a packed lattice carry no load, so a cube is supported if and
 * only if every cell under it down to the base is a dormant cube. A cube that
 * left the lattice (woken, not only removed) breaks support too: a dormant
 * cube above it would be an infinite-mass ceiling that takes the column's
 * weight off it, and it could then slide out without friction.
 * A legal column is therefore a prefix: cells 0 .. top-1.
 */
export const looseColumns: SupportModel = {
  name: 'loose-columns',

  canInsert(lat, i, j, k) {
    return lat.inBounds(i, j, k) && !lat.has(i, j, k) && (j === 0 || lat.has(i, j - 1, k)) && firstGap(lat, i, k) === j;
  },

  unsupported(lat, columns) {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const [i, k] of columns) {
      const col = lat.column(i, k);
      if (seen.has(col)) continue;
      seen.add(col);
      const g = firstGap(lat, i, k);
      for (const j of lat.occupiedFrom(i, k, g + 1)) out.push(lat.cell(i, j, k));
    }
    return out.sort((a, b) => a - b);
  },

  violations(lat) {
    const cols: Array<[number, number]> = [];
    for (let k = 0; k < lat.nz; k++) for (let i = 0; i < lat.nx; i++) cols.push([i, k]);
    return this.unsupported(lat, cols);
  },
};

/** Lowest empty height in a column (ny when full). */
export function firstGap(lat: Lattice, i: number, k: number): number {
  const words = lat.columnWords(i, k);
  for (let w = 0; w < words.length; w++) {
    const inv = ~words[w]! >>> 0;
    if (inv) return Math.min(lat.ny, w * 32 + 31 - Math.clz32(inv & -inv));
  }
  return lat.ny;
}

export interface Detached {
  i: number;
  j: number;
  k: number;
  id: number;
  rot: number;
  /** 'direct' for cells asked for, 'support' for cells that lost support as a result. */
  cause: 'direct' | 'support';
}

/**
 * Take cells out of the lattice together with every cell that loses support
 * as a result, so the lattice stays legal. Order: the requested cells as
 * given, then the unsupported ones by ascending cell index (deterministic).
 * Cells in `cells` that are empty are ignored.
 */
export function detach(lat: Lattice, support: SupportModel, cells: Iterable<[number, number, number]>): Detached[] {
  const out: Detached[] = [];
  const cols: Array<[number, number]> = [];
  for (const [i, j, k] of cells) {
    if (!lat.has(i, j, k)) continue;
    const rot = lat.rotAt(i, j, k);
    out.push({ i, j, k, rot, id: lat.remove(i, j, k), cause: 'direct' });
    cols.push([i, k]);
  }
  // A general model may need several rounds (the loose model's second is
  // empty). Each round that continues removed a cell, so this terminates.
  while (cols.length) {
    const lost = support.unsupported(lat, cols.splice(0));
    for (const c of lost) {
      const [i, j, k] = lat.coords(c);
      const rot = lat.rotAt(i, j, k);
      out.push({ i, j, k, rot, id: lat.remove(i, j, k), cause: 'support' });
      cols.push([i, k]);
    }
  }
  return out;
}
