// Stone and ground materials for the real look (realism steps 3 and 4),
// baked on the GPU at startup into two texture arrays with full mip chains,
// one layer per stone, then one per ground, then the ground's macro layer:
//
//   detail   rgb: albedo multiplier / 2 (the body's base colour times this;
//            mean about 1), a: roughness
//   normal   rgb: tangent-space normal * 0.5 + 0.5, a: cavity (1 = open
//            surface, lower in pores and grain boundaries). The relief it
//            comes from (StoneTexel.height, metres) is not stored.
//
// Each texture tiles (noise.ts is periodic). A stone covers MATERIAL_TILE
// metres, and a face samples it at its body-local position plus a per-body
// offset, so no two blocks show the same clump. A ground covers GROUND_TILE
// metres of floor; the macro layer (MACRO_TILE metres, sampled at a coarse
// mip only) holds low-frequency variation that hides the ground's repeat:
//
//   macro    r: brightness, g: warm/cool tint, b: which of the ground's two
//            scales shows, each 0.5 on average; a: 1
// Mips are box-filtered level by level;
// the shader renormalizes the averaged normal and widens roughness by how
// much it shortened (Toksvig), so distant faces lose bump detail as
// roughness rather than as sparkle.
//
// materialSample and macroSample are the CPU twins of the WGSL functions:
// tests compare baked texels with them and check the textures tile.
//
// Alternatives considered: evaluating the noise per fragment costs 10-40 noise
// calls per pixel at 1440p, for little gain over a 2 mm texel; CC0 scans
// (ambientCG, Poly Haven) are not reachable from the build environment and
// would need hosting; the layout keeps their slot open (same two arrays).
import { fbm, gnoise, NOISE_WGSL, worley } from './noise.ts';
import type { V3 } from './math.ts';

export const STONES = ['limestone', 'sandstone', 'granite', 'concrete'] as const;
export type Stone = (typeof STONES)[number];
export const GROUNDS = ['gravel', 'dirt'] as const;
export type Ground = (typeof GROUNDS)[number];
/** Layer of the first ground, and of the ground's macro variation (after the grounds). */
export const GROUND_LAYER = STONES.length;
export const MACRO_LAYER = GROUND_LAYER + GROUNDS.length;
export const MATERIAL_LAYERS = MACRO_LAYER + 1;
export const MATERIAL_SIZE = 512;
export const MATERIAL_MIPS = Math.log2(MATERIAL_SIZE) + 1;
/** Metres one stone tile covers at texture scale 1. */
export const MATERIAL_TILE = 1;
/** Metres of floor one ground tile, and the macro layer, cover at ground scale 1. */
export const GROUND_TILE = 2;
export const MACRO_TILE = 64;

/** Metres one tile of a layer covers at scale 1. */
export function layerTile(layer: number): number {
  return layer < GROUND_LAYER ? MATERIAL_TILE : layer < MACRO_LAYER ? GROUND_TILE : MACRO_TILE;
}

/** Base colours (sRGB) blocks of each stone are drawn from, one per block. */
export const STONE_PALETTES: Record<Stone, string[]> = {
  limestone: ['#C9C1B1', '#BFB6A4', '#D2CBBC', '#B8AE9B', '#C4BBA8'],
  sandstone: ['#C49A6C', '#B98B5E', '#CFA77A', '#A97C55', '#C2946A'],
  granite: ['#8F8A86', '#9A928D', '#86817E', '#A39B95', '#918B88'],
  concrete: ['#A7A6A1', '#9C9B96', '#B0AEA8', '#95948F', '#A3A19B'],
};

export interface StoneTexel { albedo: V3; rough: number; height: number; cavity: number }

