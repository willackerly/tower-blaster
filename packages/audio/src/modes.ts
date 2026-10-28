// Mode tables, contact and click: everything about one impact that does not
// depend on time. A synthesiser (plan S2, S5) turns these into sound; it never
// derives physics itself, so every engine sounds the same for the same table.
import { CUBE_MODES, CUBE_NU, FACE, OMEGA } from './cube-modes.ts';
import type { SoundMaterial } from './material.ts';

export const C_AIR = 343;
export const RHO_AIR = 1.2;
/** Free-free beam: roots of cos(x) cosh(x) = 1. */
export const BETA_L = [4.730041, 7.853205, 10.995608, 14.137165, 17.278760, 20.420352];
/** Clamped square plate (Leissa): lambda = omega a^2 sqrt(rho h / D), with the half-wave counts (p, q). */
export const CLAMPED_PLATE: readonly (readonly [number, number, number])[] = [
  [35.99, 1, 1], [73.41, 2, 1], [73.41, 1, 2], [108.27, 2, 2], [131.64, 3, 1], [132.24, 1, 3], [165.15, 3, 2], [165.15, 2, 3],
];

export interface Modes {
  /** Hz, unsorted. */
  freq: Float64Array;
  /** Amplitude decay time, s: exp(-t / tau). */
  tau: Float64Array;
  /** Pressure at 1 m per m/s of surface velocity, per mode (radiation). */
  gain: Float64Array;
  /** Contact weights of one impact at a random point, one per mode (rms ~1 over the surface), written into `out`. */
  weights(rand: () => number, out: Float64Array): Float64Array;
}

/** The edge a shell or cube sounds as: the material's own size, else the body's. */
export function soundSize(m: SoundMaterial, bodyEdge: number): number {
  return m.model === 'plank' ? m.dims![0] : (m.size ?? bodyEdge);
}

export function mass(m: SoundMaterial, bodyEdge = 1): number {
  const L = soundSize(m, bodyEdge);
  if (m.model === 'plank') return m.rho * m.dims![0] * m.dims![1] * m.dims![2];
  if (m.model === 'shell') return m.rho * 6 * L * L * m.wall!;
  return m.rho * L ** 3;
}

/** Displaced volume: what radiates when the body as a whole accelerates. */
export function volume(m: SoundMaterial, bodyEdge = 1): number {
  return m.model === 'plank' ? m.dims![0] * m.dims![1] * m.dims![2] : soundSize(m, bodyEdge) ** 3;
}

/** Standard normal from two uniforms (Box-Muller). */
export const gauss = (rand: () => number): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const tauOf = (f: number, eta: number) => 1 / (Math.PI * f * eta);

/** Compact radiator, dipole efficiency (ka)^4 / (1 + (ka)^4) with a = half the smallest cross dimension. */
function radiation(m: SoundMaterial, f: number, bodyEdge: number): number {
  const thin = m.model === 'plank' ? m.dims![1] / 2 : soundSize(m, bodyEdge) / 2;
  const ka = (2 * Math.PI * f / C_AIR) * thin, k4 = ka ** 4;
  const extent = m.model === 'plank' ? m.dims![0] / 2 : soundSize(m, bodyEdge) / 2;
  return RHO_AIR * C_AIR * Math.sqrt(k4 / (1 + k4)) * extent * 10 ** (m.ringDb / 20);
}

/** Beam bending mode n (0-based) for a section of depth h: Euler-Bernoulli with the Rayleigh-Timoshenko correction. */
export function beamBending(L: number, h: number, E: number, G: number, rho: number, n: number): number {
  const b = BETA_L[n]!, rg = h / Math.sqrt(12), beta = b / L;
  const eb = (b * b) / (2 * Math.PI * L * L) * Math.sqrt(E / rho) * rg;
  return eb / Math.sqrt(1 + (beta * rg) ** 2 * (1 + E / ((5 / 6) * G)));
}

/** Free-free beam bending shape, rms 1 over the length, at x in [0, 1]. */
export function beamShape(n: number, x: number): number {
  const b = BETA_L[n]!, s = (Math.cosh(b) - Math.cos(b)) / (Math.sinh(b) - Math.sin(b)), bx = b * x;
  return Math.cosh(bx) + Math.cos(bx) - s * (Math.sinh(bx) + Math.sin(bx));
}

