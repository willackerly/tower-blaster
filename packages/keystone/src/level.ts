// Level definitions: authored data in cube units, compiled to an engine
// SceneDesc plus per-body metadata the rules need (role, material, mass,
// home pose). Compilation is pure and the body order is stable, so a level
// hash pins the exact scene a recorded solution was made against.
import { type BodyDesc, massOf, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { DEFAULT_GAP, DEFAULT_UNIT, encodeTag, GRAVITY, MATERIALS, materialId, type MaterialName, type Role, ROLES } from './materials.ts';
import { AMMO, type AmmoKind, type LauncherDef, type Shot, type ShotFrame, speedOf } from './shots.ts';

/** A course (layer) override inside a block: change material or role, or leave cells out. */
export interface CourseOverride {
  /** Course index within the block, 0 = bottom. */
  k: number;
  material?: MaterialName;
  role?: Role;
  /** (i, j) cells within the course this applies to; default all. */
  cells?: [number, number][];
  omit?: boolean;
}

/** A box of unit cubes; `at` is the min corner in cells, `size` the count along x, y, z. */
export interface BlockPart { kind: 'block'; at: Vec3; size: Vec3; material: MaterialName; role?: Role; courses?: CourseOverride[] }
/** One box body; `at` is (centre x, bottom y, centre z) and `half` its half-extents, in h. */
export interface BoxPart { kind: 'slab' | 'rod'; at: Vec3; half: Vec3; material: MaterialName; role?: Role }
export type Part = BlockPart | BoxPart;

export type Objective = { kind: 'crowns' } | { kind: 'skyline'; maxH: number; footprintMax?: number };

export interface LevelDef {
  id: string;
  name: string;
  version: number;
  world: number;
  /** Metres per h (default 0.5). */
  unit?: number;
  /** Horizontal gap between lattice cells as a fraction of h (default 0.02). */
  gap?: number;
  parts: Part[];
  /** Lot rectangle in horizontal cell coordinates: [x, z] corners. */
  lot: { min: [number, number]; max: [number, number] };
  /** Height in h below which a crown counts as down. */
  crownLine: number;
  objective: Objective;
  par: number;
  rack: AmmoKind[];
  launcher: LauncherDef;
  /** Leverage for the third star, set from bot runs; DEFAULT_GOLD when absent. */
  lGold?: number;
  /** Recorded solutions, replayed by tests. */
  solutions?: { par?: Shot[]; ace?: Shot[] };
}

export const ROLE_ID: Record<Role, number> = { plain: 0, crown: 1, heritage: 2 };
export const MAX_BODIES = 2500;
export const MAX_RACK = 6;

/** Per structure body, index-aligned with scene.bodies. Ammo is appended after these at runtime. */
export interface BodyMeta {
  n: number;
  role: Uint8Array;
  material: Uint8Array;
  mass: Float64Array;
  /** World AABB half-extents at rest (3 per body). */
  half: Float64Array;
  home: Float64Array;
  /** Height band 0..7 of the home position over the structure's height. */
  band: Uint8Array;
  part: Uint16Array;
  crowns: Int32Array;
  heritage: Int32Array;
}

export interface CompiledLevel {
  def: LevelDef;
  scene: SceneDesc;
  meta: BodyMeta;
  frame: ShotFrame;
  /** World-space lot rectangle in metres. */
  lot: { min: [number, number]; max: [number, number] };
  /** Structure height in metres (top of the highest body). */
  height: number;
  hash: string;
}

export const unitOf = (d: LevelDef) => d.unit ?? DEFAULT_UNIT;
export const pitchOf = (d: LevelDef) => 1 + (d.gap ?? DEFAULT_GAP);

function body(pos: Vec3, half: Vec3, material: MaterialName, role: Role, part: number): BodyDesc {
  const m = MATERIALS[materialId(material)]!;
  return { shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: m.density, friction: m.friction, restitution: m.restitution, tag: encodeTag(role, part) };
}

/** FNV-1a over a string, twice with different offsets: 64 bits as hex. */
export function hashString(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function compileLevel(def: LevelDef): CompiledLevel {
  const h = unitOf(def), p = pitchOf(def) * h;
  const bodies: BodyDesc[] = [];
  const roles: number[] = [], mats: number[] = [], parts: number[] = [];
  const add = (b: BodyDesc, role: Role, material: MaterialName, part: number) => { bodies.push(b); roles.push(ROLE_ID[role]); mats.push(materialId(material)); parts.push(part); };

  def.parts.forEach((part, pi) => {
    if (part.kind === 'block') {
      const [nx, ny, nz] = part.size;
      for (let k = 0; k < ny; k++) for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        let material = part.material, role: Role = part.role ?? 'plain', omit = false;
        for (const o of part.courses ?? []) {
          if (o.k !== k || (o.cells && !o.cells.some(([a, b]) => a === i && b === j))) continue;
          material = o.material ?? material; role = o.role ?? role; omit = o.omit ?? omit;
        }
        if (omit) continue;
        const pos: Vec3 = [(part.at[0] + i + 0.5) * p, (part.at[1] + k + 0.5) * h, (part.at[2] + j + 0.5) * p];
        add(body(pos, [h / 2, h / 2, h / 2], material, role, pi), role, material, pi);
      }
    } else {
      const half = part.half.map((x) => x * h) as Vec3;
      const pos: Vec3 = [part.at[0] * p, part.at[1] * h + half[1], part.at[2] * p];
      const role = part.role ?? 'plain';
      add(body(pos, half, part.material, role, pi), role, part.material, pi);
    }
  });

  const n = bodies.length;
  const meta: BodyMeta = {
    n, role: Uint8Array.from(roles), material: Uint8Array.from(mats), mass: Float64Array.from(bodies, massOf),
    half: new Float64Array(3 * n), home: new Float64Array(3 * n), band: new Uint8Array(n), part: Uint16Array.from(parts),
    crowns: Int32Array.from(roles.flatMap((r, i) => (r === ROLE_ID.crown ? [i] : []))),
    heritage: Int32Array.from(roles.flatMap((r, i) => (r === ROLE_ID.heritage ? [i] : []))),
  };
  let height = 0;
  bodies.forEach((b, i) => {
    const half = (b.shape as { half: Vec3 }).half;
    meta.half.set(half, 3 * i);
    meta.home.set(b.pos, 3 * i);
    height = Math.max(height, b.pos[1] + half[1]);
  });
  for (let i = 0; i < n; i++) meta.band[i] = Math.min(7, Math.floor((8 * meta.home[3 * i + 1]!) / Math.max(height, 1e-9)));

  const scene: SceneDesc = {
    id: `keystone:${def.id}`, params: { version: def.version }, seed: 0, gravity: [0, -GRAVITY, 0], dt: 1 / 60,
    ground: { y: 0, friction: MATERIALS[0].friction }, sleep: true, bodies, inputs: [],
  };
  const lot = { min: [def.lot.min[0] * p, def.lot.min[1] * p] as [number, number], max: [def.lot.max[0] * p, def.lot.max[1] * p] as [number, number] };
  const frame: ShotFrame = { unit: h, pitch: pitchOf(def), centre: [(lot.min[0] + lot.max[0]) / 2, (lot.min[1] + lot.max[1]) / 2], launcher: def.launcher };
  const { solutions: _omit, ...geometry } = def; // solutions don't change the scene
  return { def, scene, meta, frame, lot, height, hash: hashString(JSON.stringify(geometry)) };
}

export interface Issue { code: 'count' | 'overlap' | 'unsupported' | 'mass-ratio' | 'tunnelling' | 'crown-start' | 'rack' | 'empty'; message: string; bodies?: number[] }

const aabb = (m: BodyMeta, i: number) => {
  const c = [m.home[3 * i]!, m.home[3 * i + 1]!, m.home[3 * i + 2]!], e = [m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!];
  return { lo: c.map((x, k) => x - e[k]!), hi: c.map((x, k) => x + e[k]!) };
};

/** Pairs whose AABBs, grown by `margin` on every side, overlap. Sweep on x. */
function nearPairs(m: BodyMeta, margin: number): Array<[number, number]> {
  const boxes = Array.from({ length: m.n }, (_, i) => aabb(m, i));
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.lo[0]! - boxes[b]!.lo[0]!);
  const out: Array<[number, number]> = [];
  for (let s = 0; s < order.length; s++) {
    const i = order[s]!, A = boxes[i]!;
    for (let t = s + 1; t < order.length; t++) {
      const j = order[t]!, B = boxes[j]!;
      if (B.lo[0]! > A.hi[0]! + 2 * margin) break;
      if ([0, 1, 2].every((k) => A.lo[k]! - margin < B.hi[k]! + margin && B.lo[k]! - margin < A.hi[k]! + margin)) out.push(i < j ? [i, j] : [j, i]);
    }
  }
  return out;
}

