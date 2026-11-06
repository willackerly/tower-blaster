// Level definitions: authored data in cube units, compiled to an engine
// SceneDesc plus per-body metadata the rules need (role, material, mass,
// home pose). Compilation is pure and the body order is stable, so a level
// hash pins the exact scene a recorded solution was made against.
import { type BodyDesc, massOf, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { DEFAULT_GAP, DEFAULT_UNIT, encodeTag, GRAVITY, MATERIALS, materialId, type MaterialName, type Role, ROLES } from './materials.ts';
import { peOf_mJ, SETTLE_RULES, type SettleRule } from './rules.ts';
import { type Arm, chargeIssues, levelArm, rackArms } from './arsenal.ts';
import { chargeWeaponOf, isRackItem, itemRef, type LevelWeapon, PLUNGER, RACK_ITEM_NAMES, rackBodies, type RackItem, speedOf, WEAPON_KEY, weaponOf } from './rack.ts';
import { type ScenarioPart, scenarioBodies, scenarioKey } from './scenario-part.ts';
import { ammoBody, type LauncherDef, launcherPos, type Shot, type ShotFrame } from './shots.ts';
import { checkIce, type IceBlock, IceBreaker, iceOf } from './ice.ts';

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
export type Part = BlockPart | BoxPart | ScenarioPart;

/**
 * What the level asks for; meeting it is the first star. footprintMax (a fraction of the structure
 * bodies allowed outside the lot grown by 0.5 h): on par levels part of the skyline objective, as
 * before; on outcome levels a constraint on any objective that costs points, not stars
 * (docs/game/spectacle-mode.md, section 3).
 */
export type Objective =
  | { kind: 'crowns'; footprintMax?: number }
  | { kind: 'skyline'; maxH: number; footprintMax?: number }
  /** Collapse fraction D (outcome.ts collapseFraction) at least `min`, from 0 to 1. */
  | { kind: 'collapse'; min: number; footprintMax?: number }
  /**
   * Undercut's Hollow (docs/game/undercut-bullet-time.md): every crown still up at the end. Outcome
   * levels only; a settle with a crown down ends the level there, failed. Scored on what was pulled.
   */
  | { kind: 'hold'; footprintMax?: number };

/** How a level is scored: par (strokes, golf stamps; L1 to L5) or outcome (what came down; the spectacle mode). */
export const SCORINGS = ['par', 'outcome'] as const;
export type Scoring = (typeof SCORINGS)[number];

/**
 * The one metric an outcome level's stars are measured on: collapse (D, higher is better), crowns
 * (crowns down), skyline (end skyline over start skyline, lower is better), score (the tally total)
 * or pulled (the share of the structure's mass pulled, Undercut; higher is better).
 */
export const STAR_METRICS = ['collapse', 'crowns', 'skyline', 'score', 'pulled'] as const;
export type StarMetric = (typeof STAR_METRICS)[number];

/**
 * Thresholds cast by the bot for an outcome level (spectacle-mode.md, section 6): two stars at t2,
 * three at t3 (and no heritage broken); `best` is the best bot play (beat the bot). The rest records
 * how they were cast. Not part of the level hash: the cast records the hash it was made against.
 */
/**
 * A level's star thresholds, as a cast set them. `waived` names cast gates that failed and were accepted as a
 * documented call (keystone-lab `--waive`; the level's notes say why), so the stars file says which stars rest on one.
 */
export interface StarsDef { metric: StarMetric; t2: number; t3: number; best?: number; castOn?: string; engine?: string; hash?: string; n?: number; seed?: number; waived?: string[] }

/**
 * x as a StarsDef, or throws naming `where` and the field at fault: the check a stars file (big-levels.ts
 * STARS_FILE) passes at import, so a malformed drop-in fails loudly instead of showing wrong stars.
 * Higher is better for every metric but skyline, so T3 must be at least as hard as T2 in that direction.
 */
export function checkStars(x: unknown, where = 'stars'): StarsDef {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`${where} must be an object`);
  const o = x as Record<string, unknown>;
  if (!(STAR_METRICS as readonly unknown[]).includes(o.metric)) throw new Error(`${where}.metric must be one of ${STAR_METRICS.join(', ')}: ${String(o.metric)}`);
  for (const k of ['t2', 't3']) if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) throw new Error(`${where}.${k} must be a finite number: ${String(o[k])}`);
  for (const k of ['best', 'n', 'seed']) if (o[k] !== undefined && (typeof o[k] !== 'number' || !Number.isFinite(o[k]))) throw new Error(`${where}.${k} must be a finite number when given: ${String(o[k])}`);
  for (const k of ['castOn', 'engine', 'hash']) if (o[k] !== undefined && typeof o[k] !== 'string') throw new Error(`${where}.${k} must be a string when given: ${String(o[k])}`);
  if (o.waived !== undefined && (!Array.isArray(o.waived) || !o.waived.length || !o.waived.every((g) => typeof g === 'string' && g.length > 0))) throw new Error(`${where}.waived must be a non-empty list of gate names when given: ${JSON.stringify(o.waived)}`);
  const known = new Set(['metric', 't2', 't3', 'best', 'castOn', 'engine', 'hash', 'n', 'seed', 'waived']);
  for (const k of Object.keys(o)) if (!known.has(k)) throw new Error(`${where}: unknown field ${k}`);
  const lower = o.metric === 'skyline', t2 = o.t2 as number, t3 = o.t3 as number;
  if (lower ? t3 > t2 : t3 < t2) throw new Error(`${where}: t3 (${t3}) is easier than t2 (${t2}) for ${String(o.metric)}`);
  return o as unknown as StarsDef;
}

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
  /** What the player may fire, one entry per shot (rack.ts names). */
  rack: RackItem[];
  /**
   * Weapons the rack's w-<key> items fire, by key: a GrenadeSpec with lengths (blast radius,
   * prox) in h and the rest SI (levelWeapon), or a @tb/weapons WeaponSpec in the viewer's
   * cube units, scaled to the level's commonest block (arsenal.ts cubeScale).
   */
  weapons?: Record<string, LevelWeapon>;
  /**
   * Charges on the structure (docs/design/charges.md): WeaponSpecs riding structure bodies, with no
   * body of their own until they go off. A `plunger` rack item arms them on a timeline (shots.ts
   * PlungerShot names them by index here); `arm: 'start'` ones are armed when play starts.
   */
  charges?: ChargeDef[];
  /** Validator limits a level may relax. */
  limits?: {
    /** Most a rack item's mass may be over the lightest structure body's (default AMMO_RATIO, at most AMMO_RATIO_MAX). */
    ammoRatio?: number;
  };
  launcher: LauncherDef;
  /** Leverage for the gold badge (LevelScore.gold; it gates no star since 2026-11-06, docs/game/stars.md), set from bot runs; DEFAULT_GOLD when absent. */
  lGold?: number;
  /** Recorded solutions, replayed by tests. */
  solutions?: { par?: Shot[]; ace?: Shot[] };
  /** Default 'par': every level before the spectacle mode, scored as before. */
  scoring?: Scoring;
  /** Outcome levels: the cast star thresholds; absent, stars are uncast (only the objective's star). */
  stars?: StarsDef;
  /** Outcome levels: end at the first settle where the objective is met, as par levels do (URL key keystone.autobank). Default: end at a bank or an empty rack. */
  autobank?: boolean;
  /**
   * How a shot settles (rules.ts SETTLE_RULES; URL key keystone.settle). Default by scoring (settleOf):
   * v1 for par levels, whose lines are pinned on it, and v3 for outcome levels, whose big structures
   * keep blocks rocking long after the collapse is over. In the hash unless par's v1 or outcome's v2
   * (the rules those levels were hashed under before v3), so a v3 level hashes apart from its v2 self.
   */
  settle?: SettleRule;
  /**
   * Bullet Time (C2, docs/game/undercut-bullet-time.md): the most shots that may go in while another
   * runs, each cutting it (rapid fire, Session.fire); 0 allows none. Absent: no limit. The game lets
   * the player freeze the world to aim them; a freeze costs nothing until a shot goes in. Part of the
   * hash (URL key keystone.freeze), so stars cast without a budget never show with one.
   */
  freeze?: number;
  /** The physics the level plays at (default Keystone's: PHYSICS_DEFAULTS). Part of the level hash, so stars cast at one setting never show at another. */
  physics?: PhysicsBlock;
  /**
   * Made from an authored level by overrides (URL keys keystone.*): it plays, but cast stars do not
   * apply ("custom: stars not recorded"). Not part of the hash: the overrides already are.
   */
  custom?: boolean;
}

