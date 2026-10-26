// Physically based sky for the `real` look: Hillaire 2020, "A Scalable and
// Production Ready Sky and Atmosphere Rendering Technique" (EGSR). Three
// lookup tables, computed in compute passes:
//
// - transmittance (256x64): exp(-optical depth) from a point at radius r
//   along a ray at cos zenith mu to the top of the atmosphere, in
//   Bruneton's (r, mu) parameterization;
// - multiple scattering (32x32): Hillaire's isotropic approximation of all
//   orders above the first, as a function of sun zenith and height;
// - sky view (192x108): in-scattered radiance (rgb) and transmittance
//   (alpha, green channel) along every view ray from the eye, longitude
//   relative to the sun, latitude squeezed toward the horizon.
//
// The first two depend only on the atmosphere and are recomputed when it
// changes; the sky view also depends on the sun and the eye height, and is
// cheap enough (20k rays) to recompute every frame.
//
// Units: kilometres for the atmosphere. Radiance in renderer units: the sun
// illuminance at the top of the atmosphere is `sunIlluminance`, and a
// diffuse surface facing the sun reflects albedo x illuminance / pi, so the
// renderer's `sunColor` is sunIlluminance x transmittance / pi.
//
// Every function here has a CPU twin (tests compare them with the GPU).
import { defineStruct, wgslStruct, writeStruct } from '@tb/schema';
import type { V3 } from './math.ts';

/** Planet and atmosphere-top radii, km (Earth). */
export const R_GROUND = 6360;
export const R_TOP = 6460;
/** Rayleigh scattering per km at sea level (680, 550, 440 nm), scale height km. */
export const RAYLEIGH: V3 = [5.802e-3, 13.558e-3, 33.1e-3];
export const RAYLEIGH_H = 8;
export const MIE_H = 1.2;
/** Ozone absorption per km at the layer's peak, tent from 10 to 40 km. */
export const OZONE: V3 = [0.65e-3, 1.881e-3, 0.085e-3];
export const OZONE_CENTER = 25;
export const OZONE_WIDTH = 15;
/** Koschmieder's constant: visibility (km) x extinction (per km) at 550 nm, for a 2% contrast threshold. */
export const KOSCHMIEDER = 3.912;

export const TRANSMITTANCE_SIZE: [number, number] = [256, 64];
export const MULTI_SIZE: [number, number] = [32, 32];
export const SKY_VIEW_SIZE: [number, number] = [192, 108];
/** Ray-march steps (squared spacing, dense near the start). */
export const STEPS = { transmittance: 40, multi: 20, sky: 32 } as const;
/** Directions per multiple-scattering texel (8 x 8 over the sphere). */
export const MULTI_DIRS = 8;

export interface AtmosphereParams {
  /** Meteorological visibility at the ground, km; sets the aerosol (Mie) density. */
  visibility: number;
  /** Aerosol single-scattering albedo. */
  mieAlbedo: number;
  /** Aerosol phase asymmetry (Cornette-Shanks). */
  mieG: number;
  /** Ground albedo the multiple scattering sees. */
  groundAlbedo: V3;
  /** Sun illuminance at the top of the atmosphere, renderer units. */
  sunIlluminance: V3;
  /** Angular radius of the sun disc, radians (0.2666 degrees). */
  sunRadius: number;
}

export const CLEAR_DAY: AtmosphereParams = {
  visibility: 40,
  mieAlbedo: 0.9,
  mieG: 0.8,
  groundAlbedo: [0.3, 0.3, 0.3],
  sunIlluminance: [9.4, 9.4, 9.4],
  sunRadius: 0.004654,
};

/** Aerosol extinction at the ground: Koschmieder's total at 550 nm less Rayleigh's. */
export function mieExtinction(a: AtmosphereParams): number {
  return Math.max(0, KOSCHMIEDER / a.visibility - RAYLEIGH[1]);
}

// ---------------------------------------------------------------- CPU twins

type Medium = { scatter: V3; rayleigh: V3; mie: number; extinction: V3 };

export function medium(a: AtmosphereParams, h: number): Medium {
  const rd = Math.exp(-h / RAYLEIGH_H), md = Math.exp(-h / MIE_H);
  const od = Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_WIDTH);
  const me = mieExtinction(a) * md, ms = me * a.mieAlbedo;
  const rayleigh = RAYLEIGH.map((b) => b * rd) as V3;
  return {
    rayleigh, mie: ms,
    scatter: rayleigh.map((x) => x + ms) as V3,
    extinction: rayleigh.map((x, k) => x + me + OZONE[k]! * od) as V3,
  };
}

// Geometry takes the height h above the ground, not the radius: at eye
// heights of a few metres, r^2 - R_GROUND^2 computed from r loses most of
// its digits in f32 (an ulp of 6360 km is 0.5 m). r^2 - R_GROUND^2 is
// h (2 R_GROUND + h) instead, and every formula below avoids the cancellation.

/** r^2 - R_GROUND^2 at height h. */
const rho2 = (h: number) => h * (2 * R_GROUND + h);

/** Distance from height h along cos zenith mu to the top of the atmosphere. */
export function distanceToTop(h: number, mu: number): number {
  const r = R_GROUND + h;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * mu * mu + (R_TOP - R_GROUND - h) * (R_TOP + r))));
}

