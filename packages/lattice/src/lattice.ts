// Storage for cubes at rest on a regular grid: the dormant tier. A cube in
// the lattice costs nothing per step; it is only a bit and a body id until
// something wakes it.
//
// Layout (dense, structure of arrays, sized to the bounds of the towers):
// - occupancy: one bitset per column (x, z), `words` u32 per column, bit j
//   is the cell at height j. Support rules work on whole columns with word
//   operations (a loose column on the ground is a prefix mask).
// - ids: Int32Array, body id per cell or -1, column-contiguous like the bits.
// - rots: Uint8Array, index into CUBE_ROTATIONS per cell.
// Alternatives considered: a Map keyed by cell (sparse, about 10x slower per
// lookup and no word-level column ops), 8^3 bricks as the primary store
// (what the GPU wants, but a column then spans several bricks), sorted Morton
// arrays (compact, but inserts cost O(n)). At 100k cubes in 1M cells of bounds
// the dense layout is about 5 MB. Bricks are exported for the GPU instead.
import type { Vec3 } from '@tb/engine-api';

export interface LatticeFrame {
  /** World position of the centre of cell (0, 0, 0). */
  origin: Vec3;
  /** Cube edge, which is also the cell pitch on every axis (cubes packed face to face). */
  edge: number;
}

export interface LatticeDims { nx: number; ny: number; nz: number }

export const EMPTY = -1;
/** Edge of a brick in cells. */
export const BRICK = 8;
/** u32 words per brick mask (512 bits). */
export const BRICK_WORDS = 16;

export class Lattice {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** u32 words per column bitset. */
  readonly words: number;
  readonly bits: Uint32Array;
  private readonly ids: Int32Array;
  private readonly rots: Uint8Array;
  private n = 0;
  private dirty = new Set<number>();
  readonly nbx: number;
  readonly nby: number;
  readonly nbz: number;

  constructor(readonly frame: LatticeFrame, dims: LatticeDims) {
    const { nx, ny, nz } = dims;
    if (![nx, ny, nz].every((v) => Number.isInteger(v) && v > 0)) throw new Error(`bad lattice dims ${nx}x${ny}x${nz}`);
    if (!(frame.edge > 0)) throw new Error('lattice edge must be positive');
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.words = Math.ceil(ny / 32);
    this.bits = new Uint32Array(nx * nz * this.words);
    this.ids = new Int32Array(nx * ny * nz).fill(EMPTY);
    this.rots = new Uint8Array(nx * ny * nz);
    this.nbx = Math.ceil(nx / BRICK); this.nby = Math.ceil(ny / BRICK); this.nbz = Math.ceil(nz / BRICK);
  }

  /** Number of occupied cells. */
  get count(): number { return this.n; }

  inBounds(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz;
  }

  /** Flat cell index; cells of a column are contiguous in j. */
  cell(i: number, j: number, k: number): number { return (k * this.nx + i) * this.ny + j; }

  coords(c: number): [number, number, number] {
    const j = c % this.ny, col = (c - j) / this.ny;
    return [col % this.nx, j, Math.floor(col / this.nx)];
  }

  column(i: number, k: number): number { return k * this.nx + i; }

  has(i: number, j: number, k: number): boolean {
    if (!this.inBounds(i, j, k)) return false;
    return ((this.bits[this.column(i, k) * this.words + (j >>> 5)]! >>> (j & 31)) & 1) === 1;
  }

  /** Body id at a cell, or EMPTY (also outside the bounds). */
  idAt(i: number, j: number, k: number): number {
    return this.inBounds(i, j, k) ? this.ids[this.cell(i, j, k)]! : EMPTY;
  }

  rotAt(i: number, j: number, k: number): number { return this.rots[this.cell(i, j, k)]!; }

  insert(i: number, j: number, k: number, id: number, rot = 0): void {
    if (!this.inBounds(i, j, k)) throw new Error(`cell ${i},${j},${k} outside lattice bounds`);
    if (this.has(i, j, k)) throw new Error(`cell ${i},${j},${k} already holds body ${this.idAt(i, j, k)}`);
    if (!(id >= 0)) throw new Error(`body id must be >= 0, got ${id}`);
    const c = this.cell(i, j, k);
    this.bits[this.column(i, k) * this.words + (j >>> 5)]! |= 1 << (j & 31);
    this.ids[c] = id;
    this.rots[c] = rot;
    this.n++;
    this.dirty.add(this.brickKey(i, j, k));
  }

