// Room sound (A5): the surroundings' answer to the collapse, added to the dry mix before the low cut
// and the limiter. Two parts, each a standard building block:
//
//   early      sparse reflections off what is far away (walls and roof in a hall; tree lines and
//              buildings outdoors): taps on a delay line of the mono mix after a diffuser (four
//              Schroeder allpasses: a reflection off a rough surface is smeared, not a click), each
//              low-passed for the air it crossed and sent to one side.
//   late       a feedback delay network (Jot): eight mutually prime delay lines mixed by a Hadamard
//              matrix, each with a one-pole loop filter whose gains at DC and at HF_REF give the
//              reverb times rt60 and rtHigh exactly for its length. Fed by the diffuser.
//
// Levels are energies against the dry signal's: an impulse through the early and late paths
// carries 10^(earlyDb/10) and 10^(lateDb/10) of the impulse's energy
// (measured once per room on an impulse: roomGains). So lateDb is the negative of the
// direct-to-reverberant ratio at the listener: about 0 dB at a hall's critical distance
// (0.057 sqrt(V / RT60), 17 m in the Grand Hall), 20 dB down outdoors.
//
// Alternatives weighed: convolution with a measured or modelled impulse response (exact, but a
// 3 s response is 144k taps: a partitioned FFT convolution costs ~10x this, and recorded responses
// would come from the Mac with their licences); Schroeder/Freeverb comb banks (cheap, but rings
// metallic on impulsive input, the worst case for comb colouration and exactly what a collapse
// is); velvet-noise convolution (cheap per tap, but a dense 3 s tail is still thousands of taps a
// sample). An FDN behind a diffuser is dense within ~50 ms and costs ~100 flops a sample.
//
// No floor or ground reflection. Its delay is the path difference, 2 h_source h_listener / distance:
// 0.4 ms for a block at 0.25 m seen from 5 m up and 20 m off, 4 ms at 3 m up. On a mix of hundreds of
// impacts at every height, one fixed delay would put one comb on all of them (a 3 ms copy at -8 dB took
// real recordings' real share from 0.87 to 0.59); the true sum of many such combs is incoherent, a
// level change of 1-3 dB at low frequencies, which the mix's own level already stands for.

export const ROOMS = ['off', 'outdoor', 'hall'] as const;
export type Room = (typeof ROOMS)[number];

/** The frequency rtHigh is set at, Hz. */
export const HF_REF = 8000;

/** One reflection: delay (s), relative amplitude, low-pass corner (Hz), side (-1 left, 1 right, 0 both). */
export type Reflection = readonly [delay: number, gain: number, lowpass: number, side: -1 | 0 | 1];

export interface RoomParams {
  /** 60 dB decay of the late part at low and mid frequencies, and at HF_REF, s. */
  rt60: number;
  rtHigh: number;
  /** The late part's delay lines, s: eight lengths spread log-uniformly between these (made mutually prime). */
  lines: readonly [number, number];
  /** Delay before the late part starts, s (it is fed from the diffuser after this). */
  preDelay: number;
  early: readonly Reflection[];
  /** Energies against the dry signal's, dB (at the space's reference distance, when space is on: engine.setSpace). */
  earlyDb: number;
  lateDb: number;
  /**
   * With space on (A8a), the room's send for an impact at distance d is (d / dref)^distanceLaw, so the late part
   * against the dry sound grows 6 x distanceLaw dB a doubling of distance. 1 (the default) is a diffuse field's:
   * an enclosed room's reverb does not fall with the source's distance (Sabine). The early taps follow geometry
   * whatever the law (setDistance).
   */
  distanceLaw?: number;
}

