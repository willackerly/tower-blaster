// Tone maps and film grain for the final composite (post.ts), with CPU twins
// that tests compare the GPU with (realism step 7, docs/render/polish.md).
//
// Every operator maps linear scene colour (after exposure) to display-encoded
// colour in 0..1, as agx (look.ts) does. AgX stays the default and the only
// one the stylized looks use; the others are A/B options of the real look
// (RealOptions.toneMap). Each alternative is fed through a gain (TONE_GAIN)
// that puts mid grey at the display value AgX gives it, so an A/B compares
// the curves' toes, shoulders and colour handling, not their brightness.
import { agx, linearToSrgb, TONE_MAPS, type ToneMap } from './look.ts';
import type { V3 } from './math.ts';
import { pcg3d } from './noise.ts';

const LUMA: V3 = [0.2126, 0.7152, 0.0722];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// AgX without the look (same inset, log encoding, contrast fit and outset as agx in look.ts).
const AGX_IN = [0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104];
const AGX_OUT = [1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116];
const MIN_EV = -12.47393, MAX_EV = 4.026069;
const colMajor = (m: number[], v: V3): V3 => [0, 1, 2].map((r) => m[r]! * v[0] + m[3 + r]! * v[1] + m[6 + r]! * v[2]) as V3;
const contrast = (x: number) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

/** AgX base (no look): linear scene colour to display-encoded colour. */
export function agxBase(c: V3): V3 {
  const v = colMajor(AGX_IN, c).map((x) => contrast((Math.min(MAX_EV, Math.max(MIN_EV, Math.log2(Math.max(x, 1e-10)))) - MIN_EV) / (MAX_EV - MIN_EV))) as V3;
  return colMajor(AGX_OUT, v).map(clamp01) as V3;
}

/**
 * Khronos PBR Neutral (2024): hue- and saturation-preserving below a
 * compression start of 0.76, a smooth shoulder above it that desaturates
 * toward white. Its output is linear; this returns it sRGB-encoded.
 */
export function pbrNeutral(c: V3): V3 {
  const start = 0.8 - 0.04, desat = 0.15;
  const x = Math.min(c[0], c[1], c[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let v = c.map((k) => k - offset) as V3;
  const peak = Math.max(v[0], v[1], v[2]);
  if (peak >= start) {
    const d = 1 - start;
    const newPeak = 1 - (d * d) / (peak + d - start);
    v = v.map((k) => (k * newPeak) / peak) as V3;
    const g = 1 - 1 / (desat * (peak - newPeak) + 1);
    v = v.map((k) => k + (newPeak - k) * g) as V3;
  }
  return v.map((k) => clamp01(linearToSrgb(clamp01(k)))) as V3;
}

// ACES: Stephen Hill's fit of the RRT and sRGB ODT, rows of the input (sRGB to RRT_SAT(AP1)) and output matrices.
const ACES_IN: [V3, V3, V3] = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const ACES_OUT: [V3, V3, V3] = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const rrtOdt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);

/** ACES (Hill's fit): linear scene colour to display-encoded colour. */
export function aces(c: V3): V3 {
  const a = ACES_IN.map((r) => rrtOdt(dot(r, c))) as V3;
  return ACES_OUT.map((r) => clamp01(linearToSrgb(clamp01(dot(r, a))))) as V3;
}

const OPS: Record<ToneMap, (c: V3) => V3> = { agx, 'agx-base': agxBase, neutral: pbrNeutral, aces };

/** Mid grey (linear 0.18). */
export const MID_GREY = 0.18;

/** The gain before op that puts mid grey at AgX's display value (bisection on the monotone grey curve). */
function midGreyGain(op: ToneMap): number {
  if (op === 'agx') return 1;
  const want = dot(agx([MID_GREY, MID_GREY, MID_GREY]), LUMA);
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 60; i++) {
    const k = Math.sqrt(lo * hi);
    const y = dot(OPS[op]([k * MID_GREY, k * MID_GREY, k * MID_GREY]), LUMA);
    if (y < want) lo = k; else hi = k;
  }
  return Math.sqrt(lo * hi);
}

/** Per operator, the gain applied before it so mid grey matches AgX's (1 for agx). */
export const TONE_GAIN: Record<ToneMap, number> = Object.fromEntries(TONE_MAPS.map((op) => [op, midGreyGain(op)])) as Record<ToneMap, number>;

/** Linear scene colour (after exposure) to display-encoded colour with operator op, its mid-grey gain included. */
export function toneMapped(op: ToneMap, c: V3): V3 {
  if (op === 'agx') return agx(c);
  const k = TONE_GAIN[op];
  return OPS[op]([c[0] * k, c[1] * k, c[2] * k]);
}

const f = (x: number) => x.toPrecision(17).replace(/0+$/, '').replace(/\.$/, '.0');
const row = (r: V3) => `vec3f(${r.map(f).join(', ')})`;