  /** Empties a cell and returns the id it held. */
  remove(i: number, j: number, k: number): number {
    if (!this.has(i, j, k)) throw new Error(`cell ${i},${j},${k} is empty`);
    const c = this.cell(i, j, k);
    const id = this.ids[c]!;
    this.bits[this.column(i, k) * this.words + (j >>> 5)]! &= ~(1 << (j & 31));
    this.ids[c] = EMPTY;
    this.n--;
    this.dirty.add(this.brickKey(i, j, k));
    return id;
  }

  /** World centre of a cell. */
  center(i: number, j: number, k: number): Vec3 {
    const { origin: o, edge: e } = this.frame;
    return [o[0] + i * e, o[1] + j * e, o[2] + k * e];
  }

  /** Nearest cell to a world point (may be outside the bounds). */
  nearest(p: Vec3): [number, number, number] {
    const { origin: o, edge: e } = this.frame;
    return [Math.round((p[0] - o[0]) / e), Math.round((p[1] - o[1]) / e), Math.round((p[2] - o[2]) / e)];
  }

  /** Heights j >= from that are occupied in column (i, k), ascending. */
  occupiedFrom(i: number, k: number, from: number): number[] {
    const out: number[] = [];
    const base = this.column(i, k) * this.words;
    for (let w = Math.max(0, from >>> 5); w < this.words; w++) {
      let m = this.bits[base + w]!;
      if (w === from >>> 5) m &= ~((1 << (from & 31)) - 1);
      while (m) {
        const low = m & -m;
        out.push(w * 32 + 31 - Math.clz32(low));
        m ^= low;
      }
    }
    return out;
  }

  /** Raw occupancy words of a column (a view, do not keep). */
  columnWords(i: number, k: number): Uint32Array {
    const base = this.column(i, k) * this.words;
    return this.bits.subarray(base, base + this.words);
  }

  forEach(fn: (i: number, j: number, k: number, id: number) => void): void {
    for (let k = 0; k < this.nz; k++)
      for (let i = 0; i < this.nx; i++)
        for (const j of this.occupiedFrom(i, k, 0)) fn(i, j, k, this.ids[this.cell(i, j, k)]!);
  }

  // GPU mirror: 8^3 bricks of occupancy, 16 u32 words each. Bit b of a brick
  // is local cell (lx, ly, lz) with b = (lz * 8 + ly) * 8 + lx, word b >> 5.
  // Brick key = (bk * nbx + bi) * nby + bj.

  brickKey(i: number, j: number, k: number): number {
    return ((k >> 3) * this.nbx + (i >> 3)) * this.nby + (j >> 3);
  }

  brickMask(key: number, out = new Uint32Array(BRICK_WORDS)): Uint32Array {
    out.fill(0);
    const bj = key % this.nby, rest = (key - bj) / this.nby, bi = rest % this.nbx, bk = (rest - bi) / this.nbx;
    for (let lz = 0; lz < BRICK; lz++)
      for (let lx = 0; lx < BRICK; lx++) {
        const i = bi * BRICK + lx, k = bk * BRICK + lz;
        if (i >= this.nx || k >= this.nz) continue;
        for (let ly = 0; ly < BRICK; ly++) {
          const j = bj * BRICK + ly;
          if (j < this.ny && this.has(i, j, k)) {
            const b = (lz * 8 + ly) * 8 + lx;
            out[b >>> 5]! |= 1 << (b & 31);
          }
        }
      }
    return out;
  }

  /** Every non-empty brick, keys ascending. */
  bricks(): { keys: Uint32Array; masks: Uint32Array } {
    const keys = new Set<number>();
    this.forEach((i, j, k) => keys.add(this.brickKey(i, j, k)));
    return this.packBricks([...keys].sort((a, b) => a - b));
  }

  /** Bricks changed since the last call (including ones now empty), keys ascending. */
  takeDirtyBricks(): { keys: Uint32Array; masks: Uint32Array } {
    const keys = [...this.dirty].sort((a, b) => a - b);
    this.dirty = new Set();
    return this.packBricks(keys);
  }

  private packBricks(keys: number[]) {
    const masks = new Uint32Array(keys.length * BRICK_WORDS);
    keys.forEach((key, n) => this.brickMask(key, masks.subarray(n * BRICK_WORDS, (n + 1) * BRICK_WORDS)));
    return { keys: Uint32Array.from(keys), masks };
  }
}
