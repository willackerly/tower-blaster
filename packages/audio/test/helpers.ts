// Shared helpers for the engine's tests: frames from histogram cells, block rendering, octave energies.
import { type AudioFrame, BLOCK, cellOf, CLASSIC_SOUND_MATERIALS, CollapseEngine, DV_EDGES, type SoundMaterial, TOP_FIELDS } from '@tb/audio';

export const SR = 48000, FRAME = 800; // 60 Hz
/** The free Kapla plank (the classic set's pine): the engine's tests pin its physics, which the real set's pile damping (A9) would blur. */
export const pine: SoundMaterial = CLASSIC_SOUND_MATERIALS.pine;

export interface Cell { bin: number; sector?: number; count: number; a2: number }
export function frame(cells: Cell[], top: number[][] = [], sectors = 4): AudioFrame {
  const n = DV_EDGES.length * sectors, counts = new Float32Array(n), a2 = new Float32Array(n);
  for (const c of cells) { const k = cellOf(0, c.bin, c.sector ?? 1, sectors); counts[k]! += c.count; a2[k]! += c.a2; }
  const t = new Float32Array(top.length * TOP_FIELDS);
  top.forEach((x, j) => t.set(x, j * TOP_FIELDS));
  return { dt: FRAME / SR, materials: 1, sectors, counts, a2, top: t };
}

export function engine(seed = 1, m: SoundMaterial = pine, opts = {}) {
  const e = new CollapseEngine({ sampleRate: SR, seed, fullScale: 1000, ...opts });
  e.setMaterial(0, m);
  return e;
}

/** Render `blocks` blocks, calling feed(blockIndex) before each; mono sum L + R (and energy L^2 + R^2). */
export function run(e: CollapseEngine, blocks: number, feed: (b: number) => void = () => {}) {
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), mono = new Float32Array(blocks * BLOCK);
  let energy = 0;
  for (let b = 0; b < blocks; b++) {
    feed(b);
    e.render(L, R);
    for (let i = 0; i < BLOCK; i++) { mono[b * BLOCK + i] = L[i]! + R[i]!; energy += L[i]! ** 2 + R[i]! ** 2; }
  }
  return { mono, energy };
}
export const db = (x: number) => 10 * Math.log10(x);

/** 60 Hz modulation: envelope power at 60/120/180 Hz over the mean of the 30-200 Hz modulation band (dB). */
export function buzz(x: Float32Array): number {
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
export function octaves(x: Float32Array): number[] {
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