/** A charge on the structure (LevelDef.charges; arsenal.ts levelCharges resolves it). */
export interface ChargeDef {
  /** The structure body it rides (its index in the compiled level: engine id): not a crown, heritage or ice. */
  host: number;
  /** Its point in the host's frame, in h (default the host's centre): a blast is centred there. */
  at?: Vec3;
  /** A key of the level's weapons (a WeaponSpec in cube units) or a built-in charge: cutter, kicker, relay. */
  weapon: string;
  /** 'plunger' (default): armed by a plunger shot naming it; 'start': armed when play starts (a relay, with a moved trigger). */
  arm?: 'plunger' | 'start';
}

/** A level's physics settings (spectacle-mode.md, section 8). Absent fields take PHYSICS_DEFAULTS. */
export interface PhysicsBlock {
  /** AVBD iterations (GPU solver and reference). */
  iterations?: number;
  /** Loaded-gap slop, m (0: off). */
  gapSlop?: number;
  /** Restitution e for the structure and the ground, with the engine's restitution pass on; null: off. */
  bounce?: number | null;
  /** The GPU engine's pair buffer per body; absent: the game's sizing rule. */
  pairsPerBody?: number;
  /** Steps run after init before play starts. */
  presettle?: number;
  /** How the level's ice cracks and shatters (ice.ts; absent fields take ICE_DEFAULTS). Only levels with ice bodies use it. */
  ice?: IceBlock;
  /**
   * GPU per-body sleep (physics-gpu GpuEngineOptions.sleep, roadmap E2): a body at rest stops being solved, as an
   * anchor, until a blast, a spawn, a removal or a moving neighbour wakes it. It changes the GPU's trajectories, so it
   * is off by default (every par line and cast is pinned without it) and part of the hash when on. Not with bounce
   * (the restitution pass does not know sleepers yet). Rapier sleeps either way (SceneDesc.sleep).
   */
  sleep?: boolean;
}

/**
 * Keystone's settings, as every par line is pinned at: 40 iterations, 3e-5 m slop, no Bounce, 300
 * pre-settle steps (driver.ts AVBD_ITERATIONS, AVBD_GAP_SLOP, PRESETTLE_STEPS give the reasons).
 */
