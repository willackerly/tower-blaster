// The collapse synthesiser: pure TS, no WebAudio, so node tests drive it and
// the AudioWorklet (worklet.ts) only moves blocks in and out.
//
//   foreground  each frame's loudest impacts (AudioFrame.top) play as their
//               own modal voices: exact dv, contact time, pitch and pan.
//   bank        everything else. By linearity, all impacts on bodies that
//               ring at the same frequencies sum into one resonator per mode,
//               so the bank holds (pitch class x sector x mode) resonators per
//               material and its cost does not depend on the body count.
//               Each frame's histogram is turned back into impulses: n per
//               cell (at most maxImpulses, carrying the cell's sum A^2 exactly),
//               dv log-uniform in the bin, a random contact point and class.
//   clicks      the rigid-body click of every impact (one cycle of a sine as
//               long as the contact, clickKernel), exactly: per (material, bin,
//               sector) an undamped resonator with that period, fed each
//               impulse and, one period later, its negative, which stops it.
//   dense       the modes above the table (materials with a finite denseDb): per
//               (material, sector, half-octave band) a loop of band noise under an
//               amplitude that each impulse raises by the band's energy (denseField)
//               and that decays at the band's loss factor. Energy-exact in
//               expectation, like the bank; foreground impacts feed it too.
//   grit        chips knocked off hard hits (materials with a finite gritDb:
//               stone), plan S8: each impact over GRIT.dvMin sheds a Poisson
//               number of tiny bright grains (one of GRAIN_VARIANTS kernels,
//               ~1.5-12 kHz) over an exponential spread after it. Foreground
//               impacts and the bank's rebuilt impulses shed them alike, so a
//               grain carries a known energy (gritEnergy) whichever path it
//               came from; above maxGrains a cell and frame, fewer grains carry
//               the same energy. Grit draws from its own random stream: the
//               modes and clicks are bit for bit the same with it on or off.
//
// Impulse times are spread uniformly over the frame they arrived in, never on
// the frame start: aligned onsets buzz at the frame rate (+13 dB in the study).
// A frame is scheduled `latency` seconds after it arrives, or right after the
// previous frame, so frames neither overlap nor leave gaps; the clock resyncs if
// the two drift apart by more than `resync`.
//
// Master: Pa to full scale, a low cut (2nd-order Butterworth high-pass at
// `lowcut` Hz: below ~35 Hz no speaker plays it, yet a big block's thump puts
// a third of its energy there, which only uses up headroom), then a lookahead
// peak limiter (Limiter): gain changes are ramps, never steps, so heavy
// limiting does not crackle.
import { binOf, DV_EDGES, TOP_FIELDS, type AudioFrame } from './frame.ts';
import type { SoundMaterial } from './material.ts';
import { BL_CLICK_MAX, C_AIR, clickFilter, clickKernel, contactTime, mass, RHO_AIR, radiatedClick, DENSE_BANDS, denseField, forceSpectrum, gauss, modes, roughness, roughTime, soundSize, type Modes } from './modes.ts';

export const BLOCK = 128;
const RING = 64; // blocks of scheduling horizon (171 ms at 48 kHz)
const BUCKET = 4096; // impulses per block, at most
/** Limiter ceiling (each channel) and lookahead, samples. */
export const CEILING = 0.9;
export const LOOKAHEAD = 64;

/**
 * Grit, the study's chip model (/mnt/project-files/sound/scripts/snd.py, add_grit) made exact in energy:
 * an impact of speed change dv (m/s) at A = dv / distance sheds Poisson(min(perDv dv, most)) grains when
 * dv > dvMin, each delayed by an exponential of mean spread (s, for a refEdge block; sqrt(edge / refEdge)
 * for others, as chips fall from higher), with a lognormal(0, sigma) amplitude normalised to mean square 1.
 * A grain's energy (sum of squares at 48 kHz, Pa^2) is (pa 10^(gritDb / 20) (edge / refEdge)^1.5 A dv)^2:
 * chip energy in proportion to the block's volume. pa matches the study's grain (0.02 Pa per (m/s)^2/m,
 * peak 1 on a 9-sample Hann derivative) for a 25 cm block.
 */
export const GRIT = { dvMin: 0.6, perDv: 3, most: 30, spread: 0.02, refEdge: 0.25, sigma: 0.7, pa: 0.02 } as const;
/** Grain kernels (chip sizes): lengths 4 to 32 samples at 48 kHz, log spaced. */
export const GRAIN_VARIANTS = 16;
const GRING = 128; // blocks of grain horizon (341 ms at 48 kHz): a frame up to `resync` ahead plus the spread's tail
const GBUCKET = 1024; // grains per block, at most
/** Dense field noise loops: samples per band (0.68 s at 48 kHz). */
export const DENSE_LOOP = 1 << 15;
/** Class marker of an impulse that only drives the dense field (a foreground impact: its modes are a voice). */
const DENSE_ONLY = 0xffff;

/** In-place radix-2 FFT (sign -1 forward, +1 inverse, unscaled). */
function fft(re: Float64Array, im: Float64Array, sign: number): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; } }
  for (let len = 2; len <= N; len <<= 1) for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
    const a = (sign * 2 * Math.PI * k) / len, wr = Math.cos(a), wi = Math.sin(a), p = i + k, q = p + len / 2;
    const vr = re[q]! * wr - im[q]! * wi, vi = re[q]! * wi + im[q]! * wr;
    re[q] = re[p]! - vr; im[q] = im[p]! - vi; re[p]! += vr; im[p]! += vi;
  }
}

/**
 * The dense field's band noise: per DENSE_BANDS centre, a periodic loop of DENSE_LOOP samples with mean
 * square 1 and a cos^2 response over +-1 half-octave (power-complementary: the bands' squares sum to 1
 * across the range), from random phases of a fixed seed.
 */
