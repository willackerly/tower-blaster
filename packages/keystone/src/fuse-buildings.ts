// Fuse & Fold buildings (M5, docs/game/fuse-and-fold.md): frame buildings of
// columns under slabs, the structures probe X2 found where the order of the
// cuts decides where a building lands (a solid block of cubes drops in place
// whatever the order). Pure data: a FrameSpec becomes level parts, one cutter
// charge per ground-storey column, and the heritage neighbours around the lot.
//
// Layout (cells, h): columns on an nx x nz grid `span` cells apart, centred on
// the origin, each 1 x colH x 1 (one rod, or colH stacked cubes); a slab
// `slab` cells thick over the whole grid tops every storey. Storey s spans
// [s * (colH + slab), (s + 1) * (colH + slab)).
import type { BodyDesc, Quat, Vec3 } from '@tb/engine-api';
import type { ChargeDef, CompiledLevel, LevelDef, Part } from './level.ts';
import type { MaterialName } from './materials.ts';

export interface FrameSpec {
  /** Columns along x and z (2 to 5). */
  nx: number;
  nz: number;
  /** Cells between column centres (1 to 4). */
  span: number;
  storeys: number;
  /** Column height in cells (1 to 4). */
  colH: number;
  /** Slab thickness in cells (0.25 to 1). */
  slab: number;
  /** One rod body per column per storey, or colH stacked cubes. */
  column: 'rod' | 'cubes';
  material?: MaterialName;
  /** The slab material (default the columns'). */
  slabMaterial?: MaterialName;
}

/** Where a frame's bodies are, in compiled order, as level parts produce them. */
export interface Frame {
  parts: Part[];
  /** Body index of every ground-storey column (its bottom cube for cube columns), x-major then z: col[i][j]. */
  ground: number[][];
  /** Body count of the frame. */
  n: number;
  /** Footprint half extents in cells (to the outer faces) and the top in cells. */
  half: [number, number];
  top: number;
}

/** Column centre in cells along an axis with n columns `span` apart. */
export const colAt = (i: number, n: number, span: number): number => (i - (n - 1) / 2) * span;

/**
 * The frame's parts and its ground-column body indices. Bodies come out in part order: storey by
 * storey, columns x-major then z, then the slab; a cube column's cubes bottom up.
 */
export function frameBuilding(f: FrameSpec, at: [number, number] = [0, 0], pitch = 1.02): Frame {
  const mat = f.material ?? 'plaster', slabMat = f.slabMaterial ?? mat;
  const parts: Part[] = [], ground: number[][] = Array.from({ length: f.nx }, () => []);
  const storeyH = f.colH + f.slab;
  // The slab reaches the outer columns' outer faces: column centres are in pitches, half extents in h.
  const hx = colAt(f.nx - 1, f.nx, f.span) * pitch + 0.5, hz = colAt(f.nz - 1, f.nz, f.span) * pitch + 0.5;
  let n = 0;
  for (let s = 0; s < f.storeys; s++) {
    const y0 = s * storeyH;
    for (let i = 0; i < f.nx; i++) for (let j = 0; j < f.nz; j++) {
      const x = at[0] + colAt(i, f.nx, f.span), z = at[1] + colAt(j, f.nz, f.span);
      if (s === 0) ground[i]!.push(n);
      if (f.column === 'rod') { parts.push({ kind: 'rod', at: [x, y0, z], half: [0.5, f.colH / 2, 0.5], material: mat }); n++; }
      else for (let k = 0; k < f.colH; k++) { parts.push({ kind: 'rod', at: [x, y0 + k, z], half: [0.5, 0.5, 0.5], material: mat }); n++; }
    }
    parts.push({ kind: 'slab', at: [at[0], y0 + f.colH, at[1]], half: [hx, f.slab / 2, hz], material: slabMat });
    n++;
  }
  return { parts, ground, n, half: [hx, hz], top: f.storeys * storeyH };
}

/**
 * A heritage house: `size` (w, h, d) cells with its min corner at `at` (cells), built as h stone courses of one
 * body each (a course is one heritage body, so a terrace of houses stays under the watched-body cap and every
 * course still cracks on its own when hit).
 */
export function heritageHouse(at: Vec3, size: Vec3, material: MaterialName = 'stone', pitch = 1.02): Part[] {
  const [w, h, d] = size;
  // A course spans the cells it covers on the lattice: from the min cell's near face to the max cell's far face.
  const half: Vec3 = [((w - 1) * pitch + 1) / 2, 0.5, ((d - 1) * pitch + 1) / 2];
  return Array.from({ length: h }, (_, k) => ({ kind: 'slab' as const, at: [at[0] + w / 2, at[1] + k, at[2] + d / 2] as Vec3, half, material, role: 'heritage' as const }));
}

/** One cutter per ground column (frame body indices offset by `first`), x-major then z, as LevelDef charges. */
export function groundCutters(fr: Frame, first = 0): ChargeDef[] {
  return fr.ground.flat().map((host) => ({ host: first + host, weapon: 'cutter' }));
}

/** One cutter on every column of each storey in `storeys` (bottom body for cube columns), frame body indices offset by `first`. */
export function storeyCutters(f: FrameSpec, storeys: readonly number[], first = 0): ChargeDef[] {
  const perStorey = f.nx * f.nz * (f.column === 'rod' ? 1 : f.colH) + 1, perCol = f.column === 'rod' ? 1 : f.colH;
  return storeys.flatMap((s) => {
    if (!(Number.isInteger(s) && s >= 0 && s < f.storeys)) throw new RangeError(`storeyCutters: storey ${s} is not 0 to ${f.storeys - 1}`);
    return Array.from({ length: f.nx * f.nz }, (_, k) => ({ host: first + s * perStorey + k * perCol, weapon: 'cutter' }));
  });
}

