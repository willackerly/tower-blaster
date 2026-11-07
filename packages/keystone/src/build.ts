// The build tool's state (C9, docs/game/placement.md): what may be placed (a
// catalogue of pieces and course stamps), what it costs against a level's
// budget, and the edits themselves (place, remove, lay a domino run, undo),
// kept as a LevelDef. Time is stopped while editing: the world is the level as
// it compiles, every body at its authored pose, and Play is compileLevel of
// def(), so the run that starts is exactly the level a saved file would load
// (the level hash says so).
import type { Vec3 } from '@tb/engine-api';
import { type BallPart, compileLevel, type CompiledLevel, type LevelDef, type Part, type PiecePart, pitchOf, type RunPart, unitOf } from './level.ts';
import type { MaterialName } from './materials.ts';
import { axisOf, type Hit, normDeg, type Obb, obbOfBody, obbOverlap, pieceQuat, PlacementIndex, QUAT_ID, type Ray, snapPlace, type SnapOptions, yawQuat } from './placement.ts';
import { DOMINO_HALF, DOMINO_PITCH, type P2, runPoses } from './stroke.ts';

/** One box of a stamp: its centre in the stamp's frame and its half-extents, in h. */
export interface StampBox { at: Vec3; half: Vec3 }

/** Something the build tool places in one click: one piece, or a course stamp of several. */
export interface CatalogItem {
  name: string;
  /** A few words for a button. */
  label: string;
  /** The boxes, in the stamp's frame (centred on its bounding box), h. */
  boxes: StampBox[];
  /** What it costs against a build budget. */
  cost: number;
  /**
   * Rube Lab parts (docs/game/rube-lab.md), single-box items only. `pinned`: bolted to the world (C8); it may
   * dip into the ground and into other pinned bodies, never into a free one. `tilt`: degrees about the item's
   * own +z (PiecePart.tilt), placed with the low end of its top face on the face it goes on (a ramp's foot
   * flush with the ground or a shelf). `ball`: a sphere of this radius (h), placed as its bounding cube.
   */
  pinned?: true;
  tilt?: number;
  ball?: number;
  /** What it is made of when not the level's build material (a stone ball). */
  material?: MaterialName;
}

/** A course stamp: `nx` by `ny` by `nz` cubes on the lattice (horizontal pitch p, courses 1 h), centred. */
function lattice(nx: number, ny: number, nz: number, pitch: number): StampBox[] {
  const out: StampBox[] = [];
  for (let k = 0; k < ny; k++) for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    out.push({ at: [(i - (nx - 1) / 2) * pitch, k - (ny - 1) / 2, (j - (nz - 1) / 2) * pitch], half: [0.5, 0.5, 0.5] });
  }
  return out;
}

/**
 * The catalogue, for a level of horizontal pitch `pitch` (1 + gap): single pieces (a cube, a domino
 * as the brush lays it, a Kapla plank, a slab, a three-cube beam) and course stamps (a course of
 * four, a wall of four by two, a pier three high). A cube costs 1; other pieces cost about their
 * volume in cubes, at least 1; a stamp costs its cubes.
 */
