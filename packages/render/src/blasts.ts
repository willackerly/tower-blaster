// Blasts you can see (the bomb visuals): when a weapon goes off, a fireball,
// a shock shell that shows the blast's reach, and a light that floods the
// scene around it. The physics knows nothing of this: the game (or viewer)
// calls Renderer.blast(centre, radius) when its blast feedback arrives.
//
//   timeline  blastState: everything a blast shows at an age, on the CPU
//             (no GPU state; tests check it directly). The fireball grows
//             from `start` to `fire` x the blast radius in `grow` s
//             (ease-out; it is already big on its first frame), burns
//             hot for `burn` s, cools to smoke that rises and thins out by
//             `smoke` s. The shock shell runs out to exactly the blast
//             radius in `shock` s, so the player sees how far the blast
//             reaches, then drifts on to `overshoot` x the radius as it
//             fades over `shockHold` s (a still shell reads
//             as a soap bubble; review 2026-11-05). Durations scale
//             with the radius's cube root (bigger bangs last longer;
//             clamped to 0.5..2x): `sizeRef` is the radius at 1x.
//   draw      one camera-facing quad per fireball and per shell, sized to
//             the sphere's silhouette; the fragment shader intersects its
//             pixel's ray with the sphere and shades the chord: fire and
//             smoke from three samples of a baked 3D noise (front to back,
//             emission over absorption, premultiplied), the shell as the
//             chord through a thin spherical layer (limb-brightened, so it
//             reads as a sphere's edge). It writes the depth of the
//             sphere's front surface, so blocks in front of the fire hide
//             it and the floor cuts a ground blast to a dome. No depth
//             write. Drawn last in the scene pass, before bloom (HDR).
//   light     each live blast is a point light (lights.ts blast slots, the
//             BLAST_LIGHTS brightest), `reach` x its radius, intensity
//             proportional to radius squared, a short attack then decay
//             with `lightTau`. It is the only light the real look's
//             blocks get besides the sun and sky, and it is on in every
//             look (unlike the stylized effects).
//
// Brightness is relative to the look's sunlight (its luminance), so fire
// reads the same against a candy night as against photoreal daylight.
//
// Cost: nothing at all with no live blast (no draw, no pipeline compiled).
// With some, fill: one fragment per covered pixel per sphere, 9 trilinear
// noise taps and a ray-sphere test; at most MAX_BLASTS spheres of each kind.
//
// Alternatives considered:
// - The spark pool (sparks.ts): already there, but it reads as sparks, not
//   a fireball, and the real look has none.
// - Raymarched volumetric fire (8-16 steps of fbm): the best look, several
//   times the fill cost of three samples on a chord; a close-up fills the
//   screen. Three samples, a radial density profile and a baked noise
//   texture cost about one textured full-screen pass at worst.
// - An emissive noise-displaced mesh: cheap and correctly occluded, but
//   opaque and cartoonish; no smoke, no soft edge.
// - Soft intersections with blocks (sampling scene depth): the scene's
//   depth is 4x MSAA and never stored; the front-surface depth gets the
//   order right for anything not inside the fireball.
// - Shadowed blast light (a cube shadow map per blast): six extra depth
//   passes of up to 100k bodies in the frame it matters most; the light
//   is brief and NoL already darkens faces turned away.
import { pcg3d } from './noise.ts';
import { HDR_FORMAT } from './post.ts';
import type { Mat4, V3 } from './math.ts';

/** Most blasts drawn at once (fireball and shell each); more start by retiring the oldest. */
export const MAX_BLASTS = 16;
/** Edge of the baked noise volume, texels (tiles). */
export const NOISE_SIZE = 32;
const SAMPLES = 4;

