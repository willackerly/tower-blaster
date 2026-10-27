// Graph colouring for the Gauss-Seidel sweep: bodies of one colour share no
// contact, so they can be updated in parallel (on the GPU) or in any order.
//
// The colouring is greedy in decreasing priority order. That is exactly what
// Jones-Plassmann computes in parallel rounds (a node colours itself once it
// outranks every uncoloured neighbour, taking the smallest colour its
// higher-priority neighbours do not use), so the GPU can reproduce this
// colouring bit for bit without any ordering between threads.

/** Fixed per-body priority: a 32-bit integer hash (lowbias32, Wellons). */
export function priority(i: number): number {
  let x = i >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** True when body i is coloured before body j (higher priority, then lower index). */
export const outranks = (i: number, j: number) => {
  const pi = priority(i), pj = priority(j);
  return pi > pj || (pi === pj && i < j);
};

/** Colour of every node; adj[i] lists i's neighbours (symmetric, no self loops). */
export function colorGraph(adj: ReadonlyArray<ReadonlyArray<number>>): Int32Array {
  const n = adj.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => (outranks(i, j) ? -1 : outranks(j, i) ? 1 : 0));
  const color = new Int32Array(n).fill(-1);
  const used: boolean[] = [];
  for (const v of order) {
    for (const u of adj[v]!) if (color[u]! >= 0) used[color[u]!] = true;
    let c = 0;
    while (used[c]) c++;
    color[v] = c;
    for (const u of adj[v]!) if (color[u]! >= 0) used[color[u]!] = false;
  }
  return color;
}

// ---------------------------------------------------------------------------
// Lattice-preferred colouring (AvbdParams.colorMode 1-4) and largest-degree-
// first priority (AvbdParams.colorPriority 1). Opt-in and experimental
// (Quality, below); colorGraph above is the default and is untouched. The GPU runs the same rules in its
// Jones-Plassmann rounds (physics-gpu/src/coloring.ts).
//
// A cube that sits in a world lattice of its own size has a cell index
// (x, y, z). Colour it by a linear map of the index parities mod 2, and two
// such cubes share a colour only when their offset (mod 2) is in the map's
// kernel. A resting stack's contact graph is the 14-neighbourhood: 6 faces
// and the 8 edge diagonals one layer apart, (+-1, +-1, 0) and (0, +-1, +-1);
// in-plane diagonals (+-1, 0, +-1) and corners (+-1, +-1, +-1) only touch
// once towers boil or break. So two bits whose kernel is the corner offset
// (colorMode 2: 2 (x+y) + (y+z), the face+edge rule) or the in-plane
// diagonal (colorMode 3: 2 (x+z) + y, the column-and-layer product) colour a
// resting lattice properly in 4 colours, where the hash priority needs 9-11.
// A body with an aligned neighbour of the same 4-colour (a contact along the
// kernel) prefers 4-colour + 4 x (x parity) instead. That 8-colour map has a
// trivial kernel, so it is proper on the whole 26-neighbourhood, and its low
// two bits are the 4-colour, so the two levels never clash. colorMode 1 is
// the plain 8-colour map 4 y + 2 x + z (round 1's lattice-8). colorMode 4 is
// colorMode 3 for the lattice interior only: a body prefers its 4-colour only
// when every neighbour is on the lattice and none has that 4-colour, so the
// edge of a lattice region (a tilted tower, a struck tower, debris against
// it) keeps the default's choice instead of mixing pattern and greedy
// colours, which can cost colours there. A resting lattice colours exactly as
// colorMode 3 (no kernel contacts, every neighbour aligned).
//
// A preference is only a choice among free colours: in priority order, a
// body takes its preferred colour if no higher-priority neighbour holds it,
// else the smallest free one, as the default does. So the colouring is
// proper whatever the poses, debris and bodies off the lattice keep today's
// choice, and Jones-Plassmann reproduces it bit for bit (when a body
// colours, exactly its higher-priority neighbours are coloured). The
// priority, and so the number of rounds, is the default's.
//
// Quality, unresolved (f64 reference, I = 20, perf-competition round 2), so
// every mode and colorPriority 1 stay experimental opt-ins:
//   - KNOCKT, S5's ball into a 320-cube tower, over 20 body orders. Early
//     collapses (more than 100 cubes moved by step 360): the default 4,
//     colorMode 3 none, colorMode 4 6 of 19. Paired by order, mode 4's onset
//     is earlier than mode 3's in 12 orders and later in 3 (one-sided
//     permutation test p ~ 0.014; against the default p ~ 0.07).
//     colorPriority 1 alone collapses in 6 of 6.
//   - Mode 3's worst point penetration there is larger than the default's:
//     78.06 mm (order 10) against 53.52 mm over the 20 orders, and 28.67 mm
//     (order 6) against 9.10 mm over orders 0-9. Its p99 is lower (1.60
//     against 7.73 mm).
//   - Structure. On Q6 (a 2x2x20 tower tilted 8 deg) mode 3 walks more points
//     than the default: mean sum W 1.017x on the same graphs, 1.028x in steps
//     200-270 (1.13x on its own trajectory). Mode 4 is 1.000x there, but
//     1.015x in KNOCKT's steps 200-360, where mode 3 is at most 1.006x.

