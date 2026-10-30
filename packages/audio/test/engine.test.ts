import { describe, expect, it } from 'vitest';
import { type AudioFrame, BLOCK, cellOf, CollapseEngine, contactTime, DV_EDGES, normInv, SOUND_MATERIALS, type SoundMaterial, TOP_FIELDS } from '@tb/audio';

const SR = 48000, FRAME = 800; // 60 Hz
const pine: SoundMaterial = SOUND_MATERIALS.pine;

interface Cell { bin: number; sector?: number; count: number; a2: number }
function frame(cells: Cell[], top: number[][] = [], sectors = 4): AudioFrame {
  const n = DV_EDGES.length * sectors, counts = new Float32Array(n), a2 = new Float32Array(n);
  for (const c of cells) { const k = cellOf(0, c.bin, c.sector ?? 1, sectors); counts[k]! += c.count; a2[k]! += c.a2; }
  const t = new Float32Array(top.length * TOP_FIELDS);
  top.forEach((x, j) => t.set(x, j * TOP_FIELDS));
  return { dt: FRAME / SR, materials: 1, sectors, counts, a2, top: t };
}

function engine(seed = 1, m: SoundMaterial = pine, opts = {}) {
  const e = new CollapseEngine({ sampleRate: SR, seed, fullScale: 1000, ...opts });
  e.setMaterial(0, m);
  return e;
}

/** Render `blocks` blocks, calling feed(blockIndex) before each; mono sum L + R (and energy L^2 + R^2). */
function run(e: CollapseEngine, blocks: number, feed: (b: number) => void = () => {}) {
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), mono = new Float32Array(blocks * BLOCK);
  let energy = 0;
  for (let b = 0; b < blocks; b++) {
    feed(b);
    e.render(L, R);
    for (let i = 0; i < BLOCK; i++) { mono[b * BLOCK + i] = L[i]! + R[i]!; energy += L[i]! ** 2 + R[i]! ** 2; }
  }
  return { mono, energy };
}
const db = (x: number) => 10 * Math.log10(x);

/** 60 Hz modulation: envelope power at 60/120/180 Hz over the mean of the 30-200 Hz modulation band (dB). */
function buzz(x: Float32Array): number {
  const hop = 48, n = Math.floor(x.length / hop), env = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < hop; j++) s += x[i * hop + j]! ** 2; env[i] = Math.sqrt(s / hop); }
  const mean = env.reduce((a, b) => a + b, 0) / n, fs = SR / hop;
  const power = (f: number) => { let re = 0, im = 0; for (let i = 0; i < n; i++) { const a = (2 * Math.PI * f * i) / fs; re += (env[i]! - mean) * Math.cos(a); im += (env[i]! - mean) * Math.sin(a); } return re * re + im * im; };
  const lines = [60, 120, 180].map(power).reduce((a, b) => a + b, 0) / 3;
  let band = 0, k = 0;
  for (let f = 31; f < 200; f += 1.7) if (![60, 120, 180].some((h) => Math.abs(f - h) < 4)) { band += power(f); k++; }
  return db(lines / (band / k));
}

/** Energy per octave band (16 Hz to 24 kHz, 11 bands) of x, zero-padded to 2^15 samples. */
function octaves(x: Float32Array): number[] {
  const N = 1 << 15, re = new Float64Array(N), im = new Float64Array(N);
  re.set(x.subarray(0, N));
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [re[i], re[j]] = [re[j]!, re[i]!]; }
  for (let len = 2; len <= N; len <<= 1) for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
    const a = (-2 * Math.PI * k) / len, wr = Math.cos(a), wi = Math.sin(a), p = i + k, q = p + len / 2;
    const vr = re[q]! * wr - im[q]! * wi, vi = re[q]! * wi + im[q]! * wr;
    re[q] = re[p]! - vr; im[q] = im[p]! - vi; re[p]! += vr; im[p]! += vi;
  }
  const out = new Array<number>(11).fill(0);
  for (let k = 1; k < N / 2; k++) out[Math.min(10, Math.max(0, Math.floor(Math.log2((k * SR) / N / 16))))]! += re[k]! ** 2 + im[k]! ** 2;
  return out;
}