export function denseNoise(sr: number, seed = 7): Float32Array[] {
  const rand = mulberry(seed), N = DENSE_LOOP;
  return DENSE_BANDS.map((c) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 1; k < N / 2; k++) {
      const x = 2 * Math.log2((k * sr) / N / c);
      if (Math.abs(x) >= 1) continue;
      const h = Math.cos((Math.PI * x) / 2), ph = 2 * Math.PI * rand();
      re[k] = h * Math.cos(ph); im[k] = h * Math.sin(ph); re[N - k] = re[k]!; im[N - k] = -im[k]!;
    }
    fft(re, im, 1);
    let ms = 0;
    for (let i = 0; i < N; i++) ms += re[i]! ** 2;
    const g = 1 / Math.sqrt(ms / N || 1);
    return Float32Array.from(re, (x) => x * g);
  });
}

/** Hann derivative of `len` samples (the study's chip click), scaled to energy `energy`. */
function hannStep(len: number, energy: number): Float32Array {
  const h = (n: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / len), out = new Float32Array(len);
  let e = 0;
  for (let i = 0; i < len; i++) { out[i] = h(i + 1) - h(i); e += out[i]! ** 2; }
  for (let i = 0; i < len; i++) out[i]! *= Math.sqrt(energy / e);
  return out;
}

/** The grain kernels at a sample rate: unit energy at 48 kHz (energy in proportion to the rate, as a fixed-length pulse's). */
export function grainKernels(sr: number): Float32Array[] {
  return Array.from({ length: GRAIN_VARIANTS }, (_, j) => hannStep(Math.max(3, Math.round(4 * 8 ** (j / (GRAIN_VARIANTS - 1)) * (sr / 48000))), sr / 48000));
}

/** Pa^2 at 48 kHz per (A dv)^2 of one grain of material m on a block of `edge` metres (0: no grit). */
export function gritEnergy(m: SoundMaterial, edge = 1): number {
  if (!(m.gritDb > -Infinity)) return 0;
  // The study's grain: peak 0.02 on diff(hanning(10)) (9 samples), lognormal(0, 0.7) amplitude (mean square e^0.98).
  const ref = hannStep(9, 1), peak = Math.max(...ref.map(Math.abs)), study = (GRIT.pa / peak) ** 2 * Math.exp(2 * GRIT.sigma ** 2);
  return study * 10 ** (m.gritDb / 10) * (soundSize(m, edge) / GRIT.refEdge) ** 3;
}

/**
 * Most of an impact's kinetic energy (1/2 m* dv^2) its grit may radiate. Grit's energy grows as
 * rate dv^3 (grains in proportion to dv, each of (A dv)^2) against the impact's dv^2, so a loud
 * crack burst (ice, gritDb 50) would pass 15% of the energy at 4 m/s; fracture radiates far less.
 * Past the share an impact sheds fewer grains of the same size. G6's grit never reaches it.
 */
export const GRIT_SHARE = 0.05;

/** Expected grains of one impact (rate: the material's gritRate, grains per m/s; the cap scales with it). */
export const gritGrains = (dv: number, rate: number = GRIT.perDv): number => (dv > GRIT.dvMin ? Math.min(rate * dv, (GRIT.most * rate) / GRIT.perDv) : 0);

/** Expected grains of one impact on a material: its gritRate's, under the GRIT_SHARE cap. */
const grainsOf = (st: { gritRate: number; gritCap: number }, dv: number): number => Math.min(gritGrains(dv, st.gritRate), st.gritCap / (dv * dv));

export interface EngineOptions {
  sampleRate: number;
  /** Pitch classes per material (quantiles of the body-to-body jitter). */
  classes?: number;
  sectors?: number;
  /** Most foreground voices at once; the quietest is stolen. */
  voices?: number;
  /** Most impulses rebuilt per histogram cell and frame (above: fewer, stronger ones of the same energy). */
  maxImpulses?: number;
  /** Most grit grains per histogram cell and frame, expected (above: fewer, stronger ones of the same energy). */
  maxGrains?: number;
  latency?: number;
  resync?: number;
  /** Pressure (Pa at the listener) that maps to full scale before the limiter. */
  fullScale?: number;
  seed?: number;
}

interface MatState {
  slot: number; // its index in mats
  /** The material's levelDb as a gain on every impact's A = dv / distance (all of its sound is linear in A). */
  level: number;
  m: SoundMaterial;
  md: Modes;
  /** Body edge for shell and cube materials without their own size. */
  edge: number;
  M: number;
  /** Per class: frequency multiplier. Resonator r = (class * sectors + sector) * M + mode. */
  mult: Float64Array;
  a1: Float32Array; a2: Float32Array; b: Float32Array;
  y1: Float32Array; y2: Float32Array;
  x: Float32Array; // BLOCK inputs per resonator
  live: Uint8Array; // resonator has input or ringing state this block
  nLive: number; // of live, how many are set (0: the bank is idle and not scanned)
  cIn: Uint8Array; // per (bin, sector): input this block
  /** Click resonator per (bin, sector): its period D (samples, per bin), 2 cos(2 pi / D), state, input and the input's last D samples. */
  cD: Int32Array; cc: Float64Array; cy1: Float64Array; cy2: Float64Array; cx: Float32Array; cring: Float64Array[];
  cLast: Float64Array; // per (bin, sector): absolute sample of its last input (-Infinity: none)
  /**
   * Per bin: a click shorter than BL_CLICK_MAX samples plays as its band-limited kernel instead (A7; null: the
   * resonator), overlap-added per (bin, sector) into cAcc (BLOCK + the kernel's length).
   */
  cFir: (Float32Array | null)[]; cAcc: Float64Array[];
  clickPeak: Float64Array; // per bin: impulse into the click resonator per (m/s of dv per m)
  /** Radiation filter of the bank's clicks (clickFilter; null: the compact dipole), its per-sector state [x1 x2 y1 y2] and bus. */
  cf: [number, number, number, number, number] | null; cfz: Float64Array; cbus: Float64Array;
  binT: Float64Array; // per bin: contact time
  w: Float64Array; // scratch weights
  /** Grit: amplitude per (A dv) of a unit-energy grain kernel (0: none), and the grains' mean delay in samples. */
  gritAmp: number; gritDelay: number; gritRate: number;
  /** Most grains an impact sheds, times dv^2: GRIT_SHARE of its kinetic energy (Infinity: no grit). */
  gritCap: number;
  /** Ringing cracks (gritRing): a grain's dry click gain, sqrt(1 - ring), and the impulse A per unit of grain amplitude that rings the body with ring of its energy (0: none). */
  gritDry: number; crackA: number;
  /** Contact roughness (amplitude floor re the impulse, 0: smooth). */
  rough: number;
  /** Asperity contact time, s (roughTime). */
  roughT: number;
  /**
   * Dense field (null: off): per (bin, band) the squared amplitude an impulse of A = 1 adds (2 E / tau),
   * per band the amplitude decay a sample, per (sector, band) the amplitude and this block's additions.
   */
  dK: Float64Array | null; dDec: Float64Array; dA: Float64Array; dIn: Float32Array; dLive: number;
}