const U = 1 / 4294967296;
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** One stone at texture coordinate (u, v) in [0, 1): what the bake writes, before encoding. */
export function stoneSample(layer: number, u: number, v: number): StoneTexel {
  const seed = 1000 * (layer + 1);
  if (layer === 0) { // limestone: cloudy mottling, sparse fine pores of mixed size
    const m = fbm(u * 3, v * 3, 3, seed, 6), fine = gnoise(u * 256, v * 256, 256, seed + 7);
    const [f1, , id] = worley(u * 64, v * 64, 64, seed + 11), k = id * U;
    const r = 0.05 + 0.25 * ((id >>> 8) & 255) / 255;
    const pore = k < 0.25 ? 1 - smoothstep(0.6 * r, r, f1) : 0;
    const a = 1 + 0.25 * m + 0.03 * fine - 0.3 * pore;
    return { albedo: mix3([a, a, a], [a * 1.03, a, a * 0.94], 0.5 + m), rough: 0.8 + 0.1 * fine, height: 0.0012 * m + 0.0002 * fine - 0.0006 * pore, cavity: 1 - 0.6 * pore };
  }
  if (layer === 1) { // sandstone: faint bedding, iron staining, sand grain
    const warp = fbm(u * 2, v * 2, 2, seed, 4), blotch = fbm(u * 4, v * 4, 4, seed + 5, 4), grain = gnoise(u * 256, v * 256, 256, seed + 7);
    const bands = Math.sin(2 * Math.PI * (v * 11 + 0.6 * warp));
    const a = 1 + 0.035 * bands + 0.05 * grain + 0.08 * blotch;
    return { albedo: mix3([a, a, a], [a * 1.08, a * 0.95, a * 0.82], 0.6 * smoothstep(0.05, 0.35, blotch)), rough: 0.88 + 0.05 * grain, height: 0.0004 * bands + 0.0004 * grain, cavity: 1 - 0.2 * Math.max(-grain, 0) };
  }
  if (layer === 2) { // granite: small interlocking crystals of three minerals, larger-scale shading
    const [f1, f2, id] = worley(u * 200, v * 200, 200, seed), coarse = worley(u * 80, v * 80, 80, seed + 3)[2] * U;
    const k = id * U, edge = smoothstep(0, 0.1, f2 - f1);
    const mineral: V3 = k < 0.1 ? [0.35, 0.34, 0.36] : k < 0.55 ? [1.15, 1.13, 1.1] : [1, 0.9, 0.86];
    const s = (0.95 + 0.05 * edge) * (0.92 + 0.16 * coarse);
    return { albedo: [mineral[0] * s, mineral[1] * s, mineral[2] * s], rough: 0.6 + 0.15 * (k < 0.1 ? 1 : 0), height: 0.0002 * (edge - 1) + 0.0002 * coarse, cavity: 0.8 + 0.2 * edge };
  }
  // concrete: cement mottling, sparse air voids
  const m = fbm(u * 5, v * 5, 5, seed, 5), [f1, , id] = worley(u * 40, v * 40, 40, seed + 11);
  const pore = id * U < 0.3 ? 1 - smoothstep(0.03, 0.09, f1) : 0;
  const a = 1 + 0.12 * m - 0.45 * pore;
  return { albedo: [a, a, a * 1.01], rough: 0.9, height: 0.001 * m - 0.0012 * pore, cavity: 1 - 0.7 * pore };
}

/**
 * Rounded stones on a worley grid of period cells per tile: in a cell whose
 * hash is under density, a dome of radius 0.3 to 0.6 cells and peak height
 * up to hMax metres, in one of several tones. cover: where it shows; crevice:
 * the ring where it meets the ground.
 */
function pebbles(u: number, v: number, period: number, seed: number, density: number, hMax: number) {
  const [f1, , id] = worley(u * period, v * period, period, seed);
  const r = 0.3 + (0.3 * ((id >>> 8) & 255)) / 255;
  const on = 1 - smoothstep(density - 0.05, density + 0.05, id * U);
  const x = Math.min(f1 / r, 1), dome = (1 - x * x) * (1 - x * x);
  const t = ((id >>> 16) & 255) / 255;
  const albedo: V3 = ((id >>> 24) & 3) === 0 ? [1.15, 1.0, 0.82] : [0.62 + 0.7 * t, 0.62 + 0.69 * t, 0.62 + 0.68 * t];
  return { cover: on * (1 - smoothstep(0.8, 1, x)), height: (hMax * r * on * dome) / 0.6, albedo, crevice: on * smoothstep(0.8, 1, f1 / r) * (1 - smoothstep(1, 1.7, f1 / r)) };
}

