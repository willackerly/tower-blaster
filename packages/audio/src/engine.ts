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
import { clickKernel, contactTime, modes, pulseSpectrum, type Modes } from './modes.ts';

export const BLOCK = 128;
const RING = 64; // blocks of scheduling horizon (171 ms at 48 kHz)
const BUCKET = 4096; // impulses per block, at most
/** Limiter ceiling (each channel) and lookahead, samples. */
export const CEILING = 0.9;
export const LOOKAHEAD = 64;

export interface EngineOptions {
  sampleRate: number;
  /** Pitch classes per material (quantiles of the body-to-body jitter). */
  classes?: number;
  sectors?: number;
  /** Most foreground voices at once; the quietest is stolen. */
  voices?: number;
  /** Most impulses rebuilt per histogram cell and frame (above: fewer, stronger ones of the same energy). */
  maxImpulses?: number;
  latency?: number;
  resync?: number;
  /** Pressure (Pa at the listener) that maps to full scale before the limiter. */
  fullScale?: number;
  seed?: number;
}

interface MatState {
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
  /** Click resonator per (bin, sector): its period D (samples, per bin), 2 cos(2 pi / D), state, input and the input's last D samples. */
  cD: Int32Array; cc: Float64Array; cy1: Float64Array; cy2: Float64Array; cx: Float32Array; cring: Float64Array[];
  cLast: Float64Array; // per (bin, sector): absolute sample of its last input (-Infinity: none)
  clickPeak: Float64Array; // per bin: impulse into the click resonator per (m/s of dv per m)
  binT: Float64Array; // per bin: contact time
  w: Float64Array; // scratch weights
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

