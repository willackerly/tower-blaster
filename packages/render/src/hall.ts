// An exhibition hall around the scene (Kapla step K3; Olympia London's Grand
// Hall, where the 100k-plank record tower stood): a glazed barrel vault on
// lattice ribs, iron columns, a gallery all round, and glazed end screens.
//
// Everything is analytic, traced per pixel by hallTrace (WGSL HALL_WGSL, CPU
// twin hallTraceCpu for tests): one cylinder for the vault, a slab-annulus
// test per rib, a cylinder per column, planes and boxes for the rest. No
// meshes, no textures, and the cost does not grow with the hall's size.
// Alternatives considered: instanced boxes through the body pipeline (shadows
// and AO for free, but a lattice girder is hundreds of members, the glazing
// needs a transparent pass, and the box pipeline is fed by the physics' slots)
// and a baked environment map (cheap, but no parallax, so the camera could not
// move through the hall). Small detail (purlins, glazing bars, mullions,
// lattice of the balustrade) is left to the shading, from the hit's uv.
//
// Frame: metres, the hall's floor centre at the origin, y up, the vault's
// axis along z. The vault is a circular arc springing at (+-span/2, spring)
// through (0, crown). Ribs stand every `bay` along z, symmetric about z = 0.
import type { V3 } from './math.ts';

export interface HallParams {
  /** Clear span between the column lines, crown height and the arch's spring height, m. */
  span: number;
  crown: number;
  spring: number;
  /** Length between the end screens, rib spacing, m. */
  length: number;
  bay: number;
  /** Rib (lattice girder) depth, width and chord thickness, m. */
  ribDepth: number;
  ribWidth: number;
  chord: number;
  /** Lattice bar width in the ribs' webs, m. */
  bar: number;
  /** Column radius, m. */
  column: number;
  /** Gallery: deck height, depth behind the column line, deck thickness, balustrade height, m. */
  gallery: number;
  galleryDepth: number;
  deck: number;
  balustrade: number;
  /** Half-angles from the crown of the clear glazing and of the crown lantern, degrees; beyond the glazing, roof panels. */
  clear: number;
  lantern: number;
}

/** Olympia's Grand Hall (1886): 53 m span, 31 m to the crown, lattice ribs 2.1 m deep every 10.4 m, 134 m long. */
export const OLYMPIA: HallParams = {
  span: 53, crown: 31, spring: 11, length: 134, bay: 10.4,
  ribDepth: 2.1, ribWidth: 0.5, chord: 0.25, bar: 0.1, column: 0.35,
  gallery: 6.5, galleryDepth: 9, deck: 0.45, balustrade: 1.1,
  clear: 30, lantern: 2.5,
};

/** The hall scaled by s: every length times s, the glazing's angles kept. */
export function hallScaled(h: HallParams, s: number): HallParams {
  const o = { ...h };
  for (const k of Object.keys(h) as (keyof HallParams)[]) if (k !== 'clear' && k !== 'lantern') o[k] = h[k] * s;
  return o;
}

/** Is p (hall metres) inside the hall: above the floor, within the outer walls and end screens, under the vault? */
export function hallInside(h: HallParams, p: V3): boolean {
  const { R, yc } = hallArch(h);
  return p[1] >= 0 && Math.abs(p[0]) <= h.span / 2 + h.galleryDepth && Math.abs(p[2]) <= h.length / 2 && (p[1] < h.spring || Math.hypot(p[0], p[1] - yc) <= R);
}

/** The balustrade's bottom and top rails' heights and its lattice's pitch and bar width, m (a person's size, whatever the hall's). */
export const BALUSTRADE = { bottom: 0.06, top: 0.08, pitch: 0.3, bar: 0.025 } as const;

/** Is (z, y) on the balustrade (y up from the deck, below its height hb): a rail or a lattice bar? */
export function hallBalustrade(z: number, y: number, hb: number): boolean {
  return y < BALUSTRADE.bottom || y > hb - BALUSTRADE.top || hallLattice(z, y / BALUSTRADE.pitch, BALUSTRADE.pitch, BALUSTRADE.bar);
}

/** What a hall ray hit (HallHit.mat). */
export const HALL_MAT = { none: 0, glass: 1, panel: 2, iron: 3, wall: 4, rail: 5, lantern: 6, screen: 7 } as const;

/** The arch's radius and its centre's height, and the spring's half-angle from the crown (radians). */
export function hallArch(h: HallParams): { R: number; yc: number; spring: number } {
  const a = h.span / 2, f = h.crown - h.spring;
  const R = (a * a + f * f) / (2 * f);
  return { R, yc: h.crown - R, spring: Math.atan2(a, h.spring - (h.crown - R)) };
}

/** Number of ribs: one at z = 0 and every bay either side, inside the end screens. */
export function hallRibs(h: HallParams): number {
  return 2 * Math.floor((h.length / 2 - h.ribWidth) / h.bay) + 1;
}

