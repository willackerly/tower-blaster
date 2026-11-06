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

/**
 * A clamped plate's modes up to n half-waves each way: Leissa's table where it has them, beyond it
 * Bolotin's edge-effect asymptote lambda ~ pi^2 ((p + 1/2)^2 + (q + 1/2)^2), scaled by 0.91 so it
 * meets the table at (3, 2) and (3, 3) (Leissa 165.15 and 220.03). Absent n: the table alone (the
 * classic 8 modes a wall, which bunch into near-harmonic clusters and read as a bell or a door).
 */
export function plateTable(n?: number): readonly (readonly [number, number, number])[] {
  if (n === undefined) return CLAMPED_PLATE;
  const out = CLAMPED_PLATE.filter(([, p, q]) => p <= n && q <= n).map((x) => [...x] as [number, number, number]);
  for (let p = 1; p <= n; p++) for (let q = 1; q <= n; q++)
    if (!CLAMPED_PLATE.some(([, a, b]) => a === p && b === q)) out.push([0.91 * Math.PI ** 2 * ((p + 0.5) ** 2 + (q + 0.5) ** 2), p, q]);
  return out;
}

/** Shell walls' frequency multipliers when a material gives none: within 3%, as machined walls. */
export const CLASSIC_WALLS = [1.012, 0.987, 1.03, 0.995, 0.972, 1.006] as const;

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
export function radiation(m: SoundMaterial, f: number, bodyEdge: number): number {
  const thin = m.model === 'plank' ? m.dims![1] / 2 : soundSize(m, bodyEdge) / 2;
  const ka = (2 * Math.PI * f / C_AIR) * thin, k4 = ka ** 4;
  const extent = m.model === 'plank' ? m.dims![0] / 2 : soundSize(m, bodyEdge) / 2;
  return RHO_AIR * C_AIR * Math.sqrt(k4 / (1 + k4)) * extent * 10 ** (m.ringDb / 20);
}

/**
 * Most of an impact's kinetic energy (1/2 m* dv^2) the table modes, and separately the dense field, may
 * take as vibration: half (a restitution of 0.7 keeps the other half as motion). An impulse into a
 * point excites every mode under 1 / T with the rigid body's energy each, which sums past the impact's.
 */
export const VIB_SHARE = 0.5;

/**
 * law 'energy': Pa at 1 m per m/s of dv of a table mode at f (decay tau), from the impact's energy. An
 * impulse J = m* dv gives a mode of unit contact weight (shapes rms 1 over the body: modal mass M) the
 * energy J^2 / (2 M); it radiates the share eta_rad / (eta_rad + eta) (denseRadiation; for planks the
 * compact dipole's (ka)^4 / (1 + (ka)^4)) as W, and a decaying sine of amplitude a carries
 * Int p^2 dt = a^2 tau / 4 = W rho_air c / (4 pi) at 1 m. The same law as the dense field, so the
 * table and the field meet without a step; ringDb trims it.
 */