interface Voice {
  on: boolean; mat: number; age: number; life: number; level: number;
  gl: number; gr: number;
  a1: Float32Array; a2: Float32Array; y1: Float32Array; y2: Float32Array; M: number;
  click: Float32Array; clickAt: number; clickGain: number;
  start: number; // absolute sample
  amp: Float32Array;
}

/** Equal-power gains for a pan in [-1, 1]. */
export const panGains = (pan: number): [number, number] => { const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4; return [Math.cos(a), Math.sin(a)]; };

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q0 = Math.min(p, 1 - p);
  if (q0 < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(q0));
    const x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    return p < 0.5 ? x : -x;
  }
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coeffs(f: number, tau: number, sr: number): [number, number, number] {
  const r = Math.exp(-1 / (tau * sr)), th = (2 * Math.PI * Math.min(f, 0.45 * sr)) / sr;
  return [2 * r * Math.cos(th), -r * r, Math.sin(th)];
}

export class CollapseEngine {
  readonly sr: number;
  readonly classes: number;
  readonly sectors: number;
  readonly maxImpulses: number;
  readonly maxGrains: number;
  latency: number;
  resync: number;
  fullScale: number;
  /** Master high-pass corner, Hz (0: off). */
  lowcut = 35;
  muted = false;
  /** Debug: put every impulse on its frame's first sample (the study's buzz). */
  alignOnsets = false;
  private mats: (MatState | null)[] = [];
  private voices: Voice[];
  private rand: () => number;
  private grand: () => number; // grit's own stream
  private kernels: Float32Array[];
  private dnoise: Float32Array[] | null = null; // the dense field's band noise, made when a material first needs it
  private gbus: Float32Array; // per sector: this block and the next DMAX samples of grains
  private gw: number;
  private now = 0; // absolute sample of the next block
  private nextFrame = -1; // absolute sample where the next frame starts
  private sector = new Float32Array(0);
  readonly limiter = new Limiter();
  readonly highpass = new HighPass();
  // Impulse buckets, by block: t (sample in block), material, class, sector, A, dv.
  private bt = new Uint16Array(RING * BUCKET);
  private bm = new Uint8Array(RING * BUCKET);
  private bc = new Uint16Array(RING * BUCKET);
  private bs = new Uint8Array(RING * BUCKET);
  private bA = new Float32Array(RING * BUCKET);
  private bdv = new Float32Array(RING * BUCKET);
  private bn = new Uint32Array(RING);
  /** Impulses dropped for a full bucket (their energy goes to the bucket's last impulse). */
  overflow = 0;
  // Grain buckets, by block: t, sector, kernel, amplitude.
  private gt = new Uint16Array(GRING * GBUCKET);
  private gs = new Uint8Array(GRING * GBUCKET);
  private gv = new Uint8Array(GRING * GBUCKET);
  private ga = new Float32Array(GRING * GBUCKET);
  private gn = new Uint32Array(GRING);
  private gm = new Uint8Array(GRING * GBUCKET); // the grain's material slot
  /** Grains merged into a full bucket's last (their energy kept). */
  gritOverflow = 0;
  /** Grains scheduled (a probe for tests and stats). */
  grains = 0;
  /** Resonator samples computed, bank and clicks (a cost probe: idle materials add none). */
  work = 0;

  constructor(opts: EngineOptions) {
    this.sr = opts.sampleRate;
    this.classes = opts.classes ?? 8;
    this.sectors = opts.sectors ?? 4;
    this.maxImpulses = opts.maxImpulses ?? 256;
    this.maxGrains = opts.maxGrains ?? 64;
    this.latency = opts.latency ?? 0.03;
    this.resync = opts.resync ?? 0.12;
    this.fullScale = opts.fullScale ?? 30;
    this.rand = mulberry(opts.seed ?? 1);
    this.grand = mulberry((opts.seed ?? 1) ^ 0x5bd1e995);
    this.sector = new Float32Array(this.sectors * BLOCK);
    this.kernels = grainKernels(this.sr);
    const dmax = Math.max(...this.kernels.map((k) => k.length));
    if (dmax > BLOCK) throw new Error(`grain kernels longer than a block at ${this.sr} Hz`);
    this.gw = BLOCK + dmax;
    this.gbus = new Float32Array(this.sectors * this.gw);
    this.voices = Array.from({ length: opts.voices ?? 48 }, () => ({
      on: false, mat: 0, age: 0, life: 0, level: 0, gl: 0, gr: 0, M: 0,
      a1: new Float32Array(64), a2: new Float32Array(64), y1: new Float32Array(64), y2: new Float32Array(64), amp: new Float32Array(64),
      click: new Float32Array(0), clickAt: 0, clickGain: 0, start: 0,
    }));
  }