/**
 * The presets, at size 1 (size scales every distance and both reverb times: a hall size x, or the
 * outdoor surroundings x as far). The values were chosen on the judge with a control (docs/sound.md, Room):
 * real recordings (ESC-50 knocks, glass, footsteps, cans, clicks) put through the same room must keep
 * reading real, so a preset that makes real sounds read as instruments is the room's fault, not the synth's.
 *
 * Hall: the render's hall (the Olympia Grand Hall: 150 x 68 m, ~30 m to the roof, glass and iron), the
 * listener near its middle: roof 0.17 s, side walls ~0.2 s, end walls ~0.43 s; a glass-and-iron shed of
 * that size rings ~3 s at mid frequencies (a crowd and stands bring real ones to 3-5 s; Sabine on the bare
 * surfaces says more), 1.3 s at 8 kHz, where the air over a 100 m path takes ~1 dB per 10 m. The listener
 * at about half the critical distance (17 m): the late part 6 dB under the direct sound.
 *
 * Outdoor: a tree line ~15 m off and a building ~27 m off answer at 0.09 and 0.16 s, darker with distance;
 * foliage scatters a little diffuse sound that dies in 0.7 s (0.2 s at 8 kHz), 22 dB under the direct. In the
 * open the scattered sound is not a field that holds its level, so its distance law is 0.5 (3 dB a doubling),
 * chosen on the judge's control (docs/sound.md, Space), not measured.
 */
export const ROOM_PRESETS: Record<Exclude<Room, 'off'>, RoomParams> = {
  hall: {
    rt60: 3.0, rtHigh: 1.3, lines: [0.043, 0.107], preDelay: 0.03,
    early: [[0.17, 1, 6000, -1], [0.18, 0.9, 6000, 1], [0.19, 0.85, 5500, 1], [0.21, 0.8, 5500, -1], [0.42, 0.5, 4000, -1], [0.45, 0.45, 4000, 1]],
    earlyDb: -14, lateDb: -6,
  },
  outdoor: {
    rt60: 0.7, rtHigh: 0.2, lines: [0.029, 0.067], preDelay: 0.06,
    early: [[0.09, 1, 3500, -1], [0.16, 0.8, 2500, 1]],
    earlyDb: -16, lateDb: -22, distanceLaw: 0.5,
  },
};

/** Speed of sound, m/s (20 C): turns an early tap's delay into its extra path. */
const SOUND_SPEED = 343;

const N = 8;
const IMPULSE_BLOCK = 128; // pathEnergies' block (any length works: the processor keeps its state across calls)
const DIFFUSER = [0.0047, 0.0036, 0.0127, 0.0093] as const; // s (Dattorro's input diffusers at 29.8 kHz, scaled)
const DIFFUSE_G = 0.6;
const RSQ = 1 / Math.sqrt(N);
// Input signs (+ - + - + - + -), output rows OUT_L (+ + - - + + - -) and OUT_R (+ - - + + - - +): written out in process.

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

/** Eight distinct primes spread log-uniformly over [a, b] seconds at sr (so the lines share no period). */
export function lineLengths(a: number, b: number, sr: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    let n = Math.round(a * sr * (b / a) ** (i / (N - 1)));
    while (!isPrime(n) || out.includes(n)) n++;
    out.push(n);
  }
  return out;
}

/**
 * The one-pole loop filter y = b x + a y[-1] whose gain is gDc at DC and gHf at w (rad/sample): with b =
 * gDc (1 - a), |H(w)|^2 = b^2 / (1 - 2 a cos w + a^2), which is gHf^2 when a solves a^2 + (B / A) a + 1 =
 * 0, A = gHf^2 - gDc^2, B = 2 (gDc^2 - cos w gHf^2) (the root in [0, 1)). gHf at or above gDc: a = 0.
 */
export function loopFilter(gDc: number, gHf: number, w: number): { a: number; b: number } {
  if (gHf >= gDc) return { a: 0, b: gDc };
  const A = gHf * gHf - gDc * gDc, B = 2 * (gDc * gDc - Math.cos(w) * gHf * gHf), p = B / A;
  const disc = p * p - 4;
  const a = disc <= 0 ? 1 - 1e-9 : (-p - Math.sqrt(disc)) / 2;
  const ac = Math.min(Math.max(a, 0), 1 - 1e-9);
  return { a: ac, b: gDc * (1 - ac) };
}

