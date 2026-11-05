// Siege Table (docs/game/modes-roadmap.md, mode M4; capability C4): two
// players take turns on one device, each with a rack and a side of the ring to
// fire from, and the turn controller judges every settle from tagged
// reductions (groups.ts) of what each player owns. No networking, no casting:
// a duel is scored against the other player, so its level is played uncast.
//
// The duel is a referee beside the Session, not a new Session: the level's
// rack is both players' racks together, the Session plays it as an outcome
// level (it never ends by its objective, so nothing but the duel ends it), and
// a page asks the duel before every shot and tells it about every settle. A
// recorded duel is therefore (level, shots, who went first), and replays as
// any Keystone session does.
import type { Snapshot } from '@tb/engine-api';
import { type GroupReduction, type GroupSel, reduceGroup, selectGroup } from './groups.ts';
import type { CompiledLevel, LevelDef } from './level.ts';
import { isRackItem, type RackItem } from './rack.ts';
import type { Shot } from './shots.ts';

/**
 * keeps: an artillery duel between two forts. Topple the other side's king (its crown blocks, all
 * of them down) and you win at once; topple your own and you lose. With both racks spent, the fort
 * with more of itself standing wins.
 * heraldry: one shared tower in two players' colours. Each shot scores the rival's blocks it brought
 * down, less your own; with both racks spent, the higher score wins.
 */
export const RULESETS = ['keeps', 'heraldry'] as const;
export type Ruleset = (typeof RULESETS)[number];

export interface DuelSide {
  /** Shown to the players ("West", "Gold"). */
  name: string;
  /** What this player owns: their keep, or their stripes. */
  owns: GroupSel;
  /** keeps: the king blocks (every one down: this side loses). Absent: the keep falls under DuelDef.fallShare. */
  king?: GroupSel;
  /** Launcher azimuths this player fires from, [from, to] in 0.5 deg (shots.ts LaunchShot.az), inclusive; from > to wraps through 0. */
  arc: [number, number];
  /** This player's shots. */
  rack: RackItem[];
  /** The owner ink their blocks are tinted with, linear RGB 0 to 1. */
  ink: [number, number, number];
}

export interface DuelDef {
  id: string;
  name: string;
  ruleset: Ruleset;
  /** The table: structure, lot, launcher ring. Its own rack is replaced by the sides' (duelLevel). */
  level: LevelDef;
  sides: [DuelSide, DuelSide];
  /** keeps without a king: a keep with no more than this share standing has fallen (default 0.5). */
  fallShare?: number;
  /** Real seconds a turn runs at its own pace before the page fast-forwards the rest of its settle (default 8). */
  turnSeconds?: number;
}

export type Player = 0 | 1;
export const DEFAULT_TURN_SECONDS = 8;
export const DEFAULT_FALL_SHARE = 0.5;

/** azimuth az (0.5 deg) lies in arc, wrapping through 0 when from > to. */
export const inArc = (az: number, [from, to]: [number, number]): boolean => (from <= to ? az >= from && az <= to : az >= from || az <= to);

/**
 * The level a duel plays: the table with both racks in turn order from `first` (A, B, A, B, ...;
 * the longer rack's extra shots last), scored on outcome so that only the duel ends it, uncast and
 * marked custom (a duel has no stars). Who goes first is part of the level, so a rematch with the
 * other player first is a different (level, shots) record.
 */
export function duelLevel(def: DuelDef, first: Player = 0): LevelDef {
  const a = def.sides[first].rack, b = def.sides[1 - first as Player].rack, rack: RackItem[] = [];
  for (let k = 0; k < Math.max(a.length, b.length); k++) { if (k < a.length) rack.push(a[k]!); if (k < b.length) rack.push(b[k]!); }
  const { stars: _s, solutions: _x, ...table } = def.level;
  return { ...table, id: duelLevelId(def, first), name: def.name, scoring: 'outcome', autobank: false, rack, par: rack.length, objective: { kind: 'collapse', min: 0 }, custom: true };
}

/** The id of a duel's level: the table's id with the first player first, `<id>-2` with the second (a rematch). */
export const duelLevelId = (def: DuelDef, first: Player): string => (first === 0 ? def.id : `${def.id}-2`);