/** The uniform block hallTrace reads (6 vec4f; the last holds cos and sin of the spring's half-angle, so both twins use the same rounded values). */
export function hallUniform(h: HallParams): Float32Array {
  const { R, yc, spring } = hallArch(h);
  const d = Math.PI / 180;
  return new Float32Array([
    h.span / 2, h.spring, h.crown, h.length / 2,
    h.bay, h.ribDepth, h.ribWidth, h.chord,
    h.column, h.gallery, h.galleryDepth, h.deck,
    R, yc, hallRibs(h), spring,
    h.balustrade, h.bar, h.clear * d, h.lantern * d,
    Math.cos(spring), Math.sin(spring), 0, 0,
  ]);
}

export interface HallHit {
  /** Ray distance; Infinity for none. */
  t: number;
  mat: number;
  /** Unit normal facing the ray. */
  n: V3;
  /** Surface coordinates for the shading's patterns (see HALL_WGSL). */
  uv: [number, number];
}

// ---------------------------------------------------------------- CPU twin

const NONE: HallHit = { t: Infinity, mat: HALL_MAT.none, n: [0, 1, 0], uv: [0, 0] };
const BIG = 1e30;

/** Interval of t where the ray is within radius r of the axis (x = 0, y = yc); empty as [BIG, -BIG]. */
function cylIn(o: V3, d: V3, yc: number, r: number): [number, number] {
  const ox = o[0], oy = o[1] - yc;
  const A = d[0] * d[0] + d[1] * d[1], B = ox * d[0] + oy * d[1], C = ox * ox + oy * oy - r * r;
  if (A < 1e-12) return C <= 0 ? [-BIG, BIG] : [BIG, -BIG];
  const disc = B * B - A * C;
  if (disc < 0) return [BIG, -BIG];
  // The stable form: q and the two roots q / A and C / q, without cancellation.
  const q = -(B + (B >= 0 ? 1 : -1) * Math.sqrt(disc)), t0 = q / A, t1 = q !== 0 ? C / q : t0;
  return t0 < t1 ? [t0, t1] : [t1, t0];
}

/** Interval of t where |p.k - c| <= hw along axis k. */
function slab(o: number, d: number, c: number, hw: number): [number, number] {
  if (Math.abs(d) < 1e-12) return Math.abs(o - c) <= hw ? [-BIG, BIG] : [BIG, -BIG];
  const t0 = (c - hw - o) / d, t1 = (c + hw - o) / d;
  return t0 < t1 ? [t0, t1] : [t1, t0];
}

/**
 * First t > 0 in [lo, hi] where the ray is in the annulus r0 <= r <= r1
 * about the vault's axis, and which bound it entered by: 0 the interval's
 * start (a rib's side), 1 the inner cylinder, 2 the outer one; -1 for none
 * (a ray starting inside the annulus does not hit it).
 */
function annulus(o: V3, d: V3, yc: number, r0: number, r1: number, lo: number, hi: number): [number, number] {
  const out = cylIn(o, d, yc, r1), inn = cylIn(o, d, yc, r0);
  // Inside the outer cylinder and outside the inner one: [out0, min(out1, inn0)] (entered across the outer
  // cylinder) and [max(out0, inn1), out1] (across the inner one, unless out0 is later); one piece when the inner is missed.
  const pieces: Array<[number, number, number]> = inn[0] > inn[1]
    ? [[out[0], out[1], 2]]
    : [[out[0], Math.min(out[1], inn[0]), 2], [Math.max(out[0], inn[1]), out[1], inn[1] >= out[0] ? 1 : 2]];
  let best = BIG, how = -1;
  for (const [a, b, enter] of pieces) {
    const s = Math.max(a, lo);
    if (s > Math.min(b, hi) || s <= 0 || s >= best) continue;
    best = s;
    how = lo > a ? 0 : enter;
  }
  return [best, how];
}

/**
 * Where the walk over the bay lines starts and which way it goes: from the
 * line before the first whose slab |z - zk| <= m the ray can still reach
 * (one early, so rounding never skips it), in the direction of d.z (up
 * when it is 0). The GPU twin computes the same in f32.
 */
export function hallRibOrder(oz: number, dz: number, nr: number, bay: number, m: number): [number, number] {
  const c = (nr - 1) / 2;
  return dz >= 0 ? [Math.max(Math.ceil((oz - m) / bay + c) - 1, 0), 1] : [Math.min(Math.floor((oz + m) / bay + c) + 1, nr - 1), -1];
}

const at = (o: V3, d: V3, t: number): V3 => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
const facing = (n: V3, d: V3): V3 => (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0 ? [-n[0], -n[1], -n[2]] : n);
const fract = (x: number) => x - Math.floor(x);

/** Lattice of crossing diagonals at 45 degrees: is (s, h) on a bar? p: panel length, w: bar width (both m), h in panel heights. */
export function hallLattice(s: number, h: number, p: number, w: number): boolean {
  const u = s / p, k = (w * Math.SQRT2) / (2 * p);
  return Math.abs(fract(u - h + 0.5) - 0.5) < k || Math.abs(fract(u + h + 0.5) - 0.5) < k;
}

/**
 * The first hall surface along the ray from o (inside the hall) in unit
 * direction d, with uv:
 * - vault (glass, panel, lantern): angle from the crown (rad), z;
 * - rib: arc length along the rib's mid-radius, height in the web (0..1, chords outside);
 * - column: angle around it, y; wall, rail, screen: the plane's in-plane coordinates.
 * all: test every bay line in index order, without the front-to-back early
 * exit (the reference the walk is tested against).
 */
