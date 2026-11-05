// The front door (roadmap G7): the title, the series' levels with their star
// targets and the player's best, how to play, and the settings. Formatting is
// pure (doorLevels, doorHtml) and tested; the page (main.ts) shows it over the
// level already loading behind it, so the first shot is one click away.
//
// Star targets come from each level's cast stars (stars.json via castStars):
// a level whose cast has not landed yet (B3 while its cast runs) shows only the
// objective's star and "more stars once cast", and picks the rest up from the
// file with no change here.
import { castStars, type CompiledLevel, compileLevel, DUEL_NAMES, type DuelDef, type LevelDef, type Objective, scoringOf, type Shot, type StarMetric, type StarsDef } from '@tb/keystone';
import { CUSTOM_NOTE, esc, fmtPoints, itemLabel, objectiveText, pct } from './hud.ts';
import type { LevelRecord } from './progress.ts';
import { LOOK_CHOICES, type Settings } from './settings.ts';

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

/** Shown for two and three stars on a level whose cast has not landed (B3 while it runs). */
export const UNCAST_TARGETS = 'targets coming soon';

/** The three star targets of a compiled level: the objective, then T2 and T3 (or UNCAST_TARGETS), and par for par levels. */
export function starTargets(c: CompiledLevel, stars: StarsDef | undefined): { targets: [string, string, string]; short: [string, string, string]; cast: boolean } {
  const d = c.def;
  const heritage = c.meta.heritage.length ? ', heritage intact' : '';
  const one = cap(objectiveText(d.objective)), oneShort = objectiveShort(d.objective);
  if (scoringOf(d) === 'par') return { targets: [one, `…in par (${d.par})`, `…in par with leverage${heritage}`], short: [oneShort, `par ${d.par}`, 'par + leverage'], cast: true };
  if (!stars) return { targets: [one, UNCAST_TARGETS, UNCAST_TARGETS], short: [oneShort, '?', '?'], cast: false };
  return {
    targets: [one, cap(thresholdText(stars.metric, stars.t2)), `${cap(thresholdText(stars.metric, stars.t3))}${heritage}`],
    short: [oneShort, thresholdShort(stars.metric, stars.t2), thresholdShort(stars.metric, stars.t3)],
    cast: true,
  };
}

/** The door's view of each level, as the page will play it (overrides and engine applied), with the best play on its hash. */
export function doorLevels(levels: readonly LevelDef[], best: (id: string, hash: string) => LevelRecord | null, compiled: (d: LevelDef) => CompiledLevel = compileLevel): DoorLevel[] {
  return levels.map((d) => {
    const c = compiled(d), stars = castStars(c);
    return { id: d.id, name: d.name, blocks: c.meta.n, rack: rackText(d.rack), ...starTargets(c, stars), custom: Boolean(d.custom), best: d.custom ? null : best(d.id, c.hash) };
  });
}

/** The level the door's Play button opens: the first not yet cleared (no star), else the first. */
export function nextLevel(levels: readonly DoorLevel[]): number {
  const i = levels.findIndex((l) => !l.best || l.best.stars === 0);
  return i < 0 ? 0 : i;
}

/** The best play in words: stars, then what it reached. */
export function bestText(b: LevelRecord | null): string {
  if (!b) return 'Not played yet';
  const what = b.metric === 'score' ? `${fmtPoints(b.total)} points` : b.collapse !== undefined ? `${pct(b.collapse)} down` : `${fmtPoints(b.total)} points`;
  return `Best ${what} · ${b.plays} play${b.plays === 1 ? '' : 's'}${b.beatBot ? ' · beat the bot' : ''}`;
}

/** How to play, in four lines (the controls line is GAME_HELP's, shown in play). */
export const HOW_TO_PLAY: readonly string[] = [
  'Pick a spot on the structure and click to fire. Drag to look around; the launcher follows you.',
  'Fire again whenever you like, even while things are still falling. Once everything settles, physics freezes while you aim. Rubble stays between shots.',
  'Meet the objective for one star. Bring more down for two and three; the targets were set by a bot playing each level hundreds of times.',
  'After any shot you may <kbd>B</kbd> bank: end the level and keep the unused rack as points.',
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
  /** The level loaded behind the door (its card is marked), or -1. */
  current: number;
  settings: Settings;
  /** The how-to-play panel is open. */
  howTo: boolean;
  /** The Advanced settings panel (sound, look, camera, rapid fire, sharpness, forget my progress) is open; closed by default. */
  advanced: boolean;
}

