// The game's state machine. It sees only observations (reductions plus a few
// watched bodies) and step indices: never frames, wall time, the camera or the
// engine. It emits spawn events for the engine and feedback events for the
// renderer, audio and pacing, which never flow back into the rules.
import { massOf, type RemoveEvent, type SpawnEvent, type Vec3 } from '@tb/engine-api';
import { GRAVITY } from './materials.ts';
import { itemYield, levelCharges, plungerYield } from './arsenal.ts';
import { castStars, type CompiledLevel, type Scoring, scoringOf, settleOf } from './level.ts';
import type { IceCrack } from './ice.ts';
import { buildingOnly, collapseFraction, floorPotential_mJ, homePotential_mJ, homeSkyline, objectiveMet, type OutcomeFacts, outcomeScore } from './outcome.ts';
import { ammoInFlight, bellRung, crownDown, heritageBroken, leverage, levelScore, type LevelScore, levelTier, refereedScore, roundLeverage, type Observation, type Reductions, type SettleRule, type SettleState, settleCap, settleUpdate, type ShotOutcome, skyline, spillOf } from './rules.ts';
import type { RackItem } from './rack.ts';
import { placedCost } from './build.ts';
import { ammoKE, type PlungerShot, pullEnergy, type Shot, shotEvent } from './shots.ts';

export type Phase = 'aiming' | 'running' | 'cleared' | 'failed';

export type Feedback =
  /** A shot went in: `body` is the ammo's engine id, for a pull the structure body taken out, for a plunger -1; ke the energy charged (a pull's is nominal, a plunger's 0: its charges' is yield). */
  | { t: 'fired'; step: number; ammo: RackItem; body: number; ke: number }
  /** The ammo's velocity changed by more than gravity explains: it hit something. Drives hit-stop. */
  | { t: 'contact'; step: number; body: number; dv: number; impulse: number }
  | { t: 'crownDown'; step: number; body: number; ordinal: number }
  | { t: 'heritageCrack'; step: number; body: number }
  | { t: 'slowMo'; step: number; body: number }
  | { t: 'tier'; step: number; leverage: number; tier: number }
  | { t: 'impacts'; step: number; hist: Uint32Array; total: number }
  /** A fired weapon's blast, due at `step`, shows in the state just observed (Driver, arsenal.ts): centred on `body`, `radius` m. */
  | { t: 'blast'; step: number; body: number; radius: number }
  /** An ice block cracked further (ice.ts): crack level 1 to 7, where it started (body frame, -1..1 per axis) and a seed for its pattern. */
  | { t: 'iceCrack'; step: number; body: number; level: number; at: Vec3; seed: number }
  /** An ice block shattered: removed at `step`, its pieces (engine ids) spawned in its place; dv the hit that did it, m/s. */
  | { t: 'shatter'; step: number; body: number; pieces: number[]; dv: number; cracks: IceCrack[] }
  | { t: 'settled'; step: number; shot: number; outcome: ShotOutcome }
  /**
   * A shot fired while shot `shot` was still running (rapid fire) closed it: its outcome is taken on
   * the state the new shot was fired from (ShotOutcome.cut). No settle, no level end: the new shot runs on.
   */
  | { t: 'cut'; step: number; shot: number; outcome: ShotOutcome }
  | { t: 'levelEnd'; step: number; cleared: boolean; score: LevelScore };

/** The highest a spawned body's centre can sit on the ground: a sphere's radius, a box's half diagonal (any face or edge down). */
export function restHeight(spawn: SpawnEvent): number {
  const sh = spawn.body.shape;
  return sh.kind === 'sphere' ? sh.radius : Math.hypot(...sh.half);
}

/** Vertical speed of a crown (m/s, downward) that starts slow motion. */
export const SLOWMO_VY = -1.5;

interface Live {
  /** Nominal yield of the item's weapon, J (0 without one): charged with ke in energy fired. */
  yield: number;
  shot: Shot;
  spawnStep: number;
  body: number;
  ke: number;
  mass: number;
  ammo: RackItem;
  settle: SettleState;
  contact: boolean;
  /** The highest the ammo's centre can sit on the ground, m (rules.ts ammoInFlight); 0 for a pull. */
  rest: number;
  /** Whether the ammo was in flight at the last observed step (ammoInFlight). */
  inFlight: boolean;
  prevVel: Vec3 | null;
  tier: number;
  slowMo: boolean;
  crownsBefore: number;
  heritageBefore: number;
}