/** One-pole low-pass coefficient for a corner at f Hz (y += c (x - y)). */
const lp = (f: number, sr: number) => 1 - Math.exp((-2 * Math.PI * Math.min(f, 0.45 * sr)) / sr);

/** Room processor: adds the room's answer to L and R in place. Raw paths (unit gains) until scaled by roomGains. */
export class RoomVerb {
  readonly sr: number;
  readonly params: RoomParams;
  readonly size: number;
  /** Samples after the input falls silent until the tail is under -120 dB of where it was: then it idles. */
  readonly tail: number;
  /** The late send's distance law (RoomParams.distanceLaw; the engine reads it with space on). */
  readonly law: number;
  // Gains of the two paths (linear amplitude).
  gEarly = 1;
  gLate = 1;
  // Diffuser allpasses on the mono mix.
  private ap: Float32Array[]; private apAt: number[];
  // Diffused mono history for the early taps and the late feed.
  private h: Float32Array; private hLen: number; private hAt = 0;
  private eD: Int32Array; private eG: Float64Array; private eG0: Float64Array; private eP: Float64Array; private eC: Float64Array; private eSide: Int8Array; private eY: Float64Array;
  private pre: number;
  // FDN.
  private lines: Float32Array[]; private len: number[]; private at: number[]; private fa: Float64Array; private fb: Float64Array; private fy: Float64Array;
  private quiet = Infinity; // samples since the input was last above the idle floor

  constructor(params: RoomParams, sr: number, size = 1) {
    if (!(size > 0.05 && size <= 20)) throw new Error(`room size must be from 0.05 to 20: ${size}`);
    this.sr = sr; this.params = params; this.size = size;
    const s = size;
    this.ap = DIFFUSER.map((d) => new Float32Array(Math.max(1, Math.round(d * sr))));
    this.apAt = DIFFUSER.map(() => 0);
    const e = params.early;
    this.eD = Int32Array.from(e.map((r) => Math.max(1, Math.round(r[0] * s * sr))));
    this.eG = Float64Array.from(e.map((r) => r[1]));
    this.eG0 = Float64Array.from(this.eG);
    this.eP = Float64Array.from(e.map((r) => r[0] * s * SOUND_SPEED));
    this.law = params.distanceLaw ?? 1;
    if (!(this.law >= 0 && this.law <= 2)) throw new Error(`room distanceLaw must be from 0 to 2: ${this.law}`);
    this.eC = Float64Array.from(e.map((r) => lp(r[2], sr)));
    this.eSide = Int8Array.from(e.map((r) => r[3]));
    this.eY = new Float64Array(e.length);
    this.pre = Math.max(1, Math.round(params.preDelay * s * sr));
    this.hLen = Math.max(this.pre, ...this.eD) + 1;
    this.h = new Float32Array(this.hLen);
    this.len = lineLengths(params.lines[0] * s, params.lines[1] * s, sr);
    this.lines = this.len.map((n) => new Float32Array(n));
    this.at = this.len.map(() => 0);
    const rt = params.rt60 * s, rtH = params.rtHigh * s, w = (2 * Math.PI * Math.min(HF_REF, 0.45 * sr)) / sr;
    this.fa = new Float64Array(N); this.fb = new Float64Array(N); this.fy = new Float64Array(N);
    this.len.forEach((n, i) => {
      const f = loopFilter(10 ** ((-3 * n) / (sr * rt)), 10 ** ((-3 * n) / (sr * rtH)), w);
      this.fa[i] = f.a; this.fb[i] = f.b;
    });
    this.tail = Math.ceil(2 * rt * sr) + this.hLen + Math.max(...this.len);
  }

