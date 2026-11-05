// Side goals (docs/game/modes-roadmap.md, capability C3; mode M3 Lot Sheet):
// a level's hand-written challenges beside its objective, each a predicate
// over what the round left behind ("clear it with marbles only", "bring the
// north tower down and leave the south one standing"). A predicate is plain
// JSON data, so a lot sheet is a data file, not code, and a goal reads the same
// in the game, in tests and in a proof replay.
//
// Goals are judged on a round as it stands at a settle (provisionally, for the
// HUD) and at its end (for the record): the session's per-shot outcomes, its
// sticky heritage and crown state, and the end snapshot reduced by groups.ts.
// They never feed the level's score or stars, so a lot sheet can be added to
// any level without touching its hash or its casts.
import type { Quat, Snapshot, Vec3 } from '@tb/engine-api';
import { type GroupReduction, type GroupSel, reduceGroups, selectGroups } from './groups.ts';
import type { CompiledLevel, StarMetric } from './level.ts';
import { collapseFraction, floorPotential_mJ, homePotential_mJ, homeSkyline } from './outcome.ts';
import { isRackItem, type RackItem } from './rack.ts';
import { aabbTop, HEIGHT_BINS, leverage, type LevelScore, outsideLot, potential_mJ, type ShotOutcome, skyline } from './rules.ts';
import type { Phase } from './session.ts';
import { readShots, type Shot } from './shots.ts';

/** Whole-round facts a goal can test. */
export const ROUND_FACTS = ['cleared', 'shots', 'rackLeft', 'collapse', 'crowns', 'crownsLeft', 'heritage', 'leverage', 'comboMax', 'outOfLot', 'skyline', 'score', 'stars'] as const;
export type RoundFact = (typeof ROUND_FACTS)[number];
/** Facts of one fired shot (ShotOutcome fields). */
export const SHOT_FACTS = ['crownsDown', 'leverage', 'heritageNew', 'displaced'] as const;
export type ShotFact = (typeof SHOT_FACTS)[number];
/** What a group term measures: a share of the group's bodies (0 to 1), or with `count` the number of them. */
export const GROUP_FACTS = ['down', 'displaced', 'outOfLot', 'standing'] as const;
export type GroupFact = (typeof GROUP_FACTS)[number];
export const OPS = ['>=', '<=', '>', '<', '=='] as const;
export type Op = (typeof OPS)[number];

/**
 * One test. `fact`: a whole-round fact (see RoundFacts). `group`: a named group of the sheet, as a
 * share of its bodies unless `count`. `used`: how many shots fired this rack item ('any': all shots).
 * `shot`: a fact of the k-th shot fired (1 = the first; a shot not fired fails the test).
 */
export type GoalTerm =
  | { fact: RoundFact; op: Op; value: number }
  | { group: string; of: GroupFact; count?: boolean; op: Op; value: number }
  | { used: RackItem | 'any'; op: Op; value: number }
  | { shot: number; fact: ShotFact; op: Op; value: number };
export type GoalPred = GoalTerm | { all: GoalPred[] } | { any: GoalPred[] } | { not: GoalPred };

export interface Goal {
  /** Short id, unique in its sheet: 1 to 24 lower case letters, digits and dashes. Progress records goals by it. */
  id: string;
  /** What the player reads. */
  text: string;
  when: GoalPred;
  /**
   * A line (writeShots text) that meets the goal, recorded once: tests replay it on the engine named by
   * the sheet, so a goal nobody can meet never ships as proven. Absent: unproven (the game hides it
   * unless ?keystone.goals=all).
   */
  proof?: string;
}

/**
 * Five grade bands from a level's cast cloud (docs/game/levels/<id>.md): the competent plays'
 * P10, P25, P50, P75 and P90 on the star metric. A round's grade is the best band it reaches:
 * E at P10 up to A at P90 (lower is better for skyline).
 */
export interface Grades { metric: StarMetric; cuts: [number, number, number, number, number]; source: string }
export const GRADE_NAMES = ['E', 'D', 'C', 'B', 'A'] as const;
export type Grade = (typeof GRADE_NAMES)[number];

/** A level's side goals. `engine` names what the proofs were played on ('ref': the f64 reference; 'gpu'). */
export interface LotSheet { level: string; engine: 'ref' | 'gpu'; groups?: Record<string, GroupSel>; goals: Goal[]; grades?: Grades }

/** Most goals a sheet holds (the design's five, with room). */
export const MAX_GOALS = 8;
const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** A round as goals see it: a Session (live or ended) or a lab PlayResult's session has these. */
export interface RoundState {
  phase: Phase;
  rackLeft: readonly RackItem[];
  outcomes: readonly ShotOutcome[];
  inputs: readonly { step: number; shot: Shot }[];
  crownDown: Uint8Array;
  heritageBroken: Uint8Array;
  score: LevelScore | null;
  home: Float64Array;
}