/** Distance from height h along cos zenith mu to the ground, or -1 when the ray misses it. */
export function distanceToGround(h: number, mu: number): number {
  const r = R_GROUND + h, disc = r * r * mu * mu - rho2(h);
  // -r mu - sqrt(disc), rationalized (the two terms nearly cancel near the ground).
  return mu < 0 && disc >= 0 ? rho2(h) / Math.max(-r * mu + Math.sqrt(disc), 1e-30) : -1;
}

/** Height and radius at distance t along a ray from height h0 at cos zenith mu. */
function along(h0: number, mu: number, t: number): { h: number; r: number } {
  const q = rho2(h0) + t * (t + 2 * (R_GROUND + h0) * mu), r = Math.sqrt(R_GROUND * R_GROUND + Math.max(q, 0));
  return { h: Math.max(q, 0) / (r + R_GROUND), r };
}

/** Unit range to texel centres of an n-texel axis (Bruneton). */
const toTexel = (x: number, n: number) => 0.5 / n + x * (1 - 1 / n);
const fromTexel = (u: number, n: number) => (u - 0.5 / n) / (1 - 1 / n);
const H_TOP = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function transmittanceUv(h: number, mu: number): [number, number] {
  const rho = Math.sqrt(rho2(h));
  const d = distanceToTop(h, mu), dMin = R_TOP - R_GROUND - h, dMax = rho + H_TOP;
  return [toTexel((d - dMin) / (dMax - dMin), TRANSMITTANCE_SIZE[0]), toTexel(rho / H_TOP, TRANSMITTANCE_SIZE[1])];
}

/** Height and cos zenith of transmittance texel coordinates (u, v). */
export function transmittanceHMu(u: number, v: number): [number, number] {
  const xMu = fromTexel(u, TRANSMITTANCE_SIZE[0]), xR = fromTexel(v, TRANSMITTANCE_SIZE[1]);
  const rho = H_TOP * xR, h = (rho * rho) / (R_GROUND + Math.sqrt(R_GROUND * R_GROUND + rho * rho)), r = R_GROUND + h;
  const dMin = R_TOP - R_GROUND - h, dMax = rho + H_TOP, d = dMin + xMu * (dMax - dMin);
  const mu = d === 0 ? 1 : clamp((H_TOP * H_TOP - rho * rho - d * d) / (2 * r * d), -1, 1);
  return [h, mu];
}

/** Squared step spacing over [0, tMax]: segment i's midpoint and length. */
function segment(i: number, n: number, tMax: number): [number, number] {
  const t0 = tMax * (i / n) ** 2, t1 = tMax * ((i + 1) / n) ** 2;
  return [0.5 * (t0 + t1), t1 - t0];
}

/** Transmittance from height h along cos zenith mu to the top of the atmosphere, integrated directly. */
export function transmittance(a: AtmosphereParams, h0: number, mu: number): V3 {
  const tMax = distanceToTop(h0, mu);
  const tau: V3 = [0, 0, 0];
  for (let i = 0; i < STEPS.transmittance; i++) {
    const [t, dt] = segment(i, STEPS.transmittance, tMax);
    const e = medium(a, along(h0, mu, t).h).extinction;
    for (let k = 0; k < 3; k++) tau[k] = tau[k]! + e[k]! * dt;
  }
  return tau.map((x) => Math.exp(-x)) as V3;
}

export function rayleighPhase(c: number): number {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

export function miePhase(g: number, c: number): number {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * (1 - g2) * (1 + c * c)) / ((2 + g2) * (1 + g2 - 2 * g * c) ** 1.5);
}

/** A multiple-scattering table, for the CPU twin of the sky (row-major, height rows). */
export interface MultiTable { w: number; h: number; data: Float32Array }

export function multiUv(muS: number, h: number, w = MULTI_SIZE[0], hh = MULTI_SIZE[1]): [number, number] {
  return [toTexel(clamp(0.5 + 0.5 * muS, 0, 1), w), toTexel(clamp(h / (R_TOP - R_GROUND), 0, 1), hh)];
}

/** Bilinear sampling of an rgb table at texel-centred uv, clamped at the edges (as the GPU's linear sampler). */
function bilinear(t: MultiTable, u: number, v: number): V3 {
  const x = clamp(u * t.w - 0.5, 0, t.w - 1), y = clamp(v * t.h - 0.5, 0, t.h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, t.w - 1), y1 = Math.min(y0 + 1, t.h - 1);
  const fx = x - x0, fy = y - y0;
  const at = (i: number, j: number, k: number) => t.data[(j * t.w + i) * 3 + k]!;
  return [0, 1, 2].map((k) => (at(x0, y0, k) * (1 - fx) + at(x1, y0, k) * fx) * (1 - fy) + (at(x0, y1, k) * (1 - fx) + at(x1, y1, k) * fx) * fy) as V3;
}

/** The transmittance LUT on the CPU: what csTransmittance writes, texel for texel. */
export function transmittanceTable(a: AtmosphereParams): MultiTable {
  const [w, h] = TRANSMITTANCE_SIZE, data = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data.set(transmittance(a, ...transmittanceHMu((i + 0.5) / w, (j + 0.5) / h)), (j * w + i) * 3);
  return { w, h, data };
}