export class Session {
  phase: Phase = 'aiming';
  rackLeft: RackItem[];
  readonly outcomes: ShotOutcome[] = [];
  readonly inputs: { step: number; shot: Shot }[] = [];
  /** Crowns down as of the last settle (authoritative), and live for feedback. */
  readonly crownDown: Uint8Array;
  readonly crownLive: Uint8Array;
  /** Sticky: once broken, heritage stays broken. */
  readonly heritageBroken: Uint8Array;
  score: LevelScore | null = null;
  /** Structure bodies pulled so far (Undercut), in pull order. */
  readonly pulled: number[] = [];
  /** Ice blocks shattered so far (ice.ts), in shatter order: a crown among them is down, heritage broken. */
  readonly shattered: number[] = [];
  /** Charges armed by plungers so far (LevelDef.charges indices), in arming order. */
  readonly armed: number[] = [];
  /** Structure bodies taken out by charges (removeTarget), in order (Driver tells the session as it pushes them). */
  readonly cut: number[] = [];
  /** Leverage of the shot in flight, or of the last shot once it closed (until the next goes in): the HUD's "this shot". */
  liveLeverage = 0;
  /** The shot in flight's release so far, mJ (0 between shots): what roundLeverageNow adds to the closed shots. */
  private liveDPE_mJ = 0;
  private live: Live | null = null;
  private ammoCount = 0;
  private ordinal = 0;
  /** Bodies the observer must report each step: crowns, heritage, then live ammo. */
  watchIdx: Int32Array;
  /** Par (end at clear) or outcome (end at a bank or an empty rack; LevelDef.autobank ends at the first clear too). */
  readonly scoring: Scoring;
  /** How this level's shots settle (settleOf: v1 for par levels, v3 for outcome levels unless the level says). */
  readonly settleRule: SettleRule;
  /** Collapse fraction D now, for the HUD (while a shot runs), and whether the objective was met at the last settle. */
  liveCollapse = 0;
  objectiveDone = false;
  /** The reductions and crowns at the last settle: what an outcome level is scored on when it ends. */
  private lastSettle: { red: Reductions; crownsTotal: number } | null = null;

  /**
   * `home` holds the structure's positions when play starts (after the
   * pre-settle); heritage is judged against it. Defaults to the authored poses.
   */
  readonly home: Float64Array;
  /** The structure's potential energy at home, PE(B0), and lying flat, PE_floor: the collapse fraction's range. */
  /** PE at the start and lying flat: of the building alone on a fold level (outcome.ts buildingOnly), else of the whole structure. */
  readonly startPe_mJ: number;
  readonly floorPe_mJ: number;
  /** Collapse counts the building alone (a fold level). */
  readonly building: boolean;

  /**
   * A refereed round (a Siege Table duel, whose referee is Duel): the round ends as an outcome level
   * would, but with refereedScore, no solo tally or stars (PT16).
   */
  readonly refereed: boolean;

  constructor(readonly level: CompiledLevel, home?: Float64Array, opts: { refereed?: boolean } = {}) {
    this.refereed = opts.refereed ?? false;
    this.home = (home ?? level.meta.home).slice(0, 3 * level.meta.n);
    this.building = buildingOnly(level);
    this.startPe_mJ = homePotential_mJ(level, this.home, this.building);
    this.floorPe_mJ = floorPotential_mJ(level, this.building);
    this.scoring = scoringOf(level.def);
    this.settleRule = settleOf(level.def);
    this.rackLeft = [...level.def.rack];
    this.crownDown = new Uint8Array(level.meta.crowns.length);
    this.crownLive = new Uint8Array(level.meta.crowns.length);
    this.heritageBroken = new Uint8Array(level.meta.heritage.length);
    this.watchIdx = Int32Array.from([...level.meta.crowns, ...level.meta.heritage]);
  }

  /** A bell level (Rube Lab): its crowns are bells, rung by bellRung. */
  get bell(): boolean { return this.level.def.objective.kind === 'bell'; }
  /** Whether crown k (a bell) at p has rung, against its home. */
  private rung(k: number, p: Vec3): boolean {
    const b = this.level.meta.crowns[k]!;
    return bellRung(this.level, p, [this.home[3 * b]!, this.home[3 * b + 1]!, this.home[3 * b + 2]!]);
  }

