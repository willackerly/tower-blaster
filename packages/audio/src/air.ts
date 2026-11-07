// Air absorption (A8a step 3): sound loses its top end over distance. ISO 9613-1:1993 gives the pure-tone
// attenuation of the atmosphere, alpha(f) in dB/m; at 20 C and 50% relative humidity it is 0.005 dB/m at
// 1 kHz, 0.03 at 4 kHz, 0.11 at 8 kHz and 0.36 at 16 kHz, so an impact 25 m away loses 9 dB at 16 kHz and the
// city's (98 m) 10 dB at 8 kHz.
//
// The filter: loss in dB grows about as f^2 d, which one pole cannot follow once the loss passes ~3 dB (fitted
// at 8 kHz for 100 m it loses 5.5 dB at 4 kHz, where the air loses 3.0). Two first-order sections with real
// poles and zeros and unit gain at DC (one biquad), fitted minimax to the standard on 60 log-spaced
// frequencies from 500 Hz to 20 kHz where the loss is under 20 dB, follow it within 0.1 dB to 30 m, 0.15 dB
// at 50 m, 1.6 dB at 100 m and 2.3 dB at most out to 400 m (the error sits where the loss is 10-20 dB). The
// fits are a table (air-table.ts, written by air-cli.ts), one per distance at 5% steps from 1 to 400 m:
// fitting in the audio thread would take ~10 ms, four blocks. The table is fitted at 48 kHz; at another rate
// the same coefficients play the 48 kHz response at f x 48 kHz / rate, and since the loss goes about as f^2 d
// (above 2 kHz, between nitrogen's relaxation at ~330 Hz and oxygen's at ~35 kHz), the filter takes the
// entry for d (rate / 48 kHz)^2: at 44.1 kHz within 0.2 dB of the standard to 50 m (where the loss is under
// 20 dB), at 96 kHz within 2.7 dB.
import { AIR_TABLE } from './air-table.ts';

/** ISO 9613-1 pure-tone atmospheric absorption, dB/m, at f Hz (default 20 C, 50% RH, 101.325 kPa). */
export function airAlpha(f: number, celsius = 20, rh = 50, kPa = 101.325): number {
  const T = celsius + 273.15, T0 = 293.15, T01 = 273.16, pr = 101.325, pa = kPa;
  const C = -6.8346 * (T01 / T) ** 1.261 + 4.6151, h = rh * 10 ** C * (pr / pa);
  const frO = (pa / pr) * (24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h));
  const frN = (pa / pr) * (T / T0) ** -0.5 * (9 + 280 * h * Math.exp(-4.17 * ((T / T0) ** (-1 / 3) - 1)));
  return 8.686 * f * f * (1.84e-11 * (pr / pa) * (T / T0) ** 0.5 + (T / T0) ** -2.5 * ((0.01275 * Math.exp(-2239.1 / T)) / (frO + (f * f) / frO) + (0.1068 * Math.exp(-3352 / T)) / (frN + (f * f) / frN)));
}

/** The table's distances: AIR_D0 x AIR_STEP^i, i from 0 to AIR_TABLE.length - 1. */
export const AIR_D0 = 1;
export const AIR_STEP = 1.05;
export const AIR_RATE = 48000;

/** The table index nearest distance d (m), clamped to the table. */
export const airIndex = (d: number): number => Math.max(0, Math.min(AIR_TABLE.length - 1, Math.round(Math.log(Math.max(d, AIR_D0) / AIR_D0) / Math.log(AIR_STEP))));

/** A fit's two sections, [pole, zero] each, from its parameters (tanh keeps them inside the unit circle). */
export const airSections = (p: readonly number[]): [number, number, number, number] => [Math.tanh(p[0]!), Math.tanh(p[1]!), Math.tanh(p[2]!), Math.tanh(p[3]!)];

/** Loss in dB at f Hz of a fit at rate sr (positive: quieter). */
export function airLoss(p: readonly number[], f: number, sr = AIR_RATE): number {
  const w = (2 * Math.PI * f) / sr, [p1, z1, p2, z2] = airSections(p);
  const mag = (q: number) => Math.hypot(1 - q * Math.cos(w), q * Math.sin(w));
  const h = (((1 - p1) / (1 - z1)) * mag(z1)) / mag(p1) * (((1 - p2) / (1 - z2)) * mag(z2)) / mag(p2);
  return -20 * Math.log10(h);
}

/**
 * One air filter (a voice's, or a bank sector's): the fit's two sections multiplied out into one biquad, run as
 * direct form I, so the state is the signal's own history and the sections' order in the table does not
 * matter. A move to another table entry (at most once a block) ramps the coefficients across the next
 * process() call: real poles keep (a1, a2) in the stability triangle, which is convex, so every filter on the
 * way is stable, and the move does not click.
 */
export class AirFilter {
  private i = -1;
  private readonly k: number; // distance scale for the rate: (rate / AIR_RATE)^2
  private c = new Float64Array(5); // b0 b1 b2 a1 a2 now
  private t = new Float64Array(5); // the entry's
  private ramp = false;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  constructor(sampleRate = AIR_RATE) {
    if (!(sampleRate > 0)) throw new Error(`air filter sample rate must be positive: ${sampleRate}`);
    this.k = (sampleRate / AIR_RATE) ** 2;
  }

  /** Use the table entry for distance d (m); the first entry is taken at once, later ones ramp. */
  set(d: number): void {
    const i = airIndex(d * this.k);
    if (i === this.i) return;
    const [p1, z1, p2, z2] = airSections(AIR_TABLE[i]!), g = ((1 - p1) / (1 - z1)) * ((1 - p2) / (1 - z2)), t = this.t;
    t[0] = g; t[1] = -g * (z1 + z2); t[2] = g * z1 * z2; t[3] = -(p1 + p2); t[4] = p1 * p2;
    if (this.i < 0) this.c.set(t); else this.ramp = true;
    this.i = i;
  }

  /** The table entry in use (-1: none yet). */
  get entry(): number { return this.i; }

  /** Forget the signal and the entry (a new voice). */
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.i = -1; this.ramp = false; }

  /** Filter x[from..to) in place. */
  process(x: Float32Array, from = 0, to = x.length): void {
    const c = this.c, t = this.t, n = to - from;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    if (this.ramp && n > 0) {
      const d0 = (t[0]! - c[0]!) / n, d1 = (t[1]! - c[1]!) / n, d2 = (t[2]! - c[2]!) / n, d3 = (t[3]! - c[3]!) / n, d4 = (t[4]! - c[4]!) / n;
      let b0 = c[0]!, b1 = c[1]!, b2 = c[2]!, a1 = c[3]!, a2 = c[4]!;
      for (let k = from; k < to; k++) {
        b0 += d0; b1 += d1; b2 += d2; a1 += d3; a2 += d4;
        const v = x[k]!, y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = y; x[k] = y;
      }
      c.set(t); this.ramp = false;
    } else {
      const b0 = c[0]!, b1 = c[1]!, b2 = c[2]!, a1 = c[3]!, a2 = c[4]!;
      for (let k = from; k < to; k++) {
        const v = x[k]!, y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = y; x[k] = y;
      }
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  }
}
