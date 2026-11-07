// The front door (roadmap G7): the title, the series' levels with their star
// targets and the player's best, how to play, and the settings. Formatting is
// pure (doorLevels, doorHtml) and tested; the page (main.ts) shows it over the
// level already loading behind it, so the first shot is one click away.
//
// Every series shows, each under its title (Spectacle, Chamber, Undercut), and
// the trials (keystone trial-levels.ts: unrated: 16 after PT11's pruning, then the C9 workshop) under a toggle,
// closed by default so the door neither scrolls past them nor compiles them
// (a 10k trial compiles in 20-30 ms) until the player opens it.
//
// Star targets come from each level's cast stars (stars.json via castStars):
// a level with none (a trial, or a level whose cast has not landed) shows the
// objective's star alone, one target row and one star slot, never a placeholder
// (the agent playtest's PT7: "targets coming soon" read as unfinished), and picks
// the rest up from the file with no change here.
import { castStars, type CompiledLevel, compileLevel, DUEL_NAMES, type DuelDef, isTrial, type LevelDef, type Objective, scoringOf, SERIES, SERIES_TITLES, type Shot, type StarMetric, type StarsDef } from '@tb/keystone';
import { CUSTOM_NOTE, esc, fmtPoints, itemLabel, LEVERAGE_MEANS, objectiveText, pct } from './hud.ts';
import type { LevelRecord } from './progress.ts';
import type { QualitySetting, QualityTier } from './quality.ts';
import { LOOK_CHOICES, QUALITY_CHOICES, type Settings } from './settings.ts';

/** The Quality buttons' tooltips (docs/game/quality-tiers.md). */
export const QUALITY_TITLES: Readonly<Record<QualitySetting, string>> = {
  auto: 'Picked for this device when the page loads',
  high: 'Full resolution, every effect',
  mid: 'One pixel per screen point: a quarter of the pixels on a sharp screen',
  low: 'Half resolution, no ambient occlusion, no sparks or dust',
};

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
  return metric === 'collapse' || metric === 'skyline' || metric === 'pulled' ? pct(t) : fmtPoints(Math.round(t));
}

