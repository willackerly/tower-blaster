// HUD and result card. Formatting is pure and tested; the DOM side only
// writes strings into fixed elements. Level text is authored in this repo,
// but everything still goes through esc().
import { itemRef, type LevelDef, type LevelScore, type Objective, type RackItem, scoringOf, tier, TIER_NAMES } from '@tb/keystone';
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
}

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
    ? `<div class="row"><span>Shot ${s.strokes}</span>${d.objective.kind === 'hold' ? `<span>Pulled <b class="down">${pct(s.pulled ?? 0)}</b></span>` : `<span>Down <b class="down">${pct(s.collapse ?? 0)}</b></span>`}</div>
    <div class="row"><span>Objective</span><span class="${s.met ? 'ok' : ''}">${esc(objectiveText(d.objective))}${s.met ? ' ✓' : ''}</span></div>`
    : `<div class="row"><span>Par ${d.par}</span><span>Stroke ${s.strokes}</span></div>`;
  const crowns = !outcome || s.crownsTotal ? `<div class="row"><span>Crowns</span><span class="crowns">${s.crownsDown} / ${s.crownsTotal}</span></div>` : '';
  if (s.duel !== undefined) {
    return `
    <div class="title">${esc(d.name)}${s.pace ? ` <span class="pace" title="physics is running slower than real time">${esc(s.pace)}</span>` : ''}</div>
    ${s.duel}
    <div class="chips">${chips}</div>
    ${power}${reach}`;
  }
  return `
    <div class="title">W${d.world}-${esc(d.id.replace(/^L/, ''))} · ${esc(d.name)}${s.pace ? ` <span class="pace" title="physics is running slower than real time">${esc(s.pace)}</span>` : ''}</div>
    ${d.custom ? `<div class="small custom">${CUSTOM_NOTE}</div>` : ''}
    ${head}
    ${crowns}
    ${heritage}
    <div class="row"><span>Leverage</span><span>${fmtLeverage(s.liveLeverage)}</span></div>
    <div class="chips">${chips}</div>
    ${s.opener ? `<div class="row">${OPENER_BUTTON}<span class="small"><span class="kg-desk">or aim and click</span><span class="kg-tch">or drag and lift</span></span></div>` : ''}
    ${power}${reach}${outcome && s.canBank ? `<div class="row">${BANK_BUTTON}<span class="small">end here, keep the rack</span></div>` : ''}`;
}

/** Result card: score lines slam in one by one, then the stamp and stars. */
/**
 * The round-over card. With no score yet the round is known to be over (every
 * crown is down) and the rest of the settle is still running: the card shows
 * at once and tallies, and is drawn again with the score when it settles.
 */
export function resultHtml(level: LevelDef, score: LevelScore | null, strokes: number, hasNext: boolean, canSave = false, extra = ''): string {
  const outcome = scoringOf(level) === 'outcome';
  const shotsText = `${strokes} ${outcome ? 'shot' : 'stroke'}${strokes === 1 ? '' : 's'}${outcome ? '' : ` · par ${level.par}`}`;
  const save = canSave && score ? '<button data-act="save" title="Download this round as a file to send back">Save session</button>' : '';
  const actions = `<div class="actions"><button data-act="retry"><kbd>R</kbd> Retry</button>${save}${hasNext ? '<button data-act="next" class="primary"><kbd>N</kbd> Next</button>' : ''}</div>`;
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
