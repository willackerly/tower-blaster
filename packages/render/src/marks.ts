// Engraved marks: a glyph carved into every face of a box body, so a block's
// part in the level reads at a glance whatever its colour (Will, 2026-11-06:
// "engravings on different color stones that make it clear which ones to save
// vs hit"). Three glyphs, in different silhouettes so they read apart even where
// the colours do not (colour-blind players, a gold crown that must be held):
//
//   hit   a crosshair: a ring, a centre dot and four ticks across the ring.
//   save  a shield: an outline with a solid shield inside it.
//   keep  a crown: a solid band, three points with a jewel on each. A crown
//         the objective asks to keep standing (Undercut's hold levels): gold
//         like every crown, but neither "hit" nor "heritage" (playtest PT17).
//
// The mark is two bits of a slot's fx record (fx.ts word 1, bits 20-21), set
// with Renderer.setMarks and kept through every other setFx until clearFx.
// The scene pass carves it: inside the glyph the albedo darkens (the groove's
// floor, out of the light) and, within MARK_WALL of its edge, the normal tilts
// into the groove (its wall), so the sun picks out one side of every stroke.
// A long face carries a row of glyphs, one per square cell along it (a rod).
// Under a pixel per stroke the carving cannot resolve: the floor's darkening
// spreads to the glyph's mean cover (from a stroke a pixel wide down to half
// of one), so a distant marked block is a shade darker, never aliased dashes;
// the walls' tilt fades sooner (under two pixels of wall), where it would
// sparkle. Tuned on the game's captures: legible down to cubes ~25 px across.
//
// Glyph space: the cell's half-size is 1, +y up the face (body-local +y on a
// side face, +z on a top or bottom face), so the glyph tumbles with its body.
// markSd and engrave are the TypeScript twins of the WGSL below (tests compare
// them on the GPU).
import type { V3 } from './math.ts';

export const MARK_NONE = 0;
export const MARK_HIT = 1;
export const MARK_SAVE = 2;
export const MARK_KEEP = 3;
export type MarkId = typeof MARK_NONE | typeof MARK_HIT | typeof MARK_SAVE | typeof MARK_KEEP;
export const MARK_NAMES: Record<MarkId, string> = { 0: 'none', 1: 'hit', 2: 'save', 3: 'keep' };

/** The mark's bits in fx word 1 (fx.ts). */
export const MARK_SHIFT = 20;
export const MARK_MASK = 3 << MARK_SHIFT;

/** The groove's floor albedo multiple (1 - MARK_SHADE at full cover). */
export const MARK_SHADE = 0.72;
/** Width of the groove's wall, glyph units: the band inside the edge where the normal tilts. */
export const MARK_WALL = 0.06;
/** Tilt of the wall's normal into the groove (tan of its slope): 1 is 45 degrees. */
export const MARK_SLOPE = 0.9;
/** The thinnest stroke's half-width, glyph units (the crosshair's ticks). */
export const MARK_STROKE = 0.065;
/**
 * Pixel size over the pxM the scene pass gives (length(fwidth(local * half)): about sqrt 2 pixels on a
 * face seen square on).
 */
export const MARK_PX = 0.7;
/** The view cosine (face normal to eye) over which a carving fades in, from none to all (MARKS_WGSL carveSeen). */
export const MARK_GRAZE = [0.15, 0.4] as const;
/** Most glyphs along one face (a long rod gets a row of them). */
export const MARK_MAX_CELLS = 12;

/** Signed distance (glyph units, negative inside) from p to a heraldic shield: half-width w, flat top at y = top, point at y = -b. */
export function shieldSd(x: number, y: number, w: number, top: number, b: number): number {
  const R = (w * w + b * b) / (2 * w), ax = Math.abs(x);
  const side = y > 0 ? ax - w : Math.hypot(ax - (w - R), y) - R;
  return Math.max(side, y - top);
}

