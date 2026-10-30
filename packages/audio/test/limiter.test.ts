import { describe, expect, it } from 'vitest';
import { BLOCK, CEILING, HighPass, Limiter, LOOKAHEAD } from '@tb/audio';

const SR = 48000, DELAY = LOOKAHEAD - 1;

/** Run x (mono, both channels) through a limiter block by block; the output. */
function limit(x: Float32Array, lim = new Limiter()) {
  const out = new Float32Array(x.length), R = new Float32Array(BLOCK);
  for (let o = 0; o < x.length; o += BLOCK) {
    const L = x.slice(o, o + BLOCK);
    R.set(L);
    lim.process(L, R.subarray(0, L.length), SR);
    out.set(L, o);
  }
  return out;
}

/** 1 kHz at amplitude a from sample `on` to `off`, silence around it. */
const burst = (n: number, a: number, on: number, off: number) => Float32Array.from({ length: n }, (_, i) => (i >= on && i < off ? a * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0));

describe('Limiter', () => {
  it('passes what is under the ceiling unchanged, LOOKAHEAD - 1 samples late', () => {
    const x = burst(48000, 0.85, 1000, 30000), y = limit(x);
    for (let i = DELAY; i < x.length; i++) expect(y[i]).toBe(x[i - DELAY]);
    for (let i = 0; i < DELAY; i++) expect(y[i]).toBe(0);
  });

  it('never lets a sample past the ceiling, even a burst 20 dB over that starts at once', () => {
    for (const a of [1, 3, 9, 100]) {
      const x = burst(SR, a, 777, 20000), y = limit(x);
      expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(CEILING * (1 + 1e-6));
      // And it does limit, to the ceiling, not below: the loudest output sample is within 1% of it.
      expect(Math.max(...y.map(Math.abs))).toBeGreaterThan(0.99 * CEILING);
    }
  });

  it('changes gain in ramps: no step at a block edge or anywhere (the old limiter stepped 12 dB)', () => {
    const lim = new Limiter(), x = burst(SR, 9, 777, 20000), y = limit(x, lim);
    // The gain on each played sample, where the input is large enough to read it; its change per sample
    // between two such samples. It starts falling in the lookahead's silence before the burst plays.
    let worst = 0, prev = NaN, at = 0;
    for (let i = DELAY; i < x.length; i++) {
      const xi = x[i - DELAY]!;
      if (Math.abs(xi) < 0.05) continue;
      const g = y[i]! / xi;
      if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(g - prev) / (i - at));
      prev = g; at = i;
    }
    expect(lim.minGain).toBeCloseTo(CEILING / 9, 2);
    // The steepest it can fall: from 1 to the least gain over the lookahead, in equal steps.
    expect(worst).toBeLessThanOrEqual(((1 - lim.minGain) / LOOKAHEAD) * 1.001);
  });

  it('recovers after the burst at the release rate', () => {
    const lim = new Limiter(), x = burst(2 * SR, 9, 0, 4800), quiet = burst(2 * SR, 0.5, 0, 2 * SR);
    for (let i = 4800; i < x.length; i++) x[i] = quiet[i]!;
    const y = limit(x, lim);
    // 0.1 back to ~1: ln(10) release constants (0.35 s); by 1 s in it plays the 0.5 sine unchanged.
    const i = SR + 123;
    expect(y[i]! / x[i - DELAY]!).toBeCloseTo(1, 6);
    const early = 4800 + DELAY + 2400; // 50 ms after: still well down
    expect(Math.abs(y[early]! / x[early - DELAY]!)).toBeLessThan(0.2);
  });
});

describe('HighPass (the master low cut)', () => {
  /** Gain, dB, of a steady sine at f through the filter at corner fc (after 1 s of settling). */
  const response = (f: number, fc: number) => {
    const hp = new HighPass(), n = 2 * SR, L = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR)), R = L.slice();
    for (let o = 0; o < n; o += BLOCK) hp.process(L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK), fc, SR);
    let a = 0, b = 0;
    for (let i = SR; i < n; i++) { a += L[i]! ** 2; b += Math.sin((2 * Math.PI * f * i) / SR) ** 2; }
    return 10 * Math.log10(a / b);
  };
  it('is a Butterworth: -3 dB at the corner, -12 dB an octave under it per 2nd order, flat above', () => {
    expect(response(35, 35)).toBeCloseTo(-3.01, 1);
    expect(response(17.5, 35)).toBeLessThan(-12);
    expect(response(17.5, 35)).toBeGreaterThan(-12.6);
    expect(Math.abs(response(200, 35))).toBeLessThan(0.01);
    expect(Math.abs(response(5000, 35))).toBeLessThan(0.001);
  });
});