/** One ground (k: index in GROUNDS) at (u, v) in [0, 1) of its GROUND_TILE: what the bake writes. */
export function groundSample(k: number, u: number, v: number): StoneTexel {
  const seed = 1000 * (GROUND_LAYER + k + 1);
  if (k === 0) { // gravel: rounded stones of three sizes and mixed tone in a dirt matrix, denser in metre-scale clumps
    const clump = fbm(u * 2, v * 2, 2, seed, 3), tone = fbm(u * 16, v * 16, 16, seed + 3, 3), fines = gnoise(u * 256, v * 256, 256, seed + 7);
    const grit = pebbles(u, v, 150, seed + 13, 0.55 + 0.3 * clump, 0.0015);
    const peb = pebbles(u, v, 56, seed + 11, 0.5 + 0.5 * clump, 0.005);
    const cob = pebbles(u, v, 20, seed + 17, 0.18 + 0.2 * clump, 0.011);
    const m = 1.03 + 0.3 * tone + 0.04 * fines;
    const albedo = mix3(mix3(mix3([m, m, m], grit.albedo, grit.cover), peb.albedo, peb.cover), cob.albedo, cob.cover);
    const cover = Math.max(grit.cover, peb.cover, cob.cover);
    return { albedo, rough: 0.95 - 0.22 * cover, height: Math.max(grit.height, peb.height, cob.height) + 0.0006 * fines + 0.0015 * tone, cavity: (1 - 0.2 * grit.crevice) * (1 - 0.3 * peb.crevice) * (1 - 0.35 * cob.crevice) };
  }
  // dirt: packed earth with a mottled crust, fine drying cracks in patches, a few small stones
  const clump = fbm(u * 2, v * 2, 2, seed, 3), m = fbm(u * 8, v * 8, 8, seed + 3, 4), grain = gnoise(u * 256, v * 256, 256, seed + 7);
  const [f1, f2] = worley(u * 14, v * 14, 14, seed + 5);
  const crack = (1 - smoothstep(0, 0.05, f2 - f1)) * smoothstep(-0.05, 0.2, clump);
  const [g1, , gid] = worley(u * 120, v * 120, 120, seed + 11);
  const st = gid * U < 0.12 ? 1 - smoothstep(0.2, 0.35, g1) : 0;
  const a = 1 + 0.2 * m + 0.05 * grain + 0.12 * clump - 0.4 * crack;
  return { albedo: mix3([a * 1.02, a, a * 0.97], [1.12, 1.1, 1.06], st), rough: 0.96 - 0.12 * st, height: 0.003 * m + 0.0004 * grain - 0.0015 * crack + 0.0025 * st * (1 - smoothstep(0, 0.35, g1)), cavity: 1 - 0.55 * crack };
}

/** A stone or ground layer at (u, v) in [0, 1) of its tile. */
export function materialSample(layer: number, u: number, v: number): StoneTexel {
  return layer < GROUND_LAYER ? stoneSample(layer, u, v) : groundSample(layer - GROUND_LAYER, u, v);
}

/** The macro layer at (u, v) in [0, 1): brightness, tint and scale blend, each 0.5 on average, and 1. */
export function macroSample(u: number, v: number): [number, number, number, number] {
  const seed = 1000 * (MACRO_LAYER + 1);
  const b = fbm(u * 4, v * 4, 4, seed, 5), t = fbm(u * 3, v * 3, 3, seed + 5, 4), w = fbm(u * 6, v * 6, 6, seed + 9, 4);
  return [clamp01(0.5 + b), clamp01(0.5 + t), clamp01(0.5 + 1.5 * w), 1];
}

/**
 * The ground's patch field (shaders.ts groundMacro: 0.55 x the macro b at
 * its 1/4.7 scale plus 0.45 x at 1/22, each at its finest level, 3.5 and 4)
 * is close to normal, with this mean and standard deviation (measured from
 * macroSample's box mips; materials.test.ts checks the shares).
 */
export const PATCH_FIELD = { mean: 0.503, sd: 0.12 } as const;

/** The patch field's value that `share` of the ground (seen up close) lies above: above 1 for none, below 0 for all. */
export function patchThreshold(share: number): number {
  if (!(share > 0)) return 2;
  if (share >= 1) return -1;
  return PATCH_FIELD.mean + PATCH_FIELD.sd * probit(1 - share);
}

/** The standard normal quantile (Acklam's rational approximation, relative error below 1.2e-9). */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`probit: p must be in (0, 1): ${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q: number) => (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

const STONE_WGSL = /* wgsl */ `
${NOISE_WGSL}
struct StoneTexel { albedo: vec3f, rough: f32, height: f32, cavity: f32 }

