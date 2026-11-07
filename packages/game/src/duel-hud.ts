// The Siege Table in the HUD and on the result card (docs/game/siege-table.md):
// whose turn it is and from which side, each side's keep or points and shots
// left in its owner ink, and the winner. Pure formatting, like hud.ts.
import { type Duel, DUEL_NAMES, type Refusal } from '@tb/keystone';
import { arcMiddle, turnCue } from './duel-view.ts';
import { esc, pct } from './hud.ts';

const css = (rgb: readonly number[]) => `rgb(${rgb.map((x) => Math.round(255 * Math.min(1, Math.max(0, x)) ** (1 / 2.2))).join(',')})`;
/** Which half of the ring a side fires from, in a word, from its arc's middle azimuth. */
export function sideOf(arc: [number, number]): string {
  const deg = arcMiddle(arc) / 2;
  return deg > 45 && deg < 135 ? 'south' : deg >= 135 && deg <= 225 ? 'west' : deg > 225 && deg < 315 ? 'north' : 'east';
}

/** n points, in words: "1 pt", "-4 pts". */
export const ptsText = (n: number): string => `${n} pt${Math.abs(n) === 1 ? '' : 's'}`;

/** The mode line: the mode, the ruleset when the table's own name is not already it (D1 is "Two Keeps", as its ruleset), two players. */
export function modeLine(d: Pick<Duel, 'def'>): string {
  const rules = DUEL_NAMES.rulesets[d.def.ruleset];
  return [DUEL_NAMES.mode, ...(rules === d.def.name ? [] : [rules]), 'two players'].map(esc).join(' · ');
}

/**
 * The duel's goal for the side to fire, in a line (PT34: the match never said it): in Two Keeps the rival's king to
 * topple and your own to protect, by the marks their stones carry (the crosshair ⌖ and the shield ⛨, duel-view.ts
 * duelMarks); in Heraldry what a block down scores, in the inks.
 */
export function goalHtml(d: Pick<Duel, 'def' | 'turn'>): string {
  const me = d.def.sides[d.turn], them = d.def.sides[1 - d.turn]!, ink = (side: typeof me, text: string) => `<b style="color:${css(side.ink)}">${esc(text)}</b>`;
  return d.def.ruleset === 'keeps'
    ? `Topple ${ink(them, `${them.name}'s ⌖ king`)} · protect your ${ink(me, '⛨ king')}`
    : `Knock down ${ink(them, them.name.toLowerCase())} +1 · your ${ink(me, me.name.toLowerCase())} −1`;
}

/** Where the side to fire fires from, in the table's own terms (PT34: west and east mean nothing on a plain field). */
export function fromWhere(d: Pick<Duel, 'def'>, k: 0 | 1): string {
  const me = d.def.sides[k], them = d.def.sides[1 - k]!;
  return d.def.ruleset === 'keeps' ? `from behind the ${me.name.toLowerCase()} keep` : `at the ${them.name.toLowerCase()} face`;
}

/**
 * The HUD block that replaces the objective rows in a duel. `refusal`: why the shot aimed now would be refused.
 * `az`: the launcher's azimuth at the view now (aim.ts azFromYaw); outside the player to fire's arc, the block says
 * which way to drag to reach it (duel-view.ts turnCue), on a mouse or two fingers on a touch screen (body.kg-touch).
 * `ownAim`: the point aimed at is on the player to fire's own blocks (keeps: a warning, PT5; the shot is still allowed).
 */
export function duelHudHtml(d: Duel, refusal: Refusal = null, az: number | null = null, ownAim = false): string {
  const def = d.def, keeps = def.ruleset === 'keeps';
  const rows = def.sides.map((side, k) => {
    const st = d.sides[k]!, on = !d.result.over && d.turn === k;
    const measure = keeps
      ? `<span class="bar" title="${pct(st.share)} of the keep standing"><i style="width:${(100 * st.share).toFixed(1)}%;background:${css(side.ink)}"></i></span>${st.kingDown ? ' <span class="bad">king down</span>' : ''}`
      : `<b>${st.points}</b> pt${Math.abs(st.points) === 1 ? '' : 's'}`;
    return `<div class="row duel-side${on ? ' on' : ''}"><span><i class="ink" style="background:${css(side.ink)}"></i>${esc(side.name)}${on ? ' ◂' : ''}</span><span>${measure} · ${st.shotsLeft} shot${st.shotsLeft === 1 ? '' : 's'} left</span></div>`;
  }).join('');
  const answer = !d.result.over && keeps && d.answering === d.turn && d.sides[1 - d.turn]!.fellOn === null && d.sides[d.turn]!.fellOn !== null;
  const turn = d.result.over ? '' : `<div class="row"><span class="small">${esc(def.sides[d.turn].name)} ${answer ? 'answers' : 'to fire'}, ${esc(fromWhere(d, d.turn))}</span></div>`;
  const goal = d.result.over ? '' : `<div class="row duel-goal"><span class="small">${goalHtml(d)}</span></div>`;
  const side = def.sides[d.turn], cue = az !== null && !d.result.over && d.shooter === null ? turnCue(side.arc, az) : null;
  const arrow = cue === 'right' ? '▸' : '◂';
  const why = cue
    ? `<div class="bad small turn-cue"><span class="kg-desk">Drag ${cue} ${arrow}</span><span class="kg-tch">Two fingers ${cue} ${arrow}</span> to turn to ${esc(side.name)}'s side</div>`
    : refusal && refusal.why === 'arc' ? `<div class="bad small">${esc(refusal.message)}</div>`
    : ownAim && keeps ? `<div class="bad small own-aim">That's ${esc(side.name)}'s own keep</div>` : '';
  return `<div class="row"><span class="small">${modeLine(d)}</span></div>${goal}${rows}${turn}${why}`;
}

