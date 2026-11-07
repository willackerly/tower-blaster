// Each mode's own HUD and result card (agent playtest round 2, PT23 and PT27; docs/game/mode-ui.md).
//
// The game's HUD and card were built for the projectile levels. Fuse & Fold, Aftershock and Rube Lab have no
// projectile to aim: they start from their own panel (the Timeline's Plunger, the quake designer's Start, the
// Build panel's Run) and are judged on their own terms. This module says, per mode, which HUD rows a round shows
// and which start verb it has (hudProfile), and what its result card says (cardModel). hud.ts draws both.
// A mode thread changes its mode's content here (PROFILES, MODE_CARDS); the mechanism is the same for all.
// keystone.modeui=0 draws the projectile HUD and card for every mode, as before.
import { type LevelDef, type LevelScore, type Objective } from '@tb/keystone';

/** How a level is played: aimed shots (every series before the new modes), or one of the modes with a panel of its own. */
export type PlayMode = 'shot' | 'fuse' | 'quake' | 'rube';

/** A level's mode, from its definition alone. */
export function playMode(def: Pick<LevelDef, 'rube' | 'objective'>): PlayMode {
  if (def.rube) return 'rube';
  if (def.objective.kind === 'quake') return 'quake';
  if (def.objective.kind === 'fold') return 'fuse';
  return 'shot';
}

/** What a mode's HUD shows (hud.ts hudHtml reads it; absent: the projectile HUD, keystone.modeui=0). */
export interface HudProfile {
  mode: PlayMode;
  /** The Power and Height rows: there is a projectile to aim. */
  aim: boolean;
  /** The rack's chips. Off where the mode's panel is the one control (a Plunger chip beside the Timeline's Plunger). */
  chips: boolean;
  /** The help says click or lift fires (off: no shot is fired from the scene). */
  fire: boolean;
  /** The Leverage row (off where energy in against energy out is not what the mode asks). */
  leverage: boolean;
  /** The pre-aimed opener ("Fire the first shot", key F). Off where it would stand beside the mode's own start, or play its answer. */
  opener: boolean;
  /**
   * The one start verb, where the mode has its own (its panel's button): 'Plunger', 'Start the quake', 'Run'.
   * null: the shot is the start.
   */
  start: string | null;
}

const PROFILES: Record<PlayMode, Omit<HudProfile, 'mode'>> = {
  shot: { aim: true, chips: true, fire: true, leverage: true, opener: true, start: null },
  // The Timeline panel's Plunger (Enter) is the start; the charges, not a projectile, bring it down.
  fuse: { aim: false, chips: false, fire: false, leverage: true, opener: false, start: 'Plunger' },
  // The designer's Start (Enter). The opener fell back to the ace's quake, which played the answer (PT23).
  quake: { aim: false, chips: false, fire: false, leverage: false, opener: false, start: 'Start the quake' },
  // One Run: the Build panel's while building (it plays the build and releases the ball), else the HUD's (key F).
  rube: { aim: false, chips: false, fire: false, leverage: false, opener: true, start: 'Run' },
};

/** The HUD profile of a level's mode. */
export function hudProfile(def: Pick<LevelDef, 'rube' | 'objective'>): HudProfile {
  const mode = playMode(def);
  return { mode, ...PROFILES[mode] };
}

// ---- The result card ----

/** What the round left, for the card's words (play.ts reads it off the session at the end). */
export interface CardFacts {
  crownsDown: number;
  crownsTotal: number;
  heritageBroken: number;
  heritageTotal: number;
  /** Collapse fraction D at the end, 0 to 1. */
  collapse: number;
  /** Fold levels: the building's spill out of its lot, 0 to 1. */
  spill?: number;
  /** Energy fired over the round, J (Aftershock's star metric). */
  energy?: number;
}

/** One of a mode's own card rows: a fact, not points. */
export interface CardRow { label: string; value: string; tone?: 'ok' | 'bad' }

/** What the result card says (hud.ts resultHtml draws it). */
export interface CardModel {
  /** The line under the level's name. */
  sub: string;
  /** The mode's own rows, above the points (none: the points alone). */
  rows: CardRow[];
  /** The score's point lines and their total. Off where points mean nothing in the mode (Rube Lab: one plunger, no strokes). */
  points: boolean;
  /** The par levels' gold-leverage badge. */
  gold: boolean;
  /** The stamp, and 'bad' for a loss the player should read as one (HERITAGE LOST: drawn red by its class, s-heritagelost, shared with the score module's stamp, #281). */
  stamp: string;
  stampTone: '' | 'bad';
  /** A failed round: what fell short, in the mode's terms, and what to try where the mode says. null on a round with a star. */
  reason: string | null;
}

/** The objectives a broken heritage fails outright (outcome.ts objectiveMet): the rest only cost stars or points. */
export const heritageFails = (o: Objective) => o.kind === 'quake' || o.kind === 'fold';

