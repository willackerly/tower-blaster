// Outcome scoring, the spectacle mode's (docs/game/spectacle-mode.md, sections
// 4 and 6): what came down, judged by measures that mean the same at 40 bodies
// and at 10k. Like rules.ts, everything is a pure function of observed state
// and the compiled level; energies are integer millijoules so any summation
// order (and a later GPU reduction) gives the same number.
import type { Vec3 } from '@tb/engine-api';
import { type CompiledLevel, lowerIsBetter, type Objective, type Scoring, type StarMetric, type StarsDef } from './level.ts';
import { aabbTop, asideOf, floorTotal, HEIGHT_BINS, type LevelScore, peOf_mJ, type Reductions, type ScoreLine, skyline, spillOf } from './rules.ts';


/**
 * A fold level's collapse is the building's (docs/game/fuse-and-fold.md): heritage neighbours stand outside
 * it, and their mass would otherwise cap the fraction (stone houses beside a plaster frame held a felled
 * tower to 0.45), and a domino fuse's dominoes are props (M5b). Elsewhere the whole structure counts, as before.
 * `building` below: skip what rules.ts asideOf sets aside (heritage and props).
 */
export const buildingOnly = (c: CompiledLevel): boolean => c.def.objective.kind === 'fold';

/**
 * Floor energy PE_floor: every structure body lying flat on the ground on its largest face, so its
 * centre at its smallest half-extent. Static per level; the bottom of the collapse fraction's range.
 */
export function floorPotential_mJ(c: CompiledLevel, building = false): number {
  const m = c.meta, aside = asideOf(c);
  let pe = 0;
  for (let i = 0; i < m.n; i++) if (!building || !aside[i]) pe += peOf_mJ(m.mass[i]!, Math.min(m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!));
  return pe;
}

/** The structure's potential energy with its bodies at `home` (3 per body; default the authored poses): PE(B0) from the pre-settled home. */
export function homePotential_mJ(c: CompiledLevel, home: ArrayLike<number> = c.meta.home, building = false): number {
  let pe = 0;
  const aside = asideOf(c);
  for (let i = 0; i < c.meta.n; i++) if (!building || !aside[i]) pe += peOf_mJ(c.meta.mass[i]!, home[3 * i + 1]!);
  return pe;
}

/**
 * Collapse fraction D = clamp((PE(B0) - PE(end)) / (PE(B0) - PE_floor), 0, 1): the share of the
 * energy the structure could release that it did. Scale-free. 0 when there is nothing to bring down
 * (PE(B0) at or under the floor; validateLevel's `flat` issue).
 */
export function collapseFraction(pe0_mJ: number, peEnd_mJ: number, peFloor_mJ: number): number {
  const span = pe0_mJ - peFloor_mJ;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (pe0_mJ - peEnd_mJ) / span));
}

/** The skyline (rules.ts skyline) of the structure at `home` with its authored rotations, binned as reduceCpu bins. */
export function homeSkyline(c: CompiledLevel, home: ArrayLike<number> = c.meta.home): number {
  const hist = new Uint32Array(HEIGHT_BINS), top = Math.max(c.height, 1e-9), m = c.meta;
  for (let i = 0; i < m.n; i++) {
    const t = aabbTop(home[3 * i + 1]!, c.scene.bodies[i]!.rot, [m.half[3 * i]!, m.half[3 * i + 1]!, m.half[3 * i + 2]!] as Vec3);
    hist[Math.max(0, Math.min(HEIGHT_BINS - 1, Math.floor((HEIGHT_BINS * t) / top)))]!++;
  }
  return skyline(hist, c.height);
}

/** What an objective needs to know at a settle; heritage (bodies broken so far) only the fold and quake objectives read (absent: none). */
export interface ObjectiveFacts { red: Reductions; crownsTotal: number; collapse: number; heritage?: number; /** Fold levels: plunger charges whose host still stands (Session.misfires; absent: none). */ misfires?: number }

/**
 * Whether the objective is met. Par scoring keeps its rule (a skyline objective's footprintMax is part
 * of it); outcome scoring judges the objective alone, footprint costing points (outcomeTally).
 */
export function objectiveMet(c: CompiledLevel, f: ObjectiveFacts, scoring: Scoring, obj: Objective = c.def.objective): boolean {
  switch (obj.kind) {
    case 'crowns': return c.meta.crowns.length > 0 && f.crownsTotal === c.meta.crowns.length;
    case 'skyline': return skyline(f.red.heightHist, c.height) <= obj.maxH * c.frame.unit + 1e-9
      && (scoring === 'outcome' || obj.footprintMax === undefined || f.red.outOfLot <= obj.footprintMax * c.meta.n);
    case 'collapse': return f.collapse >= obj.min;
    case 'hold': return c.meta.crowns.length > 0 && f.crownsTotal === 0;
    case 'quake': return (c.meta.crowns.length > 0 || c.def.build !== undefined) && c.meta.heritage.length > 0 && f.crownsTotal === c.meta.crowns.length && (f.heritage ?? 0) === 0;
    case 'fold': return f.collapse >= obj.min && spillOf(f.red) <= obj.spillMax + 1e-12 && (f.heritage ?? 0) === 0 && (f.misfires ?? 0) === 0;
    case 'bell': return c.meta.crowns.length > 0 && f.crownsTotal === c.meta.crowns.length;
    // Mason's Trial: the judge decides (mason-judge.ts), from its worlds, never a settle.
    case 'trial': return false;
  }
}