  /**
   * Space (A8a): the mix's sources are about d metres off, and the send already carries (d / dref)^law of them. A
   * reflection with extra path p (its delay x c) arrives at d / (d + p) of the direct sound's amplitude, which
   * the preset's tap gains hold at dref: so tap k's gain is its own x (dref + p) / (d + p) x (d / dref)^(1 - law).
   * At d = dref the gains are the preset's exactly.
   */
  setDistance(d: number, dref: number): void {
    const { eG, eG0, eP } = this;
    if (d === dref) { eG.set(eG0); return; }
    const x = (d / dref) ** (1 - this.law);
    for (let k = 0; k < eG.length; k++) eG[k] = eG0[k]! * ((dref + eP[k]!) / (d + eP[k]!)) * x;
  }

  /** Zero every state (the tail stops). */
  reset(): void {
    for (const a of this.ap) a.fill(0);
    this.h.fill(0); this.eY.fill(0);
    for (const l of this.lines) l.fill(0);
    this.fy.fill(0);
  }

  /** Is it idle (input silent for longer than the tail)? An idle room costs nothing. */
  get idle(): boolean { return this.quiet > this.tail; }

  /**
   * Add the room to one block of L, R. Its input is their mono mix, or `send` when given (mono, the same
   * length: the engine's distance-weighted send, A8a); the dry L, R pass through either way.
   */
  process(L: Float32Array, R: Float32Array, send?: Float32Array): void {
    const n = L.length;
    let peak = 0;
    if (send) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(send[i]!));
    else for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
    if (peak > 1e-6) this.quiet = 0;
    else {
      if (this.quiet > this.tail) return;
      if ((this.quiet += n) > this.tail) { this.reset(); return; }
    }
    const { gEarly, gLate, ap, apAt, h, hLen, eD, eG, eC, eSide, eY, pre, lines, len, at, fa, fb, fy } = this;
    let hAt = this.hAt;
    for (let i = 0; i < n; i++) {
      const xl = L[i]!, xr = R[i]!;
      let ol = 0, or = 0;
      // Diffuser on the mono mix (or the send).
      let m = send ? send[i]! : 0.5 * (xl + xr);
      for (let k = 0; k < 4; k++) {
        const buf = ap[k]!, j = apAt[k]!, d = buf[j]!, v = m + DIFFUSE_G * d;
        buf[j] = v; m = d - DIFFUSE_G * v; apAt[k] = j + 1 === buf.length ? 0 : j + 1;
      }
      h[hAt] = m;
      // Early taps.
      for (let k = 0; k < eD.length; k++) {
        const y = (eY[k]! += eC[k]! * (h[(hAt + hLen - eD[k]!) % hLen]! - eY[k]!)), s = eSide[k]!, v = gEarly * eG[k]! * y;
        if (s <= 0) ol += v;
        if (s >= 0) or += v;
      }
      // Late: the FDN, fed the diffused mix pre samples ago.
      const feed = h[(hAt + hLen - pre) % hLen]!;
      hAt = (hAt + 1) % hLen;
      const l0 = lines[0]!, l1 = lines[1]!, l2 = lines[2]!, l3 = lines[3]!, l4 = lines[4]!, l5 = lines[5]!, l6 = lines[6]!, l7 = lines[7]!;
      const y0 = (fy[0] = fb[0]! * l0[at[0]!]! + fa[0]! * fy[0]!), y1 = (fy[1] = fb[1]! * l1[at[1]!]! + fa[1]! * fy[1]!);
      const y2 = (fy[2] = fb[2]! * l2[at[2]!]! + fa[2]! * fy[2]!), y3 = (fy[3] = fb[3]! * l3[at[3]!]! + fa[3]! * fy[3]!);
      const y4 = (fy[4] = fb[4]! * l4[at[4]!]! + fa[4]! * fy[4]!), y5 = (fy[5] = fb[5]! * l5[at[5]!]! + fa[5]! * fy[5]!);
      const y6 = (fy[6] = fb[6]! * l6[at[6]!]! + fa[6]! * fy[6]!), y7 = (fy[7] = fb[7]! * l7[at[7]!]! + fa[7]! * fy[7]!);
      // Outputs: two rows of the Hadamard matrix (OUT_L, OUT_R), so the sides are decorrelated.
      ol += gLate * RSQ * (y0 + y1 - y2 - y3 + y4 + y5 - y6 - y7);
      or += gLate * RSQ * (y0 - y1 - y2 + y3 + y4 - y5 - y6 + y7);
      // Feedback: the orthonormal Hadamard matrix (a fast Walsh-Hadamard transform), plus the input (IN_SIGN).
      const a0 = y0 + y1, a1 = y0 - y1, a2 = y2 + y3, a3 = y2 - y3, a4 = y4 + y5, a5 = y4 - y5, a6 = y6 + y7, a7 = y6 - y7;
      const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3, b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
      l0[at[0]!] = RSQ * (b0 + b4) + feed; l1[at[1]!] = RSQ * (b1 + b5) - feed;
      l2[at[2]!] = RSQ * (b2 + b6) + feed; l3[at[3]!] = RSQ * (b3 + b7) - feed;
      l4[at[4]!] = RSQ * (b0 - b4) + feed; l5[at[5]!] = RSQ * (b1 - b5) - feed;
      l6[at[6]!] = RSQ * (b2 - b6) + feed; l7[at[7]!] = RSQ * (b3 - b7) - feed;
      for (let k = 0; k < N; k++) at[k] = at[k]! + 1 === len[k]! ? 0 : at[k]! + 1;
      L[i] = xl + ol; R[i] = xr + or;
    }
    this.hAt = hAt;
  }
}

