// What a view shows of a level's bodies, on the CPU: a small ID raster (body + 1 per pixel, 0 = none),
// the same measure as @tb/render's ID pass (Renderer.renderIds) without a GPU, so the opening camera
// (view.ts) can be chosen for what it shows and node tests can check it. Boxes only (a level's structure),
// at their home poses (as loaded, before the pre-settle moves them by a hair).
import type { CompiledLevel } from '@tb/keystone';

/** A screen rectangle in shares of the width and height from the top-left (0..1): e.g. where the HUD sits. */
export interface ScreenRect { left: number; top: number; right: number; bottom: number }

/** An ID raster, and each drawn body's outline area in pixels (what it would cover with nothing in front, not clipped to the screen). */
export interface IdRaster { width: number; height: number; ids: Uint32Array; solo: Float64Array }

type Matrix = ArrayLike<number>;

// The six faces of a box as corner indices (corner k has x = bit 0, y = bit 1, z = bit 2 at +half), each clockwise
// seen from outside with y up: so on the raster (y down) a face toward the eye has positive signed area (tri culls the rest).
const FACES = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]] as const;

/**
 * A depth-tested box rasterizer over one level at one view: draw(i) writes body i's id (i + 1) where it is nearest.
 * Boxes are at their home poses and rotations; a box with a corner behind the eye is skipped (opening views keep
 * every body in front). Faces turned away are culled; the depth test keeps the nearest of the rest.
 */
class BoxRaster {
  readonly ids: Uint32Array;
  readonly depth: Float32Array;
  private readonly sx = new Float64Array(8);
  private readonly sy = new Float64Array(8);
  private readonly sz = new Float64Array(8);
  /** Whether the last projected box is in front of the eye (every corner): only then is it drawn. */
  inFront = false;

  /** buffers false: no ID or depth buffer, for measuring outlines only (draw(i, false)). */
  constructor(private readonly c: CompiledLevel, private readonly m: Matrix, readonly width: number, readonly height: number, buffers = true) {
    this.ids = new Uint32Array(buffers ? width * height : 0);
    this.depth = new Float32Array(buffers ? width * height : 0).fill(Infinity);
  }

  /** Project body i's corners to the raster (sx, sy, sz); inFront says whether all are in front of the eye. */
  project(i: number): void {
    const { c, m, sx, sy, sz, width, height } = this;
    const px = c.meta.home[3 * i]!, py = c.meta.home[3 * i + 1]!, pz = c.meta.home[3 * i + 2]!;
    const hx = c.meta.half[3 * i]!, hy = c.meta.half[3 * i + 1]!, hz = c.meta.half[3 * i + 2]!;
    const q = c.scene.bodies[i]!.rot;
    this.inFront = false;
    for (let k = 0; k < 8; k++) {
      const lx = k & 1 ? hx : -hx, ly = k & 2 ? hy : -hy, lz = k & 4 ? hz : -hz;
      // (lx, ly, lz) rotated by q = (x, y, z, w): v + w t + q x t with t = 2 q x v.
      const tx = 2 * (q[1] * lz - q[2] * ly), ty = 2 * (q[2] * lx - q[0] * lz), tz = 2 * (q[0] * ly - q[1] * lx);
      const x = px + lx + q[3] * tx + (q[1] * tz - q[2] * ty), y = py + ly + q[3] * ty + (q[2] * tx - q[0] * tz), z = pz + lz + q[3] * tz + (q[0] * ty - q[1] * tx);
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (!(w > 1e-6)) return;
      sx[k] = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) * 0.5 * width;
      sy[k] = (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) * 0.5 * height;
      sz[k] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w;
    }
    this.inFront = true;
  }

  /**
   * Draw body i (fill false: only measure it); returns its outline's pixel area (its faces toward the eye tile the
   * outline of a convex box), 0 when not in front of the eye.
   */
  draw(i: number, fill = true): number {
    this.project(i);
    if (!this.inFront) return 0;
    let area = 0;
    for (const f of FACES) area += this.tri(f[0], f[1], f[2], fill ? i + 1 : 0) + this.tri(f[0], f[2], f[3], fill ? i + 1 : 0);
    return area;
  }

  /** Rasterize triangle (a, b, d) if it faces the eye; returns its pixel area (0 when turned away). */
  private tri(a: number, b: number, d: number, id: number): number {
    const { sx, sy, sz, width, height, ids, depth } = this;
    const area = (sx[b]! - sx[a]!) * (sy[d]! - sy[a]!) - (sy[b]! - sy[a]!) * (sx[d]! - sx[a]!);
    if (!(area > 0)) return 0; // turned away (or edge-on)
    if (id === 0) return area / 2; // measuring only
    const ax = sx[a]!, ay = sy[a]!, bx = sx[b]!, by = sy[b]!, dx = sx[d]!, dy = sy[d]!;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, dx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, dx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, dy))), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, dy)));
    const za = sz[a]!, zb = sz[b]!, zd = sz[d]!;
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        // Barycentric weights at the pixel centre.
        const w0 = ((bx - cx) * (dy - cy) - (by - cy) * (dx - cx)) / area;
        const w1 = ((dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * za + w1 * zb + w2 * zd, p = y * width + x;
        if (z < depth[p]!) { depth[p] = z; ids[p] = id; }
      }
    }
    return area / 2;
  }
}

