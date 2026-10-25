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
  ['shadowParams', 'vec4f', 'normal offset m, depth bias (light depth units), texel m, unused'],
  ['viewport', 'vec2f', 'pixels'], ['dt', 'f32', 'seconds since the last scene frame'], ['trailHead', 'u32', 'newest ball trail sample'],
  ['aoOrigin', 'vec3f', 'AO grid low corner, camera-relative'], ['aoInvVoxel', 'f32', 'per metre, level 0'],
  ['aoDims', 'vec3f', 'level-0 voxels'], ['aoOn', 'f32', '0: AO off'],
  ['aoK', 'vec4f', 'tap strengths (0.3, 0.9, 2.0 m), sky weight'],
  ['ramp0', 'vec4f', 'OKLab'], ['ramp1', 'vec4f'], ['ramp2', 'vec4f'], ['ramp3', 'vec4f'], ['ramp4', 'vec4f'],
], 'Per-frame uniforms of the scene pass.');

export const SCENE_WGSL = /* wgsl */ `
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
  let texel = 1.0 / ${SHADOW_SIZE}.0;
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
  var c = select(skyColor(R), mix(fr.skyHorizon, fr.floor * fr.ambSky, min(-4.0 * R.y, 1.0)), R.y < 0.0);
  c += fr.keyColor * softbox(R, fr.keyDir, fr.keySize, rough);
  c += fr.rimColor * softbox(R, fr.rimDir, fr.rimSize, rough);
  return c;
}

fn fog(c: vec3f, rel: vec3f) -> vec3f {
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
  let sh = shadow(rel, n) * NoL;
  let H = normalize(L + V);
  let NoH = max(dot(n, H), 0.0);
  let VoH = max(dot(V, H), 0.0);
  let F = schlick(0.04, VoH);
  let spec = (ggx(NoH, a) * smithVis(NoV, NoL, a) + coat * ggx(NoH, ac) * smithVis(NoV, NoL, ac)) * F * PI;
  let R = reflect(-V, n);
  let reflections = env(R, sqrt(a)) * envBrdf(0.04, sqrt(a), NoV) + coat * env(R, sqrt(ac)) * envBrdf(0.04, sqrt(ac), NoV);
  // Ground contact: darker near the floor. The occupancy volume (ao.ts) adds what is nearby; sky visibility dims only the sky light.
  let contact = 0.5 + 0.5 * smoothstep(0.0, 1.5, rel.y + fr.eye.y - fr.groundY);
  let occl = contact * ao.x;
  let amb = mix(fr.ambGround, fr.ambSky * ao.y, n.y * 0.5 + 0.5) * occl;
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
  // Clamped: an edge pixel's shading point may lie just outside the face.
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
  // 1 m grid with screen-space antialiased lines, fading out where a line is under a pixel.
  let p = g.rel.xz + fr.eye.xz;
  let w = fwidth(p);
  let line = abs(fract(p - 0.5) - 0.5) / max(w, vec2f(1e-4));
  let grid = (1.0 - min(min(line.x, line.y), 1.0)) * (1.0 - smoothstep(0.05, 0.4, max(w.x, w.y)));
  let base = fr.floor * (1.0 + 2.0 * fr.floorGrid * grid);
  let up = vec3f(0.0, 1.0, 0.0);
  return vec4f(fog(shade(base, g.rel, up, 0.36, 0.36, 0.0, aoAt(aoView(), g.rel, up, g.rel, vec3f(0.0))), g.rel), 1.0);
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
  return vec4f(select(skyColor(dir), fr.skyHorizon, dir.y < 0.0), 1.0);
}

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
