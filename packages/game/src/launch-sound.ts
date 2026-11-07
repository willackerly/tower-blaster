// The launch sound (A10): a gas launcher's whump, from the shot itself, in place of the old sine glide.
// The launcher stands behind the camera (aim.ts), so the player hears it close. Pure: node tests render
// it and audio.ts's Synth plays the samples. Three parts, each from the shot's size and speed:
//   - the barrel: a tube closed at the breech and open at the muzzle rings at its quarter-wave
//     resonances, f_k = (2k - 1) c / (4 (L + 0.61 r)) (the 0.61 r end correction of an unflanged pipe),
//     struck as the gas behind the shot vents. The barrel is BARREL_CALIBRES shot diameters long, so a
//     heavier shot's whump is lower.
//   - the muzzle blast: a Friedlander pulse p(t) = (1 - t/T) e^(-B t/T), its positive phase T growing as
//     the cube root of the gas's energy (Hopkinson-Cranz blast scaling): a bigger charge thumps lower.
//     The gas holds ke (1 / EFFICIENCY - 1) after the shot takes its share.
//   - the chuff: the gas jet's turbulence, noise centred on Strouhal 0.2 (f = 0.2 U / d) for the gas
//     leaving the bore d choked (at the speed of sound, U = c: the pressure behind a shot is many times
//     the air's), venting over VENT_TRANSITS barrel transits (L / c each).
// docs/sound.md, Launch.
import type { BodyDesc } from '@tb/engine-api';

/** Speed of sound, m/s. */
export const C_AIR = 343;
/** Barrel length in shot diameters (a mortar's is ~10, a howitzer's 20-40; a toy air cannon's 5-8). */
export const BARREL_CALIBRES = 6;
/** Share of the gas's energy the shot takes (pneumatic launchers: 0.2-0.4). */
export const EFFICIENCY = 0.3;
/** The Friedlander pulse's positive phase for 1 kJ of gas, s (a ~1 ms crack at a few metres). */
export const BLAST_T_1KJ = 0.0004;
/** The Friedlander decay constant B. */
export const BLAST_B = 1.5;
/** The gas vents over this many barrel transit times (L / c). */
export const VENT_TRANSITS = 4;
/** Strouhal number of the jet's loudest turbulence. */
export const STROUHAL = 0.2;
/** Quality factor of the barrel's resonances (its wide open end radiates them away in a few cycles). */
export const BARREL_Q = 3;
/** The chuff band's Q: jet noise is broadband about its Strouhal peak (a narrow band reads as a struck bell). */
export const CHUFF_Q = 0.7;
/** Energy shares of the three parts. */
export const MIX = { barrel: 0.3, blast: 0.3, chuff: 0.4 } as const;
/** Peak gain of the whump for a shot of REF_KE, and its range (the old glide's was 0.35). */
export const LAUNCH_GAIN = 0.35, LAUNCH_GAIN_MIN = 0.2, LAUNCH_GAIN_MAX = 0.5;
/** Kinetic energy (J) that plays at LAUNCH_GAIN: the default cannonball (0.5 m of steel) at ~15 m/s. */
export const REF_KE = 1e5;
/** Seconds of sound. */
export const LAUNCH_SECONDS = 0.6;

export interface LaunchShape {
  /** Shot diameter, m (a box: its longest side). */
  diameter: number;
  /** Muzzle speed, m/s. */
  speed: number;
  /** Shot density, kg/m^3 (steel by default). */
  rho?: number;
  /** A sphere (true) or a box of diameter^3 (false). */
  sphere?: boolean;
}

export interface LaunchParams {
  mass: number; ke: number; gas: number;
  barrel: number; partials: number[]; tau: number[];
  blastT: number; chuffHz: number; vent: number; gain: number;
}

/** A fired body's launch: its size, speed and density (game densities are kg/m^3 for ammo), or null for none (a pull, a quake). */
export function launchShapeOf(b: BodyDesc | undefined): LaunchShape | null {
  if (!b) return null;
  const v = b.linVel, speed = Math.hypot(v[0], v[1], v[2]);
  if (b.shape.kind === 'sphere') return { diameter: 2 * b.shape.radius, speed, rho: b.density, sphere: true };
  if (b.shape.kind === 'box') return { diameter: 2 * Math.max(...b.shape.half), speed, rho: b.density, sphere: false };
  return null;
}

