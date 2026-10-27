// WGSL for the scene pass: bodies (boxes as rounded glossy candy, spheres),
// the floor, the sky, and the ID target used by tests. Everything is
// camera-relative; the shading reads its colours and lights from the Frame
// uniform (LookParams), so presets are data.
import { defineStruct, FxState, RenderRecord, Spark, wgslStruct } from '@tb/schema';
import { FX_EMISSIVE_MAX, FX_WGSL } from './fx.ts';
import { BEVEL_WGSL, OKLAB_WGSL } from './look.ts';
import { SPARK_COMMON } from './sparks.ts';
import { LIGHT_META, LIGHT_PACKED, LIGHT_VEC4, MAX_BALLS, TRAIL } from './lights.ts';
import { AO_FOOT_WGSL, AO_SAMPLE_WGSL, AO_SEAM_WGSL } from './ao.ts';
import { ATMO_COMMON_WGSL } from './atmosphere.ts';
import { GROUND_LAYER, GROUND_TILE, GROUNDS, MACRO_LAYER, MACRO_TILE, MATERIAL_MIPS, MATERIAL_SIZE, MATERIAL_TILE, WOOD, WOOD_RING_M, WOOD_STRETCH, WOOD_WGSL } from './materials.ts';
import { PCG_WGSL } from './noise.ts';
import { HALL_MAT, HALL_WGSL } from './hall.ts';

export const SHADOW_SIZE = 2048;
export const SPHERE_SEG = 24;
export const SPHERE_RINGS = 14;
export const SPHERE_VERTS = SPHERE_SEG * SPHERE_RINGS * 6;
/** Vertices per box: the hexagon fan (default) or the full 12-triangle cube (debug, A/B). */
export const BOX_FAN_VERTS = 18;
export const BOX_CUBE_VERTS = 36;
export const BOX_VERTS = BOX_FAN_VERTS;

export const Frame = defineStruct('Frame', [
  ['viewProj', 'mat4x4f', 'camera-relative'],
  ['lightViewProj', 'mat4x4f', 'camera-relative'],
  ['invViewProj', 'mat4x4f', 'camera-relative'],
  ['eye', 'vec3f'], ['time', 'f32'],
  ['sun', 'vec3f'], ['groundY', 'f32'],
  ['focus', 'vec3f', 'orbit target, camera-relative'], ['capacity', 'u32'],
  ['skyZenith', 'vec3f'], ['exposure', 'f32'],
  ['skyHorizon', 'vec3f'], ['fogDensity', 'f32'],
  ['glow', 'vec3f'], ['fogHeight', 'f32'],
  ['floor', 'vec3f'], ['floorGrid', 'f32'],
  ['sunColor', 'vec3f'], ['roughness', 'f32'],
  ['ambSky', 'vec3f'], ['clearcoat', 'f32'],
  ['ambGround', 'vec3f'], ['bevel', 'f32'],
  ['keyColor', 'vec3f'], ['keySize', 'f32'],
  ['keyDir', 'vec3f'], ['rimSize', 'f32'],
  ['rimColor', 'vec3f'], ['hueStep', 'f32', 'radians'],
  ['rimDir', 'vec3f'], ['ballEmissive', 'f32'],
  ['ball', 'vec3f'], ['heat', 'f32', '1: heat glow on (bench toggle)'],
  ['shadowParams', 'vec4f', 'normal offset m, depth bias (light depth units), texel m, texel uv (1 / map size)'],
  ['viewport', 'vec2f', 'pixels'], ['dt', 'f32', 'seconds since the last scene frame'], ['trailHead', 'u32', 'newest ball trail sample'],
  ['aoOrigin', 'vec3f', 'AO grid low corner, camera-relative'], ['aoInvVoxel', 'f32', 'per metre, level 0'],
  ['aoDims', 'vec3f', 'level-0 voxels'], ['aoOn', 'f32', '0: AO off'],
  ['aoK', 'vec4f', 'tap strengths (0.3, 0.9, 2.0 m), sky weight'],
  ['ramp0', 'vec4f', 'OKLab'], ['ramp1', 'vec4f'], ['ramp2', 'vec4f'], ['ramp3', 'vec4f'], ['ramp4', 'vec4f'],
  ['atmoSigma', 'vec3f', 'real look: air extinction at the ground, per metre'], ['atmoEyeKm', 'f32', 'real look: eye height above the ground, km'],
  ['sunDisc', 'vec3f', 'real look: sun disc radiance'], ['sunCos', 'f32', 'real look: cos of the sun disc angular radius'],
  ['stone', 'vec4f', 'real look: stone layer (materials.ts STONES), texture scale, edge wear, dirt'],
  ['stoneDetail', 'vec4f', 'real look: x: stone texture strength (0: none, nothing sampled), y: fade-out pixel footprint (m)'],
  ['blockAlbedo', 'vec4f', 'real look: the blocks\' mean linear albedo (the ramp\'s)'],
  ['aoFloorSky', 'vec4f', 'real look: floor sky map placement, uv = (rel.xz - xy) * zw (AoVolume.floorSkyFrame)'],
  ['ground', 'vec4f', 'real look: ground layer (materials.ts), texture scale, texture strength (0: none, nothing sampled), macro variation'],
  ['groundShape', 'vec4f', 'real look: ground relief (m, the coarse macro scale\'s; half that at the next), patch threshold (macro value; above 1: no patches), unused x2'],
  ['hills', 'vec4f', 'real look: horizon hills\' greatest height (radians, 0: none) and distance (m)'],
  ['debris', 'vec4f', 'real look: dust puff size (m, fully grown), puff opacity, chip size (m), unused'],
  ['shadowSoft', 'vec4f', 'real look: tan of the penumbra half angle (0: 3x3 taps), blocker search radius (texels), light depth range (m), steepest receiver plane (depth per uv)'],
  ['hall0', 'vec4f', 'real look, hall: hallUniform (hall.ts), metres'], ['hall1', 'vec4f'], ['hall2', 'vec4f'], ['hall3', 'vec4f'], ['hall4', 'vec4f'], ['hall5', 'vec4f'],
  ['hallLook', 'vec4f', 'real look: 1 while the eye is inside the hall (else it is not drawn), metres per world unit, glass milkiness, iron grey'],
], 'Per-frame uniforms of the scene pass.');

// The real look's sky (atmosphere.ts): bind group 1, read by the scene
// shader only when it is generated for that look (sceneWgsl(true)).
/** The ground's second scale is this much coarser than its first (realism step 4). */
const GROUND_B = 2.71;

