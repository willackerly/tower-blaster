// Integrated loudness, ITU-R BS.1770-4 (LUFS): K-weighting (a high shelf and a high-pass), mean square
// over 400 ms blocks overlapping by 75%, gated at -70 LUFS and then 10 LU under the ungated mean. Used
// to level one material set against another (the game's level, sound-map.ts) and in the realism
// checks, so a change that only makes things louder cannot pass as a change in timbre.

/** K-weighting at 48 kHz: the standard's two biquads, [b0, b1, b2, a1, a2]. */
const K48: readonly (readonly number[])[] = [
  [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
  [1, -2, 1, -1.99004745483398, 0.99007225036621],
];

function kWeight(x: Float32Array): Float64Array {
  let y = Float64Array.from(x);
  for (const [b0, b1, b2, a1, a2] of K48) {
    const out = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i]!, o = b0! * v + b1! * x1 + b2! * x2 - a1! * y1 - a2! * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = o; out[i] = o;
    }
    y = out;
  }
  return y;
}

/** Integrated loudness (LUFS) of a stereo (or mono: R omitted) signal at 48 kHz; -Infinity when everything is gated out. */
export function loudness(L: Float32Array, R?: Float32Array, sr = 48000): number {
  if (sr !== 48000) throw new Error(`loudness: K-weighting is tabulated for 48 kHz, not ${sr}`);
  const chans = [kWeight(L), ...(R ? [kWeight(R)] : [])];
  const block = Math.round(0.4 * sr), hop = block / 4, z: number[] = [];
  for (let s = 0; s + block <= L.length; s += hop) {
    let sum = 0;
    for (const c of chans) for (let i = s; i < s + block; i++) sum += c[i]! ** 2;
    z.push(sum / block);
  }
  const lk = (ms: number) => -0.691 + 10 * Math.log10(ms);
  const gated = (zs: number[]) => zs.reduce((a, b) => a + b, 0) / zs.length;
  const abs = z.filter((v) => lk(v) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(gated(abs)) - 10, kept = abs.filter((v) => lk(v) > rel);
  return lk(gated(kept));
}