/** True for a pixel (x, y) of a width x height raster whose centre lies inside any of `rects`. */
function coverer(rects: readonly ScreenRect[], width: number, height: number): (x: number, y: number) => boolean {
  const boxes = rects.map((b) => [b.left * width, b.top * height, b.right * width, b.bottom * height] as const);
  return (x, y) => boxes.some(([l, t, r, bt]) => x + 0.5 >= l && x + 0.5 <= r && y + 0.5 >= t && y + 0.5 <= bt);
}

/**
 * Rasterize the level's boxes through viewProj m (column-major, as @tb/render/camera viewProj) at width x height:
 * each pixel holds the nearest body's index + 1, 0 where none. `only` rasterizes those bodies alone.
 */
export function idRaster(c: CompiledLevel, m: Matrix, width: number, height: number, only?: Iterable<number>): IdRaster {
  const r = new BoxRaster(c, m, width, height), solo = new Float64Array(c.meta.n);
  if (only) for (const i of only) solo[i] = r.draw(i);
  else for (let i = 0; i < c.meta.n; i++) solo[i] = r.draw(i);
  return { width, height, ids: r.ids, solo };
}

/** Every body's outline area in pixels at this view (IdRaster.solo without drawing): for an ID pass made elsewhere (the GPU's). */
export function outlineAreas(c: CompiledLevel, m: Matrix, width: number, height: number): Float64Array {
  const r = new BoxRaster(c, m, width, height, false), out = new Float64Array(c.meta.n);
  for (let i = 0; i < c.meta.n; i++) out[i] = r.draw(i, false);
  return out;
}

/** Pixels per body (index = body) in an ID raster, leaving out pixels inside any of `covered` (the HUD's panels). */
export function pixelCounts(r: IdRaster, n: number, covered: readonly ScreenRect[] = []): Uint32Array {
  const out = new Uint32Array(n), hid = coverer(covered, r.width, r.height);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const id = r.ids[y * r.width + x]!;
    if (id === 0 || id > n || hid(x, y)) continue;
    out[id - 1]!++;
  }
  return out;
}

/** A body is in sight when at least this share of its unoccluded pixels show (and at least SEEN_MIN_PX). */
export const SEEN_SHARE = 0.25;
/** ... and at least this many pixels at the raster's size. */
export const SEEN_MIN_PX = 2;

/** Whether a body showing `px` of its `solo` pixels is in sight (at least `share` of it: SEEN_SHARE unless asked stricter). */
export const seen = (px: number, solo: number, share = SEEN_SHARE): boolean => px >= SEEN_MIN_PX && px >= share * solo;
