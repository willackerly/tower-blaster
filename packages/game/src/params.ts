// The game page's URL keys, parsed in one place for both pages that play
// Keystone: the game page reads them all here, and the viewer under
// rules=keystone reads the Keystone ones through the same functions
// (docs/design/viewer-superset.md, step F). A key's bad value is refused with
// a message naming it; keys a page doesn't know are left to it (the look's
// real.* knobs, the viewer's own).
import { LEVELS, type LevelDef, readShots, SCORINGS, type Scoring, type Shot } from '@tb/keystone';
import { LOOKS } from '@tb/render';
import { type EngineKind, engineKind } from './engines.ts';
import { paceFeel, type PaceFeel } from './pacing.ts';

/** The game's look when ?look= is absent: the maquette, whose pale albedo shows the role tints true. */
export const GAME_LOOK = 'hazy';

/**
 * Rule overrides from the URL (docs/game/spectacle-mode.md, section 10): ?keystone.scoring=par|outcome
 * scores any level either way, ?keystone.autobank=1|0 ends an outcome level at its first clear (or not).
 * Each is part of the level it makes (its hash), so stars cast for the level do not apply to it.
 */
export interface LevelRules { scoring?: Scoring; autobank?: boolean }

export function levelRules(q: URLSearchParams): LevelRules {
  const r: LevelRules = {};
  const sc = q.get('keystone.scoring'), ab = q.get('keystone.autobank');
  if (sc !== null) {
    if (!(SCORINGS as readonly string[]).includes(sc)) throw new Error(`keystone.scoring must be ${SCORINGS.join(' or ')}: ${sc}`);
    r.scoring = sc as Scoring;
  }
  if (ab !== null) {
    if (ab !== '0' && ab !== '1') throw new Error(`keystone.autobank must be 0 or 1: ${ab}`);
    r.autobank = ab === '1';
  }
  return r;
}

/** def with the URL's rule overrides (none: def itself). */
export function withRules(def: LevelDef, r: LevelRules): LevelDef {
  if (r.scoring === undefined && r.autobank === undefined) return def;
  return { ...def, ...(r.scoring !== undefined ? { scoring: r.scoring } : {}), ...(r.autobank !== undefined ? { autobank: r.autobank } : {}) };
}

export interface GameParams {
  /** ?level=L1 to L5 (any case; the first level when absent), with the rule overrides applied. */
  level: LevelDef;
  rules: LevelRules;
  engine: EngineKind;
  feel: PaceFeel;
  /** ?look=candy | hazy | real (GAME_LOOK when absent); the real look's knobs are @tb/render parseRealOptions. */
  look: string;
  /** ?keystone.shots: a line to play once the level has loaded (lineOf). */
  shots: Shot[] | null;
  /** ?offscreen=1 (tests): draw only for captures. */
  offscreen: boolean;
}

/** A built-in level by id, any case; throws naming the known ones. */
export function gameLevel(id: string): LevelDef {
  const def = LEVELS.find((l) => l.id === id.toUpperCase());
  if (!def) throw new Error(`unknown level ${id.toUpperCase()}; known: ${LEVELS.map((l) => l.id).join(', ')}`);
  return def;
}

/** Throws unless def's rack holds every shot of the line. */
export function checkLine(def: LevelDef, shots: readonly Shot[]): void {
  for (const ammo of new Set(shots.map((s) => s.ammo))) {
    const want = shots.filter((s) => s.ammo === ammo).length, have = def.rack.filter((a) => a === ammo).length;
    if (want > have) throw new Error(`keystone.shots fires ${want} ${ammo} but ${def.id}'s rack holds ${have} (rack: ${def.rack.join(', ')})`);
  }
}

/** ?keystone.shots for level def (@tb/keystone writeShots text): null when absent; empty, malformed or more than the rack holds is refused. */
export function lineOf(def: LevelDef, text: string | null): Shot[] | null {
  if (text === null) return null;
  if (text === '') throw new Error('keystone.shots is empty: leave it out for no line');
  const shots = readShots(text);
  checkLine(def, shots);
  return shots;
}

/** A look name; throws naming the known ones. */
export function lookName(name: string): string {
  if (!LOOKS[name]) throw new Error(`unknown look ${name}; known: ${Object.keys(LOOKS).join(', ')}`);
  return name;
}

export function parseGameParams(q: URLSearchParams): GameParams {
  const rules = levelRules(q);
  const level = withRules(gameLevel(q.get('level') ?? LEVELS[0]!.id), rules);
  return {
    level,
    rules,
    engine: engineKind(q.get('engine')),
    feel: paceFeel(q),
    look: lookName(q.get('look') ?? GAME_LOOK),
    shots: lineOf(level, q.get('keystone.shots')),
    offscreen: q.get('offscreen') === '1',
  };
}