export interface BlastParams {
  /** Fireball's full radius, fraction of the blast radius. */
  fire: number;
  /** s to grow to full size. */
  grow: number;
  /** s it burns hot after that (heat falls to 0). */
  burn: number;
  /** s from the start until the smoke is gone. */
  smoke: number;
  /** How fast the cooling fireball rises, blast radii per second. */
  rise: number;
  /** s for the shock shell to reach the blast radius. */
  shock: number;
  /** s the shell fades over once it reaches the blast radius, drifting on to overshoot x the radius. */
  shockHold: number;
  /** Where the fading shell ends, blast radii. */
  overshoot: number;
  /** Fireball radius on its first frame, fraction of its full radius. */
  start: number;
  /** Shell thickness, fraction of the blast radius. */
  shockWidth: number;
  /** Shell brightness (x the look's sun luminance). */
  shockGlow: number;
  /** Fireball brightness (x the look's sun luminance). */
  glow: number;
  /** Smoke's lit brightness (x the look's sun luminance). */
  smokeLight: number;
  /** How much the fireball swells as it cools to smoke, fraction of its full radius. */
  swell: number;
  /** Light: intensity at its peak per (blast radius)^2 (x the look's sun luminance and its blastLight); 0: no light. */
  light: number;
  /** Light radius, blast radii. */
  reach: number;
  /** Light decay time constant, s. */
  lightTau: number;
  /** Blast radius whose durations are as written; others scale by the cube root of the ratio (0.5 to 2x). */
  sizeRef: number;
}

export const DEFAULT_BLASTS: BlastParams = {
  fire: 0.8, start: 0.5, grow: 0.12, burn: 0.55, smoke: 1.8, rise: 0.35,
  shock: 0.15, shockHold: 0.2, overshoot: 1.05, shockWidth: 0.08, shockGlow: 1.2,
  glow: 2.5, smokeLight: 0.45, swell: 0.4, light: 5, reach: 3.5, lightTau: 0.22, sizeRef: 5,
};

/**
 * A bell's ring (Rube Lab, PT26: Renderer.ring): the shell alone, no fireball or smoke, running out slowly to
 * its radius and on past it as it fades (a ring wave rather than a blast's snap), with a short warm light.
 */
export const RING_BLASTS: BlastParams = {
  ...DEFAULT_BLASTS, fire: 0, smoke: 1.4, shock: 0.45, shockHold: 0.7, overshoot: 1.6, shockWidth: 0.05, light: 1.2, reach: 2.5, lightTau: 0.35, sizeRef: 3,
};

/** The second ring wave follows the first by this much (s): Renderer.ring. */
export const RING_ECHO_S = 0.35;

