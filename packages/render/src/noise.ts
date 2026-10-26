// Tileable noise for the material bake (materials.ts, realism step 3), in
// WGSL and as a CPU twin.
//
//   hash      pcg3d (Jarzynski and Olano 2020): integer only, so the GPU and
//             the CPU agree bit for bit on which gradient or feature point a
//             cell gets
//   gnoise    2D gradient noise, quintic fade, periodic in both axes with an
//             integer period (in cells): textures baked from it tile
//   fbm       octaves of gnoise at frequency 2^k with period * 2^k, so every
//             octave keeps the period
//   worley    periodic cellular noise: distances to the nearest and second
//             nearest feature point (F1, F2) and the nearest cell's hash
//
// The CPU twin rounds nothing on purpose: GPU f32 and JS doubles differ by
// float rounding only (tests compare within 1e-4).
//
// Alternatives considered: value noise has visible grid-aligned artefacts at
// low octaves; simplex noise is cheaper per sample but its periodic form needs
// a skewed lattice whose period is awkward to match a texture; a float hash
// (fract(sin(x) * 43758)) differs between GPU vendors, which would make the
// baked textures platform-dependent.

const M = 1664525, C = 1013904223;

/** pcg3d of three u32. */
export function pcg3d(x: number, y: number, z: number): [number, number, number] {
  let a = (Math.imul(x, M) + C) >>> 0, b = (Math.imul(y, M) + C) >>> 0, c = (Math.imul(z, M) + C) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0; b = (b + Math.imul(c, a)) >>> 0; c = (c + Math.imul(a, b)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0; b = (b ^ (b >>> 16)) >>> 0; c = (c ^ (c >>> 16)) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0; b = (b + Math.imul(c, a)) >>> 0; c = (c + Math.imul(a, b)) >>> 0;
  return [a, b, c];
}

const U = 1 / 4294967296;
const mod = (i: number, n: number) => ((i % n) + n) % n;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad(ix: number, iy: number, seed: number, fx: number, fy: number): number {
  const a = pcg3d(ix, iy, seed)[0] * U * 2 * Math.PI;
  return Math.cos(a) * fx + Math.sin(a) * fy;
}

/** Gradient noise at p, periodic with period cells in x and y; about -0.7 to 0.7. */
export function gnoise(px: number, py: number, period: number, seed: number): number {
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  const x0 = mod(ix, period), y0 = mod(iy, period), x1 = mod(ix + 1, period), y1 = mod(iy + 1, period);
  const u = fade(fx), v = fade(fy);
  return lerp(lerp(grad(x0, y0, seed, fx, fy), grad(x1, y0, seed, fx - 1, fy), u), lerp(grad(x0, y1, seed, fx, fy - 1), grad(x1, y1, seed, fx - 1, fy - 1), u), v);
}

/** Octaves of gnoise (lacunarity 2, gain 0.5), periodic with period cells of the first octave. */
export function fbm(px: number, py: number, period: number, seed: number, octaves: number): number {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * gnoise(px * f, py * f, period * f, seed + o);
    amp *= 0.5;
    f *= 2;
  }
  return s;
}

/** Periodic cellular noise: F1, F2 (in cells) and the hash of F1's cell. */
export function worley(px: number, py: number, period: number, seed: number): [number, number, number] {
  const ix = Math.floor(px), iy = Math.floor(py);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const h = pcg3d(mod(ix + i, period), mod(iy + j, period), seed);
    const dx = ix + i + h[0] * U - px, dy = iy + j + h[1] * U - py, d = Math.hypot(dx, dy);
    if (d < f1) { f2 = f1; f1 = d; id = h[2]; } else if (d < f2) f2 = d;
  }
  return [f1, f2, id];
}

/** pcg3d and 2^-32 alone (the scene shader's per-block variation needs only the hash). */
export const PCG_WGSL = /* wgsl */ `
fn pcg3d(p: vec3u) -> vec3u {
  var v = p * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

const NOISE_U = 2.3283064365386963e-10; // 2^-32
`;

export const NOISE_WGSL = /* wgsl */ `
${PCG_WGSL}
fn wrapCell(i: i32, period: i32) -> u32 { return u32(((i % period) + period) % period); }

fn noiseGrad(c: vec2u, seed: u32, f: vec2f) -> f32 {
  let a = f32(pcg3d(vec3u(c, seed)).x) * NOISE_U * 6.283185307;
  return cos(a) * f.x + sin(a) * f.y;
}

fn gnoise(p: vec2f, period: i32, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let x0 = wrapCell(i.x, period); let y0 = wrapCell(i.y, period);
  let x1 = wrapCell(i.x + 1, period); let y1 = wrapCell(i.y + 1, period);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = mix(noiseGrad(vec2u(x0, y0), seed, f), noiseGrad(vec2u(x1, y0), seed, f - vec2f(1.0, 0.0)), u.x);
  let b = mix(noiseGrad(vec2u(x0, y1), seed, f - vec2f(0.0, 1.0)), noiseGrad(vec2u(x1, y1), seed, f - vec2f(1.0)), u.x);
  return mix(a, b, u.y);
}

fn fbm(p: vec2f, period: i32, seed: u32, octaves: i32) -> f32 {
  var s = 0.0;
  var amp = 0.5;
  var f = 1.0;
  var per = period;
  for (var o = 0; o < octaves; o++) {
    s += amp * gnoise(p * f, per, seed + u32(o));
    amp *= 0.5;
    f *= 2.0;
    per *= 2;
  }
  return s;
}

// F1, F2 (cells) and F1's cell hash.
struct Cell { f1: f32, f2: f32, id: u32 }
fn worley(p: vec2f, period: i32, seed: u32) -> Cell {
  let i = vec2i(floor(p));
  var f1 = 9.0;
  var f2 = 9.0;
  var id = 0u;
  for (var j = -1; j <= 1; j++) {
    for (var k = -1; k <= 1; k++) {
      let h = pcg3d(vec3u(wrapCell(i.x + k, period), wrapCell(i.y + j, period), seed));
      let d = length(vec2f(f32(i.x + k), f32(i.y + j)) + vec2f(f32(h.x), f32(h.y)) * NOISE_U - p);
      if (d < f1) { f2 = f1; f1 = d; id = h.z; } else if (d < f2) { f2 = d; }
    }
  }
  return Cell(f1, f2, id);
}
`;