/** Throws unless the duel is well formed against its compiled level (duelLevel), naming the fault. */
export function checkDuel(def: DuelDef, c: CompiledLevel): void {
  const where = `duel ${def.id}`;
  if (!(RULESETS as readonly string[]).includes(def.ruleset)) throw new Error(`${where}: ruleset must be ${RULESETS.join(' or ')}: ${def.ruleset}`);
  const owned = def.sides.map((s, k) => selectGroup(c, s.owns, `${where} sides[${k}].owns`));
  owned.forEach((g, k) => { if (!g.length) throw new Error(`${where}: side ${def.sides[k]!.name} owns no bodies`); });
  const a = new Set(owned[0]);
  if (owned[1]!.some((i) => a.has(i))) throw new Error(`${where}: the sides own bodies in common`);
  def.sides.forEach((s, k) => {
    const w = `${where} sides[${k}]`;
    if (!s.name.trim()) throw new Error(`${w}: name is empty`);
    if (!s.rack.length) throw new Error(`${w}: rack is empty`);
    for (const item of s.rack) if (!isRackItem(item)) throw new Error(`${w}: rack item ${item} is not an item`);
    if (!s.arc.every((x) => Number.isInteger(x) && x >= 0 && x < 720)) throw new Error(`${w}: arc needs azimuths 0 to 719`);
    if (s.king) {
      const king = selectGroup(c, s.king, `${w}.king`), mine = new Set(owned[k]);
      if (!king.length) throw new Error(`${w}: king holds no bodies`);
      if (!king.every((i) => mine.has(i))) throw new Error(`${w}: the king must be part of what the side owns`);
    }
    if (!s.ink.every((x) => x >= 0 && x <= 1)) throw new Error(`${w}: ink is linear RGB from 0 to 1`);
  });
  if (def.ruleset === 'heraldry' && def.sides.some((s) => s.king)) throw new Error(`${where}: heraldry has no kings`);
  const f = def.fallShare ?? DEFAULT_FALL_SHARE, t = def.turnSeconds ?? DEFAULT_TURN_SECONDS;
  if (!(f >= 0 && f < 1)) throw new Error(`${where}: fallShare must be from 0 to below 1: ${f}`);
  if (!(t > 0 && t <= 60)) throw new Error(`${where}: turnSeconds must be above 0 and at most 60: ${t}`);
}

/** One side as of the last settle. */
export interface SideState { standing: number; share: number; kingDown: boolean; points: number; shotsLeft: number }
export type DuelResult = { over: false } | { over: true; winner: Player | null; why: string };

/** Why a shot is refused, or null when the current player may fire it. */
export type Refusal = { why: 'over' | 'not-yours' | 'rack' | 'arc'; message: string } | null;

/**
 * The turn controller. `turn` is whose shot is next; `fired` gives the shot to its player;
 * `settled` judges the settle against the snapshot and passes the turn (to the other player
 * while they have shots, else back). Pure: no engine, no clock (the page owns the pace).
 */
export class Duel {
  turn: Player;
  /** The player whose shot is in the air (null while aiming). */
  shooter: Player | null = null;
  readonly left: [RackItem[], RackItem[]];
  readonly owned: [Int32Array, Int32Array];
  readonly kings: [Int32Array | null, Int32Array | null];
  sides: [SideState, SideState];
  result: DuelResult = { over: false };
  /** Each shot fired, by whom, in order. */
  readonly log: { player: Player; shot: Shot }[] = [];
  private last: [GroupReduction, GroupReduction] | null = null;

  constructor(readonly def: DuelDef, readonly level: CompiledLevel, readonly first: Player = 0, private readonly home: ArrayLike<number> = level.meta.home) {
    checkDuel(def, level);
    this.turn = first;
    this.left = [[...def.sides[0].rack], [...def.sides[1].rack]];
    this.owned = [selectGroup(level, def.sides[0].owns), selectGroup(level, def.sides[1].owns)];
    this.kings = [def.sides[0].king ? selectGroup(level, def.sides[0].king) : null, def.sides[1].king ? selectGroup(level, def.sides[1].king) : null];
    this.sides = [0, 1].map((k) => ({ standing: this.owned[k as Player].length, share: 1, kingDown: false, points: 0, shotsLeft: this.left[k as Player].length })) as [SideState, SideState];
  }

