// The player-facing copy audit (agent playtest PT18, docs/game/agent-playtest-1.md): every string the door, the HUD,
// the tallying banner and the result card show, over every level the game page lists (trials included) and every
// duel, rendered to visible text (tags and attributes dropped) and checked for the developer words the playtest's
// judges found: "engine", "probe", the weapon key "grenadel", "1 pts", and trial ids (T-S14T) or the W5- prefix.
// Ids may stay in attributes (data-id, the URL): what is checked is what a player reads.
import { describe, expect, it } from 'vitest';
import { compileLevel, D1, D2, Duel, duelLevel, type LevelDef, TRIAL_LEVELS } from '@tb/keystone';
import { doorDuels, doorHtml, doorLevels, HOW_TO_PLAY, SIEGE_TABLE_HOW, TRIALS_BLURB } from '../src/door.ts';
import { duelHudHtml, duelResultHtml } from '../src/duel-hud.ts';
import { CUSTOM_NOTE, hudHtml, hudTitle, itemLabel, levelTag, playerName, rackChips, resultHtml, tallyHtml, WEAPON_LABEL } from '../src/hud.ts';
import { GAME_SERIES } from '../src/params.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

/** What a player reads: the markup with its tags (and so its attributes) dropped and the entities decoded. */
const visible = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** The words the playtest's judges flagged (PT18), and the trial ids and world prefix (J1 #22). */
const BANNED: readonly [string, RegExp][] = [
  ['engine', /\bengine/i],
  ['probe', /\bprobe/i],
  ['grenadel', /grenadel/i],
  ['1 pts', /(^|[^\d.,])1 pts\b/],
  ['a trial id', /\bT-[A-Z]\d/],
  ['a W-n prefix', /\bW\d+-/],
];
const audit = (where: string, html: string) => {
  const text = visible(html);
  for (const [name, re] of BANNED) expect(text, `${where} shows ${name}: …${text.match(re) ? text.slice(Math.max(0, text.search(re) - 40), text.search(re) + 40) : ''}…`).not.toMatch(re);
};

const ALL: readonly LevelDef[] = GAME_SERIES.flat();

describe('player-facing copy (PT18)', () => {
  it('the door: every series, the trials open, how to play, advanced settings, the Siege Table', () => {
    const levels = doorLevels(ALL, () => null);
    for (const current of [-1, 0, ALL.findIndex((d) => d.id === 'T-S14T')]) {
      audit(`the door (current ${current})`, doorHtml({ levels, current, settings: DEFAULT_SETTINGS, howTo: true, advanced: true, trials: { count: TRIAL_LEVELS.length, open: true }, duels: doorDuels([D1, D2], null) }));
    }
    audit('the trials blurb', TRIALS_BLURB);
  });

  it('the HUD, the tallying banner and the result card of every level, before and after a shot', () => {
    for (const d of ALL) {
      const rack = d.rack;
      for (const strokes of [0, 1]) {
        audit(`${d.id}'s HUD at shot ${strokes}`, hudHtml({
          level: d, strokes, crownsDown: 0, crownsTotal: 1, heritageBroken: 0, heritageTotal: 0, power: 60, leverage: { round: 0.5, shot: 0.5 }, phase: 'aiming', reachable: false,
          chips: rackChips(rack, rack, rack[0] ?? null), collapse: 0.2, met: false, canBank: strokes > 0,
        }));
      }
      audit(`${d.id}'s tally`, tallyHtml(d, null));
      audit(`${d.id}'s card`, resultHtml(d, null, 1, true));
    }
    audit('the custom note', CUSTOM_NOTE);
  });

  it('the duels: one point is "1 pt"', () => {
    for (const def of [D1, D2]) {
      const c = compileLevel(duelLevel(def)), d = new Duel(def, c);
      for (const side of d.sides) (side as { points: number }).points = 1;
      audit(`${def.id}'s HUD`, duelHudHtml(d));
      Object.assign(d.result, { over: true, winner: 0, why: 'test' });
      audit(`${def.id}'s card`, duelResultHtml(d));
    }
  });

  it('the rack: sized grenades have player names, and no two items in a rack read alike', () => {
    expect(itemLabel('w-grenadel')).toBe('Big grenade');
    expect(itemLabel('w-grenade')).toBe('Grenade');
    expect(itemLabel('w-grenades')).toBe('Small grenade');
    expect(itemLabel('w-grenadexl')).toBe('Huge grenade');
    expect(itemLabel('w-bomb')).toBe('Bomb');
    expect(Object.keys(WEAPON_LABEL)).toEqual(['grenades', 'grenadem', 'grenadel', 'grenadexl']);
    // In every level's rack the chips' names are distinct, and none is a prefix of another plus one letter (Grenade, Grenadel).
    for (const d of ALL) {
      const names = [...new Set(d.rack)].map((r) => itemLabel(r).toLowerCase());
      expect(new Set(names).size, d.id).toBe(names.length);
      for (const a of names) for (const b of names) if (a !== b) expect(b.startsWith(a) && b.length === a.length + 1, `${d.id}: ${a} / ${b}`).toBe(false);
    }
  });

  it('trials show a number and their name without the draft code; the id stays in the definition', () => {
    const t = TRIAL_LEVELS.findIndex((d) => /\([A-Z]\d+[a-z]\)$/.test(d.name));
    expect(t).toBeGreaterThanOrEqual(0);
    const draft = TRIAL_LEVELS[t]!;
    expect(levelTag(draft)).toBe(`Trial ${t + 1}`);
    expect(playerName(draft)).toBe(draft.name.replace(/ \(.*\)$/, ''));
    expect(hudTitle(draft)).toBe(`Trial ${t + 1} · ${playerName(draft)}`);
    // Rated levels as before.
    const l2 = ALL.find((d) => d.id === 'L2')!;
    expect([levelTag(l2), playerName(l2), hudTitle(l2)]).toEqual(['L2', l2.name, `L2 · ${l2.name}`]);
    // A T- id the list does not hold (a level file's own) still hides its id.
    expect(levelTag({ id: 'T-ZZ9' })).toBe('Trial');
  });

  it('how to play covers Bullet Time and the Siege Table', () => {
    const how = HOW_TO_PLAY.join(' ');
    expect(how).toMatch(/Bullet Time/);
    expect(how).toMatch(/<kbd>T<\/kbd>/);
    expect(HOW_TO_PLAY).toContain(SIEGE_TABLE_HOW);
    expect(SIEGE_TABLE_HOW).toMatch(/^Siege Table: two players/);
    expect(SIEGE_TABLE_HOW).toMatch(/Two Keeps: .*Heraldry: /);
  });
});
