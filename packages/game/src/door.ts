// The front door (roadmap G7): the title, the series' levels with their star
// targets and the player's best, how to play, and the settings. Formatting is
// pure (doorLevels, doorHtml) and tested; the page (main.ts) shows it over the
// level already loading behind it, so the first shot is one click away.
//
// Every series shows, each under its title (Spectacle, Chamber, Undercut), and
// the trials (keystone trial-levels.ts: unrated: 16 after PT11's pruning, then the C9 workshop and the Kapla Spire drafts) under a toggle,
// closed by default so the door neither scrolls past them nor compiles them
// (a 10k trial compiles in 20-30 ms) until the player opens it.
//
// Star targets come from each level's cast stars (stars.json via castStars):
// a level with none (a trial, or a level whose cast has not landed) shows the
// objective's star alone, one target row and one star slot, never a placeholder
// (the agent playtest's PT7: "targets coming soon" read as unfinished), and picks
// the rest up from the file with no change here.
import { castStars, type CompiledLevel, compileLevel, DUEL_NAMES, type DuelDef, isTrial, type LevelDef, type Objective, scoringOf, SERIES, SERIES_TITLES, type Shot, type StarMetric, type StarsDef } from '@tb/keystone';
import { CUSTOM_NOTE, esc, fmtPoints, itemLabel, LEVERAGE_MEANS, levelTag, objectiveText, pct, playerName } from './hud.ts';
import type { LevelRecord } from './progress.ts';
import type { QualityTier } from './quality.ts';
import { type Settings, settingRows } from './settings.ts';

export { QUALITY_TITLES } from './options/quality.ts';

/** ?door=auto (default: shown when the URL names no level), 1 (always shown on load) or 0 (never). */
export type DoorMode = 'auto' | '1' | '0';

export function doorMode(q: URLSearchParams): DoorMode {
  const v = q.get('door') ?? 'auto';
  if (v !== 'auto' && v !== '1' && v !== '0') throw new Error(`door must be auto, 1 or 0: ${v}`);
  return v;
}

/** Whether the door shows when the page opens. */
export const doorOnLoad = (mode: DoorMode, q: URLSearchParams): boolean => (mode === 'auto' ? !q.has('level') && !q.has('duel') : mode === '1');

/** One level as the door shows it. */
export interface DoorLevel {
  id: string;
  /** The card's tag as the player sees it (hud.ts levelTag): the id for a series level, "Trial 7" for a trial. */
  tag: string;
  /** The name as the player sees it (hud.ts playerName). */
  name: string;
  blocks: number;
  /** The rack in words: "3 bombs", "1 bomb, 2 rams". */
  rack: string;
  /** The three star targets, one line each (index 0 is one star). */
  targets: [string, string, string];
  /** The same in a word or number each, for the compact card on a phone. */
  short: [string, string, string];
  /** The level has cast stars here (two and three stars can be earned). */
  cast: boolean;
  custom: boolean;
  best: LevelRecord | null;
  /** Its index in the page's level list (the card's data-arg). */
  index: number;
  /** Its series' title (SERIES_TITLES), or '' for a level of no built-in series. */
  series: string;
  /** An unrated trial (trial-levels.ts): never Play's pick, listed under the Trials toggle. */
  trial: boolean;
}

/** The title of the built-in series holding level `id` (SERIES_TITLES), or ''. */
export function seriesTitle(id: string): string {
  const i = SERIES.findIndex((s) => s.some((l) => l.id.toUpperCase() === id.toUpperCase()));
  return i < 0 ? '' : SERIES_TITLES[i]!;
}

/**
 * The result card's way on at the end of a series (PT4): the next rated series' first level in the page's
 * list (`series` index-aligned with `levels`, as the game page's GAME_SERIES gives them), labelled with its
 * title; null inside a series, at the list's end, or when the next series is the unrated trials (the card
 * then offers Levels, the door).
 */
export function seriesForward(series: readonly number[], i: number, levels: readonly LevelDef[]): { index: number; label: string } | null {
  const k = series[i], next = i + 1;
  if (k === undefined || next >= levels.length || series[next] === k) return null;
  const l = levels[next]!;
  if (isTrial(l.id)) return null;
  const t = seriesTitle(l.id);
  return { index: next, label: t ? `Next: ${t}` : 'Next series' };
}