/** Lattice preference modes (AvbdParams.colorMode): 0 none, 1 eight colours, 2 four (corner kernel), 3 four (in-plane-diagonal kernel), 4 as 3 for the lattice interior only. */
export const COLOR_MODES = [0, 1, 2, 3, 4] as const;
/** Priority rules (AvbdParams.colorPriority): 0 the hash (default), 1 largest degree first, then the hash. */
export const COLOR_PRIORITIES = [0, 1] as const;

/** A body takes its lattice preference only with at least this many aligned neighbours: loose debris that lands square keeps the greedy choice. */
export const LATTICE_MIN_ALIGNED = 3;

/**
 * Cell parities of a cube sitting in the world lattice of its own size
 * (bit 0 x, bit 1 y, bit 2 z), or -1 when it does not: each axis within
 * ~11 deg of a world axis (|component| >= 0.98) and its centre within 0.15
 * cell of a cell centre or a cell corner on every axis (y from the ground).
 * Each coordinate's parity is taken on the nearer of the two lattices, so
 * cubes at k + 1/2 and at k both work. `half` is the cube's half size
 * (null for any other shape).
 */
export function latticeParity(pos: ArrayLike<number>, rot: ArrayLike<number>, half: number | null, groundY = 0): number {
  if (half === null || !(half > 0)) return -1;
  const x = rot[0]!, y = rot[1]!, z = rot[2]!, w = rot[3]!;
  // Columns of the rotation matrix.
  const cols = [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  ];
  for (const c of cols) if (Math.max(Math.abs(c[0]!), Math.abs(c[1]!), Math.abs(c[2]!)) < 0.98) return -1;
  const cell = 2 * half;
  let bits = 0;
  for (let k = 0; k < 3; k++) {
    const q = (k === 1 ? pos[1]! - groundY : pos[k]!) / cell;
    const h = 2 * q;
    if (Math.abs(h - Math.round(h)) >= 0.3) return -1;
    const f = Math.floor(q);
    bits |= ((Math.abs(q - f - 0.5) < 0.25 ? f : Math.floor(q + 0.5)) & 1) << k;
  }
  return bits;
}

/** The colour a body with cell parities `bits` prefers under `mode` (1-4; 4 is 3's map); `clash`: an aligned neighbour has its 4-colour. */
export function latticeColor(bits: number, mode: number, clash: boolean): number {
  const px = bits & 1, py = (bits >> 1) & 1, pz = (bits >> 2) & 1;
  if (mode === 1) return 4 * py + 2 * px + pz;
  if (mode === 4) mode = 3;
  const c4 = mode === 2 ? 2 * (px ^ py) + (py ^ pz) : 2 * (px ^ pz) + py;
  return clash ? c4 + 4 * px : c4;
}

/**
 * Per-body preferred colours for colorGraphWith (-1: none) from each body's
 * latticeParity: a body prefers its latticeColor when it is on the lattice
 * and touches at least LATTICE_MIN_ALIGNED bodies that are. Mode 4 also
 * needs every neighbour on the lattice and none of its 4-colour (no
 * fallback colour).
 */
export function latticePreferences(adj: ReadonlyArray<ReadonlyArray<number>>, parity: ArrayLike<number>, mode: number): Int32Array {
  if (mode !== 1 && mode !== 2 && mode !== 3 && mode !== 4) throw new Error(`latticePreferences: mode must be 1, 2, 3 or 4, got ${mode}`);
  const n = adj.length;
  const pref = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const mine = parity[i]!;
    if (mine < 0) continue;
    let aligned = 0, clash = false;
    for (const u of adj[i]!) {
      const pu = parity[u]!;
      if (pu < 0) continue;
      aligned++;
      if (latticeColor(pu, mode, false) === latticeColor(mine, mode, false)) clash = true;
    }
    if (aligned < LATTICE_MIN_ALIGNED) continue;
    if (mode === 4) { if (aligned === adj[i]!.length && !clash) pref[i] = latticeColor(mine, 4, false); }
    else pref[i] = latticeColor(mine, mode, mode !== 1 && clash);
  }
  return pref;
}

/**
 * colorGraph with options: `prefer[v]` (>= 0) is taken when no neighbour
 * coloured before v holds it, else the smallest free colour; `degreeFirst`
 * colours larger-degree nodes first (then the hash, then the index), which
 * Jones-Plassmann reproduces with that priority. With neither it is colorGraph.
 */
export function colorGraphWith(adj: ReadonlyArray<ReadonlyArray<number>>, opts: { prefer?: ArrayLike<number>; degreeFirst?: boolean } = {}): Int32Array {
  const n = adj.length, { prefer, degreeFirst = false } = opts;
  const before = (i: number, j: number) => (degreeFirst && adj[i]!.length !== adj[j]!.length ? adj[i]!.length > adj[j]!.length : outranks(i, j));
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => (before(i, j) ? -1 : before(j, i) ? 1 : 0));
  const color = new Int32Array(n).fill(-1);
  const used: boolean[] = [];
  for (const v of order) {
    for (const u of adj[v]!) if (color[u]! >= 0) used[color[u]!] = true;
    let c = 0;
    const want = prefer ? prefer[v]! : -1;
    if (want >= 0 && !used[want]) c = want;
    else while (used[c]) c++;
    color[v] = c;
    for (const u of adj[v]!) if (color[u]! >= 0) used[color[u]!] = false;
  }
  return color;
}
