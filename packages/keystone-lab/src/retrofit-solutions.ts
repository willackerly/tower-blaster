// Aftershock's recorded retrofits (M7b, docs/game/aftershock.md "Retrofit"): for each shipped retrofit level, one
// bracing per family the retrofit search found robust (retrofit-search.ts, at least ROBUST of NUDGES nudged builds
// keep every protected tower standing on the reference), and the obvious wrong builds, which must not. Programs,
// not part lists: each brace goes through the real build tool (BuildSession: face hits, snap, overlap and budget),
// so a replay checks the bin and the budget as well as the physics. The first bracing of each level is its
// three-star line (the cheapest the search found); the second is the other family's cheapest, its two-star line.
// Replayed on the reference (test/retrofit-ref-*.test.ts) and on the GPU (test/retrofit-gpu-*.test.ts).
import { type LevelDef, RETROFIT_SITES } from '@tb/keystone';
import { type Brace, braceSteps, bracedLevel, crossBraced, type Family } from './retrofit-search.ts';
import type { BuildStep } from './rube.ts';

export interface RetrofitBuild { label: string; family: Family | 'none' | 'across'; braces: Brace[] }

const tie = (tower: number, dir: -1 | 1 = 1): Brace => ({ tower, kind: 'tie', dir, item: 'plank' });
const pier = (tower: number, k: number): Brace => ({ tower, kind: 'buttress', k });

/** Each shipped retrofit level's site (keystone RETROFIT_SITES), by level id. */
export const RETROFIT_SITE_OF: Record<string, string> = { A6: 'RC-1', A7: 'RC-2', A8: 'RC-3' };

/** The robust bracings, by level id: the cheapest first (the third star), then the other family's cheapest (the second). */
export const RETROFIT_SOLUTIONS: Record<string, RetrofitBuild[]> = {
  A6: [
    { label: 'a plank from each column\'s top onto its hall', family: 'tie', braces: [tie(0), tie(2), tie(4)] },
    { label: 'piers beside each column along the quake, two, two and three high', family: 'buttress', braces: [pier(0, 2), pier(2, 2), pier(4, 3)] },
  ],
  A7: [
    { label: 'a plank onto the hall along the quake from the two columns that have one, piers two high beside the two that do not', family: 'tie', braces: [tie(0), pier(3, 2), tie(5), pier(8, 2)] },
    { label: 'piers two high beside every column along the quake', family: 'buttress', braces: [pier(0, 2), pier(3, 2), pier(5, 2), pier(8, 2)] },
  ],
  A8: [
    { label: 'a plank onto its hall from each of the four columns that have one, piers two high beside the two that do not', family: 'tie', braces: [tie(0), pier(2, 2), tie(3), tie(5), tie(7), pier(10, 2)] },
    { label: 'piers beside every column along the quake, three high beside the two tall columns of the front row, two elsewhere', family: 'buttress', braces: [pier(0, 3), pier(2, 2), pier(3, 3), pier(5, 2), pier(7, 2), pier(10, 2)] },
  ],
};

/** The wrong builds, by level id: none may keep every protected tower standing. */
export const RETROFIT_WRONG: Record<string, RetrofitBuild[]> = Object.fromEntries(Object.keys(RETROFIT_SITE_OF).map((id) => {
  const site = RETROFIT_SITES[RETROFIT_SITE_OF[id]!]!, prot = site.towers.flatMap((t, i) => (t.role === 'protected' ? [i] : []));
  return [id, [
    { label: 'nothing placed', family: 'none', braces: [] },
    { label: 'piers of three beside every column, across the quake', family: 'across', braces: prot.map((i) => pier(i, 3)) },
  ]];
}));

/** The level braced as `b` braces it, and what it cost; throws when the build tool refuses a step. */
export function retrofitBuild(def: LevelDef, b: RetrofitBuild): { def: LevelDef; spent: number } {
  const site = RETROFIT_SITES[RETROFIT_SITE_OF[def.id]!]!;
  const r = b.family === 'across' ? crossBraced(def, site, b.braces) : bracedLevel(def, site, b.braces);
  if (!r) throw new Error(`${def.id}: the build tool refused "${b.label}"`);
  return r;
}

/** A recorded bracing as build-tool steps (retrofit-search braceSteps); throws when the build tool refuses a step. */
export function retrofitSteps(def: LevelDef, b: RetrofitBuild): BuildStep[] {
  if (b.family === 'across') throw new Error(`${def.id}: "${b.label}" is braced for a turned quake; it has no steps on the level as it is`);
  const steps = braceSteps(def, RETROFIT_SITES[RETROFIT_SITE_OF[def.id]!]!, b.braces);
  if (!steps) throw new Error(`${def.id}: the build tool refused "${b.label}"`);
  return steps;
}