function segSd(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * The shield's outline stroke (half-width) and its inner shield's scale: a stroke half again the crosshair's
 * and a gap of about a stroke to the inner shield, so at 15-25 px the two do not blur into a cup (second-opinion
 * review, 2026-11-06: the first cut, 0.075 and 0.5, read fainter than the crosshair).
 */
const SHIELD_STROKE = 0.1;
const SHIELD_INNER = 0.55;
/** The crown's stroke (half-width): the shield outline's weight, less a little, since its band is solid. */
const CROWN_STROKE = 0.09;

/** Signed distance from (x, y) to the box of half-size (w, h) at the origin. */
function boxSd(x: number, y: number, w: number, h: number): number {
  const dx = Math.abs(x) - w, dy = Math.abs(y) - h;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/**
 * The keep glyph, a crown (mirror-symmetric, so in |x|): a solid band at the bottom, its sides rising to
 * two outer points, a zigzag down and up to the taller middle point, and a round jewel on each point.
 */
function crownSd(x: number, y: number): number {
  const q = Math.abs(x);
  const band = boxSd(x, y + 0.44, 0.52, 0.11);
  const line = Math.min(segSd(q, y, 0.5, -0.33, 0.56, 0.28), segSd(q, y, 0.56, 0.28, 0.27, -0.06), segSd(q, y, 0.27, -0.06, 0, 0.36)) - CROWN_STROKE;
  const jewel = Math.min(Math.hypot(q - 0.58, y - 0.42), Math.hypot(q, y - 0.52)) - 0.11;
  return Math.min(band, line, jewel);
}

/** Signed distance (glyph units) from (x, y) to the carved part of glyph `mark` (hit, save or keep). */
export function markSd(mark: number, x: number, y: number): number {
  if (mark === MARK_HIT) {
    const r = Math.hypot(x, y), qx = Math.abs(x), qy = Math.abs(y);
    const ring = Math.abs(r - 0.5) - 0.08;
    const dot = r - 0.17;
    const tick = Math.min(segSd(qx, qy, 0, 0.3, 0, 0.74), segSd(qx, qy, 0.3, 0, 0.74, 0)) - MARK_STROKE;
    return Math.min(ring, dot, tick);
  }
  if (mark === MARK_KEEP) return crownSd(x, y);
  const sy = y - 0.05;
  const outline = Math.abs(shieldSd(x, sy, 0.46, 0.52, 0.62)) - SHIELD_STROKE;
  const inner = SHIELD_INNER * shieldSd(x / SHIELD_INNER, sy / SHIELD_INNER, 0.46, 0.52, 0.62);
  return Math.min(outline, inner);
}

/** Fraction of the square cell [-1, 1]^2 the glyph covers (its mean darkening once it is under a pixel). */
export function markCover(mark: number, n = 256): number {
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (markSd(mark, -1 + (2 * i + 1) / n, -1 + (2 * j + 1) / n) < 0) k++;
  return k / (n * n);
}
export const MARK_COVER: Record<number, number> = { [MARK_HIT]: markCover(MARK_HIT), [MARK_SAVE]: markCover(MARK_SAVE), [MARK_KEEP]: markCover(MARK_KEEP) };

/** The face's in-plane coordinates of lp, its half-extents and its two axes (body-local), for the box face faceN. */
function faceFrame(lp: V3, faceN: V3, half: V3): { uv: [number, number]; ext: [number, number]; u: number; v: number } {
  if (faceN[0] !== 0) return { uv: [lp[2], lp[1]], ext: [half[2], half[1]], u: 2, v: 1 };
  if (faceN[1] !== 0) return { uv: [lp[0], lp[2]], ext: [half[0], half[2]], u: 0, v: 2 };
  return { uv: [lp[0], lp[1]], ext: [half[0], half[1]], u: 0, v: 1 };
}

/** Where on its cell's glyph lp falls (glyph units) and the cell's half-size c (m). */
export function markPoint(lp: V3, faceN: V3, half: V3): { p: [number, number]; c: number } {
  const { uv, ext } = faceFrame(lp, faceN, half), c = Math.min(ext[0], ext[1]);
  const p = uv.map((x, k) => {
    const e = ext[k]!, n = Math.min(MARK_MAX_CELLS, Math.max(1, Math.round(e / c))), cell = (2 * e) / n;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x + e) / cell)));
    return (x + e - cell * (i + 0.5)) / c;
  }) as [number, number];
  return { p, c };
}