/**
 * Static checks that keep levels solvable and the solver honest. The physical
 * check (the level sits still on a real engine) lives in the sim package.
 */
export function validateLevel(c: CompiledLevel): Issue[] {
  const { def, meta: m } = c, h = c.frame.unit, issues: Issue[] = [];
  if (m.n === 0) issues.push({ code: 'empty', message: 'level has no bodies' });
  if (m.n > MAX_BODIES) issues.push({ code: 'count', message: `${m.n} bodies > ${MAX_BODIES} (Rapier prototype budget)` });
  if (def.rack.length === 0 || def.rack.length > MAX_RACK || def.par < 1 || def.par > def.rack.length) issues.push({ code: 'rack', message: `rack of ${def.rack.length} with par ${def.par}: need 1 <= par <= rack <= ${MAX_RACK}` });

  const eps = 1e-4 * h;
  const box = (i: number) => aabb(m, i);
  for (const [i, j] of nearPairs(m, 0.1 * h)) {
    const A = box(i), B = box(j);
    const depth = Math.min(...[0, 1, 2].map((k) => Math.min(A.hi[k]!, B.hi[k]!) - Math.max(A.lo[k]!, B.lo[k]!)));
    if (depth > eps) issues.push({ code: 'overlap', message: `bodies ${i} and ${j} overlap by ${(depth / h).toFixed(3)} h`, bodies: [i, j] });
    const ratio = Math.max(m.mass[i]! / m.mass[j]!, m.mass[j]! / m.mass[i]!);
    if (ratio > 10) issues.push({ code: 'mass-ratio', message: `bodies ${i} and ${j} touch with mass ratio ${ratio.toFixed(1)} > 10`, bodies: [i, j] });
  }

  // Loose support: a body off the ground must rest on bodies whose tops meet
  // its bottom, with its centre over the bounding box of those contacts.
  const boxes = Array.from({ length: m.n }, (_, i) => box(i));
  // above[j] = bodies resting directly on j; below[j] = what j rests on.
  const above: number[][] = Array.from({ length: m.n }, () => []);
  const below: number[][] = Array.from({ length: m.n }, () => []);
  for (const [i, j] of nearPairs(m, 0.01 * h)) {
    const A = boxes[i]!, B = boxes[j]!;
    const ox = Math.min(A.hi[0]!, B.hi[0]!) - Math.max(A.lo[0]!, B.lo[0]!), oz = Math.min(A.hi[2]!, B.hi[2]!) - Math.max(A.lo[2]!, B.lo[2]!);
    if (ox <= eps || oz <= eps) continue;
    if (Math.abs(A.hi[1]! - B.lo[1]!) <= eps) { above[i]!.push(j); below[j]!.push(i); }
    else if (Math.abs(B.hi[1]! - A.lo[1]!) <= eps) { above[j]!.push(i); below[i]!.push(j); }
  }
  // The body plus everything that rests only on it (transitively). Shared
  // loads such as a lintel on two columns are left out: splitting them needs
  // statics, and the at-rest run on a real engine catches those cases.
  const carried = (i: number): Set<number> => {
    const set = new Set([i]);
    for (let grew = true; grew;) {
      grew = false;
      for (const k of [...set]) for (const j of above[k]!) if (!set.has(j) && below[j]!.every((b) => set.has(b))) { set.add(j); grew = true; }
    }
    return set;
  };
  for (let i = 0; i < m.n; i++) {
    const A = boxes[i]!;
    if (A.lo[1]! < eps) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let j = 0; j < m.n; j++) {
      const B = boxes[j]!;
      if (j === i || Math.abs(B.hi[1]! - A.lo[1]!) > eps) continue;
      const ox0 = Math.max(A.lo[0]!, B.lo[0]!), ox1 = Math.min(A.hi[0]!, B.hi[0]!), oz0 = Math.max(A.lo[2]!, B.lo[2]!), oz1 = Math.min(A.hi[2]!, B.hi[2]!);
      if (ox1 - ox0 <= eps || oz1 - oz0 <= eps) continue;
      x0 = Math.min(x0, ox0); x1 = Math.max(x1, ox1); z0 = Math.min(z0, oz0); z1 = Math.max(z1, oz1);
    }
    // Centre of mass of the body and everything resting on it, so a lever
    // whose own centre overhangs its supports passes if its load balances it.
    const load = carried(i);
    let mx = 0, mz = 0, mm = 0;
    for (const j of load) { mx += m.mass[j]! * m.home[3 * j]!; mz += m.mass[j]! * m.home[3 * j + 2]!; mm += m.mass[j]!; }
    const cx = mx / mm, cz = mz / mm;
    if (!(cx > x0 + eps && cx < x1 - eps && cz > z0 + eps && cz < z1 - eps)) issues.push({ code: 'unsupported', message: `body ${i} at y=${(A.lo[1]! / h).toFixed(2)} h: the centre of mass of it and its load is not over its supports`, bodies: [i] });
  }

  // No continuous collision on the GPU path: one step of the fastest ammo must
  // not carry it through the thinnest body.
  let thin = Infinity;
  for (let i = 0; i < m.n; i++) thin = Math.min(thin, 2 * Math.min(m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!));
  for (const kind of new Set(def.rack)) {
    const s = AMMO[kind].size, size = 'radius' in s ? 2 * s.radius * h : 2 * Math.min(...s.half) * h;
    const v = kind === 'drop' ? Math.sqrt(2 * GRAVITY * def.launcher.dropY * h) : speedOf(kind, 100);
    const reach = v * c.scene.dt;
    if (reach > 0.8 * (size + thin)) issues.push({ code: 'tunnelling', message: `${kind} moves ${reach.toFixed(3)} m per step, more than 0.8 x (${size.toFixed(3)} + thinnest body ${thin.toFixed(3)}) m` });
  }

  for (const i of m.crowns) {
    const x = m.home[3 * i]!, y = m.home[3 * i + 1]!, z = m.home[3 * i + 2]!;
    if (y < def.crownLine * h || x < c.lot.min[0] || x > c.lot.max[0] || z < c.lot.min[1] || z > c.lot.max[1]) issues.push({ code: 'crown-start', message: `crown ${i} starts already down`, bodies: [i] });
  }
  return issues;
}

export const roleName = (id: number): Role | 'ammo' => ROLES[id] ?? 'ammo';
