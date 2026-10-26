// Fitting the one shadow map to what the camera can see (design step 12).
//
// The light's view is fixed by the arena and the sun, so only the ortho
// window moves. Each frame:
//   1. Window: the light-space box of (camera frustum) ∩ (arena). The
//      frustum (far plane pulled in to the far side of the arena) is
//      clipped exactly against the arena box, a convex polytope whose
//      vertices are found by edge-plane intersection; the light-space AABB
//      of those vertices is then clipped by that of the arena sphere.
//      Every step is a superset, so the window holds every visible
//      receiver in the arena. No GPU readback.
//      (Intersecting AABBs instead of clipping is far looser whenever the
//      camera looks down: the frustum's far part, below the arena, is
//      wide. Fitting to the depth buffer (SDSM) is tighter still, but needs
//      a readback or a GPU-written matrix; revisit if shadows look soft.)
//   2. Size: a ladder of half sizes rMin·√2^k. Grow at once when the
//      window outgrows the level; shrink only when the window fits the
//      level below with 15% to spare, so a wobbling camera never flips
//      levels back and forth.
//   3. Centre: snapped to whole texels of the chosen level, so as the
//      camera moves the map content shifts by whole texels and shadow
//      edges do not swim.
// Depth always spans the arena along the light, so every caster counts.
// Receivers are the arena plus the floor its shadows reach under a low sun.
import { lookAt, multiply, ortho, transform, type Mat4, type V3 } from './math.ts';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface ShadowFitState { level: number }

export interface ShadowFit {
  /** Light view-projection (world space). */
  matrix: Mat4;
  level: number;
  /** Half size of the window, metres. */
  half: number;
  /** Texel size, metres. */
  texel: number;
  /** Light depth range (far - near), metres: converts metric bias to depth units. */
  depthRange: number;
  /** Window centre in light view space (x, y). */
  center: [number, number];
}

/** Where shadows can be: the intersection of a box and a sphere around the same centre. */
export interface Arena {
  center: V3;
  half: V3;
  /** Default: the box's circumradius (the box alone). */
  radius?: number;
}

export const SHADOW_LADDER_MIN = 4;
/** Farthest a shadow is followed past the arena along the floor, metres (a sun within ~0.5 degrees of the horizon). */
export const SHADOW_REACH_MAX = 2000;
const SHRINK_MARGIN = 1.15;

