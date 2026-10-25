// Exact reductions and sparse reads (docs/design/reduce.md). Pure TS, no
// dependencies: everything here is the definition every engine's observer
// must match bit for bit.

/** Fixed-point exponent: x is read as the integer quant(x, s) ≈ x·2^s. Integer 0..24; default 16 (2^-16 ≈ 15 µm, 15 µm/s). */
export type Scale = number;

const Q_LIMIT = 2 ** 29;

/**
 * quant on v = fround(x)·2^s, with ⊥ as NaN so hot loops stay on numbers.
 * The product is exact (24-bit significand, power-of-two scale), so only the
 * rounding remains: Math.round sends ties up, so odd results move to even.
 */
function quantScaled(v: number): number {
  if (!(Math.abs(v) < Q_LIMIT)) return NaN; // NaN, ±Inf, |v| ≥ 2^29
  let r = Math.round(v);
  if (r - v === 0.5 && r % 2) r -= 1;
  return r + 0; // −0 → +0
}

/** ⊥ (null) for NaN, ±Inf, and |fround(x)|·2^s ≥ 2^29; else fround(x)·2^s rounded to nearest, ties to even, −0 → 0. */
export function quant(x: number, s: Scale): number | null {
  if (!(Number.isInteger(s) && s >= 0 && s <= 24)) throw new RangeError(`quant: s must be an integer 0..24, got ${s}`);
  const r = quantScaled(Math.fround(x) * 2 ** s);
  return Number.isNaN(r) ? null : r;
}