/** The door's markup. Every button carries data-act (play, level, how, advanced, sound, look, sharp, camera, rapid, reset, close) and data-arg where it needs one. */
export function doorHtml(m: DoorModel): string {
  const next = nextLevel(m.levels);
  const cards = m.levels.map((l, i) => {
    const earned = l.best?.stars ?? 0;
    // An uncast level's two- and three-star rows say the same thing: one row for both.
    const rows = (l.cast ? l.targets : l.targets.slice(0, 2)).map((t, k) => `<li class="${earned > k ? 'got' : ''}${!l.cast && k > 0 ? ' uncast' : ''}"><span class="s">${'★'.repeat(k + 1)}</span>${esc(t)}</li>`).join('');
    const short = l.short.map((t, k) => `<span class="${earned > k ? 'got' : ''}"><b>${'★'.repeat(k + 1)}</b> ${esc(t)}</span>`).join(' · ');
    return `<button class="card${i === m.current ? ' current' : ''}${i === next ? ' next' : ''}" data-act="level" data-arg="${i}" aria-label="${esc(`${l.id} ${l.name}`)}">
      <div class="id">${esc(l.id)}</div>
      <div class="lname">${esc(l.name)}</div>
      <div class="meta">${l.blocks.toLocaleString('en-US')} blocks · ${esc(l.rack)}</div>
      <ul class="targets">${rows}</ul>
      <div class="short">${short}</div>
      <div class="best"><span class="earned">${'★'.repeat(earned)}</span><span class="unearned">${'☆'.repeat(3 - earned)}</span> ${esc(bestText(l.best))}</div>
      ${l.custom ? `<div class="custom">${CUSTOM_NOTE}</div>` : ''}
    </button>`;
  }).join('');
  const play = m.levels[next], here = m.current >= 0 ? m.levels[m.current] : undefined;
  const s = m.settings;
  const looks = LOOK_CHOICES.map((c) => `<button data-act="look" data-arg="${c.look}" class="${s.look === c.look ? 'on' : ''}">${c.label}</button>`).join('');
  return `
    <div class="door-inner">
      <h1>Keystone</h1>
      <div class="tag">Bring it down.</div>
      <div class="ctas">
        ${play ? `<button class="play" data-act="level" data-arg="${next}">Play · ${esc(play.name)}</button>` : ''}
        ${here && here !== play ? `<button data-act="close" class="close"><kbd>Esc</kbd> Back to ${esc(here.name)}</button>` : ''}
      </div>
      <button data-act="how" class="howlink${m.howTo ? ' on' : ''}">How to play</button>
      ${m.howTo ? `<ul class="how">${HOW_TO_PLAY.map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
      <div class="cards">${cards}</div>
      ${duelsHtml(m.duels ?? [])}
      <button data-act="advanced" class="howlink advlink${m.advanced ? ' on' : ''}" aria-expanded="${m.advanced}">Advanced settings</button>
      ${m.advanced ? `<div class="advanced">
      <div class="foot">
        <span class="group"><span class="lbl">Sound</span><span class="seg"><button data-act="sound" class="${s.sound ? 'on' : ''}">${s.sound ? 'On' : 'Off'}</button></span></span>
        <span class="group"><span class="lbl">Look</span><span class="seg">${looks}</span></span>
        <span class="group"><span class="lbl">Camera</span><span class="seg"><button data-act="camera" data-arg="still" class="${s.camera === 'still' ? 'on' : ''}" title="Moves only when you move it">Still</button><button data-act="camera" data-arg="dynamic" class="${s.camera === 'dynamic' ? 'on' : ''}" title="Follows the collapse and shakes on hits">Dynamic</button></span></span>
        <span class="group"><span class="lbl">Rapid fire</span><span class="seg"><button data-act="rapid" data-arg="on" class="${s.rapid ? 'on' : ''}" title="Fire again before the last shot settles">On</button><button data-act="rapid" data-arg="off" class="${s.rapid ? '' : 'on'}" title="Each shot waits for the last to settle">Off</button></span></span>
        <span class="group"><span class="lbl">Sharpness</span><span class="seg"><button data-act="sharp" data-arg="2" class="${s.sharp === 2 ? 'on' : ''}">Full</button><button data-act="sharp" data-arg="1" class="${s.sharp === 1 ? 'on' : ''}">Fast</button></span></span>
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
  .kg-door .targets li.uncast { color: #8a93a6; }
  .kg-door .short { display: none; margin: 8px 0; font-size: 13px; color: #c7cdda; font-variant-numeric: tabular-nums; }
  .kg-door .short b { color: #7a8296; font-weight: 400; letter-spacing: -0.05em; }
  .kg-door .best { margin-top: auto; padding-top: 8px; border-top: 1px solid #2b3242; font-size: 12px; color: #a6aec0; font-variant-numeric: tabular-nums; }
  .kg-door .best .earned { color: #f7b955; font-size: 15px; letter-spacing: 0.04em; }
  .kg-door .best .unearned { color: #6b7385; font-size: 15px; letter-spacing: 0.04em; margin-right: 4px; }
  .kg-door .custom { margin-top: 4px; font-size: 11px; color: #f0806a; }
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
 * The pre-aimed opening shot for level def at index `index` of its series: the first shot of its best
 * recorded line (solutions.ace, else solutions.par), or null. Under auto only the series' first level has
 * one, and only until the player has a record for it: the first-minute promise is for a first visit, and
 * handing every level its best opener would give the stars away.
 */
export function openerFor(def: LevelDef, index: number, mode: PreaimMode, played: boolean): Shot | null {
  if (mode === '0' || (mode === 'auto' && (index !== 0 || played))) return null;
  return def.solutions?.ace?.[0] ?? def.solutions?.par?.[0] ?? null;
}