// ---- Tally ----

/** The tally's weights, one table (re-fit after the playtest, not per level). */
export const OUTCOME_WEIGHTS = {
  objective: 1000,
  collapse: 3000,
  leverage: 300,
  combo: 50,
  /** Crowns down in one shot count up to this many. */
  comboCap: 12,
  rackLeft: 400,
  /** Hold levels: per share of the structure's mass pulled (all of it: 3000, as collapse). */
  pulled: 3000,
  /** Quake levels: per condemned tower down. */
  condemned: 500,
  heritage: -500,
  footprint: -3000,
  /** Fuse & Fold: per share of the building's mass outside its lot (all of it: -3000, as the footprint line). */
  spill: -3000,
  /** Fuse & Fold's domino fuses (M5b): per column a fuse never cut (its socket never fell): the round fails anyway. */
  misfire: -200,
  /** Aftershock retrofits: per unit of the build budget not spent, once the heritage stood (200 left: 2000). */
  budgetLeft: 10,
} as const;

/** What happened in an outcome level, as of its end. */
export interface OutcomeFacts {
  met: boolean;
  /** Collapse fraction D. */
  collapse: number;
  /** The round's leverage (roundLeverage: each shot's release over the energy fired, J per J), as the HUD and a par card read it. */
  leverage: number;
  /** Most crowns down in one shot (levels with crowns). */
  comboMax: number;
  hasCrowns: boolean;
  /** Rack items not fired. */
  rackLeft: number;
  heritageBroken: number;
  /** Fraction of structure bodies outside the lot grown by 0.5 h, and the level's limit (absent: none). */
  outOfLot: number;
  footprintMax?: number;
  /** Crowns down at the end, and the skyline at the end over the skyline at the start. */
  crownsDown: number;
  skylineRatio: number;
  /** Share of the structure's mass pulled (Undercut), 0 to 1. */
  pulled: number;
  /** The objective is hold (Undercut's Hollow): scored on what was pulled, not on what came down. */
  hold?: boolean;
  /** The objective is quake (Aftershock): scored on the condemned towers down, not on the collapse. */
  quake?: boolean;
  /** Energy fired over the round, J (each shot's ke + yield; a quake's is quakeEnergy): the energy metric. */
  energy?: number;
  /** Fold levels (Fuse & Fold): the building's spill at the end (rules.ts spillOf), 0 to 1; absent on other levels. */
  spill?: number;
  /** Fold levels: charges that never cut their column (a dead domino fuse, M5b: Session.misfires); any fails the objective. */
  misfires?: number;
  /** Build levels (a build block): what the player placed (build.ts placedCost) and the level's budget (absent: none). */
  built?: { spent: number; budget?: number };
}

const tri = (n: number) => (n * (n + 1)) / 2;

/** The tally lines (spectacle-mode.md, section 6), in display order; zero-value optional lines are left out. */
export function outcomeTally(f: OutcomeFacts, w = OUTCOME_WEIGHTS): ScoreLine[] {
  const lines: ScoreLine[] = [];
  if (f.met) lines.push({ label: 'Objective', value: w.objective });
  if (f.hold) {
    // Hollow: what you dared take while the crown stayed up. Nothing for coming down or for pulls not made.
    if (f.met) lines.push({ label: 'Pulled', value: Math.floor(w.pulled * f.pulled) });
    if (f.heritageBroken) lines.push({ label: 'Heritage', value: w.heritage * f.heritageBroken });
    if (f.footprintMax !== undefined && f.outOfLot > f.footprintMax) lines.push({ label: 'Footprint', value: Math.floor(w.footprint * (f.outOfLot - f.footprintMax)) });
    return lines;
  }
  if (f.quake) {
    // Aftershock: each condemned tower down and each protected one broken. No Collapse or Leverage line: both pay
    // for the protected towers coming down as well. The quake's economy is the stars' metric (energy) instead.
    if (f.hasCrowns) lines.push({ label: 'Condemned', value: w.condemned * f.crownsDown });
    // A retrofit (M7b): the bracing not spent, once the heritage stood (its stars are on what was spent: built).
    if (f.met && f.built?.budget !== undefined && f.built.budget > f.built.spent) lines.push({ label: 'Budget left', value: w.budgetLeft * (f.built.budget - f.built.spent) });
    if (f.heritageBroken) lines.push({ label: 'Heritage', value: w.heritage * f.heritageBroken });
    return lines;
  }
  lines.push({ label: 'Collapse', value: Math.floor(w.collapse * f.collapse) });
  lines.push({ label: 'Leverage', value: Math.floor(w.leverage * Math.log2(1 + f.leverage)) });
  if (f.hasCrowns) lines.push({ label: 'Combo', value: w.combo * tri(Math.min(Math.max(0, f.comboMax), w.comboCap)) });
  if (f.met && f.rackLeft > 0) lines.push({ label: 'Rack left', value: w.rackLeft * f.rackLeft });
  if (f.heritageBroken) lines.push({ label: 'Heritage', value: w.heritage * f.heritageBroken });
  if (f.footprintMax !== undefined && f.outOfLot > f.footprintMax) lines.push({ label: 'Footprint', value: Math.floor(w.footprint * (f.outOfLot - f.footprintMax)) });
  if (f.spill !== undefined && f.spill > 0) lines.push({ label: 'Spill', value: Math.floor(w.spill * f.spill) });
  if (f.misfires) lines.push({ label: 'Misfire', value: w.misfire * f.misfires });
  return lines;
}