  constructor(opts: EngineOptions) {
    this.sr = opts.sampleRate;
    this.classes = opts.classes ?? 8;
    this.sectors = opts.sectors ?? 4;
    this.maxImpulses = opts.maxImpulses ?? 256;
    this.latency = opts.latency ?? 0.03;
    this.resync = opts.resync ?? 0.12;
    this.fullScale = opts.fullScale ?? 30;
    this.rand = mulberry(opts.seed ?? 1);
    this.sector = new Float32Array(this.sectors * BLOCK);
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
      m, md, edge, M, mult: new Float64Array(C),
      a1: new Float32Array(n), a2: new Float32Array(n), b: new Float32Array(n),
      y1: keep ? old.y1 : new Float32Array(n), y2: keep ? old.y2 : new Float32Array(n),
      x: keep ? old.x : new Float32Array(n * BLOCK), live: keep ? old.live : new Uint8Array(n),
      cD: new Int32Array(DV_EDGES.length), cc: new Float64Array(DV_EDGES.length),
      cy1: new Float64Array(DV_EDGES.length * S), cy2: new Float64Array(DV_EDGES.length * S),
      cx: keep ? old.cx : new Float32Array(DV_EDGES.length * S * BLOCK), cring: [], cLast: new Float64Array(DV_EDGES.length * S).fill(-Infinity),
      clickPeak: new Float64Array(DV_EDGES.length), binT: new Float64Array(DV_EDGES.length), w: new Float64Array(md.freq.length),
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
      const D = Math.max(4, Math.round(T * this.sr)), th = (2 * Math.PI) / D;
      st.cD[bin] = D; st.cc[bin] = 2 * Math.cos(th);
      let ek = 0;
      for (const x of clickKernel(m, T, this.sr, edge)) ek += x * x;
      st.clickPeak[bin] = Math.sqrt(ek / (D / 2)) * Math.sin(th);
      for (let s = 0; s < S; s++) st.cring.push(new Float64Array(D));
    }
    // A click under way keeps playing through a change that keeps its period.
    if (keep) for (let r = 0; r < st.cring.length; r++) {
      const bin = Math.floor(r / S);
      if (old.cD[bin] !== st.cD[bin]) continue;
      st.cring[r] = old.cring[r]!; st.cy1[r] = old.cy1[r]!; st.cy2[r] = old.cy2[r]!; st.cLast[r] = old.cLast[r]!;
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
      this.voice(mat, dv, dist, pan, f.top[o + 4]!, start + (this.alignOnsets ? 0 : Math.floor(this.rand() * len)));
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
        const g = Math.sqrt(a2[c]! / sum);
        for (const dv of dvs) this.impulse(start + (this.alignOnsets ? 0 : Math.floor(this.rand() * len)), mat, Math.min(this.classes - 1, Math.floor(this.rand() * this.classes)), s, g * dv, dv);
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
      v.amp[k] = level * w[k]! * pulseSpectrum(f, T) * st.md.gain[k]! * Math.sin((2 * Math.PI * Math.min(f, 0.45 * this.sr)) / this.sr);
      tmax = Math.max(tmax, st.md.tau[k]!);
    }
    const [gl, gr] = panGains(pan);
    Object.assign(v, { on: true, mat, M: st.M, age: 0, life: Math.max(tmax, T) * this.sr, level, gl, gr, start: at, click: clickKernel(st.m, T, this.sr, st.edge), clickAt: 0, clickGain: level });
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
      const t = this.bt[q]!, A = this.bA[q]!, dv = this.bdv[q]!, cls = this.bc[q]!, s = this.bs[q]!;
      const bin = binOf(dv), T = st.binT[bin]!, w = st.md.weights(this.rand, st.w), mult = st.mult[cls]!;
      const base = (cls * S + s) * st.M;
      for (let k = 0; k < st.M; k++) {
        const amp = A * w[k]! * pulseSpectrum(st.md.freq[k]! * mult, T) * st.md.gain[k]!;
        st.x[(base + k) * BLOCK + t]! += amp; st.live[base + k] = 1;
      }
      st.cx[(bin * S + s) * BLOCK + t]! += A * st.clickPeak[bin]!;
    }
    this.bn[slot] = 0;
    // Bank and clicks, into the sector buses.
    for (const st of this.mats) {
      if (!st) continue;
      for (let r = 0; r < st.live.length; r++) {
        if (!st.live[r]) continue;
        const a1 = st.a1[r]!, a2 = st.a2[r]!, b = st.b[r]!, o = r * BLOCK, s = Math.floor(r / st.M) % S, so = s * BLOCK;
        let y1 = st.y1[r]!, y2 = st.y2[r]!, peak = 0;
        for (let i = 0; i < BLOCK; i++) {
          const y = a1 * y1 + a2 * y2 + b * st.x[o + i]!;
          st.x[o + i] = 0; y2 = y1; y1 = y; sec[so + i]! += y;
          peak = Math.max(peak, Math.abs(y));
        }
        st.y1[r] = y1; st.y2[r] = y2;
        if (peak < 1e-7) { st.live[r] = 0; st.y1[r] = 0; st.y2[r] = 0; }
      }
      for (let r = 0; r < st.cring.length; r++) {
        const D = st.cD[Math.floor(r / S)]!, c = st.cc[Math.floor(r / S)]!, ring = st.cring[r]!, o = r * BLOCK, so = (r % S) * BLOCK;
        let y1 = st.cy1[r]!, y2 = st.cy2[r]!, last = st.cLast[r]!;
        // Idle: no input for a period (the ring holds only zeros) and the last cycle ended.
        if (this.now - last > D && y1 === 0 && y2 === 0 && !st.cx.subarray(o, o + BLOCK).some((x) => x !== 0)) continue;
        for (let i = 0; i < BLOCK; i++) {
          const x = st.cx[o + i]!, k = (this.now + i) % D, y = c * y1 - y2 + x - ring[k]!;
          if (x !== 0) last = this.now + i;
          ring[k] = x; st.cx[o + i] = 0; sec[so + i]! += y; y2 = y1; y1 = y;
        }
        // A finished cycle leaves rounding (~1e-16 of it); clear it once the ring is empty.
        if (this.now + BLOCK - last > D && Math.abs(y1) < 1e-9 && Math.abs(y2) < 1e-9) { y1 = 0; y2 = 0; }
        st.cy1[r] = y1; st.cy2[r] = y2; st.cLast[r] = last;
      }
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