export function hallTraceCpu(h: HallParams, o: V3, d: V3, all = false): HallHit {
  const u = hallUniform(h);
  const a = u[0]!, hs = u[1]!, L2 = u[3]!, bay = u[4]!, rd = u[5]!, rw = u[6]!, ch = u[7]!;
  const rc = u[8]!, hg = u[9]!, gd = u[10]!, deck = u[11]!, R = u[12]!, yc = u[13]!, nr = u[14]!, ths = u[15]!;
  const hb = u[16]!, bar = u[17]!, clear = u[18]!, lantern = u[19]!, cs = u[20]!, ss = u[21]!;
  let best: HallHit = NONE;
  const take = (t: number, mat: number, n: V3, uv: [number, number]) => { if (t > 0 && t < best.t) best = { t, mat, n: facing(n, d), uv }; };

  // Vault: where the ray leaves the arch's cylinder, above the spring.
  const v = cylIn(o, d, yc, R);
  if (v[1] > 0 && v[1] < BIG) {
    const p = at(o, d, v[1]);
    if (p[1] >= hs && Math.abs(p[2]) <= L2) {
      const th = Math.atan2(p[0], p[1] - yc), at2 = Math.abs(th);
      take(v[1], at2 < lantern ? HALL_MAT.lantern : at2 < clear ? HALL_MAT.glass : HALL_MAT.panel, [-p[0] / R, -(p[1] - yc) / R, 0], [th, p[2]]);
    }
  }
  // End screens: glazed inside the arch above the spring, wall below.
  if (Math.abs(d[2]) > 1e-12) {
    const zs = d[2] > 0 ? L2 : -L2, t = (zs - o[2]) / d[2], p = at(o, d, t);
    const r = Math.hypot(p[0], p[1] - yc);
    if (p[1] >= 0 && ((p[1] < hs && Math.abs(p[0]) <= a + gd) || (p[1] >= hs && r <= R))) take(t, p[1] >= hs ? HALL_MAT.screen : HALL_MAT.wall, [0, 0, 1], [p[0], p[1]]);
  }
  for (const sx of [-1, 1]) {
    // Outer wall and the aisle's ceiling (at the spring), behind the column line.
    if (Math.abs(d[0]) > 1e-12) {
      const t = (sx * (a + gd) - o[0]) / d[0], p = at(o, d, t);
      if (p[1] >= 0 && p[1] <= hs && Math.abs(p[2]) <= L2) take(t, HALL_MAT.wall, [1, 0, 0], [p[2], p[1]]);
    }
    if (Math.abs(d[1]) > 1e-12) {
      const t = (hs - o[1]) / d[1], p = at(o, d, t);
      if (sx * p[0] >= a && sx * p[0] <= a + gd && Math.abs(p[2]) <= L2) take(t, HALL_MAT.wall, [0, 1, 0], [p[0], p[2]]);
    }
    // Gallery deck: a box from the column line back to the wall.
    {
      const x0 = sx > 0 ? a : -a - gd, ix = slab(o[0], d[0], x0 + gd / 2, gd / 2), iy = slab(o[1], d[1], hg - deck / 2, deck / 2), iz = slab(o[2], d[2], 0, L2);
      const t0 = Math.max(ix[0], iy[0], iz[0]), t1 = Math.min(ix[1], iy[1], iz[1]);
      if (t0 <= t1 && t0 > 0) {
        const n: V3 = t0 === ix[0] ? [1, 0, 0] : t0 === iy[0] ? [0, 1, 0] : [0, 0, 1];
        const p = at(o, d, t0);
        take(t0, HALL_MAT.wall, n, [p[2], p[1]]);
      }
    }
    // Balustrade on the column line: rails and a lattice between.
    if (Math.abs(d[0]) > 1e-12) {
      const t = (sx * a - o[0]) / d[0], p = at(o, d, t), y = p[1] - hg;
      if (y >= 0 && y <= hb && Math.abs(p[2]) <= L2 && hallBalustrade(p[2], y, hb)) take(t, HALL_MAT.rail, [1, 0, 0], [p[2], y]);
    }
  }
  // Columns and ribs, one per bay line, front to back along the ray's z
  // (hallRibOrder): past the first whose slab starts beyond the nearest hit
  // so far, none can be nearer. all: every bay line, in index order (tests).
  const [k0, sz] = hallRibOrder(o[2], d[2], nr, bay, Math.max(rw / 2, rc));
  for (let i = 0; i < nr; i++) {
    const k = all ? i : k0 + i * sz;
    if (k < 0 || k >= nr) break;
    const zk = (k - (nr - 1) / 2) * bay;
    const ez = slab(o[2], d[2], zk, Math.max(rw / 2, rc));
    if (!all && ez[0] <= ez[1] && ez[1] > 0 && ez[0] >= best.t) break;
    for (const sx of [-1, 1]) {
      // Vertical cylinder at (sx a, zk), solved from the ray's closest approach to its axis
      // (C = |o|^2 - rc^2 would cancel catastrophically in f32 tens of metres away).
      const ox = o[0] - sx * a, oz = o[2] - zk;
      const A = d[0] * d[0] + d[2] * d[2];
      if (A > 1e-12) {
        const tc = -(ox * d[0] + oz * d[2]) / A, px = ox + tc * d[0], pz = oz + tc * d[2], e = rc * rc - (px * px + pz * pz);
        if (e >= 0) {
          const t = tc - Math.sqrt(e / A), p = at(o, d, t);
          if (p[1] >= 0 && p[1] <= hs) take(t, HALL_MAT.iron, [(p[0] - sx * a) / rc, 0, (p[2] - zk) / rc], [Math.atan2(p[2] - zk, p[0] - sx * a), p[1]]);
        }
      }
    }
    // Rib: chords (solid) and lattice webs on both sides, in the slab |z - zk| <= rw / 2.
    const iz = slab(o[2], d[2], zk, rw / 2);
    if (iz[0] > iz[1] || iz[1] <= 0 || iz[0] >= best.t) continue;
    const inRange = (p: V3) => Math.abs(Math.atan2(p[0], p[1] - yc)) <= ths;
    const uvOf = (p: V3): [number, number] => {
      const r = Math.hypot(p[0], p[1] - yc);
      return [(R - rd / 2) * Math.atan2(p[0], p[1] - yc), (r - (R - rd + ch)) / (rd - 2 * ch)];
    };
    for (const [r0, r1] of [[R - rd, R - rd + ch], [R - ch, R]] as const) {
      const [t, how] = annulus(o, d, yc, r0, r1, iz[0], iz[1]);
      if (how < 0 || t >= best.t) continue;
      const p = at(o, d, t);
      if (!inRange(p)) continue;
      const n: V3 = how === 0 ? [0, 0, 1] : [p[0], p[1] - yc, 0].map((x) => x / (how === 1 ? r0 : r1)) as V3;
      take(t, HALL_MAT.iron, n, uvOf(p));
    }
    for (const t of iz) {
      if (t <= 0 || t >= best.t) continue;
      const p = at(o, d, t), r = Math.hypot(p[0], p[1] - yc);
      if (r < R - rd + ch || r > R - ch || !inRange(p)) continue;
      const [s, hh] = uvOf(p);
      if (hallLattice(s, hh, rd - 2 * ch, bar)) take(t, HALL_MAT.iron, [0, 0, 1], [s, hh]);
    }
    // The chords' ends at the springs: the planes through the vault's axis at angles +-ths.
    for (const sg of [-1, 1]) {
      const th = sg * ths, c = cs, sn = sg * ss, den = d[0] * c - d[1] * sn;
      if (Math.abs(den) < 1e-12) continue;
      const t = -(o[0] * c - (o[1] - yc) * sn) / den;
      if (t <= 0 || t >= best.t || t < iz[0] || t > iz[1]) continue;
      const p = at(o, d, t), rho = p[0] * sn + (p[1] - yc) * c;
      if ((rho >= R - rd && rho <= R - rd + ch) || (rho >= R - ch && rho <= R)) take(t, HALL_MAT.iron, [c, -sn, 0], [(R - rd / 2) * th, (rho - (R - rd + ch)) / (rd - 2 * ch)]);
    }
  }
  return best;
}