export const PHYSICS_DEFAULTS = { iterations: 40, gapSlop: 3e-5, bounce: null, presettle: 300, sleep: false } as const satisfies PhysicsBlock;
export type ResolvedPhysics = { iterations: number; gapSlop: number; bounce: number | null; presettle: number; sleep: boolean; pairsPerBody?: number };

export function physicsOf(d: LevelDef): ResolvedPhysics {
  const p = d.physics ?? {};
  return {
    iterations: p.iterations ?? PHYSICS_DEFAULTS.iterations, gapSlop: p.gapSlop ?? PHYSICS_DEFAULTS.gapSlop,
    bounce: p.bounce === undefined ? PHYSICS_DEFAULTS.bounce : p.bounce, presettle: p.presettle ?? PHYSICS_DEFAULTS.presettle,
    sleep: p.sleep ?? PHYSICS_DEFAULTS.sleep,
    ...(p.pairsPerBody !== undefined ? { pairsPerBody: p.pairsPerBody } : {}),
  };
}

/** Throws unless every physics field is in range, naming it. */
export function checkPhysics(p: PhysicsBlock, where = 'physics'): void {
  const int = (v: number | undefined, k: string, lo: number, hi: number) => {
    if (v !== undefined && !(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(`${where}.${k} must be a whole number from ${lo} to ${hi}: ${v}`);
  };
  int(p.iterations, 'iterations', 1, 200);
  int(p.pairsPerBody, 'pairsPerBody', 1, 256);
  int(p.presettle, 'presettle', 0, 6000);
  if (p.gapSlop !== undefined && !(Number.isFinite(p.gapSlop) && p.gapSlop >= 0 && p.gapSlop <= 0.01)) throw new Error(`${where}.gapSlop must be from 0 to 0.01 m: ${p.gapSlop}`);
  if (p.bounce !== undefined && p.bounce !== null && !(p.bounce >= 0 && p.bounce <= 1)) throw new Error(`${where}.bounce must be from 0 to 1, or null for off: ${p.bounce}`);
  if (p.ice !== undefined) checkIce(p.ice, `${where}.ice`);
  if (p.sleep !== undefined && typeof p.sleep !== 'boolean') throw new Error(`${where}.sleep must be true or false: ${p.sleep}`);
  if (p.sleep === true && p.bounce !== undefined && p.bounce !== null) throw new Error(`${where}.sleep does not go with bounce yet (the restitution pass does not know sleepers): bounce ${p.bounce}`);
}

/** The physics block with fields at their defaults left out (absent when nothing is left): what the hash sees. */
function physicsKey(p: PhysicsBlock | undefined): PhysicsBlock | undefined {
  if (!p) return undefined;
  const out: PhysicsBlock = {};
  if (p.iterations !== undefined && p.iterations !== PHYSICS_DEFAULTS.iterations) out.iterations = p.iterations;
  if (p.gapSlop !== undefined && p.gapSlop !== PHYSICS_DEFAULTS.gapSlop) out.gapSlop = p.gapSlop;
  if (p.bounce !== undefined && p.bounce !== PHYSICS_DEFAULTS.bounce) out.bounce = p.bounce;
  if (p.presettle !== undefined && p.presettle !== PHYSICS_DEFAULTS.presettle) out.presettle = p.presettle;
  if (p.pairsPerBody !== undefined) out.pairsPerBody = p.pairsPerBody;
  if (p.sleep !== undefined && p.sleep !== PHYSICS_DEFAULTS.sleep) out.sleep = p.sleep;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The level's cast stars if they apply to this compiled level: none on a custom run, and none when the
 * cast recorded another level hash (the level, its physics or its rules changed since).
 */
export function castStars(c: CompiledLevel): StarsDef | undefined {
  const s = c.def.stars;
  if (!s || c.def.custom || (s.hash !== undefined && s.hash !== c.hash)) return undefined;
  return s;
}

export const scoringOf = (d: LevelDef): Scoring => d.scoring ?? 'par';
/** The settle rule a level plays by: its own, else v1 for par scoring and v3 for outcome scoring. */
export const settleOf = (d: LevelDef): SettleRule => d.settle ?? (scoringOf(d) === 'outcome' ? 'v3' : 'v1');
/** Throws unless v is a settle rule, naming `where`. */
export function checkSettle(v: unknown, where = 'settle'): SettleRule {
  if (!(SETTLE_RULES as readonly unknown[]).includes(v)) throw new Error(`${where} must be ${SETTLE_RULES.join(' or ')}: ${String(v)}`);
  return v as SettleRule;
}

export const ROLE_ID: Record<Role, number> = { plain: 0, crown: 1, heritage: 2 };
/** Most rack items that fire something; pulls count apart (MAX_PULLS), since they add no body. */
export const MAX_RACK = 8;
/** Most pulls a rack holds (Undercut's Hollow takes many blocks). */
export const MAX_PULLS = 24;

/** The largest freeze budget a level may give (LevelDef.freeze). */
export const MAX_FREEZE = 9;

/** Why `n` is not a freeze budget (a whole number, 0 to MAX_FREEZE), or null when it is. */
export function freezeProblem(n: number): string | null {
  return Number.isInteger(n) && n >= 0 && n <= MAX_FREEZE ? null : `freeze must be a whole number from 0 to ${MAX_FREEZE}: ${n}`;
}

/** Why a rack is too big or empty (MAX_RACK fired items, MAX_PULLS pulls), or null when it fits. */
export function rackSizeProblem(rack: readonly string[]): string | null {
  // A plunger fires nothing but is a stroke: it counts with the fired items.
  const pulls = rack.filter((x) => x === 'pull').length, fired = rack.length - pulls;
  if (rack.length === 0) return 'an empty rack';
  if (fired > MAX_RACK) return `${fired} fired items, over ${MAX_RACK}`;
  if (pulls > MAX_PULLS) return `${pulls} pulls, over ${MAX_PULLS}`;
  return null;
}
/**
 * Rack item mass over the lightest structure body's, default and ceiling. AVBD drives a
 * light body into the ground under a much heavier one (roadmap E4), so a level may raise
 * the default only to the ceiling, and only with a passing heavy-ball probe (its tests).
 */
export const AMMO_RATIO = 20;
export const AMMO_RATIO_MAX = 100;

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
  /** The rack's weapons resolved, by item name (arsenal.ts rackArms; frame.shells holds their shells). */
  arms: Readonly<Record<string, Arm>>;
  /** World-space lot rectangle in metres. */
  lot: { min: [number, number]; max: [number, number] };
  /** Structure height in metres (top of the highest body). */
  height: number;
  hash: string;
}

export const unitOf = (d: LevelDef) => d.unit ?? DEFAULT_UNIT;
export const pitchOf = (d: LevelDef) => 1 + (d.gap ?? DEFAULT_GAP);

function body(pos: Vec3, half: Vec3, material: MaterialName, role: Role, part: number, rot: BodyDesc['rot'] = [0, 0, 0, 1]): BodyDesc {
  const m = MATERIALS[materialId(material)]!;
  return { shape: { kind: 'box', half }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: m.density, friction: m.friction, restitution: m.restitution, tag: encodeTag(role, part) };
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
  if (def.physics) checkPhysics(def.physics);
  if (def.settle !== undefined) checkSettle(def.settle);
  const h = unitOf(def), p = pitchOf(def) * h;
  const bounce = physicsOf(def).bounce;
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
    } else if (part.kind === 'scenario') {
      for (const b of scenarioBodies(part, h, pitchOf(def))) add(body(b.pos, b.half, part.material, b.role, pi, b.rot), b.role, part.material, pi);
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
    // 'min' lets one slick face make a slip plane: ice on plaster is ice, not
    // the 0.325 the default average gives (docs/game/findings.md, section 3).
    ground: { y: 0, friction: MATERIALS[0].friction, ...(bounce !== null ? { restitution: bounce } : {}) }, sleep: true, frictionCombine: 'min', bodies, inputs: [],
  };
  // Bounce: the structure and the ground at e (the engine's restitution pass is turned on from the same block).
  if (bounce !== null) for (const b of bodies) b.restitution = bounce;
  const lot = { min: [def.lot.min[0] * p, def.lot.min[1] * p] as [number, number], max: [def.lot.max[0] * p, def.lot.max[1] * p] as [number, number] };
  const frame: ShotFrame = { unit: h, pitch: pitchOf(def), centre: [(lot.min[0] + lot.max[0]) / 2, (lot.min[1] + lot.max[1]) / 2], launcher: def.launcher };
  // Solutions don't change the scene, and the stars are cast against the hash (StarsDef.hash).
  // scoring 'par', autobank false, the scoring's settle rule and physics at its defaults are the defaults, so writing them out names the same level;
  // custom marks overrides the hash already holds.
  const { solutions: _omit, stars: _stars, custom: _custom, ...geometry } = def;
  if (geometry.scoring === 'par') delete geometry.scoring;
  if (geometry.autobank === false) delete geometry.autobank;
  // The settle rule a level plays by hashes as absent when it is the one its scoring used before v3 (par v1, outcome v2), so those
  // levels hash as they did; any other, outcome levels' default v3 included, is written out, so stars cast under v2 never show under v3.
  const settleRule = settleOf(def);
  if (settleRule === (scoringOf(def) === 'outcome' ? 'v2' : 'v1')) delete geometry.settle; else geometry.settle = settleRule;
  const physics = physicsKey(geometry.physics);
  if (physics) geometry.physics = physics; else delete geometry.physics;
  // Ice rules join the hash written out whenever the level has ice (as a defaulted weapon does), so retuning
  // ICE_DEFAULTS drops stars cast under the old ones; levels without ice hash as before, whatever physics.ice says.
  if (mats.includes(materialId('ice'))) geometry.physics = { ...geometry.physics, ice: iceOf(def.physics?.ice) };
  geometry.parts = geometry.parts.map((pt) => (pt.kind === 'scenario' ? scenarioKey(pt) : pt));
  // A w- item the level gives no weapon of its own plays the built-in (rack.ts weaponOf): the built-in joins the
  // hash as if written out, so retuning one drops stars cast with it. Levels whose rack has none hash as before.
  const defaulted: Record<string, LevelWeapon> = {};
  for (const item of def.rack) {
    const ref = itemRef(item);
    if (ref?.kind !== 'weapon' || (def.weapons && Object.hasOwn(def.weapons, ref.key))) continue;
    const w = weaponOf(def, ref.key);
    if (w) defaulted[ref.key] = w;
  }
  // Built-in charges a level names join the hash the same way.
  for (const ch of def.charges ?? []) {
    if (typeof ch.weapon !== 'string' || (def.weapons && Object.hasOwn(def.weapons, ch.weapon))) continue;
    const w = chargeWeaponOf(def, ch.weapon);
    if (w) defaulted[ch.weapon] = w;
  }
  if (Object.keys(defaulted).length) geometry.weapons = { ...geometry.weapons, ...defaulted };
  // A scenario part names its bodies by (id, params, seed): the bodies themselves join the hash, so a
  // change to the scenario's builder is a different level too. Levels without one hash as before.
  const built = def.parts.some((pt) => pt.kind === 'scenario') ? `|${bodiesDigest(bodies)}` : '';
  const c: CompiledLevel = { def, scene, meta, frame, arms: {}, lot, height, hash: hashString(JSON.stringify(geometry) + built) };
  const arms = rackArms(c);
  c.arms = arms;
  frame.shells = Object.fromEntries(Object.entries(arms).map(([k, a]) => [k, a.shell]));
  return c;
}

/** FNV-1a over the bytes of every body's pose and half-extents (f64). */
function bodiesDigest(bodies: readonly BodyDesc[]): string {
  const f = new Float64Array(10 * bodies.length);
  bodies.forEach((b, i) => { f.set(b.pos, 10 * i); f.set(b.rot, 10 * i + 3); f.set((b.shape as { half: Vec3 }).half, 10 * i + 7); });
  const u = new Uint8Array(f.buffer);
  let a = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) a = Math.imul(a ^ u[i]!, 0x01000193) >>> 0;
  return a.toString(16).padStart(8, '0');
}