export function catalog(pitch: number): CatalogItem[] {
  const one = (name: string, label: string, half: Vec3, cost: number): CatalogItem => ({ name, label, boxes: [{ at: [0, 0, 0], half }], cost });
  const stamp = (name: string, label: string, n: [number, number, number]): CatalogItem => ({ name, label, boxes: lattice(...n, pitch), cost: n[0] * n[1] * n[2] });
  return [
    one('cube', 'Cube', [0.5, 0.5, 0.5], 1),
    one('domino', 'Domino', [...DOMINO_HALF], 1),
    one('plank', 'Plank', [2.5, 1 / 6, 0.5], 2),
    one('slab', 'Slab', [1.5, 0.125, 1.5], 2),
    one('beam', 'Beam', [1.5, 0.5, 0.5], 3),
    stamp('course4', 'Course of 4', [4, 1, 1]),
    stamp('wall4x2', 'Wall 4 x 2', [4, 2, 1]),
    stamp('pier3', 'Pier of 3', [1, 3, 1]),
    // Rube Lab parts (offered only when a level names them, RUBE_PARTS).
    { name: 'ball', label: 'Ball', boxes: [{ at: [0, 0, 0], half: [BALL_RADIUS, BALL_RADIUS, BALL_RADIUS] }], cost: 1, ball: BALL_RADIUS, material: 'stone' },
    { name: 'ramp', label: 'Ramp (fixed)', boxes: [{ at: [0, 0, 0], half: [...RAMP_HALF] }], cost: 3, pinned: true, tilt: RAMP_TILT },
    { name: 'bumper', label: 'Bumper (fixed)', boxes: [{ at: [0, 0, 0], half: [...BUMPER_HALF] }], cost: 3, pinned: true },
  ];
}
/** Rube Lab's runner and bin ball: radius 0.4 h (a 0.2 m stone ball at the game's h, about a cube's mass). */
export const BALL_RADIUS = 0.4;
/** The bin's ramp: a plank 6 h long, 1 h wide and 1/3 h thick, rising 15 degrees along its length (about 1.6 h). */
export const RAMP_HALF = [3, 1 / 6, 0.5] as const;
export const RAMP_TILT = 15;
/** The bin's bumper: a fixed wall 4 h long, 1 h high and 0.3 h thick, to turn a ball. */
export const BUMPER_HALF = [2, 0.5, 0.15] as const;
export const CATALOG_NAMES = ['cube', 'domino', 'plank', 'slab', 'beam', 'course4', 'wall4x2', 'pier3', 'ball', 'ramp', 'bumper'] as const;
export type CatalogName = (typeof CATALOG_NAMES)[number];
/** The items offered when a level's build block names none (C9's bin): Rube Lab's parts must be named. */
export const DEFAULT_PIECES: readonly CatalogName[] = ['cube', 'domino', 'plank', 'slab', 'beam', 'course4', 'wall4x2', 'pier3'];
/** Rube Lab's own parts. */
export const RUBE_PARTS: readonly CatalogName[] = ['ball', 'ramp', 'bumper'];

/** A level's build rules: how much may be placed and what (LevelDef.build). */
export interface BuildDef {
  /** Most cost the player may place (catalogue costs; a domino of a run costs 1). Absent: no limit. */
  budget?: number;
  /** Catalogue items offered (absent: DEFAULT_PIECES, C9's bin without Rube Lab's parts), and whether the domino brush is (default true). */
  pieces?: CatalogName[];
  brush?: boolean;
  /** What placed pieces are made of (default plaster). */
  material?: MaterialName;
}

/** How the player turns what they hold: a yaw, and which of the item's axes stands up (tip: 0 as built, 1 x up, 2 z up). */
export interface Hold { item: CatalogName; yaw: number; tip: 0 | 1 | 2 }

/** The item's boxes turned by `tip` (swapping the up axis with x or z), still in h. */
export function tipped(item: CatalogItem, tip: 0 | 1 | 2): StampBox[] {
  if (tip === 0) return item.boxes;
  const k = tip === 1 ? 0 : 2;
  const swap = (v: Vec3): Vec3 => { const o: Vec3 = [...v]; [o[1], o[k]] = [v[k]!, v[1]!]; return o; };
  return item.boxes.map((b) => ({ at: swap(b.at), half: swap(b.half) }));
}

/** Half-extents of the bounding box of a stamp's boxes (they are centred on it). */
export function stampHalf(boxes: readonly StampBox[]): Vec3 {
  const e: Vec3 = [0, 0, 0];
  for (const b of boxes) for (let k = 0; k < 3; k++) e[k] = Math.max(e[k]!, Math.abs(b.at[k]!) + b.half[k]!);
  return e;
}

/** What placing would do: each box (metres), whether it may go there and why not. */
export interface Ghost {
  boxes: Obb[];
  /** The pieces the place would add (h), in order. */
  parts: (PiecePart | BallPart)[];
  /** The shape of each box: a ball's box is its bounding cube (drawn as a ball). Absent: all boxes. */
  spheres?: boolean[];
  cost: number;
  ok: boolean;
  /** Empty when ok: overlap (with body indices), ground, budget or item (not offered). */
  why: string;
  clash: number[];
}

/** A domino run as the brush would lay it: every domino's box, and which of them clash (they are left out). */
export interface StrokeGhost { part: RunPart; boxes: Obb[]; clash: boolean[]; cost: number; ok: boolean; why: string }

/** A level body's source: its part, and for a run which domino of it. */
interface BodySource { part: number; domino: number }

/** Interpenetration a placement may have and still count as touching: validateLevel's 1e-4 h. */
export const TOUCH = 1e-4;