const pct = (x: number) => `${Math.floor(100 * x)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a round that earned no star failed, from its objective and what it left: the shortfall in the objective's own
 * measure. Every objective has one, so no failed card goes without (PT27). Heritage first where it fails the objective.
 */
export function failReason(def: Pick<LevelDef, 'objective'>, score: LevelScore, f: CardFacts): string {
  const o = def.objective, standing = Math.max(0, f.crownsTotal - f.crownsDown);
  if (heritageFails(o) && f.heritageBroken > 0) return `${plural(f.heritageBroken, 'heritage block')} broken: the objective spares them all`;
  switch (o.kind) {
    case 'crowns': return `${standing} of ${plural(f.crownsTotal, 'crown')} still standing: bring them all down`;
    case 'skyline': return `The skyline is still above ${o.maxH} h`;
    case 'collapse': return `${pct(f.collapse)} down, ${pct(o.min)} needed`;
    case 'hold': return 'A crown fell: every crown has to stay up';
    case 'quake': return `${standing} of ${plural(f.crownsTotal, 'condemned tower')} still standing`;
    case 'fold':
      if (f.collapse < o.min) return `${pct(f.collapse)} folded, ${pct(o.min)} needed`;
      return `${pct(f.spill ?? 0)} spilled out of the lot, at most ${pct(o.spillMax)} allowed`;
    case 'bell': return 'The bell did not ring';
    case 'trial': {
      const w = score.worlds;
      return w ? `Stood in ${w.cleared} of ${w.of} worlds, ${w.thresholds[0]} needed` : 'The build did not pass its test';
    }
  }
}

/** A mode's changes to the card: what it says, given the default (the projectile card) and the round. */
export type ModeCard = (x: { def: LevelDef; score: LevelScore; facts: CardFacts; base: CardModel }) => Partial<CardModel> & { tip?: string };

/**
 * Each new mode's card (PT27). The mode threads own the words; this is the first draft from the playtest's notes.
 * `tip` is added after the reason on a failed round.
 */
export const MODE_CARDS: Partial<Record<PlayMode, ModeCard>> = {
  // A contraption's one plunger is no stroke, its energy no leverage: the card is the bell and the parts against par.
  rube: ({ score, base }) => {
    const rung = score.stars > 0, p = score.parts;
    return {
      sub: p ? `parts ${p.used} / par ${p.par}` : base.sub,
      rows: [
        { label: 'Bell', value: rung ? 'rung ✓' : 'not rung', tone: rung ? 'ok' : 'bad' },
        ...(p ? [{ label: 'Parts', value: `${p.used} / par ${p.par}`, ...(p.used > p.par ? { tone: 'bad' as const } : {}) }] : []),
      ],
      points: false,
      gold: false,
      ...(rung ? {} : { stamp: 'NOT RUNG' }),
      tip: 'change the build and Run again',
    };
  },
  // The condemned down and the heritage spared are the objective; how much of the lot came down is not.
  quake: ({ score, facts, base }) => {
    const met = score.stars > 0, beat = (score as { outcome?: { beatBot?: boolean } }).outcome?.beatBot === true;
    const energy = facts.energy !== undefined && Number.isFinite(facts.energy) ? ` · energy ${Math.round(facts.energy).toLocaleString('en-US')} J` : '';
    return {
      sub: `1 quake${energy}`,
      ...(met && !beat ? { stamp: `${facts.crownsDown}/${facts.crownsTotal} CONDEMNED · HERITAGE SAFE` } : {}),
      gold: false,
      ...(base.reason && facts.heritageBroken === 0 ? { tip: 'try a stronger or longer quake, or another axis' } : {}),
    };
  },
  // A fold is judged on what came down into the lot and what spilled out of it.
  fuse: ({ facts, base }) => ({
    sub: base.sub.replace(/ down\b/, ' folded') + (facts.spill !== undefined ? ` · spill ${pct(facts.spill)}` : ''),
  }),
};

/**
 * The card for a round: the projectile card (`base`: the sub line and stamp hud.ts made, points, gold) with HERITAGE
 * LOST in red where a broken heritage failed the objective and a reason on every failed round, then the mode's own
 * changes (MODE_CARDS). `modeUi` false (keystone.modeui=0): the base card with neither, as before.
 */
export function cardModel(def: LevelDef, score: LevelScore, facts: CardFacts | undefined, base: { sub: string; stamp: string }, modeUi = true): CardModel {
  const card: CardModel = { sub: base.sub, rows: [], points: true, gold: true, stamp: base.stamp, stampTone: '', reason: null };
  if (!modeUi || !facts || score.refereed) return card;
  const failed = score.stars === 0;
  if (failed) {
    card.reason = failReason(def, score, facts);
    if (heritageFails(def.objective) && facts.heritageBroken > 0) { card.stamp = 'HERITAGE LOST'; card.stampTone = 'bad'; }
  }
  const mode = MODE_CARDS[playMode(def)];
  if (!mode) return card;
  const { tip, ...over } = mode({ def, score, facts, base: card });
  const out = { ...card, ...over };
  // HERITAGE LOST stands over a mode's stamp: it is the reason the round failed.
  if (card.stampTone === 'bad') { out.stamp = card.stamp; out.stampTone = 'bad'; }
  if (out.reason && tip) out.reason = `${out.reason}: ${tip}`;
  return out;
}
