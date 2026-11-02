// Small rocks on the ground (V1 backlog, 2026-11-02; real look, real.rocks,
// off by default). Drawn by the floor's fragment shader, not as geometry:
// a grid of cells ROCK_CELL rock sizes wide, each holding a rock with
// probability `rocks` times a clumping field (value noise ROCK_CLUMP metres
// across), a lumpy ellipsoid sunk ROCK_SINK into the ground, placed, sized
// (mostly small: 0.35 to 1.95 times rockSize, skewed by u^3) and turned by
// the cell's hash. A floor pixel intersects the eye's ray with the rocks of
// the 3x3 cells around it (so a rock's top hides the ground behind it),
// lights the nearest on its own normal, and takes the shadow the other rocks
// cast there (a ray to each ellipsoid toward the sun); the blocks' shadows
// land on rocks through the shadow map as on the ground. rockIn is the CPU
// twin of the shader's placement (tests).

/** A cell is this many rockSize wide (the largest rock, 1.95x, stays within its neighbours). */
export const ROCK_CELL = 5;
/** A rock's height (of its whole ellipsoid) over its narrower radius. */
export const ROCK_HEIGHT = 0.65;
/** How far a rock's ellipsoid is sunk into the ground, as a share of its height: its base meets the ground at an angle. */
export const ROCK_SINK = 0.12;
/** The clumping field's lattice (m): rocks gather in patches about this far apart. */
export const ROCK_CLUMP = 3;

/** pcg4d (Jarzynski and Olano 2020), as the shader hashes a cell (u32 arithmetic). */
export function rockHash(cx: number, cy: number): [number, number, number, number] {
  const v = [cx >>> 0, cy >>> 0, 0x9e3779b9, 0x85ebca6b].map((x) => (Math.imul(x, 1664525) + 1013904223) >>> 0) as [number, number, number, number];
  const mix = () => {
    v[0] = (v[0] + Math.imul(v[1], v[3])) >>> 0;
    v[1] = (v[1] + Math.imul(v[2], v[0])) >>> 0;
    v[2] = (v[2] + Math.imul(v[0], v[1])) >>> 0;
    v[3] = (v[3] + Math.imul(v[1], v[2])) >>> 0;
  };
  mix();
  for (let k = 0; k < 4; k++) v[k] = (v[k]! ^ (v[k]! >>> 16)) >>> 0;
  mix();
  return v;
}

const unit = (h: number) => (h >>> 8) / 16777216;

export interface Rock {
  /** Centre on the ground (world xz). */
  c: [number, number];
  /** Radii along its own axes (world units). */
  r: [number, number];
  /** cos and sin of its turn. */
  cs: [number, number];
  /** Height (world units). */
  h: number;
  /** Brightness 0 to 1. */
  tone: number;
}

/** The clumping field at lattice point g (value noise on rockHash, smoothstep weights): 0 to 1. */
export function rockClump(gx: number, gy: number): number {
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v = (x: number, y: number) => unit(rockHash(x + 7919, y + 104729)[0]);
  return (v(ix, iy) * (1 - sx) + v(ix + 1, iy) * sx) * (1 - sy) + (v(ix, iy + 1) * (1 - sx) + v(ix + 1, iy + 1) * sx) * sy;
}

/**
 * The rock in cell (cx, cy), or null: share = its chance where the clumping
 * field is at its mean, size = rockSize, cell = cell width, clump = the
 * clumping lattice (world units).
 */
export function rockIn(cx: number, cy: number, share: number, size: number, cell: number, clump: number): Rock | null {
  const h = rockHash(cx, cy);
  const f = rockClump(((cx + 0.5) * cell) / clump, ((cy + 0.5) * cell) / clump);
  const t = Math.min(Math.max((f - 0.25) / 0.5, 0), 1);
  if (unit(h[0]) >= share * Math.min(2 * t * t * (3 - 2 * t), 1)) return null;
  const u = unit(h[3]);
  const R = size * (0.35 + 1.6 * u * u * u);
  const aspect = 0.55 + (0.45 * (h[1] & 0xff)) / 255;
  const ang = (2 * Math.PI * (h[0] & 0xff)) / 256;
  return {
    c: [(cx + 0.2 + 0.6 * unit(h[1])) * cell, (cy + 0.2 + 0.6 * unit(h[2])) * cell],
    r: [R, R * aspect],
    cs: [Math.cos(ang), Math.sin(ang)],
    h: R * aspect * ROCK_HEIGHT,
    tone: (h[2] & 0xff) / 255,
  };
}

