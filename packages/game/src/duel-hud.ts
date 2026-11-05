// The Siege Table in the HUD and on the result card (docs/game/siege-table.md):
// whose turn it is and from which side, each side's keep or points and shots
// left in its owner ink, and the winner. Pure formatting, like hud.ts.
import { type Duel, DUEL_NAMES, type Refusal } from '@tb/keystone';
import { esc, pct } from './hud.ts';

const css = (rgb: readonly number[]) => `rgb(${rgb.map((x) => Math.round(255 * Math.min(1, Math.max(0, x)) ** (1 / 2.2))).join(',')})`;
/** Which half of the ring a side fires from, in a word, from its arc's middle azimuth. */
export function sideOf(arc: [number, number]): string {
  const mid = ((arc[0] + (arc[0] <= arc[1] ? arc[1] : arc[1] + 720)) / 2) % 720, deg = mid / 2;
  return deg > 45 && deg < 135 ? 'south' : deg >= 135 && deg <= 225 ? 'west' : deg > 225 && deg < 315 ? 'north' : 'east';
}

/** The HUD block that replaces the objective rows in a duel. `refusal`: why the shot aimed now would be refused. */
export function duelHudHtml(d: Duel, refusal: Refusal = null): string {
  const def = d.def, keeps = def.ruleset === 'keeps';
  const rows = def.sides.map((side, k) => {
    const st = d.sides[k]!, on = !d.result.over && d.turn === k;
    const measure = keeps
      ? `<span class="bar" title="${pct(st.share)} of the keep standing"><i style="width:${(100 * st.share).toFixed(1)}%;background:${css(side.ink)}"></i></span>${st.kingDown ? ' <span class="bad">king down</span>' : ''}`
      : `<b>${st.points}</b> pts`;
    return `<div class="row duel-side${on ? ' on' : ''}"><span><i class="ink" style="background:${css(side.ink)}"></i>${esc(side.name)}${on ? ' ◂' : ''}</span><span>${measure} · ${st.shotsLeft} left</span></div>`;
  }).join('');
  const turn = d.result.over ? '' : `<div class="row"><span class="small">${esc(def.sides[d.turn].name)} to fire, from the ${sideOf(def.sides[d.turn].arc)}</span></div>`;
  const why = refusal && refusal.why === 'arc' ? `<div class="bad small">${esc(refusal.message)}</div>` : '';
  return `<div class="row"><span class="small">${esc(DUEL_NAMES.mode)} · ${esc(DUEL_NAMES.rulesets[def.ruleset])} · two players</span></div>${rows}${turn}${why}`;
}

/** The duel's result card: the winner (or a draw) and why, each side's numbers, Rematch (the other side starts) and Again (the same start). */
export function duelResultHtml(d: Duel): string {
  const r = d.result, def = d.def;
  if (!r.over) return '';
  const head = r.winner === null ? 'A draw' : `${esc(def.sides[r.winner].name)} wins`;
  const ink = r.winner === null ? '#e8ebf2' : css(def.sides[r.winner].ink);
  const lines = def.sides.map((side, k) => {
    const st = d.sides[k]!;
    return `<div class="line" style="opacity:1;animation:none"><span><i class="ink" style="background:${css(side.ink)}"></i>${esc(side.name)}</span><span>${def.ruleset === 'keeps' ? `${pct(st.share)} standing${st.kingDown ? ', king down' : ''}` : `${st.points} pts`}</span></div>`;
  }).join('');
  return `
    <div class="name" style="color:${ink}">${head}</div>
    <div class="sub">${esc(DUEL_NAMES.rulesets[def.ruleset])} · ${esc(r.why)} · ${d.log.length} shot${d.log.length === 1 ? '' : 's'}</div>
    ${lines}
    <div class="actions"><button data-act="rematch" class="primary"><kbd>R</kbd> Rematch</button><button data-act="again">Same start</button></div>`;
}

export const DUEL_CSS = `
  .kg-hud .ink, .kg-result .ink { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  .kg-hud .duel-side { opacity: 0.7; }
  .kg-hud .duel-side .bar { display: inline-block; width: 80px; vertical-align: 0; }
  .kg-hud .duel-side.on { opacity: 1; font-weight: 650; }
`;
