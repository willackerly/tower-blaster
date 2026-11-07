// Aftershock's seeded dial (PT25, docs/game/aftershock.md "The dial's starting quake"): where a level's quake dial
// starts. Agent playtest round 2 found every level loading the same dial (0.3 g, 1 Hz, 3 s along x), which on Big
// Brother (A2) fells nothing for 7 s and scores 0: a newcomer who presses Start learns nothing. A level's seed is a
// quake that does part of the job: it fells at least one condemned tower, breaks fewer protected towers than it
// fells (so the round scores above 0), and does not clear the level (the levers are still the player's to find).
//
// The search, on the reference engine: candidate quakes on the dial's own stops, nearest the old start first; each
// screened on one nudged build, the nearest few that pass confirmed on NUDGES builds, where a seed must do part of the
// job on at least ROBUST of them and clear the level on at most BARE_MAX. The seed is the nearest confirmed quake to
// the old start, so the dial starts as close as it can to where it always did, but on a quake that does something.
import { type CompiledLevel, compileLevel, type LevelDef, quakeRefusal, quakeRulesOf, type QuakeShot } from '@tb/keystone';
import { type EngineSpec } from './engines.ts';
import { playQuakeTasks, quake, type QuakeEnd, siteTops } from './quake-search.ts';

export const SEED_NUDGES = 8, SEED_ROBUST = 7, SEED_CLEAR_MAX = 1;
/** The dial's old start, which every level loaded before PT25 (quake-panel.ts dialStart). */
export const OLD_START = quake(30, 10, 30, 0);

const PEAKS = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const HZ = [3, 4, 5, 6, 8, 10, 12, 15, 20];
const SEC = [10, 15, 20, 30, 40];

/** Dial steps from the old start: strength by 5% g, frequency and duration by stops, the axis by 15 degrees. */
export function dialDistance(q: QuakeShot, from: QuakeShot = OLD_START): number {
  const i = (xs: readonly number[], v: number) => xs.indexOf(v);
  const da = Math.min(Math.abs(q.axis - from.axis), 180 - Math.abs(q.axis - from.axis)) / 15;
  return Math.abs(q.peak - from.peak) / 5 + Math.abs(i(HZ, q.hz) - i(HZ, from.hz)) + Math.abs(i(SEC, q.sec) - i(SEC, from.sec)) + da;
}

/** The level's candidate seeds inside its rules and budget, nearest the old start first (ties: less energy, by peak). */
export function seedCandidates(def: LevelDef, limit: number): QuakeShot[] {
  const c = compileLevel(def), r = quakeRulesOf(def), axes = r.axisStep <= 90 ? [0, 90, ...(r.axisStep <= 45 ? [45, 135] : [])] : [0];
  const all: QuakeShot[] = [];
  for (const p of PEAKS) for (const h of HZ) for (const s of SEC) for (const a of axes) {
    const q = quake(p, h, s, a);
    if (quakeRefusal(c, q) === null) all.push(q);
  }
  return all.sort((a, b) => dialDistance(a) - dialDistance(b) || a.peak - b.peak || a.sec - b.sec || a.hz - b.hz || a.axis - b.axis).slice(0, limit);
}

/** What one quake did on one build: condemned towers down, protected towers broken, and whether it cleared the level. */
export function partial(c: CompiledLevel, e: QuakeEnd): { down: number; broken: number; met: boolean; part: boolean } {
  const tops = siteTops(c).map((t) => t.body);
  let down = 0, broken = 0;
  tops.forEach((b, i) => { if (c.meta.crowns.includes(b) && e.down[i]) down++; if (c.meta.heritage.includes(b) && !e.standing[i]) broken++; });
  return { down, broken, met: e.met, part: !e.met && down >= 1 && broken < down };
}

export interface SeedResult { id: string; seed: QuakeShot | null; distance: number; part: number; cleared: number; n: number; screened: number; confirmed: number; wallS: number }

/** The level's seed: the nearest candidate to the old start that does part of the job on SEED_ROBUST of SEED_NUDGES builds. */
export async function searchSeed(def: LevelDef, o: { jobs: number; screen?: number; confirm?: number; spec?: EngineSpec; log?: (l: string) => void }): Promise<SeedResult> {
  const t0 = performance.now(), c = compileLevel(def), log = o.log ?? (() => {}), batch = o.confirm ?? 6;
  const cands = seedCandidates(def, o.screen ?? 400);
  // The screen: one nudged build, the candidates split across the jobs.
  const chunk = Math.ceil(cands.length / Math.max(1, o.jobs)), parts = Array.from({ length: Math.ceil(cands.length / chunk) }, (_, k) => cands.slice(k * chunk, (k + 1) * chunk));
  const screen = (await playQuakeTasks(def, parts.map((quakes) => ({ quakes, nudge: 1 })), o.jobs, o.spec)).flat();
  const passed = cands.filter((_, i) => partial(c, screen[i]!).part);
  log(`${def.id}: ${passed.length} of ${cands.length} candidates do part of the job on the screen build`);
  const nudges = Array.from({ length: SEED_NUDGES }, (_, k) => k + 1);
  // The confirm: the nearest passing candidates, a batch at a time, until one holds.
  for (let from = 0; from < passed.length; from += batch) {
    const top = passed.slice(from, from + batch), ends = await playQuakeTasks(def, nudges.map((nudge) => ({ quakes: top, nudge })), o.jobs, o.spec);
    for (const [i, q] of top.entries()) {
      const per = ends.map((e) => partial(c, e[i]!)), part = per.filter((p) => p.part).length, cleared = per.filter((p) => p.met).length;
      log(`${def.id}: ${JSON.stringify(q)} distance ${dialDistance(q)}: part of the job on ${part}/${SEED_NUDGES}, cleared ${cleared}`);
      if (part >= SEED_ROBUST && cleared <= SEED_CLEAR_MAX) {
        return { id: def.id, seed: q, distance: dialDistance(q), part, cleared, n: SEED_NUDGES, screened: cands.length, confirmed: from + i + 1, wallS: (performance.now() - t0) / 1000 };
      }
    }
  }
  return { id: def.id, seed: null, distance: NaN, part: 0, cleared: 0, n: SEED_NUDGES, screened: cands.length, confirmed: passed.length, wallS: (performance.now() - t0) / 1000 };
}