/** WGSL twins: agxBase, pbrNeutral, aces and toneMapAlt(op, c) for op 1..3 (TONE_MAPS index). Needs agx (AGX_WGSL) only for op 0, which callers keep themselves. */
export const TONE_WGSL = /* wgsl */ `
fn srgbEncode(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return clamp(select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308)), vec3f(0.0), vec3f(1.0));
}

fn agxBase(c: vec3f) -> vec3f {
  let inset = mat3x3f(${AGX_IN.map(f).join(', ')});
  let outset = mat3x3f(${AGX_OUT.map(f).join(', ')});
  var v = clamp(log2(max(inset * c, vec3f(1e-10))), vec3f(${MIN_EV}), vec3f(${MAX_EV}));
  v = (v - ${MIN_EV}) / (${MAX_EV} - ${MIN_EV});
  let x2 = v * v;
  let x4 = x2 * x2;
  v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232;
  return clamp(outset * v, vec3f(0.0), vec3f(1.0));
}

fn pbrNeutral(c: vec3f) -> vec3f {
  let start = 0.76;
  let x = min(c.r, min(c.g, c.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var v = c - offset;
  let peak = max(v.r, max(v.g, v.b));
  if (peak >= start) {
    let d = 1.0 - start;
    let newPeak = 1.0 - d * d / (peak + d - start);
    v *= newPeak / peak;
    let g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
    v = mix(v, vec3f(newPeak), g);
  }
  return srgbEncode(v);
}

fn rrtOdt(v: vec3f) -> vec3f {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

fn aces(c: vec3f) -> vec3f {
  let a = rrtOdt(vec3f(dot(${row(ACES_IN[0])}, c), dot(${row(ACES_IN[1])}, c), dot(${row(ACES_IN[2])}, c)));
  return srgbEncode(vec3f(dot(${row(ACES_OUT[0])}, a), dot(${row(ACES_OUT[1])}, a), dot(${row(ACES_OUT[2])}, a)));
}

fn toneMapAlt(op: u32, c: vec3f) -> vec3f {
  switch op {
    case 1u: { return agxBase(c); }
    case 2u: { return pbrNeutral(c); }
    default: { return aces(c); }
  }
}
`;

// ---------------------------------------------------------------- grain

/** The grain's lattice spacing in pixels for size (pixels at 1080 lines) in a frame `height` pixels tall (at least 1). */
export function grainPixels(size: number, height: number): number {
  return Math.max(1, (size * height) / 1080);
}

/** Relative grain (standard deviation over the signal) at mid grey for grain amount 1. */
export const GRAIN_MID = 0.1;
/** Below this luminance the relative grain stops growing (4x mid grey's), so blacks do not boil. */
export const GRAIN_FLOOR = MID_GREY / 16;

/**
 * Unit-variance grain at a pixel (integer coordinates) for frame seed and
 * grain size (pixels): hashed lattice values (triangular, from two uniforms)
 * every `size` pixels, interpolated bilinearly and divided by the root of the
 * sum of the squared weights, so every pixel has variance 1 whatever its
 * place between lattice points (no grid shows in the grain's strength).
 */
export function grainNoise(px: number, py: number, seed: number, size: number): number {
  const s = Math.max(size, 1);
  const x = (px + 0.5) / s - 0.5, y = (py + 0.5) / s - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const val = (i: number, j: number) => {
    const h = pcg3d(i >>> 0, j >>> 0, seed >>> 0);
    return ((h[0] + h[1]) * 2.3283064365386963e-10 - 1) * Math.sqrt(6);
  };
  const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  const v = [val(ix, iy), val(ix + 1, iy), val(ix, iy + 1), val(ix + 1, iy + 1)];
  const norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
  return (w[0]! * v[0]! + w[1]! * v[1]! + w[2]! * v[2]! + w[3]! * v[3]!) / norm;
}

/**
 * Linear colour (after exposure) with grain: times 1 + s n, where n is
 * grainNoise and s the relative grain, amount x GRAIN_MID at mid grey and
 * growing as 1 / sqrt(luminance) below it (photon shot noise: the noise's
 * standard deviation grows as the root of the signal), down to GRAIN_FLOOR.
 * Monochrome: the colour keeps its hue.
 */
export function grained(c: V3, amount: number, n: number): V3 {
  const y = Math.max(dot(c, LUMA), GRAIN_FLOOR);
  const k = Math.max(1 + amount * GRAIN_MID * Math.sqrt(MID_GREY / y) * n, 0);
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** WGSL twins of grainNoise and grained (needs PCG_WGSL). */
export const GRAIN_WGSL = /* wgsl */ `
fn grainVal(c: vec2i, seed: u32) -> f32 {
  let h = pcg3d(vec3u(bitcast<vec2u>(c), seed));
  return (f32(h.x) * 2.3283064365386963e-10 + f32(h.y) * 2.3283064365386963e-10 - 1.0) * 2.449489742783178;
}

fn grainNoise(px: vec2f, seed: u32, size: f32) -> f32 {
  let p = (floor(px) + 0.5) / max(size, 1.0) - 0.5;
  let i = vec2i(floor(p));
  let fr = p - floor(p);
  let w = vec4f((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y);
  let v = vec4f(grainVal(i, seed), grainVal(i + vec2i(1, 0), seed), grainVal(i + vec2i(0, 1), seed), grainVal(i + vec2i(1, 1), seed));
  return dot(w, v) / sqrt(dot(w, w));
}

fn grained(c: vec3f, amount: f32, n: f32) -> vec3f {
  let y = max(dot(c, vec3f(${LUMA.join(', ')})), ${GRAIN_FLOOR});
  return c * max(1.0 + amount * ${GRAIN_MID} * sqrt(${MID_GREY} / y) * n, 0.0);
}
`;