// ---------------------------------------------------------------- mesh

/** Floats per hall mesh vertex: position (m), normal (either side: the shader turns it to the eye), uv, material (HALL_MAT), pattern (HALL_PATTERN). */
export const HALL_VERTEX = 10;
/**
 * What the fragment shader cuts out of a face: nothing; the ribs' web
 * lattice (uv: arc length at the web's middle in web panels, height in the
 * web, 0 to 1); the balustrade's rails and lattice (uv: z, height above the
 * deck, m). The CPU twin is hallLattice and hallBalustrade.
 */
export const HALL_PATTERN = { solid: 0, web: 1, balustrade: 2 } as const;

/** The hall as triangles (hall metres): opaque surfaces, ordered near-first for early depth rejection (ribs, columns, balustrade, then the envelope), and the glazing. */
export interface HallMesh { opaque: Float32Array; glass: Float32Array }

/** Angles from a to b in equal steps of at most step, both ends included. */
function steps(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((b - a) / step));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/**
 * The hall's surfaces as a triangle mesh, the rasterized counterpart of
 * hallTraceCpu: the same surfaces, curved ones as facets with their
 * vertices on the true surface (arcs every `arc` radians, columns of
 * `column` sides), and the lattices as flat faces whose bars the fragment
 * shader cuts (HALL_PATTERN). Faces hidden from inside are left out: the
 * ribs' outer chords' backs (against the glass), and the decks' ends and
 * backs (against the walls).
 */
