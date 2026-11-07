// What the rules measure, as pure functions of body state. Everything here is
// either a reduction over all bodies (counts, sums, histograms: the shape a
// GPU reduce() will take at 100k bodies) or a read of a few watched bodies
// (crowns, heritage, live ammo). Integer fields are exact so a GPU version can
// be checked bit for bit against this one.
import type { Quat, Snapshot, Vec3 } from '@tb/engine-api';
import { quatAngle } from '@tb/geom';
import { GRAVITY, MATERIALS } from './materials.ts';
import type { CompiledLevel, LevelDef } from './level.ts';

export const HEIGHT_BINS = 64;
export const BANDS = 8;
/** Velocity change in one step (beyond gravity) that counts as an impact, m/s. */
export const IMPACT_DV = 0.8;
/** A shot settles after this many consecutive quiet steps... */
export const SETTLE_QUIET = 30;
/** ...but never sooner than this after the spawn, and always by the cap. */
export const SETTLE_MIN = 20;
export const SETTLE_CAP = 600;
/**
 * Settle v2's cap (spectacle-mode.md, section 9): 30 s at 60 Hz. A big
 * structure's collapse runs longer than a chamber's, and its tail of a few
 * rocking blocks would otherwise hold the shot open to it every time.
 */
export const SETTLE_CAP_V2 = 1800;
/**
 * How a shot settles. v1: every awake body quiet (speed under QUIET_SPEED and,
 * for the structure, spin under QUIET_SPIN) for SETTLE_QUIET steps, or
 * SETTLE_CAP; par levels pin their lines on it. v2: at most
 * settleAllowance(n) structure bodies moving (Reductions.nMoving) and every
 * live spawned body under QUIET_SPEED, for SETTLE_QUIET steps, or
 * SETTLE_CAP_V2. v3, outcome levels' default: as v2, or else the structure is
 * frozen: nothing live (ammo included) faster than FROZEN_SPEED,
 * and the collapse D and the displaced count unchanged (D within FROZEN_D) for
 * FROZEN_STEPS steps, however many bodies still move. A standing wall can ring
 * for the whole cap with a hundred blocks swaying a few centimetres at 0.1 to
 * 0.3 m/s while nothing changes (G5's B1, 2026-11-01); v3 ends that shot, and
 * settles no later than v2 anywhere. v4 (agent playtest PT6): as v3, or else the collapse D has stayed
 * within STEADY_D of where a run began for STEADY_STEPS steps, whatever still moves: a big level's
 * shot whose Down% reads the same for seconds while debris rolls and blocks rock (B1 at 17% from 3.5 s
 * to 18.4 s on Rapier) ends 2 s after the last change anyone can see.
 */
export const SETTLE_RULES = ['v1', 'v2', 'v3', 'v4'] as const;
export type SettleRule = (typeof SETTLE_RULES)[number];
/** Structure bodies settle v2 lets still move: a few stragglers per thousand, at least 2. */
export const settleAllowance = (n: number) => Math.max(2, Math.floor(n / 1000));
export const settleCap = (rule: SettleRule) => (rule === 'v1' ? SETTLE_CAP : SETTLE_CAP_V2);
/** Settle v3's frozen structure: no live body faster than this (m/s; any fall passes it within 0.05 s), */
export const FROZEN_SPEED = 0.5;
/** for this many steps, */
export const FROZEN_STEPS = 60;
/** with the collapse D within this of where the run began (and the displaced count the same). */
export const FROZEN_D = 1e-4;
/** Settle v4's steady collapse: D within this (absolute, 0.5% of the structure's drop) of where the run began, */
export const STEADY_D = 0.005;
/** for this many steps (2 s at 60 Hz). */
export const STEADY_STEPS = 120;
export const QUIET_SPEED = 0.05; // m/s
export const QUIET_SPIN = 0.2; // rad/s
/** Displacement (in h) beyond which a body counts as moved by a shot. */
export const DISPLACED = 0.5;
/** Heritage tolerances. */
export const HERITAGE_MOVE = 0.3; // h
export const HERITAGE_TILT = (15 * Math.PI) / 180;