/** What a blast shows at an age (blastState). Lengths in world units, intensities before the look's sun luminance. */
export interface BlastState {
  alive: boolean;
  /** Fireball centre (risen) and radius. */
  centre: V3;
  fireR: number;
  /** 1 white hot to 0 cold smoke. */
  heat: number;
  /** Smoke and fire density, 1 to 0 as it thins out. */
  density: number;
  shockR: number;
  /** Shell brightness, 0 to 1. */
  shockA: number;
  shockW: number;
  /** Light intensity (0: none), radius and colour (linear, unit-ish). */
  light: number;
  lightR: number;
  lightColour: V3;
  /** Duration scale used (for the noise's animation). */
  k: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Duration scale of a blast of this radius: cube root of radius / sizeRef, clamped to 0.5..2. */
export function durationScale(radius: number, p: BlastParams = DEFAULT_BLASTS): number {
  return Math.min(2, Math.max(0.5, Math.cbrt(radius / p.sizeRef)));
}

/** Everything a blast centred at `centre` with this radius shows `age` s after it went off. */
export function blastState(centre: V3, radius: number, age: number, p: BlastParams = DEFAULT_BLASTS): BlastState {
  const k = durationScale(radius, p);
  const grow = p.grow * k, burn = p.burn * k, smoke = p.smoke * k, shock = p.shock * k, hold = p.shockHold * k;
  const a = Math.max(0, age);
  const g = clamp01(a / grow);
  const after = Math.max(0, a - grow);
  // Ease-out growth, then a slow swell as it cools.
  const fireR = radius * p.fire * (p.start + (1 - p.start) * (1 - (1 - g) ** 3) + p.swell * clamp01(after / (smoke - grow)));
  const heat = a < grow ? 1 : clamp01(1 - after / burn) ** 1.5;
  const density = 1 - smooth(burn + grow, smoke, a);
  const ps = a / shock;
  const shockR = radius * (ps < 1 ? 1 - (1 - ps) ** 3 : 1 + (p.overshoot - 1) * clamp01((a - shock) / hold));
  const shockA = ps < 1 ? 1 : clamp01(1 - (a - shock) / hold);
  const attack = 0.025;
  const lt = a < attack ? a / attack : Math.exp(-(a - attack) / (p.lightTau * k));
  const warm = clamp01(heat);
  const lightColour: V3 = [1, 0.42 + 0.33 * warm, 0.14 + 0.36 * warm];
  const alive = a < smoke && age >= 0;
  return {
    alive,
    centre: [centre[0], centre[1] + p.rise * radius * after, centre[2]],
    fireR: alive ? fireR : 0, heat: alive ? heat : 0, density: alive ? density : 0,
    shockR, shockA: alive && a < shock + hold ? shockA : 0, shockW: Math.max(1e-3, p.shockWidth * radius),
    light: alive && p.light > 0 ? p.light * radius * radius * lt : 0, lightR: p.reach * radius, lightColour, k,
  };
}

/** A blast in flight: where, how big, when (renderer time, s), and a seed for its noise. */
export interface Blast { centre: V3; radius: number; t0: number; seed: number; params?: BlastParams }

/** The baked noise volume: NOISE_SIZE^3 texels, 4 independent smooth channels, tiling. */
export function bakeBlastNoise(): Uint8Array {
  const n = NOISE_SIZE, n3 = n * n * n;
  const out = new Uint8Array(n3 * 4);
  for (let c = 0; c < 4; c++) {
    let v = new Float32Array(n3);
    for (let i = 0; i < n3; i++) v[i] = pcg3d(i, c, 0x9e37)[0] / 4294967296;
    // Two [1 2 1] passes per axis: white noise to a smooth blob field (sampled trilinearly).
    for (let pass = 0; pass < 2; pass++) for (let axis = 0; axis < 3; axis++) {
      const s = axis === 0 ? 1 : axis === 1 ? n : n * n;
      const w = new Float32Array(n3);
      for (let i = 0; i < n3; i++) {
        const q = Math.floor(i / s) % n;
        const lo = i + (((q + n - 1) % n) - q) * s, hi = i + (((q + 1) % n) - q) * s;
        w[i] = 0.25 * v[lo]! + 0.5 * v[i]! + 0.25 * v[hi]!;
      }
      v = w;
    }
    let lo = Infinity, hi = -Infinity;
    for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    for (let i = 0; i < n3; i++) out[4 * i + c] = Math.round(((v[i]! - lo) / (hi - lo)) * 255);
  }
  return out;
}

const INST_FLOATS = 16;
const UNIFORM_FLOATS = 40;

export const BLAST_WGSL = /* wgsl */ `
struct BlastFrame { viewProj: mat4x4f, invViewProj: mat4x4f, viewport: vec2f, time: f32, gain: f32, shockGain: f32, smoke: f32, pad1: f32, pad2: f32 }
// a: fireball centre (camera-relative, risen), radius; b: heat, density, duration scale, seed;
// c: shell centre (where the blast went off, camera-relative), radius; d: shell brightness, thickness, age / duration scale, unused
struct BlastInst { a: vec4f, b: vec4f, c: vec4f, d: vec4f }
@group(0) @binding(0) var<uniform> bf: BlastFrame;
@group(0) @binding(1) var<storage, read> insts: array<BlastInst>;
@group(0) @binding(2) var noiseTex: texture_3d<f32>;
@group(0) @binding(3) var noiseSamp: sampler;

struct BOut {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) k: u32,
  @location(1) @interpolate(flat) shell: u32,
}

fn sphereOf(s: BlastInst, shell: bool) -> vec4f {
  return select(s.a, s.c, shell);
}

@vertex fn vsBlast(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  var o: BOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0); // outside the depth range: clipped
  o.k = ii / 2u;
  o.shell = ii % 2u;
  let s = insts[o.k];
  let shell = o.shell == 1u;
  let sph = sphereOf(s, shell);
  let C = sph.xyz;
  let R = sph.w;
  let on = select(R > 0.0 && s.b.y > 0.0, R > 0.0 && s.d.x > 0.0, shell);
  if (!on) { return o; }
  let corner = vec2f(array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0)[vi], array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0)[vi]);
  let d = length(C);
  if (d < R * 1.05) {
    // The eye is (nearly) inside: the whole screen; the fragment does the rest.
    o.clip = vec4f(corner, 0.5, 1.0);
    return o;
  }
  let f = C / d;
  let up0 = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(f.y) > 0.99);
  let right = normalize(cross(f, up0));
  let up = cross(right, f);
  // The silhouette's radius in the plane through the centre: the tangent cone's.
  let half = R * d / sqrt(d * d - R * R);
  o.clip = bf.viewProj * vec4f(C + (right * corner.x + up * corner.y) * half, 1.0);
  return o;
}

fn noise3(p: vec3f) -> vec4f {
  return textureSampleLevel(noiseTex, noiseSamp, p, 0.0);
}

// Fire colour by temperature, 0 (cold, dark) to 1 (white hot), unit-ish brightness.
fn fireColour(t: f32) -> vec3f {
  let deep = vec3f(0.3, 0.05, 0.0);
  let orange = vec3f(1.0, 0.36, 0.05);
  let yellow = vec3f(1.0, 0.72, 0.28);
  let white = vec3f(1.0, 0.93, 0.8);
  var c = mix(deep, orange, smoothstep(0.0, 0.4, t));
  c = mix(c, yellow, smoothstep(0.35, 0.75, t));
  c = mix(c, white, smoothstep(0.75, 1.0, t));
  return c * (0.08 + 2.4 * t * t * t + 0.6 * t);
}

struct FOut { @location(0) c: vec4f, @builtin(frag_depth) depth: f32 }

@fragment fn fsBlast(o: BOut) -> FOut {
  var out: FOut;
  let s = insts[o.k];
  let shell = o.shell == 1u;
  let sph = sphereOf(s, shell);
  let C = sph.xyz;
  let R = sph.w;
  let ndc = vec2f(o.clip.x / bf.viewport.x * 2.0 - 1.0, 1.0 - o.clip.y / bf.viewport.y * 2.0);
  let fp = bf.invViewProj * vec4f(ndc, 1.0, 1.0);
  let dir = normalize(fp.xyz / fp.w);
  let b = dot(dir, C);
  let c2 = dot(C, C) - R * R;
  let disc = b * b - c2;
  if (disc <= 0.0) { discard; }
  let sq = sqrt(disc);
  let t1 = b + sq;
  if (t1 <= 0.0) { discard; }
  let t0 = max(b - sq, 0.0);
  let pc = bf.viewProj * vec4f(dir * max(t0, 1e-4), 1.0);
  out.depth = clamp(pc.z / pc.w, 0.0, 1.0);
  if (shell) {
    // Chord through a spherical layer of thickness w: brightest at the limb.
    let w = min(s.d.y, R);
    let p2 = max(dot(C, C) - b * b, 0.0); // squared distance of the ray from the centre
    let ri = R - w;
    let outer = sqrt(max(R * R - p2, 0.0));
    let inner = sqrt(max(ri * ri - p2, 0.0));
    let chord = 2.0 * (outer - inner);
    let peak = 2.0 * sqrt(max(R * R - ri * ri, 1e-8));
    // Cubed, so the limb dominates and the middle stays clear; warm, not a white bubble.
    let e = chord / peak;
    let i = s.d.x * bf.shockGain * e * e * e;
    out.c = vec4f(vec3f(1.0, 0.62, 0.3) * i, 0.0);
    return out;
  }
  let heat = s.b.x;
  let density = s.b.y;
  let seed = vec3f(fract(s.b.w * 0.1031), fract(s.b.w * 0.11369), fract(s.b.w * 0.13787)) * 7.0;
  let age = s.d.z;
  let chord = t1 - t0;
  var col = vec3f(0.0);
  var trans = 1.0;
  for (var j = 0; j < 3; j++) {
    let t = t0 + chord * (f32(j) + 0.5) / 3.0;
    let u = (dir * t - C) / R;           // unit-sphere coordinates
    let r = length(u);
    // Turbulence that boils outward and rolls upward as it ages; one octave warps the others.
    // The noise's blobs are about a tenth of its tile, so 0.22 per unit radius gives four or five lumps across.
    let q0 = u * (0.22 - 0.04 * min(age, 1.5)) + seed + vec3f(0.0, -0.05 * age, 0.0);
    let warp = noise3(q0 * 0.6 + 0.13).xyz - 0.5;
    let q = q0 + warp * 0.16;
    let n = noise3(q).x * 0.5 + noise3(q * 2.03 + 0.37).y * 0.3 + noise3(q * 4.1 + 0.71).z * 0.2;
    // A lumpy ball with a ragged edge that erodes as it thins.
    let erode = 1.0 - density;
    // The ball proper ends at about 0.7 of the sphere; lumps of noise reach out to its edge.
    let rho = clamp((0.7 - r) * 3.2 + (n - 0.5) * 4.2 - erode * 1.6, 0.0, 1.0) * density;
    // Hottest at the core and early on; cool dark knots where the noise is low.
    let temp = clamp(heat * (1.35 - 1.4 * r + (n - 0.5) * 3.2), 0.0, 1.0);
    let a = 1.0 - exp(-rho * 5.0 * chord / (3.0 * R));
    // Smoke: a lit grey that takes over as the fire cools.
    let smoke = vec3f(0.27, 0.27, 0.28) * bf.smoke * (1.0 - temp) * (0.6 + 0.4 * n);
    let emit = fireColour(temp) * bf.gain * smoothstep(0.0, 0.08, temp);
    col += trans * a * (emit + smoke);
    trans *= 1.0 - a;
  }
  out.c = vec4f(col, 1.0 - trans);
  return out;
}
`;

/** CPU side: the live blasts, their instance upload, the pipeline (made at the first live blast) and the draw. */
export class Blasts {
  /** Tunables, read every frame. */
  config: BlastParams = { ...DEFAULT_BLASTS };
  private live: Blast[] = [];
  private seed = 1;
  private gpu: { pipe: GPURenderPipeline; bind: GPUBindGroup; insts: GPUBuffer; uniform: GPUBuffer; noise: GPUTexture } | null = null;
  private drawCount = 0;
  private readonly inst = new Float32Array(MAX_BLASTS * INST_FLOATS);