describe('CollapseEngine', () => {
  it('normInv is the standard normal quantile', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 9);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normInv(0.001)).toBeCloseTo(-3.090232, 5);
  });

  it('is silent with no impacts and when muted, and never NaN', () => {
    expect(run(engine(), 40).energy).toBe(0);
    const e = engine(); e.muted = true;
    expect(run(e, 40, (b) => b === 0 && e.push(frame([{ bin: 3, count: 50, a2: 50 }]))).energy).toBe(0);
    const f = engine(1, pine, { fullScale: 1 });
    const { mono } = run(f, 200, (b) => b % 6 === 0 && f.push(frame([{ bin: 5, count: 1e6, a2: 1e8 }], [[100, 0.5, 0, 0, 3]])));
    expect(mono.every(Number.isFinite)).toBe(true);
    expect(Math.max(...mono.map(Math.abs))).toBeLessThanOrEqual(2 * 0.9 + 1e-6); // limiter: each channel <= 0.9
  });

  it('n impacts sound 10 log10 n dB above one (incoherent sum), within 1 dB over seeds', () => {
    let one = 0, many = 0;
    // A single impact's energy varies a lot with where it lands, so average many.
    for (let seed = 1; seed <= 400; seed++) { const a = engine(seed); one += run(a, 30, (b) => b === 0 && a.push(frame([{ bin: 2, count: 1, a2: 0.01 }]))).energy; }
    for (let seed = 1; seed <= 12; seed++) { const c = engine(seed + 1000); many += run(c, 30, (b) => b === 0 && c.push(frame([{ bin: 2, count: 64, a2: 0.64 }]))).energy; }
    one /= 400; many /= 12;
    expect(db(many / one)).toBeGreaterThan(db(64) - 1);
    expect(db(many / one)).toBeLessThan(db(64) + 1);
  });

  it('a foreground voice and the bank give one impact the same energy, within 1.5 dB over seeds', () => {
    let fg = 0, bank = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const a = engine(seed); fg += run(a, 60, (b) => b === 0 && a.push(frame([{ bin: 2, count: 1, a2: 0.0169 }], [[1.3, 10, -0.25, 0, normInv((seed - 0.5) / 24)]]))).energy;
      const c = engine(seed); bank += run(c, 60, (b) => b === 0 && c.push(frame([{ bin: 2, count: 1, a2: 0.0169 }]))).energy;
    }
    expect(Math.abs(db(fg / bank))).toBeLessThan(1.5);
  });

  it('a click-only material carries the exact click kernel energy', () => {
    const quiet = { ...pine, ringDb: -Infinity };
    let bank = 0, fg = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const a = engine(seed, quiet); bank += run(a, 40, (b) => b === 0 && a.push(frame([{ bin: 2, count: 1, a2: 1 }]))).energy;
      const c = engine(seed, quiet); fg += run(c, 40, (b) => b === 0 && c.push(frame([{ bin: 2, sector: 2, count: 1, a2: 1 }], [[1.41, 1.41, 0, 0, 0]]))).energy;
    }
    // Both: A = 1 and the contact time of dv = 1.41 m/s; the voice plays the exact kernel, the bank a matched band-pass.
    expect(Math.abs(db(bank / fg))).toBeLessThan(0.5);
  });

  // The bank's click used to be an impulse into a damped band-pass, differentiated: right energy, but
  // its first sample was a full-band spike, so a 1 m stone block's 60 Hz thump came out as a tick
  // 34-46 dB too bright at 1-4 kHz, and a stone collapse (all bank) as crackle.
  it.each([['stone, 1 m blocks', SOUND_MATERIALS.stone, 1], ['stone, 0.25 m', SOUND_MATERIALS.stone, 0.25], ['stone, Kapla-size', SOUND_MATERIALS.stone, 0.0234], ['acrylic', SOUND_MATERIALS.acrylic, 1], ['pine', pine, 1]] as const)('the bank plays the exact click kernel, band for band (%s)', (_name, m, edge) => {
    const quiet = { ...m, ringDb: -Infinity }, bin = 2, dv = DV_EDGES[bin] * Math.SQRT2; // the bin's own contact time
    const play = (voice: boolean) => {
      const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: 1e6 });
      e.setMaterial(0, quiet, edge);
      return run(e, 300, (b) => b === 0 && e.push(frame([{ bin, sector: 2, count: 1, a2: 1 }], voice ? [[dv, dv, 0, 0, 0]] : []))).mono;
    };
    const fg = octaves(play(true)), bank = octaves(play(false)), total = fg.reduce((a, b) => a + b, 0);
    // Within 1 dB where the click is (bands with 1% of its energy), 3 dB in its faint skirts: the bank's
    // cycle is a whole number of samples (20 for acrylic and pine, so up to 2.5% off the contact time).
    // A click under 16 samples (stone at Kapla size: 8) is sampled too coarsely for its top octave in
    // either path: against the band-limited pulse the kernel reads 16 kHz 4.6 dB low and the bank 4.8 dB
    // high, so that octave is left out for it (a band-limited kernel for both would fix it).
    const D = Math.round(contactTime(m, dv, edge) * SR);
    fg.forEach((x, k) => { if (x > 1e-4 * total && (D >= 16 || k < 10)) expect(Math.abs(db(bank[k]! / x)), `octave ${16 * 2 ** k} Hz`).toBeLessThan(x > 0.01 * total ? 1 : 3); });
  });

  it('a click ends after one contact time: nothing rings on', () => {
    const e = engine(1, { ...SOUND_MATERIALS.stone, ringDb: -Infinity });
    e.setMaterial(0, { ...SOUND_MATERIALS.stone, ringDb: -Infinity }, 1);
    e.lowcut = 0; // the master high-pass has a tail of its own
    const { mono } = run(e, 200, (b) => b === 0 && e.push(frame([{ bin: 3, count: 1, a2: 1 }])));
    const first = mono.findIndex((x) => x !== 0), T = contactTime(SOUND_MATERIALS.stone, DV_EDGES[3] * Math.SQRT2, 1);
    expect(first).toBeGreaterThan(0);
    const peak = Math.max(...mono.map(Math.abs)), after = mono.subarray(first + Math.ceil(T * SR) + 2);
    expect(Math.max(...after.map(Math.abs))).toBeLessThan(1e-9 * peak);
    expect(after.subarray(BLOCK).every((x) => x === 0)).toBe(true); // and its resonator went idle
  });

  it('spreads onsets over the frame: a steady dense stream has no 60 Hz buzz, aligned onsets do', () => {
    const feed = (e: CollapseEngine) => { let next = 0; return (b: number) => { while (next <= b * BLOCK) { e.push(frame([{ bin: 2, count: 200, a2: 2 }])); next += FRAME; } }; };
    const a = engine(3); const spread = buzz(run(a, 1500, feed(a)).mono.subarray(20000));
    const c = engine(3); c.alignOnsets = true; const aligned = buzz(run(c, 1500, feed(c)).mono.subarray(20000));
    expect(spread).toBeLessThan(3);
    expect(aligned).toBeGreaterThan(spread + 6);
  });

  it('schedules a frame after the latency and keeps a steady stream gapless', () => {
    const e = engine(); e.latency = 0.03;
    const { mono } = run(e, 600, (b) => { if (b % 6 === 0 && b < 500) e.push(frame([{ bin: 3, count: 100, a2: 4 }])); });
    const first = mono.findIndex((x) => x !== 0);
    expect(first).toBeGreaterThanOrEqual(0.03 * SR - BLOCK);
    expect(first).toBeLessThan(0.03 * SR + 2 * BLOCK);
    // 10 ms windows from 50 ms to 500 blocks in: none silent.
    for (let w = Math.round(0.05 * SR); w + 480 < 480 * BLOCK; w += 480) {
      let s = 0; for (let i = w; i < w + 480; i++) s += mono[i]! ** 2;
      expect(s).toBeGreaterThan(0);
    }
  });

  it('a material change is live: four times the stiffness, twice the pitch', () => {
    const pitch = (m: SoundMaterial) => {
      const e = engine(5, { ...m, jitter: 0, clickDb: -Infinity });
      const { mono } = run(e, 60, (b) => b === 0 && e.push(frame([], [[1, 1, 0, 0, 0]])));
      let best = 0, bf = 0;
      for (let f = 1000; f < 12000; f += 10) {
        let re = 0, im = 0; for (let i = 0; i < 4096; i++) { const v = mono[1400 + i]!; re += v * Math.cos((2 * Math.PI * f * i) / SR); im += v * Math.sin((2 * Math.PI * f * i) / SR); }
        if (re * re + im * im > best) { best = re * re + im * im; bf = f; }
      }
      return bf;
    };
    const f0 = pitch(pine), f1 = pitch({ ...pine, E: 4 * pine.E, G: 4 * pine.G! });
    expect(f1 / f0).toBeGreaterThan(1.95);
    expect(f1 / f0).toBeLessThan(2.05);
    // And on a running engine, setMaterial swaps coefficients without dropping the ringing state.
    const e = engine();
    run(e, 20, (b) => b === 0 && e.push(frame([{ bin: 3, count: 50, a2: 5 }])));
    e.setMaterial(0, { ...pine, eta: 0.02 });
    expect(e.liveResonators()).toBeGreaterThan(0);
  });

  it('cost does not grow with the impact count', () => {
    const live = (n: number) => { const e = engine(); run(e, 12, (b) => b === 0 && e.push(frame([0, 1, 2, 3, 4, 5].flatMap((bin) => [0, 1, 2, 3].map((sector) => ({ bin, sector, count: n, a2: n * 0.01 })))))); return e.liveResonators(); };
    const C = 8, S = 4, M = 13;
    expect(live(1e5)).toBeLessThanOrEqual(C * S * M);
    expect(live(1e5)).toBe(live(1e3));
  });
});