  /** Collapse fraction D with the structure at potential energy pe_mJ. */
  collapse(pe_mJ: number): number { return collapseFraction(this.startPe_mJ, pe_mJ, this.floorPe_mJ); }
  /** The PE a reduction holds of what collapse counts (startPe_mJ's: the building's alone on a fold level). */
  peOf(red: Pick<Reductions, 'pe_mJ' | 'peHeritage_mJ'>): number { return this.building ? red.pe_mJ - red.peHeritage_mJ : red.pe_mJ; }

  get strokes() { return this.outcomes.length + (this.live ? 1 : 0); }

  /**
   * The round's leverage as it stands (roundLeverage over the closed shots and the one in flight, its
   * release so far): what the HUD shows. Once the round ends it equals the card's (LevelScore.leverage).
   */
  roundLeverageNow(): number {
    const L = this.live;
    return roundLeverage(L ? [...this.outcomes, { ke: L.ke, yield: L.yield, dPE_mJ: this.liveDPE_mJ }] : this.outcomes);
  }
  /**
   * Whether `ammo` can go in now: the round is open (aiming, or a shot running: rapid fire, which
   * cuts the shot in flight) and the rack still holds one. Whether a player may fire mid-shot is the
   * game's choice (@tb/game PaceFeel.rapid); the rules allow it, up to the level's freeze budget
   * (freezesLeft).
   */
  canFire(ammo: RackItem): boolean {
    return (this.phase === 'aiming' || (this.phase === 'running' && this.freezesLeft > 0)) && this.rackLeft.includes(ammo);
  }

  /**
   * How many more shots may go in while another runs (LevelDef.freeze, Bullet Time): the level's
   * budget less the shots that have cut one; Infinity when the level sets none. A shot fired while
   * aiming spends nothing, and neither does freezing the world without firing (the game's pause).
   */
  get freezesLeft(): number {
    const budget = this.level.def.freeze;
    return budget === undefined ? Infinity : budget - this.inputs.filter((i) => i.shot.after !== undefined).length;
  }

  /**
   * Why structure body `body` cannot be pulled, or null if it can: only plain structure bodies
   * still in the world (crowns and heritage are the objective's, never taken).
   */
  pullRefusal(body: number): string | null {
    const m = this.level.meta;
    if (!Number.isInteger(body) || body < 0 || body >= m.n) return `body ${body} is not a structure body (0 to ${m.n - 1})`;
    if (m.crowns.includes(body)) return `body ${body} is a crown`;
    if (m.heritage.includes(body)) return `body ${body} is heritage`;
    if (this.pulled.includes(body)) return `body ${body} is already pulled`;
    if (this.cut.includes(body)) return `body ${body} was taken out by a charge`;
    return null;
  }

  /**
   * Why plunger shot `shot` cannot go in, or null if it can: every charge it names is one of the
   * level's that a plunger arms, not armed before nor named twice, and every delay ends before the
   * settle rule's cap (a shot never holds open past it).
   */
  plungerRefusal(shot: PlungerShot): string | null {
    const charges = this.level.def.charges ?? [], cap = settleCap(this.settleRule), seen = new Set<number>();
    for (const [i, delay] of shot.fuse) {
      if (!Number.isInteger(i) || i < 0 || i >= charges.length) return `charge ${i} is not one of the level's ${charges.length}`;
      if ((charges[i]!.arm ?? 'plunger') !== 'plunger') return `charge ${i} is armed at start, not by a plunger`;
      if (seen.has(i)) return `charge ${i} is named twice`;
      if (this.armed.includes(i)) return `charge ${i} is already armed`;
      if (!Number.isInteger(delay) || delay < 0 || delay >= cap) return `charge ${i}'s delay ${delay} is not 0 to ${cap - 1} steps (the settle cap)`;
      seen.add(i);
    }
    // Fuse & Fold: a demolition fires every charge, so the decision is when each goes, not which to leave out
    // (leaving a row standing is a hinge that fells a frame as surely as a long delay does: fuse-and-fold.md).
    if (this.level.def.objective.kind === 'fold') {
      const left = charges.flatMap((ch, i) => ((ch.arm ?? 'plunger') === 'plunger' && !seen.has(i) && !this.armed.includes(i) ? [i] : []));
      if (left.length) return `a fold level's plunger fires every charge: ${left.length} not named (${left.slice(0, 4).join(', ')}${left.length > 4 ? ', ...' : ''})`;
    }
    return null;
  }

