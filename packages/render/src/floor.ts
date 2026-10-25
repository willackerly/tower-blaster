// The visible part of the floor plane, as one small convex polygon.
//
// The floor used to be a 1,200 m quad: two triangles reaching far outside
// the viewport, whose depth some rasterizers get wrong (macOS SwiftShader
// drew one of them over a slab 7 m above it). Cutting the plane with the
// view frustum instead gives at most 6 vertices, all on the frustum's
// faces, so the triangles barely leave the screen and their depth is
// interpolated over the visible range only.
import { transform, type Mat4, type V3 } from './math.ts';

/** How far the floor reaches from the eye, metres (the old quad's half size). */
export const FLOOR_REACH = 600;
/** Frustum widening, in NDC, so float error never opens a gap at the screen edge. */
export const FLOOR_PAD = 1.02;
/** Most vertices of a plane's section of the frustum (a hexahedron has 6 faces), and of its triangle fan. */
export const FLOOR_MAX = 6;
export const FLOOR_VERTS = 3 * (FLOOR_MAX - 2);

/**
 * The section of the plane y = planeY with the view frustum, the frustum
 * padded by FLOOR_PAD in x and y and cut at FLOOR_REACH along its axis (so
 * its far face stays planar). Points in the space invViewProj maps to (the
 * renderer's camera-relative space; eye at the origin), ordered around the
 * polygon; empty when the plane is not in view.
 */
export function floorPolygon(invViewProj: Mat4, planeY: number, eye: V3 = [0, 0, 0], reach = FLOOR_REACH, pad = FLOOR_PAD): V3[] {
  const un = (x: number, y: number, z: number): V3 | null => {
    const p = transform(invViewProj, [x, y, z]);
    return p[3] > 0 && Number.isFinite(p[0] / p[3]) ? [p[0] / p[3], p[1] / p[3], p[2] / p[3]] : null;
  };
  const near: V3[] = [], far: V3[] = [];
  for (const y of [-pad, pad]) for (const x of [-pad, pad]) {
    const n = un(x, y, 0);
    if (!n) return [];
    near.push(n);
    far.push(un(x, y, 1) ?? n);
  }
  // Cut the far face at `reach` along the frustum's axis, keeping it planar.
  const mid = [0, 1, 2].map((k) => far.reduce((s, w) => s + w[k]!, 0) / 4 - eye[k]!);
  const len = Math.hypot(...mid) || 1;
  const axis = mid.map((v) => v / len);
  const depthOf = (w: V3) => (w[0] - eye[0]) * axis[0]! + (w[1] - eye[1]) * axis[1]! + (w[2] - eye[2]) * axis[2]!;
  for (let i = 0; i < 4; i++) {
    const n = near[i]!, w = far[i]!, dn = depthOf(n), dw = depthOf(w);
    if (dw > reach && dw > dn) { const t = (reach - dn) / (dw - dn); far[i] = [n[0] + (w[0] - n[0]) * t, n[1] + (w[1] - n[1]) * t, n[2] + (w[2] - n[2]) * t]; }
  }
  // Corners: bit 0 x, bit 1 y, bit 2 near/far. Edges join corners one bit apart.
  const c = [...near, ...far];
  const pts: V3[] = [];
  const add = (p: V3) => { if (!pts.some((q) => Math.hypot(q[0] - p[0], q[2] - p[2]) < 1e-6 * (1 + Math.hypot(p[0], p[2])))) pts.push(p); };
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) {
    const b = a | bit;
    if (b === a) continue;
    const pa = c[a]!, pb = c[b]!, da = pa[1] - planeY, db = pb[1] - planeY;
    if (da === 0) add([pa[0], planeY, pa[2]]);
    if (db === 0) add([pb[0], planeY, pb[2]]);
    if (da * db < 0) {
      const t = da / (da - db);
      add([pa[0] + (pb[0] - pa[0]) * t, planeY, pa[2] + (pb[2] - pa[2]) * t]);
    }
  }
  if (pts.length < 3) return [];
  // A section of a convex solid is convex: order by angle about the centroid.
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[2], 0) / pts.length;
  return pts.sort((p, q) => Math.atan2(p[2] - cz, p[0] - cx) - Math.atan2(q[2] - cz, q[0] - cx)).slice(0, FLOOR_MAX);
}

/** The polygon as a triangle fan (x, y, z per vertex) for FLOOR_VERTS vertices, and how many to draw. */
export function floorFan(poly: V3[], out = new Float32Array(FLOOR_VERTS * 3)): { data: Float32Array; count: number } {
  let k = 0;
  for (let i = 1; i + 1 < poly.length; i++) for (const p of [poly[0]!, poly[i]!, poly[i + 1]!]) { out.set(p, k); k += 3; }
  return { data: out, count: k / 3 };
}