  /** Install or change material i (live: state is kept when the mode count is unchanged). */
  setMaterial(i: number, m: SoundMaterial | null, edge = 1): void {
    if (!m) { this.mats[i] = null; return; }
    const md = modes(m, edge), M = Math.min(md.freq.length, 64), C = this.classes, S = this.sectors, n = C * S * M;
    const old = this.mats[i];
    const keep = old && old.M === M;
    const st: MatState = {
      slot: i, m, md, edge, M, mult: new Float64Array(C), level: 10 ** ((m.levelDb ?? 0) / 20),
      a1: new Float32Array(n), a2: new Float32Array(n), b: new Float32Array(n),
      y1: keep ? old.y1 : new Float32Array(n), y2: keep ? old.y2 : new Float32Array(n),
      x: keep ? old.x : new Float32Array(n * BLOCK), live: keep ? old.live : new Uint8Array(n), nLive: keep ? old.nLive : 0,
      cIn: keep ? old.cIn : new Uint8Array(DV_EDGES.length * S),
      cD: new Int32Array(DV_EDGES.length), cc: new Float64Array(DV_EDGES.length),
      cy1: new Float64Array(DV_EDGES.length * S), cy2: new Float64Array(DV_EDGES.length * S),
      cx: keep ? old.cx : new Float32Array(DV_EDGES.length * S * BLOCK), cring: [], cLast: new Float64Array(DV_EDGES.length * S).fill(-Infinity),
      cFir: [], cAcc: [],
      cf: clickFilter(m, this.sr, edge), cfz: new Float64Array(4 * S), cbus: new Float64Array(S * BLOCK),
      clickPeak: new Float64Array(DV_EDGES.length), binT: new Float64Array(DV_EDGES.length), w: new Float64Array(md.freq.length),
      gritAmp: Math.sqrt(gritEnergy(m, edge)),
      gritRate: m.gritRate ?? GRIT.perDv, gritCap: Infinity, gritDry: Math.sqrt(1 - (m.gritRing ?? 0)), crackA: 0,
      gritDelay: (m.gritSpread ?? GRIT.spread) * Math.sqrt(soundSize(m, edge) / GRIT.refEdge) * this.sr,
      rough: roughness(m),
      roughT: roughTime(m),
      dK: null, dDec: new Float64Array(0), dA: new Float64Array(0), dIn: new Float32Array(0), dLive: 0,
    };
    for (let c = 0; c < C; c++) st.mult[c] = Math.exp(m.jitter * normInv((c + 0.5) / C));
    for (let c = 0; c < C; c++) for (let s = 0; s < S; s++) for (let k = 0; k < M; k++) {
      const r = (c * S + s) * M + k, [a1, a2, b] = coeffs(md.freq[k]! * st.mult[c]!, md.tau[k]!, this.sr);
      st.a1[r] = a1; st.a2[r] = a2; st.b[r] = b;
    }
    for (let bin = 0; bin < DV_EDGES.length; bin++) {
      const dv = DV_EDGES[bin]! * Math.SQRT2, T = contactTime(m, dv, edge);
      st.binT[bin] = T;
      // y = 2 cos(th) y1 - y2 + u, th = 2 pi / D, answers an impulse with sin((n + 1) th) / sin(th): one
      // cycle of the kernel's sine is D samples, and the same impulse negated D samples later ends it
      // (u = x - x[n - D]). Scaled so one impulse carries the exact kernel's energy (clickKernel) for a
      // unit dv at 1 m; the cycle's energy is D / 2 / sin(th)^2.
      const D = Math.max(4, Math.round(T * this.sr)), th = (2 * Math.PI) / D, kernel = clickKernel(m, T, this.sr, edge);
      st.cD[bin] = D; st.cc[bin] = 2 * Math.cos(th);
      // A short click (A7) is its band-limited kernel itself: an impulse of A plays A times it.
      const fir = m.clickBand === 'limited' && T * this.sr < BL_CLICK_MAX ? kernel : null;
      st.cFir.push(fir);
      let ek = 0;
      for (const x of kernel) ek += x * x;
      st.clickPeak[bin] = fir ? 1 : Math.sqrt(ek / (D / 2)) * Math.sin(th);
      for (let s = 0; s < S; s++) { st.cring.push(new Float64Array(fir ? 0 : D)); st.cAcc.push(new Float64Array(fir ? BLOCK + fir.length : 0)); }
    }
    const dense = denseField(m, st.binT, edge, Math.min(18000, 0.45 * this.sr));
    if (dense) {
      const B = DENSE_BANDS.length;
      st.dK = dense.energy.map((e, j) => (2 * e) / dense.tau[j % B]!);
      st.dDec = dense.tau.map((t) => Math.exp(-1 / (t * this.sr)));
      st.dA = keep && old.dA.length === S * B ? old.dA : new Float64Array(S * B);
      st.dIn = keep && old.dIn.length === S * B * BLOCK ? old.dIn : new Float32Array(S * B * BLOCK);
      st.dLive = keep ? old.dLive : 0;
      this.dnoise ??= denseNoise(this.sr);
    }
    // A click under way keeps playing through a change that keeps its period.
    if (keep) for (let r = 0; r < st.cring.length; r++) {
      const bin = Math.floor(r / S);
      if (old.cD[bin] !== st.cD[bin] || old.cAcc[r]?.length !== st.cAcc[r]!.length) continue;
      st.cring[r] = old.cring[r]!; st.cy1[r] = old.cy1[r]!; st.cy2[r] = old.cy2[r]!; st.cLast[r] = old.cLast[r]!; st.cAcc[r] = old.cAcc[r]!;
    }
    // Ringing cracks: a crack is a pulse shorter than any contact (flat over the modes, the shortest
    // contact's dense row), with no rigid-body click (it carries no momentum). Its energy for A = 1:
    // a mode of amplitude c rings c^2 tau sr / 4 (Pa^2 samples, the resonator's r^n sin), averaged over
    // the classes' unit-rms weights, plus the dense bands' A^2 E sr. crackA makes that ring of the grain's a^2.
    // Grit's energy cap: n grains of an impact at 1 m radiate W = 4 pi / (rho c) n gritAmp^2 dv^4 / 48000 (J).
    if (st.gritAmp > 0) st.gritCap = ((m.gritShare ?? GRIT_SHARE) * 0.5 * m.mstar * mass(m, edge) * RHO_AIR * C_AIR * 48000) / (4 * Math.PI * st.gritAmp ** 2);
    const ring = m.gritRing ?? 0;
    if (ring > 0 && st.gritAmp > 0) {
      let e = 0;
      for (let k = 0; k < M; k++) e += st.md.gain[k]! ** 2 * md.tau[k]! * this.sr / 4;
      if (st.dK) { const B = DENSE_BANDS.length, last = DV_EDGES.length - 1, dense = denseField(m, st.binT, edge, Math.min(18000, 0.45 * this.sr))!; for (let b = 0; b < B; b++) e += dense.energy[last * B + b]! * this.sr; }
      st.crackA = e > 0 ? Math.sqrt(ring / e) : 0;
    }
    this.mats[i] = st;
  }