export interface Baseline { step: number; pos: Float64Array; pe_mJ: number }

export interface Reductions {
  step: number;
  /** Awake bodies, not counting ammo that has rolled away or come to rest on the ground. */
  nAwake: number;
  maxSpeed: number;
  /**
   * Over awake structure bodies only. Live ammo counts by its speed: a ball
   * rolling slowly on a level top spins above QUIET_SPIN (0.24 rad/s at 1.4
   * cm/s for a 0.1 m marble) and would hold a shot open to the cap, while the
   * spin of a ball alone moves nothing.
   */
  maxAngSpeed: number;
  /** Potential energy of the structure, sum of round(m g y * 1000) in index order. */
  pe_mJ: number;
  /** Structure bodies more than DISPLACED h from the shot baseline. */
  displaced: number;
  /** Structure bodies whose centre is outside the lot grown by 0.5 h. */
  outOfLot: number;
  /** Structure bodies by the top of their world AABB, over [0, level height]. */
  heightHist: Uint32Array;
  /** Impacts this step by material (6) x home height band (8). */
  impacts: Uint32Array;
  /** Awake structure bodies moving faster than QUIET_SPEED or spinning faster than QUIET_SPIN (settle v2, the tail skip). */
  nMoving: number;
  /**
   * The box around the centres of those bodies, [min x, y, z, max x, y, z] in metres (the collapse-front
   * camera); +Infinity mins and -Infinity maxes when nothing moves. Min and max are exact in any order.
   */
  movingBox: Float64Array;
  /**
   * The fastest live spawned body (ammo, a weapon's children: index n and up, counted as for nAwake),
   * m/s; 0 when none is awake. Settle v2 waits for it: a ball still in flight moves no structure body.
   */
  ammoSpeed: number;
}

export interface Watched { idx: Int32Array; pos: Float64Array; rot: Float64Array; linVel: Float64Array }

export interface Observation { step: number; red: Reductions; watched: Watched; basePe_mJ: number }

const get3 = (a: ArrayLike<number>, i: number): Vec3 => [a[3 * i]!, a[3 * i + 1]!, a[3 * i + 2]!];
const get4 = (a: ArrayLike<number>, i: number): Quat => [a[4 * i]!, a[4 * i + 1]!, a[4 * i + 2]!, a[4 * i + 3]!];

/** Integer millijoules for one body: identical however the sum is ordered. */
export const peOf_mJ = (mass: number, y: number) => Math.round(mass * GRAVITY * y * 1000);

export function potential_mJ(s: Snapshot, c: CompiledLevel): number {
  let pe = 0;
  for (let i = 0; i < c.meta.n; i++) pe += peOf_mJ(c.meta.mass[i]!, s.pos[3 * i + 1]!);
  return pe;
}

export function baselineOf(s: Snapshot, c: CompiledLevel, step: number): Baseline {
  return { step, pos: s.pos.slice(0, 3 * c.meta.n), pe_mJ: potential_mJ(s, c) };
}