export function modes(m: SoundMaterial, bodyEdge = 1, fmax = 18000): Modes {
  const f: number[] = [];
  let weights: Modes['weights'];
  if (m.model === 'plank') {
    const [L, w, t] = m.dims!, G = m.G!;
    const kinds: [0 | 1 | 2, number][] = []; // 0 bending across t, 1 bending across w, 2 torsion
    for (const [kind, h] of [[0, t], [1, w]] as const)
      for (let n = 0; n < BETA_L.length; n++) { const fn = beamBending(L, h, m.E, G, m.rho, n); if (fn < fmax) { f.push(fn); kinds.push([kind, n]); } }
    // Saint-Venant torsion of a thin rectangle: c = sqrt(G J / (rho Ip)), f_n = n c / 2L.
    const J = w * t ** 3 * (1 / 3 - 0.21 * (t / w) * (1 - (t / w) ** 4 / 12)), Ip = (w * t * (w * w + t * t)) / 12;
    const ct = Math.sqrt(G / m.rho) * Math.sqrt(J / Ip);
    for (let n = 1; (n * ct) / (2 * L) < fmax; n++) { f.push((n * ct) / (2 * L)); kinds.push([2, n]); }
    weights = (rand, out) => {
      // Contact at x along the length, at offset `off` across the width, from a uniformly random direction.
      const x = rand(), off = 2 * rand() - 1;
      let nx = Math.abs(gauss(rand)), ny = Math.abs(gauss(rand)), nz = Math.abs(gauss(rand));
      const s = Math.hypot(nx, ny, nz) || 1; nx /= s; ny /= s; nz /= s;
      kinds.forEach(([kind, n], j) => {
        out[j] = kind === 2 ? Math.SQRT2 * Math.cos(n * Math.PI * x) * off * nz : beamShape(n, x) * (kind === 0 ? nz : ny);
      });
      return out;
    };
  } else if (m.model === 'shell') {
    const a = soundSize(m, bodyEdge), h = m.wall!;
    const D = (m.E * h ** 3) / (12 * (1 - m.nu * m.nu));
    const f1 = Math.sqrt(D / (m.rho * h)) / (2 * Math.PI * a * a);
    // Six walls, not quite equal (fixed spread so a material always sounds the same).
    const wallMul = [1.012, 0.987, 1.03, 0.995, 0.972, 1.006];
    const pq: [number, number, number][] = [];
    for (let wall = 0; wall < 6; wall++) for (const [l, p, q] of CLAMPED_PLATE) { const fn = l * f1 * wallMul[wall]!; if (fn < fmax) { f.push(fn); pq.push([wall, p, q]); } }
    weights = (rand, out) => {
      const wall = Math.min(5, Math.floor(rand() * 6)), x = rand(), y = rand();
      pq.forEach(([w, p, q], j) => { out[j] = w === wall ? 2 * Math.sqrt(6) * Math.sin(p * Math.PI * x) * Math.sin(q * Math.PI * y) : 0; });
      return out;
    };
  } else {
    const L = soundSize(m, bodyEdge), G = m.E / (2 * (1 + m.nu)), ct = Math.sqrt(G / m.rho);
    const k = Math.abs(m.nu - CUBE_NU[0]) <= Math.abs(m.nu - CUBE_NU[1]) ? 0 : 1; // nearest tabulated Poisson ratio
    const keep: number[] = [];
    for (let j = 0; j < CUBE_MODES; j++) { const fn = (OMEGA[k]![j]! * ct) / L; if (fn < fmax) { f.push(fn); keep.push(j); } }
    const face = FACE[k]!;
    const rms = keep.map((j) => Math.sqrt(face[j]!.reduce((s, u) => s + u * u, 0) / face[j]!.length));
    weights = (rand, out) => {
      const p = Math.min(35, Math.floor(rand() * 36));
      keep.forEach((j, i) => { out[i] = face[j]![p]! / rms[i]!; });
      return out;
    };
  }
  const freq = Float64Array.from(f);
  return {
    freq,
    tau: freq.map((x) => tauOf(x, m.eta)),
    gain: freq.map((x) => radiation(m, x, bodyEdge)),
    weights,
  };
}

/** Hertz contact time, s, of an impact at relative speed dv (m/s): 2.87 (m*^2 / (R E*^2 v))^(1/5). */
export function contactTime(m: SoundMaterial, dv: number, bodyEdge = 1): number {
  const Ec = m.Ec ?? m.E, Es = Ec / (2 * (1 - m.nu * m.nu)), ms = m.mstar * mass(m, bodyEdge);
  return 2.87 * ((ms * ms) / (m.R * Es * Es * Math.max(dv, 1e-3))) ** 0.2;
}

/** |F(f)| / J for a raised-cosine force pulse of length T: 1 at f = 0, zeros at f T = 2, 3, ... */
export function pulseSpectrum(f: number, T: number): number {
  const x = f * T;
  if (x < 1e-9) return 1;
  if (Math.abs(x - 1) < 1e-9) return 0.5;
  return Math.abs(Math.sin(Math.PI * x) / (Math.PI * x * (1 - x * x)));
}

/**
 * The click of the body's own acceleration (a compact dipole on its axis), Pa at 1 m per m/s of dv,
 * sampled at `sr` over the pulse: p = rho_air 3V / (8 pi c) * da/dt, da/dt = (2 pi dv / T^2) sin(2 pi t / T).
 */
export function clickKernel(m: SoundMaterial, T: number, sr: number, bodyEdge = 1): Float32Array {
  const n = Math.max(2, Math.ceil(T * sr)), out = new Float32Array(n);
  const k = ((RHO_AIR * 3 * volume(m, bodyEdge)) / (8 * Math.PI * C_AIR)) * 10 ** (m.clickDb / 20);
  for (let i = 0; i < n; i++) out[i] = k * ((2 * Math.PI) / (T * T)) * Math.sin((2 * Math.PI * (i + 0.5)) / (sr * T));
  return out;
}

/** A body's frequency multiplier: lognormal(jitter), from a per-body standard normal z. */
export const pitchOf = (m: SoundMaterial, z: number): number => Math.exp(m.jitter * z);