  /** Schedule one frame's impacts. */
  push(f: AudioFrame): void {
    if (!(f.dt > 0)) return;
    const len = Math.round(f.dt * this.sr), earliest = this.now + Math.round(this.latency * this.sr);
    if (this.nextFrame < 0 || Math.abs(this.nextFrame - earliest) > this.resync * this.sr) this.nextFrame = earliest;
    const start = Math.max(this.nextFrame, this.now + BLOCK);
    this.nextFrame = start + len;
    const S = f.sectors;
    // Background: the histogram, less the foreground's share.
    const counts = Float32Array.from(f.counts), a2 = Float32Array.from(f.a2);
    for (let j = 0; j < f.top.length / TOP_FIELDS; j++) {
      const o = j * TOP_FIELDS, dv = f.top[o]!, dist = f.top[o + 1]!, pan = f.top[o + 2]!, mat = f.top[o + 3]!;
      const s = Math.min(S - 1, Math.max(0, Math.floor(((pan + 1) / 2) * S))), c = (mat * DV_EDGES.length + binOf(dv)) * S + s;
      counts[c] = Math.max(0, counts[c]! - 1); a2[c] = Math.max(0, a2[c]! - (dv / dist) ** 2);
      const at = start + (this.alignOnsets ? 0 : Math.floor(this.rand() * len));
      const st = this.mats[mat], A = (st?.level ?? 1) * dv / dist;
      this.voice(mat, dv, dv / A, pan, f.top[o + 4]!, at);
      if (st?.dK) this.impulse(at, mat, DENSE_ONLY, s, A, dv);
      if (st && st.gritAmp > 0) this.grit(st, at, s, A * dv, grainsOf(st, dv), 1);
    }
    for (let mat = 0; mat < f.materials; mat++) {
      if (!this.mats[mat]) continue;
      for (let bin = 0; bin < DV_EDGES.length; bin++) for (let s = 0; s < S && s < this.sectors; s++) {
        const c = (mat * DV_EDGES.length + bin) * S + s, n = Math.round(counts[c]!);
        if (n <= 0 || !(a2[c]! > 0)) continue;
        const k = Math.min(n, this.maxImpulses), lo = DV_EDGES[bin]!, hi = bin + 1 < DV_EDGES.length ? DV_EDGES[bin + 1]! : 2 * lo;
        // dv log-uniform in the bin; amplitudes in proportion to dv, scaled so their squares sum to the cell's a2.
        let sum = 0;
        const dvs: number[] = [];
        for (let e = 0; e < k; e++) { const dv = lo * (hi / lo) ** this.rand(); dvs.push(dv); sum += dv * dv; }
        const st = this.mats[mat]!, g = st.level * Math.sqrt(a2[c]! / sum);
        // Grit: impulse e stands for n / k impacts (its A^2 is theirs summed), so it sheds their grains,
        // n / k gritGrains(dv) of them, times q to keep the cell under maxGrains; each grain's amplitude is
        // over sqrt(n / k q), so the energy is what the impacts' own grains would carry.
        let q = 0;
        if (st.gritAmp > 0) { let lam = 0; for (const dv of dvs) lam += grainsOf(st, dv); lam *= n / k; q = lam > 0 ? Math.min(1, this.maxGrains / lam) * (n / k) : 0; }
        for (const dv of dvs) {
          const at = start + (this.alignOnsets ? 0 : Math.floor(this.rand() * len));
          this.impulse(at, mat, Math.min(this.classes - 1, Math.floor(this.rand() * this.classes)), s, g * dv, dv);
          if (q > 0) this.grit(st, at, s, g * dv * dv, grainsOf(st, dv) * q, 1 / Math.sqrt(q));
        }
      }
    }
  }

  private impulse(at: number, mat: number, cls: number, sector: number, A: number, dv: number): void {
    const blk = Math.floor(at / BLOCK), slot = blk % RING;
    if (blk - Math.floor(this.now / BLOCK) >= RING) return; // beyond the horizon: drop (a resync follows)
    let j = this.bn[slot]!;
    if (j >= BUCKET) { this.overflow++; const q = slot * BUCKET + BUCKET - 1; this.bA[q] = Math.hypot(this.bA[q]!, A); return; }
    const q = slot * BUCKET + j;
    this.bt[q] = at - blk * BLOCK; this.bm[q] = mat; this.bc[q] = cls; this.bs[q] = sector; this.bA[q] = A; this.bdv[q] = dv;
    this.bn[slot] = j + 1;
  }

  /** Schedule Poisson(lam) grains after sample `at` in a sector, each of amplitude gain * Adv * the material's per grain. */
  private grit(st: MatState, at: number, sector: number, Adv: number, lam: number, gain: number): void {
    if (!(lam > 0)) return;
    const r = this.grand, amp = st.gritAmp * Adv * gain, norm = Math.exp(-(GRIT.sigma ** 2)), nowBlk = Math.floor(this.now / BLOCK);
    // Poisson by products of uniforms (Knuth): lam is at most GRIT.most n / k q <= maxGrains here.
    const stop = Math.exp(-lam);
    for (let p = r(); p > stop; p *= r()) {
      let t = at + Math.floor(-Math.log(1 - r()) * st.gritDelay), blk = Math.floor(t / BLOCK);
      // A tail past the horizon (rare: frames run at most `resync` ahead) plays in its last block instead.
      if (blk - nowBlk >= GRING) { blk = nowBlk + GRING - 1; t = blk * BLOCK + (t % BLOCK); }
      const slot = blk % GRING, v = Math.min(GRAIN_VARIANTS - 1, Math.floor(r() * GRAIN_VARIANTS)), a = amp * norm * Math.exp(GRIT.sigma * gauss(r));
      this.grains++;
      const j = this.gn[slot]!;
      if (j >= GBUCKET) { this.gritOverflow++; const q = slot * GBUCKET + GBUCKET - 1; this.ga[q] = Math.hypot(this.ga[q]!, a); continue; }
      const q = slot * GBUCKET + j;
      this.gt[q] = t - blk * BLOCK; this.gs[q] = sector; this.gv[q] = v; this.ga[q] = a; this.gm[q] = st.slot;
      this.gn[slot] = j + 1;
    }
  }

