// HUD and result card. Formatting is pure and tested; the DOM side only
// writes strings into fixed elements. Level text is authored in this repo,
// but everything still goes through esc().
import { castStars, type CompiledLevel, DEFAULT_GOLD, isTrial, itemRef, type LevelDef, type LevelScore, levelTier, type Objective, type RackItem, scoringOf, TIER_NAMES, TRIAL_LEVELS } from '@tb/keystone';
import { PROJECTILE_PRESETS } from '@tb/weapons';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A level's short tag as the player sees it: the series code (B1, L2, U1), or for a trial its number in the trials'
 * door order, "Trial 7" (PT18: trial ids such as T-S14T are internal; they stay in the URL, ?level=T-S14T). A trial
 * the list does not hold (a level file's own T- id) shows "Trial".
 */
export function levelTag(d: Pick<LevelDef, 'id'>): string {
  if (!isTrial(d.id)) return d.id;
  const n = TRIAL_LEVELS.findIndex((t) => t.id.toUpperCase() === d.id.toUpperCase());
  return n < 0 ? 'Trial' : `Trial ${n + 1}`;
}

/**
 * A level's name as the player sees it: its name, less a trial's draft code (trial-levels.ts names the drafts it
 * keeps "Long Wall (B1b)"; the code is ours, PT18). Display only: the name joins the level's hash, so the
 * definition keeps it.
 */
export function playerName(d: Pick<LevelDef, 'id' | 'name'>): string {
  return isTrial(d.id) ? d.name.replace(/\s*\([A-Z]\d+[a-z]?\)$/, '') : d.name;
}

/**
 * The HUD's title: the level's tag as its door card shows it, then its name: "L2 · Lintel", "B1 · Long Wall",
 * "Trial 7 · Town" (PT18: the HUD said "W1-2" and "W5-T-S14T" where the door said L2 and the trial).
 */
export function hudTitle(d: Pick<LevelDef, 'id' | 'name'>): string {
  return `${levelTag(d)} · ${playerName(d)}`;
}

export const AMMO_LABEL: Record<'marble' | 'cannonball' | 'cue' | 'drop', string> = { marble: 'Marble', cannonball: 'Cannonball', cue: 'Cue', drop: 'Anvil' };

/**
 * Player names for weapon keys whose key is not a word a player would use (PT18: the sized grenades' keys read
 * as typos, "Grenade" and "Grenadel" side by side in one rack). Only the name on screen: the rack item (w-grenadel)
 * and so every level's hash stay as they are. Keys not listed show as themselves ("Bomb", "Ram").
 */
export const WEAPON_LABEL: Readonly<Record<string, string>> = { grenades: 'Small grenade', grenadem: 'Grenade', grenadel: 'Big grenade', grenadexl: 'Huge grenade' };

/** A rack item's name on its chip: Keystone's ammo as before, a preset's catalogue label, a weapon's player name or key. */
export function itemLabel(item: RackItem): string {
  const r = itemRef(item);
  if (!r) return item;
  const label = r.kind === 'ammo' ? AMMO_LABEL[r.ammo] : r.kind === 'pull' ? 'Pull' : r.kind === 'plunger' ? 'Plunger' : r.kind === 'quake' ? 'Quake' : r.kind === 'preset' ? PROJECTILE_PRESETS[r.preset].label : WEAPON_LABEL[r.key] ?? r.key;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface Chip { ammo: RackItem; key: string; left: number; total: number; selected: boolean }

/** The rack grouped by kind in first-seen order, keyed 1, 2, 3... */
export function rackChips(rack: readonly RackItem[], left: readonly RackItem[], selected: RackItem | null): Chip[] {
  const kinds = [...new Set(rack)];
  return kinds.map((ammo, i) => ({ ammo, key: String(i + 1), total: rack.filter((a) => a === ammo).length, left: left.filter((a) => a === ammo).length, selected: ammo === selected }));
}

/** The selection after a shot: keep it while any are left, else the first kind with ammo left. */
export function nextSelection(rack: readonly RackItem[], left: readonly RackItem[], current: RackItem | null): RackItem | null {
  if (current && left.includes(current)) return current;
  return [...new Set(rack)].find((a) => left.includes(a)) ?? null;
}

export const fmtLeverage = (L: number) => `×${L >= 100 ? L.toFixed(0) : L >= 10 ? L.toFixed(1) : L.toFixed(2)}`;
export const tierName = (t: number) => TIER_NAMES[Math.max(0, Math.min(3, t))]!;
export const starsText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
export const fmtPoints = (v: number) => (v < 0 ? `−${Math.abs(v).toLocaleString('en-US')}` : v.toLocaleString('en-US'));

export interface HudState {
  level: LevelDef;
  strokes: number;
  crownsDown: number;
  crownsTotal: number;
  heritageBroken: number;
  heritageTotal: number;
  chips: Chip[];
  power: number;
  /** The launcher's height over the ground, m (keys W and S; aim.ts launchHeight); absent: no Height row. */
  launch?: number;
  /**
   * Leverage (keystone rules.ts, one definition): the round's so far (Session.roundLeverageNow, which
   * ends equal to the card's LevelScore.leverage) and this shot's (Session.liveLeverage).
   */
  leverage: { round: number; shot: number };
  phase: string;
  reachable: boolean | null;
  /**
   * The pull under the cursor is refused (a crown or heritage block): said instead of out of reach, as a
   * neutral hint while it is only hovered, and in red once a click or tap on it was refused ('tapped';
   * playtest PT17: a red error before any input read as a mistake the player had not made).
   */
  pullRefused?: boolean | 'tapped';
  /** Outcome levels: collapse fraction D now, the objective met at the last settle, and whether a bank is possible. */
  collapse?: number;
  /** Hold levels (Undercut's Hollow): the share of the structure's mass pulled, shown in place of D. */
  pulled?: number;
  met?: boolean;
  canBank?: boolean;
  /** A shot is running and can be skipped to its settle (the Skip button, key K; agent playtest PT6), and whether it is skipping now. */
  canSkip?: boolean;
  skipping?: boolean;
  /** The slow-motion tag while physics runs slower than real time ('80% speed'; pacing.ts slowTag), '' or absent at real time. */
  pace?: string;
  /** The level's pre-aimed opening shot can be fired now (the Fire button, key F). */
  opener?: boolean;
  /** A duel's block (duel-hud.ts duelHudHtml): it replaces the objective, crowns, heritage and leverage rows. */
  duel?: string;
  /** Outcome levels: the star thresholds on the Down (or Pulled) bar (meterTicks); no bar without any. */
  ticks?: readonly MeterTick[];
  /** Aftershock: the quake designer's block (quake-panel.ts quakePanelHtml) while the Quake chip is selected, in place of power and height. */
  quake?: string;
  /** Bullet Time levels (LevelDef.freeze): freezes left of the level's, whether the shot is frozen now, and whether it can be. */
  freezes?: { left: number; total: number; frozen: boolean; can: boolean };
}

/** Bullet Time: the Freeze button (key T), shown while a running shot can be frozen, and Resume while it is. */
export const freezeButton = (frozen: boolean) => `<button data-act="freeze" class="freeze"><kbd>T</kbd> ${frozen ? 'Resume' : 'Freeze'}</button>`;

/** A star threshold on the HUD's Down bar: the share (0..1) at which `stars` stars are in reach. */
export interface MeterTick { at: number; stars: 1 | 2 | 3 }

/**
 * The star thresholds an outcome level's HUD bar can show, in the bar's own measure: collapse D, or for a
 * hold level the share pulled. One star where the objective is a collapse share; two and three where the
 * level's cast stars (castStars: none on a custom run) are in that measure. A star by points, crowns or
 * skyline has no place on the bar (B2's stars are points: no bar there). Sorted by share.
 */
export function meterTicks(c: CompiledLevel): MeterTick[] {
  const d = c.def;
  if (scoringOf(d) !== 'outcome') return [];
  const measure = d.objective.kind === 'hold' ? 'pulled' : 'collapse';
  const out: MeterTick[] = [];
  if (d.objective.kind === 'collapse') out.push({ at: d.objective.min, stars: 1 });
  const s = castStars(c);
  if (s && s.metric === measure) out.push({ at: s.t2, stars: 2 }, { at: s.t3, stars: 3 });
  return out.filter((t) => t.at > 0 && t.at <= 1).sort((a, b) => a.at - b.at);
}

/** The Down bar: filled to `value` (0..1), a tick per star threshold, lit once the value has reached it. */
export function meterHtml(value: number, ticks: readonly MeterTick[], label: string): string {
  const v = Math.max(0, Math.min(1, value));
  const marks = ticks.map((t) => `<span class="tick${t.stars === 1 ? ' obj' : ''}${v >= t.at ? ' got' : ''}" style="left:${(100 * t.at).toFixed(1)}%" title="${'★'.repeat(t.stars)} at ${pct(t.at)} ${label}"><b>${'★'.repeat(t.stars)}</b></span>`).join('');
  return `<div class="meter" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(100 * v)}"><i style="width:${(100 * v).toFixed(1)}%"></i>${marks}</div>`;
}

/** The help line on a touch screen (body.kg-touch): the gestures of touch.ts; the HUD's Undo and Restart buttons do what U and R do. */
export const TOUCH_HELP = 'drag: aim · lift: fire · two fingers: turn · pinch: zoom · add a finger mid-aim: cancel';

/**
 * Undo and Restart as icons for a touch screen, which has no U or R key (kg-tch: shown only there). Always in
 * the HUD so it never changes size (docs/game/phone-hud.md); disabled until the first shot is in.
 */
export const touchActs = (strokes: number) => {
  const off = strokes > 0 ? '' : ' disabled';
  return `<span class="acts kg-tch"><button data-act="undo" class="ico kg-tch" title="Undo shot" aria-label="Undo shot"${off}>↶</button><button data-act="restart" class="ico kg-tch" title="Restart" aria-label="Restart"${off}>↻</button></span>`;
};

/** The pre-aimed opener's button (key F), shown before the first shot of a level that has one. */
export const OPENER_BUTTON = '<button data-act="opener" class="opener"><kbd>F</kbd> Fire the first shot</button>';
/** Rube Lab's opener (docs/game/rube-lab.md): the plunger that opens the trapdoor, the only shot such a level has. */
export const GO_BUTTON = '<button data-act="opener" class="opener go"><kbd>F</kbd> Go: release the ball</button>';

/** Power changes by this (percent) per key press (Q, E) or tap of a power button. */
export const POWER_STEP = 10;
/** A power button (touch screens only: GAME_CSS shows .kg-tch under body.kg-touch). */
const POWER_STEP_BUTTON = (d: number) => `<button class="pw kg-tch" data-act="power" data-arg="${d}" aria-label="${d < 0 ? 'Less' : 'More'} power">${d < 0 ? '−' : '+'}</button>`;

/** A launcher height button (touch screens only, as the power buttons): one h down (-1) or up (1), keys S and W. */
const LAUNCH_STEP_BUTTON = (d: number) => `<button class="pw kg-tch" data-act="launch" data-arg="${d}" aria-label="${d < 0 ? 'Lower' : 'Raise'} the launcher">${d < 0 ? '−' : '+'}</button>`;

/** The Height row: the launcher's height in metres, with lower and raise buttons on a touch screen (keys S and W). */
export const launchRow = (m: number) => `<div class="row"><span>Height <kbd>W</kbd><kbd>S</kbd></span><span class="power">${LAUNCH_STEP_BUTTON(-1)}<b class="launch">${m.toFixed(1)} m</b>${LAUNCH_STEP_BUTTON(1)}</span></div>`;

export const pct = (x: number) => `${Math.floor(100 * x)}%`;

/** What the objective asks, in a few words. */
export function objectiveText(o: Objective): string {
  switch (o.kind) {
    case 'crowns': return 'fell every crown';
    case 'skyline': return `skyline under ${o.maxH} h`;
    case 'collapse': return `bring ${pct(o.min)} down`;
    case 'hold': return 'keep the crown up';
    case 'quake': return 'fell the condemned, spare the heritage';
    case 'fold': return `fold ${pct(o.min)} into its lot, neighbours untouched`;
    case 'bell': return 'ring the bell';
    case 'trial': return 'build it to pass the test';
  }
}

/** Why a pull is refused (Session.pullRefusal: crowns and heritage are the objective's). */
export const PULL_HINT = 'Crowns, heritage and fixed beams stay: pull a plain block';

/**
 * A hold level's crown row (Undercut's Hollow): its crowns are to be kept up, so the row says whether they
 * stand, in the objective's green, instead of a crown counter (0 / 1 in the crown colour read as a target to
 * topple; playtest PT17). Nothing on a level without crowns.
 */
export function keepRow(down: number, total: number): string {
  if (!total) return '';
  const label = total === 1 ? 'Crown' : 'Crowns';
  const state = down === 0 ? (total === 1 ? 'standing ✓' : 'all standing ✓') : total === 1 ? 'fallen' : `${down} of ${total} fallen`;
  return `<div class="row"><span>${label}</span><span class="keep ${down ? 'bad' : 'ok'}">${state}</span></div>`;
}

/** Shown on a level made by overrides (LevelDef.custom): the link's settings, or an engine its stars were not cast on. */
export const CUSTOM_NOTE = 'Custom settings, so no stars are recorded';

/** Outcome levels: the Bank button (key B), shown while a bank is possible. */
export const BANK_BUTTON = '<button data-act="bank" class="bank"><kbd>B</kbd> Bank</button>';
/**
 * Bank before the objective is met (PT18): an outline, not the primary orange, since banking then ends the level
 * with no star (the playtest's novice was invited to bank at 17% of B1's 40%). It turns solid once the objective is met.
 */
export const BANK_QUIET = '<button data-act="bank" class="bank quiet" title="Ends the level now: the objective is not met yet, so no star"><kbd>B</kbd> Bank</button>';

/** What the HUD's action slot offers now: one button, always in the same place (docs/game/phone-hud.md). */
export type SlotAction = 'freeze' | 'resume' | 'skip' | 'skipping' | 'opener' | 'go' | 'bank' | null;

/**
 * The action slot's button, by priority: Resume while frozen, Freeze while a running shot can be, Skip
 * while a running shot can be skipped to its settle (PT6; then a note while it skips), the pre-aimed opener
 * before the first shot, Bank while an outcome round can bank. They are offered at different moments (a
 * shot running, before the first, between shots), apart from Freeze and Skip, which a running shot on a
 * Bullet Time level offers together: the slot then holds both (`slotHtml`), Freeze first.
 */
export function slotAction(s: Pick<HudState, 'level' | 'opener' | 'canBank' | 'freezes' | 'duel' | 'canSkip' | 'skipping'>): SlotAction {
  if (s.duel !== undefined) return null;
  if (s.freezes?.frozen) return 'resume';
  if (s.freezes?.can) return 'freeze';
  if (s.canSkip) return 'skip';
  if (s.skipping) return 'skipping';
  if (s.opener) return s.level.rube ? 'go' : 'opener';
  if (s.canBank && scoringOf(s.level) === 'outcome') return 'bank';
  return null;
}

/** The slot's note beside its button (the panel HUD shows it; the docked phone HUD has no room and hides it). */
const SLOT_NOTE: Record<Exclude<SlotAction, null>, string> = {
  resume: 'aim and fire, or Resume: the freeze is kept',
  freeze: 'stop the world to aim',
  skip: 'to the settle',
  skipping: '',
  opener: '<span class="kg-desk">or aim and click</span><span class="kg-tch">or drag and lift</span>',
  go: 'the contraption runs from here',
  bank: 'end here, keep the rack',
};

/**
 * The HUD in two groups (docs/game/phone-hud.md): `.st`, the status (title, how the round stands, leverage,
 * the lot sheet), and `.tray`, the aim tray (rack, power, height, the action slot, Undo and Restart). The game
 * page's panel stacks them as one; a phone docks the status as a strip at the top and the tray at the bottom
 * (upright) or both down a side rail (sideways). Every row a round can show is in the markup from its first
 * frame, hidden where it does not apply yet, so the docked HUD keeps one size through the round.
 * `sheet` is the lot sheet's HUD block (lot-hud.ts goalsHudHtml), in the status group.
 */
/** The Skip button (key K), shown while a running shot can be skipped to its settle. */
export const SKIP_BUTTON = '<button data-act="skip" class="skip" title="Run the rest of this shot fast, to where it settles: the outcome is the same"><kbd>K</kbd> Skip</button>';
/** What the slot says while a shot skips (in the slot itself, so the docked HUD, which hides the notes, shows it). */
const SKIPPING = '<span class="small skipping">skipping to the settle…</span>';

/** The action slot's contents for `act`: its button, Freeze with Skip beside it when both apply, or the skipping note. */
export function slotHtml(act: SlotAction, s: Pick<HudState, 'canSkip' | 'met'>): string {
  switch (act) {
    case 'resume': return freezeButton(true);
    case 'freeze': return freezeButton(false) + (s.canSkip ? SKIP_BUTTON : '');
    case 'skip': return SKIP_BUTTON;
    case 'skipping': return SKIPPING;
    case 'opener': return OPENER_BUTTON;
    case 'go': return GO_BUTTON;
    case 'bank': return s.met ? BANK_BUTTON : BANK_QUIET;
    default: return '';
  }
}

export function hudHtml(s: HudState, sheet = ''): string {
  const d = s.level;
  // Chips are buttons (a tap selects, as the key does); kbd hints hide on a touch screen (GAME_CSS, body.kg-touch).
  const chips = s.chips.map((c) => `<button class="chip${c.selected ? ' on' : ''}${c.left ? '' : ' spent'}" data-act="ammo" data-arg="${c.key}"><kbd>${c.key}</kbd> ${esc(itemLabel(c.ammo))} <b>${c.left}</b>/${c.total}</button>`).join('');
  const heritage = s.heritageTotal ? `<div class="row"><span>Heritage</span><span class="${s.heritageBroken ? 'bad' : 'ok'}">${s.heritageBroken ? `${s.heritageBroken} cracked` : 'intact'}</span></div>` : '';
  const sel = s.chips.find((c) => c.selected)?.ammo;
  // A rack of one quake: the docked phone HUD drops its chip while the quake panel stands for it (ui.ts).
  const onlyQuake = s.chips.length === 1 && sel === 'quake' && s.quake ? ' only-quake' : '';
  // The power bar, with minus and plus buttons on a touch screen (keys Q and E).
  // A plunger aims at nothing (the timeline sets it): no power, no launcher height. A quake has its own designer instead.
  const power = sel === 'drop' || sel === 'pull' || sel === 'plunger' || sel === 'quake' ? (sel === 'quake' ? s.quake ?? '' : '') : `<div class="row"><span>Power <kbd>Q</kbd><kbd>E</kbd></span><span class="power">${POWER_STEP_BUTTON(-POWER_STEP)}<span class="bar"><i style="width:${s.power}%"></i></span>${POWER_STEP_BUTTON(POWER_STEP)}</span></div>`;
  const height = sel === 'drop' || sel === 'pull' || sel === 'plunger' || sel === 'quake' || s.launch === undefined ? '' : launchRow(s.launch);
  const reach = s.pullRefused ? `<div class="${s.pullRefused === 'tapped' ? 'bad' : 'hint'} small pull-hint">${PULL_HINT}</div>` : s.reachable === false ? '<div class="bad small reach">Out of reach at this power</div>' : '';
  const ctl = `<div class="ctl">${power}${height}</div>`;
  const pace = s.pace ? ` <span class="pace" title="physics is running slower than real time">${esc(s.pace)}</span>` : '';
  if (s.duel !== undefined) {
    return `<div class="st">
    <div class="title">${esc(d.name)}${pace}</div>
    ${s.duel}
    </div><div class="tray">
    <div class="chips${onlyQuake}">${chips}</div>
    ${ctl}<div class="above">${reach}</div>
    </div>`;
  }
  const outcome = scoringOf(d) === 'outcome';
  const head = outcome
    ? `<div class="row"><span>Shot ${s.strokes}</span>${d.objective.kind === 'hold' ? `<span>Pulled <b class="down${(s.pulled ?? 0) > 0 ? '' : ' none'}">${pct(s.pulled ?? 0)}</b></span>` : `<span>Down <b class="down${(s.collapse ?? 0) > 0 ? '' : ' none'}">${pct(s.collapse ?? 0)}</b></span>`}</div>
    ${s.ticks?.length ? meterHtml(d.objective.kind === 'hold' ? s.pulled ?? 0 : s.collapse ?? 0, s.ticks, d.objective.kind === 'hold' ? 'pulled' : 'down') : ''}
    <div class="row obj"><span>Objective</span><span class="${s.met ? 'ok' : ''}">${esc(objectiveText(d.objective))}${s.met ? ' ✓' : ''}</span></div>`
    : `<div class="row"><span>Par ${d.par}</span><span>Stroke ${s.strokes}</span></div>`;
  const fz = s.freezes;
  const freezes = fz ? `<div class="row"><span>Freezes</span><span class="${fz.left ? '' : 'spent'}">${fz.left} / ${fz.total}</span></div>` : '';
  const crowns = d.objective.kind === 'hold' ? keepRow(s.crownsDown, s.crownsTotal)
    : !outcome || s.crownsTotal ? `<div class="row"><span>${d.objective.kind === 'quake' ? 'Condemned down' : 'Crowns'}</span><span class="crowns">${s.crownsDown} / ${s.crownsTotal}</span></div>` : '';
  const act = slotAction(s);
  const button = slotHtml(act, s);
  const slot = `<div class="row slot-row${act ? '' : ' idle'}"><span class="slot${act ? '' : ' empty'}">${button}</span><span class="small note">${act ? SLOT_NOTE[act] : ''}</span>${touchActs(s.strokes)}</div>`;
  return `<div class="st">
    <div class="title">${esc(hudTitle(d))}${fz?.frozen ? ' <span class="pace frozen" title="physics is frozen: a shot fired now spends a freeze">FROZEN</span>' : pace}</div>
    ${d.custom ? `<div class="small custom">${CUSTOM_NOTE}</div>` : ''}
    ${head}
    ${crowns}
    ${heritage}
    ${freezes}
    ${leverageRow(s.strokes, s.leverage)}
    ${sheet}
    </div><div class="tray">
    <div class="chips${onlyQuake}">${chips}</div>
    ${ctl}<div class="above">${reach}${s.strokes > 0 ? '' : `<div class="tch-hint">${TOUCH_HELP}</div>`}</div>
    ${slot}
    </div>`;
}

/** What leverage means, in one line: the HUD row's tooltip and How to play's line. */
export const LEVERAGE_MEANS = 'Leverage is the energy of what you bring down for each unit of energy you fire.';

/**
 * The HUD's Leverage row: the round's, the figure the result card will show, and from the second shot
 * on this shot's beside it, so the two can never be read as one number that disagrees with itself.
 * The row and the shot's figure are in the markup from the first frame, held (hidden, holding their place,
 * drawn as ×0.00) until they apply, so the docked HUD keeps one size through the round (docs/game/phone-hud.md).
 */
export function leverageRow(strokes: number, L: { round: number; shot: number }): string {
  const shot = ` <span class="small shot${strokes > 1 ? '' : ' held'}">this shot ${fmtLeverage(strokes > 1 ? L.shot : 0)}</span>`;
  return `<div class="row lev${strokes > 0 ? '' : ' pre'}" title="${esc(LEVERAGE_MEANS)} This round's so far${strokes > 1 ? ', then the last shot\'s' : ''}."><span>Leverage</span><span>${fmtLeverage(strokes > 0 ? L.round : 0)}${shot}</span></div>`;
}

/** The leverage tier's name for a round on `level` (levelTier: against its gold line), or '' where it has none. */
export function tierLabel(L: number, level: LevelDef): string {
  const t = levelTier(L, level);
  return t === null ? '' : tierName(t);
}

/**
 * A par level's gold-leverage badge under the stars (keystone LevelScore.gold): earned, or once cleared the line
 * still to reach. Leverage gates no star; this is what it earns. Nothing on outcome levels or before a clear.
 */
export function goldHtml(level: LevelDef, score: LevelScore, delay = 0): string {
  if (scoringOf(level) !== 'par' || score.stars === 0) return '';
  const line = fmtLeverage(level.lGold ?? DEFAULT_GOLD);
  return score.gold
    ? `<div class="gold got" style="animation-delay:${delay}s">◆ Gold leverage (${line} or more)</div>`
    : `<div class="gold" style="animation-delay:${delay}s">◇ Gold leverage at ${line}, in par, heritage intact</div>`;
}

/**
 * The result card's forward button: Next (key N) inside a series; at a series' end the next series' first
 * level, labelled (series), or the page's level list (levels); null for none.
 */
export type CardForward = { act: 'next' } | { act: 'series'; label: string } | { act: 'levels' } | null;

/** A round that failed (no star: the objective unmet, or not cleared): its card puts Retry first, not the way forward. */
export const failedRound = (score: LevelScore | null) => score !== null && score.stars === 0;

/**
 * The result card's buttons. The primary (orange) one is the way forward, except after a failed round, where
 * it is Retry (PT4). `forward` true is Next (the viewer's and older callers' boolean), false none.
 */
export function cardActions(score: LevelScore | null, strokes: number, forward: boolean | CardForward, canSave: boolean, canUndo: boolean): string {
  const fw: CardForward = forward === true ? { act: 'next' } : forward === false ? null : forward;
  const failed = failedRound(score);
  const save = canSave && score ? '<button data-act="save" title="Download this round as a file to send back">Save session</button>' : '';
  const undo = canUndo && strokes > 0 ? '<button data-act="undo" title="Take the last shot back and play on from the shot before"><kbd>U</kbd> Undo shot</button>' : '';
  const retry = `<button data-act="retry"${failed ? ' class="primary"' : ''}><kbd>R</kbd> Retry</button>`;
  const cls = failed ? '' : ' class="primary"';
  const go = !fw ? ''
    : fw.act === 'next' ? `<button data-act="next"${cls}><kbd>N</kbd> Next</button>`
      : fw.act === 'series' ? `<button data-act="series"${cls}>${esc(fw.label)} →</button>`
        : `<button data-act="levels"${cls}>Levels</button>`;
  return `<div class="actions">${undo}${retry}${save}${go}</div>`;
}

/**
 * The docked layout's tallying banner (layout.ts, PT4), shown from the round's end until the card: the level
 * and, once the settle has scored it, its stamp and stars, a preview of the card about to come. `over`
 * replaces the text (a duel's round).
 */
export function tallyHtml(level: LevelDef, score: LevelScore | null, over: string | null = null): string {
  if (over) return `<b>${esc(over)}</b> <span class="small">tallying…</span>`;
  const what = score ? `<b>${esc(score.stamp)}</b> <span class="stars">${starsText(score.stars)}</span>` : `<b>${scoringOf(level) === 'outcome' ? 'Round over' : 'All crowns down'}</b>`;
  return `<span class="name">${esc(playerName(level))}</span> ${what} <span class="small">tallying…</span>`;
}

/**
 * The round-over card. With no score yet the round is known to be over (every
 * crown is down) and the rest of the settle is still running: the card shows
 * at once and tallies, and is drawn again with the score when it settles.
 * Two groups, `.c1` (name, the score lines and the total) and `.c2` (stamp, stars, badge, lot sheet and
 * the buttons): one column as before, two side by side on a phone held sideways (GAME_CSS, docked).
 * Score lines slam in one by one, then the stamp and stars. An outcome level's sub line gives its share down,
 * except on a hold level (U3), whose metric is the share pulled: the stamp and the Pulled line carry it, and a
 * "% down" beside them was a second metric (PT35).
 */
export function resultHtml(level: LevelDef, score: LevelScore | null, strokes: number, forward: boolean | CardForward, canSave = false, extra = '', canUndo = false): string {
  const outcome = scoringOf(level) === 'outcome';
  // A Rube Lab level's one plunger is no stroke to count: its line is the parts used against the parts par.
  const shotsText = score?.parts ? `parts ${score.parts.used} / par ${score.parts.par}` : `${strokes} ${outcome ? 'shot' : 'stroke'}${strokes === 1 ? '' : 's'}${outcome ? '' : ` · par ${level.par}`}`;
  const actions = cardActions(score, strokes, forward, canSave, canUndo);
  if (!score) {
    return `<div class="c1">
    <div class="name">${esc(playerName(level))}</div>
    <div class="sub">${shotsText}</div>
    <div class="line tally"><span>All crowns down</span><span>tallying…</span></div>
    </div><div class="c2">${actions}</div>`;
  }
  // A line that costs points (heritage, footprint) is red end to end: its own red line, never netted into another.
  const lines = score.lines.map((l, i) => `<div class="line${l.value < 0 ? ' bad' : ''}" style="animation-delay:${0.15 + 0.22 * i}s"><span>${esc(l.label)}</span><span class="${l.value < 0 ? 'bad' : ''}">${fmtPoints(l.value)}</span></div>`).join('');
  const after = 0.15 + 0.22 * score.lines.length;
  const tierText = tierLabel(score.leverage, level);
  const fz = score.freezes ? ` · freezes used ${score.freezes.used}/${score.freezes.total}` : '';
  const lost = score.heritageStarsLost ? `<div class="lost bad" style="animation-delay:${after + 0.7}s">Heritage cracked: ${score.heritageStarsLost} star${score.heritageStarsLost === 1 ? '' : 's'} lost</div>` : '';
  return `<div class="c1">
    <div class="name">${esc(playerName(level))}</div>
    ${level.custom ? `<div class="sub custom">${CUSTOM_NOTE}</div>` : ''}
    <div class="sub">${shotsText}${'outcome' in score && level.objective.kind !== 'hold' ? ` · ${pct((score as { outcome: { collapse: number } }).outcome.collapse)} down` : ''} · leverage ${fmtLeverage(score.leverage)}${tierText ? ` (${tierText})` : ''}${fz}</div>
    ${lines}
    <div class="line total" style="animation-delay:${after}s" title="The lines' sum, never below 0"><span>Total</span><span>${fmtPoints(score.total)}</span></div>
    </div><div class="c2">
    <div class="stamp s-${score.stamp.replace(/[^A-Z]/g, '').toLowerCase()}" style="animation-delay:${after + 0.3}s">${esc(score.stamp)}</div>
    <div class="stars" style="animation-delay:${after + 0.55}s">${starsText(score.stars)}</div>
    ${lost}
    ${goldHtml(level, score, after + 0.8)}
    ${extra}
    ${actions}
    </div>`;
}
