// Find the cubes of a scene that are already on a lattice and store them
// there. Used for harness scenarios; levels will declare lattices directly.
import { type BodyDesc, type SceneDesc } from '@tb/engine-api';
import { Lattice } from './lattice.ts';
import { detach, type SupportModel } from './support.ts';
import { nearestCubeRotation } from './symmetry.ts';

export interface BuildOptions {
  /** Position tolerance, as a fraction of the edge. */
  posTol: number;
  /** Rotation tolerance from a cube symmetry, radians. */
  rotTol: number;
  /** Largest speed (m/s, and rad/s times half-edge) that counts as at rest. */
  restSpeed: number;
  /** Spare height above the tallest column, in cells, for cubes that settle back. */
  headroom: number;
  /** Spare cells around the XZ bounds. */
  margin: number;
}

export const DEFAULT_BUILD: BuildOptions = { posTol: 1e-6, rotTol: 1e-6, restSpeed: 1e-9, headroom: 4, margin: 2 };

export interface BuiltLattices {
  /** One lattice per group of cubes sharing a grid (typically one per tower block or city). */
  lattices: Lattice[];
  /** Index into `lattices` per scene body, or -1 for bodies that start active. */
  latticeOf: Int32Array;
  /** Flat cell index per scene body within its lattice, or -1. */
  cellOf: Int32Array;
}

/** Cube half-edge if the body is a cube at rest, else null. */
function restingCubeHalf(b: BodyDesc, o: BuildOptions): number | null {
  if (b.shape.kind !== 'box') return null;
  const [hx, hy, hz] = b.shape.half;
  if (Math.abs(hx - hy) > 1e-12 * hx || Math.abs(hx - hz) > 1e-12 * hx) return null;
  const v = Math.hypot(...b.linVel), w = Math.hypot(...b.angVel) * hx;
  if (v > o.restSpeed || w > o.restSpeed) return null;
  if (nearestCubeRotation(b.rot).angle > o.rotTol) return null;
  return hx;
}

/**
 * Put every cube of the scene that sits on a lattice resting on the ground
 * into a Lattice, then drop cells the support model rejects (they start
 * active and fall). Cubes are grouped by size and by grid offset modulo the
 * edge, and each group gets its own lattice, so towers that are not on a
 * common grid (streets of 6.5, say) still go dormant. Gapped towers (pitch
 * above the edge) currently become one lattice per column; a lattice with a
 * pitch would be the follow-up if that shows up in levels.
 */
export function latticesFromScene(scene: SceneDesc, support: SupportModel, opts: Partial<BuildOptions> = {}): BuiltLattices {
  const o = { ...DEFAULT_BUILD, ...opts };
  const n = scene.bodies.length;
  const out: BuiltLattices = { lattices: [], latticeOf: new Int32Array(n).fill(-1), cellOf: new Int32Array(n).fill(-1) };
  if (!scene.ground) return out;
  const groundY = scene.ground.y;
  interface Group { half: number; ox: number; oz: number; members: number[] }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const onGrid = (x: number, origin: number, edge: number) => {
    const t = (x - origin) / edge;
    return Math.abs(t - Math.round(t)) <= o.posTol;
  };
  scene.bodies.forEach((b, id) => {
    const h = restingCubeHalf(b, o);
    if (h === null) return;
    const e = 2 * h;
    if (!onGrid(b.pos[1], groundY + h, e) || b.pos[1] < groundY + h - o.posTol * e) return;
    // Bucket by the offset rounded well above the tolerance; check the neighbours of a bucket too.
    const fx = ((b.pos[0] % e) + e) % e, fz = ((b.pos[2] % e) + e) % e;
    const q = 1e-4 * e, bx = Math.round(fx / q), bz = Math.round(fz / q), nb = Math.round(e / q);
    let g: Group | undefined;
    for (const dx of [0, -1, 1, nb, -nb]) {
      for (const dz of [0, -1, 1, nb, -nb]) {
        const c = byKey.get(`${h},${bx + dx},${bz + dz}`);
        if (c && onGrid(b.pos[0], c.ox, e) && onGrid(b.pos[2], c.oz, e)) { g = c; break; }
      }
      if (g) break;
    }
    if (!g) {
      groups.push(g = { half: h, ox: b.pos[0], oz: b.pos[2], members: [] });
      byKey.set(`${h},${bx},${bz}`, g);
    }
    g.members.push(id);
  });
  for (const g of groups) {
    const e = 2 * g.half;
    const idx = (x: number, origin: number) => Math.round((x - origin) / e);
    let minI = Infinity, maxI = -Infinity, minK = Infinity, maxK = -Infinity, maxJ = 0;
    for (const id of g.members) {
      const p = scene.bodies[id]!.pos;
      const i = idx(p[0], g.ox), j = idx(p[1], groundY + g.half), k = idx(p[2], g.oz);
      minI = Math.min(minI, i); maxI = Math.max(maxI, i);
      minK = Math.min(minK, k); maxK = Math.max(maxK, k);
      maxJ = Math.max(maxJ, j);
    }
    const m = o.margin;
    const lattice = new Lattice(
      { origin: [g.ox + (minI - m) * e, groundY + g.half, g.oz + (minK - m) * e], edge: e },
      { nx: maxI - minI + 1 + 2 * m, ny: maxJ + 1 + o.headroom, nz: maxK - minK + 1 + 2 * m },
    );
    const li = out.lattices.length;
    for (const id of g.members) {
      const b = scene.bodies[id]!;
      const [i, j, k] = lattice.nearest(b.pos);
      if (lattice.has(i, j, k)) continue; // two cubes on one cell overlap; the second stays active
      lattice.insert(i, j, k, id, nearestCubeRotation(b.rot).index);
      out.cellOf[id] = lattice.cell(i, j, k);
      out.latticeOf[id] = li;
    }
    const bad = support.violations(lattice).map((c) => lattice.coords(c));
    for (const d of detach(lattice, support, bad)) { out.cellOf[d.id] = -1; out.latticeOf[d.id] = -1; }
    if (lattice.count) out.lattices.push(lattice);
  }
  return out;
}
