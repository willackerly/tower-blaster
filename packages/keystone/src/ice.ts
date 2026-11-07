// Ice that cracks and shatters (material 'ice'). Pure rules: the Driver shows
// IceBreaker every state it observes, and it returns what to push (a shatter:
// the block removed, its pieces spawned in its place) and what to tell the
// game (a crack's level and where it started, for the renderer's ice shader).
//
// Damage. Each observed step, every ice body's speed change not explained by
// gravity is taken as one hit, with spin counted at the block's corners:
//   dv = |v - v_prev - g dt| combined with |w - w_prev| x the largest half extent
// A hit under crackDv does nothing (resting contact, sliding, rocking). Above
// it, the hit adds ((dv - crackDv) / (shatterDv - crackDv))^2 to the block's
// damage, so one hit at shatterDv or more shatters it at once and smaller ones
// add up (two at 70% of the way do). Damage d < 1 shows as crack level
// ceil(7 d) (1..7); the crack starts where the first hit pushed from (the face
// opposite the speed change, in the body's frame).
//
// Shatter. At damage 1 the block is removed and replaced, from the next step,
// by its pieces: a 2 x 2 x 2 split (an axis under 3/4 of the longest is not
// split, so a plank breaks across), each 4% smaller than its cell so they
// start apart, denser by the same share so the mass is unchanged, moving with
// the block (its velocity at the piece's centre) plus an outward kick that
// grows with the hit. Pieces crack but never shatter again. As fragments (the
// default, PT15): each cut is placed off centre, seeded per block, so the
// pieces are uneven; their fracture faces are rough (PIECE_FRICTION, not
// ice's 0.05), so they stop near where they fell instead of skating; and each
// starts crushed at the corner that faced the block's centre.
//
// Scoring. The rules keep scoring the structure's n bodies; a shattered block
// is scored where its pieces are: its position is their mass-weighted centre
// (proxy), which leaves the structure's potential energy exactly what it would
// be summed over the pieces. A shattered crown counts as down, a shattered
// heritage block as broken (Session.shattered).
//
// Determinism. Everything here is a function of observed states and step
// indices, so a session replays exactly on a driver with the same options, as
// a weapon's fuses do (arsenal.ts).
import type { BodyDesc, InputEvent, Quat, RemoveEvent, Snapshot, SpawnEvent, Vec3 } from '@tb/engine-api';
import { GRAVITY, MATERIALS, materialId } from './materials.ts';
import type { CompiledLevel } from './level.ts';

export interface IceBlock {
  /** Speed change in one step (m/s, beyond gravity) under which ice takes no damage. */
  crackDv?: number;
  /** Speed change in one step that shatters a whole block at once (m/s). */
  shatterDv?: number;
  /** false: ice cracks but never shatters. */
  shatter?: boolean;
  /** true (default): a shattered block breaks into uneven, rough, crushed fragments; false: into even cubes on ice's own friction (before PT15). */
  fragments?: boolean;
}

export type ResolvedIce = Required<IceBlock>;

/**
 * Keystone's ice. Measured 2026-11-06 on the f64 reference (L1, L2 and L5 built of ice, their par shots;
 * a body's hardest one-step hit, m/s, quartiles 50/90/max): L1 3.5/4.7/6.9, L5 2.7/3.5/5.0, L2 0.17/0.22/10.6
 * (its blast is local). Resting contact reads 0.16 (g dt). At 1.5 most of a struck tower cracks and the
 * calm part stays clear; at 5 a cannonball's block and a few that land hard shatter, and their pieces crack
 * more (L2: 6 shatters, 48 cracks at 6 m/s). Levels set their own (LevelDef.physics.ice).
 */
export const ICE_DEFAULTS: ResolvedIce = { crackDv: 1.5, shatterDv: 5, shatter: true, fragments: true };

/** Pieces as a share of their cell, per axis (the gap keeps them from starting in contact). */
export const PIECE_FILL = 0.96;
/** Outward kick of the pieces at a hit of shatterDv, m/s (it grows with the hit, to twice that). */
export const PIECE_KICK = 0.6;
/** Fragments: each cut lies within PIECE_CUT of the axis's middle, as a share of its length (0.5 +- 0.18: pieces from 32% to 68%). */
export const PIECE_CUT = 0.18;
/**
 * Fragments: the friction of a piece's rough fracture faces (ice's own is 0.05, a polished face). Keystone combines
 * friction by the minimum (level.ts), so on the ground (0.6) a piece sliding at 5 m/s stops in about 2.6 m, not 25 m.
 */