/** A star threshold in the metric's own words. */
export function thresholdText(metric: StarMetric, t: number): string {
  switch (metric) {
    case 'collapse': return `${pct(t)} down`;
    case 'score': return `${fmtPoints(Math.round(t))} points`;
    case 'crowns': return `${t} crown${t === 1 ? '' : 's'} down`;
    case 'skyline': return `skyline at ${pct(t)} of its height`;
    case 'pulled': return `${pct(t)} pulled`;
    case 'energy': return `a quake of ${Math.round(t)} J or less`;
    case 'fold': return `${pct(t)} folded`;
  }
}

/** "3 bombs", "1 bomb, 2 rams": the rack grouped in first-seen order. */
export function rackText(rack: readonly string[]): string {
  const kinds = [...new Set(rack)];
  return kinds.map((k) => {
    const n = rack.filter((x) => x === k).length, label = itemLabel(k as never).toLowerCase();
    return `${n} ${label}${n === 1 ? '' : 's'}`;
  }).join(', ');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A star threshold as a bare number: "70%", "3,200". */
export function thresholdShort(metric: StarMetric, t: number): string {
  return metric === 'collapse' || metric === 'skyline' || metric === 'pulled' || metric === 'fold' ? pct(t) : metric === 'energy' ? `${Math.round(t)} J` : fmtPoints(Math.round(t));
}

/** What the objective asks, in a word or number. */
export function objectiveShort(o: Objective): string {
  switch (o.kind) {
    case 'crowns': return 'all crowns';
    case 'skyline': return `skyline ${o.maxH} h`;
    case 'collapse': return pct(o.min);
    case 'hold': return 'crown up';
    case 'quake': return 'condemned down';
    case 'fold': return `${pct(o.min)}, in the lot`;
    case 'bell': return 'ring the bell';
    case 'trial': return 'pass the test';
  }
}

/** "2 shots", or "2 pulls" on a rack of pulls only (Undercut's par puzzles). */
const shotCount = (n: number, rack: readonly string[] = []) => {
  const word = rack.length && rack.every((x) => x === 'pull') ? 'pull' : 'shot';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
};

/** The three star targets of a compiled level: the objective, then T2 and T3 ('' when uncast: the door shows the objective's row alone), and par for par levels. */
export function starTargets(c: CompiledLevel, stars: StarsDef | undefined): { targets: [string, string, string]; short: [string, string, string]; cast: boolean } {
  const d = c.def;
  const heritage = c.meta.heritage.length ? ', heritage intact' : '';
  const one = cap(objectiveText(d.objective)), oneShort = objectiveShort(d.objective);
  // Par levels (keystone parStars): three stars less one per stroke over par and one for broken heritage.
  if (scoringOf(d) === 'par') return { targets: [one, `…in ${shotCount(d.par + 1, d.rack)}`, `…in par (${shotCount(d.par, d.rack)})${heritage}`], short: [oneShort, shotCount(d.par + 1, d.rack), `par ${d.par}`], cast: true };
  if (!stars) return { targets: [one, '', ''], short: [oneShort, '', ''], cast: false };
  return {
    targets: [one, cap(thresholdText(stars.metric, stars.t2)), `${cap(thresholdText(stars.metric, stars.t3))}${heritage}`],
    short: [oneShort, thresholdShort(stars.metric, stars.t2), thresholdShort(stars.metric, stars.t3)],
    cast: true,
  };
}

/**
 * The door's view of each level, as the page will play it (overrides and engine applied), with the best play on its
 * hash. `skip` leaves levels out (uncompiled: the closed Trials toggle's); the rest keep their index in `levels`.
 */
export function doorLevels(levels: readonly LevelDef[], best: (id: string, hash: string) => LevelRecord | null, compiled: (d: LevelDef) => CompiledLevel = compileLevel, skip: (d: LevelDef) => boolean = () => false): DoorLevel[] {
  return levels.flatMap((d, index) => {
    if (skip(d)) return [];
    const c = compiled(d), stars = castStars(c);
    return [{
      id: d.id, tag: levelTag(d), name: playerName(d), blocks: c.meta.n, rack: rackText(d.rack), ...starTargets(c, stars), custom: Boolean(d.custom), best: d.custom ? null : best(d.id, c.hash),
      index, series: seriesTitle(d.id), trial: isTrial(d.id),
    }];
  });
}

/** The card the door's Play button opens (an index into `levels`): the first rated level not yet cleared (no star), else the first rated one, else the first. */
export function nextLevel(levels: readonly DoorLevel[]): number {
  const i = levels.findIndex((l) => !l.trial && (!l.best || l.best.stars === 0));
  if (i >= 0) return i;
  const rated = levels.findIndex((l) => !l.trial);
  return rated < 0 ? 0 : rated;
}

/**
 * What the opened trials toggle says (PT18: the first blurb spoke of the engine's test scenes and the mode probes'
 * builds; the player wants to know what these are to them, not where they came from).
 */
export const TRIALS_BLURB = 'More structures to bring down, just for fun. They are unrated: no stars, just a goal to meet, and they are not balanced like the levels above. The best of them will become rated levels.';

/** The best play in words: stars, then what it reached. */
export function bestText(b: LevelRecord | null): string {
  if (!b) return 'Not played yet';
  const what = b.metric === 'score' ? `${fmtPoints(b.total)} points` : b.collapse !== undefined ? `${pct(b.collapse)} down` : `${fmtPoints(b.total)} points`;
  return `Best ${what} · ${b.plays} play${b.plays === 1 ? '' : 's'}${b.beatBot ? ' · beat the bot' : ''}${b.gold ? ' · gold leverage' : ''}`;
}

/** How to play's Bullet Time line (playtest PT8: the T key was named only in the key list). */
export const BULLET_TIME_HOW = 'Bullet Time levels give you a few freezes: while a shot runs, <span class="kg-desk"><kbd>T</kbd></span><span class="kg-tch">Freeze</span> stops the world. Aim and fire into it for a shot that is free against par; resuming without firing keeps the freeze.';

/** How to play's Siege Table line (PT18: the two-player mode was on the door but not in How to play). */
export const SIEGE_TABLE_HOW = `${DUEL_NAMES.mode}: two players on one device take turns, each from their own side, passing the device between shots. ${DUEL_NAMES.rulesets.keeps}: topple the other king to win, and keep your own standing. ${DUEL_NAMES.rulesets.heraldry}: each shot scores the rival's blocks it brings down, less your own.`;

/** One mode's page of How to play: a tab (its title) and one or two lines (HTML). */
export interface HowMode { readonly id: string; readonly title: string; readonly lines: readonly string[] }

/**
 * How to play, one page per mode, one or two lines each (PT37, agent playtest 2: seven bullets of jargon, leverage,
 * gold line, Brute, bank, before a single shot, with the Siege Table rule below the fold on a phone held sideways).
 * Basics comes first; the page that opens is the mode of the level behind the door (howModeOf). The words the
 * game uses on its cards (par, heritage, leverage, Bank) are each explained where they first matter.
 */
export const HOW_TO_PLAY: readonly HowMode[] = [
  { id: 'basics', title: 'Basics', lines: [
    '<span class="kg-desk">Click a spot on the structure to fire at it; drag to look around.</span><span class="kg-tch">Touch the structure and drag to aim; lift your finger to fire. Two fingers turn and zoom.</span> Fire again whenever you like.',
    'Blocks with a gold ⌖ are the ones to bring down. Teal ⛨ blocks are heritage: spare them. Each card says what earns its stars.',
  ] },
  { id: 'chamber', title: 'Chamber', lines: [
    'Bring every gold ⌖ block down within par (the card\'s shot count) for three stars; each extra shot or cracked heritage costs one.',
    LEVERAGE_MEANS,
  ] },
  { id: 'spectacle', title: 'Spectacle', lines: [
    'A few big shots at a big structure: bring as much down as you can. More down, more stars.',
    '<kbd>B</kbd> Bank ends the level early and turns the shots you have left into points.',
  ] },
  { id: 'bullet', title: 'Bullet Time', lines: [BULLET_TIME_HOW] },
  { id: 'undercut', title: 'Undercut', lines: [
    'No shots: pull blocks out one at a time (never a gold ⌖ or teal ⛨ one) so the structure falls the way the level asks. Fewer pulls, more stars.',
    'On a Hollow level, take as much as you dare while the crown stays up, and Bank before it falls.',
  ] },
  { id: 'rube', title: 'Rube Lab', lines: [
    'Build a contraption from the parts bin that carries the ball to the bell, then press Play to open the trapdoor.',
    'Ring the bell to clear it; the fewer parts you use, the more stars.',
  ] },
  { id: 'fuse', title: 'Fuse & Fold', lines: [
    'Set when each charge goes off on the timeline, then press the plunger.',
    'Fold the building down into its own lot without touching its neighbours.',
  ] },
  { id: 'aftershock', title: 'Aftershock', lines: [
    'Design one earthquake: its strength, frequency, length and direction. Then let it go.',
    'Bring down the gold ⌖ towers and leave the teal ⛨ towers standing. The less energy your quake uses, the more stars.',
  ] },
  { id: 'wavefront', title: 'Wavefront', lines: [
    'One push starts a wave of falling towers and dominoes. Choose where to push, or pull pieces out while the wave runs to save what is left.',
  ] },
  { id: 'siege', title: DUEL_NAMES.mode, lines: [SIEGE_TABLE_HOW] },
];

/** Each series' How to play page, by its title (SERIES_TITLES); a series not listed opens Basics. */
const HOW_BY_SERIES: Readonly<Record<string, string>> = { Chamber: 'chamber', Spectacle: 'spectacle', Undercut: 'undercut', 'Rube Lab': 'rube', 'Fuse & Fold': 'fuse', Aftershock: 'aftershock', Wavefront: 'wavefront' };

/** The How to play page that opens first: Bullet Time on a level with freezes, else its series' page, else Basics. */
export function howModeOf(def: Pick<LevelDef, 'id' | 'freeze'> | null | undefined): string {
  if (!def) return 'basics';
  if (def.freeze !== undefined) return 'bullet';
  return HOW_BY_SERIES[seriesTitle(def.id)] ?? 'basics';
}

/** A duel table as the door's Two players section shows it. */
export interface DoorDuel { id: string; name: string; ruleset: string; blurb: string; current: boolean }

/** One line on what each ruleset asks, for its card. */
export const RULESET_BLURB: Record<DuelDef['ruleset'], string> = {
  keeps: 'Take turns firing from behind your keep. Topple the other king to win; topple your own and you lose.',
  heraldry: 'One tower in both colours. Each shot scores the rival blocks it brings down, less your own.',
};

/** The door's view of the duel tables; `current` is the one being played (or null). */
export function doorDuels(duels: readonly DuelDef[], current: string | null): DoorDuel[] {
  return duels.map((d) => ({ id: d.id, name: d.name, ruleset: DUEL_NAMES.rulesets[d.ruleset], blurb: RULESET_BLURB[d.ruleset], current: d.id === current }));
}

/** ?duels=1 (default: the door shows the Two players section) or 0 (hidden: the playtest build's switch). */
export function duelsOnDoor(q: URLSearchParams): boolean {
  const v = q.get('duels') ?? '1';
  if (v !== '0' && v !== '1') throw new Error(`duels must be 0 or 1: ${v}`);
  return v === '1';
}

export interface DoorModel {
  /** The Two players section's tables (empty: no section). */
  duels?: DoorDuel[];
  levels: DoorLevel[];
  /** The level loaded behind the door (its card is marked), as its index in the page's level list (DoorLevel.index), or -1. */
  current: number;
  /** The Trials toggle: how many trials the page has and whether their cards show (absent: no toggle). */
  trials?: { count: number; open: boolean };
  settings: Settings;
  /** The how-to-play panel is open. */
  howTo: boolean;
  /** Its page (HowMode.id); absent: Basics. */
  howMode?: string;
  /** The Advanced settings panel (sound, look, camera, rapid fire, duel turns, hand-over, launch height, stone marks, layout, sharpness, quality, forget my progress) is open; closed by default. */
  advanced: boolean;
  /** Under Advanced settings, the Developer settings disclosure (every other setting, and Forget my progress) is open. */
  developer?: boolean;
  /** Forget my progress was clicked and asks to be confirmed. */
  resetAsk?: boolean;
  /** The tier the probe picked on load, which Auto takes (quality.ts); null or absent when none ran. */
  detected?: QualityTier | null;
}

/** The door's markup. Every button carries data-act (play, level, how, howmode, advanced, developer, trials, each setting's own act, reset, reset-yes, reset-no, close) and data-arg where it needs one. */
export function doorHtml(m: DoorModel): string {
  const next = nextLevel(m.levels);
  const card = (l: DoorLevel, i: number) => {
    const earned = l.best?.stars ?? 0;
    // An uncast level has the objective's star only: its row alone, and one star slot.
    const most = l.cast ? 3 : 1;
    // An unrated trial has no stars at all (PT37): its goal, and whether it was met.
    const rows = l.trial
      ? `<li class="${earned ? 'got' : ''}"><span class="s">Goal</span>${esc(l.targets[0])}</li>`
      : l.targets.slice(0, most).map((t, k) => `<li class="${earned > k ? 'got' : ''}"><span class="s">${'★'.repeat(k + 1)}</span>${esc(t)}</li>`).join('');
    const short = l.trial
      ? `<span class="${earned ? 'got' : ''}"><b>Goal</b> ${esc(l.short[0])}</span>`
      : l.short.slice(0, most).map((t, k) => `<span class="${earned > k ? 'got' : ''}"><b>${'★'.repeat(k + 1)}</b> ${esc(t)}</span>`).join(' · ');
    const best = l.trial
      ? `${earned ? '<span class="met">Goal met</span> · ' : ''}${esc(bestText(l.best))}`
      : `<span class="earned">${'★'.repeat(earned)}</span><span class="unearned">${'☆'.repeat(Math.max(0, most - earned))}</span> ${esc(bestText(l.best))}`;
    return `<button class="card${l.index === m.current ? ' current' : ''}${i === next ? ' next' : ''}${l.trial ? ' trial' : ''}" data-act="level" data-arg="${l.index}" data-id="${esc(l.id)}" aria-label="${esc(`${l.tag} ${l.name}`)}">
      <div class="id">${esc(l.tag)}</div>
      <div class="lname">${esc(l.name)}</div>
      <div class="meta">${l.blocks.toLocaleString('en-US')} blocks · ${esc(l.rack)}</div>
      <ul class="targets">${rows}</ul>
      <div class="short">${short}</div>
      <div class="best">${best}</div>
      ${l.custom ? `<div class="custom">${CUSTOM_NOTE}</div>` : ''}
    </button>`;
  };
  // A section per series, in the order given, headed by its title when the door shows more than one; the trials last, behind their toggle.
  const rated = m.levels.map((l, i) => [l, i] as const).filter(([l]) => !l.trial), titles = [...new Set(rated.map(([l]) => l.series))];
  const sections = titles.map((t) => {
    const cards = rated.filter(([l]) => l.series === t).map(([l, i]) => card(l, i)).join('');
    return `${titles.length > 1 && t ? `<h2 class="series-head">${esc(t)}</h2>` : ''}<div class="cards">${cards}</div>`;
  }).join('');
  const trialCards = m.trials?.open ? m.levels.map((l, i) => [l, i] as const).filter(([l]) => l.trial).map(([l, i]) => card(l, i)).join('') : '';
  const trials = m.trials ? `<button data-act="trials" class="series-head trials-head${m.trials.open ? ' on' : ''}" aria-expanded="${m.trials.open}">${esc(SERIES_TITLES.at(-1)!)} (${m.trials.count}) ${m.trials.open ? '▾' : '▸'}</button>
      ${m.trials.open ? `<div class="trials-blurb">${esc(TRIALS_BLURB)}</div><div class="cards trials">${trialCards}</div>` : ''}` : '';
  const play = m.levels[next], here = m.levels.find((l) => l.index === m.current);
  const s = m.settings;
  return `
    <div class="door-inner">
      <div class="head">
      <h1>Keystone</h1>
      <div class="tag">Bring it down.</div>
      <div class="ctas">
        ${play ? `<button class="play" data-act="level" data-arg="${play.index}">Play · ${esc(play.name)}</button>` : ''}
        ${here && here !== play ? `<button data-act="close" class="close"><kbd>Esc</kbd> Back to ${esc(here.name)}</button>` : ''}
      </div>
      <button data-act="how" class="howlink${m.howTo ? ' on' : ''}">How to play</button>
      </div>
      ${m.howTo ? howHtml(m.howMode) : ''}
      ${sections}
      ${duelsHtml(m.duels ?? [])}
      ${trials}
      <button data-act="advanced" class="howlink advlink${m.advanced ? ' on' : ''}" aria-expanded="${m.advanced}">Advanced settings</button>
      ${m.advanced ? `<div class="advanced">
      <div class="foot">
        ${settingRows(s, { detected: m.detected ?? null, esc }, 'player').join('\n        ')}
      </div>
      <button data-act="developer" class="howlink devlink${m.developer ? ' on' : ''}" aria-expanded="${Boolean(m.developer)}">Developer settings ${m.developer ? '▾' : '▸'}</button>
      ${m.developer ? `<div class="developer">
      <div class="foot">
        ${settingRows(s, { detected: m.detected ?? null, esc }, 'developer').join('\n        ')}
      </div>
      <div class="reset">${m.resetAsk
        ? `<span class="ask">Forget every best play and star on this device?</span> <button data-act="reset-yes" class="yes">Forget</button> <button data-act="reset-no" class="no">Keep</button>`
        : '<button data-act="reset">Forget my progress…</button>'}</div>
      </div>` : ''}
      </div>` : ''}
    </div>`;
}

/** The How to play panel: a tab per mode and the open mode's lines (PT37). */
function howHtml(mode: string | undefined): string {
  const open = HOW_TO_PLAY.find((h) => h.id === mode) ?? HOW_TO_PLAY[0]!;
  const tabs = HOW_TO_PLAY.map((h) => `<button data-act="howmode" data-arg="${h.id}" class="${h === open ? 'on' : ''}">${esc(h.title)}</button>`).join('');
  return `<div class="how"><div class="how-tabs" role="tablist">${tabs}</div><ul data-mode="${open.id}">${open.lines.map((t) => `<li>${t}</li>`).join('')}</ul></div>`;
}

/** The Two players section: one card per duel table (data-act="duel", data-arg its id). */
function duelsHtml(duels: readonly DoorDuel[]): string {
  if (!duels.length) return '';
  const cards = duels.map((d) => `<button class="card duel${d.current ? ' current' : ''}" data-act="duel" data-arg="${esc(d.id)}" aria-label="${esc(`${d.id} ${d.name}`)}">
      <div class="id">${esc(d.id)}</div>
      <div class="lname">${esc(d.name)}</div>
      <div class="meta">${d.ruleset === d.name ? '' : `${esc(d.ruleset)} · `}2 players, one device</div>
      <div class="blurb">${esc(d.blurb)}</div>
    </button>`).join('');
  return `<h2 class="duels-head">${esc(DUEL_NAMES.mode)} · two players</h2><div class="cards duels">${cards}</div>`;
}

/** The door's styles, scoped to .kg-door (the palette is the HUD's, ui.ts). */
export const DOOR_CSS = `
  .kg-door { position: fixed; inset: 0; display: none; overflow-y: auto; background: radial-gradient(ellipse at 50% 30%, rgba(17, 20, 28, 0.35), rgba(17, 20, 28, 0.82)); color: #e8ebf2; font: 14px/1.45 system-ui, sans-serif; z-index: 10; }
  .kg-door.show { display: block; animation: kg-fade 0.25s ease-out; }
  body.door-open .kg-hud, body.door-open .kg-help, body.door-open .kg-result, body.door-open .kg-banner { visibility: hidden; }
  .kg-door .head { display: contents; }
  .kg-door .door-inner { box-sizing: border-box; min-height: 100%; max-width: 960px; margin: 0 auto; padding: 32px 16px; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
  .kg-door h1 { margin: 0; font: 900 clamp(40px, 8vw, 76px)/1 system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; text-shadow: 0 4px 24px rgba(0, 0, 0, 0.5); }
  .kg-door .tag { margin: 6px 0 22px; color: #f7b955; font-size: 18px; font-weight: 600; letter-spacing: 0.04em; }
  .kg-door button { font: inherit; color: inherit; border: 0; cursor: pointer; }
  .kg-door .ctas { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 10px; }
  .kg-door .play { padding: 12px 26px; border-radius: 10px; background: #d8693f; color: #fff; font-size: 18px; font-weight: 700; box-shadow: 0 6px 20px rgba(216, 105, 63, 0.35); }
  .kg-door .play:hover, .kg-door .play:focus-visible { background: #e57a4f; }
  .kg-door .close { padding: 10px 16px; border-radius: 10px; background: rgba(17, 20, 28, 0.7); box-shadow: inset 0 0 0 1px #4d5a75; }
  .kg-door .howlink { margin-top: 12px; padding: 2px 6px; background: none; color: #9fc3ff; text-decoration: underline; text-underline-offset: 3px; }
  .kg-door .howlink.on { color: #e8ebf2; }
  .kg-door .advlink { display: block; margin: 0 auto 10px; font-size: 13px; color: #8a93a8; }
  .kg-door .advanced { margin-top: 4px; }
  .kg-door .cards { align-self: stretch; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 22px 0 18px; text-align: left; }
  .kg-door .card { display: flex; flex-direction: column; justify-content: flex-start; padding: 14px 16px; border-radius: 12px; background: rgba(17, 20, 28, 0.78); backdrop-filter: blur(6px); border: 2px solid transparent; text-align: left; transition: transform 0.12s, border-color 0.12s; }
  .kg-door .card:hover, .kg-door .card:focus-visible { transform: translateY(-2px); border-color: rgba(159, 195, 255, 0.4); }
  .kg-door .card.next { border-color: #d8693f; }
  .kg-door .card .id { align-self: flex-start; display: inline-block; padding: 1px 7px; border-radius: 5px; background: #3a4459; color: #9fc3ff; font: 700 12px/1.6 system-ui, sans-serif; letter-spacing: 0.02em; }
  .kg-door .card.next .id::after { content: ' · next up'; color: #f2a07e; }
  .kg-door .lname { margin-top: 6px; font-size: 19px; font-weight: 700; }
  .kg-door .meta { color: #a6aec0; font-size: 12px; font-variant-numeric: tabular-nums; }
  .kg-door .targets { list-style: none; margin: 10px 0 8px; padding: 0; font-size: 13px; }
  .kg-door .targets li { display: flex; gap: 8px; padding: 2px 0; color: #c7cdda; }
  .kg-door .targets li .s { flex: none; min-width: 3.2em; color: #7a8296; letter-spacing: -0.05em; }
  .kg-door .targets li.got .s, .kg-door .short .got b { color: #f7b955; }
  .kg-door .short { display: none; margin: 8px 0; font-size: 13px; color: #c7cdda; font-variant-numeric: tabular-nums; }
  .kg-door .short b { color: #7a8296; font-weight: 400; letter-spacing: -0.05em; }
  .kg-door .best { margin-top: auto; padding-top: 8px; border-top: 1px solid #2b3242; font-size: 12px; color: #a6aec0; font-variant-numeric: tabular-nums; }
  .kg-door .best .earned { color: #f7b955; font-size: 15px; letter-spacing: 0.04em; }
  .kg-door .best .unearned { color: #6b7385; font-size: 15px; letter-spacing: 0.04em; margin-right: 4px; }
  .kg-door .custom { margin-top: 4px; font-size: 11px; color: #f0806a; }
  .kg-door .series-head { align-self: stretch; margin: 6px 0 0; font-size: 15px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #9fc3ff; text-align: left; }
  .kg-door .series-head + .cards { margin-top: 10px; }
  .kg-door button.trials-head { padding: 6px 0; background: none; text-align: center; color: #8a93a8; }
  .kg-door button.trials-head.on, .kg-door button.trials-head:hover { color: #9fc3ff; }
  .kg-door .trials-blurb { max-width: 620px; margin: 4px auto 0; font-size: 13px; color: #a6aec0; }
  .kg-door .cards.trials { margin-top: 10px; }
  .kg-door .card.trial .id { background: #3b3448; color: #d2b8ff; }
  .kg-door .duels-head { margin: 4px 0 0; font-size: 15px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #9fc3ff; }
  .kg-door .cards.duels { margin-top: 10px; }
  .kg-door .card.duel .blurb { margin-top: 8px; font-size: 13px; color: #c7cdda; }
  .kg-door .card.current { border-color: #9fc3ff; }
  .kg-door .foot { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 10px 20px; }
  .kg-door .foot .group { display: inline-flex; align-items: center; gap: 6px; }
  .kg-door .foot .lbl { color: #a6aec0; font-size: 13px; }
  .kg-door .seg { display: inline-flex; border-radius: 7px; box-shadow: inset 0 0 0 1px #3a4459; overflow: hidden; }
  /* A segmented control: the selected side filled in the accent, the rest outlined on the panel (PT18: it was the other way round to the eye). */
  .kg-door .seg { background: rgba(17, 20, 28, 0.6); box-shadow: inset 0 0 0 1px #4d5a75; }
  .kg-door .seg button { padding: 5px 11px; background: transparent; color: #c7cdda; border-radius: 0; }
  .kg-door .seg button + button { border-left: 1px solid #4d5a75; }
  .kg-door .seg button:not(.on):hover { background: rgba(159, 195, 255, 0.12); }
  .kg-door .seg button.on { background: #9fc3ff; color: #11141c; font-weight: 650; }
  .kg-door kbd { font: 600 11px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 3px; background: #3a4459; color: #e8ebf2; margin-right: 2px; }
  .kg-door .how { box-sizing: border-box; width: min(660px, 100%); margin: 10px auto 0; padding: 10px 14px 12px; border-radius: 10px; background: rgba(17, 20, 28, 0.78); text-align: left; }
  .kg-door .how-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .kg-door .how-tabs button { padding: 3px 9px; border-radius: 6px; background: transparent; color: #c7cdda; font-size: 13px; box-shadow: inset 0 0 0 1px #4d5a75; }
  .kg-door .how-tabs button.on { background: #9fc3ff; color: #11141c; font-weight: 650; box-shadow: none; }
  .kg-door .how ul { margin: 0; padding-left: 20px; }
  .kg-door .how li { margin: 4px 0; }
  .kg-door .devlink { display: block; margin: 14px auto 0; font-size: 12px; color: #8a93a8; }
  .kg-door .developer { margin-top: 8px; }
  .kg-door .reset { margin-top: 18px; font-size: 12px; color: #a6aec0; }
  .kg-door .reset button { background: none; color: #6f7890; font-size: 12px; text-decoration: underline; }
  .kg-door .reset button.yes { padding: 4px 10px; border-radius: 6px; background: #b9623f; color: #fff; text-decoration: none; }
  .kg-door .reset button.no { padding: 4px 10px; border-radius: 6px; background: #3a4459; color: #e8ebf2; text-decoration: none; }
  .kg-door .best .met { color: #f7b955; }
  .kg-menu kbd { font: 600 10px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 3px; background: #3a4459; margin-left: 4px; }
  .kg-menu { position: fixed; top: 12px; right: 12px; padding: 6px 10px; border: 0; border-radius: 8px; background: rgba(17, 20, 28, 0.8); color: #e8ebf2; font: 13px/1.2 system-ui, sans-serif; cursor: pointer; }
  .kg-hud button.opener { font: inherit; padding: 6px 12px; border: 0; border-radius: 6px; background: #d8693f; color: #fff; cursor: pointer; margin-top: 6px; font-weight: 650; animation: kg-pulse 1.6s ease-in-out infinite; }
  @keyframes kg-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes kg-pulse { 50% { box-shadow: 0 0 0 6px rgba(216, 105, 63, 0.25); } }
  @media (max-width: 640px) {
    .kg-door .door-inner { justify-content: flex-start; padding-top: 24px; }
    .kg-door .tag { margin-bottom: 16px; }
    .kg-door .cards { grid-template-columns: 1fr; gap: 8px; margin-top: 16px; }
    .kg-door .card { padding: 10px 14px; }
    .kg-door .lname { font-size: 17px; margin-top: 4px; }
    .kg-door .targets { display: none; }
    .kg-door .short { display: block; }
    .kg-menu kbd { display: none; }
  }
  /*
   * A phone on its side (PT18): the title, tagline, Play and How to play share one row and the cards go compact,
   * so the first screen shows whole cards (the playtest's 844 x 390 showed the title and Play and cut the first
   * cards at their first line).
   */
  @media (orientation: landscape) and (max-height: 500px) {
    .kg-door .door-inner { justify-content: flex-start; padding: 10px 16px 20px; }
    .kg-door .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 18px; }
    .kg-door h1 { font-size: 30px; letter-spacing: 0.1em; }
    .kg-door .tag { margin: 0; font-size: 15px; }
    .kg-door .play { padding: 8px 18px; font-size: 16px; }
    .kg-door .head .howlink { margin: 0; }
    .kg-door .series-head { font-size: 13px; margin-top: 2px; }
    .kg-door .cards { gap: 8px; margin: 10px 0 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
    .kg-door .series-head + .cards { margin-top: 6px; }
    .kg-door .card { padding: 8px 12px; }
    .kg-door .lname { font-size: 16px; margin-top: 3px; }
    .kg-door .targets { display: none; }
    .kg-door .short { display: block; margin: 6px 0; }
    .kg-door .best { padding-top: 6px; }
  }
`;

/** ?keystone.preaim: auto (default: the series' first level, for a player who has not played it), 1 (every level with a recorded line) or 0 (never). */
export type PreaimMode = 'auto' | '1' | '0';

export function preaimMode(q: URLSearchParams): PreaimMode {
  const v = q.get('keystone.preaim') ?? 'auto';
  if (v !== 'auto' && v !== '1' && v !== '0') throw new Error(`keystone.preaim must be auto, 1 or 0: ${v}`);
  return v;
}

/**
 * The pre-aimed opening shot for level def at index `index` of its series: the level's chosen opener
 * (solutions.opener: a shot that wins it alone, PT13), else the first shot of its best recorded line
 * (solutions.ace, else solutions.par), or null. Under auto only the series' first level has
 * one, and only until the player has a record for it: the first-minute promise is for a first visit, and
 * handing every level its best opener would give the stars away.
 */
export function openerFor(def: LevelDef, index: number, mode: PreaimMode, played: boolean): Shot | null {
  if (mode === '0' || (mode === 'auto' && (index !== 0 || played))) return null;
  return def.solutions?.opener ?? def.solutions?.ace?.[0] ?? def.solutions?.par?.[0] ?? null;
}