  get ruleset(): Ruleset { return this.def.ruleset; }

  /** Whether the current player may fire `shot` now, and if not why (for the HUD). */
  refuse(shot: Shot): Refusal {
    if (this.result.over) return { why: 'over', message: 'The duel is over' };
    if (this.shooter !== null) return { why: 'over', message: 'Wait for the last shot to settle' };
    const side = this.def.sides[this.turn], left = this.left[this.turn];
    if (!left.includes(shot.ammo)) return { why: 'rack', message: `${side.name} has no ${shot.ammo} left` };
    if ('az' in shot && !inArc(shot.az, side.arc)) return { why: 'arc', message: `${side.name} fires from its own side: turn the view` };
    return null;
  }

  /** The current player fired `shot` (refuse() said yes). */
  fired(shot: Shot): void {
    const r = this.refuse(shot);
    if (r) throw new Error(`duel: ${r.message}`);
    const left = this.left[this.turn];
    left.splice(left.indexOf(shot.ammo), 1);
    this.sides[this.turn].shotsLeft = left.length;
    this.shooter = this.turn;
    this.log.push({ player: this.turn, shot });
  }

  /** The shot in the air settled with the structure as in `s`: score it, decide the duel or pass the turn. */
  settled(s: Snapshot): DuelResult {
    if (this.shooter === null) throw new Error('duel: settled with no shot in the air');
    const p = this.shooter, q = (1 - p) as Player, c = this.level;
    const red: [GroupReduction, GroupReduction] = [reduceGroup(s, c, this.owned[0], this.home), reduceGroup(s, c, this.owned[1], this.home)];
    const before = this.last ?? [{ down: 0 }, { down: 0 }];
    if (this.ruleset === 'heraldry') this.sides[p].points += (red[q].down - before[q]!.down) - (red[p].down - before[p]!.down);
    for (const k of [0, 1] as const) {
      const side = this.sides[k], g = red[k], king = this.kings[k];
      side.standing = g.n - g.down;
      side.share = g.n ? side.standing / g.n : 0;
      side.kingDown = king !== null && reduceGroup(s, c, king, this.home).down === king.length;
    }
    this.last = red;
    this.shooter = null;
    this.result = this.judge(p);
    if (!this.result.over) this.turn = this.left[q].length ? q : p;
    return this.result;
  }

  private judge(shooter: Player): DuelResult {
    const [a, b] = this.sides, other = (1 - shooter) as Player, names = this.def.sides.map((s) => s.name);
    if (this.ruleset === 'keeps') {
      const fall = this.def.fallShare ?? DEFAULT_FALL_SHARE;
      const fallen = (k: Player) => (this.kings[k] ? this.sides[k].kingDown : this.sides[k].share <= fall);
      const fa = fallen(0), fb = fallen(1);
      // Both down in one shot: the shooter brought down their own too, and loses.
      if (fa && fb) return { over: true, winner: other, why: `${names[shooter]} toppled both keeps` };
      if (fa || fb) {
        const loser: Player = fa ? 0 : 1;
        return { over: true, winner: (1 - loser) as Player, why: loser === shooter ? `${names[loser]} toppled its own keep` : `${names[loser]}'s keep fell` };
      }
      if (a.shotsLeft + b.shotsLeft > 0) return { over: false };
      if (a.share === b.share) return { over: true, winner: null, why: 'both keeps stand alike' };
      const w: Player = a.share > b.share ? 0 : 1;
      return { over: true, winner: w, why: `${names[w]}'s keep stands taller` };
    }
    if (a.shotsLeft + b.shotsLeft > 0) return { over: false };
    if (a.points === b.points) return { over: true, winner: null, why: 'level on points' };
    const w: Player = a.points > b.points ? 0 : 1;
    return { over: true, winner: w, why: `${names[w]} scored more` };
  }
}