export const PIECE_FRICTION = 0.5;
/** Fragments: the crack level a piece starts at, crushed at the corner that faced the block's centre (4: crushed). */
export const PIECE_CRACK = 4;

/** An ice piece's density: the ice's, packed into PIECE_FILL^3 of its cell (shatterPieces). */
export const ICE_PIECE_DENSITY = MATERIALS[materialId('ice')]!.density / PIECE_FILL ** 3;

/** Whether a spawned body is a shattered block's piece (ice keeps its own density, so a piece's is unique to it). */
export const isIcePiece = (b: BodyDesc): boolean => b.density === ICE_PIECE_DENSITY;

export function iceOf(b: IceBlock | undefined): ResolvedIce {
  return { crackDv: b?.crackDv ?? ICE_DEFAULTS.crackDv, shatterDv: b?.shatterDv ?? ICE_DEFAULTS.shatterDv, shatter: b?.shatter ?? ICE_DEFAULTS.shatter, fragments: b?.fragments ?? ICE_DEFAULTS.fragments };
}

/** Throws unless the ice block is in range. */
export function checkIce(b: IceBlock, where = 'physics.ice'): void {
  const r = iceOf(b);
  if (!(r.crackDv > 0 && r.crackDv <= 50)) throw new Error(`${where}.crackDv must be over 0 and at most 50 m/s: ${b.crackDv}`);
  if (!(r.shatterDv > r.crackDv && r.shatterDv <= 100)) throw new Error(`${where}.shatterDv must be over crackDv (${r.crackDv}) and at most 100 m/s: ${b.shatterDv}`);
  if (typeof r.shatter !== 'boolean') throw new Error(`${where}.shatter must be true or false: ${b.shatter}`);
  if (typeof r.fragments !== 'boolean') throw new Error(`${where}.fragments must be true or false: ${b.fragments}`);
}

/** Damage one hit of speed change dv adds. */
export function hitDamage(dv: number, ice: ResolvedIce): number {
  if (!(dv > ice.crackDv)) return 0;
  const x = (dv - ice.crackDv) / (ice.shatterDv - ice.crackDv);
  return x * x;
}

/** Crack level a damage shows as: 0 whole, 1..7 cracked (7 once damage passes 6/7). */
export function crackLevel(damage: number): number {
  return damage <= 0 ? 0 : Math.min(7, Math.ceil(7 * Math.min(damage, 1)));
}

const qrot = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const get3 = (a: ArrayLike<number>, i: number): Vec3 => [a[3 * i]!, a[3 * i + 1]!, a[3 * i + 2]!];

/** The pieces a block of half extents `half` splits into: per axis 2 cells, or 1 on an axis under 3/4 of the longest. */
export function pieceGrid(half: Vec3): Vec3 {
  const m = Math.max(...half);
  return half.map((h) => (h >= 0.75 * m ? 2 : 1)) as Vec3;
}

/** Where a fragment cut lies on axis `a` of a block with crack seed `seed`, as a share of the axis from its low end (integer hash: the same on every platform). */
export function pieceCut(seed: number, a: number): number {
  const h = Math.imul((seed ^ Math.imul(a + 1, 0x9e3779b9)) >>> 0, 0x85ebca6b) >>> 0;
  const u = (((h ^ (h >>> 13)) >>> 0) % 1024) / 1023;
  return 0.5 + PIECE_CUT * (2 * u - 1);
}

/**
 * The pieces of block `b` (as it stands: position, rotation, velocities) after a hit of `dv`: spawn events
 * due at `step`. Mass is kept (each piece PIECE_FILL^3 of its cell's volume, denser by as much), and so are the
 * centre of mass (the cells tile the block) and the momentum (the kicks' mass-weighted mean is taken off).
 * As fragments (ice.fragments) the cuts lie at pieceCut(seed, axis) and the pieces have PIECE_FRICTION.
 */