  /** A short click's (bin, sector) r for this block: its impulses overlap-add their band-limited kernel (A7). */
  private firClick(st: MatState, r: number, h: Float32Array): void {
    const acc = st.cAcc[r]!, L = h.length, o = r * BLOCK, out = st.cf ? st.cbus : this.sector, so = (r % this.sectors) * BLOCK;
    let last = st.cLast[r]!;
    // Idle: no input this block, and the last kernel has played out.
    if (!st.cIn[r] && this.now - last >= L) return;
    st.cIn[r] = 0;
    this.work += BLOCK;
    for (let i = 0; i < BLOCK; i++) {
      const x = st.cx[o + i]!;
      if (x === 0) continue;
      st.cx[o + i] = 0; last = this.now + i;
      for (let j = 0; j < L; j++) acc[i + j]! += x * h[j]!;
    }
    for (let i = 0; i < BLOCK; i++) out[so + i]! += acc[i]!;
    acc.copyWithin(0, BLOCK); acc.fill(0, L);
    st.cLast[r] = last;
  }

  private voice(mat: number, dv: number, dist: number, pan: number, z: number, at: number): void {
    const st = this.mats[mat];
    if (!st) return;
    const level = dv / dist;
    let v = this.voices.find((x) => !x.on);
    if (!v) { v = this.voices.reduce((p, x) => (x.level * Math.exp(-x.age / x.life) < p.level * Math.exp(-p.age / p.life) ? x : p)); if (v.level * Math.exp(-v.age / v.life) > level) return; }
    const T = contactTime(st.m, dv, st.edge), mult = Math.exp(st.m.jitter * z), w = st.md.weights(this.rand, st.w);
    let tmax = 0;
    for (let k = 0; k < st.M; k++) {
      const f = st.md.freq[k]! * mult, [a1, a2] = coeffs(f, st.md.tau[k]!, this.sr);
      v.a1[k] = a1; v.a2[k] = a2; v.y1[k] = 0; v.y2[k] = 0;
      v.amp[k] = level * w[k]! * forceSpectrum(f, T, st.rough, st.roughT) * st.md.gain[k]! * Math.sin((2 * Math.PI * Math.min(f, 0.45 * this.sr)) / this.sr);
      tmax = Math.max(tmax, st.md.tau[k]!);
    }
    const [gl, gr] = panGains(pan);
    Object.assign(v, { on: true, mat, M: st.M, age: 0, life: Math.max(tmax, T) * this.sr, level, gl, gr, start: at, click: radiatedClick(st.m, T, this.sr, st.edge), clickAt: 0, clickGain: level });
  }

