// Statistics for benchmark decisions. The rule the harness follows: a
// variant is faster only if the confidence interval of the paired
// difference excludes zero.

export function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Quantile with linear interpolation between order statistics (R type 7). */
export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function summarize(xs: readonly number[]) {
  return { n: xs.length, median: median(xs), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99), max: Math.max(...xs), mean: mean(xs) };
}

/** Deterministic PRNG for resampling (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval { estimate: number; lo: number; hi: number }

export interface BootstrapOptions { iters?: number; alpha?: number; seed?: number }

/** Percentile bootstrap confidence interval for a statistic. */
export function bootstrapCI(xs: readonly number[], stat: (s: number[]) => number, opts: BootstrapOptions = {}): Interval {
  const { iters = 2000, alpha = 0.05, seed = 1 } = opts;
  const r = prng(seed);
  const n = xs.length;
  const reps: number[] = [];
  const buf = new Array<number>(n);
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < n; i++) buf[i] = xs[Math.floor(r() * n)]!;
    reps.push(stat(buf));
  }
  return { estimate: stat([...xs]), lo: quantile(reps, alpha / 2), hi: quantile(reps, 1 - alpha / 2) };
}

/**
 * Percent change of B relative to A from interleaved blocks: block i of A
 * and block i of B ran back to back, so each pair shares whatever the
 * machine was doing at the time. The estimate is exp(median of per-pair
 * log ratios) - 1, which cancels slow drift (thermal, background load)
 * exactly and is robust to a noise burst hitting one side of a pair.
 * The interval is a percentile bootstrap over pairs.
 */
export function pairedPercentDiff(a: readonly number[], b: readonly number[], opts: BootstrapOptions = {}): Interval {
  if (a.length !== b.length || a.length < 2) throw new Error('need two equal-length series of at least 2 blocks');
  const logRatios = a.map((x, i) => Math.log(b[i]! / x));
  const ci = bootstrapCI(logRatios, median, opts);
  return { estimate: Math.expm1(ci.estimate), lo: Math.expm1(ci.lo), hi: Math.expm1(ci.hi) };
}

export type Verdict = 'faster' | 'slower' | 'no-difference';

/** Classify an interval of B-relative-to-A time change. */
export function verdict(diff: Interval, threshold = 0): Verdict {
  if (diff.hi < -threshold) return 'faster';
  if (diff.lo > threshold) return 'slower';
  return 'no-difference';
}

/** Least-squares fit of log t = a + b log N, with r^2. b near 1 is linear. */
export function loglogFit(ns: readonly number[], ts: readonly number[]) {
  const x = ns.map(Math.log), y = ts.map(Math.log);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

/** Least-squares fit of t = t0 + c N (fixed overhead plus per-body cost). */
export function linearFit(ns: readonly number[], ts: readonly number[]) {
  const mx = mean(ns), my = mean(ts);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < ns.length; i++) {
    sxy += (ns[i]! - mx) * (ts[i]! - my);
    sxx += (ns[i]! - mx) ** 2;
  }
  const c = sxy / sxx;
  return { t0: my - c * mx, perBody: c };
}

/**
 * True when the median of the last quarter of a block differs from the first
 * quarter by more than `tolerance`: thermal throttling or background load.
 */
export function driftSuspect(samples: readonly number[], tolerance = 0.03): boolean {
  const q = Math.floor(samples.length / 4);
  if (q < 3) return false;
  return Math.abs(median(samples.slice(-q)) / median(samples.slice(0, q)) - 1) > tolerance;
}
