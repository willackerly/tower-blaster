// The game page's URL keys, parsed in one place for both pages that play
// Keystone: the game page reads them all here, and the viewer under
// rules=keystone reads the Keystone ones through the same functions
// (docs/design/viewer-superset.md, step F). A key's bad value is refused with
// a message naming it; keys a page doesn't know are left to it (the look's
// real.* knobs, the viewer's own).
import { isRackItem, itemRef, LEVELS, type LevelDef, levelWeapon, MAX_RACK, RACK_ITEM_NAMES, type RackItem, readShots, type Shot } from '@tb/keystone';
import { LOOKS } from '@tb/render';
import { type EngineKind, engineKind } from './engines.ts';
import { paceFeel, type PaceFeel } from './pacing.ts';

/** The game's look when ?look= is absent: the maquette, whose pale albedo shows the role tints true. */
export const GAME_LOOK = 'hazy';

export interface GameParams {
  /** ?level=L1 to L5 (any case; the first level when absent), with its rack replaced when ?keystone.rack is given. */
  level: LevelDef;
  /** ?keystone.rack: the rack the level opened with instead of its own (rackOf), or null. */
  rack: RackItem[] | null;
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

/**
 * ?keystone.rack for level def: a comma list of rack item names (@tb/keystone rack.ts) the level
 * plays with instead of its own, or null when absent. Refused: an empty list, more than MAX_RACK,
 * a name that is no item, a weapon the level does not have. The level's hash changes with its
 * rack, so a run with an override is never the authored level's (spectacle-mode.md: custom).
 */
export function rackOf(def: LevelDef, text: string | null): RackItem[] | null {
  if (text === null) return null;
  const items = text.split(',');
  if (text === '' || items.length > MAX_RACK) throw new Error(`keystone.rack must list 1 to ${MAX_RACK} items: ${text}`);
  return items.map((name) => {
    if (!isRackItem(name)) throw new Error(`keystone.rack: ${name || 'an empty name'} is not one of ${RACK_ITEM_NAMES}`);
    const ref = itemRef(name)!;
    if (ref.kind === 'weapon' && !levelWeapon(def, ref.key)) throw new Error(`keystone.rack: ${def.id} has no weapons.${ref.key} for ${name}`);
    return name;
  });
}

/** A look name; throws naming the known ones. */
export function lookName(name: string): string {
  if (!LOOKS[name]) throw new Error(`unknown look ${name}; known: ${Object.keys(LOOKS).join(', ')}`);
  return name;
}

export function parseGameParams(q: URLSearchParams): GameParams {
  const authored = gameLevel(q.get('level') ?? LEVELS[0]!.id), rack = rackOf(authored, q.get('keystone.rack'));
  const level = rack ? { ...authored, rack } : authored;
  return {
    level, rack,
    engine: engineKind(q.get('engine')),
    feel: paceFeel(q),
    look: lookName(q.get('look') ?? GAME_LOOK),
    shots: lineOf(level, q.get('keystone.shots')),
    offscreen: q.get('offscreen') === '1',
  };
}