  /** A charge took structure body `body` out (Driver): it can no longer be pulled. */
  chargeCut(body: number): void {
    if (!this.cut.includes(body)) this.cut.push(body);
  }

  /**
   * Fire at engine step `step` (its current stepIndex). Returns the engine event to push: the
   * ammo's spawn, or a pull's removal (spawn null). `body` is the engine id the ammo will have: by
   * default the structure's bodies then the ammo fired before; a driver that pushes other spawns
   * (Driver.push) passes its own count. A pull spawns nothing and takes no id.
   *
   * While a shot runs (rapid fire), `now` must be the rules' view of the state the new shot is
   * fired from, against the running shot's baseline (Driver.fire: CpuObserver.peek). The running
   * shot is cut there (a 'cut' feedback, its outcome marked cut) and the new one starts from it, so
   * the shots' dPE still sums to the structure's whole drop. The input is recorded with `after`
   * (steps since the shot before was fired) only then; a shot fired while aiming is recorded without one.
   */
  fire(shot: Shot, step: number, body = this.level.meta.n + this.ammoCount, now?: Observation): { spawn: SpawnEvent | null; event: SpawnEvent | RemoveEvent | null; feedback: Feedback[] } {
    if (!this.canFire(shot.ammo)) throw new Error(`cannot fire ${shot.ammo}: phase ${this.phase}, rack [${this.rackLeft.join(', ')}]${this.phase === 'running' && this.freezesLeft <= 0 ? `, no freezes left (the level gives ${this.level.def.freeze})` : ''}`);
    const why = shot.ammo === 'pull' ? this.pullRefusal(shot.body) : null;
    if (why) throw new Error(`cannot pull: ${why}`);
    const no = shot.ammo === 'plunger' ? this.plungerRefusal(shot) : null;
    if (no) throw new Error(`cannot fire the plunger: ${no}`);
    if (this.live && !now) throw new Error(`Session.fire: a shot is running; cutting it needs the observed state the new one is fired from`);
    const out: Feedback[] = [];
    const { after: _, ...bare } = shot;
    let recorded = bare as Shot;
    if (this.live) {
      const prev = this.inputs[this.inputs.length - 1]!.step;
      if (step < prev) throw new Error(`Session.fire: step ${step} is before the running shot's ${prev}`);
      out.push(this.close(now!, true));
      recorded = { ...bare, after: step - prev } as Shot;
    }
    const event = shotEvent(this.level.frame, shot, step), spawn = event?.kind === 'spawn' ? event : null;
    this.rackLeft.splice(this.rackLeft.indexOf(shot.ammo), 1);
    if (spawn) this.ammoCount++;
    if (event?.kind === 'remove') this.pulled.push(event.id);
    if (shot.ammo === 'plunger') { levelCharges(this.level); this.armed.push(...shot.fuse.map(([i]) => i)); }
    // A pull is charged a nominal poke; a plunger's press is free and its charges are its yield.
    const ke = spawn ? ammoKE(spawn) : shot.ammo === 'plunger' ? 0 : pullEnergy(this.level.frame);
    const yieldJ = shot.ammo === 'plunger' ? plungerYield(this.level, shot) : itemYield(this.level, shot.ammo);
    const live = spawn ? body : -1;
    this.live = {
      shot, spawnStep: step, body: live, ke, yield: yieldJ, mass: spawn ? massOf(spawn.body) : 0, ammo: shot.ammo, settle: { quietSince: null }, contact: false, rest: spawn ? restHeight(spawn) : 0, inFlight: spawn !== null, prevVel: null, tier: 0, slowMo: false,
      crownsBefore: this.crownDown.reduce((a, x) => a + x, 0), heritageBefore: this.heritageBroken.reduce((a, x) => a + x, 0),
    };
    this.inputs.push({ step, shot: recorded });
    this.watchIdx = Int32Array.from(spawn ? [...this.level.meta.crowns, ...this.level.meta.heritage, body] : [...this.level.meta.crowns, ...this.level.meta.heritage]);
    this.phase = 'running';
    this.liveLeverage = 0;
    this.liveDPE_mJ = 0;
    out.push({ t: 'fired', step, ammo: shot.ammo, body: event?.kind === 'remove' ? event.id : spawn ? body : -1, ke });
    return { spawn, event, feedback: out };
  }

