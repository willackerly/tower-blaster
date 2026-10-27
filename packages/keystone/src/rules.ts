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

export function reduceCpu(s: Snapshot, prevLinVel: Float64Array | null, c: CompiledLevel, base: Baseline, step: number): Reductions {
  const { meta: m } = c, h = c.frame.unit, dt = c.scene.dt;
  const r: Reductions = { step, nAwake: 0, maxSpeed: 0, maxAngSpeed: 0, pe_mJ: 0, displaced: 0, outOfLot: 0, heightHist: new Uint32Array(HEIGHT_BINS), impacts: new Uint32Array(MATERIALS.length * BANDS) };
  const top = Math.max(c.height, 1e-9);
  for (let i = 0; i < s.count; i++) {
    const structure = i < m.n;
    if (!structure && !ammoLive(c, s, i)) continue;
    if (s.awake[i]) {
      r.nAwake++;
      r.maxSpeed = Math.max(r.maxSpeed, Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!));
      if (structure) r.maxAngSpeed = Math.max(r.maxAngSpeed, Math.hypot(s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!));
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
  get baseline() { return this.base; }
  observe(s: Snapshot, step: number, watchIdx: Int32Array): Observation {
    const red = reduceCpu(s, this.prevVel, this.c, this.base, step);
    this.prevVel = s.linVel.slice();
    return { step, red, watched: watch(s, watchIdx), basePe_mJ: this.base.pe_mJ };
  }
}

// ---- Settling ----

export interface SettleState { quietSince: number | null }

export function settleUpdate(st: SettleState, r: Reductions, spawnStep: number): { state: SettleState; settled: boolean } {
  const quiet = r.nAwake === 0 || (r.maxSpeed < QUIET_SPEED && r.maxAngSpeed < QUIET_SPIN);
  const quietSince = quiet ? (st.quietSince ?? r.step) : null;
  const old = r.step - spawnStep;
  const settled = old >= SETTLE_CAP || (old >= SETTLE_MIN && (r.nAwake === 0 || (quietSince !== null && r.step - quietSince + 1 >= SETTLE_QUIET)));
  return { state: { quietSince }, settled };
}

// ---- Objectives ----

export function crownDown(c: CompiledLevel, p: Vec3): boolean {
  return p[1] < c.def.crownLine * c.frame.unit || outsideLot(c, p[0], p[2]);
}

/** Heritage starts axis-aligned at `home`; it breaks if it moves or tilts past tolerance. */
export function heritageBroken(c: CompiledLevel, p: Vec3, q: Quat, home: Vec3): boolean {
  const h = c.frame.unit;
  return Math.hypot(p[0] - home[0], p[1] - home[1], p[2] - home[2]) > HERITAGE_MOVE * h || quatAngle(q) > HERITAGE_TILT;
}

/** Settled height: the top of the highest histogram bin holding at least 3 bodies (strays don't count). */
export function skyline(hist: Uint32Array, height: number): number {
  for (let b = hist.length - 1; b >= 0; b--) if (hist[b]! >= 3) return ((b + 1) * height) / hist.length;
  return 0;
}

// ---- Scoring ----

export const TIER_NAMES = ['Brute', 'Clean', 'Elegant', 'Keystone'] as const;
const TIER_FLOORS = [0, 5, 15, 40];

/** Collapse energy released per joule fired. */
export const leverage = (dPE_mJ: number, ke: number) => (ke > 0 ? Math.max(0, dPE_mJ / 1000) / ke : 0);
export function tier(L: number): 0 | 1 | 2 | 3 {
  return L >= TIER_FLOORS[3]! ? 3 : L >= TIER_FLOORS[2]! ? 2 : L >= TIER_FLOORS[1]! ? 1 : 0;
}

export interface ShotOutcome {
  ke: number;
  dPE_mJ: number;
  leverage: number;
  /** Crowns that went down during this shot, and the running total. */
  crownsDown: number;
  crownsTotal: number;
  heritageNew: number;
  displaced: number;
  outOfLot: number;
  spawnStep: number;
  settleStep: number;
}

export interface ScoreLine { label: string; value: number }
export interface LevelScore { lines: ScoreLine[]; total: number; stars: 0 | 1 | 2 | 3; stamp: string; leverage: number }

/** Leverage needed for the third star when the bot has not set one for the level. */
export const DEFAULT_GOLD = 15;

export function stampOf(strokes: number, par: number): string {
  if (strokes === 1 && par >= 2) return 'ACE';
  const d = strokes - par;
  return d <= -3 ? 'ALBATROSS' : d === -2 ? 'EAGLE' : d === -1 ? 'BIRDIE' : d === 0 ? 'PAR' : d === 1 ? 'BOGEY' : d === 2 ? 'DOUBLE BOGEY' : `+${d}`;
}

export function levelScore(def: LevelDef, shots: ShotOutcome[], cleared: boolean, structureCount: number): LevelScore {
  const s = shots.length, par = def.par;
  const ke = shots.reduce((a, o) => a + o.ke, 0), dpe = shots.reduce((a, o) => a + o.dPE_mJ, 0);
  const L = leverage(dpe, ke);
  const cmax = Math.min(12, Math.max(0, ...shots.map((o) => o.crownsDown)));
  const broken = shots.reduce((a, o) => a + o.heritageNew, 0);
  const lines: ScoreLine[] = [
    { label: 'Strokes', value: 1000 * Math.max(0, par + 3 - s) },
    { label: 'Leverage', value: Math.floor(300 * Math.log2(1 + L)) },
    { label: 'Combo', value: (50 * cmax * (cmax + 1)) / 2 },
  ];
  if (cleared && s === 1 && par >= 2) lines.push({ label: 'Ace', value: 2000 });
  if (broken) lines.push({ label: 'Heritage', value: -500 * broken });
  if (def.objective.kind === 'skyline' && def.objective.footprintMax !== undefined && s) {
    const out = shots[s - 1]!.outOfLot, allowance = Math.floor(def.objective.footprintMax * structureCount);
    if (out > allowance) lines.push({ label: 'Footprint', value: -20 * (out - allowance) });
  }
  const total = lines.reduce((a, l) => a + l.value, 0);
  const stars = !cleared ? 0 : s > par ? 1 : broken === 0 && L >= (def.lGold ?? DEFAULT_GOLD) ? 3 : 2;
  return { lines, total, stars, stamp: cleared ? stampOf(s, par) : 'INCOMPLETE', leverage: L };
}