export function modeGain(m: SoundMaterial, f: number, tau: number, bodyEdge = 1): number {
  const M = mass(m, bodyEdge), S = m.model === 'plank' ? 2 * (m.dims![0] * m.dims![1] + m.dims![0] * m.dims![2] + m.dims![1] * m.dims![2]) : 6 * soundSize(m, bodyEdge) ** 2;
  let sigma: number;
  if (m.model === 'plank') { const ka = ((2 * Math.PI * f) / C_AIR) * (m.dims![1] / 2), k4 = ka ** 4; sigma = k4 / (1 + k4); }
  else sigma = denseRadiation(m, f, bodyEdge);
  const er = (RHO_AIR * C_AIR * S * sigma) / (2 * Math.PI * f * M), W = ((m.mstar * M) ** 2 / (2 * M)) * (er / (er + m.eta));
  return Math.sqrt((W * RHO_AIR * C_AIR) / (Math.PI * tau)) * 10 ** (m.ringDb / 20);
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
    // Six walls, not quite equal (a fixed spread per material, so it always sounds the same).
    const wallMul = m.walls ?? CLASSIC_WALLS;
    const pq: [number, number, number][] = [];
    for (let wall = 0; wall < 6; wall++) for (const [l, p, q] of plateTable(m.plateModes)) { const fn = l * f1 * wallMul[wall]!; if (fn < fmax) { f.push(fn); pq.push([wall, p, q]); } }
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
  if (m.overlap !== undefined && m.model !== 'plank') weights = sparseModes(m, bodyEdge, fmax, f, weights);
  const freq = Float64Array.from(f), tau = freq.map((x) => tauOf(x, m.eta));
  let gain: Float64Array;
  if (m.law === 'energy') {
    // Each mode takes J^2 |F|^2 / (2 M) of a 1 m/s impact (its contact time); together at most VIB_SHARE of
    // the impact's energy (a hollow box's low modes all sit under 1 / T and would each take the rigid body's).
    const T = contactTime(m, 1, bodyEdge), eps = roughness(m), M = mass(m, bodyEdge);
    let vib = 0;
    for (const x of freq) vib += ((m.mstar * M) ** 2 * forceSpectrum(x, T, eps, roughTime(m)) ** 2) / (2 * M);
    const cap = Math.sqrt(Math.min(1, (VIB_SHARE * 0.5 * m.mstar * M) / vib));
    gain = freq.map((x, k) => modeGain(m, x, tau[k]!, bodyEdge) * cap);
  } else gain = freq.map((x) => radiation(m, x, bodyEdge));
  return { freq, tau, gain, weights };
}

/** The modal overlap at f: modes per half-power bandwidth, n(f) f eta pi / 2 (Cremer & Heckl). */
export const modalOverlap = (m: SoundMaterial, f: number, bodyEdge = 1): number => (modalDensity(m, f, bodyEdge) * f * m.eta * Math.PI) / 2;

/**
 * Discrete modes from the top of the table up to where the modal overlap reaches m.overlap (or fmax),
 * appended to f: the band-noise field (denseField) is only a fair stand-in where modes overlap. Below,
 * a steel block's "dense" modes are hundreds of Hz apart and a few Hz wide: a line spectrum, which
 * band noise turns into a synth pad (the judge's "Music"). Frequencies follow the Weyl count N(f)
 * (modalDensity), one per unit of N with a fixed +-0.3 jitter (modes repel: no near-degenerate pairs),
 * the same for every body of the material; each impact weights them by an independent unit normal
 * (rms 1, the table's contact-weight contract). Returns the weights with the new modes appended.
 */
export function sparseModes(m: SoundMaterial, bodyEdge: number, fmax: number, f: number[], table: Modes['weights']): Modes['weights'] {
  const n0 = f.length, top = f.reduce((a, b) => Math.max(a, b), 0), stop = m.overlap!;
  let a = 0x9e3779b9 >>> 0; // fixed stream: a material always rings the same
  const r = () => { a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return a / 4294967296; };
  // An empty table (a body whose first mode is past fmax, or a tiny one) counts from 20 Hz: from 0 the step x * 0.002 never moves.
  let N = 0, x = Math.max(top, 20), next = 1 + 0.6 * (r() - 0.5);
  while (x < fmax && modalOverlap(m, x, bodyEdge) < stop && f.length < n0 + 512) {
    const dx = x * 0.002;
    N += modalDensity(m, x, bodyEdge) * dx; x += dx;
    if (N >= next) { f.push(x); next = Math.floor(next + 0.5) + 1 + 0.6 * (r() - 0.5); }
  }
  if (f.length === n0) return table;
  return (rand, out) => {
    table(rand, out);
    for (let j = n0; j < f.length; j++) out[j] = gauss(rand);
    return out;
  };
}

/**
 * Contact time, s, of an impact at relative speed dv (m/s). Hertz (a curved contact of radius R):
 * 2.87 (m*^2 / (R E*^2 v))^(1/5). With `face`, toward a flat face meeting a flat face, whose stiffness
 * is the block's own, k = E* L (a cube's face over its edge), so T_face = pi sqrt(m* / k), and
 * T = T_hertz^(1 - face) T_face^face. A 0.5 m stone block dropped 5 cm: 7.5 ms on a 2 mm corner, 0.50 ms
 * flat; a landing starts on an edge and rolls onto the face (Material identity, step 2c).
 */