fn stoneSample(layer: u32, uv: vec2f) -> StoneTexel {
  let seed = 1000u * (layer + 1u);
  if (layer == 0u) {
    let m = fbm(uv * 3.0, 3, seed, 6);
    let fine = gnoise(uv * 256.0, 256, seed + 7u);
    let c = worley(uv * 64.0, 64, seed + 11u);
    let k = f32(c.id) * NOISE_U;
    let r = 0.05 + 0.25 * f32((c.id >> 8u) & 255u) / 255.0;
    let pore = select(0.0, 1.0 - smoothstep(0.6 * r, r, c.f1), k < 0.25);
    let a = 1.0 + 0.25 * m + 0.03 * fine - 0.3 * pore;
    return StoneTexel(mix(vec3f(a), vec3f(a * 1.03, a, a * 0.94), 0.5 + m), 0.8 + 0.1 * fine, 0.0012 * m + 0.0002 * fine - 0.0006 * pore, 1.0 - 0.6 * pore);
  }
  if (layer == 1u) {
    let warp = fbm(uv * 2.0, 2, seed, 4);
    let blotch = fbm(uv * 4.0, 4, seed + 5u, 4);
    let grain = gnoise(uv * 256.0, 256, seed + 7u);
    let bands = sin(6.283185307 * (uv.y * 11.0 + 0.6 * warp));
    let a = 1.0 + 0.035 * bands + 0.05 * grain + 0.08 * blotch;
    return StoneTexel(mix(vec3f(a), vec3f(a * 1.08, a * 0.95, a * 0.82), 0.6 * smoothstep(0.05, 0.35, blotch)), 0.88 + 0.05 * grain, 0.0004 * bands + 0.0004 * grain, 1.0 - 0.2 * max(-grain, 0.0));
  }
  if (layer == 2u) {
    let c = worley(uv * 200.0, 200, seed);
    let coarse = f32(worley(uv * 80.0, 80, seed + 3u).id) * NOISE_U;
    let k = f32(c.id) * NOISE_U;
    let edge = smoothstep(0.0, 0.1, c.f2 - c.f1);
    let mineral = select(select(vec3f(1.0, 0.9, 0.86), vec3f(1.15, 1.13, 1.1), k < 0.55), vec3f(0.35, 0.34, 0.36), k < 0.1);
    let s = (0.95 + 0.05 * edge) * (0.92 + 0.16 * coarse);
    return StoneTexel(mineral * s, 0.6 + 0.15 * select(0.0, 1.0, k < 0.1), 0.0002 * (edge - 1.0) + 0.0002 * coarse, 0.8 + 0.2 * edge);
  }
  let m = fbm(uv * 5.0, 5, seed, 5);
  let c = worley(uv * 40.0, 40, seed + 11u);
  let pore = select(0.0, 1.0 - smoothstep(0.03, 0.09, c.f1), f32(c.id) * NOISE_U < 0.3);
  let a = 1.0 + 0.12 * m - 0.45 * pore;
  return StoneTexel(vec3f(a, a, a * 1.01), 0.9, 0.001 * m - 0.0012 * pore, 1.0 - 0.7 * pore);
}

struct Pebbles { cover: f32, height: f32, albedo: vec3f, crevice: f32 }
fn pebbles(uv: vec2f, period: i32, seed: u32, density: f32, hMax: f32) -> Pebbles {
  let c = worley(uv * f32(period), period, seed);
  let r = 0.3 + 0.3 * f32((c.id >> 8u) & 255u) / 255.0;
  let on = 1.0 - smoothstep(density - 0.05, density + 0.05, f32(c.id) * NOISE_U);
  let x = min(c.f1 / r, 1.0);
  let dome = (1.0 - x * x) * (1.0 - x * x);
  let t = f32((c.id >> 16u) & 255u) / 255.0;
  let albedo = select(vec3f(0.62 + 0.7 * t, 0.62 + 0.69 * t, 0.62 + 0.68 * t), vec3f(1.15, 1.0, 0.82), ((c.id >> 24u) & 3u) == 0u);
  return Pebbles(on * (1.0 - smoothstep(0.8, 1.0, x)), hMax * r * on * dome / 0.6, albedo, on * smoothstep(0.8, 1.0, c.f1 / r) * (1.0 - smoothstep(1.0, 1.7, c.f1 / r)));
}