const REAL_WGSL = /* wgsl */ `
${ATMO_COMMON_WGSL}
@group(1) @binding(0) var skyViewTex: texture_2d<f32>;
@group(1) @binding(1) var skySamp: sampler;
@group(1) @binding(2) var<storage, read> atmoAmbient: array<vec4f, 3>; // sky irradiance / pi, ground radiance, adapted exposure
@group(1) @binding(3) var stoneDetail: texture_2d_array<f32>; // materials.ts: albedo multiplier / 2, roughness
@group(1) @binding(4) var stoneNormal: texture_2d_array<f32>; // materials.ts: tangent-space normal * 0.5 + 0.5, cavity
@group(1) @binding(5) var stoneSamp: sampler;
@group(0) @binding(15) var aoFloorSkyTex: texture_2d<f32>; // ao.ts: the floor's sky view factor (R)
${PCG_WGSL}
${WOOD_WGSL}
${HALL_WGSL}
// Bench diagnostics (RendererOptions.realDiag): REAL_STONE false compiles the
// stone samples out ('stone-off'); REAL_BLOCK false shades blocks as step 1
// did, the stylized body under the atmosphere ('step1').
override REAL_STONE: bool = true;
override REAL_BLOCK: bool = true;
// The wood (materials.ts WOOD): the box pipeline for a look whose stone is
// pine sets it, and blocks take woodAt instead of the stone. Off, the wood
// code is not compiled, so the stones' pipelines carry none of its registers.
override REAL_WOOD: bool = false;
// RendererOptions.realDiag 'no-floor-sky': the floor's baked sky view unused (the vertical sky term only).
override FLOOR_CONES: bool = true;
// RendererOptions.realDiag 'ground-off': the ground material and horizon hills compiled out (the flat floor of ground texture 0).
override REAL_GROUND: bool = true;
// RendererOptions.realDiag 'pcss-off': sun shadows from the stylized looks' 3x3 taps, the soft shadow code compiled out.
override REAL_PCSS: bool = true;
// RendererOptions.realDiag 'shadow-view' (tests): the floor shows its sun visibility (0 to 1) instead of its colour.
override SHADOW_VIEW: bool = false;
@group(1) @binding(6) var shadowPoint: sampler; // non-filtering: textureGather on the shadow map
// The fragment's pixel (set by each real fragment entry point), for the shadow taps' per-pixel turn.
var<private> fragPx: vec2f;

// Soft sun shadows (realism step 5): percentage-closer soft shadows with the
// sun's angular size. Taps on Vogel discs (radius sqrt((i + 0.5) / N), golden
// angle), so equal weights average over the disc the sun is.
const PCSS_SEARCH = array<vec2f, 8>(vec2f(0.2500, 0.0000), vec2f(-0.3193, 0.2925), vec2f(0.0489, -0.5569), vec2f(0.4024, 0.5249), vec2f(-0.7385, -0.1306), vec2f(0.6996, -0.4450), vec2f(-0.2340, 0.8705), vec2f(-0.4463, -0.8593));
const PCSS_TAPS = array<vec2f, 12>(vec2f(0.2041, 0.0000), vec2f(-0.2607, 0.2388), vec2f(0.0399, -0.4547), vec2f(0.3286, 0.4286), vec2f(-0.6030, -0.1067), vec2f(0.5712, -0.3634), vec2f(-0.1911, 0.7107), vec2f(-0.3644, -0.7016), vec2f(0.7906, 0.2887), vec2f(-0.8224, 0.3395), vec2f(0.3965, -0.8472), vec2f(0.2930, 0.9341));

// The stylized looks' 3x3 taps (shadow()), for penumbrae under 1.5 texels.
fn shadowPcf(uv: vec2f, depth: f32) -> f32 {
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * fr.shadowParams.w, depth);
    }
  }
  return sum / 9.0;
}

// The receiver's plane in the shadow map: light depth per unit of uv, so a
// tap away from the centre compares against the surface's own depth there
// (without it, wide kernels shadow tilted surfaces with themselves).
// Tangents through the light's matrix, solved for the gradient.
fn receiverSlope(n: vec3f) -> vec2f {
  let t1 = normalize(cross(n, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.x) > 0.9)));
  let t2 = cross(n, t1);
  let c1 = (fr.lightViewProj * vec4f(t1, 0.0)).xyz * vec3f(0.5, -0.5, 1.0);
  let c2 = (fr.lightViewProj * vec4f(t2, 0.0)).xyz * vec3f(0.5, -0.5, 1.0);
  let det = c1.x * c2.y - c1.y * c2.x;
  var g = vec2f(c1.z * c2.y - c1.y * c2.z, c1.x * c2.z - c1.z * c2.x) / select(det, 1e-20, abs(det) < 1e-20);
  let gl = length(g);
  if (gl > fr.shadowSoft.w) { g *= fr.shadowSoft.w / gl; }
  return g;
}

fn turn(v: vec2f, cs: vec2f) -> vec2f {
  return vec2f(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

// Sun visibility at rel (normal n): a blocker search over the widest
// penumbra (fr.shadowSoft.y texels), then a disc of taps whose radius is
// the receiver-blocker distance times tan(sun radius). Fully lit or fully
// blocked searches return at once.
fn shadowSoft(rel: vec3f, n: vec3f) -> f32 {
  let lc = fr.lightViewProj * vec4f(rel + n * fr.shadowParams.x, 1.0);
  let uv = lc.xy * vec2f(0.5, -0.5) + 0.5;
  let depth = lc.z - fr.shadowParams.y;
  if (!(all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && depth < 1.0)) { return 1.0; }
  if (!REAL_PCSS || fr.shadowSoft.x <= 0.0) { return shadowPcf(uv, depth); }
  let g = receiverSlope(n);
  let ang = 6.2831853 * fract(52.9829189 * fract(dot(fragPx, vec2f(0.06711056, 0.00583715))));
  let cs = vec2f(cos(ang), sin(ang));
  let search = fr.shadowSoft.y * fr.shadowParams.w;
  // A gather's four texels lie within 0.71 texel of its point.
  let slack = 0.71 * length(g) * fr.shadowParams.w;
  var blockers = 0.0;
  var dsum = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = turn(PCSS_SEARCH[i], cs) * search;
    let z = depth + dot(g, o);
    let d = textureGather(shadowMap, shadowPoint, uv + o);
    let b = vec4f(d < vec4f(z - slack));
    blockers += b.x + b.y + b.z + b.w;
    dsum += dot(b, vec4f(z) - d);
  }
  if (blockers == 0.0) { return 1.0; }
  if (blockers == 32.0) { return 0.0; }
  // Penumbra radius, texels: blocker distance (m) x tan(sun radius) / texel (m).
  let r = min(dsum / blockers * fr.shadowSoft.z * fr.shadowSoft.x / fr.shadowParams.z, fr.shadowSoft.y);
  if (r < 1.5) { return shadowPcf(uv, depth); }
  var sum = 0.0;
  for (var i = 0; i < 12; i++) {
    let o = turn(PCSS_TAPS[i], cs) * (r * fr.shadowParams.w);
    sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, depth + dot(g, o));
  }
  return sum / 12.0;
}

// Back faces skip the lookup (their N.L is 0 anyway).
fn sunShadow(rel: vec3f, n: vec3f, NoL: f32) -> f32 {
  if (NoL <= 0.0) { return 0.0; }
  return shadowSoft(rel, n) * NoL;
}

// In-scattered radiance (rgb) and green transmittance (a) along the view ray in direction dir (unit).
fn skyLut(dir: vec3f) -> vec4f {
  return textureSampleLevel(skyViewTex, skySamp, skyViewUv(dir, fr.sun, fr.atmoEyeKm), 0.0);
}

fn rot90(v: vec2f, k: u32) -> vec2f {
  switch k {
    case 0u: { return v; }
    case 1u: { return vec2f(-v.y, v.x); }
    case 2u: { return -v; }
    default: { return vec2f(v.y, -v.x); }
  }
}

// A block face's stone (materials.ts): its texture placed at the face's
// body-local position, shifted and turned by a hash of (slot, face) so no two
// faces show the same patch. pxM: metres per pixel there (unclamped, see
// stoneLodDepth); the texture fades out from half the fade footprint to all
// of it. dn: the normal map's tilt in body-local space,
// to add to the face (or bevel) normal; nLen: the mip-averaged normal's
// length, < 1 where bumps average out (Toksvig).
// Wood (materials.ts WOOD, REAL_WOOD): the grain runs along the block's
// longest axis G (x on ties). Faces along it sample the layer WOOD_STRETCH
// times longer along G, so its noise reads as fibres, flipped and shifted by
// a hash; end faces sample it unstretched at half strength, darker and
// rougher (open end grain). The growth rings (woodRings) are 3D, so end faces
// show arcs and the long faces stripes and arches, matching at the edges.
// Like stoneAt, everything fades to the uniform hit (albedo 1, roughness 0.8)
// by the fade-out footprint, so the far boxes (REAL_STONE off) match.
fn woodAt(slot: u32, lp: vec3f, faceN: vec3f, half: vec3f, pxM: f32) -> StoneHit {
  let gx = half.x >= half.y && half.x >= half.z;
  let gy = !gx && half.y >= half.z;
  let G = select(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), gy), vec3f(1.0, 0.0, 0.0), gx);
  let A = select(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), gy), vec3f(0.0, 1.0, 0.0), gx);
  let B = cross(G, A);
  let h = pcg3d(vec3u(slot, 0x3779u, 0x9e3du));
  let tile = ${MATERIAL_TILE.toFixed(1)} * fr.stone.y;
  let detail = fr.stoneDetail.x * (1.0 - smoothstep(0.5 * fr.stoneDetail.y, fr.stoneDetail.y, pxM));
  let rings = woodRings(vec3f(dot(lp, A), dot(lp, B), dot(lp, G)), h, ${WOOD_RING_M / MATERIAL_TILE} * tile, pxM);
  let endGrain = abs(dot(faceN, G)) > 0.5;
  // Texture axes: along the grain and across it on the long faces, the cross-section's on the ends.
  let fl = vec2f(select(-1.0, 1.0, (h.x & 1u) == 0u), select(-1.0, 1.0, (h.x & 2u) == 0u));
  let U = select(G, A, endGrain) * fl.x;
  let V = select(cross(faceN, G), B, endGrain) * fl.y;
  let stretch = select(${WOOD_STRETCH.toFixed(1)}, 1.0, endGrain);
  let off = vec2f(f32(h.y), f32(h.z)) * NOISE_U;
  let uv = vec2f(dot(lp, U) / (stretch * tile), dot(lp, V) / tile) + off;
  let d = textureSample(stoneDetail, stoneSamp, uv, ${WOOD});
  let nm = textureSample(stoneNormal, stoneSamp, uv, ${WOOD});
  let tn = nm.xyz * 2.0 - 1.0;
  let len = max(length(tn), 1e-4);
  let t = vec2f(tn.x / stretch, tn.y) / max(tn.z, 0.2);
  let k = select(1.0, 0.5, endGrain) * detail;
  let albedo = mix(vec3f(1.0), d.rgb * 2.0, k) * mix(1.0, rings.x, detail) * select(1.0, mix(1.0, 0.82, detail), endGrain);
  let rough = mix(0.8, d.a - 0.05 * rings.y + select(0.0, 0.1, endGrain), detail);
  return StoneHit(albedo, rough, (U * t.x + V * t.y) * k, mix(1.0, nm.a, k), mix(1.0, min(len, 1.0), k));
}

struct StoneHit { albedo: vec3f, rough: f32, dn: vec3f, cavity: f32, nLen: f32 }
fn stoneAt(slot: u32, lp: vec3f, faceN: vec3f, half: vec3f, pxM: f32) -> StoneHit {
  if (!REAL_STONE || fr.stoneDetail.x <= 0.0) { return StoneHit(vec3f(1.0), 0.8, vec3f(0.0), 1.0, 1.0); } // uniform: skips both samples
  if (REAL_WOOD) { return woodAt(slot, lp, faceN, half, pxM); }
  let ax = abs(faceN);
  let T = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), ax.x > 0.5);
  let B = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0), ax.y > 0.5);
  let faceId = u32(dot(ax, vec3f(0.0, 2.0, 4.0))) + select(0u, 1u, dot(faceN, vec3f(1.0)) > 0.0);
  let h = pcg3d(vec3u(slot, faceId, 0x5ea1u));
  let k = h.x & 3u;
  let uv = rot90(vec2f(dot(lp, T), dot(lp, B)) / (${MATERIAL_TILE.toFixed(1)} * fr.stone.y), k) + vec2f(f32(h.y), f32(h.z)) * NOISE_U;
  let layer = i32(fr.stone.x);
  let detail = fr.stoneDetail.x * (1.0 - smoothstep(0.5 * fr.stoneDetail.y, fr.stoneDetail.y, pxM));
  let d = textureSample(stoneDetail, stoneSamp, uv, layer);
  let nm = textureSample(stoneNormal, stoneSamp, uv, layer);
  let tn = nm.xyz * 2.0 - 1.0;
  let len = max(length(tn), 1e-4);
  let t = rot90(tn.xy, (4u - k) & 3u) / max(tn.z, 0.2);
  return StoneHit(mix(vec3f(1.0), d.rgb * 2.0, detail), mix(0.8, d.a, detail), (T * t.x + B * t.y) * detail, mix(1.0, nm.a, detail), mix(1.0, min(len, 1.0), detail));
}

// A block's base colour in the real look: one of the stone's five palette
// colours (the ramp) per block, a little lightness jitter, the tower's hue step.
fn realAlbedo(look: u32, slot: u32) -> vec3f {
  let h = pcg3d(vec3u(slot, 0x77u, 0xc01u));
  var lab = rampKey(h.x % 5u);
  let hue = (f32((look >> 8u) & 0xfu) - 2.5) * fr.hueStep;
  let c = cos(hue);
  let s = sin(hue);
  lab = vec3f(lab.x * (1.0 + (f32(h.y >> 16u) / 65535.0 - 0.5) * 0.08), c * lab.y - s * lab.z, s * lab.y + c * lab.z);
  return max(oklabToLinear(lab), vec3f(0.0));
}

// Radiance of the blocks a surface sees where they hide the sky: walls of
// the blocks' mean albedo, lit by the sun at its elevation averaged over the
// walls' compass directions (the mean of max(cos, 0) is 1/pi), and by half
// the sky and half the ground. Neither their shadows on each other nor
// their tops count; sky lighting (realism step 2) replaces this.
fn realBounce() -> vec3f {
  let cosE = sqrt(max(1.0 - fr.sun.y * fr.sun.y, 0.0));
  return fr.blockAlbedo.rgb * (fr.sunColor * cosE / PI + 0.5 * atmoAmbient[0].rgb + 0.5 * atmoAmbient[1].rgb);
}

// The floor's sky view factor (FLOOR_SKY_WGSL), baked per frame into
// aoFloorSky over the AO grid and the cones' reach; past it, open sky.
fn floorSky(rel: vec3f) -> f32 {
  let av = aoView();
  if (av.on == 0.0) { return 1.0; }
  if (!FLOOR_CONES) { return aoAt(av, rel, vec3f(0.0, 1.0, 0.0), rel, vec3f(0.0)).y; }
  let uv = (rel.xz - fr.aoFloorSky.xy) * fr.aoFloorSky.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  return textureSampleLevel(aoFloorSkyTex, aoSamp, uv, 0.0).r;
}

// The ground (realism step 4): its material (materials.ts) at two scales,
// the second ${GROUND_B}x coarser and turned 0.6 rad so their repeats never
// line up, blended by the macro layer, which also varies brightness and
// tint from tens of metres down to about one, lays patches of the other
// ground (at a third scale, 1.37x) and a gentle relief the low sun picks
// out (after Will's high-camera screenshot, 2026-10-27: one coarse layer
// read as a blurred low-res texture). Texture 0 (or REAL_GROUND false) is
// the flat floor, with nothing sampled. a: GGX alpha, Toksvig-widened where the
// mips (and the blend) average bumps away.
struct GroundHit { albedo: vec3f, a: f32, n: vec3f, cavity: f32 }
const GROUND_ROT = mat2x2f(0.8253356, 0.5646425, -0.5646425, 0.8253356);
const MACRO_MIN_LOD = 2.0; // the macro layer's finest level: 0.5 m texels at scale 1

// The macro layer at three scales (MACRO_TILE, 1/4.7 and 1/22 of it, each
// turned so the repeats never line up), for a footprint of pxM metres: a
// 1/f mix from tens of metres down to about one, the scale the 2 m ground
// tile averages away at a distance. Brightness and tint (tone), two
// weights: the coarse scale's (b) and the patches of the other ground
// (other: dirt in gravel, gravel in dirt), where the two finer scales'
// mean passes fr.groundShape.y (materials.ts patchThreshold), with edges
// that stay a few pixels wide; and the relief h (metres): hollows where
// the patches gather, rises between, fr.groundShape.x deep at the coarse
// scale and half that at the next, read from coarse levels (2 m texels)
// so it stays a gentle swell, not the finer octaves' grain, through a
// cubic B-spline: bilinear's slope jumps at every texel, which the low
// sun showed as a grid of flat facets. Faded out past 1 m pixels, where
// it would only alias.
struct Macro { tone: vec3f, b: f32, other: f32, h: f32 }

// The macro layer's b at mip level lod (a whole number) through a cubic
// B-spline, smooth in value and slope: four bilinear taps (Sigg and
// Hadwiger, GPU Gems 2 ch. 20).
fn macroSmooth(uv: vec2f, lod: f32) -> f32 {
  let n = f32(${MATERIAL_SIZE}u >> u32(lod));
  let t = uv * n - 0.5;
  let i = floor(t);
  let f = t - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = 1.0 - g0;
  let a = (i - 0.5 + w1 / g0) / n;
  let c = (i + 1.5 + w3 / g1) / n;
  let s = vec4f(
    textureSampleLevel(stoneDetail, stoneSamp, a, ${MACRO_LAYER}, lod).b,
    textureSampleLevel(stoneDetail, stoneSamp, vec2f(c.x, a.y), ${MACRO_LAYER}, lod).b,
    textureSampleLevel(stoneDetail, stoneSamp, vec2f(a.x, c.y), ${MACRO_LAYER}, lod).b,
    textureSampleLevel(stoneDetail, stoneSamp, c, ${MACRO_LAYER}, lod).b);
  return mix(mix(s.x, s.y, g1.x), mix(s.z, s.w, g1.x), g1.y);
}
const MACRO_R1 = mat2x2f(0.4535961, 0.8912074, -0.8912074, 0.4535961);
const MACRO_R2 = mat2x2f(-0.6662760, 0.7457052, -0.7457052, -0.6662760);
fn macroAt(uv: vec2f, sizeM: f32, pxM: f32, minLod: f32) -> vec4f {
  let lod = clamp(log2(pxM * ${MATERIAL_SIZE.toFixed(1)} / sizeM), minLod, ${(MATERIAL_MIPS - 1).toFixed(1)});
  return textureSampleLevel(stoneDetail, stoneSamp, uv, ${MACRO_LAYER}, lod);
}
fn groundMacro(p: vec2f, pxM: f32) -> Macro {
  let size = ${MACRO_TILE.toFixed(1)} * fr.ground.y;
  let uv0 = p / size + vec2f(0.31, 0.17);
  let m0 = macroAt(uv0, size, pxM, MACRO_MIN_LOD);
  let uv1 = MACRO_R1 * p / (size / 4.7) + vec2f(0.77, 0.05);
  let m1 = macroAt(uv1, size / 4.7, pxM, 3.5);
  let m2 = macroAt(MACRO_R2 * p / (size / 22.0) + vec2f(0.13, 0.59), size / 22.0, pxM, 4.0);
  let v = fr.ground.w;
  let br = 0.5 * (m0.r - 0.5) + 0.35 * (m1.r - 0.5) + 0.25 * (m2.r - 0.5);
  let tint = 0.6 * (m0.g - 0.5) + 0.4 * (m1.g - 0.5);
  let edge = max(0.06, 2.0 * pxM / size * 22.0);
  let pf = 0.55 * m1.b + 0.45 * m2.b;
  let at = fr.groundShape.y;
  let other = smoothstep(at - edge, at + edge, pf);
  var h = 0.0;
  if (fr.groundShape.x > 0.0) { // uniform: no relief, no taps
    // Faded out as pixels pass a quarter to a half of the coarse relief's texel (size / 32: 2 m at scale 1).
    h = -fr.groundShape.x * (1.0 - smoothstep(0.25, 0.5, pxM / (size / 32.0))) * ((macroSmooth(uv0, 4.0) - 0.5) + 0.5 * (macroSmooth(uv1, 6.0) - 0.5));
  }
  return Macro((1.0 + v * 2.0 * br * 0.5) * (1.0 + 0.1 * v * 2.0 * tint * vec3f(1.0, 0.0, -1.0)), smoothstep(0.3, 0.7, m0.b), other, h);
}

// The ground at world xz p; w: fwidth(p).
fn groundAt(p: vec2f, w: vec2f) -> GroundHit {
  if (!REAL_GROUND || fr.ground.z <= 0.0) { return GroundHit(vec3f(1.0), 0.36, vec3f(0.0, 1.0, 0.0), 1.0); } // uniform: skips every sample
  let layer = i32(fr.ground.x);
  let other = ${GROUND_LAYER} + (layer - ${GROUND_LAYER} + 1) % ${GROUNDS.length};
  let tile = ${GROUND_TILE.toFixed(1)} * fr.ground.y;
  let uvA = p / tile;
  let uvB = GROUND_ROT * p / (tile * ${GROUND_B}) + vec2f(0.43, 0.71);
  let uvC = MACRO_R1 * p / (tile * 1.37) + vec2f(0.21, 0.37);
  let dA = textureSample(stoneDetail, stoneSamp, uvA, layer);
  let nA = textureSample(stoneNormal, stoneSamp, uvA, layer);
  let dB = textureSample(stoneDetail, stoneSamp, uvB, layer);
  let nB = textureSample(stoneNormal, stoneSamp, uvB, layer);
  let dC = textureSample(stoneDetail, stoneSamp, uvC, other);
  let nC = textureSample(stoneNormal, stoneSamp, uvC, other);
  let mac = groundMacro(p, max(w.x, w.y));
  let k = fr.ground.z;
  let b = mac.b;
  let q = mac.other;
  // uvB = R p, so B's slope in p is R^T times its slope in uv; likewise C.
  let tB = nB.xyz * 2.0 - 1.0;
  let tC = nC.xyz * 2.0 - 1.0;
  let t = mix(mix(nA.xyz * 2.0 - 1.0, vec3f(transpose(GROUND_ROT) * tB.xy, tB.z), b), vec3f(transpose(MACRO_R1) * tC.xy, tC.z), q);
  let len = mix(1.0, min(max(length(t), 1e-4), 1.0), k);
  let slope = t.xy / max(t.z, 0.2) * k;
  let rough = mix(0.6, mix(mix(dA.a, dB.a, b), dC.a, q), k);
  let a = sqrt(min(rough * rough * rough * rough + 2.0 * (1.0 - len) / len, 1.0));
  let alb = mix(mix(dA.rgb, dB.rgb, b), dC.rgb, q) * 2.0;
  // The relief's slope g in world xz from screen derivatives, [dp/dx; dp/dy] g = [dh/dx; dh/dy]:
  // free next to the samples, and exact enough: h is smooth over a 2x2 quad.
  let px = dpdx(p);
  let py = dpdy(p);
  let det = px.x * py.y - px.y * py.x;
  let hx = dpdx(mac.h);
  let hy = dpdy(mac.h);
  let g = select(vec2f(0.0), vec2f(hx * py.y - hy * px.y, px.x * hy - py.x * hx) / det, abs(det) > 1e-12);
  return GroundHit(mix(vec3f(1.0), alb, k) * mac.tone, a, normalize(vec3f(slope.x - g.x, 1.0, slope.y - g.y)), mix(1.0, mix(mix(nA.a, nB.a, b), nC.a, q), k));
}

// The ground past the floor polygon (fsSky, non-uniform control flow, so no
// implicit derivatives), for a footprint of pxM metres: what groundAt gives
// where the texture has mipped down to its mean (its 1x1 level), under the
// same macro variation and patches (no relief: flat to a pixel this far).
fn groundFar(p: vec2f, pxM: f32) -> GroundHit {
  if (!REAL_GROUND || fr.ground.z <= 0.0) { return GroundHit(vec3f(1.0), 0.36, vec3f(0.0, 1.0, 0.0), 1.0); }
  let layer = i32(fr.ground.x);
  let other = ${GROUND_LAYER} + (layer - ${GROUND_LAYER} + 1) % ${GROUNDS.length};
  let mac = groundMacro(p, pxM);
  let top = ${(MATERIAL_MIPS - 1).toFixed(1)};
  let d = mix(textureSampleLevel(stoneDetail, stoneSamp, vec2f(0.5), layer, top), textureSampleLevel(stoneDetail, stoneSamp, vec2f(0.5), other, top), mac.other);
  let n = mix(textureSampleLevel(stoneNormal, stoneSamp, vec2f(0.5), layer, top), textureSampleLevel(stoneNormal, stoneSamp, vec2f(0.5), other, top), mac.other);
  let k = fr.ground.z;
  let len = mix(1.0, min(max(length(n.xyz * 2.0 - 1.0), 1e-4), 1.0), k);
  let rough = mix(0.6, d.a, k);
  let a = sqrt(min(rough * rough * rough * rough + 2.0 * (1.0 - len) / len, 1.0));
  return GroundHit(mix(vec3f(1.0), d.rgb * 2.0, k) * mac.tone, a, vec3f(0.0, 1.0, 0.0), mix(1.0, n.a, k));
}

// Hills on the horizon (realism step 4): a ridge at most hills.x radians
// high, hills.y metres away, its profile a sum of sines in azimuth (so it
// closes on itself). Their slopes face the eye, tilted 27 degrees, and turn
// sideways with the profile's own slope, so a low sun picks out the folds;
// lit by the sun and the ambient light in the floor's albedo, seen through
// hills.y metres of air. rgb, and coverage (the ridge antialiased over a
// pixel). Most sky pixels are above every ridge and return at once.
fn hillsAt(dir: vec3f, pxA: f32) -> vec4f {
  if (dir.y > sin(fr.hills.x) + pxA) { return vec4f(0.0); }
  let az = atan2(dir.x, -dir.z);
  let H = fr.hills.x;
  let ridge = H * (0.55 + 0.2 * sin(3.0 * az + 1.3) + 0.15 * sin(7.0 * az + 0.4) + 0.07 * sin(13.0 * az + 2.1) + 0.03 * sin(29.0 * az + 0.7));
  let cover = 1.0 - smoothstep(ridge - pxA, ridge + pxA, asin(clamp(dir.y, -1.0, 1.0)));
  if (cover <= 0.0) { return vec4f(0.0); }
  // d ridge / d azimuth: the hillside's slope across the line of sight (height and width both scale with the distance).
  let lateral = H * (0.6 * cos(3.0 * az + 1.3) + 1.05 * cos(7.0 * az + 0.4) + 0.91 * cos(13.0 * az + 2.1) + 0.87 * cos(29.0 * az + 0.7));
  let back = -dir.xz / max(length(dir.xz), 1e-6);
  let down = vec2f(-back.y, back.x); // toward decreasing azimuth: downhill where lateral > 0
  // The profile's slope is the silhouette's, gentler than the slopes in front of it: 8x.
  let tilt = 0.5 * back + 8.0 * lateral * down;
  let n = normalize(vec3f(tilt.x, 1.0, tilt.y));
  let lit = fr.floor * (mix(atmoAmbient[1].rgb, atmoAmbient[0].rgb, n.y * 0.5 + 0.5) + fr.sunColor * max(dot(n, fr.sun), 0.0));
  return vec4f(fog(lit, dir * fr.hills.y), cover);
}

// Aerial perspective: the surface through d metres of air. The LUT holds
// the in-scattering along the whole ray (to the ground or space) and that
// ray's transmittance; the part within d is scaled by the optical depth
// covered, exact for uniform air with a uniform source, and equal to the
// sky itself at the horizon.
fn aerial(c: vec3f, rel: vec3f) -> vec3f {
  let d = length(rel);
  let s = skyLut(rel / max(d, 1e-6));
  let T = exp(-fr.atmoSigma * d);
  return c * T + s.rgb * min((1.0 - T.g) / max(1.0 - s.a, 1e-4), 1.0);
}
`;