/** Top of the world AABB of a box with half-extents `half` rotated by q. */
export function aabbTop(y: number, q: Quat, half: Vec3): number {
  const [x, yy, z, w] = q;
  const r10 = 2 * (x * yy + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (yy * z - w * x);
  return y + Math.abs(r10) * half[0] + Math.abs(r11) * half[1] + Math.abs(r12) * half[2];
}

export function outsideLot(c: CompiledLevel, x: number, z: number, grow = 0): boolean {
  return x < c.lot.min[0] - grow || x > c.lot.max[0] + grow || z < c.lot.min[1] - grow || z > c.lot.max[1] + grow;
}

/** Whether ammo body i still matters for settling: in range and not resting on the ground. */
export function ammoLive(c: CompiledLevel, s: Snapshot, i: number): boolean {
  const h = c.frame.unit;
  return !outsideLot(c, s.pos[3 * i]!, s.pos[3 * i + 2]!, 4 * h) && s.pos[3 * i + 1]! >= 0.6 * h;
}

/**
 * Whether a shot's ammo is still in flight: it has made no contact yet (Session: its velocity has not
 * left free flight), it is moving (QUIET_SPEED or faster) and its centre is above `rest`, the highest
 * it can sit on the ground (a sphere's radius, a box's half diagonal), by more than 0.05 h. The last two
 * end a flight whose landing was too soft to read as a contact (a slow roll-off, a grazing touchdown).
 */
export function ammoInFlight(c: CompiledLevel, contact: boolean, y: number, speed: number, rest: number): boolean {
  return !contact && speed >= QUIET_SPEED && y > rest + 0.05 * c.frame.unit;
}

export function reduceCpu(s: Snapshot, prevLinVel: Float64Array | null, c: CompiledLevel, base: Baseline, step: number): Reductions {
  const { meta: m } = c, h = c.frame.unit, dt = c.scene.dt;
  const r: Reductions = {
    step, nAwake: 0, maxSpeed: 0, maxAngSpeed: 0, pe_mJ: 0, displaced: 0, outOfLot: 0, heightHist: new Uint32Array(HEIGHT_BINS), impacts: new Uint32Array(MATERIALS.length * BANDS),
    nMoving: 0, movingBox: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity), ammoSpeed: 0,
  };
  const top = Math.max(c.height, 1e-9);
  for (let i = 0; i < s.count; i++) {
    const structure = i < m.n;
    if (!structure && !ammoLive(c, s, i)) continue;
    if (s.awake[i]) {
      r.nAwake++;
      const v = Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!);
      r.maxSpeed = Math.max(r.maxSpeed, v);
      if (!structure) r.ammoSpeed = Math.max(r.ammoSpeed, v);
      if (structure) {
        const w = Math.hypot(s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!);
        r.maxAngSpeed = Math.max(r.maxAngSpeed, w);
        if (v > QUIET_SPEED || w > QUIET_SPIN) {
          r.nMoving++;
          for (let k = 0; k < 3; k++) {
            const x = s.pos[3 * i + k]!;
            r.movingBox[k] = Math.min(r.movingBox[k]!, x);
            r.movingBox[3 + k] = Math.max(r.movingBox[3 + k]!, x);
          }
        }
      }
    }
    if (!structure) continue;
    const x = s.pos[3 * i]!, y = s.pos[3 * i + 1]!, z = s.pos[3 * i + 2]!;
    r.pe_mJ += peOf_mJ(m.mass[i]!, y);
    const dx = x - base.pos[3 * i]!, dy = y - base.pos[3 * i + 1]!, dz = z - base.pos[3 * i + 2]!;
    if (dx * dx + dy * dy + dz * dz > (DISPLACED * h) ** 2) r.displaced++;
    if (outsideLot(c, x, z, 0.5 * h)) r.outOfLot++;
    const t = aabbTop(y, get4(s.rot, i), get3(m.half, i));
    r.heightHist[Math.max(0, Math.min(HEIGHT_BINS - 1, Math.floor((HEIGHT_BINS * t) / top)))]!++;
    if (prevLinVel && 3 * i + 2 < prevLinVel.length) {
      const ex = s.linVel[3 * i]! - prevLinVel[3 * i]!, ey = s.linVel[3 * i + 1]! - (prevLinVel[3 * i + 1]! - GRAVITY * dt), ez = s.linVel[3 * i + 2]! - prevLinVel[3 * i + 2]!;
      // A body that just fell asleep reads as stopping; only awake bodies count.
      if (s.awake[i] && ex * ex + ey * ey + ez * ez > IMPACT_DV * IMPACT_DV) r.impacts[m.material[i]! * BANDS + m.band[i]!]!++;
    }
  }
  return r;
}