/** The light's view matrix for an arena: looks along -sun at its centre, from outside it. */
export function lightView(arena: Arena, sun: V3): Mat4 {
  const c = arena.center, d = 2 * Math.hypot(...arena.half) + 1;
  const eye: V3 = [c[0] + sun[0] * d, c[1] + sun[1] * d, c[2] + sun[2] * d];
  return lookAt(eye, c, Math.abs(sun[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
}

/** Light-space AABB of the arena: its box's AABB clipped by its sphere's. */
function arenaBox(view: Mat4, arena: Arena) {
  const { center: c, half: h } = arena;
  const pts: V3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push([c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
  const box = lightBox(view, pts);
  const r = arena.radius ?? Math.hypot(...h), q = transform(view, c);
  for (let k = 0; k < 3; k++) { box.lo[k] = Math.max(box.lo[k]!, q[k]! - r); box.hi[k] = Math.min(box.hi[k]!, q[k]! + r); }
  return box;
}

/**
 * World-space corners of a view-projection's frustum (depth 0..1). Given an
 * eye and maxDist, the far plane is pulled in to depth maxDist along the
 * view axis, which keeps every point within maxDist of the eye inside.
 * (Pulling each far corner to distance maxDist along its own ray would not:
 * corner rays are longer than the axis, so that plane sits nearer.)
 */
export function frustumCorners(invViewProj: Mat4, eye?: V3, maxDist?: number): V3[] {
  const out: V3[] = [];
  for (const z of [0, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) {
    const p = transform(invViewProj, [x, y, z]);
    out.push([p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
  }
  if (eye && maxDist !== undefined) {
    const far = out.slice(4);
    const mid = [0, 1, 2].map((k) => far.reduce((s, w) => s + w[k]!, 0) / 4 - eye[k]!);
    const len = Math.hypot(...mid);
    const axis = mid.map((v) => v / len);
    for (let i = 4; i < 8; i++) {
      const w = out[i]!, depth = (w[0] - eye[0]) * axis[0]! + (w[1] - eye[1]) * axis[1]! + (w[2] - eye[2]) * axis[2]!;
      if (depth > maxDist) out[i] = w.map((v, k) => eye[k]! + ((v - eye[k]!) * maxDist) / depth) as V3;
    }
  }
  return out;
}

function lightBox(view: Mat4, pts: V3[]) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    const q = transform(view, p);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, q[k]!); hi[k] = Math.max(hi[k]!, q[k]!); }
  }
  return { lo, hi };
}

/** The 12 edges of a hexahedron whose corners are indexed x + 2y + 4z (frustumCorners order, box corners). */
const EDGES: [number, number][] = [];
for (let i = 0; i < 8; i++) for (const b of [1, 2, 4]) if (!(i & b)) EDGES.push([i, i | b]);

/** Inward planes (n, d), dot(n, p) + d >= 0 inside, of a convex hexahedron in that order. */
function hexPlanes(c: V3[]): [V3, number][] {
  const mid = [0, 1, 2].map((k) => c.reduce((s, p) => s + p[k]!, 0) / 8) as V3;
  const out: [V3, number][] = [];
  for (const b of [1, 2, 4]) for (const side of [0, b]) {
    const f = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => (i & b) === side).map((i) => c[i]!);
    // The face's corners are not all coplanar in floating point; any 3 that span it will do: take the widest normal.
    let n: V3 = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const u = sub(f[(i + 1) % 4]!, f[i]!), v = sub(f[(i + 2) % 4]!, f[i]!);
      const m = cross(u, v);
      if (Math.hypot(...m) > Math.hypot(...n)) n = m;
    }
    const l = Math.hypot(...n) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    let d = -dot(n, f[0]!);
    if (dot(n, mid) + d < 0) { n = [-n[0], -n[1], -n[2]]; d = -d; }
    out.push([n, d]);
  }
  return out;
}

/** Vertices of (convex hexahedron) ∩ (axis-aligned box): their hull is the intersection. */
export function clipToBox(corners: V3[], center: V3, half: V3): V3[] {
  const eps = 1e-6 * (1 + Math.hypot(...half));
  const box: V3[] = [];
  for (let i = 0; i < 8; i++) box.push([0, 1, 2].map((k) => center[k]! + ((i >> k) & 1 ? 1 : -1) * half[k]!) as V3);
  const boxPlanes: [V3, number][] = [];
  for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
    const n: V3 = [0, 0, 0];
    n[k] = -s;
    boxPlanes.push([n, s * center[k]! + half[k]!]);
  }
  const hex = hexPlanes(corners);
  const inside = (planes: [V3, number][], p: V3) => planes.every(([n, d]) => dot(n, p) + d >= -eps);
  const out: V3[] = [];
  for (const p of corners) if (inside(boxPlanes, p)) out.push(p);
  for (const p of box) if (inside(hex, p)) out.push(p);
  const cut = (pts: V3[], planes: [V3, number][], keep: [V3, number][]) => {
    for (const [i, j] of EDGES) for (const [n, d] of planes) {
      const a = pts[i]!, b = pts[j]!, da = dot(n, a) + d, db = dot(n, b) + d;
      if ((da < 0) === (db < 0)) continue;
      const t = da / (da - db);
      const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (inside(keep, p)) out.push(p);
    }
  };
  cut(corners, boxPlanes, boxPlanes);
  cut(box, hex, hex);
  return out;
}

/**
 * Fit the shadow window. corners: the camera frustum (frustumCorners).
 * state carries the ladder level between frames (start with level -1).
 * floorY: nothing below it is visible (the ground plane).
 */
export function fitShadow(arena: Arena, sun: V3, corners: V3[], size: number, state: ShadowFitState, floorY = -Infinity): ShadowFit {
  const view = lightView(arena, sun);
  // Receivers: the arena above the (opaque) floor. Casters: the whole arena.
  const { center: c, half: h } = arena;
  const bottom = Math.min(Math.max(c[1] - h[1], floorY - 0.05), c[1] + h[1]);
  const top = c[1] + h[1];
  // A low sun throws the arena's shadows past it along the floor, away from the sun, as far as its top
  // casts: those floor points are receivers too (their light-space x, y lie inside the arena's, so the
  // window below stays within the arena's light-space box).
  const horiz = Math.hypot(sun[0], sun[2]);
  const reach = sun[1] > 0 && horiz > 1e-6 ? Math.min(((top - bottom) * horiz) / sun[1], SHADOW_REACH_MAX) : 0;
  const sx = (-sun[0] / (horiz || 1)) * reach, sz = (-sun[2] / (horiz || 1)) * reach;
  const rc: V3 = [c[0] + sx / 2, (bottom + top) / 2, c[2] + sz / 2], rh: V3 = [h[0] + Math.abs(sx) / 2, (top - bottom) / 2, h[2] + Math.abs(sz) / 2];
  const a = arenaBox(view, arena), seen = clipToBox(corners, rc, rh);
  const f = lightBox(view, seen);
  let lo = [Math.max(a.lo[0]!, f.lo[0]!), Math.max(a.lo[1]!, f.lo[1]!)], hi = [Math.min(a.hi[0]!, f.hi[0]!), Math.min(a.hi[1]!, f.hi[1]!)];
  if (!seen.length || !(lo[0]! < hi[0]! && lo[1]! < hi[1]!)) { lo = [a.lo[0]!, a.lo[1]!]; hi = [a.hi[0]!, a.hi[1]!]; } // nothing of the arena in view: fit it all
  const need = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!) / 2;
  const levelFor = (h: number) => Math.max(0, Math.ceil(Math.log2(h / SHADOW_LADDER_MIN) * 2 - 1e-9));
  const halfAt = (k: number) => SHADOW_LADDER_MIN * Math.SQRT2 ** k;
  let level = state.level;
  if (level < 0 || halfAt(level) < need) level = levelFor(need);
  else while (level > 0 && halfAt(level - 1) >= need * SHRINK_MARGIN) level--;
  state.level = level;
  // Snapping needs the window to keep its texel grid when the centre moves:
  // the grid is aligned to the light view's origin, so snap the centre to it.
  const half = halfAt(level), texel = (2 * half) / size;
  const center: [number, number] = [Math.round((lo[0]! + hi[0]!) / 2 / texel) * texel, Math.round((lo[1]! + hi[1]!) / 2 / texel) * texel];
  // Light view looks down -z: depths are -z. Span the arena with a 1 m margin, and as deep as the floor its shadows reach.
  const reachLo = reach > 0 ? lightBox(view, [0, 1, 2, 3].map((i) => [rc[0] + (i & 1 ? 1 : -1) * rh[0], bottom, rc[2] + (i & 2 ? 1 : -1) * rh[2]] as V3)).lo[2]! : Infinity;
  const near = -a.hi[2]! - 1, far = -Math.min(a.lo[2]!, reachLo) + 1;
  const proj = ortho(center[0] - half, center[0] + half, center[1] - half, center[1] + half, near, far);
  return { matrix: multiply(proj, view), level, half, texel, depthRange: far - near, center };
}