// Debris (realism step 6, sparks.ts debris mode): dust puffs and stone
// chips from impacts, in place of sparks. Puffs are camera-facing quads,
// alpha-blended (premultiplied) and unsorted: similar low-alpha puffs show
// no ordering errors. Each is lit once, in the vertex shader: the sun
// through one shadow tap, scattered forward (half Henyey-Greenstein, g
// 0.4, half isotropic for the multiple scattering of a thick cloud), and
// the sky and ground's ambient, then seen through the air (aerial).
// Its fragments fade out within half a radius above the ground, so a
// puff's foot never shows the floor's edge and nothing draws below it.
// Chips are small opaque quads with a tumbling normal, shaded like the
// blocks and darker (small broken stone is in its own shade), resting on
// the ground rather than through it; CHIP_BASE is where their ring starts
// in the pool.
const REAL_DEBRIS_WGSL = /* wgsl */ `
override CHIP_BASE: u32 = 0u;
struct DustOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) rel: vec3f,
  @location(2) @interpolate(flat) colour: vec4f, // lit rgb, opacity
  @location(3) @interpolate(flat) size: vec2f,   // radius m, noise offset
}

fn hg4pi(c: f32, g: f32) -> f32 {
  return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
}

// Camera-facing corner offset (m) of a quad of radius r at rel, turned by angle a.
fn facing(rel: vec3f, corner: vec2f, r: f32, a: f32) -> vec3f {
  let f = normalize(rel);
  let right = normalize(select(cross(f, vec3f(0.0, 1.0, 0.0)), vec3f(1.0, 0.0, 0.0), abs(f.y) > 0.999));
  let up = cross(right, f);
  let c = vec2f(corner.x * cos(a) - corner.y * sin(a), corner.x * sin(a) + corner.y * cos(a));
  return (right * c.x + up * c.y) * r;
}

const QUAD = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

@vertex fn vsDust(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> DustOut {
  var o: DustOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0); // outside the depth range: clipped
  o.uv = vec2f(0.0);
  o.rel = vec3f(0.0);
  o.colour = vec4f(0.0);
  o.size = vec2f(1.0, 0.0);
  let s = sparks[ii];
  if (s.age < 0.0) { return o; }
  let t = s.age / dustLife(s.packed);
  let seed = unit(s.packed);
  // Grows (ease-out) to dustSize, 0.5x for the softest hits to 2x for the hardest (size class in bits 8-11).
  let r = fr.debris.x * mix(0.13, 1.0, 1.0 - pow(1.0 - t, 3.0)) * (0.7 + 0.6 * seed) * mix(0.5, 2.0, f32((s.packed >> 8u) & 0xfu) / 15.0);
  let rel = s.pos - fr.eye;
  let lc = fr.lightViewProj * vec4f(rel, 1.0);
  let suv = lc.xy * vec2f(0.5, -0.5) + 0.5;
  let inside = all(suv > vec2f(0.0)) && all(suv < vec2f(1.0)) && lc.z < 1.0;
  let vis = select(1.0, textureSampleCompareLevel(shadowMap, shadowSampler, suv, lc.z - fr.shadowParams.y), inside);
  // Stone powder, lighter than the blocks, or soil raised by a landing (bit 12), lighter than the ground;
  // a thick cloud scatters many times, so half its phase is isotropic.
  let albedo = select(mix(fr.blockAlbedo.rgb, fr.floor, 0.3) * 1.1, mix(fr.blockAlbedo.rgb, fr.floor, 0.7) * 1.2, ((s.packed >> 12u) & 1u) == 1u);
  let lit = albedo * (fr.sunColor * vis * 0.5 * (0.5 + 0.5 * hg4pi(dot(fr.sun, normalize(rel)), 0.4)) + 0.5 * (atmoAmbient[0].rgb + atmoAmbient[1].rgb));
  let alpha = fr.debris.y * mix(0.5, 1.0, fract(seed * 13.7)) * pow(1.0 - t, 1.5) * smoothstep(0.0, 0.06, t);
  let corner = QUAD[vi];
  let p = rel + facing(rel, corner, r, 6.2831853 * fract(seed * 7.13) + s.age * (seed - 0.5));
  o.clip = fr.viewProj * vec4f(p, 1.0);
  o.uv = corner;
  o.rel = p;
  o.colour = vec4f(aerial(lit, rel), alpha);
  o.size = vec2f(r, fract(seed * 31.7));
  return o;
}

@fragment fn fsDust(o: DustOut) -> @location(0) vec4f {
  let d2 = dot(o.uv, o.uv);
  if (d2 >= 1.0) { discard; }
  // Billowing: the macro layer's smooth fields as density, a different patch per puff.
  let n = textureSampleLevel(stoneDetail, stoneSamp, o.uv * 0.06 + vec2f(o.size.y, fract(o.size.y * 7.0)), ${MACRO_LAYER}, 0.0);
  let density = (1.0 - d2) * (1.0 - d2) * (0.45 + 1.1 * n.b);
  let h = o.rel.y + fr.eye.y - fr.groundY;
  let a = clamp(o.colour.a * density * smoothstep(0.0, 0.5 * o.size.x, h), 0.0, 1.0);
  return vec4f(o.colour.rgb * a, a);
}

struct ChipOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) rel: vec3f,
  @location(2) @interpolate(flat) n: vec3f,
  @location(3) @interpolate(flat) base: vec4f, // albedo, shape seed
}

@vertex fn vsChip(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ChipOut {
  var o: ChipOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
  o.uv = vec2f(0.0);
  o.rel = vec3f(0.0);
  o.n = vec3f(0.0, 1.0, 0.0);
  o.base = vec4f(0.0);
  let s = sparks[CHIP_BASE + ii];
  if (s.age < 0.0) { return o; }
  let t = s.age / chipLife(s.packed);
  let h = pcg(s.packed);
  let seed = unit(s.packed);
  let r = fr.debris.z * (0.5 + unit(h)) * (1.0 - smoothstep(0.8, 1.0, t));
  // Tumbling while it flies, still once it rests on the ground.
  let spin = (8.0 + 10.0 * unit(pcg(h))) * min(length(s.vel), 3.0);
  let a1 = 6.2831853 * seed + s.age * spin;
  let a2 = 6.2831853 * unit(h) + s.age * spin * 0.7;
  o.n = normalize(vec3f(sin(a1) * cos(a2), abs(cos(a1)) + 0.2, sin(a1) * sin(a2)));
  // Lifted so the quad's lowest corner (turned: r sqrt 2) stays on the ground.
  let rel = s.pos - fr.eye + vec3f(0.0, max(1.42 * r - (s.pos.y - fr.groundY), 0.0), 0.0);
  let corner = QUAD[vi];
  let p = rel + facing(rel, corner, r, a1 * 0.3);
  o.clip = fr.viewProj * vec4f(p, 1.0);
  o.uv = corner;
  o.rel = p;
  o.base = vec4f(fr.blockAlbedo.rgb * (0.45 + 0.4 * unit(pcg(h + 1u))), unit(pcg(h + 2u)));
  return o;
}

@fragment fn fsChip(o: ChipOut) -> @location(0) vec4f {
  // An irregular chip: a square and a diamond mixed per chip, cut at a hashed corner.
  let q = abs(o.uv);
  let k = 0.3 + 0.5 * o.base.w;
  if (mix(max(q.x, q.y), q.x + q.y, k) > 0.85 || (o.uv.x + o.uv.y > 1.1 - 0.6 * o.base.w)) { discard; }
  fragPx = o.clip.xy;
  let c = shade(o.base.rgb, o.rel, o.n, 0.5, 0.5, 0.0, vec2f(1.0));
  return vec4f(fog(c, o.rel), 1.0);
}
`;