  constructor(private readonly device: GPUDevice) {}

  /** A blast went off at `centre` (world) reaching `radius`, at renderer time t0 (s); `params` in place of config (a ring: RING_BLASTS). */
  add(centre: V3, radius: number, t0: number, params?: BlastParams): void {
    if (!(radius > 0) || !centre.every(Number.isFinite)) return;
    if (this.live.length >= MAX_BLASTS) this.live.shift();
    this.live.push({ centre: [...centre], radius, t0, seed: this.seed++, ...(params ? { params } : {}) });
  }

  /** Live blasts (tests, lights). */
  get blasts(): readonly Blast[] { return this.live; }

  /** Retire the blasts that are over at time t; the states of the rest, in order. */
  states(t: number): BlastState[] {
    const p = (b: Blast) => b.params ?? this.config;
    this.live = this.live.filter((b) => t - b.t0 < p(b).smoke * durationScale(b.radius, p(b)) && t >= b.t0 - 1);
    return this.live.map((b) => blastState(b.centre, b.radius, t - b.t0, p(b)));
  }

  /** Remove every blast (a level reload). */
  clear(): void { this.live = []; }

  /**
   * Upload this frame's instances (camera-relative) and uniforms. viewProj
   * is camera-relative; gain is the look's sun luminance. Returns whether
   * anything is to be drawn (draw() then records it).
   */
  prepare(states: readonly BlastState[], f: { eye: V3; viewProj: Mat4; invViewProj: Mat4; viewport: [number, number]; time: number; gain: number }): boolean {
    let n = 0;
    states.forEach((s, i) => {
      if (!s.alive || (s.density <= 0 && s.shockA <= 0)) return;
      const o = n * INST_FLOATS, b = this.live[i]!;
      this.inst.set([
        s.centre[0] - f.eye[0], s.centre[1] - f.eye[1], s.centre[2] - f.eye[2], s.fireR,
        s.heat, s.density, s.k, b.seed % 4096,
        b.centre[0] - f.eye[0], b.centre[1] - f.eye[1], b.centre[2] - f.eye[2], s.shockA > 0 ? s.shockR : 0,
        s.shockA, s.shockW, (f.time - b.t0) / s.k, 0,
      ], o);
      n++;
    });
    this.drawCount = n;
    if (!n) return false;
    const g = (this.gpu ??= this.make());
    this.device.queue.writeBuffer(g.insts, 0, this.inst, 0, n * INST_FLOATS);
    const u = new Float32Array(UNIFORM_FLOATS);
    u.set(f.viewProj, 0); u.set(f.invViewProj, 16);
    u[32] = f.viewport[0]; u[33] = f.viewport[1]; u[34] = f.time;
    u[35] = f.gain * this.config.glow; u[36] = f.gain * this.config.shockGlow; u[37] = f.gain * this.config.smokeLight;
    this.device.queue.writeBuffer(g.uniform, 0, u);
    return true;
  }

