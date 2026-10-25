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
