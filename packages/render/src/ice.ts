// Ice (surface kind 'ice', surface.ts): a clear, slightly blue block you see
// through, drawn after the opaque scene in its own list (cull.ts
// SEG.boxIce) and its own pass. Per pixel, all analytic in the box's frame:
//
// 1. Fresnel (exact dielectric, n = ior) splits the view ray at the face:
//    the reflected part is the look's environment and the sun's highlight.
// 2. The refracted part is traced through the box: each exit is a ray-box
//    hit (iceExit); where the angle is past the critical one (49.8 deg for
//    ice) it reflects inside (total internal reflection) and goes on, up to
//    `bounces` times. That is what makes a cube of ice show its other faces,
//    bright internal edges and a bent view of what is behind it.
// 3. What the ray sees when it leaves is the opaque scene behind the ice:
//    the scene pass resolved before the ice was drawn (the renderer's
//    `under` texture), read where the exit ray points a little way past the
//    exit point (screen-space refraction); off screen, the environment.
// 4. Beer-Lambert absorption over the exact length the ray ran inside
//    (red absorbed most: thick ice goes blue-green), plus single scattering
//    from a cloudy core (a few samples of a 3D noise along the first leg)
//    and air bubbles (exact ray-sphere hits, walked cell by cell along the
//    first leg, Amanatides-Woo), lit by the sky and the sun.
// 5. Glints: a sparse grid of tiny facets on each face, each with its own
//    tilt, that flash when the sun's half vector lines up with one; faded
//    to nothing once a facet is under a pixel, so distant ice does not
//    shimmer.
// 6. Cracks (surface.ts crack level, origin and seed): planes through the
//    impact point with jagged edges, more and larger as the level rises.
//    Where the ray inside crosses one, the air gap reflects (cracks in ice
//    are silver-white) and passes less light; where one meets the face, a
//    frosted line. From level 4 the impact point is crushed white.
//
// Alternatives considered (docs/render/ice.md has the measurements):
// - Opaque ice in the scene pass (environment refraction only): no new pass,
//   but nothing shows through, and seeing the tower through the ice is
//   most of what reads as ice. Kept as the off-screen fallback.
// - Ray-traced or depth-peeled refraction: correct ice-behind-ice, at the
//   cost of a second ice layer (two more depth passes); here ice seen
//   through ice shows what is behind both. Revisit if ice walls look flat.
// - Real Voronoi prefracture meshes: the engines collide boxes and spheres
//   only, so pieces would have to be boxes anyway; the cracks here are
//   drawn, and a shatter splits a block into boxes (game rules).
// - Transparent (blended) ice without refraction: cheaper still, but reads
//   as tinted glass, and blending needs back-to-front order.
import { defineStruct, wgslStruct } from '@tb/schema';
import { SURFACE_WGSL } from './surface.ts';
import type { V3 } from './math.ts';

export interface IceParams {
  /** Index of refraction (ice: 1.31; glass 1.5). */
  ior: number;
  /** Absorption of red light, per metre; green and blue absorb ICE_SPECTRUM of it. */
  absorb: number;
  /** Scattering in the cloudy core, per metre (0: clear right through). */
  cloud: number;
  /** Air bubbles, 0 (none) to 1 (milky with them). */
  bubbles: number;
  /** Glint strength (0: none). */
  glint: number;
  /** Glint facet size, metres. */
  glintSize: number;
  /** Surface roughness (GGX alpha's square root): 0 a polished face, 0.3 frosted. */
  frost: number;
  /** How far past the exit point the background is read, in the box's half diagonals. */
  depth: number;
  /** Internal reflections a ray may take before it is given up on (0 to 4). */
  bounces: number;
  /** Crack visibility (0: cracks not drawn). */
  crack: number;
  /** Blur of what is seen through the ice, pixels (a melted, slightly frosted face). */
  blur: number;
  /** White rime along the edges of a face, 0 (none) to 1. */
  rime: number;
}

/** Green and blue absorption as shares of red's: ice's own spectrum, roughly (it absorbs red about 10x as much as blue). */
export const ICE_SPECTRUM: V3 = [1, 0.3, 0.1];