/** Everything a goal can test about one round, computed once. */
export interface RoundFacts {
  round: Record<RoundFact, number>;
  shots: readonly ShotOutcome[];
  used: Readonly<Record<string, number>>;
  groups: Readonly<Record<string, GroupReduction>>;
}

/**
 * The facts of a round whose structure stands as in `s` (the snapshot at its last settle or end).
 * `groups` from selectGroups. crowns and crownsLeft count crowns down and still up at the last
 * settle; collapse, outOfLot (a share of the structure) and skyline (end over start) are read off s.
 */
export function roundFacts(c: CompiledLevel, r: RoundState, s: Snapshot, groups: Readonly<Record<string, Int32Array>> = {}): RoundFacts {
  const m = c.meta, home = r.home;
  const pe0 = homePotential_mJ(c, home), pe = potential_mJ(s, c);
  const fired = r.outcomes.reduce((a, o) => a + o.ke + o.yield, 0);
  const crowns = r.crownDown.reduce((a, x) => a + x, 0);
  let out = 0;
  const hist = new Uint32Array(HEIGHT_BINS), top = Math.max(c.height, 1e-9);
  for (let i = 0; i < m.n; i++) {
    if (outsideLot(c, s.pos[3 * i]!, s.pos[3 * i + 2]!, 0.5 * c.frame.unit)) out++;
    const q = Array.from(s.rot.subarray(4 * i, 4 * i + 4)) as Quat, half = Array.from(m.half.subarray(3 * i, 3 * i + 3)) as Vec3;
    hist[Math.max(0, Math.min(HEIGHT_BINS - 1, Math.floor((HEIGHT_BINS * aabbTop(s.pos[3 * i + 1]!, q, half)) / top)))]!++;
  }
  const start = homeSkyline(c, home);
  const used: Record<string, number> = { any: r.inputs.length };
  for (const { shot } of r.inputs) used[shot.ammo] = (used[shot.ammo] ?? 0) + 1;
  return {
    round: {
      cleared: r.phase === 'cleared' ? 1 : 0,
      shots: r.outcomes.length,
      rackLeft: r.rackLeft.length,
      collapse: collapseFraction(pe0, pe, floorPotential_mJ(c)),
      crowns, crownsLeft: m.crowns.length - crowns,
      heritage: r.heritageBroken.reduce((a, x) => a + x, 0),
      leverage: leverage(pe0 - pe, fired),
      comboMax: Math.max(0, ...r.outcomes.map((o) => o.crownsDown)),
      outOfLot: m.n ? out / m.n : 0,
      skyline: start > 0 ? skyline(hist, c.height) / start : 1,
      score: r.score?.total ?? 0,
      stars: r.score?.stars ?? 0,
    },
    shots: r.outcomes, used, groups: reduceGroups(s, c, groups, home),
  };
}

const compare = (a: number, op: Op, b: number): boolean => {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    case '==': return a === b;
  }
};

/** The value a term reads, or NaN when it reads a shot not fired (the term then fails, whatever its op). */
function termValue(t: GoalTerm, f: RoundFacts): number {
  if ('group' in t) {
    const g = f.groups[t.group];
    if (!g) throw new Error(`goal reads group ${t.group}, which the sheet does not select`);
    const k = t.of === 'standing' ? g.n - g.down : g[t.of];
    return t.count ? k : g.n ? k / g.n : 0;
  }
  if ('used' in t) return f.used[t.used] ?? 0;
  if ('shot' in t) {
    const o = f.shots[t.shot - 1];
    return o ? o[t.fact] : NaN;
  }
  return f.round[t.fact];
}

/** Whether pred holds for a round with facts f. */
export function goalMet(pred: GoalPred, f: RoundFacts): boolean {
  if ('all' in pred) return pred.all.every((p) => goalMet(p, f));
  if ('any' in pred) return pred.any.some((p) => goalMet(p, f));
  if ('not' in pred) return !goalMet(pred.not, f);
  const v = termValue(pred, f);
  return !Number.isNaN(v) && compare(v, pred.op, pred.value);
}

/** The grade a round reaches on its sheet's grades (null below E, or when the sheet has none). */
export function gradeOf(g: Grades | undefined, f: RoundFacts): Grade | null {
  if (!g) return null;
  const v = g.metric === 'crowns' ? f.round.crowns : g.metric === 'skyline' ? f.round.skyline : g.metric === 'score' ? f.round.score : f.round.collapse;
  let best = -1;
  g.cuts.forEach((t, k) => { if (g.metric === 'skyline' ? v <= t : v >= t) best = k; });
  return best < 0 ? null : GRADE_NAMES[best]!;
}

/** Which goals a round meets, in sheet order. */
export function judgeGoals(sheet: LotSheet, f: RoundFacts, goals: readonly Goal[] = sheet.goals): { id: string; met: boolean }[] {
  return goals.map((g) => ({ id: g.id, met: goalMet(g.when, f) }));
}