export function contactTime(m: SoundMaterial, dv: number, bodyEdge = 1): number {
  const Ec = m.Ec ?? m.E, Es = Ec / (2 * (1 - m.nu * m.nu)), ms = m.mstar * mass(m, bodyEdge);
  const hertz = 2.87 * ((ms * ms) / (m.R * Es * Es * Math.max(dv, 1e-3))) ** 0.2;
  if (!(m.face! > 0)) return hertz;
  const flat = Math.PI * Math.sqrt(ms / (Es * soundSize(m, bodyEdge)));
  return hertz ** (1 - m.face!) * flat ** m.face!;
}

/** |F(f)| / J for a raised-cosine force pulse of length T: 1 at f = 0, zeros at f T = 2, 3, ... */
export function pulseSpectrum(f: number, T: number): number {
  const x = f * T;
  if (x < 1e-9) return 1;
  if (Math.abs(x - 1) < 1e-9) return 0.5;
  return Math.abs(Math.sin(Math.PI * x) / (Math.PI * x * (1 - x * x)));
}

/** Contact roughness: the force's fluctuation as a share of itself (0: smooth). */
export const roughness = (m: SoundMaterial): number => (m.roughDb !== undefined && m.roughDb > -Infinity ? 10 ** (m.roughDb / 20) : 0);

/** An asperity's contact time, s: the roughness floor rolls off above ~1 / ROUGH_T (micro-contacts last ~0.1 ms). */
export const ROUGH_T = 1.5e-4;

/** A material's asperity contact time, s (its roughT, else ROUGH_T). */
export const roughTime = (m: SoundMaterial): number => m.roughT ?? ROUGH_T;

/**
 * |F(f)| / J with roughness eps (roughness(m)): the force fluctuates by eps of itself (several points
 * touching, asperities) over the contact, as noise of bandwidth ~1 / ROUGH_T. That noise has energy
 * eps^2 Int F_hertz^2 dt = 1.5 eps^2 J^2 / T spread over 1 / ROUGH_T, so in power it adds a floor of
 * 0.75 eps^2 ROUGH_T / T times an asperity's pulse: sqrt(pulse(f T)^2 + floor pulse(f ROUGH_T)^2).
 * A long contact (a heavy block) is smoother per impulse than a short one. Exactly the smooth pulse when eps = 0.
 */
export function forceSpectrum(f: number, T: number, eps: number, rt = ROUGH_T): number {
  const p = pulseSpectrum(f, T);
  if (!(eps > 0)) return p;
  const q = eps * Math.sqrt(Math.min(1, (0.75 * rt) / T)) * pulseSpectrum(f, rt);
  return Math.sqrt(p * p + q * q);
}

/**
 * Modes per Hz at f, for the dense field above the mode table. Shell: six walls as plates (2D Weyl),
 * n = (S / 2) sqrt(rho h / D) each, S the wall's area. Cube: a solid (3D Weyl, one longitudinal and
 * two transverse families), n = 4 pi V f^2 (1 / c_l^3 + 2 / c_t^3). Plank: 0 (its table reaches 18 kHz).
 */
export function modalDensity(m: SoundMaterial, f: number, bodyEdge = 1): number {
  const L = soundSize(m, bodyEdge);
  if (m.model === 'shell') {
    const h = m.wall!, D = (m.E * h ** 3) / (12 * (1 - m.nu * m.nu));
    return 6 * ((L * L) / 2) * Math.sqrt((m.rho * h) / D);
  }
  if (m.model === 'cube') {
    const G = m.E / (2 * (1 + m.nu)), ct = Math.sqrt(G / m.rho), cl = Math.sqrt((m.E * (1 - m.nu)) / (m.rho * (1 + m.nu) * (1 - 2 * m.nu)));
    return 4 * Math.PI * L ** 3 * f * f * (1 / cl ** 3 + 2 / ct ** 3);
  }
  return 0;
}

/** Half-octave bands of the dense field: centres from 125 Hz to 16 kHz (15 bands). */
export const DENSE_BANDS = Array.from({ length: 15 }, (_, b) => 125 * 2 ** (b / 2));

