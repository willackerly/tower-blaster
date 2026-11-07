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
 * of them down) and you win; topple your own and you lose. With both racks spent, the fort with
 * more of itself standing wins.
 * heraldry: one shared tower in two players' colours. Each shot scores the rival's blocks it brought
 * down, less your own; with both racks spent, or the tower down to DuelDef.endShare, the higher score wins
 * (level scores: the side that brought down more of the other's blocks).
 *
 * Both rulesets decide only at the end of a round (the 2026-11-06 agent playtest, PT5: one shot ended
 * a duel before the other player ever fired). While a side that has fired fewer shots has shots left,
 * it answers first: a keep that falls to the first shot of a round wins only if the answer does not
 * bring the other keep down too (then the round is a draw). Only when both keeps are already down is
 * there nothing left to answer.
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
  /** heraldry: with no more than this share of the tower standing at the end of a round, the duel ends on points (default 0.15). */
  endShare?: number;
}

export type Player = 0 | 1;
export const DEFAULT_TURN_SECONDS = 8;
export const DEFAULT_FALL_SHARE = 0.5;
/** Heraldry ends once the tower is down to this share standing (PT5: at 5% standing the last shots had nothing to hit). */
export const DEFAULT_END_SHARE = 0.15;

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
  const f = def.fallShare ?? DEFAULT_FALL_SHARE, t = def.turnSeconds ?? DEFAULT_TURN_SECONDS, e = def.endShare ?? DEFAULT_END_SHARE;
  if (!(f >= 0 && f < 1)) throw new Error(`${where}: fallShare must be from 0 to below 1: ${f}`);
  if (!(e >= 0 && e < 1)) throw new Error(`${where}: endShare must be from 0 to below 1: ${e}`);
  if (!(t > 0 && t <= 60)) throw new Error(`${where}: turnSeconds must be above 0 and at most 60: ${t}`);
}

/**
 * One side as of the last settle. `fired`: shots this side has fired; `fellOn`: the shot (index in Duel.log) its keep fell
 * on, or null while it stands; `struck`: the rival's blocks its shots brought down (heraldry's tie-break).
 */