/** The goals a page shows: the proven ones, or every one with `all` (?keystone.goals=all). */
export const shownGoals = (sheet: LotSheet, all = false): Goal[] => sheet.goals.filter((g) => all || g.proof !== undefined);

/**
 * Throws unless the sheet is well formed for level c, naming the goal and field at fault: its level
 * id, groups (groups.ts checkGroup), ids unique and well formed, every term's fact, op, group, item
 * (in the rack) and shot index (within the rack), proofs that parse and fit the rack, and grades in order.
 */
export function checkLotSheet(c: CompiledLevel, sheet: LotSheet): void {
  const where = `lot sheet ${sheet.level}`;
  if (sheet.level !== c.def.id) throw new Error(`${where}: is for ${sheet.level}, not ${c.def.id}`);
  if (sheet.engine !== 'ref' && sheet.engine !== 'gpu') throw new Error(`${where}: engine must be ref or gpu: ${String(sheet.engine)}`);
  const groups = selectGroups(c, sheet.groups ?? {});
  for (const [k, idx] of Object.entries(groups)) if (!idx.length) throw new Error(`${where}: groups.${k} holds no bodies`);
  if (!sheet.goals.length || sheet.goals.length > MAX_GOALS) throw new Error(`${where}: needs 1 to ${MAX_GOALS} goals, has ${sheet.goals.length}`);
  const ids = new Set<string>(), rack = c.def.rack;
  const term = (t: GoalPred, w: string): void => {
    if (typeof t !== 'object' || t === null) throw new Error(`${w}: not a predicate`);
    if ('all' in t || 'any' in t) {
      const list = 'all' in t ? t.all : t.any;
      if (!Array.isArray(list) || !list.length) throw new Error(`${w}: all/any needs a non-empty list`);
      list.forEach((p, i) => term(p, `${w}[${i}]`));
      return;
    }
    if ('not' in t) return term(t.not, `${w}.not`);
    if (!(OPS as readonly unknown[]).includes(t.op)) throw new Error(`${w}: op must be one of ${OPS.join(' ')}: ${String(t.op)}`);
    if (typeof t.value !== 'number' || !Number.isFinite(t.value)) throw new Error(`${w}: value must be a finite number`);
    if ('group' in t) {
      if (!Object.hasOwn(groups, t.group)) throw new Error(`${w}: no group ${t.group} in the sheet`);
      if (!(GROUP_FACTS as readonly unknown[]).includes(t.of)) throw new Error(`${w}: of must be one of ${GROUP_FACTS.join(', ')}: ${String(t.of)}`);
    } else if ('used' in t) {
      if (t.used !== 'any' && !(isRackItem(t.used) && rack.includes(t.used))) throw new Error(`${w}: used ${t.used} is not in ${c.def.id}'s rack (${rack.join(', ')})`);
    } else if ('shot' in t) {
      if (!(Number.isInteger(t.shot) && t.shot >= 1 && t.shot <= rack.length)) throw new Error(`${w}: shot must be from 1 to ${rack.length}: ${t.shot}`);
      if (!(SHOT_FACTS as readonly unknown[]).includes(t.fact)) throw new Error(`${w}: shot fact must be one of ${SHOT_FACTS.join(', ')}: ${String(t.fact)}`);
    } else if (!(ROUND_FACTS as readonly unknown[]).includes((t as { fact?: unknown }).fact)) {
      throw new Error(`${w}: fact must be one of ${ROUND_FACTS.join(', ')}: ${String((t as { fact?: unknown }).fact)}`);
    }
  };
  for (const g of sheet.goals) {
    const w = `${where} goal ${g.id}`;
    if (!GOAL_ID.test(g.id)) throw new Error(`${w}: id must be 1 to 24 lower case letters, digits and dashes`);
    if (ids.has(g.id)) throw new Error(`${w}: id used twice`);
    ids.add(g.id);
    if (!g.text.trim()) throw new Error(`${w}: text is empty`);
    term(g.when, `${w}.when`);
    if (g.proof !== undefined) {
      const shots = readShots(g.proof);
      if (!shots.length) throw new Error(`${w}: proof is empty`);
      for (const ammo of new Set(shots.map((s) => s.ammo))) {
        const want = shots.filter((s) => s.ammo === ammo).length, have = rack.filter((a) => a === ammo).length;
        if (want > have) throw new Error(`${w}: proof fires ${want} ${ammo}, the rack holds ${have}`);
      }
    }
  }
  if (sheet.grades) {
    const { cuts, metric } = sheet.grades;
    if (cuts.length !== 5 || !cuts.every(Number.isFinite)) throw new Error(`${where}: grades need 5 finite cuts`);
    for (let k = 1; k < 5; k++) if (metric === 'skyline' ? cuts[k]! > cuts[k - 1]! : cuts[k]! < cuts[k - 1]!) throw new Error(`${where}: grade cuts must get harder from E to A`);
  }
}
