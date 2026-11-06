// The game page's URL keys, parsed in one place for both pages that play
// Keystone: the game page reads them all here, and the viewer under
// rules=keystone reads the Keystone ones through the same functions
// (docs/design/viewer-superset.md, step F). A key's bad value is refused with
// a message naming it; keys a page doesn't know are left to it (the look's
// real.* knobs, the viewer's own).
import { BIG_LEVELS, checkPhysics, LEVELS, TRIAL_LEVELS, UNDERCUT_LEVELS, checkSettle, DUELS, duelLevel, type DuelDef, findDuel, freezeProblem, isRackItem, itemRef, levelById, type LevelDef, MAX_PULLS, MAX_RACK, type PhysicsBlock, RACK_ITEM_NAMES, type RackItem, rackSizeProblem, readShots, SCORINGS, type Scoring, type SettleRule, type Shot, weaponOf } from '@tb/keystone';
import { LOOKS } from '@tb/render';
import { type EngineKind, engineKind } from './engines.ts';
import { paceFeel, type PaceFeel } from './pacing.ts';
import { GAME_SOUND_MODES, type GameSoundMode } from './sound-map.ts';

/** The game's look when ?look= is absent: the maquette, whose pale albedo shows the role tints true. */
export const GAME_LOOK = 'hazy';

/**
 * Rule overrides from the URL (docs/game/spectacle-mode.md, section 10): ?keystone.scoring=par|outcome
 * scores any level either way, ?keystone.autobank=1|0 ends an outcome level at its first clear (or not),
 * ?keystone.settle=v1|v2|v3|v4 picks how a shot settles (default: v1 for par levels, v3 for outcome levels),
 * ?keystone.iterations, ?keystone.gapSlop, ?keystone.bounce (e, or off), ?keystone.presettle and
 * ?keystone.pairsPerBody (the GPU pair room per body, in place of every pair) change its physics block,
 * and ?keystone.freeze=N gives the player N freezes (Bullet Time: at most N shots fired while another
 * runs, LevelDef.freeze; 0 none). Each is part of the level it makes (its hash), and the level is marked custom: stars cast for the
 * authored level do not apply to it.
 */
export interface LevelRules { scoring?: Scoring; autobank?: boolean; settle?: SettleRule; freeze?: number; physics?: PhysicsBlock }

const PHYSICS_KEYS = { 'keystone.iterations': 'iterations', 'keystone.gapSlop': 'gapSlop', 'keystone.bounce': 'bounce', 'keystone.presettle': 'presettle', 'keystone.pairsPerBody': 'pairsPerBody' } as const;
/** Every URL key levelRules reads. */
export const LEVEL_RULE_KEYS = ['keystone.scoring', 'keystone.autobank', 'keystone.settle', 'keystone.freeze', ...Object.keys(PHYSICS_KEYS)] as readonly string[];

/** The URL keys for r, as levelRules reads them back. */
export function writeLevelRules(r: LevelRules, q: URLSearchParams): void {
  if (r.scoring !== undefined) q.set('keystone.scoring', r.scoring);
  if (r.autobank !== undefined) q.set('keystone.autobank', r.autobank ? '1' : '0');
  if (r.settle !== undefined) q.set('keystone.settle', r.settle);
  if (r.freeze !== undefined) q.set('keystone.freeze', String(r.freeze));
  for (const [key, field] of Object.entries(PHYSICS_KEYS)) {
    const v = r.physics?.[field];
    if (v !== undefined) q.set(key, v === null ? 'off' : String(v));
  }
}

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
  const st = q.get('keystone.settle');
  if (st !== null) r.settle = checkSettle(st, 'keystone.settle');
  const fz = q.get('keystone.freeze');
  if (fz !== null) {
    const n = /^\d+$/.test(fz) ? Number(fz) : NaN, why = freezeProblem(n);
    if (why) throw new Error(`keystone.${why.replace(/: NaN$/, `: ${fz}`)}`);
    r.freeze = n;
  }
  for (const [key, field] of Object.entries(PHYSICS_KEYS)) {
    const v = q.get(key);
    if (v === null) continue;
    const x = field === 'bounce' && v === 'off' ? null : v.trim() === '' ? NaN : Number(v);
    const one: PhysicsBlock = { [field]: x };
    try { checkPhysics(one, 'keystone'); } catch (e) { throw new Error(`${key}: ${(e as Error).message.replace(/^keystone\.\w+ /, '')}`); }
    r.physics = { ...r.physics, ...one };
  }
  return r;
}

