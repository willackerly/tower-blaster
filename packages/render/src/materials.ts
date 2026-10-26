// Stone materials for the real look (realism step 3), baked on the GPU at
// startup into two texture arrays, one layer per stone, with full mip chains:
//
//   detail   rgb: albedo multiplier / 2 (the body's base colour times this;
//            mean about 1), a: roughness
//   normal   rgb: tangent-space normal * 0.5 + 0.5, a: cavity (1 = open
//            surface, lower in pores and grain boundaries). The relief it
//            comes from (StoneTexel.height, metres) is not stored.
//
// Each texture covers MATERIAL_TILE metres and tiles (noise.ts is periodic),
// so a face samples it at its body-local position plus a per-body offset and
// no two blocks show the same patch. Mips are box-filtered level by level;
// the shader renormalizes the averaged normal and widens roughness by how
// much it shortened (Toksvig), so distant faces lose bump detail as
// roughness rather than as sparkle.
//
// stoneSample is the CPU twin of the WGSL stone functions: tests compare
// baked texels with it and check the textures tile.
//
// Alternatives considered: evaluating the noise per fragment costs 10-40 noise
// calls per pixel at 1440p, for little gain over a 2 mm texel; CC0 scans
// (ambientCG, Poly Haven) are not reachable from the build environment and
// would need hosting; the layout keeps their slot open (same two arrays).
import { fbm, gnoise, NOISE_WGSL, worley } from './noise.ts';
import type { V3 } from './math.ts';

export const STONES = ['limestone', 'sandstone', 'granite', 'concrete'] as const;
export type Stone = (typeof STONES)[number];
export const MATERIAL_SIZE = 512;
export const MATERIAL_MIPS = Math.log2(MATERIAL_SIZE) + 1;
/** Metres one texture tile covers at texture scale 1. */
export const MATERIAL_TILE = 1;

/** Base colours (sRGB) blocks of each stone are drawn from, one per block. */
export const STONE_PALETTES: Record<Stone, string[]> = {
  limestone: ['#C9C1B1', '#BFB6A4', '#D2CBBC', '#B8AE9B', '#C4BBA8'],
  sandstone: ['#C49A6C', '#B98B5E', '#CFA77A', '#A97C55', '#C2946A'],
  granite: ['#8F8A86', '#9A928D', '#86817E', '#A39B95', '#918B88'],
  concrete: ['#A7A6A1', '#9C9B96', '#B0AEA8', '#95948F', '#A3A19B'],
};

export interface StoneTexel { albedo: V3; rough: number; height: number; cavity: number }

const U = 1 / 4294967296;
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
const TEXEL = ${MATERIAL_TILE / MATERIAL_SIZE};

fn heightAt(layer: u32, x: i32, y: i32) -> f32 {
  let w = vec2f(f32((x + i32(N)) % i32(N)), f32((y + i32(N)) % i32(N)));
  return stoneSample(layer, (w + 0.5) / f32(N)).height;
}

@compute @workgroup_size(8, 8) fn csBake(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N || id.y >= N) { return; }
  let s = stoneSample(id.z, (vec2f(id.xy) + 0.5) / f32(N));
  let x = i32(id.x); let y = i32(id.y);
  let dx = (heightAt(id.z, x + 1, y) - heightAt(id.z, x - 1, y)) / (2.0 * TEXEL);
  let dy = (heightAt(id.z, x, y + 1) - heightAt(id.z, x, y - 1)) / (2.0 * TEXEL);
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

/** The two stone texture arrays, baked once. */
export class Materials {
  readonly detail: GPUTexture;
  readonly normal: GPUTexture;
  readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    const tex = (label: string) => device.createTexture({
      size: [MATERIAL_SIZE, MATERIAL_SIZE, STONES.length], format: 'rgba8unorm', mipLevelCount: MATERIAL_MIPS,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC, label,
    });
    this.detail = tex('stone detail');
    this.normal = tex('stone normal');
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8, label: 'stone',
    });
    const module = device.createShaderModule({ code: MATERIAL_BAKE_WGSL, label: 'stone bake' });
    const bake = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'csBake' } });
    const down = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'csDown' } });
    const level = (t: GPUTexture, mip: number) => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });
    const enc = device.createCommandEncoder({ label: 'stone bake' });
    const cp = enc.beginComputePass();
    cp.setPipeline(bake);
    cp.setBindGroup(0, device.createBindGroup({ layout: bake.getBindGroupLayout(0), entries: [{ binding: 0, resource: level(this.detail, 0) }, { binding: 1, resource: level(this.normal, 0) }] }));
    cp.dispatchWorkgroups(MATERIAL_SIZE / 8, MATERIAL_SIZE / 8, STONES.length);
    cp.setPipeline(down);
    for (const t of [this.detail, this.normal]) for (let m = 1; m < MATERIAL_MIPS; m++) {
      const n = MATERIAL_SIZE >> m;
      cp.setBindGroup(0, device.createBindGroup({ layout: down.getBindGroupLayout(0), entries: [{ binding: 2, resource: level(t, m - 1) }, { binding: 3, resource: level(t, m) }] }));
      cp.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), STONES.length);
    }
    cp.end();
    device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    this.detail.destroy();
    this.normal.destroy();
  }
}