/** The whump's physics for a shot. */
export function launchParams(s: LaunchShape, q = BARREL_Q): LaunchParams {
  if (!(s.diameter > 0 && s.speed >= 0)) throw new Error(`launch: diameter must be > 0 and speed >= 0 (${s.diameter}, ${s.speed})`);
  const d = s.diameter, r = d / 2, rho = s.rho ?? 7850;
  const mass = rho * (s.sphere === false ? d * d * d : (4 / 3) * Math.PI * r * r * r), ke = 0.5 * mass * s.speed * s.speed;
  const gas = ke * (1 / EFFICIENCY - 1), barrel = BARREL_CALIBRES * d, f1 = C_AIR / (4 * (barrel + 0.61 * r));
  const partials = [1, 3, 5, 7].map((k) => k * f1), tau = partials.map((f) => q / (Math.PI * f));
  const blastT = BLAST_T_1KJ * Math.cbrt(Math.max(gas, 1) / 1000);
  const gain = Math.min(LAUNCH_GAIN_MAX, Math.max(LAUNCH_GAIN_MIN, LAUNCH_GAIN * (Math.max(ke, 1) / REF_KE) ** 0.1));
  return { mass, ke, gas, barrel, partials, tau, blastT, chuffHz: (STROUHAL * C_AIR) / d, vent: (VENT_TRANSITS * barrel) / C_AIR, gain };
}

function lcg(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 31 - 1; };
}

/** Unit-energy normalisation of one part: scaled so its sum of squares is 1. */
function unit(x: Float32Array): Float32Array {
  let e = 0;
  for (const v of x) e += v * v;
  const g = e > 0 ? 1 / Math.sqrt(e) : 0;
  for (let i = 0; i < x.length; i++) x[i]! *= g;
  return x;
}

/** The whump as samples (mono, peak = params.gain), deterministic for a seed. */
export function launchWave(p: LaunchParams, sr = 48000, seed = 1, mix: { barrel: number; blast: number; chuff: number; q?: number } = MIX): Float32Array<ArrayBuffer> {
  const n = Math.round(LAUNCH_SECONDS * sr), rand = lcg(seed);
  // The barrel: the vent's pressure drop, e^(-t / vent), rings each partial (a damped sine through it).
  const barrel = new Float32Array(n);
  p.partials.forEach((f, k) => {
    const w = (2 * Math.PI * f) / sr, a = 1 / (2 * k + 1); // odd partials fall as 1 / (2k - 1)
    const r = Math.exp(-1 / (p.tau[k]! * sr)), a1 = 2 * r * Math.cos(w), a2 = -r * r;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const u = i === 0 ? 1 : Math.exp(-i / (p.vent * sr)) - Math.exp(-(i - 1) / (p.vent * sr)); // the drop's derivative
      const y = a1 * y1 + a2 * y2 + u * Math.sin(w);
      y2 = y1; y1 = y; barrel[i]! += a * y;
    }
  });
  // The muzzle blast: one Friedlander pulse, its negative phase included (it settles to 0: no DC left over).
  const blast = new Float32Array(n), T = p.blastT * sr;
  for (let i = 0; i < n && i < 40 * T; i++) blast[i] = (1 - i / T) * Math.exp((-BLAST_B * i) / T);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += blast[i]!;
  mean /= Math.min(n, Math.ceil(40 * T));
  for (let i = 0; i < n && i < 40 * T; i++) blast[i]! -= mean;
  // The chuff: noise through a resonant band-pass at the jet's Strouhal frequency, decaying as the gas vents.
  const chuff = new Float32Array(n), fc = Math.min(p.chuffHz, 0.4 * sr), w0 = (2 * Math.PI * fc) / sr, q = mix.q ?? CHUFF_Q;
  const al = Math.sin(w0) / (2 * q), b0 = al / (1 + al), c1 = (2 * Math.cos(w0)) / (1 + al), c2 = -(1 - al) / (1 + al);
  let x1 = 0, x2 = 0, z1 = 0, z2 = 0;
  for (let i = 0; i < n; i++) {
    const x = rand() * Math.exp(-i / (p.vent * sr)) * (1 - Math.exp(-i / (0.002 * sr)));
    const z = b0 * x - b0 * x2 + c1 * z1 + c2 * z2;
    x2 = x1; x1 = x; z2 = z1; z1 = z; chuff[i] = z;
  }
  const out = new Float32Array(n), parts = [[unit(barrel), mix.barrel], [unit(blast), mix.blast], [unit(chuff), mix.chuff]] as const;
  for (const [x, share] of parts) { const g = Math.sqrt(share); for (let i = 0; i < n; i++) out[i]! += g * x[i]!; }
  // A short fade so the cut at LAUNCH_SECONDS is silent, then the peak at the gain.
  const fade = Math.round(0.05 * sr);
  for (let i = 0; i < fade; i++) out[n - 1 - i]! *= i / fade;
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= p.gain / peak;
  return out;
}