/** Transmittance from the LUT, as the GPU samples it. */
export function sampleTransmittance(t: MultiTable, h: number, mu: number): V3 {
  return bilinear(t, ...transmittanceUv(h, mu));
}

interface March { L: V3; fms: V3; throughput: V3 }

/**
 * In-scattering along a ray from height h0 (on the y axis) in direction dir,
 * lit by a sun of unit illuminance from `sun`. multi: null for the
 * multiple-scattering pass (isotropic phase, also integrates the transfer
 * fms), else the table to add as the higher orders.
 */
function march(a: AtmosphereParams, T: MultiTable, h0: number, dir: V3, sun: V3, steps: number, multi: MultiTable | null): March & { ground: boolean; tMax: number } {
  const mu = dir[1], r0 = R_GROUND + h0;
  const dg = distanceToGround(h0, mu);
  const ground = dg >= 0;
  const tMax = ground ? dg : distanceToTop(h0, mu);
  const cosTheta = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const pr = rayleighPhase(cosTheta), pm = miePhase(a.mieG, cosTheta), iso = 1 / (4 * Math.PI);
  const L: V3 = [0, 0, 0], fms: V3 = [0, 0, 0], th: V3 = [1, 1, 1];
  for (let i = 0; i < steps; i++) {
    const [t, dt] = segment(i, steps, tMax);
    const { h, r } = along(h0, mu, t);
    const muS = (t * cosTheta + r0 * sun[1]) / r;
    const m = medium(a, h);
    const lit = distanceToGround(h, muS) >= 0 ? 0 : 1;
    const ts = sampleTransmittance(T, h, muS);
    const ms = multi ? bilinear(multi, ...multiUv(muS, h, multi.w, multi.h)) : null;
    for (let k = 0; k < 3; k++) {
      const e = m.extinction[k]!, step = Math.exp(-e * dt);
      const S = multi
        ? lit * ts[k]! * (m.rayleigh[k]! * pr + m.mie * pm) + ms![k]! * m.scatter[k]!
        : lit * ts[k]! * m.scatter[k]! * iso;
      L[k] = L[k]! + (th[k]! * (S - S * step)) / e;
      if (!multi) fms[k] = fms[k]! + (th[k]! * (m.scatter[k]! - m.scatter[k]! * step)) / e;
      th[k] = th[k]! * step;
    }
  }
  return { L, fms, throughput: th, ground, tMax };
}

/** Second and higher orders of scattering at sun cos zenith muS and height h (km), per unit sun illuminance. */
export function multiScattering(a: AtmosphereParams, T: MultiTable, muS: number, h: number): V3 {
  const h0 = Math.max(h, 0.01), r = R_GROUND + h0;
  const sun: V3 = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
  const L: V3 = [0, 0, 0], f: V3 = [0, 0, 0];
  const n = MULTI_DIRS * MULTI_DIRS;
  for (let i = 0; i < MULTI_DIRS; i++) for (let j = 0; j < MULTI_DIRS; j++) {
    const phi = (2 * Math.PI * (i + 0.5)) / MULTI_DIRS, cosT = 1 - (2 * (j + 0.5)) / MULTI_DIRS, sinT = Math.sqrt(1 - cosT * cosT);
    const dir: V3 = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
    const m = march(a, T, h0, dir, sun, STEPS.multi, null);
    const Lg: V3 = [0, 0, 0];
    if (m.ground) {
      const cosTheta = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
      const muSg = (m.tMax * cosTheta + r * sun[1]) / R_GROUND;
      const tg = sampleTransmittance(T, 0, muSg);
      for (let k = 0; k < 3; k++) Lg[k] = (m.throughput[k]! * tg[k]! * Math.max(muSg, 0) * a.groundAlbedo[k]!) / Math.PI;
    }
    for (let k = 0; k < 3; k++) { L[k] = L[k]! + (m.L[k]! + Lg[k]!) / n; f[k] = f[k]! + m.fms[k]! / n; }
  }
  return L.map((x, k) => x / (1 - f[k]!)) as V3;
}

export function multiTable(a: AtmosphereParams, T: MultiTable, w = MULTI_SIZE[0], h = MULTI_SIZE[1]): MultiTable {
  const data = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const muS = 2 * fromTexel((i + 0.5) / w, w) - 1, hh = fromTexel((j + 0.5) / h, h) * (R_TOP - R_GROUND);
    data.set(multiScattering(a, T, muS, hh), (j * w + i) * 3);
  }
  return { w, h, data };
}

/** Radiance of the sky (rgb, sun disc excluded) and the view ray's green transmittance, from eye height hEye km. */
export function skyRadiance(a: AtmosphereParams, T: MultiTable, multi: MultiTable, sun: V3, dir: V3, hEye: number): [V3, number] {
  const m = march(a, T, Math.max(hEye, 1e-4), dir, sun, STEPS.sky, multi);
  return [m.L.map((x, k) => x * a.sunIlluminance[k]!) as V3, m.throughput[1]!];
}

// Sky view: u = sqrt(azimuth from the sun / pi), v splits at the horizon
// with a square-root squeeze toward it on both sides.
function horizon(h: number): { zh: number; beta: number } {
  const beta = Math.acos(Math.sqrt(rho2(h)) / (R_GROUND + h));
  return { zh: Math.PI - beta, beta };
}