  /**
   * Close the running shot on observed state `o`: crowns judged where they lie, the outcome
   * recorded. A settle (cut false) or a cut by a shot fired while it ran (ShotOutcome.cut).
   */
  private close(o: Observation, cut: boolean): Extract<Feedback, { t: 'settled' | 'cut' }> {
    const L = this.live!, c = this.level, m = c.meta, w = o.watched, nc = m.crowns.length;
    // A bell, once rung, stays rung (it was hit, or got there): judged live in observe(). A crown is judged where it lies.
    for (let k = 0; k < nc; k++) this.crownDown[k] = this.bell ? this.crownLive[k]! || (this.rung(k, [w.pos[3 * k]!, w.pos[3 * k + 1]!, w.pos[3 * k + 2]!]) ? 1 : 0) : this.shattered.includes(m.crowns[k]!) || crownDown(c, [w.pos[3 * k]!, w.pos[3 * k + 1]!, w.pos[3 * k + 2]!]) ? 1 : 0;
    const crownsTotal = this.crownDown.reduce((a, x) => a + x, 0);
    const dPE_mJ = o.basePe_mJ - o.red.pe_mJ;
    const outcome: ShotOutcome = {
      ke: L.ke, yield: L.yield, dPE_mJ, leverage: leverage(dPE_mJ, L.ke + L.yield),
      crownsDown: Math.max(0, crownsTotal - L.crownsBefore), crownsTotal,
      heritageNew: this.heritageBroken.reduce((a, x) => a + x, 0) - L.heritageBefore,
      displaced: o.red.displaced, outOfLot: o.red.outOfLot, pe_mJ: o.red.pe_mJ, spawnStep: L.spawnStep, settleStep: o.step,
      ...(cut ? { cut: true as const } : {}),
    };
    this.outcomes.push(outcome);
    this.liveLeverage = outcome.leverage;
    this.liveDPE_mJ = 0;
    this.live = null;
    this.watchIdx = Int32Array.from([...m.crowns, ...m.heritage]);
    return { t: cut ? 'cut' : 'settled', step: o.step, shot: this.outcomes.length - 1, outcome };
  }

  /**
   * The rules' view of one observed state. `hold`: a fired weapon is still to go off
   * (Driver: a live fuse or a blast due later), so the shot does not settle before
   * the settle rule's cap however quiet the structure is.
   */
  observe(o: Observation, hold = false): Feedback[] {
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
      L.inFlight = ammoInFlight(c, L.contact, w.pos[3 * ak + 1]!, Math.hypot(...v), L.rest);
    } else if (ak < 0) L.inFlight = false;

    for (let k = 0; k < nc; k++) {
      const p = pos(k);
      if (!L.slowMo && w.linVel[3 * k + 1]! < SLOWMO_VY) { L.slowMo = true; out.push({ t: 'slowMo', step, body: m.crowns[k]! }); }
      if (!this.crownLive[k] && (this.bell ? this.rung(k, p) : crownDown(c, p) || this.shattered.includes(m.crowns[k]!))) { this.crownLive[k] = 1; out.push({ t: 'crownDown', step, body: m.crowns[k]!, ordinal: this.ordinal++ }); }
    }
    for (let k = 0; k < nh; k++) {
      const b = m.heritage[k]!, q = w.rot.subarray(4 * (nc + k), 4 * (nc + k) + 4);
      if (!this.heritageBroken[k] && (this.shattered.includes(b) || heritageBroken(c, pos(nc + k), [q[0]!, q[1]!, q[2]!, q[3]!], [this.home[3 * b]!, this.home[3 * b + 1]!, this.home[3 * b + 2]!]))) {
        this.heritageBroken[k] = 1;
        out.push({ t: 'heritageCrack', step, body: b });
      }
    }

    this.liveDPE_mJ = o.basePe_mJ - o.red.pe_mJ;
    this.liveLeverage = leverage(this.liveDPE_mJ, L.ke + L.yield);
    this.liveCollapse = this.collapse(this.peOf(o.red));
    // Tiers against the level's gold line (levelTier): none on a level without one.
    const t = levelTier(this.liveLeverage, c.def) ?? 0;
    if (t > L.tier) { L.tier = t; out.push({ t: 'tier', step, leverage: this.liveLeverage, tier: t }); }
    const total = o.red.impacts.reduce((a, x) => a + x, 0);
    if (total) out.push({ t: 'impacts', step, hist: o.red.impacts, total });