export function shatterPieces(b: BodyDesc, pos: Vec3, rot: Quat, v: Vec3, w: Vec3, dv: number, ice: ResolvedIce, step: number, seed = 0): SpawnEvent[] {
  if (b.shape.kind !== 'box') return [];
  const half = b.shape.half, g = pieceGrid(half);
  // Per axis, the cells' centres and half extents: one cell, or two either side of the cut at share f.
  const cells = [0, 1, 2].map((a) => {
    const h = half[a]!;
    if (g[a] === 1) return [{ c: 0, h }];
    const f = ice.fragments ? pieceCut(seed, a) : 0.5;
    return [{ c: h * (f - 1), h: h * f }, { c: h * f, h: h * (1 - f) }];
  });
  const density = b.density / PIECE_FILL ** 3;
  const kick = PIECE_KICK * Math.min(2, dv / ice.shatterDv);
  const parts: Array<{ half: Vec3; r: Vec3; m: number; k: Vec3 }> = [];
  for (const x of cells[0]!) for (const y of cells[1]!) for (const z of cells[2]!) {
    const r = qrot(rot, [x.c, y.c, z.c]), rl = Math.hypot(...r) || 1;
    parts.push({ half: [x.h * PIECE_FILL, y.h * PIECE_FILL, z.h * PIECE_FILL], r, m: x.h * y.h * z.h, k: [(kick * r[0]) / rl, (kick * r[1]) / rl, (kick * r[2]) / rl] });
  }
  // Uneven pieces: the outward kicks no longer cancel by symmetry, so their mass-weighted mean is taken off.
  const M = parts.reduce((s, p) => s + p.m, 0);
  const mean = [0, 1, 2].map((k) => parts.reduce((s, p) => s + p.m * p.k[k]!, 0) / M);
  return parts.map(({ half: ph, r, k }) => ({
    step, kind: 'spawn' as const,
    body: {
      ...b, shape: { kind: 'box' as const, half: ph }, pos: [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]] as Vec3, rot: [...rot] as Quat,
      linVel: [
        v[0] + w[1] * r[2] - w[2] * r[1] + k[0] - mean[0]!,
        v[1] + w[2] * r[0] - w[0] * r[2] + k[1] - mean[1]!,
        v[2] + w[0] * r[1] - w[1] * r[0] + k[2] - mean[2]!,
      ] as Vec3,
      angVel: [...w] as Vec3, density, ...(ice.fragments ? { friction: PIECE_FRICTION } : {}),
    },
  }));
}

/** A piece's crushed corner, in its own frame (IceCrack.at): the corner toward the block's centre (0 on an axis not split). */
export function pieceCorner(local: Vec3): Vec3 {
  return local.map((x) => (x > 0 ? -1 : x < 0 ? 1 : 0)) as Vec3;
}

/** A body's crack pattern seed (Knuth's multiplicative hash of its id, 16 bits): the same body cracks the same way every run. */
export const crackSeed = (id: number): number => (Math.imul(id, 2654435761) + 12345) & 0xffff;

/** A crack to draw (Feedback 'iceCrack'): its level, where it started (body-normalized, -1..1 per axis) and a seed for its pattern. */
export interface IceCrack { body: number; level: number; at: Vec3; seed: number }
/** A shatter (Feedback 'shatter'): the block removed at `step` and the engine ids of its pieces. */
export interface IceShatter { step: number; body: number; pieces: number[]; dv: number; /** Each piece's crack as it starts (fragments: crushed at its inner corner; else whole). */ cracks: IceCrack[] }

interface Tracked { id: number; half: Vec3; damage: number; level: number; at: Vec3 | null; piece: boolean; v: Vec3 | null; w: Vec3 | null; hardest: number }

/**
 * One session's ice: which bodies are ice (the structure's and the pieces), their damage, and the
 * shattered blocks with their pieces. Driver owns one and checkpoints it (plain data only).
 */
export class IceBreaker {
  readonly rules: ResolvedIce;
  private readonly tracked: Tracked[] = [];
  /** Shattered structure body -> its pieces' engine ids, in shatter order. */
  readonly shattered = new Map<number, number[]>();
  /** Masses of the pieces by engine id (the proxy's weights). */
  private readonly pieceMass = new Map<number, number>();
  /** Pieces waiting for their ids (Driver numbers spawns once pushed). */
  private pending: { body: number; spawns: SpawnEvent[]; dv: number; corners: Vec3[] } | null = null;