/** def with the URL's rule overrides (none: def itself). */
export function withRules(def: LevelDef, r: LevelRules): LevelDef {
  if (r.scoring === undefined && r.autobank === undefined && r.settle === undefined && r.freeze === undefined && r.physics === undefined) return def;
  return {
    ...def, custom: true,
    ...(r.scoring !== undefined ? { scoring: r.scoring } : {}), ...(r.autobank !== undefined ? { autobank: r.autobank } : {}),
    ...(r.settle !== undefined ? { settle: r.settle } : {}), ...(r.freeze !== undefined ? { freeze: r.freeze } : {}),
    ...(r.physics !== undefined ? { physics: { ...def.physics, ...r.physics } } : {}),
  };
}

/** def as played on engine `kind`: custom when its stars were cast on another engine. */
export function onEngine(def: LevelDef, kind: string): LevelDef {
  return def.stars?.engine !== undefined && def.stars.engine !== kind && !def.custom ? { ...def, custom: true } : def;
}

export interface GameParams {
  /** ?level=B1 to B3, L1 to L5, U1 to U3 or a trial T-... (any case; DEFAULT_LEVEL, B1, when absent), with its rack replaced when ?keystone.rack is given and the rule overrides applied. */
  level: LevelDef;
  /** ?keystone.rack: the rack the level opened with instead of its own (rackOf), or null. */
  rack: RackItem[] | null;
  rules: LevelRules;
  engine: EngineKind;
  feel: PaceFeel;
  /** ?look=candy | hazy | real (GAME_LOOK when absent); the real look's knobs are @tb/render parseRealOptions. */
  look: string;
  /** ?keystone.shots: a line to play once the level has loaded (lineOf). */
  shots: Shot[] | null;
  /** ?offscreen=1 (tests): draw only for captures. */
  offscreen: boolean;
  /** The offscreen frame's size in pixels: 640x400 for ?offscreen=1, or ?offscreen=WxH (agent playtests: a phone's or a desktop's shape). */
  offscreenSize: [number, number];
  /** ?keystone.sound=classic: the collision sound with G6's materials; synth: impacts as the old pentatonic voices (collapse, the default). */
  sound: GameSoundMode;
  /** ?keystone.impacts=-6: the collision sound's level, dB over the game's own (-40 to 20). */
  impactsDb: number;
  /** ?duel=D1 (or a ruleset name, keeps or heraldry): a Siege Table duel instead of the level (docs/game/siege-table.md); null when absent. */
  duel: DuelDef | null;
}

/** ?duel: a duel table by id or ruleset, any case; null when absent; throws naming the known ones. */
export function duelOf(text: string | null): DuelDef | null {
  if (text === null) return null;
  const d = findDuel(text);
  if (!d) throw new Error(`unknown duel ${text}; known: ${DUELS.map((x) => `${x.id} (${x.ruleset})`).join(', ')}`);
  return d;
}

/** ?keystone.sound and ?keystone.impacts. */
export function gameSound(q: URLSearchParams): Pick<GameParams, 'sound' | 'impactsDb'> {
  const mode = q.get('keystone.sound') ?? 'collapse';
  if (!(GAME_SOUND_MODES as readonly string[]).includes(mode)) throw new Error(`keystone.sound must be ${GAME_SOUND_MODES.join(', ')}: ${mode}`);
  const t = q.get('keystone.impacts'), db = t === null ? 0 : t.trim() === '' ? NaN : Number(t);
  if (!(db >= -40 && db <= 20)) throw new Error(`keystone.impacts (dB) must be from -40 to 20: ${t}`);
  return { sound: mode as GameSoundMode, impactsDb: db };
}

/**
 * The level a bare URL opens: the spectacle slice's first (B1 Long Wall, roadmap G5.5); its series plays on into
 * B2 and B3. The chamber levels stay at ?level=L1 to L5, with par scoring.
 */
export const DEFAULT_LEVEL = BIG_LEVELS[0]!.id;

/**
 * The built-in series in the game's order (the door's sections, top to bottom): the spectacle slice the bare URL
 * opens, the chamber levels, Undercut's, then the unrated trials. Every level of @tb/keystone's SERIES, once.
 */
export const GAME_SERIES: readonly (readonly LevelDef[])[] = [BIG_LEVELS, LEVELS, UNDERCUT_LEVELS, TRIAL_LEVELS];

/** A built-in level (chamber L1 to L5, big B1 on, Undercut U1 on or a trial T-...) by id, any case; throws naming the known ones. */
export const gameLevel = (id: string): LevelDef => levelById(id);

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
 * plays with instead of its own, or null when absent. Refused: an empty list, more than MAX_RACK
 * fired items or MAX_PULLS pulls,
 * a name that is no item, a weapon the level does not have. The level's hash changes with its
 * rack, so a run with an override is never the authored level's (spectacle-mode.md: custom).
 */