export interface Issue {
  code: 'count' | 'capacity' | 'launcher' | 'overlap' | 'unsupported' | 'mass-ratio' | 'ammo-ratio' | 'dud' | 'tunnelling' | 'crown-start' | 'rack' | 'weapon' | 'empty' | 'watched' | 'flat' | 'objective' | 'freeze' | 'charge';
  message: string;
  bodies?: number[];
  /** Legal but worth knowing (a dud item): the level still plays as authored. */
  warning?: true;
}

/** The engines a level can be checked for: their structure budgets differ. */
export type LevelEngine = 'rapier' | 'gpu';
/**
 * Bodies an engine plays a level with: Rapier's prototype budget, the GPU solver's slice budget (raised
 * by GPU sleep, E2). Rapier's counts the rack's bodies too (`capacity`); the GPU's is the structure's,
 * the solver bar, since the GPU engine sizes its buffers per level for the structure plus the rack.
 */
export const ENGINE_MAX_BODIES: Record<LevelEngine, number> = { rapier: 2500, gpu: 10_000 };
/**
 * The engine a level is checked for when none is named: chamber (par) levels play on every engine, so
 * Rapier's budget; outcome levels are the GPU's (spectacle-mode.md, section 8).
 */
export const defaultEngineOf = (d: LevelDef): LevelEngine => (scoringOf(d) === 'outcome' ? 'gpu' : 'rapier');
/** Crowns plus heritage: they are read as watched bodies every step, and the 100k path reads at most 64. */
export const MAX_WATCHED = 64;