  constructor(readonly level: CompiledLevel) {
    this.rules = iceOf(level.def.physics?.ice);
    const ice = materialId('ice'), m = level.meta;
    // Only a box shatters (into boxes); ice of another shape cracks as a piece does.
    for (let i = 0; i < m.n; i++) if (m.material[i] === ice) this.tracked.push({ id: i, half: [m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!], damage: 0, level: 0, at: null, piece: level.scene.bodies[i]!.shape.kind !== 'box', v: null, w: null, hardest: 0 });
  }

  /** Whether the level has any ice (nothing else here runs without it). */
  get any(): boolean { return this.tracked.length > 0; }

  /** Bodies a level's ice can add: every ice block's pieces (engines reserve room for them). */
  static budget(level: CompiledLevel): number {
    if (!iceOf(level.def.physics?.ice).shatter) return 0;
    const ice = materialId('ice'), m = level.meta;
    let n = 0;
    for (let i = 0; i < m.n; i++) if (m.material[i] === ice && level.scene.bodies[i]!.shape.kind === 'box') { const g = pieceGrid([m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!]); n += g[0] * g[1] * g[2]; }
    return n;
  }

  /**
   * One observed state (its step: snapshotStep): damage from the speed changes since the last one,
   * cracks to show, and at most one shatter, its events due at step + 1. `bodies` are the engine's
   * bodies by id (Driver.bodies). The pieces' ids come back through placed() once pushed.
   */
  observe(s: Snapshot, step: number, bodies: readonly BodyDesc[], dt: number): { events: InputEvent[]; cracks: IceCrack[]; shatter: { body: number; dv: number } | null } {
    const cracks: IceCrack[] = [];
    let best: { t: Tracked; dv: number; pos: Vec3; rot: Quat; v: Vec3; w: Vec3 } | null = null;
    for (const t of this.tracked) {
      if (this.shattered.has(t.id) || t.id >= s.count) continue;
      // Only an active body is judged: one in rubble or the lattice (or removed) is held still, and its
      // speed falling to zero there is not a hit, so its history starts again when it is active.
      if (s.tier && s.tier[t.id] !== 0) { t.v = t.w = null; continue; }
      const v = get3(s.linVel, t.id), w = get3(s.angVel, t.id);
      const pv = t.v, pw = t.w;
      t.v = v; t.w = w;
      if (!pv || !pw) continue;
      const dlin: Vec3 = [v[0] - pv[0], v[1] - (pv[1] - GRAVITY * dt), v[2] - pv[2]];
      const dspin = Math.hypot(w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]) * Math.max(...t.half);
      const dv = Math.hypot(Math.hypot(...dlin), dspin);
      const add = hitDamage(dv, this.rules);
      if (add > 0) {
        if (!t.at) {
          // The crack starts on the face the hit pushed from: opposite the speed change, in the body's frame.
          const q: Quat = [s.rot[4 * t.id]!, s.rot[4 * t.id + 1]!, s.rot[4 * t.id + 2]!, s.rot[4 * t.id + 3]!];
          const b = qrot(conj(q), dlin), m = Math.max(Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[2])) || 1;
          t.at = [(0 - b[0]) / m, (0 - b[1]) / m, (0 - b[2]) / m]; // 0 - x, not -x: no -0 in the origin
        }
        t.damage += add;
        t.hardest = Math.max(t.hardest, dv);
      }
      // Past damage 1 a block shatters, now or (another went this step) at a later one, with or without a new hit.
      if (t.damage >= 1 && this.rules.shatter && !t.piece) {
        if (!best || t.hardest > best.dv) best = { t, dv: t.hardest, pos: get3(s.pos, t.id), rot: [s.rot[4 * t.id]!, s.rot[4 * t.id + 1]!, s.rot[4 * t.id + 2]!, s.rot[4 * t.id + 3]!], v, w };
        continue;
      }
      const level = crackLevel(t.damage);
      if (level !== t.level) { t.level = level; cracks.push({ body: t.id, level, at: t.at!, seed: crackSeed(t.id) }); }
    }
    // One shatter per step (the rest wait a step, their damage kept): ids stay simple to assign.
    if (!best || this.pending) return { events: [], cracks, shatter: null };
    const parent = bodies[best.t.id]!;
    const spawns = shatterPieces(parent, best.pos, best.rot, best.v, best.w, best.dv, this.rules, step + 1, crackSeed(best.t.id));
    if (!spawns.length) return { events: [], cracks, shatter: null };
    // Each piece's corner toward the block's centre, in its own frame (it starts with the block's rotation).
    const at = best.pos, q = conj(best.rot);
    const corners = spawns.map((e) => pieceCorner(qrot(q, [e.body.pos[0] - at[0], e.body.pos[1] - at[1], e.body.pos[2] - at[2]])));
    this.pending = { body: best.t.id, spawns, dv: best.dv, corners };
    const remove: RemoveEvent = { step: step + 1, kind: 'remove', id: best.t.id };
    return { events: [remove, ...spawns], cracks, shatter: { body: best.t.id, dv: best.dv } };
  }

  /**
   * Every ice body as it stands, the shattered blocks left out and their pieces in: what a renderer
   * draws as ice, with each one's crack (level 0 and origin 0 when whole). The game paints from it on
   * a load and after an undo; between those, the cracks and shatters come as feedback.
   */
  surfaces(): IceCrack[] {
    return this.tracked.filter((t) => !this.shattered.has(t.id)).map((t) => ({ body: t.id, level: t.level, at: t.at ?? [0, 0, 0], seed: crackSeed(t.id) }));
  }

  /** The engine ids of the pending shatter's pieces (Driver: after push, in spawn order). Starts tracking them. */
  placed(ids: number[]): IceShatter {
    const p = this.pending;
    if (!p || ids.length !== p.spawns.length) throw new Error('IceBreaker.placed: no shatter pending, or a different number of pieces');
    this.pending = null;
    this.shattered.set(p.body, ids);
    // Fragments start crushed at their inner corner: damage PIECE_CRACK - 1/2 sevenths shows as level PIECE_CRACK,
    // and later hits add to it (a piece never shatters). Even cubes start whole.
    const frag = this.rules.fragments, cracks: IceCrack[] = [];
    ids.forEach((id, k) => {
      const b = p.spawns[k]!.body;
      if (b.shape.kind !== 'box') return;
      const h = b.shape.half, at = frag ? p.corners[k]! : null;
      this.pieceMass.set(id, b.density * 8 * h[0] * h[1] * h[2]);
      this.tracked.push({ id, half: [h[0], h[1], h[2]], damage: frag ? (PIECE_CRACK - 0.5) / 7 : 0, level: frag ? PIECE_CRACK : 0, at, piece: true, v: null, w: null, hardest: 0 });
      cracks.push({ body: id, level: frag ? PIECE_CRACK : 0, at: at ?? [0, 0, 0], seed: crackSeed(id) });
    });
    return { step: p.spawns[0]!.step, body: p.body, pieces: ids, dv: p.dv, cracks };
  }

  /**
   * The state the rules score: `s` itself without a shattered block, otherwise a copy in which each
   * shattered block sits at its pieces' mass-weighted centre, moving at their mass-weighted velocity,
   * awake while any of them is (position, velocity and awake copied; the rest shared).
   */
  view(s: Snapshot): Snapshot {
    if (this.shattered.size === 0) return s;
    const pos = s.pos.slice(), linVel = s.linVel.slice(), awake = s.awake.slice();
    const tier = s.tier ? s.tier.slice() : undefined;
    for (const [body, ids] of this.shattered) {
      const live = ids.filter((id) => id < s.count);
      if (!live.length) continue;
      let m = 0;
      const c = [0, 0, 0], v = [0, 0, 0];
      let any = 0;
      for (const id of live) {
        const w = this.pieceMass.get(id) ?? 1;
        m += w;
        for (let k = 0; k < 3; k++) { c[k] = c[k]! + w * s.pos[3 * id + k]!; v[k] = v[k]! + w * s.linVel[3 * id + k]!; }
        any |= s.awake[id]!;
      }
      for (let k = 0; k < 3; k++) { pos[3 * body + k] = c[k]! / m; linVel[3 * body + k] = v[k]! / m; }
      awake[body] = any;
      // Scored as a live body: the proxy moves with its pieces.
      if (tier && s.tier) tier[body] = s.tier[live[0]!]!;
    }
    return { ...s, pos, linVel, awake, ...(tier ? { tier } : {}) };
  }
}
