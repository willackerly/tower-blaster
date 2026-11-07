// Chorus (roadmap M9, docs/game/chorus.md): the player's one shot is fired into
// K copies of a small level at once, each jittered by a hair, and the score is
// how many of the K clear. It runs on C10's islands (engine-api islands.ts,
// docs/design/islands.md): the K worlds are islands of one scene, so they cost
// about one scene of K times the bodies, not K engines.
//
// The seam is an engine. ChorusEngine is a PhysicsEngine that wraps the real one
// and shows the Driver, the rules and the renderer world 0 only (its ids, its
// coordinates), while every step solves all K worlds. Everything pushed into it
// (the shot's spawn, a pull's removal) goes into every world, nudged per world
// for k >= 1 (the aim tremor). So the game plays a Chorus level with no change to
// its loop: world 0 is the hero world, framed and scored as usual, and the other
// worlds are read through judge() for the grid and the score.
//
// What only statistics may depend on (islands.md, section 6): a world in an
// islands run is not bit for bit its solo run once bodies touch, so Chorus scores
// the fraction of worlds cleared, never one world. The verify (nodes.json M9) is
// that the per-world outcomes match K solo runs (two-sample KS, p > 0.05): the
// solo run of world k is the same engine with `only: k` (chorus-verify.test.ts on
// Rapier, mode-probes M9 on the GPU).
//
// Per-world outcomes are counted in the observer's arithmetic (engine-api
// observe.ts reduceRef, one histogram by island per question), not in f64, so the
// islands run, the solo runs and a native GPU observer later all count alike. The
// thresholds sit off resting heights: a crown is down below the level's crown line
// (2 h on every level here, where cube centres rest at whole cells plus 0.5 h), and
// a body has moved past DISPLACED (0.5 h, a slide), never at a one-layer drop.
import {
  type EngineCheckpoint, type EngineHealth, type EngineInfo, type InputEvent, Islands, islandSpec, type PhysicsEngine,
  type Pred, type Quat, quant, reduceRef, type SceneDesc, type Snapshot, type StepReport, type Vec3,
} from '@tb/engine-api';
import { forkDeep } from './fork.ts';
import { materialId } from './materials.ts';
import { type CompiledLevel, type Issue, type LevelDef } from './level.ts';
import { DISPLACED, floorTotal, heritageBroken, type LevelScore, QUIET_SPEED, QUIET_SPIN, SETTLE_QUIET, settleAllowance, type ScoreLine } from './rules.ts';
import { ROLE_ID } from './level.ts';

/** Worlds when a level's chorus block does not say (the roadmap's 64: 100 bodies x 64 = 6.4k, real time on the M5). */
export const CHORUS_WORLDS = 64;

/**
 * How much each world k >= 1 differs from world 0 ("a hair"). World 0 is the level exactly as a solo
 * play of it, so the hero world is the level the player knows.
 * - pos: each structure body moved on x and z by up to this, in h (uniform). 0.004 h is 2 mm on a
 *   0.5 m cube: a fifth of the 0.02 h lattice gap, so two neighbours jittered towards each other
 *   still leave 0.012 h between them.
 * - yaw: each structure body turned about y by up to this, degrees, and never so far that its corners
 *   move more than `pos` (long slabs and rods turn less).
 * - aim: each fired body's velocity turned in yaw by up to this, degrees.
 * - pitch: and raised or lowered by up to this, degrees.
 * - power: its speed scaled by 1 plus up to this (fraction).
 * The shot's three are the hand noise the casting bot's robustness gate already plays (keystone-lab
 * cast.ts nudgeLine: yaw +-0.6 degrees, power +-3 %; the bot nudges no pitch, so pitch is a hair), so a
 * shot that clears most worlds here is the shot the gate calls robust there. A hair of aim (0.1 degrees,
 * 1 %) splits Rapier's worlds but not the GPU solver's, which is far less chaotic: on L1 and L5 every one
 * of 16 GPU worlds ended the same way (docs/game/chorus.md, "The jitter").
 */
export interface ChorusJitter { pos?: number; yaw?: number; aim?: number; pitch?: number; power?: number }
export const CHORUS_JITTER: Required<ChorusJitter> = { pos: 0.004, yaw: 0.2, aim: 0.6, pitch: 0.1, power: 0.03 };