/** Energy of an impulse (1 on each channel) through each raw path, against the impulse's own: [early, late]. */
export function pathEnergies(params: RoomParams, sr: number, size = 1): [number, number] {
  const out: [number, number] = [0, 0];
  const len = Math.ceil(1.5 * params.rt60 * size * sr) + Math.ceil(0.8 * size * sr);
  for (let p = 0; p < 2; p++) {
    const r = new RoomVerb(params, sr, size);
    r.gEarly = p === 0 ? 1 : 0; r.gLate = p === 1 ? 1 : 0;
    let e = 0;
    const L = new Float32Array(IMPULSE_BLOCK), R = new Float32Array(IMPULSE_BLOCK);
    for (let t = 0; t < len; t += IMPULSE_BLOCK) {
      L.fill(0); R.fill(0);
      if (t === 0) { L[0] = 1; R[0] = 1; }
      r.process(L, R);
      for (let i = 0; i < IMPULSE_BLOCK; i++) {
        const l = L[i]! - (t === 0 && i === 0 ? 1 : 0), rr = R[i]! - (t === 0 && i === 0 ? 1 : 0);
        e += l * l + rr * rr;
      }
    }
    out[p] = e / 2; // the impulse's own energy: 1 a channel
  }
  return out;
}

const cache = new Map<string, [number, number]>();

/** A room ready to play: the raw paths scaled so each carries its preset energy (measured once per room, size and rate). */
export function makeRoom(room: Room, sr: number, size = 1, tune: Partial<RoomParams> = {}): RoomVerb | null {
  if (room === 'off') return null;
  const params = ROOM_PRESETS[room];
  if (!params) throw new Error(`room must be one of ${ROOMS.join(', ')}: ${String(room)}`);
  return roomOf({ ...params, ...tune }, sr, size);
}

/** A room from its parameters (a preset, or one being tuned), scaled as makeRoom scales a preset. */
export function roomOf(params: RoomParams, sr: number, size = 1): RoomVerb {
  const key = `${JSON.stringify(params)}:${size}:${sr}`;
  let e = cache.get(key);
  if (!e) { e = pathEnergies(params, sr, size); cache.set(key, e); }
  const r = new RoomVerb(params, sr, size);
  const g = (db: number, energy: number) => (energy > 0 ? Math.sqrt(10 ** (db / 10) / energy) : 0); // a path with no reflections: silent
  r.gEarly = g(params.earlyDb, e[0]); r.gLate = g(params.lateDb, e[1]);
  return r;
}