export type Side = 'W' | 'E' | 'N' | 'S';
/** A heritage house beside the lot: on `side`, `gap` cells clear of the lot's edge, w cells along that edge (centred at `along`), d deep, h high. */
export interface Neighbour { side: Side; gap: number; w: number; d: number; h: number; along?: number; material?: MaterialName }

/**
 * A Fuse & Fold site: the frame at the origin, cutters on the storeys in `cuts`, a lot `margin` cells beyond
 * the frame's footprint on every side plus yards on some sides, and heritage neighbours
 * outside the lot. The objective is fold: collapse at least `min`, at most `spillMax` of the building's mass
 * outside the lot, no heritage broken.
 */
export interface FoldSite {
  frame: FrameSpec;
  cuts: number[];
  margin: number;
  /** Open ground the building may fall into, beyond the margin, each on one side (two make an L-shaped corner lot's rectangle). */
  yards?: Array<{ side: Side; len: number }>;
  /** Relay charges (armed at start, C5's sympathetic charge) on every column of these storeys. */
  relays?: number[];
  neighbours: Neighbour[];
  min: number;
  spillMax: number;
}

/** The lot of a site in cells: [minX, maxX, minZ, maxZ]. */
export function siteLot(site: FoldSite, pitch = 1.02): [number, number, number, number] {
  const fr = frameBuilding(site.frame, [0, 0], pitch);
  // Footprint half extents in cells (the lattice's), outer faces of the outer columns, rounded out to whole cells.
  const hx = Math.ceil(fr.half[0] / pitch - 1e-9), hz = Math.ceil(fr.half[1] / pitch - 1e-9), m = site.margin;
  const lot: [number, number, number, number] = [-hx - m, hx + m, -hz - m, hz + m];
  for (const y of site.yards ?? []) { if (y.side === 'W') lot[0] -= y.len; else if (y.side === 'E') lot[1] += y.len; else if (y.side === 'N') lot[2] -= y.len; else lot[3] += y.len; }
  return lot;
}

/** The parts of a heritage neighbour against a lot (cells). */
export function neighbourParts(n: Neighbour, lot: readonly [number, number, number, number]): Part[] {
  const [x0, x1, z0, z1] = lot, a = n.along ?? 0;
  const at: Vec3 = n.side === 'W' ? [x0 - n.gap - n.d, 0, a - n.w / 2] : n.side === 'E' ? [x1 + n.gap, 0, a - n.w / 2]
    : n.side === 'N' ? [a - n.w / 2, 0, z0 - n.gap - n.d] : [a - n.w / 2, 0, z1 + n.gap];
  const size: Vec3 = n.side === 'W' || n.side === 'E' ? [n.d, n.h, n.w] : [n.w, n.h, n.d];
  return heritageHouse(at, size, n.material);
}

/** A Fuse & Fold level from a site: outcome scoring, a plunger, the cutters, the fold objective. */
export function foldLevel(id: string, name: string, site: FoldSite, extra: Partial<LevelDef> = {}): LevelDef {
  const fr = frameBuilding(site.frame), lot = siteLot(site);
  const parts = [...fr.parts, ...site.neighbours.flatMap((n) => neighbourParts(n, lot))];
  const reach = Math.max(Math.abs(lot[0]), lot[1], Math.abs(lot[2]), lot[3]);
  return {
    id, name, version: 1, world: 6, scoring: 'outcome', parts,
    lot: { min: [lot[0], lot[2]], max: [lot[1], lot[3]] }, crownLine: 1,
    objective: { kind: 'fold', min: site.min, spillMax: site.spillMax }, par: 1, rack: ['plunger'],
    launcher: { radius: reach + 8, y: 2, dropY: Math.ceil(fr.top) + 4 }, charges: [...storeyCutters(site.frame, site.cuts), ...storeyCutters(site.frame, site.relays ?? []).map((ch) => ({ ...ch, weapon: 'relay', arm: 'start' as const }))],
    ...extra,
  };
}

/** mulberry32: one stream per seed, identical everywhere. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Jitter of a nudged build (probe X2's): up to 1 mm across and 0.2 deg of yaw per body. */
export const NUDGE_MM = 1, NUDGE_DEG = 0.2;

/**
 * The level as built by a slightly different hand: every body moved up to NUDGE_MM horizontally and turned up to
 * NUDGE_DEG about +y, from its own seed (nudge 0: the level itself). The order-matters gate judges a line over
 * nudged builds, so a lucky chaotic outcome cannot pass it. Same bodies, metadata and hash; only the scene moves.
 */
export function nudgedLevel(c: CompiledLevel, nudge: number): CompiledLevel {
  if (nudge === 0) return c;
  const r = stream(0x5eed0000 + nudge), sym = () => 2 * r() - 1;
  const bodies = c.scene.bodies.map((b): BodyDesc => {
    const a = (sym() * NUDGE_DEG * Math.PI) / 180, q: Quat = [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
    const [x, y, z, w] = b.rot;
    // q * rot: the yaw applied in the world frame.
    const rot: Quat = [q[3] * x + q[1] * z, q[3] * y + q[1] * w, q[3] * z - q[1] * x, q[3] * w - q[1] * y];
    return { ...b, pos: [b.pos[0] + sym() * NUDGE_MM * 1e-3, b.pos[1], b.pos[2] + sym() * NUDGE_MM * 1e-3], rot };
  });
  return { ...c, scene: { ...c.scene, bodies } };
}