export function watch(s: Snapshot, idx: Int32Array): Watched {
  const w: Watched = { idx, pos: new Float64Array(3 * idx.length), rot: new Float64Array(4 * idx.length), linVel: new Float64Array(3 * idx.length) };
  idx.forEach((b, k) => {
    if (b >= s.count) { w.rot[4 * k + 3] = 1; return; }
    w.pos.set(s.pos.subarray(3 * b, 3 * b + 3), 3 * k);
    w.rot.set(s.rot.subarray(4 * b, 4 * b + 4), 4 * k);
    w.linVel.set(s.linVel.subarray(3 * b, 3 * b + 3), 3 * k);
  });
  return w;
}

/**
 * Builds observations from full snapshots: the reference implementation of
 * what a GPU observer will compute with reductions and sparse reads.
 */
export class CpuObserver {
  private base: Baseline;
  private prevVel: Float64Array | null = null;
  constructor(private readonly c: CompiledLevel, initial: Snapshot) {
    this.base = baselineOf(initial, c, 0);
  }
  setBaseline(s: Snapshot, step: number) { this.base = baselineOf(s, this.c, step); }
  /**
   * observe() without moving its velocity history: the rules' view of `s` for a decision made on it
   * (a rapid-fire cut, Driver.fire), leaving the next observe() exactly as if this one had not run.
   * Its impacts count against the last observed state's velocities.
   */
  peek(s: Snapshot, step: number, watchIdx: Int32Array): Observation {
    return { step, red: reduceCpu(s, this.prevVel, this.c, this.base, step), watched: watch(s, watchIdx), basePe_mJ: this.base.pe_mJ };
  }
  get baseline() { return this.base; }
  observe(s: Snapshot, step: number, watchIdx: Int32Array): Observation {
    const red = reduceCpu(s, this.prevVel, this.c, this.base, step);
    this.prevVel = s.linVel.slice();
    return { step, red, watched: watch(s, watchIdx), basePe_mJ: this.base.pe_mJ };
  }
}

// ---- Settling ----

/** quietSince: the first step of the current quiet run. v3's frozen run: its first step and the D and displaced count there. */
export interface SettleState { quietSince: number | null; frozenSince?: number | null; frozenD?: number; frozenDisplaced?: number; steadySince?: number | null; steadyD?: number }

/** Whether one observed state counts as quiet under `rule`, for a structure of n bodies. */
export function quietUnder(rule: SettleRule, r: Reductions, n: number): boolean {
  if (r.nAwake === 0) return true;
  if (rule === 'v1') return r.maxSpeed < QUIET_SPEED && r.maxAngSpeed < QUIET_SPIN;
  return r.nMoving <= settleAllowance(n) && r.ammoSpeed < QUIET_SPEED;
}

/**
 * Whether one observed state could be part of v3's frozen run: no live body, structure or ammo, as fast as FROZEN_SPEED
 * (Reductions.maxSpeed counts both). A ram rolling on at 9 cm/s with nothing changing held a B1 shot 15 s under v2's ammo
 * rule. D and displaced are checked over the run.
 */
export const frozenCandidate = (r: Reductions): boolean => r.maxSpeed < FROZEN_SPEED;

/**
 * One step of the settle rule (v1 unless given; v2 and v3 need the structure's body count n, v3 the
 * collapse D now, Session.liveCollapse). Settled SETTLE_QUIET consecutive quiet steps in, or (v3)
 * FROZEN_STEPS frozen ones, but never before SETTLE_MIN steps after the spawn, at once when nothing
 * is awake (from SETTLE_MIN), and always at the rule's cap. `inFlight`: the shot's ammo has not yet
 * touched anything (Session: ammoInFlight), so no run counts and only the cap settles: a structure
 * at rest before the ammo arrives (asleep on Rapier, nothing awake) settled a far shot 20 steps after
 * the launch with the ball still in the air (agent playtest PT10).
 */
