// The game's state machine. It sees only observations (reductions plus a few
// watched bodies) and step indices: never frames, wall time, the camera or the
// engine. It emits spawn events for the engine and feedback events for the
// renderer, audio and pacing, which never flow back into the rules.
import { type InputEvent, massOf, type Vec3 } from '@tb/engine-api';
import { GRAVITY } from './materials.ts';
import type { CompiledLevel } from './level.ts';
import { crownDown, heritageBroken, leverage, levelScore, type LevelScore, type Observation, type SettleState, settleUpdate, type ShotOutcome, skyline, tier } from './rules.ts';
import { type AmmoKind, ammoKE, type Shot, shotToSpawn } from './shots.ts';

export type Phase = 'aiming' | 'running' | 'cleared' | 'failed';

export type Feedback =
  | { t: 'fired'; step: number; ammo: AmmoKind; body: number; ke: number }
  /** The ammo's velocity changed by more than gravity explains: it hit something. Drives hit-stop. */
  | { t: 'contact'; step: number; body: number; dv: number; impulse: number }
  | { t: 'crownDown'; step: number; body: number; ordinal: number }
  | { t: 'heritageCrack'; step: number; body: number }
  | { t: 'slowMo'; step: number; body: number }
  | { t: 'tier'; step: number; leverage: number; tier: number }
  | { t: 'impacts'; step: number; hist: Uint32Array; total: number }
  | { t: 'settled'; step: number; shot: number; outcome: ShotOutcome }
  | { t: 'levelEnd'; step: number; cleared: boolean; score: LevelScore };

/** Vertical speed of a crown (m/s, downward) that starts slow motion. */
export const SLOWMO_VY = -1.5;

interface Live {
  shot: Shot;
  spawnStep: number;
  body: number;
  ke: number;
  mass: number;
  ammo: AmmoKind;
  settle: SettleState;
  contact: boolean;
  prevVel: Vec3 | null;
  tier: number;
  slowMo: boolean;
  crownsBefore: number;
  heritageBefore: number;
}

export class Session {
  phase: Phase = 'aiming';
  rackLeft: AmmoKind[];
  readonly outcomes: ShotOutcome[] = [];
  readonly inputs: { step: number; shot: Shot }[] = [];
  /** Crowns down as of the last settle (authoritative), and live for feedback. */
  readonly crownDown: Uint8Array;
  readonly crownLive: Uint8Array;
  /** Sticky: once broken, heritage stays broken. */
  readonly heritageBroken: Uint8Array;
  score: LevelScore | null = null;
  /** Leverage of the shot in flight, for the HUD. */
  liveLeverage = 0;
  private live: Live | null = null;
  private ammoCount = 0;
  private ordinal = 0;
  /** Bodies the observer must report each step: crowns, heritage, then live ammo. */
  watchIdx: Int32Array;

  /**
   * `home` holds the structure's positions when play starts (after the
   * pre-settle); heritage is judged against it. Defaults to the authored poses.
   */
  readonly home: Float64Array;

  constructor(readonly level: CompiledLevel, home?: Float64Array) {
    this.home = (home ?? level.meta.home).slice(0, 3 * level.meta.n);
    this.rackLeft = [...level.def.rack];
    this.crownDown = new Uint8Array(level.meta.crowns.length);
    this.crownLive = new Uint8Array(level.meta.crowns.length);
    this.heritageBroken = new Uint8Array(level.meta.heritage.length);
    this.watchIdx = Int32Array.from([...level.meta.crowns, ...level.meta.heritage]);
  }

  get strokes() { return this.outcomes.length + (this.live ? 1 : 0); }
  canFire(ammo: AmmoKind): boolean { return this.phase === 'aiming' && this.rackLeft.includes(ammo); }

  /** Fire at engine step `step` (its current stepIndex). Returns the spawn to push. */
  fire(shot: Shot, step: number): { spawn: InputEvent; feedback: Feedback[] } {
    if (!this.canFire(shot.ammo)) throw new Error(`cannot fire ${shot.ammo}: phase ${this.phase}, rack [${this.rackLeft.join(', ')}]`);
    const spawn = shotToSpawn(this.level.frame, shot, step);
    this.rackLeft.splice(this.rackLeft.indexOf(shot.ammo), 1);
    const body = this.level.meta.n + this.ammoCount++;
    const ke = ammoKE(spawn);
    this.live = {
      shot, spawnStep: step, body, ke, mass: massOf(spawn.body), ammo: shot.ammo, settle: { quietSince: null }, contact: false, prevVel: null, tier: 0, slowMo: false,
      crownsBefore: this.crownDown.reduce((a, x) => a + x, 0), heritageBefore: this.heritageBroken.reduce((a, x) => a + x, 0),
    };
    this.inputs.push({ step, shot });
    this.watchIdx = Int32Array.from([...this.level.meta.crowns, ...this.level.meta.heritage, body]);
    this.phase = 'running';
    this.liveLeverage = 0;
    return { spawn, feedback: [{ t: 'fired', step, ammo: shot.ammo, body, ke }] };
  }