export interface ValidateOptions { engine?: LevelEngine }

interface Box { lo: [number, number, number]; hi: [number, number, number] }

const aabb = (m: BodyMeta, i: number): Box => {
  const lo: [number, number, number] = [0, 0, 0], hi: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) { lo[k] = m.home[3 * i + k]! - m.half[3 * i + k]!; hi[k] = m.home[3 * i + k]! + m.half[3 * i + k]!; }
  return { lo, hi };
};

/**
 * Pairs (i < j, sorted) whose AABBs, grown by `margin` on every side, overlap. A uniform grid with
 * cells of the median grown extent: each body goes in every cell its grown box covers, and a pair is
 * reported only from the cell holding the low corner of the two grown boxes' intersection, so once.
 * Near-linear for lattices (each cell holds a few bodies); long bodies span cells instead of growing them.
 */
function nearPairs(boxes: readonly Box[], margin: number): Array<[number, number]> {
  const n = boxes.length;
  if (n < 2) return [];
  const ext = boxes.map((b) => Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) + 2 * margin).sort((a, b) => a - b);
  const cell = Math.max(ext[n >> 1]!, 1e-9);
  const OFF = 1 << 16, K = 1 << 17;
  const ix = (x: number) => Math.floor(x / cell);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const b = boxes[i]!;
    const a0 = ix(b.lo[0] - margin), a1 = ix(b.hi[0] + margin), b0 = ix(b.lo[1] - margin), b1 = ix(b.hi[1] + margin), c0 = ix(b.lo[2] - margin), c1 = ix(b.hi[2] + margin);
    for (let x = a0; x <= a1; x++) for (let y = b0; y <= b1; y++) for (let z = c0; z <= c1; z++) {
      const key = ((x + OFF) * K + (y + OFF)) * K + (z + OFF);
      const list = grid.get(key);
      if (list) list.push(i); else grid.set(key, [i]);
    }
  }
  const out: Array<[number, number]> = [];
  for (const [key, list] of grid) {
    const cz = (key % K) - OFF, cy = (Math.floor(key / K) % K) - OFF, cx = Math.floor(key / K / K) - OFF;
    for (let s = 0; s < list.length; s++) for (let t = s + 1; t < list.length; t++) {
      const i = list[s]!, j = list[t]!, A = boxes[i]!, B = boxes[j]!;
      let near = true;
      for (let k = 0; k < 3 && near; k++) near = A.lo[k]! - margin < B.hi[k]! + margin && B.lo[k]! - margin < A.hi[k]! + margin;
      if (!near) continue;
      // The intersection's low corner is in exactly one cell: report the pair there only.
      if (ix(Math.max(A.lo[0], B.lo[0]) - margin) !== cx || ix(Math.max(A.lo[1], B.lo[1]) - margin) !== cy || ix(Math.max(A.lo[2], B.lo[2]) - margin) !== cz) continue;
      out.push(i < j ? [i, j] : [j, i]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Static checks that keep levels solvable and the solver honest, near-linear in the body count so a
 * 10k level validates in well under a second or two. The physical check (the level sits still on a
 * real engine) lives in the sim package. `engine` picks the body budget (default defaultEngineOf).
 */
export function validateLevel(c: CompiledLevel, opts: ValidateOptions = {}): Issue[] {
  const { def, meta: m } = c, h = c.frame.unit, issues: Issue[] = [];
  const engine = opts.engine ?? defaultEngineOf(def), max = ENGINE_MAX_BODIES[engine];
  if (m.n === 0) issues.push({ code: 'empty', message: 'level has no bodies' });
  if (m.n > max) issues.push({ code: 'count', message: `${m.n} bodies > ${max} (the ${engine} engine's budget)` });
  else if (engine === 'rapier' && m.n + rackBodies(def.rack.filter(isRackItem), c.arms) + IceBreaker.budget(c) > max) {
    const ice = IceBreaker.budget(c);
    issues.push({ code: 'capacity', message: `${m.n} bodies + ${rackBodies(def.rack.filter(isRackItem), c.arms)} the rack can add${ice ? ` + ${ice} ice pieces` : ''} > ${max} (the ${engine} engine's budget)` });
  }
  const size = rackSizeProblem(def.rack);
  if (size || def.par < 1 || def.par > def.rack.length) issues.push({ code: 'rack', message: `rack of ${def.rack.length} with par ${def.par}: need 1 <= par <= rack, at most ${MAX_RACK} fired items and ${MAX_PULLS} pulls${size ? ` (${size})` : ''}` });
  const fz = def.freeze === undefined ? null : freezeProblem(def.freeze);
  if (fz) issues.push({ code: 'freeze', message: fz });
  for (const message of chargeIssues(c)) issues.push({ code: 'charge', message });
  if (def.rack.includes(PLUNGER) && !(def.charges ?? []).some((ch) => (ch.arm ?? 'plunger') === 'plunger')) issues.push({ code: 'charge', message: 'the rack has a plunger, and the level no charge a plunger arms' });
  if (def.objective.kind === 'hold') {
    if (scoringOf(def) !== 'outcome') issues.push({ code: 'objective', message: 'a hold objective needs outcome scoring (a par level ends at its clear)' });
    if (m.crowns.length === 0) issues.push({ code: 'objective', message: 'a hold objective needs a crown to keep up' });
  }
  const watched = m.crowns.length + m.heritage.length;
  if (watched > MAX_WATCHED) issues.push({ code: 'watched', message: `${m.crowns.length} crowns + ${m.heritage.length} heritage = ${watched} watched bodies > ${MAX_WATCHED}: judge big structures by collapse, skyline or footprint` });

  const eps = 1e-4 * h;
  const boxes = Array.from({ length: m.n }, (_, i) => aabb(m, i));
  // One pass at the wider margin; the support relation below needs a subset of these pairs.
  const pairs = nearPairs(boxes, 0.1 * h);
  for (const [i, j] of pairs) {
    const A = boxes[i]!, B = boxes[j]!;
    const depth = Math.min(...[0, 1, 2].map((k) => Math.min(A.hi[k]!, B.hi[k]!) - Math.max(A.lo[k]!, B.lo[k]!)));
    if (depth > eps) issues.push({ code: 'overlap', message: `bodies ${i} and ${j} overlap by ${(depth / h).toFixed(3)} h`, bodies: [i, j] });
    const ratio = Math.max(m.mass[i]! / m.mass[j]!, m.mass[j]! / m.mass[i]!);
    if (ratio > 10) issues.push({ code: 'mass-ratio', message: `bodies ${i} and ${j} touch with mass ratio ${ratio.toFixed(1)} > 10`, bodies: [i, j] });
  }

  // Loose support: a body off the ground must rest on bodies whose tops meet
  // its bottom, with its centre over the bounding box of those contacts.
  // above[j] = bodies resting directly on j; below[j] = what j rests on.
  const above: number[][] = Array.from({ length: m.n }, () => []);
  const below: number[][] = Array.from({ length: m.n }, () => []);
  for (const [i, j] of pairs) {
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
    for (const j of below[i]!) {
      const B = boxes[j]!;
      x0 = Math.min(x0, Math.max(A.lo[0]!, B.lo[0]!)); x1 = Math.max(x1, Math.min(A.hi[0]!, B.hi[0]!));
      z0 = Math.min(z0, Math.max(A.lo[2]!, B.lo[2]!)); z1 = Math.max(z1, Math.min(A.hi[2]!, B.hi[2]!));
    }
    // Centre of mass of the body and everything resting on it, so a lever
    // whose own centre overhangs its supports passes if its load balances it.
    const load = carried(i);
    let mx = 0, mz = 0, mm = 0;
    for (const j of load) { mx += m.mass[j]! * m.home[3 * j]!; mz += m.mass[j]! * m.home[3 * j + 2]!; mm += m.mass[j]!; }
    const cx = mx / mm, cz = mz / mm;
    if (!(cx > x0 + eps && cx < x1 - eps && cz > z0 + eps && cz < z1 - eps)) issues.push({ code: 'unsupported', message: `body ${i} at y=${(A.lo[1]! / h).toFixed(2)} h: the centre of mass of it and its load is not over its supports`, bodies: [i] });
  }

  // Nothing to bring down: the structure's energy over lying flat is under one common block falling one h.
  if (m.n > 0) {
    let pe0 = 0, floor = 0;
    for (let i = 0; i < m.n; i++) { pe0 += peOf_mJ(m.mass[i]!, m.home[3 * i + 1]!); floor += peOf_mJ(m.mass[i]!, Math.min(m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!)); }
    const block = commonMass(m), least = peOf_mJ(block, h);
    if (pe0 - floor < least) issues.push({ code: 'flat', message: `the structure holds ${((pe0 - floor) / 1000).toFixed(1)} J over lying flat, under one ${block.toFixed(1)} kg block falling 1 h (${(least / 1000).toFixed(1)} J): nothing to bring down` });
  }

  issues.push(...rackIssues(c, engine));
  if (scoringOf(def) === 'outcome') issues.push(...launcherIssues(c));

  for (const i of m.crowns) {
    const x = m.home[3 * i]!, y = m.home[3 * i + 1]!, z = m.home[3 * i + 2]!;
    if (y < def.crownLine * h || x < c.lot.min[0] || x > c.lot.max[0] || z < c.lot.min[1] || z > c.lot.max[1]) issues.push({ code: 'crown-start', message: `crown ${i} starts already down`, bodies: [i] });
  }
  return issues;
}

/**
 * Outcome levels: every launcher position must be within 4 h of the lot, where the rules count
 * ammo as live (rules.ts ammoLive). From beyond it a shot flies uncounted, and a structure
 * quiet before the ammo arrives settles the shot before it lands (a long wall's ends, a city's
 * corners). Par levels keep their launchers: their recorded lines settle where they do.
 */
function launcherIssues(c: CompiledLevel): Issue[] {
  const grow = 4 * c.frame.unit, y = Math.round(4 * c.def.launcher.y), out: number[] = [];
  for (let az = 0; az < 720; az++) {
    const p = launcherPos(c.frame, az, y);
    if (p[0] < c.lot.min[0] - grow || p[0] > c.lot.max[0] + grow || p[2] < c.lot.min[1] - grow || p[2] > c.lot.max[1] + grow) out.push(az);
  }
  if (!out.length) return [];
  return [{ code: 'launcher', message: `${out.length} of 720 launcher azimuths (first ${out[0]! / 2} deg) are over 4 h outside the lot, where a shot is not live: it could settle before it lands; grow the lot to the launcher ring less 3 cells` }];
}

/** The most common structure body mass (ties: the lighter), for the `flat` check. */
function commonMass(m: BodyMeta): number {
  const count = new Map<number, number>();
  for (let i = 0; i < m.n; i++) count.set(m.mass[i]!, (count.get(m.mass[i]!) ?? 0) + 1);
  let best = m.mass[0]!, k = 0;
  for (const [mass, c] of count) if (c > k || (c === k && mass < best)) { best = mass; k = c; }
  return best;
}

/**
 * Most a body may travel in one step, m, on every engine: 0.8 of AVBD's sweep (maxSweep,
 * 1 m a step at its defaults, which Keystone plays at). AVBD grows each body's contact
 * margin by min(maxSweep, |v| dt), so a contact a step's travel can reach is found before
 * the step and solved as a speculative contact: under the sweep nothing tunnels, however
 * thin the body (physics-gpu engine-tunnel.test.ts, GPU and reference: a 14 cm iron ball and
 * a kicked half-metre block through a 2 cm slab, none at 45 or 57 m/s, some at 90). 0.8 m a
 * step at 60 Hz is 48 m/s, engine-api's DEFAULT_BLAST_MAX_SPEED.
 */
export const SWEEP_REACH = 0.8;

/**
 * The rack's per-item checks: every name is an item and every weapon resolves; no item,
 * nor a body a weapon kicks, outruns the engine's contact search in one step (tunnelling:
 * SWEEP_REACH on every engine; on Rapier, whose boxes have no continuous collision, a box
 * also may not step through the thinnest body, nor a kicked body through twice it); items
 * are at most limits.ammoRatio times the lightest structure body; a dud (one head-on hit
 * cannot tip even the easiest body) is a warning.
 */
function rackIssues(c: CompiledLevel, engine: LevelEngine): Issue[] {
  const { def, meta: m } = c, h = c.frame.unit, dt = c.scene.dt, issues: Issue[] = [];
  let thin = Infinity, lightest = Infinity;
  for (let i = 0; i < m.n; i++) {
    thin = Math.min(thin, 2 * Math.min(m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!));
    lightest = Math.min(lightest, m.mass[i]!);
  }
  const ratioMax = def.limits?.ammoRatio ?? AMMO_RATIO;
  if (!(ratioMax > 0 && ratioMax <= AMMO_RATIO_MAX)) issues.push({ code: 'ammo-ratio', message: `limits.ammoRatio ${ratioMax} must be above 0 and at most ${AMMO_RATIO_MAX}` });
  // A weapon only charges name is checked as a charge (chargeIssues), not as a thrown one.
  const rackKeys = new Set(def.rack.map((x) => itemRef(x)).flatMap((r) => (r?.kind === 'weapon' ? [r.key] : [])));
  const chargeOnly = (key: string) => !rackKeys.has(key) && (def.charges ?? []).some((ch) => ch.weapon === key);
  for (const key of Object.keys(def.weapons ?? {})) {
    if (!WEAPON_KEY.test(key)) issues.push({ code: 'weapon', message: `weapons.${key}: a key is 1 to 24 lower case letters and digits, starting with a letter` });
    else if (chargeOnly(key)) continue;
    else try { levelArm(c, key); } catch (e) { issues.push({ code: 'weapon', message: `weapons.${key}: ${(e as Error).message}` }); }
  }
  const sizeOf = (s: BodyDesc['shape']) => (s.kind === 'sphere' ? 2 * s.radius : s.kind === 'box' ? 2 * Math.min(...s.half) : 0);
  // Rapier turns continuous collision on for spheres only (adapter-rapier bodies.ts): its boxes can step through.
  const tunnel = (what: string, shape: BodyDesc['shape'], v: number) => {
    const reach = v * dt, size = sizeOf(shape);
    if (reach > SWEEP_REACH) issues.push({ code: 'tunnelling', message: `${what} moves ${reach.toFixed(3)} m per step, more than the engines' contact search reaches (${SWEEP_REACH} m)` });
    else if (engine === 'rapier' && shape.kind === 'box' && reach > 0.8 * (size + thin)) issues.push({ code: 'tunnelling', message: `${what} moves ${reach.toFixed(3)} m per step, more than 0.8 x (${size.toFixed(3)} + thinnest body ${thin.toFixed(3)}) m: a box on Rapier, which has no continuous collision for boxes` });
  };
  const heavy = (what: string, mass: number) => {
    const ratio = mass / lightest;
    if (m.n > 0 && ratio > ratioMax) issues.push({ code: 'ammo-ratio', message: `${what} (${mass.toFixed(1)} kg) is ${ratio.toFixed(1)} x the lightest structure body (${lightest.toFixed(1)} kg), over ${ratioMax}` });
  };
  for (const item of new Set<string>(def.rack)) {
    const ref = itemRef(item);
    if (!ref) { issues.push({ code: 'rack', message: `rack item ${JSON.stringify(item)} is not one of ${RACK_ITEM_NAMES}` }); continue; }
    if (ref.kind === 'pull' || ref.kind === 'plunger') continue; // fires nothing: no body to tunnel, weigh or prove a dud
    let arm: Arm | null = null;
    if (ref.kind === 'weapon') {
      if (def.weapons && Object.hasOwn(def.weapons, ref.key)) { arm = c.arms[item] ?? null; if (!arm) continue; } // reported above
      else try { arm = levelArm(c, ref.key); } catch (e) { issues.push({ code: 'weapon', message: `${item}: ${(e as Error).message}` }); continue; }
    }
    const b = ammoBody(item as RackItem, c.frame, [0, 0, 0], [0, 0, 0]), mass = massOf(b);
    const v = item === 'drop' ? Math.sqrt(2 * GRAVITY * def.launcher.dropY * h) : speedOf(item as RackItem, 100, c.frame);
    tunnel(item, b.shape, v);
    heavy(item, mass);
    if (arm) {
      // A weapon's children (each at its speed bound: the shell's top speed plus the spreads that threw it) and its blasts' kicks.
      for (const x of arm.munitions.slice(1)) { tunnel(`${item}'s ${x.path}`, x.shape, x.speed); heavy(`${item}'s ${x.path}`, x.mass); }
      // A kick moves structure bodies (boxes) and munitions alike.
      for (const { path, blast } of arm.blasts) {
        const what = `${item}'s blast${arm.blasts.length > 1 ? ` (${path})` : ''} can kick a body to ${blast.maxSpeed} m/s, ${(blast.maxSpeed * dt).toFixed(3)} m per step`;
        if (blast.maxSpeed * dt > SWEEP_REACH) issues.push({ code: 'tunnelling', message: `${what}, more than the engines' contact search reaches (${SWEEP_REACH} m)` });
        else if (engine === 'rapier' && blast.maxSpeed * dt > 0.8 * 2 * thin) issues.push({ code: 'tunnelling', message: `${what}, more than 0.8 x twice the thinnest body ${thin.toFixed(3)} m: a box on Rapier, which has no continuous collision for boxes` });
      }
    }
    if (m.n === 0) continue;
    if (!arm && item !== 'drop' && isDud(c, mass, 0.5 * mass * v * v)) issues.push({ code: 'dud', warning: true, message: `${item}: one head-on hit at full power (${(0.5 * mass * v * v).toFixed(0)} J) cannot tip any structure body` });
  }
  return issues;
}

/**
 * Whether a thing of `mass` and kinetic energy `ke` cannot tip any structure body in
 * one head-on hit: the most an elastic head-on collision passes, ke x 4 mu / (1 + mu)^2
 * (mu = mass / the body's), is under the energy to roll the body over its nearer bottom
 * edge, m g (sqrt(a^2 + hy^2) - hy) for half-extents a (the smaller horizontal) and hy
 * (0.207 m g h for a cube of edge h).
 */
export function isDud(c: CompiledLevel, mass: number, ke: number): boolean {
  const m = c.meta;
  for (let i = 0; i < m.n; i++) {
    const a = Math.min(m.half[3 * i]!, m.half[3 * i + 2]!), hy = m.half[3 * i + 1]!, mb = m.mass[i]!;
    const mu = mass / mb, passed = (ke * 4 * mu) / ((1 + mu) * (1 + mu));
    if (passed >= mb * GRAVITY * (Math.hypot(a, hy) - hy)) return false;
  }
  return true;
}

export const roleName = (id: number): Role | 'ammo' => ROLES[id] ?? 'ammo';