export function settleUpdate(st: SettleState, r: Reductions, spawnStep: number, rule: SettleRule = 'v1', n = 0, d = 0, inFlight = false): { state: SettleState; settled: boolean } {
  if (inFlight) return { state: rule === 'v4' ? { quietSince: null, frozenSince: null, steadySince: null } : rule === 'v3' ? { quietSince: null, frozenSince: null } : { quietSince: null }, settled: r.step - spawnStep >= settleCap(rule) };
  const quiet = quietUnder(rule, r, n);
  const quietSince = quiet ? (st.quietSince ?? r.step) : null;
  const old = r.step - spawnStep;
  let state: SettleState = { quietSince }, frozen = false;
  if (rule === 'v3' || rule === 'v4') {
    // A frozen run continues while nothing is fast, D stays within FROZEN_D of where it began and the displaced count holds; otherwise it starts over here.
    const keep = frozenCandidate(r) && st.frozenSince != null && Math.abs(d - st.frozenD!) <= FROZEN_D && r.displaced === st.frozenDisplaced;
    state = keep ? { quietSince, frozenSince: st.frozenSince, frozenD: st.frozenD, frozenDisplaced: st.frozenDisplaced }
      : frozenCandidate(r) ? { quietSince, frozenSince: r.step, frozenD: d, frozenDisplaced: r.displaced } : { quietSince, frozenSince: null };
    frozen = state.frozenSince != null && r.step - state.frozenSince + 1 >= FROZEN_STEPS;
  }
  if (rule === 'v4') {
    // A steady run continues while D stays within STEADY_D of where it began; otherwise it starts over here.
    const keep = st.steadySince != null && Math.abs(d - st.steadyD!) < STEADY_D;
    state.steadySince = keep ? st.steadySince : r.step;
    state.steadyD = keep ? st.steadyD : d;
    if (r.step - state.steadySince! + 1 >= STEADY_STEPS) frozen = true;
  }
  const settled = old >= settleCap(rule) || (old >= SETTLE_MIN && (r.nAwake === 0 || frozen || (quietSince !== null && r.step - quietSince + 1 >= SETTLE_QUIET)));
  return { state, settled };
}

// ---- Objectives ----

export function crownDown(c: CompiledLevel, p: Vec3): boolean {
  return p[1] < c.def.crownLine * c.frame.unit || outsideLot(c, p[0], p[2]);
}

/** Rube Lab's default for a bell objective without a region: a bell has rung once it moved a quarter h from home. */
export const BELL_MOVED = 0.25;

/**
 * Whether a bell (a crown of a bell level, docs/game/rube-lab.md) at `p` has rung: inside the objective's region,
 * or with none, at least `moved` h (BELL_MOVED) from `home`. Squared distances, so it is the same on every machine.
 */
export function bellRung(c: CompiledLevel, p: Vec3, home: Vec3): boolean {
  const o = c.def.objective, h = c.frame.unit;
  if (o.kind !== 'bell') return false;
  if (o.region) return [0, 1, 2].every((k) => p[k]! >= o.region!.min[k]! * h && p[k]! <= o.region!.max[k]! * h);
  const d = (o.moved ?? BELL_MOVED) * h;
  return (p[0] - home[0]) ** 2 + (p[1] - home[1]) ** 2 + (p[2] - home[2]) ** 2 >= d * d;
}

/** Heritage starts axis-aligned at `home`; it breaks if it moves or tilts past tolerance. */
export function heritageBroken(c: CompiledLevel, p: Vec3, q: Quat, home: Vec3): boolean {
  const h = c.frame.unit;
  return Math.hypot(p[0] - home[0], p[1] - home[1], p[2] - home[2]) > HERITAGE_MOVE * h || quatAngle(q) > HERITAGE_TILT;
}

/**
 * The 'standing' heritage rule (LevelDef.heritage, Aftershock's protected towers), judged at a settle: fallen if it
 * has dropped more than the heritage tolerance below home or tilts past it. Sideways travel does not count: a tower
 * that slid on the ground and stands, stands.
 */
export function heritageFallen(c: CompiledLevel, p: Vec3, q: Quat, home: Vec3): boolean {
  return home[1] - p[1] > HERITAGE_MOVE * c.frame.unit || quatAngle(q) > HERITAGE_TILT;
}