/** The shader side: fr.rocks = (share, rockSize, cell width, clumping lattice); 0 share: none, nothing runs. */
export const ROCKS_WGSL = /* wgsl */ `
fn rockHash(cell: vec2i) -> vec4u {
  var v = vec4u(bitcast<u32>(cell.x), bitcast<u32>(cell.y), 0x9e3779b9u, 0x85ebca6bu) * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v = v ^ (v >> vec4u(16u));
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
fn rockUnit(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
const ROCK_HEIGHT = ${ROCK_HEIGHT};
const ROCK_SINK = ${ROCK_SINK};
fn rockClump(g: vec2f) -> f32 {
  let i = vec2i(floor(g));
  let f = g - floor(g);
  let s = f * f * (3.0 - 2.0 * f);
  let o = vec2i(7919, 104729);
  let a = rockUnit(rockHash(i + o).x);
  let b = rockUnit(rockHash(i + o + vec2i(1, 0)).x);
  let c = rockUnit(rockHash(i + o + vec2i(0, 1)).x);
  let d = rockUnit(rockHash(i + o + vec2i(1, 1)).x);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// A rock (rockIn's twin); r.x 0: none in this cell. h: its ellipsoid's height (a share ROCK_SINK of
// it under the ground). lobe: cos and sin of the two lobes' phases.
struct Rock { c: vec2f, r: vec2f, cs: vec2f, h: f32, tone: f32, lobe: vec4f }
fn rockIn(cell: vec2i) -> Rock {
  let h = rockHash(cell);
  let share = fr.rocks.x * min(2.0 * smoothstep(0.25, 0.75, rockClump((vec2f(cell) + 0.5) * fr.rocks.z / fr.rocks.w)), 1.0);
  if (rockUnit(h.x) >= share) { return Rock(vec2f(0.0), vec2f(0.0), vec2f(1.0, 0.0), 0.0, 0.0, vec4f(1.0, 0.0, 1.0, 0.0)); }
  let u = rockUnit(h.w);
  let R = fr.rocks.y * (0.35 + 1.6 * u * u * u);
  let aspect = 0.55 + 0.45 * f32(h.y & 0xffu) / 255.0;
  let ang = 6.2831853 * f32(h.x & 0xffu) / 256.0;
  let a = 6.2831853 * f32(h.w & 0xffu) / 256.0;
  let b = 6.2831853 * f32((h.z >> 8u) & 0xffu) / 256.0;
  let c = (vec2f(cell) + 0.2 + 0.6 * vec2f(rockUnit(h.y), rockUnit(h.z))) * fr.rocks.z;
  return Rock(c, vec2f(R, R * aspect), vec2f(cos(ang), sin(ang)), R * aspect * ROCK_HEIGHT, f32(h.z & 0xffu) / 255.0, vec4f(cos(a), sin(a), cos(b), sin(b)));
}
// o (world xz, from the centre) in the rock's own axes, over its radii.
fn rockLocal(k: Rock, o: vec2f) -> vec2f { return vec2f(k.cs.x * o.x + k.cs.y * o.y, -k.cs.y * o.x + k.cs.x * o.y) / k.r; }

// The rock's rim radius in direction u (unit, its own axes, over its radii): lumps of 2 and 3 lobes
// that move the rim by about a tenth.
fn rockRim(k: Rock, u: vec2f) -> f32 {
  let c2 = vec2f(u.x * u.x - u.y * u.y, 2.0 * u.x * u.y);
  let c3 = vec2f(u.x * (4.0 * u.x * u.x - 3.0), u.y * (3.0 - 4.0 * u.y * u.y));
  return 1.0 + 0.1 * dot(c2, k.lobe.xy) + 0.08 * dot(c3, k.lobe.zw);
}

// What the eye sees where its ray meets the ground at p (world xz; v: the ray's unit direction, down):
// n, the surface normal (up on bare ground); o and z, the point seen, from p (xz) and over the ground
// (a rock's top can stand in front of the ground behind it); cover, the share of the pixel on a rock
// (antialiased rim); sun, what the rocks let through of the sun there; ao, contact darkening at their
// feet and low on their sides; tone, the rock's brightness. All faded by the rocks' size on screen.
struct RockHit { n: vec3f, o: vec2f, z: f32, cover: f32, sun: f32, ao: f32, tone: f32 }
fn rocksAt(p: vec2f, v: vec3f, pxW: f32) -> RockHit {
  var hit = RockHit(vec3f(0.0, 1.0, 0.0), vec2f(0.0), 0.0, 0.0, 1.0, 1.0, 0.0);
  // Fades in as rockSize grows from 1.5 to 5 pixels; under 1.5, nothing runs.
  let fade = smoothstep(1.5, 5.0, fr.rocks.y / max(pxW, 1e-6));
  if (fade <= 0.0 || v.y >= 0.0) { return hit; }
  // Back along the ray toward the eye, per unit of height: a rock up to maxH tall can hide p from
  // as far as back * maxH in front of it, so the 3x3 cells searched are centred half way there
  // (one cell of reach at most: under about 12 degrees of view the far side is missed).
  let maxH = 1.95 * fr.rocks.y * ROCK_HEIGHT;
  var back = -v.xz / -v.y;
  let reach = length(back) * maxH;
  if (reach > fr.rocks.z) { back *= fr.rocks.z / reach; }
  let base = vec2i(floor((p + 0.5 * back * maxH) / fr.rocks.z));
  // The view ray from p back toward the eye, s per unit of height: (p, 0) + s (back, 1) * (-v.y)...
  // in each rock's scaled space (a unit ball whose centre is ROCK_SINK under the ground), from X0 along Dv:
  // the largest root is where the eye meets it.
  var top = -1;
  var topS = 0.0;
  var topX = vec3f(0.0);
  var topCover = 0.0;
  var rocks: array<Rock, 9>;
  let foot = sqrt(1.0 - ROCK_SINK * ROCK_SINK); // its footprint's radius in ball units
  for (var i = 0; i < 9; i++) {
    let k = rockIn(base + vec2i(i % 3 - 1, i / 3 - 1));
    rocks[i] = k;
    if (k.r.x <= 0.0) { continue; }
    let q = rockLocal(k, p - k.c);
    // Contact darkening on the ground at its foot, on the side away from the sun (toward it, the sun
    // and the sky reach in; all round, it read as a crater rim).
    let lq = max(length(q), 1e-6);
    let away = smoothstep(-0.2, 0.6, dot(normalize(p - k.c + 1e-6), -normalize(fr.sun.xz + 1e-6)));
    hit.ao *= mix(1.0, mix(0.85, 1.0, smoothstep(foot, 1.12 * foot, lq / rockRim(k, q / lq))), away);
    let X0 = vec3f(q, ROCK_SINK);
    let Dv = vec3f(rockLocal(k, -v.xz), -v.y / k.h);
    let DD = dot(Dv, Dv);
    let b = dot(X0, Dv) / DD;
    // Its rim where the ray passes: the lobes in the direction of the ray's closest approach, then once more there.
    let m0 = X0 - b * Dv;
    let u0 = select(vec2f(1.0, 0.0), normalize(m0.xy), length(m0.xy) > 1e-6);
    let rr = rockRim(k, u0);
    // Scale the ball's xz by rr: (x/rr)^2 + z^2 = 1.
    let Xs = vec3f(X0.xy / rr, X0.z);
    let Ds = vec3f(Dv.xy / rr, Dv.z);
    let A = dot(Ds, Ds);
    let B = dot(Xs, Ds) / A;
    let C = (dot(Xs, Xs) - 1.0) / A;
    let disc = B * B - C;
    // How close the ray passes, 1 at the rim: its rim antialiased over the pixel's footprint there.
    let m = sqrt(max(dot(Xs, Xs) - B * B * A, 0.0));
    let cover = clamp((1.0 - m) * k.r.y / max(pxW, 1e-6) + 0.5, 0.0, 1.0);
    if (cover <= 0.0) { continue; }
    let sHit = -B + sqrt(max(disc, 0.0));
    if (sHit <= 0.0) { continue; } // behind p: the ground there is in front of it
    if (sHit > topS) { top = i; topS = sHit; topX = (Xs + sHit * Ds) * vec3f(rr, rr, 1.0); topCover = cover; }
  }
  var z = 0.0;
  if (top >= 0) {
    let k = rocks[top];
    z = max(topX.z - ROCK_SINK, 0.0) * k.h;
    // The point seen, from p: s along (back, 1) in height units.
    hit.o = -v.xz / -v.y * z;
    // The ellipsoid's normal: grad (|q|^2 + (z/h)^2), q turned back to world xz.
    let g = topX.xy / k.r;
    let gx = vec2f(k.cs.x * g.x - k.cs.y * g.y, k.cs.y * g.x + k.cs.x * g.y);
    let n = normalize(vec3f(gx.x, max(topX.z, ROCK_SINK) / k.h, gx.y));
    hit.n = normalize(mix(vec3f(0.0, 1.0, 0.0), n, topCover * fade));
    hit.cover = topCover * fade;
    hit.tone = k.tone;
    // Low on its sides it sees less sky; the ground's contact darkening is behind it.
    hit.ao = mix(hit.ao, mix(0.7, 1.0, max(topX.z - ROCK_SINK, 0.0) / (1.0 - ROCK_SINK)), topCover);
  }
  // The other rocks' shadows: the ray from the point seen toward the sun against each ellipsoid. The sun's
  // penumbra at a few centimetres is under a millimetre, so the edge is softened over a pixel only.
  let s = fr.sun;
  if (s.y > 0.0) {
    let ps = p + hit.o;
    for (var i = 0; i < 9; i++) {
      let k = rocks[i];
      if (k.r.x <= 0.0 || i == top) { continue; }
      let X = vec3f(rockLocal(k, ps - k.c), z / k.h + ROCK_SINK);
      let D = vec3f(rockLocal(k, s.xz), s.y / k.h);
      let XD = dot(X, D);
      if (XD >= 0.0) { continue; } // it is behind, away from the sun
      let m = sqrt(max(dot(X, X) - XD * XD / dot(D, D), 0.0));
      let soft = clamp(0.5 * pxW / k.r.x, 0.01, 0.3);
      hit.sun *= smoothstep(1.0 - soft, 1.0, m);
    }
  }
  hit.o *= hit.cover;
  hit.z = z * hit.cover;
  hit.sun = mix(1.0, hit.sun, fade);
  hit.ao = mix(1.0, hit.ao, fade);
  return hit;
}
`;