fn groundSample(k: u32, uv: vec2f) -> StoneTexel {
  let seed = 1000u * (${GROUND_LAYER}u + k + 1u);
  if (k == 0u) {
    let clump = fbm(uv * 2.0, 2, seed, 3);
    let tone = fbm(uv * 16.0, 16, seed + 3u, 3);
    let fines = gnoise(uv * 256.0, 256, seed + 7u);
    let grit = pebbles(uv, 150, seed + 13u, 0.55 + 0.3 * clump, 0.0015);
    let peb = pebbles(uv, 56, seed + 11u, 0.5 + 0.5 * clump, 0.005);
    let cob = pebbles(uv, 20, seed + 17u, 0.18 + 0.2 * clump, 0.011);
    let m = 1.03 + 0.3 * tone + 0.04 * fines;
    let albedo = mix(mix(mix(vec3f(m), grit.albedo, grit.cover), peb.albedo, peb.cover), cob.albedo, cob.cover);
    let cover = max(grit.cover, max(peb.cover, cob.cover));
    return StoneTexel(albedo, 0.95 - 0.22 * cover, max(grit.height, max(peb.height, cob.height)) + 0.0006 * fines + 0.0015 * tone, (1.0 - 0.2 * grit.crevice) * (1.0 - 0.3 * peb.crevice) * (1.0 - 0.35 * cob.crevice));
  }
  let clump = fbm(uv * 2.0, 2, seed, 3);
  let m = fbm(uv * 8.0, 8, seed + 3u, 4);
  let grain = gnoise(uv * 256.0, 256, seed + 7u);
  let c = worley(uv * 14.0, 14, seed + 5u);
  let crack = (1.0 - smoothstep(0.0, 0.05, c.f2 - c.f1)) * smoothstep(-0.05, 0.2, clump);
  let g = worley(uv * 120.0, 120, seed + 11u);
  let st = select(0.0, 1.0 - smoothstep(0.2, 0.35, g.f1), f32(g.id) * NOISE_U < 0.12);
  let a = 1.0 + 0.2 * m + 0.05 * grain + 0.12 * clump - 0.4 * crack;
  return StoneTexel(mix(vec3f(a * 1.02, a, a * 0.97), vec3f(1.12, 1.1, 1.06), st), 0.96 - 0.12 * st, 0.003 * m + 0.0004 * grain - 0.0015 * crack + 0.0025 * st * (1.0 - smoothstep(0.0, 0.35, g.f1)), 1.0 - 0.55 * crack);
}

fn materialSample(layer: u32, uv: vec2f) -> StoneTexel {
  if (layer < ${GROUND_LAYER}u) { return stoneSample(layer, uv); }
  return groundSample(layer - ${GROUND_LAYER}u, uv);
}