export interface DenseField {
  /** Lowest frequency the field covers: just above the mode table's highest mode (Hz). */
  from: number;
  /** Per band: amplitude decay time, s (the band centre's loss). */
  tau: Float64Array;
  /** Per (dv bin, band), bin-major: the band's sound per impact, Pa^2 s at 1 m per (m/s of dv)^2 (A = dv / distance). */
  energy: Float64Array;
  /** Per dv bin: vibration energy the field takes from an impact over its kinetic energy 1/2 m* dv^2 (capped at VIB_SHARE). */
  share: Float64Array;
}

/** A body's radiating surface, m^2 (the outside of a shell, the faces of a cube). */
const surface = (m: SoundMaterial, edge: number): number => 6 * soundSize(m, edge) ** 2;

/**
 * Radiation efficiency of the dense modes at f. Shell walls: thin square plates (side a), Maidanik's
 * edge and corner modes below the coincidence frequency fc = c^2 / (2 pi) sqrt(rho h / D) (the
 * EN 12354-1 Annex B form), 1 / sqrt(1 - fc / f) above, at most 2. Cube: a solid's surface waves are
 * supersonic, so only its size limits it: (ka)^4 / (1 + (ka)^4), a = half the edge.
 */
export function denseRadiation(m: SoundMaterial, f: number, edge = 1): number {
  const a = soundSize(m, edge);
  if (m.model === 'shell') {
    const h = m.wall!, D = (m.E * h ** 3) / (12 * (1 - m.nu * m.nu)), fc = (C_AIR * C_AIR) / (2 * Math.PI) * Math.sqrt((m.rho * h) / D);
    if (f >= fc) return Math.min(2, 1 / Math.sqrt(Math.max(1e-6, 1 - fc / f)));
    const l = Math.sqrt(f / fc), d1 = ((1 - l * l) * Math.log((1 + l) / (1 - l)) + 2 * l) / (4 * Math.PI ** 2 * (1 - l * l) ** 1.5);
    const d2 = f < fc / 2 ? (8 * C_AIR * C_AIR * (1 - 2 * l * l)) / (fc * fc * Math.PI ** 4 * a * a * l * Math.sqrt(1 - l * l)) : 0;
    return Math.min(2, (2 * (2 * a) * C_AIR * d1) / (a * a * fc) + d2);
  }
  const ka = ((2 * Math.PI * f) / C_AIR) * (a / 2), k4 = ka ** 4;
  return k4 / (1 + k4);
}

/**
 * The dense field of material m for the contact times of each dv bin (binT, s); null when off.
 *
 * Energy, not the mode table's per-mode law (which plays every mode at the body's dv and would grow
 * without bound with the mode count): an impulse J = m* dv into a body of mass M gives its modes the
 * energy 2 J^2 Int |F(f)|^2 Re Y(f) df, |F| = forceSpectrum (|F(0)| = 1), and the mean point
 * conductance of a body is Re Y = n(f) / (4 M) (modalDensity; Cremer & Heckl: for a plate it is the
 * infinite plate's 1 / (8 sqrt(D rho h))). Each band radiates its share eta_rad / (eta_rad + eta),
 * eta_rad = rho_air c S sigma / (omega M) (denseRadiation), as W; at 1 m that is
 * Int p^2 dt = W rho_air c / (4 pi). The field never takes more than VIB_SHARE of the impact's kinetic energy.
 * denseDb trims the level over this.
 */