  /** Render one block of BLOCK samples (stereo, overwrites). */
  render(L: Float32Array, R: Float32Array): void {
    L.fill(0); R.fill(0);
    const S = this.sectors, sec = this.sector, slot = Math.floor(this.now / BLOCK) % RING;
    sec.fill(0);
    // Scatter this block's impulses into the resonator inputs.
    const n = this.bn[slot]!;
    for (let j = 0; j < n; j++) {
      const q = slot * BUCKET + j, st = this.mats[this.bm[q]!];
      if (!st) continue;
      const t = this.bt[q]!, A = this.bA[q]!, dv = this.bdv[q]!, cls = this.bc[q]!, s = this.bs[q]!, bin = binOf(dv);
      if (st.dK) {
        const B = DENSE_BANDS.length;
        for (let b = 0; b < B; b++) st.dIn[(s * B + b) * BLOCK + t]! += A * A * st.dK[bin * B + b]!;
        st.dLive = Math.max(st.dLive, 1);
      }
      if (cls === DENSE_ONLY) continue;
      const T = st.binT[bin]!, w = st.md.weights(this.rand, st.w), mult = st.mult[cls]!;
      const base = (cls * S + s) * st.M;
      for (let k = 0; k < st.M; k++) {
        const amp = A * w[k]! * forceSpectrum(st.md.freq[k]! * mult, T, st.rough, st.roughT) * st.md.gain[k]!;
        st.x[(base + k) * BLOCK + t]! += amp;
        if (!st.live[base + k]) { st.live[base + k] = 1; st.nLive++; }
      }
      st.cx[(bin * S + s) * BLOCK + t]! += A * st.clickPeak[bin]!;
      st.cIn[bin * S + s] = 1;
    }
    this.bn[slot] = 0;
    // Ringing cracks: this block's grains of a material with gritRing also strike its modes and dense
    // field (crackA), from grit's own stream, so a material without it plays bit for bit as before.
    const gslot = Math.floor(this.now / BLOCK) % GRING, gn = this.gn[gslot]!;
    for (let j = 0; j < gn; j++) {
      const q = gslot * GBUCKET + j, st = this.mats[this.gm[q]!];
      if (!st || !(st.crackA > 0)) continue;
      const A = this.ga[q]! * st.crackA, t = this.gt[q]!, s = this.gs[q]!;
      if (st.dK) {
        const B = DENSE_BANDS.length, last = DV_EDGES.length - 1;
        for (let b = 0; b < B; b++) st.dIn[(s * B + b) * BLOCK + t]! += A * A * st.dK[last * B + b]!;
        st.dLive = Math.max(st.dLive, 1);
      }
      const cls = Math.min(this.classes - 1, Math.floor(this.grand() * this.classes)), w = st.md.weights(this.grand, st.w), base = (cls * S + s) * st.M;
      for (let k = 0; k < st.M; k++) {
        st.x[(base + k) * BLOCK + t]! += A * w[k]! * st.md.gain[k]!;
        if (!st.live[base + k]) { st.live[base + k] = 1; st.nLive++; }
      }
    }
    // Bank and clicks, into the sector buses.
    for (const st of this.mats) {
      if (!st) continue;
      // Idle materials (nothing ringing, no input) cost nothing: a game holds ten slots, most of them silent.
      for (let r = 0; st.nLive > 0 && r < st.live.length; r++) {
        if (!st.live[r]) continue;
        const a1 = st.a1[r]!, a2 = st.a2[r]!, b = st.b[r]!, o = r * BLOCK, s = Math.floor(r / st.M) % S, so = s * BLOCK;
        let y1 = st.y1[r]!, y2 = st.y2[r]!, peak = 0;
        for (let i = 0; i < BLOCK; i++) {
          const y = a1 * y1 + a2 * y2 + b * st.x[o + i]!;
          st.x[o + i] = 0; y2 = y1; y1 = y; sec[so + i]! += y;
          peak = Math.max(peak, Math.abs(y));
        }
        st.y1[r] = y1; st.y2[r] = y2;
        this.work += BLOCK;
        if (peak < 1e-7) { st.live[r] = 0; st.nLive--; st.y1[r] = 0; st.y2[r] = 0; }
      }
      for (let r = 0; r < st.cring.length; r++) {
        const fir = st.cFir[Math.floor(r / S)];
        if (fir) { this.firClick(st, r, fir); continue; }
        const D = st.cD[Math.floor(r / S)]!, c = st.cc[Math.floor(r / S)]!, ring = st.cring[r]!, o = r * BLOCK, so = (r % S) * BLOCK;
        let y1 = st.cy1[r]!, y2 = st.cy2[r]!, last = st.cLast[r]!;
        // Idle: no input for a period (the ring holds only zeros) and the last cycle ended.
        if (this.now - last > D && y1 === 0 && y2 === 0 && !st.cIn[r]) continue;
        st.cIn[r] = 0;
        this.work += BLOCK;
        for (let i = 0; i < BLOCK; i++) {
          const x = st.cx[o + i]!, k = (this.now + i) % D, y = c * y1 - y2 + x - ring[k]!;
          if (x !== 0) last = this.now + i;
          ring[k] = x; st.cx[o + i] = 0; (st.cf ? st.cbus : sec)[so + i]! += y; y2 = y1; y1 = y;
        }
        // A finished cycle leaves rounding (~1e-16 of it); clear it once the ring is empty.
        if (this.now + BLOCK - last > D && Math.abs(y1) < 1e-9 && Math.abs(y2) < 1e-9) { y1 = 0; y2 = 0; }
        st.cy1[r] = y1; st.cy2[r] = y2; st.cLast[r] = last;
      }
      if (st.cf) {
        // The clicks' radiation, per sector: one biquad over the sum (linear and the same for every click).
        const [b0, b1, b2, a1, a2] = st.cf, z = st.cfz;
        for (let s = 0; s < S; s++) {
          let x1 = z[4 * s]!, x2 = z[4 * s + 1]!, y1 = z[4 * s + 2]!, y2 = z[4 * s + 3]!;
          if (x1 === 0 && x2 === 0 && Math.abs(y1) < 1e-12 && Math.abs(y2) < 1e-12 && !st.cbus.subarray(s * BLOCK, (s + 1) * BLOCK).some((x) => x !== 0)) { z.fill(0, 4 * s, 4 * s + 4); continue; }
          for (let i = 0; i < BLOCK; i++) {
            const x = st.cbus[s * BLOCK + i]!, y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            st.cbus[s * BLOCK + i] = 0; x2 = x1; x1 = x; y2 = y1; y1 = y; sec[s * BLOCK + i]! += y;
          }
          z[4 * s] = x1; z[4 * s + 1] = x2; z[4 * s + 2] = y1; z[4 * s + 3] = y2;
          this.work += BLOCK;
        }
      }
    }
    // Dense field: band noise under per-(sector, band) amplitudes; idle materials are skipped.
    for (let mi = 0; mi < this.mats.length; mi++) {
      const st = this.mats[mi];
      if (!st?.dK || st.dLive === 0) continue;
      const B = DENSE_BANDS.length, nz = this.dnoise!, M = DENSE_LOOP - 1;
      let live = 0;
      for (let s = 0; s < S; s++) for (let b = 0; b < B; b++) {
        const r = s * B + b, o = r * BLOCK, d = st.dDec[b]!, tab = nz[b]!, so = s * BLOCK, off = this.now + mi * 104729 + s * 7919;
        let a = st.dA[r]!;
        if (a === 0) { let any = false; for (let i = 0; i < BLOCK; i++) if (st.dIn[o + i] !== 0) { any = true; break; } if (!any) continue; }
        for (let i = 0; i < BLOCK; i++) {
          const inc = st.dIn[o + i]!;
          if (inc !== 0) { a = Math.sqrt(a * a + inc); st.dIn[o + i] = 0; }
          sec[so + i]! += a * tab[(off + i) & M]!;
          a *= d;
        }
        this.work += BLOCK;
        if (a < 1e-9) a = 0; else live++;
        st.dA[r] = a;
      }
      st.dLive = live;
    }
    // Grit grains: kernels into the grain bus (a grain may run into the next block), this block into the sectors.
    const gb = this.gbus, W = this.gw;
    for (let j = 0; j < gn; j++) {
      const q = gslot * GBUCKET + j, k = this.kernels[this.gv[q]!]!, a = this.ga[q]! * (this.mats[this.gm[q]!]?.gritDry ?? 1), o = this.gs[q]! * W + this.gt[q]!;
      for (let i = 0; i < k.length; i++) gb[o + i]! += a * k[i]!;
    }
    this.gn[gslot] = 0;
    for (let s = 0; s < S; s++) {
      const o = s * W;
      for (let i = 0; i < BLOCK; i++) sec[s * BLOCK + i]! += gb[o + i]!;
      gb.copyWithin(o, o + BLOCK, o + W);
      gb.fill(0, o + W - BLOCK, o + W);
    }
    for (let s = 0; s < S; s++) {
      const [gl, gr] = panGains(-1 + (2 * s + 1) / S);
      for (let i = 0; i < BLOCK; i++) { L[i]! += gl * sec[s * BLOCK + i]!; R[i]! += gr * sec[s * BLOCK + i]!; }
    }
    // Foreground voices.
    for (const v of this.voices) {
      if (!v.on) continue;
      const from = Math.max(0, v.start - this.now);
      if (from >= BLOCK) continue;
      for (let k = 0; k < v.M; k++) {
        const a1 = v.a1[k]!, a2 = v.a2[k]!;
        let y1 = v.y1[k]!, y2 = v.y2[k]!;
        for (let i = from; i < BLOCK; i++) {
          const y = a1 * y1 + a2 * y2 + (v.age === 0 && i === from ? v.amp[k]! : 0);
          y2 = y1; y1 = y; L[i]! += v.gl * y; R[i]! += v.gr * y;
        }
        v.y1[k] = y1; v.y2[k] = y2;
      }
      for (let i = from; i < BLOCK && v.clickAt < v.click.length; i++, v.clickAt++) { const c = v.clickGain * v.click[v.clickAt]!; L[i]! += v.gl * c; R[i]! += v.gr * c; }
      v.age += BLOCK - from;
      if (v.age > 7 * v.life) v.on = false;
    }
    // Master: Pa to full scale, then the limiter.
    const g = this.muted ? 0 : 1 / this.fullScale;
    for (let i = 0; i < BLOCK; i++) { L[i]! *= g; R[i]! *= g; }
    if (this.lowcut > 0) this.highpass.process(L, R, this.lowcut, this.sr);
    this.limiter.process(L, R, this.sr);
    this.now += BLOCK;
  }