export function skyViewUv(dir: V3, sun: V3, hEye: number): [number, number] {
  const { zh, beta } = horizon(Math.max(hEye, 1e-4));
  const zenith = Math.acos(clamp(dir[1], -1, 1));
  const v = zenith < zh ? 0.5 * (1 - Math.sqrt(1 - zenith / zh)) : 0.5 + 0.5 * Math.sqrt((zenith - zh) / beta);
  const hd = Math.hypot(dir[0], dir[2]), hs = Math.hypot(sun[0], sun[2]);
  const c = hd > 1e-6 && hs > 1e-6 ? clamp((dir[0] * sun[0] + dir[2] * sun[2]) / (hd * hs), -1, 1) : 1;
  return [toTexel(Math.sqrt(Math.acos(c) / Math.PI), SKY_VIEW_SIZE[0]), toTexel(clamp(v, 0, 1), SKY_VIEW_SIZE[1])];
}

/** The view direction of sky-view texel centre (u, v), in the frame where the sun has azimuth 0 (+x) and cos zenith muS. */
export function skyViewDir(u: number, v: number, hEye: number): V3 {
  const { zh, beta } = horizon(Math.max(hEye, 1e-4));
  const x = fromTexel(u, SKY_VIEW_SIZE[0]), y = fromTexel(v, SKY_VIEW_SIZE[1]);
  const zenith = y < 0.5 ? zh * (1 - (1 - 2 * y) ** 2) : zh + beta * (2 * y - 1) ** 2;
  const az = Math.PI * x * x;
  return [Math.sin(zenith) * Math.cos(az), Math.cos(zenith), Math.sin(zenith) * Math.sin(az)];
}

/** Sun illuminance reaching the ground (rgb) over pi: the renderer's sunColor. */
export function sunAtGround(a: AtmosphereParams, sun: V3, hEye = 0): V3 {
  const h = Math.max(hEye, 1e-4), t = transmittance(a, h, sun[1]);
  const lit = distanceToGround(h, sun[1]) >= 0 ? 0 : 1;
  return t.map((x, k) => (lit * x * a.sunIlluminance[k]!) / Math.PI) as V3;
}

/** Radiance of the sun disc's centre-weighted average (rgb), for the sky pass. */
export function sunDiscRadiance(a: AtmosphereParams, sun: V3, hEye = 0): V3 {
  const omega = 2 * Math.PI * (1 - Math.cos(a.sunRadius));
  const L = sunAtGround(a, sun, hEye).map((x) => (x * Math.PI) / omega);
  const k = Math.min(1, 6e4 / Math.max(...L, 1e-9)); // within half-float range, colour kept
  return L.map((x) => x * k) as V3;
}

/** Directions of the ambient integral: cosine-weighted over the upper hemisphere, AMBIENT_AZ x AMBIENT_EL strata. */
export const AMBIENT_AZ = 16;
export const AMBIENT_EL = 8;
export function ambientDir(k: number): V3 {
  const i = k % AMBIENT_AZ, j = Math.floor(k / AMBIENT_AZ);
  const u = (j + 0.5) / AMBIENT_EL, phi = (2 * Math.PI * (i + 0.5)) / AMBIENT_AZ;
  const sinT = Math.sqrt(u), cosT = Math.sqrt(1 - u);
  return [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
}

/**
 * Ambient for the `real` look until sky lighting lands (realism step 2), as
 * csAmbient computes it: sky irradiance on an upward surface over pi (the
 * radiance unit shade() multiplies albedo by), and the radiance of the ground
 * below (albedo x the sun's and sky's irradiance over pi). sky(dir) is the
 * sky radiance (the sky-view LUT on the GPU).
 */
export function ambientOf(sky: (dir: V3) => V3, sunColor: V3, sun: V3, groundAlbedo: V3): { sky: V3; ground: V3 } {
  const n = AMBIENT_AZ * AMBIENT_EL, s: V3 = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const L = sky(ambientDir(k));
    for (let c = 0; c < 3; c++) s[c] = s[c]! + L[c]! / n;
  }
  // Cosine-weighted mean radiance = irradiance / pi.
  return { sky: s, ground: groundAlbedo.map((g, c) => g * (sunColor[c]! * Math.max(sun[1], 0) + s[c]!)) as V3 };
}

/** Rec. 709 luminance weights (linear RGB). */
export const LUMA: V3 = [0.2126, 0.7152, 0.0722];
/** Exposure adaptation is held within this factor either way (4 EV). */
export const ADAPT_MAX = 16;
/**
 * meteredIlluminance / luminance(sunIlluminance) of CLEAR_DAY with the sun at
 * REAL_DEFAULTS' 35 degrees: the illuminance at which adaptation leaves the
 * exposure as set. Measured from csAmbient; render.test.ts checks it.
 */
export const ADAPT_REF = 0.09642;

/**
 * What the exposure meters: the mean illuminance over pi on a sphere (an
 * incident-light dome), as luminance. Sun: a quarter of its normal
 * illuminance whatever its elevation, so a low sun on walls meters as much
 * as a high one on the ground; sky and ground radiance: half each (each
 * fills a hemisphere). sky: ambientOf().sky, ground: ambientOf().ground,
 * sunColor: sunAtGround.
 */
export function meteredIlluminance(sky: V3, ground: V3, sunColor: V3): number {
  return LUMA.reduce((acc, w, c) => acc + w * (sunColor[c]! / 4 + (sky[c]! + ground[c]!) / 2), 0);
}