/** A level's Chorus block (LevelDef.chorus): the level plays as Chorus, one shot into `worlds` worlds. */
export interface ChorusDef {
  /** Worlds (CHORUS_WORLDS); 2 to 256. */
  worlds?: number;
  jitter?: ChorusJitter;
  /** The jitter's seed (default 1): part of the level, so every play of it meets the same worlds. */
  seed?: number;
  /**
   * Worlds that must clear for one, two and three stars (default CHORUS_STAR_FRACTIONS of `worlds`, rounded up).
   * Non-decreasing, each from 1 to `worlds`.
   */
  stars?: [number, number, number];
  /** Crowns down that clear a world (default every crown): one shot rarely downs every crown of a level made for several. */
  need?: number;
}

/**
 * The stars' default thresholds, as fractions of the worlds: a star for a shot that clears more worlds
 * than not, two for three in four, three for fifteen in sixteen (60 of 64: a shot that fails only where
 * the world is unlucky). Fixed, not cast: the count is already a distribution (docs/game/chorus.md).
 */
export const CHORUS_STAR_FRACTIONS = [1 / 2, 3 / 4, 15 / 16] as const;

/** A chorus block with every default filled in (chorusOf). */
export interface ResolvedChorus { worlds: number; jitter: Required<ChorusJitter>; seed: number; stars: [number, number, number]; need: number | null }

/** The level's chorus block with its defaults filled in; null for a level that is not Chorus. */
export function chorusOf(d: LevelDef): ResolvedChorus | null {
  const ch = d.chorus;
  if (!ch) return null;
  const K = ch.worlds ?? CHORUS_WORLDS;
  return {
    worlds: K,
    jitter: { ...CHORUS_JITTER, ...ch.jitter },
    seed: ch.seed ?? 1,
    stars: ch.stars ?? (CHORUS_STAR_FRACTIONS.map((f) => Math.ceil(f * K)) as [number, number, number]),
    need: ch.need ?? null,
  };
}

/** Why a level cannot play as Chorus (validateLevel adds these as issues, with its bodies' materials). */
export function chorusIssues(d: LevelDef, materials: ArrayLike<number> = []): Issue[] {
  const ch = d.chorus;
  if (!ch) return [];
  const out: Issue[] = [];
  const bad = (message: string) => out.push({ code: 'chorus', message });
  const K = ch.worlds ?? CHORUS_WORLDS;
  if (!(Number.isInteger(K) && K >= 2 && K <= 256)) bad(`chorus.worlds must be a whole number from 2 to 256, got ${K}`);
  for (const [k, v] of Object.entries(ch.jitter ?? {})) {
    if (!(k in CHORUS_JITTER)) bad(`chorus.jitter.${k} is not a jitter (${Object.keys(CHORUS_JITTER).join(', ')})`);
    else if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) bad(`chorus.jitter.${k} must be a number >= 0, got ${v}`);
  }
  const j = { ...CHORUS_JITTER, ...ch.jitter };
  if (j.pos > 0.009) bad(`chorus.jitter.pos ${j.pos} h could close the 0.02 h lattice gap between two neighbours (at most 0.009)`);
  if (ch.seed !== undefined && !(Number.isInteger(ch.seed) && ch.seed >= 0)) bad(`chorus.seed must be a whole number >= 0, got ${ch.seed}`);
  if (ch.stars !== undefined) {
    const s = ch.stars;
    if (!(Array.isArray(s) && s.length === 3 && s.every((t) => Number.isInteger(t) && t >= 1 && t <= K) && s[0] <= s[1] && s[1] <= s[2])) bad(`chorus.stars must be three non-decreasing whole numbers from 1 to ${K}, got ${JSON.stringify(s)}`);
  }
  // One shot, fired the same way into every world. Anything that decides from the observed state (a weapon's fuse
  // or proximity, ice breaking, charges) would decide from world 0 alone and act in all: refused until an arsenal
  // per world exists (docs/game/chorus.md, alternatives).
  if (d.rack.length !== 1) bad(`a Chorus level fires one shot: its rack holds ${d.rack.length} items`);
  for (const item of d.rack) if (item.startsWith('w-') || item === 'plunger') bad(`Chorus fires ${item}, whose weapon decides from world 0's state; only balls, drops and pulls fire the same into every world`);
  if (d.charges?.length) bad('Chorus levels carry no charges (they decide from world 0\'s state)');
  if (Array.prototype.includes.call(materials, materialId('ice'))) bad('Chorus levels have no ice (the Driver cracks and shatters it from world 0\'s state)');
  if (d.objective.kind !== 'crowns') bad(`Chorus judges crowns down per world, not ${d.objective.kind}`);
  if (ch.need !== undefined && !(Number.isInteger(ch.need) && ch.need >= 1)) bad(`chorus.need must be a whole number >= 1, got ${ch.need}`);
  if (d.build) bad('Chorus levels have no build phase');
  if (d.freeze !== undefined) bad('Chorus levels have no Bullet Time budget');
  return out;
}