// The real look's specular (shade): the clearcoat lobe only where there is a
// coat (the ball), so blocks and floor skip its sky LUT sample.
const REAL_SPEC = /* wgsl */ `  var spec = ggx(NoH, a) * smithVis(NoV, NoL, a);
  var reflections = env(R, sqrt(a)) * envBrdf(0.04, sqrt(a), NoV);
  if (coat > 0.0) {
    spec += coat * ggx(NoH, ac) * smithVis(NoV, NoL, ac);
    reflections += coat * env(R, sqrt(ac)) * envBrdf(0.04, sqrt(ac), NoV);
  }
  spec *= F * PI;`;

// The real look's ambient (shade). Contact darkening is the floor hiding
// the lower view of what stands on it, so a surface facing up (the floor
// itself) takes none of it; the stylized looks darken the floor too.
const REAL_CONTACT = 'mix(0.5 + 0.5 * smoothstep(0.0, 1.5, rel.y + fr.eye.y - fr.groundY), 1.0, max(n.y, 0.0))';
// Where the AO volume hides the sky, the surface sees blocks instead, and
// they are not black: realBounce, until sky lighting lands (realism step 2).
const REAL_SKY_AMBIENT = 'atmoAmbient[0].rgb * ao.y + realBounce() * (1.0 - ao.y)';