/**
 * The exposure after the eye adapts to illuminance I: exposure at the
 * reference illuminance, scaled by (ref / I)^adaptation, so 1 is a camera
 * on auto exposure and 0 a fixed one. The reference scales with the sun's
 * illuminance, so sunStrength still brightens the scene; adaptation follows
 * the sun's elevation and the haze.
 */
export function adaptedExposure(I: number, sunIlluminance: V3, exposure: number, adaptation: number, adaptRef = ADAPT_REF): number {
  const ratio = (adaptRef * LUMA.reduce((acc, w, c) => acc + w * sunIlluminance[c]!, 0)) / Math.max(I, 1e-12);
  return exposure * clamp(ratio ** adaptation, 1 / ADAPT_MAX, ADAPT_MAX);
}

// ---------------------------------------------------------------- GPU

export const Atmo = defineStruct('Atmo', [
  ['sun', 'vec3f'], ['eyeHeight', 'f32', 'km'],
  ['sunIlluminance', 'vec3f'], ['mieExt', 'f32', 'per km at the ground'],
  ['groundAlbedo', 'vec3f'], ['mieAlbedo', 'f32'],
  ['mieG', 'f32'], ['exposure', 'f32', 'the look\'s exposure (post.ts) before adaptation'],
  ['adaptation', 'f32', '0: fixed exposure, 1: full adaptation to the ground illuminance'], ['adaptRef', 'f32', 'ADAPT_REF'],
], 'Atmosphere uniforms of the sky LUT passes (atmosphere.ts).');

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const v3 = (v: V3) => `vec3f(${v.map(f).join(', ')})`;

/** Shared WGSL: constants, parameterizations and phases (scene shader and LUT passes). */
export const ATMO_COMMON_WGSL = /* wgsl */ `
const R_GROUND = ${f(R_GROUND)};
const R_TOP = ${f(R_TOP)};
const H_TOP = ${f(H_TOP)};
const ATMO_PI = 3.14159265;
const SKY_VIEW_W = ${f(SKY_VIEW_SIZE[0])};
const SKY_VIEW_H = ${f(SKY_VIEW_SIZE[1])};
const ADAPT_MAX = ${f(ADAPT_MAX)};

fn toTexel(x: f32, n: f32) -> f32 { return 0.5 / n + x * (1.0 - 1.0 / n); }
fn fromTexel(u: f32, n: f32) -> f32 { return (u - 0.5 / n) / (1.0 - 1.0 / n); }

// Heights, not radii: see atmosphere.ts (f32 cancellation near the ground).
fn rho2(h: f32) -> f32 { return h * (2.0 * R_GROUND + h); }

fn distanceToTop(h: f32, mu: f32) -> f32 {
  let r = R_GROUND + h;
  return max(0.0, -r * mu + sqrt(max(0.0, r * r * mu * mu + (R_TOP - R_GROUND - h) * (R_TOP + r))));
}

fn distanceToGround(h: f32, mu: f32) -> f32 {
  let r = R_GROUND + h;
  let disc = r * r * mu * mu - rho2(h);
  return select(-1.0, rho2(h) / max(-r * mu + sqrt(max(disc, 0.0)), 1e-30), mu < 0.0 && disc >= 0.0);
}

// Height and radius at distance t along a ray from height h0 at cos zenith mu.
fn along(h0: f32, mu: f32, t: f32) -> vec2f {
  let q = max(rho2(h0) + t * (t + 2.0 * (R_GROUND + h0) * mu), 0.0);
  let r = sqrt(R_GROUND * R_GROUND + q);
  return vec2f(q / (r + R_GROUND), r);
}

fn horizonAngles(h: f32) -> vec2f {
  let beta = acos(sqrt(rho2(h)) / (R_GROUND + h));
  return vec2f(ATMO_PI - beta, beta);
}

fn skyViewUv(dir: vec3f, sun: vec3f, hEye: f32) -> vec2f {
  let hb = horizonAngles(max(hEye, 1e-4));
  let zenith = acos(clamp(dir.y, -1.0, 1.0));
  let v = select(0.5 + 0.5 * sqrt(max(zenith - hb.x, 0.0) / hb.y), 0.5 * (1.0 - sqrt(max(1.0 - zenith / hb.x, 0.0))), zenith < hb.x);
  let hd = length(dir.xz);
  let hs = length(sun.xz);
  let c = select(1.0, clamp(dot(dir.xz, sun.xz) / (hd * hs), -1.0, 1.0), hd > 1e-6 && hs > 1e-6);
  return vec2f(toTexel(sqrt(acos(c) / ATMO_PI), SKY_VIEW_W), toTexel(clamp(v, 0.0, 1.0), SKY_VIEW_H));
}
`;