/** Rounds to 1e-6 h so a placed piece's numbers stay short in a level file and re-read exactly. */
const q6 = (x: number) => Number(x.toFixed(6)) + 0;

export class BuildSession {
  private parts: Part[];
  private readonly history: Part[][] = [];
  private compiledCache: CompiledLevel | null = null;
  private indexCache: PlacementIndex | null = null;
  private sources: BodySource[] = [];
  readonly items: CatalogItem[];
  readonly h: number;
  readonly pitch: number;

  /**
   * base: the level as authored. author: the viewer's level editing, where any piece or run may be
   * removed and no budget applies; otherwise only what was placed (PiecePart/RunPart.placed) may be
   * taken back, and the level's build block limits what goes in.
   */
  constructor(readonly base: LevelDef, readonly opts: { author?: boolean } = {}) {
    this.parts = [...base.parts];
    this.h = unitOf(base);
    this.pitch = pitchOf(base);
    const offered = new Set<string>(base.build?.pieces ?? DEFAULT_PIECES);
    this.items = catalog(this.pitch).filter((i) => opts.author || offered.has(i.name));
  }

  get build(): BuildDef { return this.base.build ?? {}; }
  get material(): MaterialName { return this.build.material ?? 'plaster'; }
  /** The budget in force, or null for none (author mode, or a level without one). */
  get budget(): number | null { return this.opts.author || this.build.budget === undefined ? null : this.build.budget; }
  get brush(): boolean { return this.opts.author || (this.build.brush ?? true); }

  /** The level with every edit so far. */
  def(): LevelDef { return { ...this.base, parts: [...this.parts] }; }

  compiled(): CompiledLevel {
    if (!this.compiledCache) {
      const c = compileLevel(this.def());
      this.compiledCache = c;
      // Which part (and domino of a run) each body came from, in compile order.
      this.sources = [];
      const counts = new Map<number, number>();
      for (let i = 0; i < c.meta.n; i++) {
        const p = c.meta.part[i]!, part = this.parts[p]!;
        let k = counts.get(p) ?? 0;
        if (part.kind === 'run') { const omit = new Set(part.omit ?? []); while (omit.has(k)) k++; }
        this.sources.push({ part: p, domino: k });
        counts.set(p, k + 1);
      }
    }
    return this.compiledCache;
  }

  /** The stopped world as oriented boxes, indexed by body. */
  world(): PlacementIndex {
    if (!this.indexCache) this.indexCache = PlacementIndex.of(this.compiled().scene.bodies.map(obbOfBody), 2 * this.h);
    return this.indexCache;
  }

  /** What the placed pieces and runs cost so far. */
  spent(): number { return placedCost(this.def()); }
  left(): number | null { return this.budget === null ? null : this.budget - this.spent(); }


  /** The face under a ray: a body of the stopped world or the ground (levels stand on y = 0). */
  pick(r: Ray): Hit | null { return this.world().pick(r, 0); }

  /** The ghost of `hold` placed at the face `hit` (face snap; placement.ts snapPlace). */
  ghost(hit: Hit, hold: Hold, snap: SnapOptions = {}): Ghost {
    const item = this.items.find((i) => i.name === hold.item);
    if (!item) return { boxes: [], parts: [], cost: 0, ok: false, why: `${hold.item} is not offered here`, clash: [] };
    const boxes = tipped(item, hold.tip), h = this.h, tilt = item.tilt ?? 0;
    // A tilted item snaps as the box that bounds it in its own yawed frame, then sinks by t cos(tilt) so the low end
    // of its top face sits on the face hit (a ramp's foot flush with the ground or a shelf, no step to climb).
    const tq = pieceQuat(0, tilt), lone = boxes[0]!;
    const half = (tilt ? [0, 1, 2].map((k) => [0, 1, 2].reduce((a, j) => a + Math.abs(axisOf(tq, j as 0 | 1 | 2)[k]!) * lone.half[j]!, 0)) : stampHalf(boxes)).map((x) => x * h) as Vec3;
    const world = this.world();
    const { box, yaw } = snapPlace(hit, half, hold.yaw, { h, pitch: this.pitch }, world.boxes, snap);
    if (tilt) box.c[1] -= 2 * lone.half[1] * Math.cos((tilt * Math.PI) / 180) * h;
    const q = yawQuat(yaw), X = axisOf(q, 0), Z = axisOf(q, 2);
    const out: Obb[] = [], parts: (PiecePart | BallPart)[] = [];
    const placed = this.opts.author ? {} : { placed: true as const }, material = item.material ?? this.material;
    for (const b of boxes) {
      const o = b.at.map((x) => x * h) as Vec3;
      const c: Vec3 = [box.c[0] + X[0] * o[0] + Z[0] * o[2], box.c[1] + o[1], box.c[2] + X[2] * o[0] + Z[2] * o[2]];
      const at = c.map((x) => q6(x / h)) as Vec3;
      if (item.ball !== undefined) {
        parts.push({ kind: 'ball', at, radius: item.ball, material, ...placed });
        out.push({ c: at.map((x) => x * h) as Vec3, q: QUAT_ID, half: b.half.map((x) => x * h) as Vec3 });
        continue;
      }
      const part: PiecePart = { kind: 'piece', at, half: [...b.half], ...(yaw !== 0 ? { yaw: q6(yaw) } : {}), ...(tilt ? { tilt } : {}), ...(item.pinned ? { pinned: true as const } : {}), material, ...placed };
      parts.push(part);
      // The box as compile will make it (rounded position), so what is checked is what plays.
      out.push({ c: at.map((x) => x * h) as Vec3, q: pieceQuat(part.yaw ?? 0, tilt), half: b.half.map((x) => x * h) as Vec3 });
    }
    const g = this.verdict(out, parts, item.cost, item.pinned === true);
    return item.ball !== undefined ? { ...g, spheres: out.map(() => true) } : g;
  }