/**
 * The hand-over card between turns (PT5: "pass the device"): whose turn, in their ink, and why when it is an answer.
 * Plain text in two lines, for the card's head and foot; tapping it lets the next player fire.
 */
export function handoffText(d: Duel, touch: boolean): { head: string; foot: string } {
  const side = d.def.sides[d.turn], other = d.def.sides[1 - d.turn]!;
  const answer = d.def.ruleset === 'keeps' && d.sides[d.turn]!.fellOn !== null && d.sides[1 - d.turn]!.fellOn === null && d.answering === d.turn;
  const head = answer ? `${side.name}'s answer` : `${side.name}'s turn`;
  const why = answer ? `${other.name} brought ${side.name}'s king down: bring ${other.name}'s down too for a draw. ` : '';
  return { head, foot: `${why}Pass the device to ${side.name} · ${touch ? 'tap' : 'click'} to start` };
}

/**
 * The hand-over card's markup (an element of class duel-handoff), in the side to fire's ink. In Heraldry it carries the
 * last shot's points too (scoreFloatHtml), since the card covers the middle of the screen where they would float.
 */
export function handoffHtml(d: Duel, touch: boolean): string {
  const { head, foot } = handoffText(d, touch), ink = css(d.def.sides[d.turn].ink), tally = shotSummaryHtml(d);
  const last = tally ? `<div class="tally">${esc(d.def.sides[d.lastShot!.player].name)}'s shot: ${tally}</div>` : '';
  return `<div class="band" style="border-color:${ink}">${last}<div class="head" style="color:${ink}">${esc(head)}</div><div class="foot">${esc(foot)}</div></div>`;
}

/** Two Keeps: what the last shot did, for the hand-over card ("4 blue blocks down · Blue's king stands"), in the inks; empty before one. */
export function keepTallyHtml(d: Duel): string {
  const t = d.lastShot;
  if (!t || d.def.ruleset !== 'keeps') return '';
  const me = d.def.sides[t.player], q = (1 - t.player) as 0 | 1, them = d.def.sides[q];
  const blocks = (n: number, side: typeof me) => `<span style="color:${css(side.ink)}">${n} ${esc(side.name.toLowerCase())} block${n === 1 ? '' : 's'} down</span>`;
  const parts = t.rival || !t.own ? [blocks(t.rival, them)] : [];
  if (t.own) parts.push(blocks(t.own, me));
  parts.push(d.sides[q].kingDown ? `<b>${esc(them.name)}'s king is down</b>` : `${esc(them.name)}'s king stands`);
  return parts.join(' · ');
}

/**
 * A Heraldry shot's points, to float where it landed (PT5: "Heraldry scores silently"): the rival's blocks it brought
 * down in their ink, the shooter's own in theirs, and the sum. Empty when the shot moved nothing.
 */
export function scoreFloatHtml(d: Duel): string {
  const t = d.lastShot;
  if (!t || d.def.ruleset !== 'heraldry' || (t.rival === 0 && t.own === 0)) return '';
  const me = d.def.sides[t.player], them = d.def.sides[1 - t.player]!;
  const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  const part = (n: number, side: typeof me, plus: boolean) => (n ? `<span style="color:${css(side.ink)}">${plus ? '+' : '−'}${n} ${esc(side.name.toLowerCase())}</span>` : '');
  const parts = [part(t.rival, them, true), part(t.own, me, false)].filter(Boolean).join(' ');
  return `${parts} <b>= ${sign(t.points)}</b>`;
}

/**
 * What the last settled shot did, for the hand-over card and the result card: every shot gets a line (PT34: a shot
 * that dropped nothing got none in Heraldry), in Two Keeps keepTallyHtml, in Heraldry its points or "nothing down".
 * Empty before the first shot settles.
 */