/** Settled height: the top of the highest histogram bin holding at least 3 bodies (strays don't count). */
export function skyline(hist: Uint32Array, height: number): number {
  for (let b = hist.length - 1; b >= 0; b--) if (hist[b]! >= 3) return ((b + 1) * height) / hist.length;
  return 0;
}

// ---- Scoring ----

export const TIER_NAMES = ['Brute', 'Clean', 'Elegant', 'Keystone'] as const;
/**
 * The tiers' floors as multiples of a level's gold line (levelGoldLine): Clean at the line, Elegant at 3x,
 * Keystone at 8x. With TIER_LINE (L5's gold line) they are the absolute floors 5, 15 and 40 the
 * tiers had before 2026-11-06, when "Brute" stood next to an earned gold badge on every other level.
 */
const TIER_STEPS = [0, 1, 3, 8] as const;
/** The line tier() measures against when given none: the old absolute floors' Clean. */
export const TIER_LINE = 5;

/**
 * Leverage: potential energy released (mJ) per joule of energy fired, J per J. The one definition:
 * a shot's is its own dPE over its own energy (ShotOutcome.leverage), a round's is roundLeverage.
 */
export const leverage = (dPE_mJ: number, ke: number) => (ke > 0 ? Math.max(0, dPE_mJ / 1000) / ke : 0);

/**
 * A round's leverage (or any set of shots'): the potential energy its shots released, each measured
 * from the state it went in on to its settle or cut, over the energy they were charged (ke + yield),
 * clamped at 0. The card (par and outcome), the gold badge, the HUD and the lot sheet's round fact all
 * read this one function (docs/game/scoring.md). One shot: its own leverage.
 */
export function roundLeverage(shots: readonly Pick<ShotOutcome, 'ke' | 'yield' | 'dPE_mJ'>[]): number {
  let released = 0;
  for (const o of shots) released += o.dPE_mJ;
  return leverage(released, energyFired(shots));
}

/** The energy fired over `shots`, J (each one's ke + yield): what roundLeverage divides by, and the energy star metric. */
export function energyFired(shots: readonly Pick<ShotOutcome, 'ke' | 'yield'>[]): number {
  let fired = 0;
  for (const o of shots) fired += o.ke + o.yield;
  return fired;
}

/** The tier of leverage L against gold line `line`: Brute under it, Clean from it, Elegant from 3x, Keystone from 8x. */
export function tierAt(L: number, line: number): 0 | 1 | 2 | 3 {
  const f = (k: 1 | 2 | 3) => line * TIER_STEPS[k];
  return L >= f(3) ? 3 : L >= f(2) ? 2 : L >= f(1) ? 1 : 0;
}
/** The tier against TIER_LINE (the old absolute floors 5, 15, 40); a level's own is levelTier. One argument, so `.map(tier)` is safe. */
export const tier = (L: number): 0 | 1 | 2 | 3 => tierAt(L, TIER_LINE);

/**
 * A level's gold line, which both names the leverage tiers and gates the gold badge, so the card can
 * never call a badge-earning round Brute: LevelDef.lGold, else DEFAULT_GOLD on a par level; null on an
 * outcome level without one (no badge there, so no tier names either).
 */
export const levelGoldLine = (def: LevelDef): number | null => def.lGold ?? ((def.scoring ?? 'par') === 'par' ? DEFAULT_GOLD : null);

/** The tier of leverage L on level `def` (tier against levelGoldLine), or null where the level has no line. */
export function levelTier(L: number, def: LevelDef): 0 | 1 | 2 | 3 | null {
  const line = levelGoldLine(def);
  return line === null ? null : tierAt(L, line);
}

export interface ShotOutcome {
  /** Launch energy, J: kinetic, or potential for a drop (ammoKE). */
  ke: number;
  /** A weapon's nominal blast yield, J (arsenal.ts itemYield; 0 without one). Energy fired is ke + yield. */
  yield: number;
  dPE_mJ: number;
  leverage: number;
  /** Crowns that went down during this shot, and the running total. */
  crownsDown: number;
  crownsTotal: number;
  heritageNew: number;
  displaced: number;
  outOfLot: number;
  /** The structure's potential energy at the settle (the level's end, after its last shot). */
  pe_mJ: number;
  spawnStep: number;
  /** The step of the state the outcome was taken on: its settle, or for a cut shot the state the next shot was fired from. */
  settleStep: number;
  /**
   * Present (true) when the shot did not settle: a shot fired while it ran closed it (rapid fire,
   * Session.fire). Its dPE and crowns are counted to there; the shot after it starts from that state.
   */
  cut?: true;
}