// The real look's block (realism step 3): stone texture and relief, a palette
// colour per block, chipped lighter edges, dirt toward the ground. Injected at
// the top of fsBox; the stylized body after it runs only when REAL_BLOCK is false.
const REAL_FS_BOX = /* wgsl */ `fragPx = v.clip.xy;
  if (REAL_BLOCK) {
    let lp = clamp(v.local, vec3f(-1.0), vec3f(1.0)) * v.half;
    let pxM = length(fwidth(lp));
    let faceN = boxFace(v.local, fwidth(v.local));
    let aoPxM = length(fwidth(v.local * v.half));
    let st = stoneAt(v.slot, lp, faceN, v.half, aoPxM);
    let n = qrot(v.rot, normalize(bevelNormal(lp, faceN, v.half, pxM, fr.bevel) + st.dn));
    let dndx = dpdx(n);
    let dndy = dpdy(n);
    let w = fx[v.slot];
    let d3 = v.half - abs(lp);
    let edgeM = max(min(d3.x, d3.y), min(max(d3.x, d3.y), d3.z));
    // Wear: within 1-4 cm of an edge, further where the stone is pitted, fresh (lighter, rougher) stone shows.
    let wear = fr.stone.z * (1.0 - smoothstep(0.0, 0.01 + 0.03 * (1.0 - st.cavity) + 0.01 * fr.stone.z, edgeM));
    let y = v.rel.y + fr.eye.y - fr.groundY;
    let dirt = fr.stone.w * (1.0 - smoothstep(0.0, 2.5, y));
    var base = realAlbedo(v.look, v.slot) * st.albedo * mix(1.0, st.cavity, 0.6) * fxTint(w.x);
    base = mix(base, base * 1.2, wear) * (1.0 - 0.35 * dirt);
    // Toksvig: bumps averaged away by the mips widen the lobe instead.
    let a = st.rough * st.rough;
    let aT = sqrt(min(a * a + 2.0 * (1.0 - st.nLen) / st.nLen, 1.0));
    let alpha = min(aT + 0.1 * wear, 1.0);
    let wPx = SEAM / max(pxM, 1e-6);
    let drawn = max(wPx, 0.75);
    let seam = 1.0 - 0.4 * min(1.0, wPx / 0.75) * (1.0 - smoothstep(drawn - 0.5, drawn + 0.5, edgeM / max(pxM, 1e-6)));
    var c = shade(base * seam, v.rel, n, aaAlpha(alpha, n, dndx, dndy), aaAlpha(0.0049, n, dndx, dndy), 0.0, aoBox(v, n, lp, faceN, aoPxM));
    c += base * seam * fxGlow(w, fr.time);
    return vec4f(fog(c, v.rel), 1.0);
  }
  `;

// The exhibition hall (hall.ts, look.hall), around the scene while the eye
// is inside it: a full-screen triangle whose fragments trace the hall from
// the eye (in metres, its floor centre at the world's origin) and write the
// hit's depth, so bodies and the hall hide each other where they should.
// Drawn after the sky, glazing premultiplied over it: glass transmits
// HALL_GLASS_T, milky glass (hallLook.z) glows with the sky and sun on its
// outer face instead, and glazing bars and purlins, antialiased, are iron.
// Lit by ambient light only until the hall's own lighting (Kapla step K3.2b):
// the sky through the vault's glazed share above, the floor's radiance below.
// Rays at the floor miss the hall and are discarded (the floor pass drew it).
const REAL_HALL_WGSL = /* wgsl */ `
struct HallOut { @location(0) colour: vec4f, @builtin(frag_depth) depth: f32 }

const HALL_PANEL = vec3f(0.5, 0.47, 0.42);
const HALL_WALL = vec3f(0.42, 0.36, 0.3);
const HALL_RAIL = vec3f(0.2, 0.045, 0.035);
const HALL_IRON_TINT = vec3f(0.93, 0.97, 1.0);
const HALL_GLASS_T = 0.8;

// Coverage of lines w wide every s at x (all m) over a pixel pxM wide:
// antialiased, and their mean cover w / s once they are under a pixel.
fn hallLines(x: f32, s: f32, w: f32, pxM: f32) -> f32 {
  let d = abs(fract(x / s + 0.5) - 0.5) * s;
  let cover = clamp((0.5 * w - d) / max(pxM, 1e-6) + 0.5, 0.0, 1.0);
  return mix(cover, w / s, smoothstep(0.25 * s, s, pxM));
}

@fragment fn fsHall(s: SOut) -> HallOut {
  let p = fr.invViewProj * vec4f(s.ndc, 1.0, 1.0);
  let dir = normalize(p.xyz / p.w);
  let pxA = length(fwidth(dir)); // radians per pixel
  let m = fr.hallLook.y;
  let hit = hallTrace(Hall(fr.hall0, fr.hall1, fr.hall2, fr.hall3, fr.hall4, fr.hall5), vec3f(fr.eye.x, fr.eye.y - fr.groundY, fr.eye.z) * m, dir);
  if (hit.mat == ${HALL_MAT.none}u) { discard; }
  let rel = dir * (hit.t / m);
  let clip = fr.viewProj * vec4f(rel, 1.0);
  let n = hit.n;
  let pxM = hit.t * pxA / max(abs(dot(n, dir)), 0.1); // metres per pixel on the surface
  let glazed = HALL_GLASS_T * fr.hall4.z / fr.hall3.w;
  let amb = mix(atmoAmbient[1].rgb, atmoAmbient[0].rgb * glazed, n.y * 0.5 + 0.5);
  let iron = fr.hallLook.w * HALL_IRON_TINT;
  var c = vec4f(0.0, 0.0, 0.0, 1.0);
  switch hit.mat {
    case ${HALL_MAT.glass}u, ${HALL_MAT.lantern}u, ${HALL_MAT.screen}u: {
      // End screens: mullions and transoms; the vault: glazing bars down the slope every 0.6 m, purlins every 2.6 m of arc.
      var bars: f32;
      if (hit.mat == ${HALL_MAT.screen}u) {
        bars = 1.0 - (1.0 - hallLines(hit.uv.x, 1.3, 0.08, pxM)) * (1.0 - hallLines(hit.uv.y, 1.6, 0.08, pxM));
      } else {
        bars = 1.0 - (1.0 - hallLines(hit.uv.y, 0.6, 0.05, pxM)) * (1.0 - hallLines(hit.uv.x * fr.hall3.x, 2.6, 0.15, pxM));
      }
      let milk = fr.hallLook.z;
      let outer = -n; // n faces the eye, inside
      let glow = HALL_GLASS_T * (atmoAmbient[0].rgb * (0.5 + 0.5 * outer.y) + fr.sunColor * max(dot(outer, fr.sun), 0.0));
      let a = bars + (1.0 - bars) * (1.0 - HALL_GLASS_T * (1.0 - milk));
      let rgb = bars * iron * amb + (1.0 - bars) * milk * glow;
      c = vec4f(fog(rgb / a, rel) * a, a);
    }
    default: {
      var base = HALL_WALL;
      if (hit.mat == ${HALL_MAT.iron}u) { base = iron; }
      if (hit.mat == ${HALL_MAT.rail}u) { base = HALL_RAIL; }
      if (hit.mat == ${HALL_MAT.panel}u) { base = HALL_PANEL * (1.0 - 0.3 * hallLines(hit.uv.x * fr.hall3.x, 2.6, 0.15, pxM)); }
      c = vec4f(fog(base * amb, rel), 1.0);
    }
  }
  return HallOut(c, clamp(clip.z / clip.w, 0.0, 1.0));
}
`;


/**
 * The scene shader. real: the variant for looks with an atmosphere (sky,
 * haze and ambient from atmosphere.ts, bind group 1); the other looks use
 * the variant without it, so nothing of the real look reaches them.
 */