/** Fuse & Fold's star metric: the collapse fraction discounted by the spill, collapse x (1 - spill), 0 to 1. */
export const foldValue = (collapse: number, spill: number): number => collapse * (1 - spill);

// ---- Stars ----

/** The star metric's value for an outcome; skyline is the only one where lower is better. */
export function metricValue(metric: StarMetric, f: OutcomeFacts, total: number): number {
  switch (metric) {
    case 'collapse': return f.collapse;
    case 'crowns': return f.crownsDown;
    case 'skyline': return f.skylineRatio;
    case 'score': return total;
    case 'pulled': return f.pulled;
    case 'energy': return f.energy ?? Infinity;
    case 'fold': return foldValue(f.collapse, f.spill ?? 0);
    case 'built': return f.built?.spent ?? Infinity;
  }
}

/** a at least as good as threshold t on this metric. */
export const atLeast = (metric: StarMetric, a: number, t: number) => (lowerIsBetter(metric) ? a <= t : a >= t);

export interface OutcomeStars {
  stars: 0 | 1 | 2 | 3;
  /** Strictly better than the best bot play the thresholds were cast from. */
  beatBot: boolean;
  /** No thresholds for this metric: only the objective's star can be earned. */
  uncast: boolean;
}

/**
 * Stars: none unless the objective is met; one for meeting it; two at t2; three at t3. Any heritage broken
 * then costs one star at every tier, down to none (PT28): a round that met the objective but broke heritage
 * scores one star fewer than the same round with it intact, so B2's novice (crowns down, 25 of the cathedral's
 * 32 cubes broken) ends on no star and its card leads with Retry. Before PT28 heritage cost only the third
 * star. Thresholds cast for another metric than the one played count as uncast.
 */
export function outcomeStars(cast: StarsDef | undefined, metric: StarMetric, value: number, met: boolean, heritageBroken: number): OutcomeStars {
  const uncast = !cast || cast.metric !== metric;
  if (!met) return { stars: 0, beatBot: false, uncast };
  const beatBot = !uncast && cast.best !== undefined && (lowerIsBetter(metric) ? value < cast.best : value > cast.best);
  const base = uncast ? 1 : atLeast(metric, value, cast.t3) ? 3 : atLeast(metric, value, cast.t2) ? 2 : 1;
  return { stars: (heritageBroken > 0 ? base - 1 : base) as 0 | 1 | 2 | 3, beatBot, uncast };
}

/** The stamp an outcome round that met its objective but broke heritage gets, in place of its gold one (PT28). */
export const HERITAGE_LOST = 'HERITAGE LOST';

/** An outcome level's score: what LevelScore holds for a par level, plus the outcome's own numbers. */
export interface OutcomeScore extends LevelScore {
  outcome: { collapse: number; metric: StarMetric; value: number } & OutcomeStars;
}

/**
 * Scores an outcome level's end. The stamp: INCOMPLETE when the objective is not met (TOPPLED on a
 * hold level), HERITAGE LOST when it was met with heritage broken (PT28: never a gold stamp then), BEAT
 * THE BOT past the best cast play, else how much came down ("72% DOWN"), or on a hold level how much was
 * pulled ("35% PULLED").
 */
export function outcomeScore(f: OutcomeFacts, cast: StarsDef | undefined, metric: StarMetric = cast?.metric ?? (f.hold ? 'pulled' : f.quake ? (f.built ? 'built' : 'energy') : 'collapse')): OutcomeScore {
  const lines = outcomeTally(f);
  const total = floorTotal(lines);
  const value = metricValue(metric, f, total);
  const s = outcomeStars(cast, metric, value, f.met, f.heritageBroken);
  // Heritage costs one star at every tier (outcomeStars); the card says how many it took.
  const lost = f.heritageBroken > 0 ? outcomeStars(cast, metric, value, f.met, 0).stars - s.stars : 0;
  const stamp = !f.met ? (f.hold ? 'TOPPLED' : 'INCOMPLETE') : f.heritageBroken > 0 ? HERITAGE_LOST : s.beatBot ? 'BEAT THE BOT' : f.hold ? `${Math.floor(100 * f.pulled)}% PULLED` : `${Math.floor(100 * f.collapse)}% DOWN`;
  return { lines, total, stars: s.stars, stamp, leverage: f.leverage, ...(lost > 0 ? { heritageStarsLost: lost } : {}), outcome: { collapse: f.collapse, metric, value, ...s } };
}