export interface ScoreLine { label: string; value: number }
export interface LevelScore {
  /**
   * The breakdown, in display order; total is their sum floored at 0 (floorTotal): heritage and
   * footprint lines can take a round below zero, but a score never shows negative.
   */
  lines: ScoreLine[]; total: number; stars: 0 | 1 | 2 | 3; stamp: string;
  /** The round's leverage (roundLeverage). */
  leverage: number;
  /**
   * Par levels: cleared in par with the level's gold leverage (lGold) or more, heritage intact: the
   * badge leverage earns now that it no longer gates a star (parStars). Absent on outcome levels.
   */
  gold?: boolean;
  /** Stars the broken heritage cost (heritageStarsLost): present, at least 1, only when it cost any. */
  heritageStarsLost?: number;
  /** Rube Lab levels (LevelDef.rube): the build's cost and the level's parts par. Absent elsewhere. */
  parts?: { used: number; par: number };
  /** Bullet Time levels (LevelDef.freeze): freezes spent (freezesUsed) of the level's budget. Absent elsewhere. */
  freezes?: { used: number; total: number };
  /**
   * A refereed round (a Siege Table duel: Session's refereed option): no solo tally was made. lines
   * empty, total and stars 0, the stamp DUEL; the duel's own result (Duel.result) is the outcome.
   */
  refereed?: true;
}

/** A score's total: its lines' sum, floored at 0 (LevelScore.lines). */
export const floorTotal = (lines: readonly ScoreLine[]) => Math.max(0, lines.reduce((a, l) => a + l.value, 0));

/** The score a refereed round (a duel) ends with: no solo tally, only the round's leverage. */
export function refereedScore(shots: readonly ShotOutcome[]): LevelScore {
  return { lines: [], total: 0, stars: 0, stamp: 'DUEL', leverage: roundLeverage(shots), refereed: true };
}

/**
 * Bullet Time (LevelDef.freeze): freezes spent in a round, one per cut shot (each shot that went in
 * while another ran spent one: Session.freezesLeft). 0 on a level without a budget, where rapid-fire
 * cuts spend nothing and count as strokes.
 */
export const freezesUsed = (def: LevelDef, shots: readonly ShotOutcome[]) => (def.freeze === undefined ? 0 : shots.filter((o) => o.cut).length);

/** A par level's par for a round: def.par plus the freezes it used, so a frozen cut-in that clears keeps par (PT8). */
export const parWithFreezes = (def: LevelDef, shots: readonly ShotOutcome[]) => def.par + freezesUsed(def, shots);

/** The gold-leverage badge's line when the bot has not set one for the level (LevelDef.lGold). */
export const DEFAULT_GOLD = 15;

/**
 * A par level's stars (docs/game/stars.md): none unless cleared; otherwise three, less one for each
 * stroke over par and one for any heritage broken, never under one. So a clear in par with heritage
 * intact is always three stars (a one-shot clear of a par-1 level, an ace), each stroke or heritage
 * piece is a visible star's worth, fewer strokes never earn fewer stars, and on a level with no
 * heritage every star is still reachable (par, bogey, worse). Leverage gates no star (the gold badge).
 */
export function parStars(cleared: boolean, strokes: number, par: number, heritageBroken: number): 0 | 1 | 2 | 3 {
  if (!cleared) return 0;
  const flaws = Math.max(0, strokes - par) + (heritageBroken > 0 ? 1 : 0);
  return Math.max(1, 3 - flaws) as 1 | 2 | 3;
}