  private verdict(boxes: Obb[], parts: (PiecePart | BallPart)[], cost: number, pinned = false): Ghost {
    const world = this.world(), tol = TOUCH * this.h, clash = new Set<number>(), bodies = this.compiled().scene.bodies;
    let ground = false;
    // A stamp's own boxes are lattice-spaced, so only the world is checked. A pinned part may dip into the ground and
    // into other pinned bodies (scenery: contacts between pins do nothing), never into a free body.
    for (const b of boxes) {
      const c = world.clashes(b, tol, 0);
      c.bodies.forEach((x) => { if (!(pinned && bodies[x]?.pinned)) clash.add(x); });
      ground ||= c.ground && !pinned;
    }
    const left = this.left();
    const why = clash.size ? `overlaps ${clash.size} bod${clash.size === 1 ? 'y' : 'ies'}` : ground ? 'goes into the ground' : left !== null && cost > left ? `costs ${cost}, ${left} left` : '';
    return { boxes, parts, cost, ok: why === '', why, clash: [...clash].sort((a, b) => a - b) };
  }

  /** Adds the ghost's pieces when it is ok; returns whether it did. */
  place(g: Ghost): boolean {
    if (!g.ok || !g.parts.length) return false;
    this.edit([...this.parts, ...g.parts]);
    return true;
  }

  /**
   * Takes body `i` out: its piece part, or for a run that domino (added to omit). Only what may be
   * taken back: anything in author mode, else what was placed. Returns whether it did.
   */
  remove(i: number): boolean {
    this.compiled();
    const src = this.sources[i];
    if (!src) return false;
    const part = this.parts[src.part]!;
    if (part.kind !== 'piece' && part.kind !== 'run') return false;
    if (!this.opts.author && !part.placed) return false;
    const next = [...this.parts];
    if (part.kind === 'piece') next.splice(src.part, 1);
    else {
      const omit = [...new Set([...(part.omit ?? []), src.domino])].sort((a, b) => a - b);
      if (omit.length >= runPoses(part.path, part.pitch).length) next.splice(src.part, 1);
      else next[src.part] = { ...part, omit };
    }
    this.edit(next);
    return true;
  }

  /** Whether body i may be taken back (remove would). */
  removable(i: number): boolean {
    this.compiled();
    const src = this.sources[i];
    const part = src ? this.parts[src.part] : undefined;
    return !!part && (part.kind === 'piece' || part.kind === 'run') && (!!this.opts.author || !!part.placed);
  }