export const DEFAULT_ICE: IceParams = {
  ior: 1.31, absorb: 0.5, cloud: 0.8, bubbles: 0.1, glint: 2, glintSize: 0.025, frost: 0.12, depth: 1, bounces: 2, crack: 1, blur: 2, rime: 0.2,
};

/** URL knobs ice.<key>: each IceParams field with its accepted range. */
export const ICE_KNOBS: Record<keyof IceParams, { min: number; max: number; int?: true }> = {
  ior: { min: 1, max: 2.5 }, absorb: { min: 0, max: 20 }, cloud: { min: 0, max: 20 }, bubbles: { min: 0, max: 1 },
  glint: { min: 0, max: 10 }, glintSize: { min: 0.002, max: 0.1 }, frost: { min: 0, max: 1 }, depth: { min: 0, max: 10 },
  bounces: { min: 0, max: 4, int: true }, crack: { min: 0, max: 4 }, blur: { min: 0, max: 16 }, rime: { min: 0, max: 1 },
};

/** From URL keys ice.<knob> (ICE_KNOBS), absent ones at DEFAULT_ICE. Refuses unknown knobs and values outside their range. */
export function parseIceOptions(q: URLSearchParams): IceParams {
  const params = { ...DEFAULT_ICE };
  for (const key of q.keys()) {
    if (!key.startsWith('ice.')) continue;
    const k = key.slice(4) as keyof IceParams;
    const range = ICE_KNOBS[k];
    if (!range) throw new Error(`${key} is not an ice knob (one of ${Object.keys(ICE_KNOBS).join(', ')})`);
    const raw = q.get(key)!, v = raw.trim() === '' ? NaN : Number(raw);
    if (!(v >= range.min && v <= range.max) || (range.int && !Number.isInteger(v))) throw new Error(`${key} must be ${range.int ? 'a whole number' : 'a number'} from ${range.min} to ${range.max}: ${raw}`);
    params[k] = v;
  }
  return params;
}

/** The URL keys for p that differ from the defaults, as parseIceOptions reads them back. */
export function writeIceOptions(p: IceParams, q: URLSearchParams): void {
  for (const k of Object.keys(ICE_KNOBS) as (keyof IceParams)[]) if (p[k] !== DEFAULT_ICE[k]) q.set(`ice.${k}`, String(p[k]));
}

export const IceFrame = defineStruct('IceFrame', [
  ['absorb', 'vec3f', 'per world unit, rgb'], ['ior', 'f32'],
  ['cloud', 'f32', 'per world unit'], ['bubbles', 'f32'], ['glint', 'f32'], ['glintCell', 'f32', 'world units'],
  ['frost', 'f32'], ['depth', 'f32'], ['bounces', 'u32'], ['crack', 'f32'],
  ['blur', 'f32', 'pixels'], ['rime', 'f32'],
], 'Per-frame uniforms of the ice pass (ice.ts).');

/** IceFrame values for params p in a world of `metres` per unit. */
export function iceUniforms(p: IceParams, metres = 1): Record<string, number | number[]> {
  return {
    absorb: ICE_SPECTRUM.map((s) => s * p.absorb * metres), ior: p.ior, cloud: p.cloud * metres, bubbles: p.bubbles,
    glint: p.glint, glintCell: p.glintSize / metres, frost: p.frost, depth: p.depth, bounces: Math.round(p.bounces), crack: p.crack,
    blur: p.blur, rime: p.rime,
  };
}

// ---------------------------------------------------------------- CPU twins (tests)

