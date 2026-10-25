// CPU references for the GPU primitives. Tests compare against these, so they
// are written for obviousness, not speed.

export function exclusiveScanU32(a: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(a.length);
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    out[i] = acc;
    acc = (acc + a[i]!) >>> 0;
  }
  return out;
}

export function compactIndices(flags: ArrayLike<number>): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i] !== 0) out.push(i);
  return Uint32Array.from(out);
}

/** Stable sort of (key, value) pairs by key; the reference for RadixSorter. */
export function sortPairs(keys: ArrayLike<number>, vals: ArrayLike<number>, keyBits = 32): { keys: Uint32Array; vals: Uint32Array } {
  const mask = keyBits >= 32 ? 0xffffffff : (1 << keyBits) - 1;
  const idx = Array.from({ length: keys.length }, (_, i) => i);
  idx.sort((a, b) => (((keys[a]! & mask) >>> 0) - ((keys[b]! & mask) >>> 0)) || a - b);
  return { keys: Uint32Array.from(idx, (i) => keys[i]!), vals: Uint32Array.from(idx, (i) => vals[i]!) };
}