export function hallMesh(h: HallParams, arc = 0.025, column = 16): HallMesh {
  const { R, yc, spring: ths } = hallArch(h);
  const a = h.span / 2, hs = h.spring, L2 = h.length / 2, gd = h.galleryDepth, rd = h.ribDepth, rw = h.ribWidth, ch = h.chord;
  const d = Math.PI / 180, clear = h.clear * d, lantern = h.lantern * d;
  const opaque: number[] = [], glass: number[] = [];
  type Vtx = [V3, V3, [number, number]];
  const tri = (out: number[], mat: number, pat: number, ...vs: Vtx[]) => { for (const [p, n, uv] of vs) out.push(...p, ...n, ...uv, mat, pat); };
  const quad = (out: number[], mat: number, pat: number, v0: Vtx, v1: Vtx, v2: Vtx, v3: Vtx) => tri(out, mat, pat, v0, v1, v2, v0, v2, v3);
  const ring = (r: number, th: number, z: number): V3 => [r * Math.sin(th), yc + r * Math.cos(th), z];
  const radial = (th: number): V3 => [Math.sin(th), Math.cos(th), 0];
  const zAxis: V3 = [0, 0, 1], xAxis: V3 = [1, 0, 0], yAxis: V3 = [0, 1, 0];
  const nr = hallRibs(h);
  const ribTh = steps(-ths, ths, arc);

  // Ribs: the chords' faces seen from inside, solid; the webs' faces, latticed.
  const p = rd - 2 * ch, sMid = R - rd / 2;
  for (let k = 0; k < nr; k++) {
    const zk = (k - (nr - 1) / 2) * h.bay, z0 = zk - rw / 2, z1 = zk + rw / 2;
    for (let i = 0; i + 1 < ribTh.length; i++) {
      const t0 = ribTh[i]!, t1 = ribTh[i + 1]!;
      for (const r of [R - rd, R - rd + ch, R - ch]) {
        quad(opaque, HALL_MAT.iron, HALL_PATTERN.solid, [ring(r, t0, z0), radial(t0), [sMid * t0, r]], [ring(r, t1, z0), radial(t1), [sMid * t1, r]], [ring(r, t1, z1), radial(t1), [sMid * t1, r]], [ring(r, t0, z1), radial(t0), [sMid * t0, r]]);
      }
      for (const z of [z0, z1]) {
        for (const [r0, r1] of [[R - rd, R - rd + ch], [R - ch, R]] as const) {
          quad(opaque, HALL_MAT.iron, HALL_PATTERN.solid, [ring(r0, t0, z), zAxis, [sMid * t0, r0]], [ring(r0, t1, z), zAxis, [sMid * t1, r0]], [ring(r1, t1, z), zAxis, [sMid * t1, r1]], [ring(r1, t0, z), zAxis, [sMid * t0, r1]]);
        }
        const r0 = R - rd + ch, r1 = R - ch;
        quad(opaque, HALL_MAT.iron, HALL_PATTERN.web, [ring(r0, t0, z), zAxis, [(sMid * t0) / p, 0]], [ring(r0, t1, z), zAxis, [(sMid * t1) / p, 0]], [ring(r1, t1, z), zAxis, [(sMid * t1) / p, 1]], [ring(r1, t0, z), zAxis, [(sMid * t0) / p, 1]]);
      }
    }
    // The chords' ends at the springs.
    for (const th of [-ths, ths]) {
      const n: V3 = [Math.cos(th), -Math.sin(th), 0];
      for (const [r0, r1] of [[R - rd, R - rd + ch], [R - ch, R]] as const) {
        quad(opaque, HALL_MAT.iron, HALL_PATTERN.solid, [ring(r0, th, z0), n, [sMid * th, r0]], [ring(r1, th, z0), n, [sMid * th, r1]], [ring(r1, th, z1), n, [sMid * th, r1]], [ring(r0, th, z1), n, [sMid * th, r0]]);
      }
    }
    // Columns on the bay line.
    for (const sx of [-1, 1]) {
      const phi = steps(0, 2 * Math.PI, (2 * Math.PI) / column);
      for (let i = 0; i + 1 < phi.length; i++) {
        const f0 = phi[i]!, f1 = phi[i + 1]!;
        const at = (f: number, y: number): V3 => [sx * a + h.column * Math.cos(f), y, zk + h.column * Math.sin(f)];
        const n0: V3 = [Math.cos(f0), 0, Math.sin(f0)], n1: V3 = [Math.cos(f1), 0, Math.sin(f1)];
        quad(opaque, HALL_MAT.iron, HALL_PATTERN.solid, [at(f0, 0), n0, [f0, 0]], [at(f1, 0), n1, [f1, 0]], [at(f1, hs), n1, [f1, hs]], [at(f0, hs), n0, [f0, hs]]);
      }
    }
  }
  for (const sx of [-1, 1]) {
    const xa = sx * a, xw = sx * (a + gd), hg = h.gallery, hb = h.balustrade;
    // Balustrade on the column line, latticed.
    quad(opaque, HALL_MAT.rail, HALL_PATTERN.balustrade, [[xa, hg, -L2], xAxis, [-L2, 0]], [[xa, hg, L2], xAxis, [L2, 0]], [[xa, hg + hb, L2], xAxis, [L2, hb]], [[xa, hg + hb, -L2], xAxis, [-L2, hb]]);
    // Gallery deck: top, underside, front.
    for (const y of [hg, hg - h.deck]) quad(opaque, HALL_MAT.wall, HALL_PATTERN.solid, [[xa, y, -L2], yAxis, [-L2, y]], [[xw, y, -L2], yAxis, [-L2, y]], [[xw, y, L2], yAxis, [L2, y]], [[xa, y, L2], yAxis, [L2, y]]);
    quad(opaque, HALL_MAT.wall, HALL_PATTERN.solid, [[xa, hg - h.deck, -L2], xAxis, [-L2, hg - h.deck]], [[xa, hg - h.deck, L2], xAxis, [L2, hg - h.deck]], [[xa, hg, L2], xAxis, [L2, hg]], [[xa, hg, -L2], xAxis, [-L2, hg]]);
    // Outer wall, and the aisle's ceiling at the spring.
    quad(opaque, HALL_MAT.wall, HALL_PATTERN.solid, [[xw, 0, -L2], xAxis, [-L2, 0]], [[xw, 0, L2], xAxis, [L2, 0]], [[xw, hs, L2], xAxis, [L2, hs]], [[xw, hs, -L2], xAxis, [-L2, hs]]);
    quad(opaque, HALL_MAT.wall, HALL_PATTERN.solid, [[xa, hs, -L2], yAxis, [xa, -L2]], [[xw, hs, -L2], yAxis, [xw, -L2]], [[xw, hs, L2], yAxis, [xw, L2]], [[xa, hs, L2], yAxis, [xa, L2]]);
  }
  // End walls below the spring, and the glazed end screens above it (a fan over the arch's segment).
  const screenTh = steps(-ths, ths, arc);
  for (const zs of [-L2, L2]) {
    const W = a + gd;
    quad(opaque, HALL_MAT.wall, HALL_PATTERN.solid, [[-W, 0, zs], zAxis, [-W, 0]], [[W, 0, zs], zAxis, [W, 0]], [[W, hs, zs], zAxis, [W, hs]], [[-W, hs, zs], zAxis, [-W, hs]]);
    for (let i = 0; i + 1 < screenTh.length; i++) {
      const q0 = ring(R, screenTh[i]!, zs), q1 = ring(R, screenTh[i + 1]!, zs);
      tri(glass, HALL_MAT.screen, HALL_PATTERN.solid, [[0, hs, zs], zAxis, [0, hs]], [q0, zAxis, [q0[0], q0[1]]], [q1, zAxis, [q1[0], q1[1]]]);
    }
  }
  // The vault: roof panels at the sides, clear glass, the crown lantern; uv: arc length, z.
  const bands = [-ths, -clear, -lantern, lantern, clear, ths];
  for (let b = 0; b + 1 < bands.length; b++) {
    const th = steps(bands[b]!, bands[b + 1]!, arc), mid = Math.abs((bands[b]! + bands[b + 1]!) / 2);
    const mat = mid < lantern ? HALL_MAT.lantern : mid < clear ? HALL_MAT.glass : HALL_MAT.panel;
    for (let i = 0; i + 1 < th.length; i++) {
      const t0 = th[i]!, t1 = th[i + 1]!;
      quad(mat === HALL_MAT.panel ? opaque : glass, mat, HALL_PATTERN.solid, [ring(R, t0, -L2), radial(t0), [R * t0, -L2]], [ring(R, t1, -L2), radial(t1), [R * t1, -L2]], [ring(R, t1, L2), radial(t1), [R * t1, L2]], [ring(R, t0, L2), radial(t0), [R * t0, L2]]);
    }
  }
  return { opaque: new Float32Array(opaque), glass: new Float32Array(glass) };
}