// ---- The worlds ----

/** mulberry32: a small, exact, seeded generator (the same numbers on every machine). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stream of uniform numbers in [-1, 1) for world k's `what` (0 the structure, 1 + i the i-th spawn), from the level's seed. */
function stream(seed: number, k: number, what: number): () => number {
  const r = rng(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77) ^ Math.imul(what + 1, 0xc2b2ae3d));
  return () => 2 * r() - 1;
}

/** q turned by `deg` degrees about the world y axis (yaw(deg) * q). */
function yawed(q: Quat, deg: number): Quat {
  const a = (deg * Math.PI) / 360, s = Math.sin(a), c = Math.cos(a), [x, y, z, w] = q;
  return [c * x + s * z, c * y + s * w, c * z - s * x, c * w - s * y];
}

/**
 * The K worlds of a Chorus level (or of `scene`, its compiled scene): world 0 is the scene as given;
 * world k >= 1 has every structure body that is not pinned moved and turned by the jitter, from the
 * level's seed. Exact and seeded: the same worlds on every machine.
 */
export function chorusWorlds(c: CompiledLevel, scene: SceneDesc = c.scene): SceneDesc[] {
  const ch = chorusOf(c.def);
  if (!ch) throw new Error(`chorusWorlds: level ${c.def.id} has no chorus block`);
  return Array.from({ length: ch.worlds }, (_, k) => chorusWorld(c, k, scene));
}

/** World k of a Chorus level (chorusWorlds), on its own. */
export function chorusWorld(c: CompiledLevel, k: number, scene: SceneDesc = c.scene): SceneDesc {
  const ch = chorusOf(c.def)!;
  if (k === 0) return scene;
  const h = c.frame.unit, r = stream(ch.seed, k, 0), j = ch.jitter;
  const bodies = scene.bodies.map((b, i) => {
    // Draw for every body, pinned or not, so one body's jitter never depends on another's being pinned.
    const dx = r() * j.pos * h, dz = r() * j.pos * h, u = r();
    if (b.pinned || i >= c.meta.n) return b;
    // Turn at most so far that the corners move no more than pos: a long body turns less than a cube.
    const reach = b.shape.kind === 'sphere' ? Infinity : Math.hypot(b.shape.half[0], b.shape.half[2]);
    const yawMax = Math.min(j.yaw, ((j.pos * h) / reach) * (180 / Math.PI));
    return { ...b, pos: [b.pos[0] + dx, b.pos[1], b.pos[2] + dz] as Vec3, rot: yawed(b.rot, u * yawMax) };
  });
  return { ...scene, id: `${scene.id}~${k}`, bodies };
}