export interface SideState { standing: number; share: number; kingDown: boolean; points: number; shotsLeft: number; fired: number; fellOn: number | null; struck: number }
/** The last settled shot: who fired it, the rival's blocks and the shooter's own it brought down, and (heraldry) the points it scored. */
export interface ShotTally { player: Player; rival: number; own: number; points: number }
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
  /** The last settled shot's tally, or null before the first settle. */
  lastShot: ShotTally | null = null;
  private last: [GroupReduction, GroupReduction] | null = null;

  constructor(readonly def: DuelDef, readonly level: CompiledLevel, readonly first: Player = 0, private readonly home: ArrayLike<number> = level.meta.home) {
    checkDuel(def, level);
    this.turn = first;
    this.left = [[...def.sides[0].rack], [...def.sides[1].rack]];
    this.owned = [selectGroup(level, def.sides[0].owns), selectGroup(level, def.sides[1].owns)];
    this.kings = [def.sides[0].king ? selectGroup(level, def.sides[0].king) : null, def.sides[1].king ? selectGroup(level, def.sides[1].king) : null];
    this.sides = [0, 1].map((k) => ({ standing: this.owned[k as Player].length, share: 1, kingDown: false, points: 0, shotsLeft: this.left[k as Player].length, fired: 0, fellOn: null, struck: 0 })) as [SideState, SideState];
  }

  get ruleset(): Ruleset { return this.def.ruleset; }

  /** The player who still owes an answer this round (fewer shots fired, shots left), or null at a round's end. */
  get answering(): Player | null {
    const [a, b] = this.sides;
    if (a.fired < b.fired && a.shotsLeft > 0) return 0;
    if (b.fired < a.fired && b.shotsLeft > 0) return 1;
    return null;
  }

  /** The whole contest's share standing: both sides' blocks together (heraldry's tower). */
  get standingShare(): number {
    const n = this.owned[0].length + this.owned[1].length;
    return n ? (this.sides[0].standing + this.sides[1].standing) / n : 0;
  }

  /** Whether side k's keep has fallen (keeps): its king down, or, kingless, its share down to fallShare. */
  fallen(k: Player): boolean {
    return this.kings[k] ? this.sides[k].kingDown : this.sides[k].share <= (this.def.fallShare ?? DEFAULT_FALL_SHARE);
  }

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
    this.sides[this.turn].fired++;
    this.shooter = this.turn;
    this.log.push({ player: this.turn, shot });
  }

  /** The shot in the air settled with the structure as in `s`: score it, decide the duel or pass the turn. */
  settled(s: Snapshot): DuelResult {
    if (this.shooter === null) throw new Error('duel: settled with no shot in the air');
    const p = this.shooter, q = (1 - p) as Player, c = this.level;
    const red: [GroupReduction, GroupReduction] = [reduceGroup(s, c, this.owned[0], this.home), reduceGroup(s, c, this.owned[1], this.home)];
    const before = this.last ?? [{ down: 0 }, { down: 0 }];
    const rival = red[q].down - before[q]!.down, own = red[p].down - before[p]!.down;
    const points = this.ruleset === 'heraldry' ? rival - own : 0;
    this.sides[p].points += points;
    this.sides[p].struck += rival;
    this.lastShot = { player: p, rival, own, points };
    for (const k of [0, 1] as const) {
      const side = this.sides[k], g = red[k], king = this.kings[k];
      side.standing = g.n - g.down;
      side.share = g.n ? side.standing / g.n : 0;
      side.kingDown = king !== null && reduceGroup(s, c, king, this.home).down === king.length;
      if (this.ruleset === 'keeps' && side.fellOn === null && this.fallen(k)) side.fellOn = this.log.length - 1;
    }
    this.last = red;
    this.shooter = null;
    this.result = this.judge();
    if (!this.result.over) this.turn = this.answering ?? (this.left[q].length ? q : p);
    return this.result;
  }

  /** The duel at a settle: decided at a round's end (no answer owed), or at once when both keeps are down. */
  private judge(): DuelResult {
    const [a, b] = this.sides, names = this.def.sides.map((s) => s.name), spent = a.shotsLeft + b.shotsLeft === 0;
    if (this.ruleset === 'keeps') {
      const fa = a.fellOn !== null, fb = b.fellOn !== null;
      if (!(fa && fb) && this.answering !== null) return { over: false };
      if (fa && fb) {
        // Both down on one shot: its shooter brought down their own too, and loses. On two shots of a round: a draw.
        if (a.fellOn === b.fellOn) {
          const shooter = this.log[a.fellOn!]!.player;
          return { over: true, winner: (1 - shooter) as Player, why: `${names[shooter]} toppled both keeps` };
        }
        return { over: true, winner: null, why: 'both keeps fell in one round' };
      }
      if (fa || fb) {
        const loser: Player = fa ? 0 : 1, by = this.log[this.sides[loser].fellOn!]!.player;
        return { over: true, winner: (1 - loser) as Player, why: by === loser ? `${names[loser]} toppled its own keep` : `${names[loser]}'s keep fell` };
      }
      if (!spent) return { over: false };
      if (a.share === b.share) return { over: true, winner: null, why: 'both keeps stand alike' };
      const w: Player = a.share > b.share ? 0 : 1;
      return { over: true, winner: w, why: `${names[w]}'s keep stands taller` };
    }
    const down = this.standingShare <= (this.def.endShare ?? DEFAULT_END_SHARE);
    if (!spent && !(down && this.answering === null)) return { over: false };
    const tail = down && !spent ? ', the tower is down' : '';
    // Level on points: the side that brought down more of the other's blocks wins (a bolder level score); else a draw.
    if (a.points === b.points) {
      if (a.struck === b.struck) return { over: true, winner: null, why: `level on points${tail}` };
      const w: Player = a.struck > b.struck ? 0 : 1;
      return { over: true, winner: w, why: `level on points, ${names[w]} brought down more${tail}` };
    }
    const w: Player = a.points > b.points ? 0 : 1;
    return { over: true, winner: w, why: `${names[w]} scored more${tail}` };
  }
}