export function denseField(m: SoundMaterial, binT: ArrayLike<number>, bodyEdge = 1, fmax = 18000): DenseField | null {
  if (!(m.denseDb !== undefined && m.denseDb > -Infinity) || m.model === 'plank') return null;
  const md = modes(m, bodyEdge, fmax), from = md.freq.reduce((a, b) => Math.max(a, b), 0) * 1.02;
  const B = DENSE_BANDS.length, tau = Float64Array.from(DENSE_BANDS, (f) => 1 / (Math.PI * f * m.eta));
  const energy = new Float64Array(binT.length * B), share = new Float64Array(binT.length);
  const M = mass(m, bodyEdge), S = surface(m, bodyEdge), r = roughness(m), rt = roughTime(m), lvl = 10 ** (m.denseDb / 10), STEPS = 24;
  const J2 = (m.mstar * M) ** 2, KE = 0.5 * m.mstar * M; // per (m/s of dv)^2
  for (let bin = 0; bin < binT.length; bin++) {
    let vib = 0;
    for (let b = 0; b < B; b++) {
      // The band's edges (geometric midpoints between centres), clipped to [from, fmax]; log-spaced midpoint rule.
      const lo = Math.max(from, DENSE_BANDS[b]! * 2 ** -0.25), hi = Math.min(fmax, DENSE_BANDS[b]! * 2 ** 0.25);
      if (!(hi > lo)) continue;
      let w = 0;
      for (let k = 0; k < STEPS; k++) {
        const f = lo * (hi / lo) ** ((k + 0.5) / STEPS), df = (f * Math.log(hi / lo)) / STEPS, F = forceSpectrum(f, binT[bin]!, r, rt);
        const e = 2 * J2 * F * F * (modalDensity(m, f, bodyEdge) / (4 * M)) * df;
        const er = (RHO_AIR * C_AIR * S * denseRadiation(m, f, bodyEdge)) / (2 * Math.PI * f * M);
        vib += e; w += (e * er) / (er + m.eta);
      }
      energy[bin * B + b] = ((w * RHO_AIR * C_AIR) / (4 * Math.PI)) * lvl;
    }
    // Energy is conserved: past VIB_SHARE of the impact's kinetic energy, every band scales down alike.
    const cap = vib > VIB_SHARE * KE ? (VIB_SHARE * KE) / vib : 1;
    share[bin] = (vib * cap) / KE;
    for (let b = 0; b < B; b++) energy[bin * B + b]! *= cap;
  }
  return { from, tau, energy, share };
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

/**
 * The click as a rigid sphere of the body's volume radiates it (clickModel 'sphere'): the compact dipole
 * (clickKernel) times G(s) = 2 / ((s / w0)^2 + 2 s / w0 + 2), w0 = c / a. That is the oscillating
 * sphere's exact far field, |p| / |accel| = rho w a^3 / (c sqrt(4 + (ka)^4)) (Kinsler et al., Morse):
 * the compact dipole below ka ~ 1.4, the piston's rho c a v above. A 0.5 m block's click is
 * compact only below ~250 Hz; the compact formula alone puts up to 11 dB too much into 300 Hz-1 kHz,
 * a "bwomp" the judge heard as Fart and Quack (docs/sound.md, Material identity, step 2).
 * Returns the biquad [b0, b1, b2, a1, a2] (bilinear, prewarped at w0); null for the compact click.
 */
export function clickFilter(m: SoundMaterial, sr: number, bodyEdge = 1): [number, number, number, number, number] | null {
  if (m.clickModel !== 'sphere') return null;
  const a = Math.cbrt((3 * volume(m, bodyEdge)) / (4 * Math.PI)), w0 = C_AIR / a, K = w0 / Math.tan(w0 / (2 * sr));
  const a0 = K * K + 2 * w0 * K + 2 * w0 * w0, g = (2 * w0 * w0) / a0;
  return [g, 2 * g, g, (4 * w0 * w0 - 2 * K * K) / a0, (K * K - 2 * w0 * K + 2 * w0 * w0) / a0];
}

/** clickKernel as radiated (clickFilter applied, with its tail), for a foreground voice. */
export function radiatedClick(m: SoundMaterial, T: number, sr: number, bodyEdge = 1): Float32Array {
  const k = clickKernel(m, T, sr, bodyEdge), f = clickFilter(m, sr, bodyEdge);
  if (!f) return k;
  const a = Math.cbrt((3 * volume(m, bodyEdge)) / (4 * Math.PI)), tail = Math.ceil((10 * a * sr) / C_AIR);
  const out = new Float32Array(k.length + tail), [b0, b1, b2, a1, a2] = f;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < out.length; i++) {
    const x = i < k.length ? k[i]! : 0, y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

/** A body's frequency multiplier: lognormal(jitter), from a per-body standard normal z. */
export const pitchOf = (m: SoundMaterial, z: number): number => Math.exp(m.jitter * z);