/** A spawn's velocity (or a drop's place) as fired into world k: turned and scaled by the aim jitter, from the level's seed and the spawn's index. */
function nudgeEvent(c: CompiledLevel, ev: InputEvent, k: number, spawnIndex: number): InputEvent {
  if (k === 0 || ev.kind !== 'spawn') return ev;
  const ch = chorusOf(c.def)!, r = stream(ch.seed, k, 1 + spawnIndex), j = ch.jitter;
  const yaw = r() * j.aim, pitch = r() * j.pitch, scale = 1 + r() * j.power, dx = r() * j.pos * c.frame.unit, dz = r() * j.pos * c.frame.unit;
  const v = ev.body.linVel;
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (speed === 0) return { ...ev, body: { ...ev.body, pos: [ev.body.pos[0] + dx, ev.body.pos[1], ev.body.pos[2] + dz] } }; // a drop: moved, as a block is
  // Turn about y by yaw, then raise by pitch in the vertical plane of the turned direction.
  const a = (yaw * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const hx = ca * v[0] + sa * v[2], hz = -sa * v[0] + ca * v[2], hor = Math.hypot(hx, hz);
  const el = Math.atan2(v[1], hor) + (pitch * Math.PI) / 180, s = speed * scale;
  const ux = hor > 0 ? hx / hor : 0, uz = hor > 0 ? hz / hor : 0;
  return { ...ev, body: { ...ev.body, linVel: [s * Math.cos(el) * ux, s * Math.sin(el), s * Math.cos(el) * uz] } };
}

// ---- Reading the worlds ----

/** Tag word 1 of a chorus run: what a body is (word 0 holds its island). */
export const CHORUS_TAG = { structure: 1, crown: 2 } as const;
const S_DOWN = 16, S_MOVED = 15;

/**
 * The questions asked of every world, as observer predicates (one histogram by island each):
 * crowns down (below the crown line, or outside the lot, as rules.ts crownDown) and structure bodies
 * moved more than DISPLACED h since the shot. Ref slot 0 holds the pose at the shot; slot 1 holds each
 * body's island offset, so { disp: 1 } is its position in its own world's coordinates.
 */
export function chorusPreds(c: CompiledLevel): Pred[] {
  const h = c.frame.unit, q = (x: number, s: number) => quant(x, s)!;
  const tag = (bit: number): Pred => ({ cmp: { tag: 1, shift: Math.log2(bit), bits: 1 }, op: '==', k: 1 });
  const local = (axis: 0 | 2) => ({ comp: { disp: 1 }, axis, s: S_DOWN }) as const;
  const crownDown: Pred = {
    and: [tag(CHORUS_TAG.crown), {
      or: [
        { cmp: { comp: 'pos', axis: 1, s: S_DOWN }, op: '<', k: q(c.def.crownLine * h, S_DOWN) },
        { cmp: local(0), op: '<', k: q(c.lot.min[0], S_DOWN) }, { cmp: local(0), op: '>', k: q(c.lot.max[0], S_DOWN) },
        { cmp: local(2), op: '<', k: q(c.lot.min[1], S_DOWN) }, { cmp: local(2), op: '>', k: q(c.lot.max[1], S_DOWN) },
      ],
    }],
  };
  const moved: Pred = { and: [tag(CHORUS_TAG.structure), { cmp: { norm2: { disp: 0 }, s: S_MOVED }, op: '>', k: Math.floor((DISPLACED * h * 2 ** S_MOVED) ** 2) }] };
  return [crownDown, moved];
}

/** Every world's outcome: what the grid draws and the score counts. */
export interface ChorusJudgement {
  /** Engine steps the state was read at. */
  step: number;
  worlds: number;
  /** Per world: cleared, every crown down (or the level's chorus.need of them) with every heritage block intact. */
  cleared: boolean[];
  /** Per world: heritage blocks broken (rules.ts heritageBroken, in f64 on the world's own pose: 0.3 h moved or 15 degrees turned, far off any resting pose). */
  heritage: number[];
  /** Per world: crowns down, and the share of structure bodies moved more than DISPLACED h since the shot. */
  crownsDown: number[];
  moved: number[];
  crowns: number;
  /** Crowns down that clear a world. */
  need: number;
  /** Worlds cleared. */
  clears: number;
  /** Bodies outside their island's cell (Islands.leaks): a run with any may have let two worlds touch. */
  leaks: number;
}

/** The judgement of one world from its counts. */
function judged(c: CompiledLevel, step: number, crownsDown: number[], movedCount: number[], heritage: number[], leaks: number): ChorusJudgement {
  const crowns = c.meta.crowns.length, n = c.meta.n, need = Math.min(crowns, chorusOf(c.def)?.need ?? crowns);
  const cleared = crownsDown.map((d, k) => crowns > 0 && d >= need && heritage[k] === 0);
  return { step, worlds: crownsDown.length, cleared, heritage, crownsDown, moved: movedCount.map((m) => m / Math.max(1, n)), crowns, need, clears: cleared.filter(Boolean).length, leaks };
}

// ---- The engine ----

export interface ChorusEngineOptions {
  /**
   * Run world k alone at the origin instead of all K (its jitter and aim nudges as in the chorus): the solo run the
   * verify compares the islands with. judge() then reads that one world.
   */
  only?: number;
}

/** The engine a Chorus round needs from the Driver (driver.ts): a settle hold and the round's judgement. */
export interface ChorusRound {
  /** Some world other than world 0 is still moving: the round's settle waits (bounded by the settle rule's cap). */
  settleHold(): boolean;
  judge(): ChorusJudgement;
}

/**
 * K worlds of a Chorus level as islands of one engine, shown as world 0 (see the header). Built per level load
 * (game engines.ts makeEngine wraps the GPU or Rapier engine in one for a level with a chorus block).
 */
export class ChorusEngine implements PhysicsEngine, ChorusRound {
  readonly info: EngineInfo;
  readonly worlds: number;
  private isl!: Islands;
  /** The newest full state read back (every world), and the step it holds. */
  private last: Snapshot | null = null;
  private lastStep = 0;
  /** Every body's pose when the first input went in (the shot): what `moved` is measured from. */
  private ref: Float64Array | null = null;
  /** Every body's island offset (ref slot 1), grown as spawns are released. */
  private origins = new Float64Array(0);
  /** Spawns pushed so far, numbering each one's aim nudge. */
  private spawnsPushed = 0;
  /** Consecutive reads with every world quiet, since the shot. */
  private quiet = 0;
  /** Bodies removed at the fence (global ids). */
  private fenced = new Set<number>();

  constructor(readonly inner: PhysicsEngine, readonly level: CompiledLevel, private readonly opts: ChorusEngineOptions = {}) {
    const ch = chorusOf(level.def);
    if (!ch) throw new Error(`ChorusEngine: level ${level.def.id} has no chorus block`);
    if (opts.only !== undefined && !(Number.isInteger(opts.only) && opts.only >= 0 && opts.only < ch.worlds)) throw new RangeError(`ChorusEngine: only must be a world from 0 to ${ch.worlds - 1}, got ${opts.only}`);
    this.worlds = opts.only === undefined ? ch.worlds : 1;
    this.info = { ...inner.info, variant: { ...inner.info.variant, chorus: ch.worlds, ...(opts.only !== undefined ? { chorusOnly: opts.only } : {}) } };
  }

  /** The world island i plays: i, or the one world asked for. */
  private worldOf(i: number): number { return this.opts.only ?? i; }

  get stepIndex(): number { return this.inner.stepIndex; }
  get islands(): Islands { return this.isl; }

  async init(scene: SceneDesc): Promise<void> {
    const worlds = this.opts.only !== undefined ? [chorusWorld(this.level, this.opts.only, scene)] : chorusWorlds(this.level, scene);
    // Room for the shot: the launcher stands outside the structure, so the cell must hold it and the ball's flight.
    const f = this.level.frame, launcher = Math.hypot(f.centre[0], f.centre[1]) + (f.launcher.radius + 2) * f.unit;
    const base = new Islands(worlds);
    this.isl = launcher > base.extent ? new Islands(worlds, { gap: Math.ceil(2 * (launcher + 24)) }) : base;
    this.last = null;
    this.ref = null;
    this.spawnsPushed = 0;
    this.quiet = 0;
    this.lastStep = 0;
    this.fenced = new Set();
    await this.inner.init(this.isl.scene);
  }

  /** Inputs in world 0's ids and coordinates: into every world, each nudged by its aim jitter. */
  push(events: InputEvent[]): void {
    if (!events.length) return;
    // The first input is the shot: every world's pose then is what `moved` is measured from.
    if (!this.ref && this.last) this.ref = this.last.pos.slice(0, 3 * this.last.count);
    const first = this.spawnsPushed;
    this.spawnsPushed += events.filter((e) => e.kind === 'spawn').length;
    for (let i = 0; i < this.isl.K; i++) {
      let s = first;
      this.isl.push(i, events.map((e) => nudgeEvent(this.level, e, this.worldOf(i), e.kind === 'spawn' ? s++ : s)));
    }
  }

  step(): StepReport | void | Promise<StepReport | void> {
    const due = this.isl.due(this.inner.stepIndex);
    if (due.length) this.inner.push(due);
    return this.inner.step();
  }

  /** World 0's state (its ids, its coordinates); every world's is kept for judge() and the settle hold. */
  snapshot(): Promise<Snapshot> {
    const step = this.inner.stepIndex;
    return Promise.resolve(this.inner.snapshot()).then((s) => {
      this.read(s, step);
      return this.isl.local(s, 0);
    });
  }

  private read(s: Snapshot, step: number): void {
    if (step < this.lastStep) return; // an older read resolving late (a pipelined driver) never replaces a newer one
    this.last = s;
    this.lastStep = step;
    this.fence(s, step);
    if (!this.ref) return;
    // Quiet as settle v1 counts it, per world, structure only: at most settleAllowance(n) bodies awake and moving.
    const n = this.level.meta.n, allow = settleAllowance(n), K = this.isl.K;
    let quiet = true;
    for (let k = this.opts.only === undefined ? 1 : 0; k < K && quiet; k++) {
      const ids = this.isl.idsOf(k);
      let moving = 0;
      for (let i = 0; i < n; i++) {
        const id = ids[i]!;
        if (id >= s.count || !s.awake[id]) continue;
        const v = Math.hypot(s.linVel[3 * id]!, s.linVel[3 * id + 1]!, s.linVel[3 * id + 2]!), w = Math.hypot(s.angVel[3 * id]!, s.angVel[3 * id + 1]!, s.angVel[3 * id + 2]!);
        if (v > QUIET_SPEED || w > QUIET_SPIN) moving++;
      }
      if (moving > allow) quiet = false;
    }
    this.quiet = quiet ? this.quiet + 1 : 0;
  }

  /**
   * How far from its world's origin a body may go, m, on x or z, before it is removed: the island's half cell less
   * 4 m (two steps at the 48 m/s blast speed cap, with room). A ball that misses rolls on forever on the frictionless
   * plane (no rolling resistance) and would reach the next island; a body that far out never comes back to its
   * structure, so removing it changes no outcome. The same rule holds in a solo run (`only`), so both arms of the
   * verify play by it.
   */
  get fenceAt(): number { return this.isl.half - 4; }

  private fence(s: Snapshot, step: number): void {
    const r = this.fenceAt;
    for (let id = 0; id < s.count; id++) {
      if (this.fenced.has(id)) continue;
      const k = this.isl.islandOf(id), o = this.isl.offsets[k]!;
      if (Math.max(Math.abs(s.pos[3 * id]! - o[0]), Math.abs(s.pos[3 * id + 2]! - o[2])) <= r) continue;
      this.fenced.add(id);
      this.isl.push(k, [{ kind: 'remove', step, id: this.isl.localOf(id) }]); // due at the next step()
    }
  }

  /** World k's state as of the newest read, in its own ids and coordinates (the game's thumbnails); null before any read. */
  worldState(k: number): Snapshot | null {
    return this.last ? this.isl.local(this.last, k) : null;
  }

  /** The shot has gone in (judge() measures `moved` from then). */
  get fired(): boolean { return this.ref !== null; }

  /** Bodies removed at the fence so far. */
  get fencedCount(): number { return this.fenced.size; }

  settleHold(): boolean {
    return this.ref !== null && this.quiet < SETTLE_QUIET;
  }

  /** Every world's outcome as of the newest read (see ChorusJudgement); before the shot, nothing has moved. */
  judge(): ChorusJudgement {
    const s = this.last;
    if (!s) throw new Error('ChorusEngine.judge: nothing read yet');
    const K = this.isl.K, n = this.level.meta.n, role = this.level.meta.role;
    const tags = new Uint32Array(2 * s.count), origins = new Float64Array(3 * s.count);
    for (let id = 0; id < s.count; id++) {
      const k = this.isl.islandOf(id), local = this.isl.localOf(id), o = this.isl.offsets[k]!;
      tags[2 * id] = k;
      tags[2 * id + 1] = local < n ? CHORUS_TAG.structure | (role[local] === ROLE_ID.crown ? CHORUS_TAG.crown : 0) : 0;
      origins.set(o, 3 * id);
    }
    this.origins = origins;
    const spec = islandSpec(K, chorusPreds(this.level), 0);
    const out = reduceRef(spec, {
      snap: s, prevLinVel: new Float64Array(0), prevCount: 0, shapes: this.isl.shapes(), tagWords: 2, tags,
      refs: [this.ref ?? s.pos.slice(0, 3 * s.count), origins], gravity: this.isl.scene.gravity, dt: this.isl.scene.dt,
    });
    // Heritage per world, in f64 as Session judges world 0: from the pose at the shot (its home in a one-shot round).
    const home = this.ref ?? s.pos;
    const heritage = Array.from({ length: K }, (_, k) => {
      const o = this.isl.offsets[k]!;
      let broken = 0;
      for (const hb of this.level.meta.heritage) {
        const id = this.isl.idOf(k, hb), p = (a: Float64Array | ArrayLike<number>, i: number) => [a[3 * i]! - o[0], a[3 * i + 1]! - o[1], a[3 * i + 2]! - o[2]] as Vec3;
        const q: Quat = [s.rot[4 * id]!, s.rot[4 * id + 1]!, s.rot[4 * id + 2]!, s.rot[4 * id + 3]!];
        if (heritageBroken(this.level, p(s.pos, id), q, p(home, id))) broken++;
      }
      return broken;
    });
    return judged(this.level, this.lastStep, [...out[0]!.bins!], [...out[1]!.bins!], heritage, this.isl.leaks(s).length);
  }

  finish(): Promise<void> { return this.inner.finish?.() ?? Promise.resolve(); }

  health(): Promise<EngineHealth> {
    if (!this.inner.health) return Promise.reject(new Error('ChorusEngine: the inner engine reports no health'));
    return this.inner.health();
  }

  checkpoint(): EngineCheckpoint {
    const inner = this.inner.checkpoint?.();
    if (!inner) throw new Error(`ChorusEngine: ${this.inner.info.name} keeps no checkpoints`);
    const saved = forkDeep({ isl: this.isl, last: this.last, lastStep: this.lastStep, ref: this.ref, spawnsPushed: this.spawnsPushed, quiet: this.quiet, fenced: this.fenced });
    return {
      step: inner.step,
      bytes: inner.bytes + (saved.last ? 2 * saved.last.pos.byteLength * 4 : 0),
      restore: () => {
        inner.restore();
        const c = forkDeep(saved);
        this.isl = c.isl; this.last = c.last; this.lastStep = c.lastStep; this.ref = c.ref; this.spawnsPushed = c.spawnsPushed; this.quiet = c.quiet; this.fenced = c.fenced;
      },
      dispose: () => inner.dispose(),
    };
  }

  dispose(): void { this.inner.dispose(); }
}

/** The engine's Chorus round when it plays one (the Driver's settle hold and rescore). */
export const chorusRound = (e: PhysicsEngine): ChorusRound | null => (e instanceof ChorusEngine ? e : null);

// ---- The score ----

/** The tally's weight (one table, as outcome.ts OUTCOME_WEIGHTS): 3000 for every world cleared, pro rata. */
export const CHORUS_WEIGHTS = { clears: 3000 } as const;

/**
 * A Chorus round's score: the share of worlds cleared, with stars at the level's thresholds on the count
 * (chorusOf: by default 32, 48 and 60 of 64). Distribution-scored, so no cast: the count already is one.
 * One line, so 0 of 64 scores 0 (no partial credit for crowns in worlds that did not clear: the count is the
 * game). `hero` is the score Session made of world 0: its leverage is kept as information only (no gold badge,
 * no tier: the card hides them for a score with `worlds`). Heritage costs nothing here directly: a world whose
 * heritage cracked does not clear. Agreed with the scores thread (docs/game/chorus.md, scoring).
 */
export function chorusScore(c: CompiledLevel, j: ChorusJudgement, hero: Pick<LevelScore, 'leverage'>): LevelScore & { worlds: NonNullable<LevelScore['worlds']> } {
  const t = chorusOf(c.def)!.stars, K = j.worlds;
  const lines: ScoreLine[] = [{ label: `Worlds cleared (${j.clears} of ${K})`, value: Math.floor((CHORUS_WEIGHTS.clears * j.clears) / K) }];
  const stars = (j.clears >= t[2] ? 3 : j.clears >= t[1] ? 2 : j.clears >= t[0] ? 1 : 0) as 0 | 1 | 2 | 3;
  return { lines, total: floorTotal(lines), stars, stamp: `${j.clears}/${K} CLEAR`, leverage: hero.leverage, gold: false, worlds: { cleared: j.clears, of: K, thresholds: t } };
}