  /** Resonators with state or input (a cost probe). */
  liveResonators(): number {
    let n = 0;
    for (const st of this.mats) if (st) for (const x of st.live) n += x;
    return n + this.voices.filter((v) => v.on).reduce((s, v) => s + v.M, 0);
  }
}

/** 2nd-order Butterworth high-pass (RBJ, Q 1/sqrt(2)), stereo; the corner can change between calls (the state carries on). */
export class HighPass {
  private f = -1;
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private s = new Float64Array(8); // x1 x2 y1 y2, left then right

  process(L: Float32Array, R: Float32Array, f: number, sr: number): void {
    if (f !== this.f) {
      const w = (2 * Math.PI * Math.min(f, 0.45 * sr)) / sr, al = Math.sin(w) / Math.SQRT2, a0 = 1 + al, c = Math.cos(w);
      this.f = f; this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
    }
    const { b0, b1, b2, a1, a2, s } = this;
    for (const [x, o] of [[L, 0], [R, 4]] as const) {
      let x1 = s[o]!, x2 = s[o + 1]!, y1 = s[o + 2]!, y2 = s[o + 3]!;
      for (let i = 0; i < x.length; i++) { const v = x[i]!, y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
      s[o] = x1; s[o + 1] = x2; s[o + 2] = y1; s[o + 3] = y2;
    }
  }
}

/**
 * Lookahead peak limiter: the output is the input LOOKAHEAD - 1 samples late, times a gain that never
 * lets a channel past CEILING and never steps. Each input sample n needs the gain r[n] = min(1, CEILING /
 * peak). The gain is the mean of h over the last LOOKAHEAD samples, h[j] = the least r over the
 * LOOKAHEAD samples up to j. Every one of those h covers the sample now being played (n - LOOKAHEAD + 1),
 * so the mean is at most its r: the gain ramps down across the lookahead and arrives in time. It then
 * rises no faster than the release allows. The old limiter set one gain per 128-sample block: up to
 * 12 dB steps at block edges under heavy limiting, heard as crackle.
 */
export class Limiter {
  release = 0.15; // s per 1/e of gain recovery
  /** Lowest gain since the last reset of this probe (set it to 1 to read the next stretch). */
  minGain = 1;
  private dl = new Float32Array(LOOKAHEAD); // input, left and right, the last LOOKAHEAD samples
  private dr = new Float32Array(LOOKAHEAD);
  private need = new Float64Array(LOOKAHEAD).fill(1); // r of the last LOOKAHEAD inputs
  private below = 0; // of need, how many are under 1
  private hold = new Float64Array(LOOKAHEAD).fill(1); // h of the last LOOKAHEAD inputs
  private sum = LOOKAHEAD; // of hold
  private gain = 1;
  private n = 0;

  process(L: Float32Array, R: Float32Array, sr: number): void {
    const up = Math.exp(1 / (this.release * sr)), need = this.need;
    for (let i = 0; i < L.length; i++) {
      const k = this.n % LOOKAHEAD, p = Math.max(Math.abs(L[i]!), Math.abs(R[i]!)), r = p > CEILING ? CEILING / p : 1;
      this.below += (r < 1 ? 1 : 0) - (need[k]! < 1 ? 1 : 0);
      need[k] = r;
      let h = 1;
      if (this.below > 0) for (let j = 0; j < LOOKAHEAD; j++) h = Math.min(h, need[j]!);
      this.sum += h - this.hold[k]!; this.hold[k] = h;
      if (this.below === 0 && this.sum > LOOKAHEAD - 1e-9) this.sum = LOOKAHEAD; // all 1 again: drop the running sum's rounding
      this.gain = Math.min(this.sum / LOOKAHEAD, this.gain * up, 1);
      this.minGain = Math.min(this.minGain, this.gain);
      this.dl[k] = L[i]!; this.dr[k] = R[i]!;
      const o = (k + 1) % LOOKAHEAD; // written LOOKAHEAD - 1 samples ago
      L[i] = this.dl[o]! * this.gain; R[i] = this.dr[o]! * this.gain;
      this.n++;
    }
  }
}