export function stampOf(strokes: number, par: number): string {
  if (strokes === 1 && par >= 2) return 'ACE';
  const d = strokes - par;
  return d <= -3 ? 'ALBATROSS' : d === -2 ? 'EAGLE' : d === -1 ? 'BIRDIE' : d === 0 ? 'PAR' : d === 1 ? 'BOGEY' : d === 2 ? 'DOUBLE BOGEY' : `+${d}`;
}

/**
 * Stars for a Rube Lab level (docs/game/rube-lab.md, scoring): 3 at or under the parts par (what the bot's
 * cheapest robust clear cost), 2 within half again, 1 for any clear; 0 uncleared. Binary clear, no cast.
 */
export function rubeStars(cleared: boolean, spent: number, partsPar: number): 0 | 1 | 2 | 3 {
  if (!cleared) return 0;
  if (spent <= partsPar) return 3;
  if (spent <= Math.ceil(1.5 * partsPar)) return 2;
  return 1;
}

/** A Rube Lab level's stamp: PARTS PAR at or under the parts par, else +N PARTS. */
export const rubeStamp = (spent: number, partsPar: number) => (spent <= partsPar ? 'PARTS PAR' : `+${spent - partsPar} PARTS`);

/**
 * A level's score at its end. `spent`: the build's cost (build.ts placedCost), read on a Rube Lab level
 * (def.rube): there the stars are rubeStars on it, less one for any heritage broken (never under one),
 * the stamp is rubeStamp, the score carries `parts`, and there is no gold (a contraption's one plunger
 * is not a stroke to beat).
 */
export function levelScore(def: LevelDef, shots: ShotOutcome[], cleared: boolean, structureCount: number, spent = 0): LevelScore {
  const s = shots.length, par = parWithFreezes(def, shots);
  const L = roundLeverage(shots);
  const cmax = Math.min(12, Math.max(0, ...shots.map((o) => o.crownsDown)));
  const broken = shots.reduce((a, o) => a + o.heritageNew, 0);
  const lines: ScoreLine[] = [
    // Stroke points reward a clear in few strokes: none for a round that did not clear (PT16).
    { label: 'Strokes', value: cleared ? 1000 * Math.max(0, par + 3 - s) : 0 },
    { label: 'Leverage', value: Math.floor(300 * Math.log2(1 + L)) },
    { label: 'Combo', value: (50 * cmax * (cmax + 1)) / 2 },
  ];
  if (cleared && s === 1 && par >= 2) lines.push({ label: 'Ace', value: 2000 });
  if (broken) lines.push({ label: 'Heritage', value: -500 * broken });
  if (def.objective.kind === 'skyline' && def.objective.footprintMax !== undefined && s) {
    const out = shots[s - 1]!.outOfLot, allowance = Math.floor(def.objective.footprintMax * structureCount);
    if (out > allowance) lines.push({ label: 'Footprint', value: -20 * (out - allowance) });
  }
  if (def.rube) {
    const base = rubeStars(cleared, spent, def.rube.partsPar), stars = (base > 1 && broken ? base - 1 : base) as 0 | 1 | 2 | 3;
    return {
      lines, total: floorTotal(lines), stars, stamp: cleared ? rubeStamp(spent, def.rube.partsPar) : 'INCOMPLETE', leverage: L,
      parts: { used: spent, par: def.rube.partsPar }, ...(base - stars > 0 ? { heritageStarsLost: base - stars } : {}),
    };
  }
  const gold = cleared && s <= par && broken === 0 && L >= (levelGoldLine(def) ?? DEFAULT_GOLD); // the line levelTier names tiers from
  const stars = parStars(cleared, s, par, broken), lost = parStars(cleared, s, par, 0) - stars;
  return {
    lines, total: floorTotal(lines), stars, stamp: cleared ? stampOf(s, par) : 'INCOMPLETE', leverage: L, gold,
    ...(lost > 0 ? { heritageStarsLost: lost } : {}),
    ...(def.freeze !== undefined ? { freezes: { used: freezesUsed(def, shots), total: def.freeze } } : {}),
  };
}