export function sceneWgsl(real = false): string {
  return /* wgsl */ `
${wgslStruct(RenderRecord)}
${wgslStruct(Spark)}
${wgslStruct(FxState)}
${SPARK_COMMON}
${AO_FOOT_WGSL}
${wgslStruct(Frame)}
@group(0) @binding(0) var<uniform> fr: Frame;
@group(0) @binding(1) var<storage, read> records: array<RenderRecord>;
@group(0) @binding(2) var<storage, read> lists: array<u32>;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
@group(0) @binding(5) var<storage, read> fx: array<vec4u>;          // per slot, see fx.ts
@group(0) @binding(6) var<storage, read> overlay: array<vec4f>;     // world x, y, z, radius
@group(0) @binding(7) var<storage, read> overlayColour: array<u32>; // sRGB rgb8 + emissive8
@group(0) @binding(8) var<storage, read> sparks: array<Spark>;      // sparks.ts
@group(0) @binding(9) var<uniform> lights: array<vec4f, ${LIGHT_VEC4}>;      // lights.ts: raw slots, meta (heat gain, lit count), packed lit lights
@group(0) @binding(11) var<storage, read> fxState: array<FxState>;   // sparks.ts: heat in bits 0-15
@group(0) @binding(12) var aoVol: texture_3d<f32>;                   // ao.ts: R occupancy, G sky
@group(0) @binding(13) var aoSamp: sampler;
${AO_SAMPLE_WGSL}

fn aoView() -> AoView { return AoView(fr.aoOrigin, fr.aoInvVoxel, fr.aoDims, fr.aoOn, fr.aoK); }
${real ? REAL_WGSL : ''}
@group(0) @binding(14) var<storage, read> aoFeet: array<vec4f>;      // ao.ts: per slot footprint, written by the splat
// Bench diagnostics (RendererOptions.aoDiag 'no-seam'): the seam cavity compiled out.
override AO_SEAM: bool = true;

// AO at a body's surface point, its own footprint subtracted (centre and
// footprint read by slot: on the M5 that measured 2% of the far 100k frame
// cheaper than deriving them from the fragment's inputs, which is exact
// but costs aoFoot's ALU per pixel).
fn aoBody(v: VOut, n: vec3f) -> vec2f {
  let av = aoView();
  if (av.on == 0.0 || v.slot >= fr.capacity) { return vec2f(1.0); }
  return aoAt(av, v.rel, n, records[v.slot].pos, aoFeet[v.slot].xyz);
}
${AO_SEAM_WGSL}

// aoBody plus the seam cavity at a box's edges (lp, face, pxM: body frame, from fsBox).
fn aoBox(v: VOut, n: vec3f, lp: vec3f, face: vec3f, pxM: f32) -> vec2f {
  let av = aoView();
  if (av.on == 0.0 || v.slot >= fr.capacity) { return vec2f(1.0); }
  let c = records[v.slot].pos;
  let foot = aoFeet[v.slot].xyz;
  let a = aoAt(av, v.rel, n, c, foot);
  if (!AO_SEAM) { return a; }
  return vec2f(a.x * aoSeam(av, lp, face, v.half, v.rot, c, foot, pxM), a.y);
}
@group(0) @binding(10) var<storage, read> trail: array<vec4f>;      // lights.ts: world xyz, time

// Which list a pipeline draws: SEG * capacity is its first entry.
override SEG: u32 = 0u;
// Boxes as a 6-triangle fan over the three faces that face the viewer (or
// the light), instead of all 12 triangles.
override FAN: bool = true;

const PI = 3.14159265;
const SEAM = 0.012;
${OKLAB_WGSL}
${BEVEL_WGSL}
${FX_WGSL}

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// Unit-cube corner for vertex vi of 36: face vi/6, two CCW triangles.

fn cubeCorner(vi: u32) -> vec3f {
  let f = vi / 6u;
  let axis = f / 2u;
  let s = select(-1.0, 1.0, f % 2u == 0u);
  let uv = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[vi % 6u];
  var p = vec3f(0.0);
  p[axis] = s;
  p[(axis + 1u) % 3u] = uv.x;
  p[(axis + 2u) % 3u] = uv.y * s;
  return p;
}

// The hexagon fan: around the box's corner nearest the viewer, s * (1,1,1)
// with s = sign of the viewer in body space, six triangles to the ring of
// the six corners next to it. Each triangle shares a coordinate with that
// corner, so it lies in one of the three faces facing the viewer: depth is
// exact and the three faces are covered once. Mirroring by s flips the
// winding when an odd number of signs is negative; the second and third
// vertices swap back to counter-clockwise.
fn fanCorner(vi: u32, s: vec3f) -> vec3f {
  let ring = array<vec3f, 7>(vec3f(1, 1, -1), vec3f(-1, 1, -1), vec3f(-1, 1, 1), vec3f(-1, -1, 1), vec3f(1, -1, 1), vec3f(1, -1, -1), vec3f(1, 1, 1));
  let t = vi / 3u;
  var k = vi % 3u;
  if (s.x * s.y * s.z < 0.0 && k != 0u) { k = 3u - k; }
  return s * ring[select(select((t + 1u) % 6u, t, k == 1u), 6u, k == 0u)];
}

// Sign per body axis of a direction (body-relative viewer or light).
fn sideOf(rot: vec4f, dir: vec3f) -> vec3f {
  return select(vec3f(-1.0), vec3f(1.0), qrot(vec4f(-rot.xyz, rot.w), dir) >= vec3f(0.0));
}

fn boxCorner(vi: u32, r: RenderRecord, toViewer: vec3f) -> vec3f {
  if (FAN) { return fanCorner(vi, sideOf(r.rot, toViewer)); }
  return cubeCorner(vi);
}

fn sphereCorner(vi: u32) -> vec3f {
  let q = vi / 6u;
  // Counter-clockwise seen from outside: +phi then +theta.
  let d = array<vec2u, 6>(vec2u(0, 0), vec2u(1, 1), vec2u(0, 1), vec2u(0, 0), vec2u(1, 0), vec2u(1, 1))[vi % 6u];
  let i = q % ${SPHERE_SEG}u + d.x;
  let j = q / ${SPHERE_SEG}u + d.y;
  let theta = f32(j) / ${SPHERE_RINGS}.0 * PI;
  let phi = f32(i) / ${SPHERE_SEG}.0 * 2.0 * PI;
  return vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
}

fn record(ii: u32) -> RenderRecord {
  return records[lists[SEG * fr.capacity + ii]];
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) rel: vec3f,
  @location(1) local: vec3f,
  @location(2) @interpolate(flat) rot: vec4f,
  @location(3) @interpolate(flat) half: vec3f,
  @location(4) @interpolate(flat) look: u32,
  @location(5) @interpolate(flat) slot: u32,
}

fn place(r: RenderRecord, corner: vec3f) -> VOut {
  let rel = r.pos + qrot(r.rot, corner * r.half);
  var o: VOut;
  o.clip = fr.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  o.local = corner;
  o.rot = r.rot;
  o.half = r.half;
  o.look = r.look;
  o.slot = r.slot;
  return o;
}

@vertex fn vsBox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let r = record(ii);
  return place(r, boxCorner(vi, r, -r.pos));
}

@vertex fn vsSphere(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  return place(record(ii), sphereCorner(vi));
}

@vertex fn vsBoxShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let r = record(ii);
  return fr.lightViewProj * vec4f(r.pos + qrot(r.rot, boxCorner(vi, r, fr.sun) * r.half), 1.0);
}

@vertex fn vsSphereShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let r = record(ii);
  return fr.lightViewProj * vec4f(r.pos + qrot(r.rot, sphereCorner(vi) * r.half), 1.0);
}

// ---------------------------------------------------------------- lighting

fn shadow(rel: vec3f, n: vec3f) -> f32 {
  let lc = fr.lightViewProj * vec4f(rel + n * fr.shadowParams.x, 1.0);
  let uv = lc.xy * vec2f(0.5, -0.5) + 0.5;
  let depth = lc.z - fr.shadowParams.y;
  let texel = fr.shadowParams.w;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, depth);
    }
  }
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && depth < 1.0;
  return select(1.0, sum / 9.0, inside);
}

fn ggx(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn smithVis(NoV: f32, NoL: f32, a: f32) -> f32 {
  let k = 0.5 * a;
  return 0.25 / ((NoL * (1.0 - k) + k) * (NoV * (1.0 - k) + k));
}

fn schlick(f0: f32, c: f32) -> f32 {
  let m = 1.0 - c;
  let m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}

// Split-sum environment BRDF, analytic fit (Karis 2014).
fn envBrdf(f0: f32, rough: f32, NoV: f32) -> f32 {
  let r = rough * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// A rectangular light panel in direction d, seen along R, blurred by roughness.
fn softbox(R: vec3f, d: vec3f, size: f32, rough: f32) -> f32 {
  let c = dot(R, d);
  let t1 = normalize(cross(d, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(d.y) > 0.9)));
  let t2 = cross(d, t1);
  let uv = abs(vec2f(dot(R, t1), dot(R, t2))) / max(c, 1e-3);
  let soft = 0.03 + rough * 1.2;
  let box = (1.0 - smoothstep(size - soft, size + soft, uv.x)) * (1.0 - smoothstep(0.5 * size - soft, 0.5 * size + soft, uv.y));
  return select(0.0, box / (1.0 + 8.0 * rough * rough), c > 0.0);
}

fn skyColor(dir: vec3f) -> vec3f {
  var c = mix(fr.skyHorizon, fr.skyZenith, sqrt(clamp(dir.y, 0.0, 1.0)));
  let f = normalize(vec3f(fr.focus.x, 0.0, fr.focus.z) + vec3f(1e-4, 0.0, 0.0));
  let h = normalize(vec3f(dir.x, 0.0, dir.z) + vec3f(1e-4, 0.0, 0.0));
  return c + fr.glow * pow(max(dot(h, f), 0.0), 6.0) * exp(-6.0 * abs(dir.y));
}

fn env(R: vec3f, rough: f32) -> vec3f {
  ${real ? /* wgsl */ `// Until sky lighting lands (realism step 2): the sky view, blurred toward the mean sky by roughness, over the ground's radiance.
  let sky = mix(skyLut(normalize(vec3f(R.x, max(R.y, 0.0), R.z))).rgb, atmoAmbient[0].rgb, rough);
  return mix(atmoAmbient[1].rgb, sky, smoothstep(-0.05 - 0.3 * rough, 0.05 + 0.3 * rough, R.y));
}

fn envCandy(R: vec3f, rough: f32) -> vec3f {` : ''}
  var c = select(skyColor(R), mix(fr.skyHorizon, fr.floor * fr.ambSky, min(-4.0 * R.y, 1.0)), R.y < 0.0);
  c += fr.keyColor * softbox(R, fr.keyDir, fr.keySize, rough);
  c += fr.rimColor * softbox(R, fr.rimDir, fr.rimSize, rough);
  return c;
}

fn fog(c: vec3f, rel: vec3f) -> vec3f {
  ${real ? `return aerial(c, rel);
}