    const s = settleUpdate(L.settle, o.red, L.spawnStep, this.settleRule, m.n, this.liveCollapse, L.inFlight);
    L.settle = s.state;
    if (!s.settled || (hold && o.step - L.spawnStep < settleCap(this.settleRule))) return out;

    // Settle: crowns are judged on where they lie now.
    const settled = this.close(o, false);
    out.push(settled);
    const crownsTotal = settled.outcome.crownsTotal;

    const cleared = objectiveMet(c, { red: o.red, crownsTotal, collapse: this.collapse(this.peOf(o.red)), heritage: this.heritageBroken.reduce((a, x) => a + x, 0) }, this.scoring);
    this.objectiveDone = cleared;
    this.lastSettle = { red: o.red, crownsTotal };
    if (this.scoring === 'outcome') {
      // Hollow: a crown down at a settle ends the level there.
      const toppled = c.def.objective.kind === 'hold' && crownsTotal > 0;
      if (toppled || this.rackLeft.length === 0 || (c.def.autobank && cleared)) out.push(this.end(step));
      else this.phase = 'aiming';
      return out;
    }
    if (cleared || this.rackLeft.length === 0) {
      this.phase = cleared ? 'cleared' : 'failed';
      // Rube Lab: a binary clear, starred on the build's cost against the parts par (rules.ts partsStars).
      this.score = levelScore(c.def, this.outcomes, cleared, m.n, c.def.build?.par !== undefined ? placedCost(c.def) : 0);
      out.push({ t: 'levelEnd', step, cleared, score: this.score });
    } else {
      this.phase = 'aiming';
    }
    return out;
  }

  /** Structure body `body` (ice) shattered (Driver, from IceBreaker): from the next observed state it counts as down (a crown) or broken (heritage). */
  shatter(body: number): void {
    if (!this.shattered.includes(body)) this.shattered.push(body);
  }

  /** An outcome level can be banked (ended, keeping the unused rack) while aiming after a settled shot. */
  canBank(): boolean { return this.scoring === 'outcome' && this.phase === 'aiming' && this.lastSettle !== null; }

  /** Ends an outcome level at engine step `step`; refused (an error) unless canBank(). */
  bank(step: number): Feedback[] {
    if (!this.canBank()) throw new Error(`cannot bank: ${this.scoring === 'par' ? 'a par level ends at its clear' : this.phase !== 'aiming' ? `phase ${this.phase}` : 'no shot has settled yet'}`);
    return [this.end(step)];
  }

  /** Share of the structure's mass pulled so far, 0 to 1. */
  pulledShare(): number {
    const m = this.level.meta;
    let all = 0, gone = 0;
    for (let i = 0; i < m.n; i++) all += m.mass[i]!;
    for (const b of this.pulled) gone += m.mass[b]!;
    return all > 0 ? gone / all : 0;
  }

  /** What an outcome level is scored on as it stands at the last settle. */
  outcomeFacts(): OutcomeFacts {
    const c = this.level, m = c.meta, last = this.lastSettle;
    const pe = last ? this.peOf(last.red) : this.startPe_mJ;
    const start = homeSkyline(c, this.home);
    return {
      met: this.objectiveDone,
      collapse: this.collapse(pe),
      leverage: roundLeverage(this.outcomes),
      comboMax: Math.max(0, ...this.outcomes.map((o) => o.crownsDown)),
      hasCrowns: m.crowns.length > 0,
      rackLeft: this.rackLeft.length,
      heritageBroken: this.heritageBroken.reduce((a, x) => a + x, 0),
      outOfLot: last && m.n ? last.red.outOfLot / m.n : 0,
      ...(c.def.objective.footprintMax !== undefined ? { footprintMax: c.def.objective.footprintMax } : {}),
      crownsDown: last?.crownsTotal ?? 0,
      skylineRatio: last && start > 0 ? skyline(last.red.heightHist, c.height) / start : 1,
      pulled: this.pulledShare(),
      ...(c.def.objective.kind === 'hold' ? { hold: true } : {}),
      ...(c.def.objective.kind === 'fold' ? { spill: last ? spillOf(last.red) : 0 } : {}),
    };
  }

  private end(step: number): Feedback {
    this.phase = this.objectiveDone ? 'cleared' : 'failed';
    this.score = this.refereed ? refereedScore(this.outcomes) : outcomeScore(this.outcomeFacts(), castStars(this.level), this.level.def.stars?.metric);
    return { t: 'levelEnd', step, cleared: this.objectiveDone, score: this.score };
  }
}