  /** Record the draw into the open scene pass (after prepare returned true); the caller re-sets its own bind group after. */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.drawCount || !this.gpu) return;
    pass.setPipeline(this.gpu.pipe);
    pass.setBindGroup(0, this.gpu.bind);
    pass.draw(6, 2 * this.drawCount);
  }

  private make(): NonNullable<Blasts['gpu']> {
    const d = this.device;
    const module = d.createShaderModule({ code: BLAST_WGSL, label: 'blasts' });
    const pipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsBlast' },
      fragment: {
        module, entryPoint: 'fsBlast',
        targets: [{ format: HDR_FORMAT, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });
    const insts = d.createBuffer({ size: MAX_BLASTS * INST_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'blast instances' });
    const uniform = d.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'blast frame' });
    const noise = d.createTexture({ size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'blast noise' });
    d.queue.writeTexture({ texture: noise }, bakeBlastNoise(), { bytesPerRow: NOISE_SIZE * 4, rowsPerImage: NOISE_SIZE }, [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE]);
    const sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    const bind = d.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: insts } }, { binding: 2, resource: noise.createView() }, { binding: 3, resource: sampler }],
    });
    return { pipe, bind, insts, uniform, noise };
  }

  destroy(): void {
    if (!this.gpu) return;
    this.gpu.insts.destroy();
    this.gpu.uniform.destroy();
    this.gpu.noise.destroy();
  }
}