fn macroSample(uv: vec2f) -> vec4f {
  let seed = 1000u * ${MACRO_LAYER + 1}u;
  let b = fbm(uv * 4.0, 4, seed, 5);
  let t = fbm(uv * 3.0, 3, seed + 5u, 4);
  let w = fbm(uv * 6.0, 6, seed + 9u, 4);
  return vec4f(clamp(vec3f(0.5 + b, 0.5 + t, 0.5 + 1.5 * w), vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

/** Tangent-space normal of a height field from central differences (texel: metres per texel). */
export function heightNormal(hl: number, hr: number, hd: number, hu: number, texel: number): V3 {
  const dx = (hr - hl) / (2 * texel), dy = (hu - hd) / (2 * texel), l = Math.hypot(dx, dy, 1);
  return [-dx / l, -dy / l, 1 / l];
}

export const MATERIAL_BAKE_WGSL = /* wgsl */ `
${STONE_WGSL}
@group(0) @binding(0) var detailOut: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(1) var normalOut: texture_storage_2d_array<rgba8unorm, write>;

const N = ${MATERIAL_SIZE}u;

// Heights first, one evaluation per texel; csBake takes the normals from their central differences.
@group(0) @binding(4) var heightOut: texture_storage_2d_array<r32float, write>;
@group(0) @binding(5) var heightIn: texture_2d_array<f32>;

@compute @workgroup_size(8, 8) fn csHeight(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  textureStore(heightOut, id.xy, id.z, vec4f(materialSample(id.z, (vec2f(id.xy) + 0.5) / f32(N)).height, 0.0, 0.0, 0.0));
}

fn heightAt(layer: u32, x: i32, y: i32) -> f32 {
  return textureLoad(heightIn, vec2i((x + i32(N)) % i32(N), (y + i32(N)) % i32(N)), i32(layer), 0).r;
}

@compute @workgroup_size(8, 8) fn csBake(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(N);
  if (id.z == ${MACRO_LAYER}u) {
    textureStore(detailOut, id.xy, id.z, macroSample(uv));
    textureStore(normalOut, id.xy, id.z, vec4f(0.5, 0.5, 1.0, 1.0));
    return;
  }
  let s = materialSample(id.z, uv);
  let texel = select(${GROUND_TILE / MATERIAL_SIZE}, ${MATERIAL_TILE / MATERIAL_SIZE}, id.z < ${GROUND_LAYER}u);
  let x = i32(id.x); let y = i32(id.y);
  let dx = (heightAt(id.z, x + 1, y) - heightAt(id.z, x - 1, y)) / (2.0 * texel);
  let dy = (heightAt(id.z, x, y + 1) - heightAt(id.z, x, y - 1)) / (2.0 * texel);
  let n = normalize(vec3f(-dx, -dy, 1.0));
  textureStore(detailOut, id.xy, id.z, vec4f(clamp(s.albedo * 0.5, vec3f(0.0), vec3f(1.0)), clamp(s.rough, 0.0, 1.0)));
  textureStore(normalOut, id.xy, id.z, vec4f(n * 0.5 + 0.5, clamp(s.cavity, 0.0, 1.0)));
}

// One mip level from the one above: a 2x2 box filter, per layer.
@group(0) @binding(2) var srcLevel: texture_2d_array<f32>;
@group(0) @binding(3) var dstLevel: texture_storage_2d_array<rgba8unorm, write>;

@compute @workgroup_size(8, 8) fn csDown(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dstLevel);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let l = i32(id.z);
  let c = textureLoad(srcLevel, p, l, 0) + textureLoad(srcLevel, p + vec2i(1, 0), l, 0) + textureLoad(srcLevel, p + vec2i(0, 1), l, 0) + textureLoad(srcLevel, p + vec2i(1, 1), l, 0);
  textureStore(dstLevel, id.xy, id.z, c * 0.25);
}
`;

/** The two material texture arrays (stones, grounds, the ground's macro layer), baked once. */
export class Materials {
  readonly detail: GPUTexture;
  readonly normal: GPUTexture;
  readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    const tex = (label: string) => device.createTexture({
      size: [MATERIAL_SIZE, MATERIAL_SIZE, MATERIAL_LAYERS], format: 'rgba8unorm', mipLevelCount: MATERIAL_MIPS,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC, label,
    });
    this.detail = tex('stone detail');
    this.normal = tex('stone normal');
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8, label: 'stone',
    });
    const module = device.createShaderModule({ code: MATERIAL_BAKE_WGSL, label: 'stone bake' });
    const height = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'csHeight' } });
    const bake = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'csBake' } });
    const down = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'csDown' } });
    const level = (t: GPUTexture, mip: number) => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });
    // Every layer but the macro one has a relief; 1 MB a layer, freed once the bake has run.
    const heights = device.createTexture({ size: [MATERIAL_SIZE, MATERIAL_SIZE, MACRO_LAYER], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, label: 'material heights' });
    const enc = device.createCommandEncoder({ label: 'stone bake' });
    const cp = enc.beginComputePass();
    cp.setPipeline(height);
    cp.setBindGroup(0, device.createBindGroup({ layout: height.getBindGroupLayout(0), entries: [{ binding: 4, resource: level(heights, 0) }] }));
    cp.dispatchWorkgroups(MATERIAL_SIZE / 8, MATERIAL_SIZE / 8, MACRO_LAYER);
    cp.setPipeline(bake);
    cp.setBindGroup(0, device.createBindGroup({ layout: bake.getBindGroupLayout(0), entries: [{ binding: 0, resource: level(this.detail, 0) }, { binding: 1, resource: level(this.normal, 0) }, { binding: 5, resource: level(heights, 0) }] }));
    cp.dispatchWorkgroups(MATERIAL_SIZE / 8, MATERIAL_SIZE / 8, MATERIAL_LAYERS);
    cp.setPipeline(down);
    for (const t of [this.detail, this.normal]) for (let m = 1; m < MATERIAL_MIPS; m++) {
      const n = MATERIAL_SIZE >> m;
      cp.setBindGroup(0, device.createBindGroup({ layout: down.getBindGroupLayout(0), entries: [{ binding: 2, resource: level(t, m - 1) }, { binding: 3, resource: level(t, m) }] }));
      cp.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), MATERIAL_LAYERS);
    }
    cp.end();
    device.queue.submit([enc.finish()]);
    heights.destroy();
  }

  destroy(): void {
    this.detail.destroy();
    this.normal.destroy();
  }
}