export function rackOf(def: LevelDef, text: string | null): RackItem[] | null {
  if (text === null) return null;
  const items = text.split(',');
  if (text === '' || rackSizeProblem(items) !== null) throw new Error(`keystone.rack must list 1 to ${MAX_RACK} items (and up to ${MAX_PULLS} pulls): ${text}`);
  return items.map((name) => {
    if (!isRackItem(name)) throw new Error(`keystone.rack: ${name || 'an empty name'} is not one of ${RACK_ITEM_NAMES}`);
    const ref = itemRef(name)!;
    if (ref.kind === 'weapon' && !weaponOf(def, ref.key)) throw new Error(`keystone.rack: ${def.id} has no weapons.${ref.key} for ${name}`);
    return name;
  });
}

/** The offscreen size when ?offscreen=1 names none. */
export const OFFSCREEN_SIZE: [number, number] = [640, 400];

/**
 * ?offscreen: absent or 0 draws to the page's canvas; 1 draws OFFSCREEN_SIZE offscreen, only for captures (tests);
 * WxH (each 64 to 4096) does the same at that size, so a capture has a phone's or a desktop's shape (the agent
 * playtest, docs/game/agent-playtest-1.md). Anything else is refused.
 */
export function offscreenOf(text: string | null): Pick<GameParams, 'offscreen' | 'offscreenSize'> {
  if (text === null || text === '0') return { offscreen: false, offscreenSize: OFFSCREEN_SIZE };
  if (text === '1') return { offscreen: true, offscreenSize: OFFSCREEN_SIZE };
  const m = /^(\d+)x(\d+)$/.exec(text), w = Number(m?.[1]), h = Number(m?.[2]);
  if (!m || !(w >= 64 && w <= 4096 && h >= 64 && h <= 4096)) throw new Error(`offscreen must be 0, 1 or WxH (each 64 to 4096): ${text}`);
  return { offscreen: true, offscreenSize: [w, h] };
}

/** A look name; throws naming the known ones. */
export function lookName(name: string): string {
  if (!LOOKS[name]) throw new Error(`unknown look ${name}; known: ${Object.keys(LOOKS).join(', ')}`);
  return name;
}

export function parseGameParams(q: URLSearchParams): GameParams {
  const rules = levelRules(q);
  const authored = gameLevel(q.get('level') ?? DEFAULT_LEVEL), rack = rackOf(authored, q.get('keystone.rack'));
  const level = withRules(rack ? { ...authored, rack } : authored, rules);
  const duel = duelOf(q.get('duel'));
  return {
    level, rack, rules, duel,
    engine: engineKind(q.get('engine')),
    feel: paceFeel(q),
    look: lookName(q.get('look') ?? GAME_LOOK),
    // A duel's line is checked against the duel's own level (its first player first).
    shots: lineOf(duel ? duelLevel(duel, 0) : level, q.get('keystone.shots')),
    ...offscreenOf(q.get('offscreen')),
    ...gameSound(q),
  };
}

/**
 * How level starts run (docs/game/level-start.md): ?keystone.loadpace=<ms> is the pre-settle's batch
 * time (0 runs it in one go, which holds the frames until it is done; default PRESETTLE_PACE's 8),
 * ?keystone.prefetch says when the level Next opens is built ahead: aim (or 1, the default) from when a
 * level loads, while the player aims; card from when the result card shows; 0 never. And
 * ?keystone.retry=rebuild makes Retry build the level again instead of restoring it from its start
 * checkpoint (default checkpoint). None changes a level's state, so none is part of a level.
 */
export interface LoadOptions { loadPaceMs?: number; prefetch?: 'aim' | 'card' | 'off'; retry?: 'checkpoint' | 'rebuild' }
export function loadOptions(q: URLSearchParams): LoadOptions {
  const out: LoadOptions = {};
  const p = q.get('keystone.loadpace');
  if (p !== null) {
    const ms = p.trim() === '' ? NaN : Number(p);
    if (!(ms >= 0 && ms <= 1000)) throw new Error(`keystone.loadpace must be from 0 to 1000 ms (0: unpaced): ${p}`);
    out.loadPaceMs = ms;
  }
  const f = q.get('keystone.prefetch');
  if (f !== null) {
    if (f !== '0' && f !== '1' && f !== 'aim' && f !== 'card') throw new Error(`keystone.prefetch must be aim (or 1), card or 0: ${f}`);
    out.prefetch = f === '0' ? 'off' : f === 'card' ? 'card' : 'aim';
  }
  const r = q.get('keystone.retry');
  if (r !== null) {
    if (r !== 'checkpoint' && r !== 'rebuild') throw new Error(`keystone.retry must be checkpoint or rebuild: ${r}`);
    out.retry = r;
  }
  return out;
}