fn fogCandy(c: vec3f, rel: vec3f) -> vec3f {` : ''}
  let y = rel.y + fr.eye.y - fr.groundY;
  let density = fr.fogDensity * exp(-max(y, 0.0) * fr.fogHeight);
  return mix(c, fr.skyHorizon, 1.0 - exp(-length(rel) * density));
}

/** Lit colour of an opaque surface. a and ac: GGX alpha of the base and clearcoat lobes. ao: (occlusion, sky visibility) from aoAt. */
fn shade(base: vec3f, rel: vec3f, n: vec3f, a: f32, ac: f32, coat: f32, ao: vec2f) -> vec3f {
  let V = normalize(-rel);
  let NoV = max(dot(n, V), 1e-4);
  let L = fr.sun;
  let NoL = max(dot(n, L), 0.0);
  let sh = ${real ? 'sunShadow(rel, n, NoL)' : 'shadow(rel, n) * NoL'};
  let H = normalize(L + V);
  let NoH = max(dot(n, H), 0.0);
  let VoH = max(dot(V, H), 0.0);
  let F = schlick(0.04, VoH);
  let R = reflect(-V, n);
${real ? REAL_SPEC : `  let spec = (ggx(NoH, a) * smithVis(NoV, NoL, a) + coat * ggx(NoH, ac) * smithVis(NoV, NoL, ac)) * F * PI;
  let reflections = env(R, sqrt(a)) * envBrdf(0.04, sqrt(a), NoV) + coat * env(R, sqrt(ac)) * envBrdf(0.04, sqrt(ac), NoV);`}
  // Ground contact: darker near the floor. The occupancy volume (ao.ts) adds what is nearby; sky visibility dims only the sky light.
  let contact = ${real ? REAL_CONTACT : '0.5 + 0.5 * smoothstep(0.0, 1.5, rel.y + fr.eye.y - fr.groundY)'};
  let occl = contact * ao.x;
  let amb = mix(${real ? 'atmoAmbient[1].rgb' : 'fr.ambGround'}, ${real ? REAL_SKY_AMBIENT : 'fr.ambSky * ao.y'}, n.y * 0.5 + 0.5) * occl;
  return base * (amb + fr.sunColor * sh) + fr.sunColor * spec * sh + reflections * occl + pointLights(base, rel, n, V, a);
}

// Ball and flash lights (lights.ts): diffuse plus the base specular lobe,
// inverse-square falloff windowed to zero at the radius, no shadows.
fn pointLights(base: vec3f, rel: vec3f, n: vec3f, V: vec3f, a: f32) -> vec3f {
  var c = vec3f(0.0);
  let lit = u32(lights[${LIGHT_META}u].y);
  for (var k = 0u; k < lit; k++) {
    let pl = lights[${LIGHT_PACKED}u + 2u * k];
    let col = lights[${LIGHT_PACKED}u + 2u * k + 1u];
    let d = pl.xyz - rel;
    let r2 = dot(d, d);
    let x = r2 / (pl.w * pl.w);
    if (x >= 1.0) { continue; }
    let L = d * inverseSqrt(max(r2, 1e-8));
    let NoL = max(dot(n, L), 0.0);
    let w = (1.0 - x) * (1.0 - x);
    let H = normalize(L + V);
    let spec = ggx(max(dot(n, H), 0.0), a) * smithVis(max(dot(n, V), 1e-4), NoL, a) * 0.04 * PI;
    c += col.rgb * col.w * w / (r2 + 1.0) * NoL * (base + spec);
  }
  return c;
}

// Kaplanyan-Hoffman specular antialiasing: widen alpha by the normal's
// screen-space variation so highlights on distant bevels do not sparkle.
fn aaAlpha(a: f32, n: vec3f, dndx: vec3f, dndy: vec3f) -> f32 {
  return sqrt(a * a + min(2.0 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18));
}

fn rampKey(i: u32) -> vec3f {
  switch i {
    case 0u: { return fr.ramp0.xyz; }
    case 1u: { return fr.ramp1.xyz; }
    case 2u: { return fr.ramp2.xyz; }
    case 3u: { return fr.ramp3.xyz; }
    default: { return fr.ramp4.xyz; }
  }
}

/** Base colour from BodyLook: OKLab ramp by original height, hue offset per tower, small lightness jitter. */
fn albedo(look: u32) -> vec3f {
  let t = f32(look & 0xffu) / 255.0 * 4.0;
  let i = min(u32(t), 3u);
  var lab = mix(rampKey(i), rampKey(i + 1u), t - f32(i));
  let hue = (f32((look >> 8u) & 0xfu) - 2.5) * fr.hueStep;
  let c = cos(hue);
  let s = sin(hue);
  lab = vec3f(lab.x * (1.0 + (f32(look >> 16u) / 65535.0 - 0.5) * 0.08), c * lab.y - s * lab.z, s * lab.y + c * lab.z);
  return max(oklabToLinear(lab), vec3f(0.0));
}

fn material(look: u32) -> u32 { return (look >> 12u) & 0xfu; }

// Body-local normal of the box face being drawn, from local and w =
// fwidth(local): the axis along which local does not change across the
// face, signed by local. Not the dominant axis of local: with MSAA an edge
// pixel's shading point can lie outside its triangle, where local
// extrapolates past the edge and the dominant axis names the neighbouring
// face (seen as dark dashes along cube edges). Derivatives come from the
// triangle's own plane, inside or out. fsFace tests this.
fn boxFace(local: vec3f, w: vec3f) -> vec3f {
  let ax = w.x <= w.y && w.x <= w.z;
  let ay = !ax && w.y <= w.z;
  return sign(local) * vec3f(select(0.0, 1.0, ax), select(0.0, 1.0, ay), select(0.0, 1.0, !ax && !ay));
}

@fragment fn fsBox(v: VOut) -> @location(0) vec4f {
  ${real ? REAL_FS_BOX : ''}// Clamped: an edge pixel's shading point may lie just outside the face.
  let lp = clamp(v.local, vec3f(-1.0), vec3f(1.0)) * v.half;
  let pxM = length(fwidth(lp));
  let faceN = boxFace(v.local, fwidth(v.local));
  let n = qrot(v.rot, bevelNormal(lp, faceN, v.half, pxM, fr.bevel));
  let dndx = dpdx(n);
  let dndy = dpdy(n);
  let isCandy = material(v.look) == 0u;
  let rough = select(0.7, fr.roughness, isCandy);
  let w = fx[v.slot];
  let base = select(vec3f(0.35), albedo(v.look), isCandy) * fxTint(w.x);
  // A thin dark seam (SEAM m wide on each cube) keeps neighbours in a packed
  // tower apart. Antialiased in pixels and faded out once it is narrower
  // than a pixel, where a hard line would alias into dashes.
  let d3 = v.half - abs(lp);
  let edgeM = max(min(d3.x, d3.y), min(max(d3.x, d3.y), d3.z)); // median: distance to the nearest edge on this face
  let wPx = SEAM / max(pxM, 1e-6);
  let drawn = max(wPx, 0.75);
  let seam = 1.0 - 0.4 * min(1.0, wPx / 0.75) * (1.0 - smoothstep(drawn - 0.5, drawn + 0.5, edgeM / max(pxM, 1e-6)));
  // The seam cavity's level of detail wants the true pixel footprint: pxM
  // comes from the clamped lp, whose derivatives flatten at edge pixels.
  let aoPxM = length(fwidth(v.local * v.half));
  var c = shade(base * seam, v.rel, n, aaAlpha(rough * rough, n, dndx, dndy), aaAlpha(0.0049, n, dndx, dndy), select(0.0, fr.clearcoat, isCandy), aoBox(v, n, lp, faceN, aoPxM));
  c += base * seam * fxGlow(w, fr.time);
  c += heatGlow(v.slot, base);
  return vec4f(fog(c, v.rel), 1.0);
}

// Heat from hard hits and ball contact (sparks.ts), scaled down when many
// bodies are hot at once (lights.ts). The palette colour glows; only the
// hottest turn white.
fn heatGlow(slot: u32, base: vec3f) -> vec3f {
  if (fr.heat == 0.0 || slot >= fr.capacity) { return vec3f(0.0); }
  let h = unpack2x16float(fxState[slot].bits).x;
  if (h <= 0.0) { return vec3f(0.0); }
  return h * lights[${LIGHT_META}u].x * mix(base * 3.0, vec3f(6.0), smoothstep(0.8, 1.0, h));
}

// Bench diagnostics (RendererOptions.flatBoxes): the cheapest box shading.
@fragment fn fsBoxFlat(v: VOut) -> @location(0) vec4f {
  return vec4f(albedo(v.look), 1.0);
}

@fragment fn fsSphere(v: VOut) -> @location(0) vec4f {
  ${real ? 'fragPx = v.clip.xy;' : ''}
  let n = qrot(v.rot, normalize(v.local));
  let dndx = dpdx(n);
  let dndy = dpdy(n);
  let isBall = material(v.look) == 1u;
  let w = fx[v.slot];
  let base = select(albedo(v.look), fr.ball, isBall) * fxTint(w.x);
  var c = shade(base, v.rel, n, aaAlpha(0.04, n, dndx, dndy), aaAlpha(0.0049, n, dndx, dndy), 0.5, aoBody(v, n));
  c += base * fxGlow(w, fr.time);
  let NoV = max(dot(n, normalize(-v.rel)), 0.0);
  c += select(vec3f(0.0), fr.ball * fr.ballEmissive * (0.35 + 0.65 * NoV), isBall);
  return vec4f(fog(c, v.rel), 1.0);
}

// Overlay spheres (setOverlay): not bodies, no shadows; slot = overlay index.
@vertex fn vsOverlay(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = overlay[ii];
  return place(RenderRecord(s.xyz - fr.eye, 0u, vec4f(0.0, 0.0, 0.0, 1.0), vec3f(s.w), ii), sphereCorner(vi));
}

@fragment fn fsOverlay(v: VOut) -> @location(0) vec4f {
  ${real ? 'fragPx = v.clip.xy;' : ''}
  let n = normalize(v.local);
  let dndx = dpdx(n);
  let dndy = dpdy(n);
  let col = overlayColour[v.slot];
  let base = pow(unpack4x8unorm(col).rgb, vec3f(2.2));
  var c = shade(base, v.rel, n, aaAlpha(0.04, n, dndx, dndy), aaAlpha(0.0049, n, dndx, dndy), 0.5, aoAt(aoView(), v.rel, n, v.rel, vec3f(0.0)));
  c += base * f32(col >> 24u) / 255.0 * ${FX_EMISSIVE_MAX}.0;
  return vec4f(fog(c, v.rel), 1.0);
}

// Test target: body slot + 1 per pixel, 0 for background.
@fragment fn fsId(v: VOut) -> @location(0) u32 {
  return v.slot + 1u;
}

// Test target: the world face fsBox would shade (1 + 2 * axis + negative),
// or 15 when it differs anywhere within half a pixel of the pixel centre
// (the most an MSAA shading point strays from the samples it shades).
// Single-sampled, so the test does not depend on how a software
// rasterizer places MSAA shading points.
fn faceCode(n: vec3f) -> u32 {
  let a = abs(n);
  let axis = select(select(2u, 1u, a.y >= a.z), 0u, a.x >= a.y && a.x >= a.z);
  return 1u + 2u * axis + select(0u, 1u, n[axis] < 0.0);
}

@fragment fn fsFace(v: VOut) -> @location(0) u32 {
  let w = fwidth(v.local);
  let dx = dpdx(v.local);
  let dy = dpdy(v.local);
  let code = faceCode(qrot(v.rot, boxFace(v.local, w)));
  for (var k = 0u; k < 4u; k++) {
    let o = vec2f(select(-0.5, 0.5, (k & 1u) != 0u), select(-0.5, 0.5, (k & 2u) != 0u));
    if (faceCode(qrot(v.rot, boxFace(v.local + dx * o.x + dy * o.y, w))) != code) { return 15u; }
  }
  return code;
}

struct GOut { @builtin(position) clip: vec4f, @location(0) rel: vec3f }

// The floor's visible polygon, camera-relative (floor.ts).
@vertex fn vsGround(@location(0) rel: vec3f) -> GOut {
  var o: GOut;
  o.clip = fr.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  return o;
}

@fragment fn fsGround(g: GOut) -> @location(0) vec4f {
  let p = g.rel.xz + fr.eye.xz;
  let w = fwidth(p);
  ${real ? /* wgsl */ `fragPx = g.clip.xy;
  if (SHADOW_VIEW) { return vec4f(vec3f(shadowSoft(g.rel, vec3f(0.0, 1.0, 0.0))), 1.0); }
  // The ground's material (groundAt); the sky it sees is the baked floor sky view.
  let gh = groundAt(p, w);
  return vec4f(fog(shade(fr.floor * gh.albedo, g.rel, gh.n, gh.a, gh.a, 0.0, vec2f(gh.cavity, floorSky(g.rel))), g.rel), 1.0);` : /* wgsl */ `// 1 m grid with screen-space antialiased lines, fading out where a line is under a pixel.
  let line = abs(fract(p - 0.5) - 0.5) / max(w, vec2f(1e-4));
  let grid = (1.0 - min(min(line.x, line.y), 1.0)) * (1.0 - smoothstep(0.05, 0.4, max(w.x, w.y)));
  return vec4f(groundShade(fr.floor * (1.0 + 2.0 * fr.floorGrid * grid), g.rel), 1.0);`}
}

// The lit, fogged floor at camera-relative rel (no derivatives: fsSky calls it in non-uniform control flow).
fn groundShade(base: vec3f, rel: vec3f${real ? ', a: f32, cavity: f32' : ''}) -> vec3f {
  let up = vec3f(0.0, 1.0, 0.0);
  return fog(shade(base, rel, up, ${real ? 'a, a' : '0.36, 0.36'}, 0.0, ${real ? 'vec2f(cavity, floorSky(rel))' : 'aoAt(aoView(), rel, up, rel, vec3f(0.0))'}), rel);
}

struct SOut { @builtin(position) clip: vec4f, @location(0) ndc: vec2f }

// Full-screen triangle on the far plane; drawn where nothing else was.
@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> SOut {
  let ndc = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: SOut;
  o.clip = vec4f(ndc, 1.0, 1.0);
  o.ndc = ndc;
  return o;
}

@fragment fn fsSky(s: SOut) -> @location(0) vec4f {
  let p = fr.invViewProj * vec4f(s.ndc, 1.0, 1.0);
  let dir = normalize(p.xyz / p.w);
  ${real ? /* wgsl */ `fragPx = s.clip.xy;
  // The sun disc, limb-darkened (I(mu) = 1 - 0.6 (1 - mu), normalized to mean 1), its rim antialiased.
  let cs = dot(dir, fr.sun);
  let x = sqrt(max(1.0 - cs * cs, 0.0)) / sqrt(1.0 - fr.sunCos * fr.sunCos);
  let rim = 1.0 - smoothstep(1.0 - 1.5 * fwidth(x), 1.0, x);
  let pxA = length(fwidth(dir)); // radians per pixel
  let hEye = fr.eye.y - fr.groundY;
  let below = dir.y < 0.0 && hEye > 0.0;
  // Hills on the horizon, where the floor does not reach them first.
  var hill = vec4f(0.0);
  if (REAL_GROUND && fr.hills.x > 0.0 && !(below && hEye < -dir.y * fr.hills.y)) {
    hill = hillsAt(dir, pxA);
    if (hill.a >= 1.0) { return vec4f(hill.rgb, 1.0); }
  }
  // Below the horizon, the floor goes on past the floor polygon's reach: the same shading, through more air.
  var c: vec3f;
  if (below) {
    let rel = dir * (hEye / -dir.y);
    let gf = groundFar(rel.xz + fr.eye.xz, length(rel) * pxA / -dir.y);
    c = groundShade(fr.floor * gf.albedo, rel, gf.a, gf.cavity);
  } else {
    let disc = fr.sunDisc * (1.0 - 0.6 * (1.0 - sqrt(max(1.0 - x * x, 0.0)))) / 0.8 * select(0.0, rim, cs > 0.0);
    c = skyLut(dir).rgb + disc;
  }
  return vec4f(mix(c, hill.rgb, hill.a), 1.0);` : 'return vec4f(select(skyColor(dir), fr.skyHorizon, dir.y < 0.0), 1.0);'}
}

${real ? REAL_HALL_WGSL : ''}
// ---------------------------------------------------------------- sparks

// A streak from the spark back along its velocity (1/45 s of travel), drawn
// as a screen-space quad 2.5 px wide, so it neither aliases nor shrinks
// with distance. Dead sparks collapse to nothing. Additive into the HDR
// target, depth-tested against the scene, no depth write.
struct SparkOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) colour: vec3f,
}

const SPARK_HALF_WIDTH = 1.25;

@vertex fn vsSpark(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SparkOut {
  var o: SparkOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0); // outside the depth range: clipped
  o.uv = vec2f(0.0);
  o.colour = vec3f(0.0);
  let s = sparks[ii];
  if (s.age < 0.0) { return o; }
  let head = fr.viewProj * vec4f(s.pos - fr.eye, 1.0);
  let tail = fr.viewProj * vec4f(s.pos - s.vel * (1.0 / 45.0) - fr.eye, 1.0);
  if (head.w < 0.05 || tail.w < 0.05) { return o; }
  let half = 0.5 * fr.viewport;
  let ph = head.xy / head.w * half;
  let pt = tail.xy / tail.w * half;
  let len = length(ph - pt);
  let d = select(vec2f(1.0, 0.0), (ph - pt) / len, len > 1e-4);
  let n = vec2f(-d.y, d.x);
  let along = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0)[vi];
  let side = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0)[vi];
  let w = SPARK_HALF_WIDTH;
  let p = mix(pt - d * w, ph + d * w, along) + n * side * w;
  o.clip = vec4f(p / half, mix(tail.z / tail.w, head.z / head.w, along), 1.0);
  o.uv = vec2f(along, side);
  // White-hot to amber over the life, then out; a streak under a pixel long
  // is dimmed by its coverage.
  let t = s.age / sparkLife(s.packed);
  let hot = mix(vec3f(1.0, 0.92, 0.8) * 20.0, vec3f(1.0, 0.42, 0.1) * 8.0, smoothstep(0.0, 0.6, t));
  o.colour = hot * (1.0 - smoothstep(0.7, 1.0, t)) * clamp(len + 0.4, 0.4, 1.0);
  return o;
}

@fragment fn fsSpark(o: SparkOut) -> @location(0) vec4f {
  let across = 1.0 - smoothstep(0.35, 1.0, abs(o.uv.y));
  let along = smoothstep(0.0, 0.8, o.uv.x); // bright head, fading tail
  return vec4f(o.colour * across * along, 0.0);
}

${real ? REAL_DEBRIS_WGSL : ''}
// ---------------------------------------------------------------- ball trail

// A camera-facing ribbon through each ball's last TRAIL positions, fading
// over TRAIL_LIFE seconds; broken where the ball jumped (new ball, reset).
const TRAIL_LIFE = 0.45;
const TRAIL_WIDTH = 0.22;

struct TrailOut {
  @builtin(position) clip: vec4f,
  @location(0) across: f32,
  @location(1) fade: f32,
}

@vertex fn vsTrail(@builtin(vertex_index) vi: u32, @builtin(instance_index) ball: u32) -> TrailOut {
  var o: TrailOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
  o.across = 0.0;
  o.fade = 0.0;
  let j = vi / 6u;
  let end = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u)[vi % 6u];
  let side = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0)[vi % 6u];
  let base = ball * ${TRAIL}u;
  let a = trail[base + (fr.trailHead + ${TRAIL}u - j) % ${TRAIL}u];
  let b = trail[base + (fr.trailHead + ${TRAIL * 2}u - j - 1u) % ${TRAIL}u];
  if (a.w < 0.0 || b.w < 0.0 || b.w > a.w || fr.time - b.w > TRAIL_LIFE || distance(a.xyz, b.xyz) > 4.0) { return o; }
  let p = select(a, b, end == 1u);
  let rel = p.xyz - fr.eye;
  let along = normalize(a.xyz - b.xyz + vec3f(1e-6, 0.0, 0.0));
  let sideV = normalize(cross(along, rel) + vec3f(0.0, 1e-6, 0.0));
  let age = clamp((fr.time - p.w) / TRAIL_LIFE, 0.0, 1.0);
  let width = TRAIL_WIDTH * (1.0 - age);
  o.clip = fr.viewProj * vec4f(rel + sideV * side * width, 1.0);
  o.across = side;
  o.fade = (1.0 - age) * (1.0 - age);
  return o;
}

@fragment fn fsTrail(o: TrailOut) -> @location(0) vec4f {
  let soft = 1.0 - smoothstep(0.2, 1.0, abs(o.across));
  return vec4f(fr.ball * fr.ballEmissive * 0.6 * o.fade * soft, 0.0);
}
`;
}

export const SCENE_WGSL = sceneWgsl();