  observe(o: Observation): Feedback[] {
    const L = this.live;
    if (!L || this.phase !== 'running') return [];
    const c = this.level, m = c.meta, w = o.watched, out: Feedback[] = [], step = o.step;
    const nc = m.crowns.length, nh = m.heritage.length;
    const pos = (k: number): Vec3 => [w.pos[3 * k]!, w.pos[3 * k + 1]!, w.pos[3 * k + 2]!];

    // Ammo: first contact is the first step its velocity departs from free flight.
    const ak = w.idx.indexOf(L.body);
    if (ak >= 0 && o.step > L.spawnStep) {
      const v: Vec3 = [w.linVel[3 * ak]!, w.linVel[3 * ak + 1]!, w.linVel[3 * ak + 2]!];
      if (L.prevVel && !L.contact) {
        const dv = Math.hypot(v[0] - L.prevVel[0], v[1] - (L.prevVel[1] - GRAVITY * c.scene.dt), v[2] - L.prevVel[2]);
        if (dv > 0.5 + 0.1 * Math.hypot(...L.prevVel)) {
          L.contact = true;
          out.push({ t: 'contact', step, body: L.body, dv, impulse: dv * L.mass });
        }
      }
      L.prevVel = v;
    }

    for (let k = 0; k < nc; k++) {
      const p = pos(k);
      if (!L.slowMo && w.linVel[3 * k + 1]! < SLOWMO_VY) { L.slowMo = true; out.push({ t: 'slowMo', step, body: m.crowns[k]! }); }
      if (!this.crownLive[k] && crownDown(c, p)) { this.crownLive[k] = 1; out.push({ t: 'crownDown', step, body: m.crowns[k]!, ordinal: this.ordinal++ }); }
    }
    for (let k = 0; k < nh; k++) {
      const b = m.heritage[k]!, q = w.rot.subarray(4 * (nc + k), 4 * (nc + k) + 4);
      if (!this.heritageBroken[k] && heritageBroken(c, pos(nc + k), [q[0]!, q[1]!, q[2]!, q[3]!], [this.home[3 * b]!, this.home[3 * b + 1]!, this.home[3 * b + 2]!])) {
        this.heritageBroken[k] = 1;
        out.push({ t: 'heritageCrack', step, body: b });
      }
    }

    this.liveLeverage = leverage(o.basePe_mJ - o.red.pe_mJ, L.ke);
    const t = tier(this.liveLeverage);
    if (t > L.tier) { L.tier = t; out.push({ t: 'tier', step, leverage: this.liveLeverage, tier: t }); }
    const total = o.red.impacts.reduce((a, x) => a + x, 0);
    if (total) out.push({ t: 'impacts', step, hist: o.red.impacts, total });

    const s = settleUpdate(L.settle, o.red, L.spawnStep);
    L.settle = s.state;
    if (!s.settled) return out;

    // Settle: crowns are judged on where they lie now.
    for (let k = 0; k < nc; k++) this.crownDown[k] = crownDown(c, pos(k)) ? 1 : 0;
    const crownsTotal = this.crownDown.reduce((a, x) => a + x, 0);
    const outcome: ShotOutcome = {
      ke: L.ke, dPE_mJ: o.basePe_mJ - o.red.pe_mJ, leverage: this.liveLeverage,
      crownsDown: Math.max(0, crownsTotal - L.crownsBefore), crownsTotal,
      heritageNew: this.heritageBroken.reduce((a, x) => a + x, 0) - L.heritageBefore,
      displaced: o.red.displaced, outOfLot: o.red.outOfLot, spawnStep: L.spawnStep, settleStep: step,
    };
    this.outcomes.push(outcome);
    this.live = null;
    this.watchIdx = Int32Array.from([...m.crowns, ...m.heritage]);
    out.push({ t: 'settled', step, shot: this.outcomes.length - 1, outcome });

    const obj = c.def.objective;
    const cleared = obj.kind === 'crowns'
      ? nc > 0 && crownsTotal === nc
      : skyline(o.red.heightHist, c.height) <= obj.maxH * c.frame.unit + 1e-9 && (obj.footprintMax === undefined || o.red.outOfLot <= obj.footprintMax * m.n);
    if (cleared || this.rackLeft.length === 0) {
      this.phase = cleared ? 'cleared' : 'failed';
      this.score = levelScore(c.def, this.outcomes, cleared, m.n);
      out.push({ t: 'levelEnd', step, cleared, score: this.score });
    } else {
      this.phase = 'aiming';
    }
    return out;
  }
}