export function shotSummaryHtml(d: Duel): string {
  if (!d.lastShot) return '';
  if (d.def.ruleset === 'keeps') return keepTallyHtml(d);
  return scoreFloatHtml(d) || 'nothing down <b>= 0</b>';
}

/** The duel's result card: the winner (or a draw) and why, each side's numbers, Rematch (the other side starts) and Again (the same start). */
export function duelResultHtml(d: Duel): string {
  const r = d.result, def = d.def;
  if (!r.over) return '';
  const head = r.winner === null ? 'A draw' : `${esc(def.sides[r.winner].name)} wins`;
  const ink = r.winner === null ? '#e8ebf2' : css(def.sides[r.winner].ink);
  const lines = def.sides.map((side, k) => {
    const st = d.sides[k]!;
    return `<div class="line" style="opacity:1;animation:none"><span><i class="ink" style="background:${css(side.ink)}"></i>${esc(side.name)}</span><span>${def.ruleset === 'keeps' ? `${pct(st.share)} standing${st.kingDown ? ', king down' : ''}` : ptsText(st.points)}</span></div>`;
  }).join('');
  // The last shot is summarised here, as every other is on the hand-over card (PT34: it never was).
  const t = d.lastShot, summary = shotSummaryHtml(d);
  const last = t && summary ? `<div class="duel-last small">${esc(def.sides[t.player].name)}'s last shot: ${summary}</div>` : '';
  return `
    <div class="name" style="color:${ink}">${head}</div>
    <div class="sub">${esc(DUEL_NAMES.rulesets[def.ruleset])} · ${esc(r.why)} · ${d.log.length} shot${d.log.length === 1 ? '' : 's'}</div>
    ${last}
    ${lines}
    <div class="actions"><button data-act="rematch" class="primary"><kbd>R</kbd> Rematch</button><button data-act="again">Same start</button></div>`;
}

export const DUEL_CSS = `
  .kg-hud .ink, .kg-result .ink { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  .kg-hud .duel-side { opacity: 0.7; }
  .kg-hud .duel-side .bar { display: inline-block; width: 80px; vertical-align: 0; }
  .kg-hud .duel-side.on { opacity: 1; font-weight: 650; }
  /* Sideways on a phone the rail is narrow (220 px): a shorter bar, so a side's row stays one line (PT30's 844 x 390 capture). */
  @media (orientation: landscape) and (max-height: 500px) { body.kg-touch .kg-hud.kg-dock .duel-side { white-space: nowrap; } body.kg-touch .kg-hud.kg-dock .duel-side .bar { width: 36px; } }
  .duel-handoff { position: fixed; inset: 0; z-index: 30; display: none; align-items: flex-end; padding-bottom: 8vh; box-sizing: border-box; justify-content: center; cursor: pointer; background: rgba(12, 15, 22, 0.25); }
  .duel-handoff.show { display: flex; animation: duel-fade 0.25s ease-out; }
  @keyframes duel-fade { from { opacity: 0; } to { opacity: 1; } }
  .duel-handoff .band { width: 100%; padding: 18px 16px; box-sizing: border-box; text-align: center; background: rgba(20, 24, 33, 0.86); border-top: 3px solid; border-bottom: 3px solid; font: 14px/1.45 system-ui, sans-serif; color: #e8ebf2; }
  /* A phone's hand-over card is opaque (PT34: the rack showed through the band, which sits over the docked tray) and dims the table more. */
  body.kg-touch .duel-handoff { background: rgba(12, 15, 22, 0.72); }
  body.kg-touch .duel-handoff .band { background: rgb(20, 24, 33); }
  .kg-result .duel-last { margin: 4px 0 8px; color: #c9cfdb; }
  .kg-hud .duel-goal b { font-weight: 700; }
  .duel-handoff .head { font: 800 32px/1.2 system-ui, sans-serif; letter-spacing: 0.02em; }
  .duel-handoff .foot { margin-top: 6px; color: #c9cfdb; }
  .duel-handoff .tally { margin-bottom: 6px; font-weight: 700; font-size: 16px; }
  .duel-float { position: fixed; z-index: 35; pointer-events: none; transform: translate(-50%, -100%); padding: 4px 10px; border-radius: 6px; background: rgba(20, 24, 33, 0.82); font: 700 16px/1.3 system-ui, sans-serif; color: #e8ebf2; white-space: nowrap; opacity: 0; }
  .duel-float.show { animation: duel-float 1.8s ease-out; }
  @keyframes duel-float { 0% { opacity: 0; margin-top: 0; } 12% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; margin-top: -36px; } }
`;