/** Farthest blocker the soft shadow search looks for, metres along the light (a 30 m tower under a 50 degree sun). */
export const PCSS_REACH = 40;
/** Widest blocker search and penumbra radius, texels: past it, more taps would only spread thinner. */
export const PCSS_MAX_TEXELS = 24;
/** Steepest receiver plane the soft shadow taps follow, metres of light depth per metre (tan 85 degrees). */
const PCSS_MAX_SLOPE = 11.4;

/**
 * The scene shader's shadowSoft uniform (shaders.ts shadowSoft()) for a
 * penumbra half angle with tangent tanHalf (the sun's radius times the
 * look's softness): [tanHalf, search radius in texels, light depth range in
 * metres, steepest receiver plane in depth per uv]. Where even a blocker
 * PCSS_REACH away casts a penumbra under 1.5 texels, tanHalf is 0 and the
 * shader takes the 3x3 taps without searching.
 */
export function pcssParams(tanHalf: number, fit: ShadowFit): [number, number, number, number] {
  const search = (PCSS_REACH * tanHalf) / fit.texel;
  return [search < 1.5 ? 0 : tanHalf, Math.min(search, PCSS_MAX_TEXELS), fit.depthRange, (PCSS_MAX_SLOPE * 2 * fit.half) / fit.depthRange];
}
