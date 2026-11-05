// HUD and result card. Formatting is pure and tested; the DOM side only
// writes strings into fixed elements. Level text is authored in this repo,
// but everything still goes through esc().
import { castStars, type CompiledLevel, itemRef, type LevelDef, type LevelScore, type Objective, type RackItem, scoringOf, tier, TIER_NAMES } from '@tb/keystone';
import { PROJECTILE_PRESETS } from '@tb/weapons';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const AMMO_LABEL: Record<'marble' | 'cannonball' | 'cue' | 'drop', string> = { marble: 'Marble', cannonball: 'Cannonball', cue: 'Cue', drop: 'Anvil' };

/** A rack item's name on its chip: Keystone's ammo as before, a preset's catalogue label, a weapon's key. */
export function itemLabel(item: RackItem): string {
  const r = itemRef(item);
  if (!r) return item;
  const label = r.kind === 'ammo' ? AMMO_LABEL[r.ammo] : r.kind === 'pull' ? 'Pull' : r.kind === 'preset' ? PROJECTILE_PRESETS[r.preset].label : r.key;
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
  liveLeverage: number;
  phase: string;
  reachable: boolean | null;
  /** The pull under the cursor is refused (a crown or heritage block): said instead of out of reach. */
  pullRefused?: boolean;
  /** Outcome levels: collapse fraction D now, the objective met at the last settle, and whether a bank is possible. */
  collapse?: number;
  /** Hold levels (Undercut's Hollow): the share of the structure's mass pulled, shown in place of D. */
  pulled?: number;
  met?: boolean;
  canBank?: boolean;
  /** The slow-motion tag while physics runs slower than real time ('×0.8'; pacing.ts slowTag), '' or absent at real time. */
  pace?: string;
  /** The level's pre-aimed opening shot can be fired now (the Fire button, key F). */
  opener?: boolean;
  /** A duel's block (duel-hud.ts duelHudHtml): it replaces the objective, crowns, heritage and leverage rows. */
  duel?: string;
  /** Outcome levels: the star thresholds on the Down (or Pulled) bar (meterTicks); no bar without any. */
  ticks?: readonly MeterTick[];
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

/** Undo and Restart for a touch screen, which has no U or R key (kg-tch: shown only there), after the first shot. */
export const TOUCH_ACTS = '<div class="row acts kg-tch"><button data-act="undo" class="kg-tch">Undo shot</button><button data-act="restart" class="kg-tch">Restart</button></div>';

/** The pre-aimed opener's button (key F), shown before the first shot of a level that has one. */
export const OPENER_BUTTON = '<button data-act="opener" class="opener"><kbd>F</kbd> Fire the first shot</button>';

/** Power changes by this (percent) per key press (Q, E) or tap of a power button. */
export const POWER_STEP = 10;
/** A power button (touch screens only: GAME_CSS shows .kg-tch under body.kg-touch). */
const POWER_STEP_BUTTON = (d: number) => `<button class="pw kg-tch" data-act="power" data-arg="${d}" aria-label="${d < 0 ? 'Less' : 'More'} power">${d < 0 ? '−' : '+'}</button>`;

export const pct = (x: number) => `${Math.floor(100 * x)}%`;

/** What the objective asks, in a few words. */
export function objectiveText(o: Objective): string {
  switch (o.kind) {
    case 'crowns': return 'fell every crown';
    case 'skyline': return `skyline under ${o.maxH} h`;
    case 'collapse': return `bring ${pct(o.min)} down`;
    case 'hold': return 'keep the crown up';
  }
}

/** Shown on a level made by overrides (LevelDef.custom). */
export const CUSTOM_NOTE = 'custom: stars not recorded';

/** Outcome levels: the Bank button (key B), shown while a bank is possible. */
export const BANK_BUTTON = '<button data-act="bank" class="bank"><kbd>B</kbd> Bank</button>';

export function hudHtml(s: HudState): string {
  const d = s.level;
  // Chips are buttons (a tap selects, as the key does); kbd hints hide on a touch screen (GAME_CSS, body.kg-touch).
  const chips = s.chips.map((c) => `<button class="chip${c.selected ? ' on' : ''}${c.left ? '' : ' spent'}" data-act="ammo" data-arg="${c.key}"><kbd>${c.key}</kbd> ${esc(itemLabel(c.ammo))} <b>${c.left}</b>/${c.total}</button>`).join('');
  const heritage = s.heritageTotal ? `<div class="row"><span>Heritage</span><span class="${s.heritageBroken ? 'bad' : 'ok'}">${s.heritageBroken ? `${s.heritageBroken} cracked` : 'intact'}</span></div>` : '';
  const sel = s.chips.find((c) => c.selected)?.ammo;
  // The power bar, with minus and plus buttons on a touch screen (keys Q and E).
  const power = sel === 'drop' || sel === 'pull' ? '' : `<div class="row"><span>Power <kbd>Q</kbd><kbd>E</kbd></span><span class="power">${POWER_STEP_BUTTON(-POWER_STEP)}<span class="bar"><i style="width:${s.power}%"></i></span>${POWER_STEP_BUTTON(POWER_STEP)}</span></div>`;
  const reach = s.pullRefused ? '<div class="bad small">Crowns and heritage stay: pull a plain block</div>' : s.reachable === false ? '<div class="bad small">Out of reach at this power</div>' : '';
  const outcome = scoringOf(d) === 'outcome';
  const head = outcome
    ? `<div class="row"><span>Shot ${s.strokes}</span>${d.objective.kind === 'hold' ? `<span>Pulled <b class="down${(s.pulled ?? 0) > 0 ? '' : ' none'}">${pct(s.pulled ?? 0)}</b></span>` : `<span>Down <b class="down${(s.collapse ?? 0) > 0 ? '' : ' none'}">${pct(s.collapse ?? 0)}</b></span>`}</div>
    ${s.ticks?.length ? meterHtml(d.objective.kind === 'hold' ? s.pulled ?? 0 : s.collapse ?? 0, s.ticks, d.objective.kind === 'hold' ? 'pulled' : 'down') : ''}
    <div class="row"><span>Objective</span><span class="${s.met ? 'ok' : ''}">${esc(objectiveText(d.objective))}${s.met ? ' ✓' : ''}</span></div>`
    : `<div class="row"><span>Par ${d.par}</span><span>Stroke ${s.strokes}</span></div>`;
  const fz = s.freezes;
  const freezes = fz
    ? `<div class="row"><span>Freezes</span><span class="${fz.left ? '' : 'spent'}">${fz.left} / ${fz.total}</span></div>${fz.frozen || fz.can ? `<div class="row">${freezeButton(fz.frozen)}<span class="small">${fz.frozen ? 'aim and fire, or resume free' : 'stop the world to aim'}</span></div>` : ''}`
    : '';
  const crowns = !outcome || s.crownsTotal ? `<div class="row"><span>Crowns</span><span class="crowns">${s.crownsDown} / ${s.crownsTotal}</span></div>` : '';
  if (s.duel !== undefined) {
    return `
    <div class="title">${esc(d.name)}${s.pace ? ` <span class="pace" title="physics is running slower than real time">${esc(s.pace)}</span>` : ''}</div>
    ${s.duel}
    <div class="chips">${chips}</div>
    ${power}${reach}`;
  }
  return `
    <div class="title">W${d.world}-${esc(d.id.replace(/^L/, ''))} · ${esc(d.name)}${fz?.frozen ? ' <span class="pace frozen" title="physics is frozen: a shot fired now spends a freeze">FROZEN</span>' : s.pace ? ` <span class="pace" title="physics is running slower than real time">${esc(s.pace)}</span>` : ''}</div>
    ${d.custom ? `<div class="small custom">${CUSTOM_NOTE}</div>` : ''}
    ${head}
    ${crowns}
    ${heritage}
    <div class="chips">${chips}</div>
    ${freezes}
    ${s.opener ? `<div class="row">${OPENER_BUTTON}<span class="small"><span class="kg-desk">or aim and click</span><span class="kg-tch">or drag and lift</span></span></div>` : ''}
    ${power}${reach}${outcome && s.canBank ? `<div class="row">${BANK_BUTTON}<span class="small">end here, keep the rack</span></div>` : ''}
    ${s.strokes > 0 ? `<div class="row lev"><span>Leverage</span><span>${fmtLeverage(s.liveLeverage)}</span></div>` : ''}
    ${s.strokes > 0 ? TOUCH_ACTS : ''}`;
}

/** Result card: score lines slam in one by one, then the stamp and stars. */
/**
 * The round-over card. With no score yet the round is known to be over (every
 * crown is down) and the rest of the settle is still running: the card shows
 * at once and tallies, and is drawn again with the score when it settles.
 */
export function resultHtml(level: LevelDef, score: LevelScore | null, strokes: number, hasNext: boolean, canSave = false, extra = '', canUndo = false): string {
  const outcome = scoringOf(level) === 'outcome';
  const shotsText = `${strokes} ${outcome ? 'shot' : 'stroke'}${strokes === 1 ? '' : 's'}${outcome ? '' : ` · par ${level.par}`}`;
  const save = canSave && score ? '<button data-act="save" title="Download this round as a file to send back">Save session</button>' : '';
  const undo = canUndo && strokes > 0 ? '<button data-act="undo" title="Take the last shot back and play on from the shot before"><kbd>U</kbd> Undo shot</button>' : '';
  const actions = `<div class="actions">${undo}<button data-act="retry"><kbd>R</kbd> Retry</button>${save}${hasNext ? '<button data-act="next" class="primary"><kbd>N</kbd> Next</button>' : ''}</div>`;
  if (!score) {
    return `
    <div class="name">${esc(level.name)}</div>
    <div class="sub">${shotsText}</div>
    <div class="line tally"><span>All crowns down</span><span>tallying…</span></div>
    ${actions}`;
  }
  const lines = score.lines.map((l, i) => `<div class="line" style="animation-delay:${0.15 + 0.22 * i}s"><span>${esc(l.label)}</span><span class="${l.value < 0 ? 'bad' : ''}">${fmtPoints(l.value)}</span></div>`).join('');
  const after = 0.15 + 0.22 * score.lines.length;
  return `
    <div class="name">${esc(level.name)}</div>
    ${level.custom ? `<div class="sub custom">${CUSTOM_NOTE}</div>` : ''}
    <div class="sub">${shotsText}${'outcome' in score ? ` · ${pct((score as { outcome: { collapse: number } }).outcome.collapse)} down` : ''} · leverage ${fmtLeverage(score.leverage)} (${tierName(tier(score.leverage))})</div>
    ${lines}
    <div class="line total" style="animation-delay:${after}s"><span>Total</span><span>${fmtPoints(score.total)}</span></div>
    <div class="stamp s-${score.stamp.replace(/[^A-Z]/g, '').toLowerCase()}" style="animation-delay:${after + 0.3}s">${esc(score.stamp)}</div>
    <div class="stars" style="animation-delay:${after + 0.55}s">${starsText(score.stars)}</div>
    ${extra}
    ${actions}`;
}
