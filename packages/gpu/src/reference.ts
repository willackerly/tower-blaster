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
