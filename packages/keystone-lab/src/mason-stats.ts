// Statistics for the Mason judge's verify (docs/game/masons-trial.md): the
// islands' pass count against the solo runs' is a 2 x 2 table of binary
// outcomes, where a two-sample KS test is degenerate (two steps), so the
// agreement test is Fisher's exact test (two-sided), with a Wilson interval
// to report each arm's pass share.

/** ln(n!) by summing logs (n is at most a few hundred here). */
function lnFact(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * Two-sided Fisher's exact test of the 2 x 2 table [[a, b], [c, d]] (rows: arms, columns: pass and fail): the
 * probability, with the margins fixed, of a table at most as likely as this one. 1 when the arms agree exactly.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const lp = (x: number) => lnFact(r1) + lnFact(r2) + lnFact(c1) + lnFact(n - c1) - lnFact(n) - lnFact(x) - lnFact(r1 - x) - lnFact(c1 - x) - lnFact(r2 - c1 + x);
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1), p0 = lp(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) { const q = lp(x); if (q <= p0 + 1e-9) p += Math.exp(q); }
  return Math.min(1, p);
}

/** Wilson score interval (95 %) for k passes of n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, w = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - w), Math.min(1, c + w)];
}