/**
 * The carving at body-local point lp (m) on the box face faceN of a box of half-extents half, seen at
 * pxM metres per pixel: the albedo multiple and the body-local normal tilt to add before normalizing.
 */
export function engrave(mark: number, lp: V3, faceN: V3, half: V3, pxM: number): { shade: number; dn: V3 } {
  if (mark !== MARK_HIT && mark !== MARK_SAVE && mark !== MARK_KEEP) return { shade: 1, dn: [0, 0, 0] };
  const { u, v } = faceFrame(lp, faceN, half), { p, c } = markPoint(lp, faceN, half);
  const f32 = Math.fround;
  const d = markSd(mark, p[0], p[1]);
  const px = Math.max(MARK_PX * pxM, 1e-9);
  // The thinnest stroke from half a pixel wide to one: the carving resolves (else its mean shade).
  const lod = smoothstep(0.5, 1, (2 * MARK_STROKE * c) / px);
  // The walls tilt the normal only once they are a pixel or two wide (narrower, they would sparkle).
  const wallLod = smoothstep(0.75, 2, (MARK_WALL * c) / px);
  const sharp = Math.min(1, Math.max(0, 0.5 - (d * c) / px));
  const cover = lod * sharp + (1 - lod) * MARK_COVER[mark]!;
  const e = 0.01;
  const gx = markSd(mark, p[0] + e, p[1]) - markSd(mark, p[0] - e, p[1]);
  const gy = markSd(mark, p[0], p[1] + e) - markSd(mark, p[0], p[1] - e);
  const gl = Math.max(Math.hypot(gx, gy), 1e-6);
  const wall = d < 0 ? MARK_SLOPE * (1 - smoothstep(0, MARK_WALL, -d)) * wallLod : 0;
  const dn: V3 = [0, 0, 0];
  dn[u] = f32((-gx / gl) * wall) + 0; // + 0: no -0 on a flat face
  dn[v] = f32((-gy / gl) * wall) + 0;
  return { shade: 1 - MARK_SHADE * cover, dn };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const f = (x: number) => x.toFixed(6);

/** WGSL: markOf(w1), markSd, engrave (twins of the functions above). */
export const MARKS_WGSL = /* wgsl */ `
struct Carve { shade: f32, dn: vec3f }

fn markOf(w1: u32) -> u32 { return (w1 >> ${MARK_SHIFT}u) & 3u; }

fn shieldSd(p: vec2f, w: f32, top: f32, b: f32) -> f32 {
  let R = (w * w + b * b) / (2.0 * w);
  let ax = abs(p.x);
  let side = select(length(vec2f(ax - (w - R), p.y)) - R, ax - w, p.y > 0.0);
  return max(side, p.y - top);
}

fn segSd(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

fn boxSd(p: vec2f, h: vec2f) -> f32 {
  let d = abs(p) - h;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn markSd(mark: u32, p: vec2f) -> f32 {
  if (mark == ${MARK_HIT}u) {
    let r = length(p);
    let q = abs(p);
    let ring = abs(r - 0.5) - 0.08;
    let dotSd = r - 0.17;
    let tick = min(segSd(q, vec2f(0.0, 0.3), vec2f(0.0, 0.74)), segSd(q, vec2f(0.3, 0.0), vec2f(0.74, 0.0))) - ${f(MARK_STROKE)};
    return min(min(ring, dotSd), tick);
  }
  if (mark == ${MARK_KEEP}u) {
    let q = vec2f(abs(p.x), p.y);
    let band = boxSd(vec2f(p.x, p.y + 0.44), vec2f(0.52, 0.11));
    let line = min(min(segSd(q, vec2f(0.5, -0.33), vec2f(0.56, 0.28)), segSd(q, vec2f(0.56, 0.28), vec2f(0.27, -0.06))), segSd(q, vec2f(0.27, -0.06), vec2f(0.0, 0.36))) - ${f(CROWN_STROKE)};
    let jewel = min(length(q - vec2f(0.58, 0.42)), length(q - vec2f(0.0, 0.52))) - 0.11;
    return min(min(band, line), jewel);
  }
  let s = vec2f(p.x, p.y - 0.05);
  let outline = abs(shieldSd(s, 0.46, 0.52, 0.62)) - ${f(SHIELD_STROKE)};
  let inner = ${f(SHIELD_INNER)} * shieldSd(s / ${f(SHIELD_INNER)}, 0.46, 0.52, 0.62);
  return min(outline, inner);
}

// A carving seen at a grazing angle squashes into smears: it fades out between 0.4 and 0.15 of the cosine
// between the face's world normal faceW and the way to the eye (rel: the point from the eye), as relief would.
fn carveSeen(k: Carve, faceW: vec3f, rel: vec3f) -> Carve {
  let t = smoothstep(${f(MARK_GRAZE[0])}, ${f(MARK_GRAZE[1])}, dot(faceW, -normalize(rel)));
  return Carve(mix(1.0, k.shade, t), k.dn * t);
}

fn engrave(mark: u32, lp: vec3f, faceN: vec3f, half: vec3f, pxM: f32) -> Carve {
  if (mark != ${MARK_HIT}u && mark != ${MARK_SAVE}u && mark != ${MARK_KEEP}u) { return Carve(1.0, vec3f(0.0)); }
  var uv = lp.xy;
  var ext = half.xy;
  var U = vec3f(1.0, 0.0, 0.0);
  var V = vec3f(0.0, 1.0, 0.0);
  if (faceN.x != 0.0) { uv = lp.zy; ext = half.zy; U = vec3f(0.0, 0.0, 1.0); }
  else if (faceN.y != 0.0) { uv = lp.xz; ext = half.xz; V = vec3f(0.0, 0.0, 1.0); }
  let c = min(ext.x, ext.y);
  let n = clamp(round(ext / c), vec2f(1.0), vec2f(${MARK_MAX_CELLS}.0));
  let cell = 2.0 * ext / n;
  let i = clamp(floor((uv + ext) / cell), vec2f(0.0), n - 1.0);
  let p = (uv + ext - cell * (i + 0.5)) / c;
  let d = markSd(mark, p);
  let px = max(${f(MARK_PX)} * pxM, 1e-9);
  let lod = smoothstep(0.5, 1.0, ${f(2 * MARK_STROKE)} * c / px);
  let wallLod = smoothstep(0.75, 2.0, ${f(MARK_WALL)} * c / px);
  let sharp = clamp(0.5 - d * c / px, 0.0, 1.0);
  let mean = select(select(${f(MARK_COVER[MARK_SAVE]!)}, ${f(MARK_COVER[MARK_KEEP]!)}, mark == ${MARK_KEEP}u), ${f(MARK_COVER[MARK_HIT]!)}, mark == ${MARK_HIT}u);
  let cover = lod * sharp + (1.0 - lod) * mean;
  let e = 0.01;
  let g = vec2f(markSd(mark, p + vec2f(e, 0.0)) - markSd(mark, p - vec2f(e, 0.0)), markSd(mark, p + vec2f(0.0, e)) - markSd(mark, p - vec2f(0.0, e)));
  let gn = g / max(length(g), 1e-6);
  let wall = select(0.0, ${f(MARK_SLOPE)} * (1.0 - smoothstep(0.0, ${f(MARK_WALL)}, -d)) * wallLod, d < 0.0);
  return Carve(1.0 - ${f(MARK_SHADE)} * cover, -(gn.x * U + gn.y * V) * wall);
}
`;