/** URL knobs blast.<key>: each BlastParams field with its accepted range. */
export const BLAST_KNOBS: Record<keyof BlastParams, { min: number; max: number }> = {
  fire: { min: 0, max: 2 }, start: { min: 0, max: 1 }, overshoot: { min: 1, max: 2 }, grow: { min: 0.01, max: 2 }, burn: { min: 0, max: 10 }, smoke: { min: 0.05, max: 20 }, rise: { min: 0, max: 5 },
  shock: { min: 0.01, max: 5 }, shockHold: { min: 0, max: 5 }, shockWidth: { min: 0.005, max: 1 }, shockGlow: { min: 0, max: 50 },
  glow: { min: 0, max: 50 }, smokeLight: { min: 0, max: 10 }, swell: { min: 0, max: 5 },
  light: { min: 0, max: 100 }, reach: { min: 0.1, max: 20 }, lightTau: { min: 0.01, max: 5 }, sizeRef: { min: 0.01, max: 1000 },
};

/** Whether blasts are drawn, and how (URL keys blast and blast.<knob>). */
export interface BlastOptions { on: boolean; params: BlastParams }

/**
 * From URL keys: blast=0 turns blast visuals off (default on); blast.<knob>
 * (BLAST_KNOBS) sets a parameter, absent ones at DEFAULT_BLASTS. Refuses
 * unknown knobs and values outside their range.
 */
export function parseBlastOptions(q: URLSearchParams): BlastOptions {
  const on = q.get('blast');
  if (on !== null && on !== '0' && on !== '1') throw new Error(`blast must be 0 or 1: ${on}`);
  const params = { ...DEFAULT_BLASTS };
  for (const key of q.keys()) {
    if (!key.startsWith('blast.')) continue;
    const k = key.slice(6) as keyof BlastParams;
    const range = BLAST_KNOBS[k];
    if (!range) throw new Error(`${key} is not a blast knob (one of ${Object.keys(BLAST_KNOBS).join(', ')})`);
    const raw = q.get(key)!, v = raw.trim() === '' ? NaN : Number(raw);
    if (!(v >= range.min && v <= range.max)) throw new Error(`${key} must be a number from ${range.min} to ${range.max}: ${raw}`);
    params[k] = v;
  }
  return { on: on !== '0', params };
}

/** The URL keys for o that differ from the defaults, as parseBlastOptions reads them back. */
export function writeBlastOptions(o: BlastOptions, q: URLSearchParams): void {
  if (!o.on) q.set('blast', '0');
  for (const k of Object.keys(BLAST_KNOBS) as (keyof BlastParams)[]) if (o.params[k] !== DEFAULT_BLASTS[k]) q.set(`blast.${k}`, String(o.params[k]));
}
