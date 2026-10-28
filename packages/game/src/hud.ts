// HUD and result card. Formatting is pure and tested; the DOM side only
// writes strings into fixed elements. Level text is authored in this repo,
// but everything still goes through esc().
import { type AmmoKind, type LevelDef, type LevelScore, tier, TIER_NAMES } from '@tb/keystone';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const AMMO_LABEL: Record<AmmoKind, string> = { marble: 'Marble', cannonball: 'Cannonball', cue: 'Cue', drop: 'Anvil' };

export interface Chip { ammo: AmmoKind; key: string; left: number; total: number; selected: boolean }

/** The rack grouped by kind in first-seen order, keyed 1, 2, 3... */
export function rackChips(rack: readonly AmmoKind[], left: readonly AmmoKind[], selected: AmmoKind | null): Chip[] {
  const kinds = [...new Set(rack)];
  return kinds.map((ammo, i) => ({ ammo, key: String(i + 1), total: rack.filter((a) => a === ammo).length, left: left.filter((a) => a === ammo).length, selected: ammo === selected }));
}

/** The selection after a shot: keep it while any are left, else the first kind with ammo left. */
export function nextSelection(rack: readonly AmmoKind[], left: readonly AmmoKind[], current: AmmoKind | null): AmmoKind | null {
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
}

export function hudHtml(s: HudState): string {
  const d = s.level;
  const chips = s.chips.map((c) => `<span class="chip${c.selected ? ' on' : ''}${c.left ? '' : ' spent'}"><kbd>${c.key}</kbd> ${esc(AMMO_LABEL[c.ammo])} <b>${c.left}</b>/${c.total}</span>`).join('');
  const heritage = s.heritageTotal ? `<div class="row"><span>Heritage</span><span class="${s.heritageBroken ? 'bad' : 'ok'}">${s.heritageBroken ? `${s.heritageBroken} cracked` : 'intact'}</span></div>` : '';
  const power = s.chips.find((c) => c.selected)?.ammo === 'drop' ? '' : `<div class="row"><span>Power <kbd>Q</kbd><kbd>E</kbd></span><span class="bar"><i style="width:${s.power}%"></i></span></div>`;
  const reach = s.reachable === false ? '<div class="bad small">Out of reach at this power</div>' : '';
  return `
    <div class="title">W${d.world}-${esc(d.id.replace(/^L/, ''))} · ${esc(d.name)}</div>
    <div class="row"><span>Par ${d.par}</span><span>Stroke ${s.strokes}</span></div>
    <div class="row"><span>Crowns</span><span class="crowns">${s.crownsDown} / ${s.crownsTotal}</span></div>
    ${heritage}
    <div class="row"><span>Leverage</span><span>${fmtLeverage(s.liveLeverage)}</span></div>
    <div class="chips">${chips}</div>
    ${power}${reach}`;
}

/** Result card: score lines slam in one by one, then the stamp and stars. */
/**
 * The round-over card. With no score yet the round is known to be over (every
 * crown is down) and the rest of the settle is still running: the card shows
 * at once and tallies, and is drawn again with the score when it settles.
 */
export function resultHtml(level: LevelDef, score: LevelScore | null, strokes: number, hasNext: boolean): string {
  const actions = `<div class="actions"><button data-act="retry"><kbd>R</kbd> Retry</button>${hasNext ? '<button data-act="next" class="primary"><kbd>N</kbd> Next</button>' : ''}</div>`;
  if (!score) {
    return `
    <div class="name">${esc(level.name)}</div>
    <div class="sub">${strokes} stroke${strokes === 1 ? '' : 's'} · par ${level.par}</div>
    <div class="line tally"><span>All crowns down</span><span>tallying…</span></div>
    ${actions}`;
  }
  const lines = score.lines.map((l, i) => `<div class="line" style="animation-delay:${0.15 + 0.22 * i}s"><span>${esc(l.label)}</span><span class="${l.value < 0 ? 'bad' : ''}">${fmtPoints(l.value)}</span></div>`).join('');
  const after = 0.15 + 0.22 * score.lines.length;
  return `
    <div class="name">${esc(level.name)}</div>
    <div class="sub">${strokes} stroke${strokes === 1 ? '' : 's'} · par ${level.par} · leverage ${fmtLeverage(score.leverage)} (${tierName(tier(score.leverage))})</div>
    ${lines}
    <div class="line total" style="animation-delay:${after}s"><span>Total</span><span>${fmtPoints(score.total)}</span></div>
    <div class="stamp s-${score.stamp.replace(/[^A-Z]/g, '').toLowerCase()}" style="animation-delay:${after + 0.3}s">${esc(score.stamp)}</div>
    <div class="stars" style="animation-delay:${after + 0.55}s">${starsText(score.stars)}</div>
    ${actions}`;
}