/** Unpolarized Fresnel reflectance at a dielectric boundary: cos of the incidence angle, eta = n(transmitted side) / n(incident side). 1 past the critical angle. */
export function fresnelDielectric(cosi: number, eta: number): number {
  const c = Math.abs(cosi), g2 = eta * eta - 1 + c * c;
  if (g2 < 0) return 1;
  const g = Math.sqrt(g2), a = (g - c) / (g + c), b = (c * (g + c) - 1) / (c * (g - c) + 1);
  return 0.5 * a * a * (1 + b * b);
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** GLSL/WGSL refract: incident i, normal n facing against it, eta = n1 / n2; [0, 0, 0] past the critical angle. */
export function refractRay(i: V3, n: V3, eta: number): V3 {
  const c = dot(n, i), k = 1 - eta * eta * (1 - c * c);
  if (k < 0) return [0, 0, 0];
  const s = eta * c + Math.sqrt(k);
  return [eta * i[0] - s * n[0], eta * i[1] - s * n[1], eta * i[2] - s * n[2]];
}

/** Distance along unit d from p, inside the box of half extents h, to the box's surface, and the axis it leaves by. */
export function iceExit(p: V3, d: V3, h: V3): { s: number; axis: number } {
  let s = Infinity, axis = 0;
  for (let k = 0; k < 3; k++) {
    const dk = Math.abs(d[k]!) < 1e-8 ? (d[k]! < 0 ? -1e-8 : 1e-8) : d[k]!;
    const t = ((dk > 0 ? h[k]! : -h[k]!) - p[k]!) / dk;
    if (t < s) { s = t; axis = k; }
  }
  return { s: Math.max(s, 0), axis };
}

export interface IcePath {
  /** Where the ray left (or was given up on), body frame. */
  p: V3;
  /** Direction it left in (outside the ice); inside, when trapped. */
  d: V3;
  /** Length inside the ice. */
  len: number;
  /** Length of the first leg (entry to first exit face). */
  first: number;
  /** Share of the light the exit lets out (1 - Fresnel at the face it leaves by); 0.5 when trapped. */
  t: number;
  /** Internal reflections taken. */
  bounces: number;
  /** Whether it left the ice. */
  escaped: boolean;
  /** Axis of the face it left by. */
  axis: number;
}

/**
 * The refracted ray's path through the box: from p0 (on its surface) in direction d0 (unit, already
 * refracted into the ice), leaving where the angle allows and reflecting inside (total internal
 * reflection) where it does not, up to `bounces` times. The CPU twin of icePath in ICE_WGSL.
 */
export function icePath(p0: V3, d0: V3, h: V3, ior: number, bounces: number): IcePath {
  let p: V3 = [...p0], d: V3 = [...d0], len = 0, first = 0, axis = 0;
  for (let k = 0; k <= bounces; k++) {
    const e = iceExit(p, d, h);
    p = [p[0] + d[0] * e.s, p[1] + d[1] * e.s, p[2] + d[2] * e.s];
    len += e.s;
    if (k === 0) first = e.s;
    axis = e.axis;
    const n: V3 = [0, 0, 0];
    n[axis] = d[axis]! < 0 ? -1 : 1;
    const c = dot(d, n);
    const r = refractRay(d, [-n[0], -n[1], -n[2]], ior);
    if (dot(r, r) > 0) return { p, d: r, len, first, t: 1 - fresnelDielectric(c, 1 / ior), bounces: k, escaped: true, axis };
    d = [d[0] - 2 * c * n[0], d[1] - 2 * c * n[1], d[2] - 2 * c * n[2]];
  }
  return { p, d, len, first, t: 0.5, bounces, escaped: false, axis };
}

// ---------------------------------------------------------------- WGSL

/** Ray-box exit, Fresnel and the TIR path: the parts tests compare with the CPU twins. */
export const ICE_PATH_WGSL = /* wgsl */ `
fn fresnelDielectric(cosi: f32, eta: f32) -> f32 {
  let c = abs(cosi);
  let g2 = eta * eta - 1.0 + c * c;
  if (g2 < 0.0) { return 1.0; }
  let g = sqrt(g2);
  let a = (g - c) / (g + c);
  let b = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return 0.5 * a * a * (1.0 + b * b);
}

// Distance along unit d from p (inside the box of half extents h) to its surface (x) and the axis it leaves by (y).
fn iceExit(p: vec3f, d: vec3f, h: vec3f) -> vec2f {
  let dd = select(d, select(vec3f(1e-8), vec3f(-1e-8), d < vec3f(0.0)), abs(d) < vec3f(1e-8));
  let t = (select(-h, h, dd > vec3f(0.0)) - p) / dd;
  var s = t.x;
  var axis = 0.0;
  if (t.y < s) { s = t.y; axis = 1.0; }
  if (t.z < s) { s = t.z; axis = 2.0; }
  return vec2f(max(s, 0.0), axis);
}

struct IcePathOut { p: vec3f, len: f32, d: vec3f, first: f32, t: f32, bounces: u32, escaped: bool, axis: u32 }

fn icePath(p0: vec3f, d0: vec3f, h: vec3f, ior: f32, bounces: u32) -> IcePathOut {
  var o: IcePathOut;
  o.p = p0;
  o.d = d0;
  o.len = 0.0;
  o.first = 0.0;
  o.t = 0.5;
  o.bounces = bounces;
  o.escaped = false;
  o.axis = 0u;
  for (var k = 0u; k <= bounces; k++) {
    let e = iceExit(o.p, o.d, h);
    o.p += o.d * e.x;
    o.len += e.x;
    if (k == 0u) { o.first = e.x; }
    let axis = u32(e.y);
    o.axis = axis;
    var n = vec3f(0.0);
    n[axis] = select(1.0, -1.0, o.d[axis] < 0.0);
    let c = dot(o.d, n);
    let r = refract(o.d, -n, ior);
    if (dot(r, r) > 0.0) {
      o.t = 1.0 - fresnelDielectric(c, 1.0 / ior);
      o.d = r;
      o.bounces = k;
      o.escaped = true;
      return o;
    }
    o.d = o.d - 2.0 * c * n;
  }
  return o;
}
`;

/**
 * The ice pass's WGSL, appended to the scene module (sceneWgsl): it uses
 * the scene's Frame, records, fx, env, fog and shadow functions. `real`
 * picks the real look's sun shadow and ambient.
 */
export function iceWgsl(real: boolean): string {
  const sunVis = real ? 'shadowSoft(rel, n) * sunVis' : 'shadow(rel, n)';
  const ambient = real ? 'atmoAmbient[0].rgb + 0.5 * atmoAmbient[1].rgb' : '0.6 * fr.ambSky + 0.4 * fr.ambGround';
  return /* wgsl */ `
${wgslStruct(IceFrame)}
${SURFACE_WGSL}
${ICE_PATH_WGSL}
@group(2) @binding(0) var<uniform> ice: IceFrame;
@group(2) @binding(1) var iceUnder: texture_2d<f32>;  // the opaque scene, resolved before the ice pass
@group(2) @binding(2) var iceSamp: sampler;
@group(2) @binding(3) var<storage, read> surfaces: array<u32>; // surface.ts, per slot

fn iceHash(p: vec3u) -> vec3u {
  var v = p * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
fn iceU(x: u32) -> f32 { return f32(x) * 2.3283064365386963e-10; }

// Value noise in 3D (trilinear over hashed lattice values), 0..1.
fn iceNoise(p: vec3f, seed: u32) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  var v: array<f32, 8>;
  for (var k = 0u; k < 8u; k++) {
    let o = vec3i(i32(k & 1u), i32((k >> 1u) & 1u), i32((k >> 2u) & 1u));
    v[k] = iceU(iceHash(bitcast<vec3u>(i + o) ^ vec3u(seed, seed * 7u, seed * 13u)).x);
  }
  let x00 = mix(v[0], v[1], u.x); let x10 = mix(v[2], v[3], u.x);
  let x01 = mix(v[4], v[5], u.x); let x11 = mix(v[6], v[7], u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// Scattering density at body point p (box of half extents h): a cloudy core
// (clear ice freezes from the outside in, pushing air to the middle).
// Per world unit.
fn iceCore(p: vec3f, h: vec3f, seed: u32) -> f32 {
  // Each block's core sits off centre by up to a quarter of its size, so a wall is not a grid of tiles.
  let o = vec3f(iceU(iceHash(vec3u(seed, 7u, 3u)).x), iceU(iceHash(vec3u(seed, 11u, 5u)).x), iceU(iceHash(vec3u(seed, 13u, 9u)).x)) - 0.5;
  let r = length((p - 0.5 * o * h) / h) / 1.7320508;
  let core = 1.0 - smoothstep(0.15, 0.75, r + 0.2 * (iceNoise(p * (3.0 / max(h.x, max(h.y, h.z))), seed) - 0.5));
  return core * core;
}

// Air bubbles along the first leg (p0 + d0 t, t in [0, len]): small spheres,
// at most one per cell of a 3D grid (cells 5 glint facets wide), more of
// them in the core, walked cell by cell (Amanatides-Woo) for up to 24 cells.
// A bubble shows as a bright rim (light reflects totally off the inside of
// its wall) round a darker middle; under a pixel it is widened to a pixel
// and dimmed by the same share, so far ice does not sparkle. Returns the
// covered share (x) and the rim light (y), 0..1.
fn iceBubbles(p0: vec3f, d0: vec3f, len: f32, h: vec3f, pxM: f32, seed: u32) -> vec2f {
  if (ice.bubbles <= 0.0) { return vec2f(0.0); }
  let B = 5.0 * ice.glintCell;
  var cell = vec3i(floor(p0 / B));
  let stepI = vec3i(select(vec3i(-1), vec3i(1), d0 > vec3f(0.0)));
  let dd = select(d0, vec3f(1e-8), abs(d0) < vec3f(1e-8));
  let next = (vec3f(cell) + select(vec3f(0.0), vec3f(1.0), d0 > vec3f(0.0))) * B;
  var tMax = (next - p0) / dd;
  let tDelta = abs(B / dd);
  var cover = 0.0;
  var rim = 0.0;
  for (var k = 0; k < 24; k++) {
    let hh = iceHash(bitcast<vec3u>(cell) ^ vec3u(seed * 5u + 3u, 0x85ebca6bu, seed * 11u));
    let centre = (vec3f(cell) + 0.2 + 0.6 * vec3f(iceU(hh.x), iceU(hh.y), iceU(hh.z))) * B;
    let rc = 1.0 - smoothstep(0.15, 0.75, length(centre / h) / 1.7320508);
    let odds = ice.bubbles * (0.08 + 0.6 * rc * rc);
    if (iceU(hh.x ^ hh.y) < odds && all(abs(centre) < h)) {
      let r = B * (0.03 + 0.07 * iceU(hh.z * 2654435761u));
      let t = clamp(dot(centre - p0, d0), 0.0, len);
      let miss = length(p0 + d0 * t - centre);
      let re = sqrt(r * r + 0.5 * pxM * pxM);
      let x = miss / re;
      if (x < 1.0) {
        let share = r * r / (re * re);
        cover = min(1.0, cover + share * 0.6);
        rim = min(1.0, rim + share * (0.25 + 0.75 * smoothstep(0.45, 0.9, x) * (1.0 - smoothstep(0.9, 1.0, x))));
      }
    }
    let tm = min(tMax.x, min(tMax.y, tMax.z));
    if (tm > len) { break; }
    if (tMax.x == tm) { cell.x += stepI.x; tMax.x += tDelta.x; }
    else if (tMax.y == tm) { cell.y += stepI.y; tMax.y += tDelta.y; }
    else { cell.z += stepI.z; tMax.z += tDelta.z; }
  }
  return vec2f(cover, rim);
}

// Sun glints on a face: one facet per cell of a grid on the body's surface,
// one in six cells holds one, each tilted up to 0.1 rad; it flashes when
// the half vector lines up with it within about the sun's disc. Faded out
// once a facet is under a pixel.
fn iceGlint(lp: vec3f, nb: vec3f, Hb: vec3f, pxM: f32, seed: u32) -> f32 {
  let cellM = ice.glintCell;
  if (ice.glint <= 0.0 || cellM <= 0.0) { return 0.0; }
  let fade = 1.0 - smoothstep(0.35 * cellM, 1.2 * cellM, pxM);
  if (fade <= 0.0) { return 0.0; }
  let g = lp / cellM;
  let ci = vec3i(floor(g));
  let h = iceHash(bitcast<vec3u>(ci) ^ vec3u(seed * 3u + 17u, 0x9e3779b9u, seed));
  if (iceU(h.x) > 0.16) { return 0.0; }
  let centre = (vec3f(ci) + vec3f(iceU(h.y), iceU(h.z), iceU(h.x * 747796405u))) * cellM;
  // A round facet of 0.3 cell radius, its edge antialiased over a pixel.
  let dist = length((lp - centre) - nb * dot(lp - centre, nb));
  let spot = 1.0 - smoothstep(0.3 * cellM - 0.5 * pxM, 0.3 * cellM + 0.5 * pxM, dist);
  let t1 = normalize(cross(nb, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(nb.y) > 0.9)));
  let t2 = cross(nb, t1);
  let tilt = (vec2f(iceU(h.y * 2891336453u), iceU(h.z * 2891336453u)) - 0.5) * 0.2;
  let m = normalize(nb + t1 * tilt.x + t2 * tilt.y);
  let c = dot(Hb, m);
  return fade * spot * smoothstep(0.9990, 0.99985, c) * 40.0 * ice.glint;
}

struct Crack { hit: f32, nrm: vec3f, line: f32, crush: f32 }

// Crack planes through the impact point c (body frame): plane j has a
// hashed normal and a jagged extent that grows with the crack level. hit:
// how much the first leg (p0 + d0 t, t in [0, len]) crosses them (0..1);
// nrm: the normal of the strongest crossing; line: a frosted line where a
// plane meets the face at lp; crush: the white crushed patch around c on
// the face from level 4.
fn iceCracks(w: u32, p0: vec3f, d0: vec3f, len: f32, lp: vec3f, h: vec3f, pxM: f32, slot: u32) -> Crack {
  var o = Crack(0.0, vec3f(0.0, 1.0, 0.0), 0.0, 0.0);
  let level = surfaceCrack(w);
  if (level == 0u || ice.crack <= 0.0) { return o; }
  let c = surfaceAt(w) * h;
  let seed = select(slot * 2654435761u, surfaceSeed(w), surfaceSeed(w) != 0u);
  let size = max(h.x, max(h.y, h.z));
  let lv = f32(level) / 7.0;
  let planes = min(level + 1u, 6u);
  var best = 0.0;
  for (var j = 0u; j < planes; j++) {
    let hj = iceHash(vec3u(seed, j, 0x51ed27u));
    let z = iceU(hj.x) * 2.0 - 1.0;
    let a = iceU(hj.y) * 6.2831853;
    let n = vec3f(sqrt(1.0 - z * z) * cos(a), z, sqrt(1.0 - z * z) * sin(a));
    let reach = size * (0.35 + 1.6 * lv) * (0.6 + 0.6 * iceU(hj.z));
    // Inside the crack: |q - c| under the reach, the edge jagged by noise of where along the plane.
    let den = dot(d0, n);
    if (abs(den) > 1e-4) {
      let t = dot(c - p0, n) / den;
      if (t > 0.0 && t < len) {
        let q = p0 + d0 * t;
        let jag = reach * (0.75 + 0.5 * iceNoise((q - c) * (4.0 / size), seed + j));
        let inside = 1.0 - smoothstep(0.85 * jag, jag, length(q - c));
        let wgt = inside * (0.45 + 0.55 * (1.0 - abs(den)));
        o.hit = min(1.0, o.hit + wgt);
        if (wgt > best) { best = wgt; o.nrm = n * sign(-den); }
      }
    }
    let ds = abs(dot(lp - c, n));
    let jagS = reach * (0.75 + 0.5 * iceNoise((lp - c) * (4.0 / size), seed + j));
    let wM = 0.6 * pxM + size * 0.004 * (0.5 + lv);
    let onFace = (1.0 - smoothstep(0.85 * jagS, jagS, length(lp - c)));
    o.line = max(o.line, onFace * (1.0 - smoothstep(0.5 * wM, wM, ds)) * (0.7 + 0.3 * iceNoise(lp * (60.0 / size), seed + 7u * j)));
  }
  // From level 3 a ring crack round the impact point (a cone crack meeting the face), from 4 the point crushed white.
  let dc = length(lp - c);
  if (level >= 3u) {
    let rho = size * (0.12 + 0.3 * lv) * (0.85 + 0.3 * iceNoise(lp * (6.0 / size), seed + 55u));
    let wR = 0.6 * pxM + size * 0.003;
    o.line = max(o.line, (1.0 - smoothstep(0.5 * wR, wR, abs(dc - rho))) * 0.8);
  }
  if (level >= 4u) {
    let r = size * (0.05 + 0.14 * (lv - 0.5)) * (0.75 + 0.5 * iceNoise(lp * (12.0 / size), seed + 99u));
    let grain = smoothstep(0.3, 0.6, iceNoise(lp * (70.0 / size), seed + 13u));
    o.crush = (1.0 - smoothstep(0.5 * r, r, dc)) * mix(grain, 1.0, 1.0 - smoothstep(0.0, 0.5 * r, dc));
  }
  o.hit *= min(ice.crack, 1.0);
  o.line *= min(ice.crack, 1.0);
  o.crush *= min(ice.crack, 1.0);
  return o;
}

fn iceAmbient() -> vec3f { return ${ambient}; }

// The opaque scene behind the ice, minus the fog in front of it (the caller adds the fog once):
// what arrives at the ice along world direction dw from the camera-relative exit point e.
fn iceBehind(e: vec3f, dw: vec3f, reach: f32, fog0: vec3f, rel: vec3f) -> vec3f {
  let far = fog(env(dw, 0.0), rel) - fog0;
  let aim = e + dw * reach;
  let clip = fr.viewProj * vec4f(aim, 1.0);
  if (clip.w <= 1e-4) { return max(far, vec3f(0.0)); }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  let on = smoothstep(0.0, 0.03, edge);
  // Four taps in a rotated square, ice.blur pixels out: what is seen through is a little soft.
  let px = ice.blur / fr.viewport;
  var under = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let o = array<vec2f, 4>(vec2f(0.5, 1.0), vec2f(-1.0, 0.5), vec2f(-0.5, -1.0), vec2f(1.0, -0.5))[k];
    under += textureSampleLevel(iceUnder, iceSamp, clamp(uv + o * px, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  }
  under = under * 0.25 - fog0;
  return max(mix(far, under, on), vec3f(0.0));
}

@fragment fn fsIce(v: VOut) -> @location(0) vec4f {
  ${real ? 'fragPx = v.clip.xy;' : ''}
  let lp = clamp(v.local, vec3f(-1.0), vec3f(1.0)) * v.half;
  let pxM = length(fwidth(lp));
  let faceN = boxFace(v.local, fwidth(v.local));
  let nb = bevelNormal(lp, faceN, v.half, pxM, fr.bevel);
  let n = qrot(v.rot, nb);
  let rel = v.rel;
  let V = normalize(-rel);
  let inv = vec4f(-v.rot.xyz, v.rot.w);
  let Vb = qrot(inv, V);
  let Lb = qrot(inv, fr.sun);
  let w = fx[v.slot];
  let sw = surfaces[v.slot];
  let seed = select(v.slot * 2654435761u, surfaceSeed(sw), surfaceSeed(sw) != 0u);
  let NoV = max(dot(nb, Vb), 1e-4);
  let NoL = max(dot(n, fr.sun), 0.0);
  let vis = select(0.0, ${sunVis}, NoL > 0.0);
  // Sun reaching the inside of the ice: not gated by the entry face (light enters by the lit faces and
  // scatters), and only partly blocked by occluders, which are mostly ice that passes light.
  let visIn = mix(${sunVis}, 1.0, 0.6);
  let fog0 = fog(vec3f(0.0), rel);

  // 1. Reflection: environment and sun, through exact Fresnel.
  let Fin = fresnelDielectric(NoV, ice.ior);
  let a = max(ice.frost * ice.frost, 0.0004);
  let R = reflect(-V, n);
  let H = normalize(fr.sun + V);
  let spec = ggx(max(dot(n, H), 0.0), max(a, 0.002)) * smithVis(NoV, NoL, max(a, 0.002)) * fresnelDielectric(max(dot(V, H), 0.0), ice.ior) * PI * NoL;
  var c = env(R, ice.frost) * Fin + fr.sunColor * spec * vis;

  // 2. Into the ice, and through it.
  let d0 = refract(-Vb, nb, 1.0 / ice.ior);
  let path = icePath(lp, d0, v.half, ice.ior, ice.bounces);
  let cr = iceCracks(sw, lp, d0, path.first, lp, v.half, pxM, v.slot);

  // 4. Scattering along the first leg (4 samples of the core), lit by sky and sun; bubbles on it.
  let ds = path.first / 4.0;
  var tau = 0.0;
  var scat = 0.0;
  for (var k = 0; k < 4; k++) {
    let q = lp + d0 * ((f32(k) + 0.5) * ds);
    let sg = (ice.cloud * iceCore(q, v.half, seed) + 0.02 * ice.cloud) * ds;
    scat += sg * exp(-tau);
    tau += sg;
  }
  let bub = iceBubbles(lp, d0, path.first, v.half, pxM, seed);
  // The rest of the path scatters as the core does on average.
  tau += 0.5 * ice.cloud * max(path.len - path.first, 0.0);
  let cosVL = dot(d0, Lb);
  let g = 0.6;
  let phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosVL, 1.5) * 0.25;
  let tint = fxTint(w.x);
  let absorb = exp(-ice.absorb * path.len);
  let lightIn = iceAmbient() + fr.sunColor * visIn * phase * 4.0;
  let inscat = scat * lightIn * mix(vec3f(1.0), sqrt(absorb), 0.5) * tint;

  // 3. What the exit sees.
  let pe = v.rel - qrot(v.rot, lp) + qrot(v.rot, path.p);
  let dw = qrot(v.rot, normalize(path.d));
  var behind = iceBehind(pe, dw, ice.depth * length(v.half), fog0, rel);
  // The exit face's edges: the far edges of the cube, seen through it.
  var d3 = v.half - abs(path.p);
  d3[path.axis] = 1e9;
  let edgeM = min(d3.x, min(d3.y, d3.z));
  let edgeLine = 1.0 - smoothstep(0.004 * length(v.half) + pxM, 0.012 * length(v.half) + 2.0 * pxM, edgeM);
  behind *= 1.0 - 0.35 * edgeLine;
  let crackPass = (1.0 - 0.55 * cr.hit) * (1.0 - 0.5 * bub.x);
  let trans = behind * absorb * exp(-tau) * path.t * crackPass * tint;

  // Cracks: the air gap reflects the sky (and the sun) back toward the eye.
  let crR = reflect(d0, cr.nrm);
  let crW = qrot(v.rot, crR);
  let crackLight = cr.hit * (0.6 * env(crW, 0.15) + fr.sunColor * vis * pow(max(dot(crR, Lb), 0.0), 24.0) * 2.0 + 0.3 * iceAmbient());

  // Light from the ice itself (reflections, scattering, cracks, glints) is fogged here; what is behind
  // the ice already carries the fog in front of the ice (iceBehind), so it is added after.
  let bubbleLight = bub.y * (1.2 * iceAmbient() + fr.sunColor * visIn * 0.6) * tint;
  c += (1.0 - Fin) * (inscat + crackLight * tint + bubbleLight);
  // Frosted lines where cracks meet the face, and the crushed patch: opaque white ice.
  let frosted = (iceAmbient() * 0.9 + fr.sunColor * visIn * (0.3 + 0.7 * max(dot(n, fr.sun), 0.0)) * 0.45) * tint;
  // Rime: the face's edges, where the block has melted and refrozen, scatter white.
  let e3 = v.half - abs(lp);
  let entryEdge = max(min(e3.x, e3.y), min(max(e3.x, e3.y), e3.z));
  let rime = ice.rime * (1.0 - smoothstep(0.0, 0.07 * length(v.half), entryEdge)) * (0.6 + 0.4 * iceNoise(lp * (20.0 / length(v.half)), seed + 31u)) * smoothstep(0.25, 0.75, iceNoise(lp * (3.0 / length(v.half)), seed + 57u));
  let m = clamp(max(max(0.75 * cr.line, 0.9 * cr.crush), rime), 0.0, 1.0);
  c = mix(c, frosted, m);
  // 5. Glints.
  let Hb = normalize(Vb + Lb);
  c += fr.sunColor * vis * iceGlint(lp, faceN, Hb, pxM, seed);
  c += tint * fxGlow(w, fr.time) * 0.3;
  return vec4f(fog(c, rel) + (1.0 - m) * (1.0 - Fin) * trans, 1.0);
}
`;
}