export const ATMOSPHERE_WGSL = /* wgsl */ `
${wgslStruct(Atmo)}
${ATMO_COMMON_WGSL}
@group(0) @binding(0) var<uniform> atmo: Atmo;
@group(0) @binding(1) var lutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multiLut: texture_2d<f32>;
@group(0) @binding(4) var outLut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var skyViewLut: texture_2d<f32>;
@group(0) @binding(6) var<storage, read_write> ambientOut: array<vec4f, 3>;

const RAYLEIGH = ${v3(RAYLEIGH)};
const OZONE = ${v3(OZONE)};
const TRANSMITTANCE_W = ${f(TRANSMITTANCE_SIZE[0])};
const TRANSMITTANCE_H = ${f(TRANSMITTANCE_SIZE[1])};
const MULTI_W = ${f(MULTI_SIZE[0])};
const MULTI_H = ${f(MULTI_SIZE[1])};

struct Medium { scatter: vec3f, rayleigh: vec3f, mie: f32, extinction: vec3f }

fn medium(h: f32) -> Medium {
  let rd = exp(-h / ${f(RAYLEIGH_H)});
  let md = exp(-h / ${f(MIE_H)});
  let od = max(0.0, 1.0 - abs(h - ${f(OZONE_CENTER)}) / ${f(OZONE_WIDTH)});
  let me = atmo.mieExt * md;
  let ms = me * atmo.mieAlbedo;
  let rayleigh = RAYLEIGH * rd;
  return Medium(rayleigh + ms, rayleigh, ms, rayleigh + me + OZONE * od);
}

fn segment(i: u32, n: u32, tMax: f32) -> vec2f {
  let a = f32(i) / f32(n);
  let b = f32(i + 1u) / f32(n);
  let t0 = tMax * a * a;
  let t1 = tMax * b * b;
  return vec2f(0.5 * (t0 + t1), t1 - t0);
}

fn transmittanceUv(h: f32, mu: f32) -> vec2f {
  let rho = sqrt(rho2(h));
  let d = distanceToTop(h, mu);
  let dMin = R_TOP - R_GROUND - h;
  let dMax = rho + H_TOP;
  return vec2f(toTexel((d - dMin) / (dMax - dMin), TRANSMITTANCE_W), toTexel(rho / H_TOP, TRANSMITTANCE_H));
}

fn sampleTransmittance(h: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transmittanceLut, lutSampler, transmittanceUv(h, mu), 0.0).rgb;
}

fn rayleighPhase(c: f32) -> f32 { return 3.0 / (16.0 * ATMO_PI) * (1.0 + c * c); }

fn miePhase(g: f32, c: f32) -> f32 {
  let g2 = g * g;
  return 3.0 / (8.0 * ATMO_PI) * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

@compute @workgroup_size(8, 8) fn csTransmittance(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= TRANSMITTANCE_W || f32(id.y) >= TRANSMITTANCE_H) { return; }
  let xMu = fromTexel((f32(id.x) + 0.5) / TRANSMITTANCE_W, TRANSMITTANCE_W);
  let xR = fromTexel((f32(id.y) + 0.5) / TRANSMITTANCE_H, TRANSMITTANCE_H);
  let rho = H_TOP * xR;
  let h0 = rho * rho / (R_GROUND + sqrt(R_GROUND * R_GROUND + rho * rho));
  let r = R_GROUND + h0;
  let dMin = R_TOP - R_GROUND - h0;
  let dMax = rho + H_TOP;
  let d = dMin + xMu * (dMax - dMin);
  let mu = select(clamp((H_TOP * H_TOP - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0), 1.0, d == 0.0);
  let tMax = distanceToTop(h0, mu);
  var tau = vec3f(0.0);
  for (var i = 0u; i < ${STEPS.transmittance}u; i++) {
    let s = segment(i, ${STEPS.transmittance}u, tMax);
    tau += medium(along(h0, mu, s.x).x).extinction * s.y;
  }
  textureStore(outLut, id.xy, vec4f(exp(-tau), 1.0));
}

struct March { L: vec3f, fms: vec3f, throughput: vec3f, ground: bool, tMax: f32 }

fn march(h0: f32, dir: vec3f, sun: vec3f, steps: u32, multi: bool) -> March {
  let mu = dir.y;
  let r0 = R_GROUND + h0;
  let dg = distanceToGround(h0, mu);
  let ground = dg >= 0.0;
  let tMax = select(distanceToTop(h0, mu), dg, ground);
  let cosTheta = dot(dir, sun);
  let pr = rayleighPhase(cosTheta);
  let pm = miePhase(atmo.mieG, cosTheta);
  let iso = 1.0 / (4.0 * ATMO_PI);
  var L = vec3f(0.0);
  var fms = vec3f(0.0);
  var th = vec3f(1.0);
  for (var i = 0u; i < steps; i++) {
    let s = segment(i, steps, tMax);
    let hr = along(h0, mu, s.x);
    let h = hr.x;
    let muS = (s.x * cosTheta + r0 * sun.y) / hr.y;
    let m = medium(h);
    let lit = select(1.0, 0.0, distanceToGround(h, muS) >= 0.0);
    let ts = sampleTransmittance(h, muS);
    let tr = exp(-m.extinction * s.y);
    var S: vec3f;
    if (multi) {
      let ms = textureSampleLevel(multiLut, lutSampler, vec2f(toTexel(clamp(0.5 + 0.5 * muS, 0.0, 1.0), MULTI_W), toTexel(clamp(h / (R_TOP - R_GROUND), 0.0, 1.0), MULTI_H)), 0.0).rgb;
      S = lit * ts * (m.rayleigh * pr + m.mie * pm) + ms * m.scatter;
    } else {
      S = lit * ts * m.scatter * iso;
      fms += th * (m.scatter - m.scatter * tr) / m.extinction;
    }
    L += th * (S - S * tr) / m.extinction;
    th *= tr;
  }
  return March(L, fms, th, ground, tMax);
}

@compute @workgroup_size(8, 8) fn csMulti(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= MULTI_W || f32(id.y) >= MULTI_H) { return; }
  let muS = 2.0 * fromTexel((f32(id.x) + 0.5) / MULTI_W, MULTI_W) - 1.0;
  let h = fromTexel((f32(id.y) + 0.5) / MULTI_H, MULTI_H) * (R_TOP - R_GROUND);
  let h0 = max(h, 0.01);
  let r = R_GROUND + h0;
  let sun = vec3f(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  var L = vec3f(0.0);
  var fsum = vec3f(0.0);
  let n = f32(${MULTI_DIRS * MULTI_DIRS});
  for (var i = 0u; i < ${MULTI_DIRS}u; i++) {
    for (var j = 0u; j < ${MULTI_DIRS}u; j++) {
      let phi = 2.0 * ATMO_PI * (f32(i) + 0.5) / ${f(MULTI_DIRS)};
      let cosT = 1.0 - 2.0 * (f32(j) + 0.5) / ${f(MULTI_DIRS)};
      let sinT = sqrt(1.0 - cosT * cosT);
      let dir = vec3f(sinT * cos(phi), cosT, sinT * sin(phi));
      let m = march(h0, dir, sun, ${STEPS.multi}u, false);
      var Lg = vec3f(0.0);
      if (m.ground) {
        let muSg = (m.tMax * dot(dir, sun) + r * sun.y) / R_GROUND;
        Lg = m.throughput * sampleTransmittance(0.0, muSg) * max(muSg, 0.0) * atmo.groundAlbedo / ATMO_PI;
      }
      L += (m.L + Lg) / n;
      fsum += m.fms / n;
    }
  }
  textureStore(outLut, id.xy, vec4f(L / (1.0 - fsum), 1.0));
}

@compute @workgroup_size(8, 8) fn csSkyView(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= SKY_VIEW_W || f32(id.y) >= SKY_VIEW_H) { return; }
  let hEye = max(atmo.eyeHeight, 1e-4);
  let hb = horizonAngles(hEye);
  let x = fromTexel((f32(id.x) + 0.5) / SKY_VIEW_W, SKY_VIEW_W);
  let y = fromTexel((f32(id.y) + 0.5) / SKY_VIEW_H, SKY_VIEW_H);
  let zenith = select(hb.x + hb.y * (2.0 * y - 1.0) * (2.0 * y - 1.0), hb.x * (1.0 - (1.0 - 2.0 * y) * (1.0 - 2.0 * y)), y < 0.5);
  let az = ATMO_PI * x * x;
  let dir = vec3f(sin(zenith) * cos(az), cos(zenith), sin(zenith) * sin(az));
  // The sun at azimuth 0 in this frame, at its true elevation.
  let sun = vec3f(length(atmo.sun.xz), atmo.sun.y, 0.0);
  let m = march(hEye, dir, sun, ${STEPS.sky}u, true);
  textureStore(outLut, id.xy, vec4f(m.L * atmo.sunIlluminance, m.throughput.g));
}

// Ambient (ambientOf in atmosphere.ts): the cosine-weighted mean sky
// radiance over the upper hemisphere, summed in a fixed order, and the
// ground's radiance from it and the sun.
const AMBIENT_N = ${AMBIENT_AZ * AMBIENT_EL}u;
var<workgroup> ambientAcc: array<vec3f, AMBIENT_N>;

@compute @workgroup_size(${AMBIENT_AZ * AMBIENT_EL}) fn csAmbient(@builtin(local_invocation_index) li: u32) {
  let u = (f32(li / ${AMBIENT_AZ}u) + 0.5) / ${f(AMBIENT_EL)};
  let phi = 2.0 * ATMO_PI * (f32(li % ${AMBIENT_AZ}u) + 0.5) / ${f(AMBIENT_AZ)};
  let sinT = sqrt(u);
  let dir = vec3f(sinT * cos(phi), sqrt(1.0 - u), sinT * sin(phi));
  ambientAcc[li] = textureSampleLevel(skyViewLut, lutSampler, skyViewUv(dir, atmo.sun, atmo.eyeHeight), 0.0).rgb;
  workgroupBarrier();
  if (li != 0u) { return; }
  var s = vec3f(0.0);
  for (var k = 0u; k < AMBIENT_N; k++) { s += ambientAcc[k] / f32(AMBIENT_N); }
  let hEye = max(atmo.eyeHeight, 1e-4);
  let lit = select(1.0, 0.0, distanceToGround(hEye, atmo.sun.y) >= 0.0);
  let sunColor = lit * sampleTransmittance(hEye, atmo.sun.y) * atmo.sunIlluminance / ATMO_PI;
  ambientOut[0] = vec4f(s, 0.0);
  ambientOut[1] = vec4f(atmo.groundAlbedo * (sunColor * max(atmo.sun.y, 0.0) + s), 0.0);
  let I = meteredIlluminance(s, ambientOut[1].rgb, sunColor);
  ambientOut[2] = vec4f(adaptedExposure(I, atmo.sunIlluminance, atmo.exposure, atmo.adaptation, atmo.adaptRef), I, 0.0, 0.0);
}

const LUMA = vec3f(0.2126, 0.7152, 0.0722);
fn meteredIlluminance(sky: vec3f, ground: vec3f, sunColor: vec3f) -> f32 {
  return dot(sunColor / 4.0 + (sky + ground) / 2.0, LUMA);
}
fn adaptedExposure(I: f32, sunIlluminance: vec3f, exposure: f32, adaptation: f32, adaptRef: f32) -> f32 {
  let ratio = adaptRef * dot(sunIlluminance, LUMA) / max(I, 1e-12);
  return exposure * clamp(pow(ratio, adaptation), 1.0 / ADAPT_MAX, ADAPT_MAX);
}
`;