/** What the objective asks, in a word or number. */
export function objectiveShort(o: Objective): string {
  switch (o.kind) {
    case 'crowns': return 'all crowns';
    case 'skyline': return `skyline ${o.maxH} h`;
    case 'collapse': return pct(o.min);
    case 'hold': return 'crown up';
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
      id: d.id, name: d.name, blocks: c.meta.n, rack: rackText(d.rack), ...starTargets(c, stars), custom: Boolean(d.custom), best: d.custom ? null : best(d.id, c.hash),
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

/** What the trials toggle says: how many there are, the blurb, open or closed. */
export const TRIALS_BLURB = 'More structures to bring down, just for fun. They are unrated: meeting the objective is the only star, and they are not balanced like the levels above. The best of them will become rated levels.';

/** The best play in words: stars, then what it reached. */
export function bestText(b: LevelRecord | null): string {
  if (!b) return 'Not played yet';
  const what = b.metric === 'score' ? `${fmtPoints(b.total)} points` : b.collapse !== undefined ? `${pct(b.collapse)} down` : `${fmtPoints(b.total)} points`;
  return `Best ${what} · ${b.plays} play${b.plays === 1 ? '' : 's'}${b.beatBot ? ' · beat the bot' : ''}${b.gold ? ' · gold leverage' : ''}`;
}

/** How to play's Bullet Time line (playtest PT8: the T key was named only in the key list). */
export const BULLET_TIME_HOW = 'Bullet Time levels give you a few freezes. While a shot is still running, <span class="kg-desk"><kbd>T</kbd></span><span class="kg-tch">Freeze</span> stops the world: aim and fire, and the new shot cuts in at that moment and spends one freeze; that shot is free against par. Resuming without firing keeps the freeze.';

/** How to play, in six lines (the controls line is GAME_HELP's, shown in play). */
export const HOW_TO_PLAY: readonly string[] = [
  '<span class="kg-desk">Pick a spot on the structure and click to fire. Drag to look around; the launcher follows you.</span><span class="kg-tch">Touch the structure and drag to aim; lift your finger to fire. Two fingers turn the view and pinch to zoom; the launcher follows you. Put a second finger down to call off a shot.</span>',
  'Fire again whenever you like, even while things are still falling. Once everything settles, the world waits while you aim; <kbd>K</kbd> or Skip runs the rest of a shot fast. Rubble stays between shots.',
  BULLET_TIME_HOW,
  'Meet the objective for one star. Chamber levels: clear in par for three, each shot over par or piece of heritage broken costs one, and leverage at the level\'s gold line earns the gold badge. Elsewhere, bring more down for two and three; the targets were set by a bot playing each level hundreds of times.',
  'After any shot you may <kbd>B</kbd> bank: end the level and keep the unused rack as points.',
  `${LEVERAGE_MEANS} The card shows the whole round's; Brute is under the level's gold line, Clean at it. A score never goes below 0: cracked heritage shows as its own red line and costs stars.`,
];

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
  /** The Advanced settings panel (sound, look, camera, rapid fire, duel turns, hand-over, launch height, stone marks, layout, sharpness, quality, forget my progress) is open; closed by default. */
  advanced: boolean;
  /** The tier the probe picked on load, which Auto takes (quality.ts); null or absent when none ran. */
  detected?: QualityTier | null;
}

/** The door's markup. Every button carries data-act (play, level, how, advanced, trials, sound, look, sharp, quality, camera, rapid, duelview, handoff, launch, marks, layout, reset, close) and data-arg where it needs one. */
export function doorHtml(m: DoorModel): string {
  const next = nextLevel(m.levels);
  const card = (l: DoorLevel, i: number) => {
    const earned = l.best?.stars ?? 0;
    // An uncast level has the objective's star only: its row alone, and one star slot.
    const most = l.cast ? 3 : 1;
    const rows = l.targets.slice(0, most).map((t, k) => `<li class="${earned > k ? 'got' : ''}"><span class="s">${'★'.repeat(k + 1)}</span>${esc(t)}</li>`).join('');
    const short = l.short.slice(0, most).map((t, k) => `<span class="${earned > k ? 'got' : ''}"><b>${'★'.repeat(k + 1)}</b> ${esc(t)}</span>`).join(' · ');
    return `<button class="card${l.index === m.current ? ' current' : ''}${i === next ? ' next' : ''}${l.trial ? ' trial' : ''}" data-act="level" data-arg="${l.index}" aria-label="${esc(`${l.id} ${l.name}`)}">
      <div class="id">${esc(l.id)}</div>
      <div class="lname">${esc(l.name)}</div>
      <div class="meta">${l.blocks.toLocaleString('en-US')} blocks · ${esc(l.rack)}</div>
      <ul class="targets">${rows}</ul>
      <div class="short">${short}</div>
      <div class="best"><span class="earned">${'★'.repeat(earned)}</span><span class="unearned">${'☆'.repeat(Math.max(0, most - earned))}</span> ${esc(bestText(l.best))}</div>
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
  const tierName = (t: QualityTier) => QUALITY_CHOICES.find((c) => c.quality === t)!.label;
  const qualities = QUALITY_CHOICES.map((c) => `<button data-act="quality" data-arg="${c.quality}" class="${s.quality === c.quality ? 'on' : ''}" title="${esc(QUALITY_TITLES[c.quality])}">${c.quality === 'auto' && m.detected ? `Auto (${tierName(m.detected)})` : c.label}</button>`).join('');
  const looks = LOOK_CHOICES.map((c) => `<button data-act="look" data-arg="${c.look}" class="${s.look === c.look ? 'on' : ''}">${c.label}</button>`).join('');
  return `
    <div class="door-inner">
      <h1>Keystone</h1>
      <div class="tag">Bring it down.</div>
      <div class="ctas">
        ${play ? `<button class="play" data-act="level" data-arg="${play.index}">Play · ${esc(play.name)}</button>` : ''}
        ${here && here !== play ? `<button data-act="close" class="close"><kbd>Esc</kbd> Back to ${esc(here.name)}</button>` : ''}
      </div>
      <button data-act="how" class="howlink${m.howTo ? ' on' : ''}">How to play</button>
      ${m.howTo ? `<ul class="how">${HOW_TO_PLAY.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
      ${sections}
      ${duelsHtml(m.duels ?? [])}
      ${trials}
      <button data-act="advanced" class="howlink advlink${m.advanced ? ' on' : ''}" aria-expanded="${m.advanced}">Advanced settings</button>
      ${m.advanced ? `<div class="advanced">
      <div class="foot">
        <span class="group"><span class="lbl">Sound</span><span class="seg"><button data-act="sound" class="${s.sound ? 'on' : ''}">${s.sound ? 'On' : 'Off'}</button></span></span>
        <span class="group"><span class="lbl">Look</span><span class="seg">${looks}</span></span>
        <span class="group"><span class="lbl">Camera</span><span class="seg"><button data-act="camera" data-arg="still" class="${s.camera === 'still' ? 'on' : ''}" title="Moves only when you move it">Still</button><button data-act="camera" data-arg="dynamic" class="${s.camera === 'dynamic' ? 'on' : ''}" title="Follows the collapse and shakes on hits">Dynamic</button></span></span>
        <span class="group"><span class="lbl">Rapid fire</span><span class="seg"><button data-act="rapid" data-arg="on" class="${s.rapid ? 'on' : ''}" title="Fire again before the last shot settles">On</button><button data-act="rapid" data-arg="off" class="${s.rapid ? '' : 'on'}" title="Each shot waits for the last to settle">Off</button></span></span>
        <span class="group"><span class="lbl">Duel turns</span><span class="seg"><button data-act="duelview" data-arg="on" class="${s.duelView ? 'on' : ''}" title="The camera turns to the side whose turn it is">Turn the view</button><button data-act="duelview" data-arg="off" class="${s.duelView ? '' : 'on'}" title="The camera stays where the last player left it">Leave it</button></span></span>
        <span class="group"><span class="lbl">Hand-over</span><span class="seg"><button data-act="handoff" data-arg="on" class="${s.handoff ? 'on' : ''}" title="Between duel turns a card says whose turn it is: tap it to start">Card</button><button data-act="handoff" data-arg="off" class="${s.handoff ? '' : 'on'}" title="The next turn starts at once, with a banner">Skip</button></span></span>
        <span class="group"><span class="lbl">Launch height</span><span class="seg"><button data-act="launch" data-arg="high" class="${s.launch === 'high' ? 'on' : ''}" title="Shots leave from over the structure's top, clear of the rubble (keys W and S move it)">High</button><button data-act="launch" data-arg="level" class="${s.launch === 'level' ? 'on' : ''}" title="Shots leave from the level's own launcher, near the ground, where its par lines were recorded">Level's</button></span></span>
        <span class="group"><span class="lbl">Stone marks</span><span class="seg"><button data-act="marks" data-arg="on" class="${s.marks ? 'on' : ''}" title="A crosshair carved on the blocks to bring down, a shield on the blocks to keep">Carved</button><button data-act="marks" data-arg="off" class="${s.marks ? '' : 'on'}" title="Plain stones: only their colour says which are which">Off</button></span></span>
        <span class="group"><span class="lbl">Layout</span><span class="seg"><button data-act="layout" data-arg="docked" class="${s.layout === 'docked' ? 'on' : ''}" title="On a phone the HUD docks to the screen's edges; the result card waits a moment after the round, then docks aside so the collapse stays in view">Docked</button><button data-act="layout" data-arg="classic" class="${s.layout === 'classic' ? 'on' : ''}" title="One HUD panel at the top left, and the result card in the middle as soon as the round ends">Classic</button></span></span>
        <span class="group"><span class="lbl">Sharpness</span><span class="seg"><button data-act="sharp" data-arg="2" class="${s.sharp === 2 ? 'on' : ''}">Full</button><button data-act="sharp" data-arg="1" class="${s.sharp === 1 ? 'on' : ''}">Fast</button></span></span>
        <span class="group"><span class="lbl">Quality</span><span class="seg">${qualities}</span></span>
      </div>
      <div class="reset"><button data-act="reset">Forget my progress</button></div>
      </div>` : ''}
    </div>`;
}

/** The Two players section: one card per duel table (data-act="duel", data-arg its id). */
function duelsHtml(duels: readonly DoorDuel[]): string {
  if (!duels.length) return '';
  const cards = duels.map((d) => `<button class="card duel${d.current ? ' current' : ''}" data-act="duel" data-arg="${esc(d.id)}" aria-label="${esc(`${d.id} ${d.name}`)}">
      <div class="id">${esc(d.id)}</div>
      <div class="lname">${esc(d.name)}</div>
      <div class="meta">${esc(d.ruleset)} · 2 players, one device</div>
      <div class="blurb">${esc(d.blurb)}</div>
    </button>`).join('');
  return `<h2 class="duels-head">${esc(DUEL_NAMES.mode)} · two players</h2><div class="cards duels">${cards}</div>`;
}

/** The door's styles, scoped to .kg-door (the palette is the HUD's, ui.ts). */
export const DOOR_CSS = `
  .kg-door { position: fixed; inset: 0; display: none; overflow-y: auto; background: radial-gradient(ellipse at 50% 30%, rgba(17, 20, 28, 0.35), rgba(17, 20, 28, 0.82)); color: #e8ebf2; font: 14px/1.45 system-ui, sans-serif; z-index: 10; }
  .kg-door.show { display: block; animation: kg-fade 0.25s ease-out; }
  body.door-open .kg-hud, body.door-open .kg-help, body.door-open .kg-result, body.door-open .kg-banner { visibility: hidden; }
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
  .kg-door .card .id { align-self: flex-start; display: inline-block; padding: 1px 7px; border-radius: 5px; background: #3a4459; color: #9fc3ff; font: 700 12px/1.6 ui-monospace, monospace; }
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
  .kg-door .seg button { padding: 5px 11px; background: rgba(43, 50, 66, 0.85); border-radius: 0; }
  .kg-door .seg button + button { border-left: 1px solid #3a4459; }
  .kg-door .seg button.on { background: #3a4459; color: #9fc3ff; }
  .kg-door kbd { font: 600 11px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 3px; background: #3a4459; color: #e8ebf2; margin-right: 2px; }
  .kg-door .how { max-width: 620px; margin: 10px auto 0; padding: 14px 18px 14px 34px; border-radius: 10px; background: rgba(17, 20, 28, 0.78); text-align: left; }
  .kg-door .how li { margin: 4px 0; }
  .kg-door .reset { margin-top: 18px; }
  .kg-door .reset button { background: none; color: #6f7890; font-size: 12px; text-decoration: underline; }
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
