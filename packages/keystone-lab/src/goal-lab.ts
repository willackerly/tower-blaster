// Side goals in the lab (docs/game/lot-sheets.md): explore a level's competent plays to see which
// facts a goal could ask for, and prove a lot sheet's goals by replaying each proof line and nudges of it.
import { type CompiledLevel, compileLevel, type Goal, goalMet, type LevelDef, type LotSheet, type RackItem, readShots, roundFacts, type RoundFacts, selectGroups, type Shot, writeShots } from '@tb/keystone';
import { competentIntents, intentShot, nudgeLine, rng, streamSeed } from './cast.ts';
import { engineSubsteps } from './engines.ts';
import type { PlayResult, Runner } from './runner.ts';

/** The facts of a lab play (runner.ts PlayResult) for a sheet's groups. */
export function playFacts(c: CompiledLevel, sheet: Pick<LotSheet, 'groups'>, r: PlayResult): RoundFacts {
  return roundFacts(c, r.session, r.snapshot, selectGroups(c, sheet.groups ?? {}));
}

export interface Explored { shots: string; facts: RoundFacts }

/**
 * n competent lines (cast.ts competentIntents, seeded), each played to its end: the raw material goals
 * are written from. `items` fires those rack items in that order instead of the whole rack in rack
 * order (a goal about the marbles needs lines that fire marbles first).
 */
export async function exploreGoals(level: LevelDef, sheet: Pick<LotSheet, 'groups'>, runner: Runner, n: number, seed = 1, items?: readonly RackItem[]): Promise<Explored[]> {
  const c = compileLevel(level), lines = exploreLines(level, n, seed, items, engineSubsteps(runner.spec));
  return Promise.all(lines.map(async (shots) => ({ shots: writeShots(shots), facts: playFacts(c, sheet, await runner.play(level, shots)) })));
}

/** The lines exploreGoals plays (no physics: the same seed always gives the same lines). */
export function exploreLines(level: LevelDef, n: number, seed: number, items: readonly RackItem[] | undefined, substeps: number): Shot[][] {
  const c = compileLevel(level);
  return competentIntents(c, n, seed).map((line) => (items ?? level.rack).map((item, k) => intentShot(c, { ...line[k % line.length]!, item }, substeps)));
}

/** A goal's proof as replayed: whether the line meets it, and how many of `nudges` hand-noise copies (cast.ts nudgeLine) do too. */
export interface GoalProof { id: string; proven: boolean; met: boolean; nudged: number; nudgedMet: number }

/**
 * Replays every proven goal of the sheet (and `nudges` nudged copies of its line, seeded per goal), on
 * the runner's engine. The roadmap's margin: a goal ships when its line meets it and at least 6 of 8
 * nudges do (marginOk).
 */
export async function proveSheet(level: LevelDef, sheet: LotSheet, runner: Runner, nudges = 0, seed = 1): Promise<GoalProof[]> {
  const c = compileLevel(level);
  const one = async (g: Goal): Promise<GoalProof> => {
    if (g.proof === undefined) return { id: g.id, proven: false, met: false, nudged: 0, nudgedMet: 0 };
    const line = readShots(g.proof), r = rng(streamSeed(seed, 'goal', g.id));
    const lines: Shot[][] = [line, ...Array.from({ length: nudges }, () => nudgeLine(line, r))];
    const met = await Promise.all(lines.map(async (l) => goalMet(g.when, playFacts(c, sheet, await runner.play(level, l)))));
    return { id: g.id, proven: true, met: met[0]!, nudged: nudges, nudgedMet: met.slice(1).filter(Boolean).length };
  };
  return Promise.all(sheet.goals.map(one));
}

/** The roadmap's margin for a proof: its line meets the goal and at least 3 in 4 nudges do (6 of 8). */
export const marginOk = (p: GoalProof): boolean => p.met && (p.nudged === 0 || p.nudgedMet >= Math.ceil(0.75 * p.nudged));
