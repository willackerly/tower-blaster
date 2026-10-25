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