// ---------------------------------------------------------------- WGSL

/**
 * hallTrace(hp, o, d) -> HallHit, the GPU twin of hallTraceCpu; hp is the
 * Hall struct filled from hallUniform (6 vec4f, in order). The same
 * operations in the same order, in f32.
 */
export const HALL_WGSL = /* wgsl */ `
struct Hall { g0: vec4f, g1: vec4f, g2: vec4f, g3: vec4f, g4: vec4f, g5: vec4f }
struct HallHit { t: f32, mat: u32, n: vec3f, uv: vec2f }
const HALL_BIG = 1e30;

fn hallCylIn(o: vec3f, d: vec3f, yc: f32, r: f32) -> vec2f {
  let ox = o.x; let oy = o.y - yc;
  let A = d.x * d.x + d.y * d.y; let B = ox * d.x + oy * d.y; let C = ox * ox + oy * oy - r * r;
  if (A < 1e-12) { return select(vec2f(HALL_BIG, -HALL_BIG), vec2f(-HALL_BIG, HALL_BIG), C <= 0.0); }
  let disc = B * B - A * C;
  if (disc < 0.0) { return vec2f(HALL_BIG, -HALL_BIG); }
  let q = -(B + select(-1.0, 1.0, B >= 0.0) * sqrt(disc));
  let t0 = q / A;
  let t1 = select(t0, C / q, q != 0.0);
  return vec2f(min(t0, t1), max(t0, t1));
}

fn hallSlab(o: f32, d: f32, c: f32, hw: f32) -> vec2f {
  if (abs(d) < 1e-12) { return select(vec2f(HALL_BIG, -HALL_BIG), vec2f(-HALL_BIG, HALL_BIG), abs(o - c) <= hw); }
  let t0 = (c - hw - o) / d; let t1 = (c + hw - o) / d;
  return vec2f(min(t0, t1), max(t0, t1));
}

// First t > 0 in [lo, hi] in the annulus r0 <= r <= r1 (x), and how it was entered (y): 0 side, 1 inner, 2 outer, -1 none.
fn hallAnnulus(o: vec3f, d: vec3f, yc: f32, r0: f32, r1: f32, lo: f32, hi: f32) -> vec2f {
  let outer = hallCylIn(o, d, yc, r1);
  let inner = hallCylIn(o, d, yc, r0);
  var pa = array<vec3f, 2>(vec3f(outer.x, outer.y, 2.0), vec3f(HALL_BIG, -HALL_BIG, 2.0));
  if (inner.x <= inner.y) {
    pa[0] = vec3f(outer.x, min(outer.y, inner.x), 2.0);
    pa[1] = vec3f(max(outer.x, inner.y), outer.y, select(2.0, 1.0, inner.y >= outer.x));
  }
  var best = HALL_BIG; var how = -1.0;
  for (var k = 0; k < 2; k++) {
    let a = pa[k].x;
    let s = max(a, lo);
    if (s > min(pa[k].y, hi) || s <= 0.0 || s >= best) { continue; }
    best = s;
    how = select(pa[k].z, 0.0, lo > a);
  }
  return vec2f(best, how);
}

fn hallLattice(s: f32, h: f32, p: f32, w: f32) -> bool {
  let u = s / p; let k = w * 1.4142135623730951 / (2.0 * p);
  return abs(fract(u - h + 0.5) - 0.5) < k || abs(fract(u + h + 0.5) - 0.5) < k;
}

fn hallTake(best: ptr<function, HallHit>, d: vec3f, t: f32, mat: u32, n: vec3f, uv: vec2f) {
  if (t > 0.0 && t < (*best).t) { *best = HallHit(t, mat, select(n, -n, dot(n, d) > 0.0), uv); }
}

fn hallTrace(hp: Hall, o: vec3f, d: vec3f) -> HallHit {
  let a = hp.g0.x; let hs = hp.g0.y; let L2 = hp.g0.w;
  let bay = hp.g1.x; let rd = hp.g1.y; let rw = hp.g1.z; let ch = hp.g1.w;
  let rc = hp.g2.x; let hg = hp.g2.y; let gd = hp.g2.z; let deck = hp.g2.w;
  let R = hp.g3.x; let yc = hp.g3.y; let nr = i32(hp.g3.z); let ths = hp.g3.w;
  let hb = hp.g4.x; let bar = hp.g4.y; let clearA = hp.g4.z; let lantern = hp.g4.w;
  var best = HallHit(HALL_BIG * 10.0, ${HALL_MAT.none}u, vec3f(0.0, 1.0, 0.0), vec2f(0.0));

  let v = hallCylIn(o, d, yc, R);
  if (v.y > 0.0 && v.y < HALL_BIG) {
    let p = o + v.y * d;
    if (p.y >= hs && abs(p.z) <= L2) {
      let th = atan2(p.x, p.y - yc); let at2 = abs(th);
      let mat = select(select(${HALL_MAT.panel}u, ${HALL_MAT.glass}u, at2 < clearA), ${HALL_MAT.lantern}u, at2 < lantern);
      hallTake(&best, d, v.y, mat, vec3f(-p.x / R, -(p.y - yc) / R, 0.0), vec2f(th, p.z));
    }
  }
  if (abs(d.z) > 1e-12) {
    let zs = select(-L2, L2, d.z > 0.0); let t = (zs - o.z) / d.z; let p = o + t * d;
    let r = length(vec2f(p.x, p.y - yc));
    if (p.y >= 0.0 && ((p.y < hs && abs(p.x) <= a + gd) || (p.y >= hs && r <= R))) {
      hallTake(&best, d, t, select(${HALL_MAT.wall}u, ${HALL_MAT.screen}u, p.y >= hs), vec3f(0.0, 0.0, 1.0), p.xy);
    }
  }
  for (var side = 0; side < 2; side++) {
    let sx = select(1.0, -1.0, side == 0);
    if (abs(d.x) > 1e-12) {
      let t = (sx * (a + gd) - o.x) / d.x; let p = o + t * d;
      if (p.y >= 0.0 && p.y <= hs && abs(p.z) <= L2) { hallTake(&best, d, t, ${HALL_MAT.wall}u, vec3f(1.0, 0.0, 0.0), vec2f(p.z, p.y)); }
    }
    if (abs(d.y) > 1e-12) {
      let t = (hs - o.y) / d.y; let p = o + t * d;
      if (sx * p.x >= a && sx * p.x <= a + gd && abs(p.z) <= L2) { hallTake(&best, d, t, ${HALL_MAT.wall}u, vec3f(0.0, 1.0, 0.0), p.xz); }
    }
    {
      let x0 = select(-a - gd, a, sx > 0.0);
      let ix = hallSlab(o.x, d.x, x0 + gd / 2.0, gd / 2.0); let iy = hallSlab(o.y, d.y, hg - deck / 2.0, deck / 2.0); let iz = hallSlab(o.z, d.z, 0.0, L2);
      let t0 = max(ix.x, max(iy.x, iz.x)); let t1 = min(ix.y, min(iy.y, iz.y));
      if (t0 <= t1 && t0 > 0.0) {
        let n = select(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), t0 == iy.x), vec3f(1.0, 0.0, 0.0), t0 == ix.x);
        let p = o + t0 * d;
        hallTake(&best, d, t0, ${HALL_MAT.wall}u, n, vec2f(p.z, p.y));
      }
    }
    if (abs(d.x) > 1e-12) {
      let t = (sx * a - o.x) / d.x; let p = o + t * d; let y = p.y - hg;
      if (y >= 0.0 && y <= hb && abs(p.z) <= L2 && (y < ${BALUSTRADE.bottom} || y > hb - ${BALUSTRADE.top} || hallLattice(p.z, y / ${BALUSTRADE.pitch}, ${BALUSTRADE.pitch}, ${BALUSTRADE.bar}))) {
        hallTake(&best, d, t, ${HALL_MAT.rail}u, vec3f(1.0, 0.0, 0.0), vec2f(p.z, y));
      }
    }
  }
  // Front to back along z, stopping at the first slab past the nearest hit (hallRibOrder).
  let m = max(rw / 2.0, rc); let cm = f32(nr - 1) / 2.0;
  var k0 = max(i32(ceil((o.z - m) / bay + cm)) - 1, 0); var sz = 1;
  if (d.z < 0.0) { k0 = min(i32(floor((o.z + m) / bay + cm)) + 1, nr - 1); sz = -1; }
  for (var i = 0; i < nr; i++) {
    let k = k0 + i * sz;
    if (k < 0 || k >= nr) { break; }
    let zk = (f32(k) - cm) * bay;
    let ez = hallSlab(o.z, d.z, zk, m);
    if (ez.x <= ez.y && ez.y > 0.0 && ez.x >= best.t) { break; }
    for (var side = 0; side < 2; side++) {
      let sx = select(1.0, -1.0, side == 0);
      let ox = o.x - sx * a; let oz = o.z - zk;
      let A = d.x * d.x + d.z * d.z;
      if (A > 1e-12) {
        let tc = -(ox * d.x + oz * d.z) / A; let px = ox + tc * d.x; let pz = oz + tc * d.z; let e = rc * rc - (px * px + pz * pz);
        if (e >= 0.0) {
          let t = tc - sqrt(e / A); let p = o + t * d;
          if (p.y >= 0.0 && p.y <= hs) { hallTake(&best, d, t, ${HALL_MAT.iron}u, vec3f((p.x - sx * a) / rc, 0.0, (p.z - zk) / rc), vec2f(atan2(p.z - zk, p.x - sx * a), p.y)); }
        }
      }
    }
    let iz = hallSlab(o.z, d.z, zk, rw / 2.0);
    if (iz.x > iz.y || iz.y <= 0.0 || iz.x >= best.t) { continue; }
    for (var c = 0; c < 2; c++) {
      let r0 = select(R - ch, R - rd, c == 0); let r1 = select(R, R - rd + ch, c == 0);
      let e = hallAnnulus(o, d, yc, r0, r1, iz.x, iz.y);
      if (e.y < 0.0 || e.x >= best.t) { continue; }
      let p = o + e.x * d;
      let th = atan2(p.x, p.y - yc);
      if (abs(th) > ths) { continue; }
      let r = length(vec2f(p.x, p.y - yc));
      var n = vec3f(0.0, 0.0, 1.0);
      if (e.y > 0.5) { n = vec3f(p.x, p.y - yc, 0.0) / select(r1, r0, e.y < 1.5); }
      hallTake(&best, d, e.x, ${HALL_MAT.iron}u, n, vec2f((R - rd / 2.0) * th, (r - (R - rd + ch)) / (rd - 2.0 * ch)));
    }
    for (var f = 0; f < 2; f++) {
      let t = select(iz.y, iz.x, f == 0);
      if (t <= 0.0 || t >= best.t) { continue; }
      let p = o + t * d; let r = length(vec2f(p.x, p.y - yc));
      let th = atan2(p.x, p.y - yc);
      if (r < R - rd + ch || r > R - ch || abs(th) > ths) { continue; }
      let s = (R - rd / 2.0) * th; let hh = (r - (R - rd + ch)) / (rd - 2.0 * ch);
      if (hallLattice(s, hh, rd - 2.0 * ch, bar)) { hallTake(&best, d, t, ${HALL_MAT.iron}u, vec3f(0.0, 0.0, 1.0), vec2f(s, hh)); }
    }
    for (var e = 0; e < 2; e++) {
      let sg = select(1.0, -1.0, e == 0);
      let th = sg * ths; let c = hp.g5.x; let sn = sg * hp.g5.y; let den = d.x * c - d.y * sn;
      if (abs(den) < 1e-12) { continue; }
      let t = -(o.x * c - (o.y - yc) * sn) / den;
      if (t <= 0.0 || t >= best.t || t < iz.x || t > iz.y) { continue; }
      let p = o + t * d; let rho = p.x * sn + (p.y - yc) * c;
      if ((rho >= R - rd && rho <= R - rd + ch) || (rho >= R - ch && rho <= R)) {
        hallTake(&best, d, t, ${HALL_MAT.iron}u, vec3f(c, -sn, 0.0), vec2f((R - rd / 2.0) * th, (rho - (R - rd + ch)) / (rd - 2.0 * ch)));
      }
    }
  }
  if (best.t >= HALL_BIG) { best.t = HALL_BIG * 10.0; }
  return best;
}
`;