/** Bytes of Atmosphere.ambient; the adapted exposure is the f32 at ADAPTED_EXPOSURE_OFFSET. */
export const AMBIENT_BYTES = 48;
export const ADAPTED_EXPOSURE_OFFSET = 32;

export const LUT_FORMAT: GPUTextureFormat = 'rgba16float';

/** The three LUTs and their passes. The sky view is what the scene shader reads. */
export class Atmosphere {
  readonly transmittance: GPUTexture;
  readonly multi: GPUTexture;
  readonly skyView: GPUTexture;
  readonly sampler: GPUSampler;
  private readonly uniform: GPUBuffer;
  private readonly data = new DataView(new ArrayBuffer(Atmo.size));
  /** Sky irradiance / pi, ground radiance and (x) the adapted exposure (vec4f each), for the scene shader and post.ts. */
  readonly ambient: GPUBuffer;
  private readonly pipes: Record<'t' | 'm' | 's' | 'a', GPUComputePipeline>;
  private readonly binds: Record<'t' | 'm' | 's' | 'a', GPUBindGroup>;
  private staticKey = '';

  constructor(private readonly device: GPUDevice) {
    const tex = (size: [number, number], label: string) => device.createTexture({ size, format: LUT_FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC, label });
    this.transmittance = tex(TRANSMITTANCE_SIZE, 'atmosphere transmittance');
    this.multi = tex(MULTI_SIZE, 'atmosphere multiple scattering');
    this.skyView = tex(SKY_VIEW_SIZE, 'atmosphere sky view');
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.uniform = device.createBuffer({ size: Atmo.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'atmosphere' });
    this.ambient = device.createBuffer({ size: AMBIENT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'atmosphere ambient' });
    const module = device.createShaderModule({ code: ATMOSPHERE_WGSL, label: 'atmosphere' });
    const pipe = (entryPoint: string) => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.pipes = { t: pipe('csTransmittance'), m: pipe('csMulti'), s: pipe('csSkyView'), a: pipe('csAmbient') };
    // Auto layouts keep only the bindings each entry point uses.
    const bind = (p: GPUComputePipeline, out: GPUBindingResource, outBinding: number, reads: Array<[number, GPUTexture]>) => device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        ...(reads.length ? [{ binding: 1, resource: this.sampler }] : []),
        ...reads.map(([binding, t]) => ({ binding, resource: t.createView() })),
        { binding: outBinding, resource: out },
      ],
    });
    this.binds = {
      t: bind(this.pipes.t, this.transmittance.createView(), 4, []),
      // march() names the multiple-scattering LUT even on the path that writes it; the sky view stands in (unread there).
      m: bind(this.pipes.m, this.multi.createView(), 4, [[2, this.transmittance], [3, this.skyView]]),
      s: bind(this.pipes.s, this.skyView.createView(), 4, [[2, this.transmittance], [3, this.multi]]),
      a: bind(this.pipes.a, { buffer: this.ambient }, 6, [[2, this.transmittance], [5, this.skyView]]),
    };
  }

  /**
   * Write the uniforms and encode the LUT passes: transmittance and multiple
   * scattering only when the atmosphere changed. exposure, adaptation: see
   * adaptedExposure.
   */
  encode(cp: GPUComputePassEncoder, a: AtmosphereParams, sun: V3, eyeHeightKm: number, exposure = 1, adaptation = 0): void {
    writeStruct(this.data, Atmo, 0, {
      sun, eyeHeight: eyeHeightKm, sunIlluminance: a.sunIlluminance, mieExt: mieExtinction(a),
      groundAlbedo: a.groundAlbedo, mieAlbedo: a.mieAlbedo, mieG: a.mieG, exposure, adaptation, adaptRef: ADAPT_REF,
    });
    this.device.queue.writeBuffer(this.uniform, 0, this.data);
    const key = JSON.stringify([a.visibility, a.mieAlbedo, a.groundAlbedo]);
    const run = (k: 't' | 'm' | 's' | 'a', [w, h]: [number, number]) => {
      cp.setPipeline(this.pipes[k]);
      cp.setBindGroup(0, this.binds[k]);
      cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    };
    if (key !== this.staticKey) {
      run('t', TRANSMITTANCE_SIZE);
      run('m', MULTI_SIZE);
      this.staticKey = key;
    }
    run('s', SKY_VIEW_SIZE);
    run('a', [8, 8]); // one workgroup
  }

  destroy(): void {
    for (const t of [this.transmittance, this.multi, this.skyView]) t.destroy();
    this.uniform.destroy();
    this.ambient.destroy();
  }
}