  /**
   * A run of dominoes along `path` (x, z in h, as smoothStroke gives it), on the ground: every domino's
   * box, those that clash with the world or the run's earlier dominoes marked (they are left out), and
   * what the rest cost. Not ok when nothing is left, the brush is not offered, or the budget is short.
   */
  stroke(path: readonly P2[], opts: { pitch?: number; half?: Vec3 } = {}): StrokeGhost {
    const h = this.h, pitch = opts.pitch ?? DOMINO_PITCH, half = opts.half ?? [...DOMINO_HALF] as Vec3;
    const part: RunPart = { kind: 'run', path: path.map(([x, z]) => [x, z] as [number, number]), pitch, half: [...half], material: this.material, ...(this.opts.author ? {} : { placed: true as const }) };
    const poses = path.length ? runPoses(part.path, pitch) : [];
    const world = this.world(), tol = TOUCH * h, boxes: Obb[] = [], clash: boolean[] = [];
    const hm = half.map((x) => x * h) as Vec3;
    for (const p of poses) {
      const b: Obb = { c: [p.x * h, hm[1], p.z * h], q: p.rot, half: hm };
      const c = world.clashes(b, tol, 0);
      // Against the run's own dominoes kept so far: a hook too tight for the pitch drops the ones that would cross.
      let bad = c.bodies.length > 0 || c.ground;
      for (let j = boxes.length - 1; j >= 0 && !bad && j >= boxes.length - 8; j--) if (!clash[j] && obbOverlap(b, boxes[j]!) > tol) bad = true;
      boxes.push(b);
      clash.push(bad);
    }
    const omit = clash.flatMap((x, i) => (x ? [i] : []));
    if (omit.length) part.omit = omit;
    const cost = poses.length - omit.length, left = this.left();
    const why = !this.brush ? 'the domino brush is not offered here' : cost === 0 ? 'no domino fits' : left !== null && cost > left ? `costs ${cost}, ${left} left` : '';
    return { part, boxes, clash, cost, ok: why === '', why };
  }

  /** Lays the run when ok; returns whether it did. */
  lay(s: StrokeGhost): boolean {
    if (!s.ok) return false;
    this.edit([...this.parts, s.part]);
    return true;
  }

  /** Undoes the last place, lay or remove; returns whether there was one. */
  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.parts = prev;
    this.invalidate();
    return true;
  }
  get canUndo(): boolean { return this.history.length > 0; }

  /** Removes everything placed (author mode: every piece and run). */
  clear(): boolean {
    const next = this.parts.filter((p) => !((p.kind === 'piece' || p.kind === 'run') && (this.opts.author || p.placed)));
    if (next.length === this.parts.length) return false;
    this.edit(next);
    return true;
  }

  private edit(next: Part[]): void {
    this.history.push(this.parts);
    this.parts = next;
    this.invalidate();
  }
  private invalidate(): void { this.compiledCache = null; this.indexCache = null; }
}

/**
 * What a level's placed parts (PiecePart/RunPart/BallPart.placed) cost against its build budget: a run's dominoes 1
 * each, a ball or piece its catalogue item's cost (a stamp's cubes 1 each; a pinned part its own item's). Pure, so
 * the rules can score a build (Rube Lab's parts par) from the level alone.
 */
export function placedCost(def: LevelDef): number {
  const items = catalog(pitchOf(def));
  let s = 0;
  for (const p of def.parts) {
    if (!('placed' in p) || !p.placed) continue;
    if (p.kind === 'run') s += runPoses(p.path, p.pitch).length - (p.omit?.length ?? 0);
    else if (p.kind === 'ball') s += items.find((i) => i.ball === p.radius)?.cost ?? 1;
    else if (p.kind === 'piece') s += pieceCost(items, p);
  }
  return s;
}

/** A placed piece's cost: its catalogue item's cost over its boxes (each stamp box is a cube, costing 1). */
function pieceCost(items: readonly CatalogItem[], p: PiecePart): number {
  // A pinned part is its catalogue item's (the same half-extents, in any order: tipped), at its own price.
  if (p.pinned) {
    const key = (h: readonly number[]) => [...h].sort((a, b) => a - b).join(',');
    const item = items.find((i) => i.pinned && i.boxes.length === 1 && key(i.boxes[0]!.half) === key(p.half));
    if (item) return item.cost;
  }
  const v = 8 * p.half[0] * p.half[1] * p.half[2];
  const match = items.find((i) => !i.pinned && i.ball === undefined && i.boxes.length === 1 && Math.abs(8 * i.boxes[0]!.half[0] * i.boxes[0]!.half[1] * i.boxes[0]!.half[2] - v) < 1e-9);
  return match?.cost ?? Math.max(1, Math.round(v));
}

/** Turns a hold by `deg` (normalised to (-180, 180]). */
export const turn = (hold: Hold, deg: number): Hold => ({ ...hold, yaw: normDeg(hold.yaw + deg) });
