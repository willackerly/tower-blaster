// Independent oracles for the observe tests. Nothing here shares code with
// observe.ts: a disagreement points at one of the two formulations.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function bitsOf(x: number): number {
  f32[0] = x;
  return u32[0]!;
}

export function fromBits(b: number): number {
  u32[0] = b >>> 0;
  return f32[0]!;
}

/** |x| = num / den exactly, from the f32 bit pattern; null for exponent 255. */
function rational(b: number): { neg: boolean; num: bigint; den: bigint } | null {
  const e = (b >>> 23) & 255, f = BigInt(b & 0x7fffff), neg = b >>> 31 === 1;
  if (e === 255) return null;
  if (e === 0) return { neg, num: f, den: 1n << 149n };
  const m = (1n << 23n) | f;
  return e >= 150 ? { neg, num: m << BigInt(e - 150), den: 1n } : { neg, num: m, den: 1n << BigInt(150 - e) };
}

/** quant as exact rational arithmetic: x·2^s rounded to nearest even, ⊥ at |x·2^s| ≥ 2^29. */
export function quantBig(b: number, s: number): bigint | null {
  const r = rational(b);
  if (!r) return null;
  const num = r.num << BigInt(s);
  if (num >= (1n << 29n) * r.den) return null;
  const fl = num / r.den, rem2 = 2n * (num - fl * r.den);
  const mag = rem2 > r.den || (rem2 === r.den && (fl & 1n) === 1n) ? fl + 1n : fl;
  return r.neg ? -mag : mag;
}

/** The WGSL integer algorithm of §3.2, line for line on u32/i32 words. */
export function quantBits(b: number, s: number): number | null {
  const e = (b >>> 23) & 255;
  if (e === 255) return null;
  if (e === 0) return 0;
  const m = (b & 0x7fffff) | 0x800000;
  const sh = e - 150 + s;
  let mag: number;
  if (sh >= 6) return null;
  if (sh >= 0) mag = m << sh;
  else if (sh >= -25) {
    const k = -sh, q = m >>> k, r = m & ((1 << k) - 1), h = 1 << (k - 1);
    mag = q + (r > h || (r === h && (q & 1) === 1) ? 1 : 0);
  } else mag = 0;
  return (b >>> 31 ? -mag : mag) | 0;
}

/** quantBig on a JS number, as a number (|q| < 2^29); null for ⊥. */
export function quantRef(x: number, s: number): number | null {
  const q = quantBig(bitsOf(x), s);
  return q === null ? null : Number(q);
}
