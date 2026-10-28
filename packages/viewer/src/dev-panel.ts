// The par and dev panel under Keystone's rules (docs/design/viewer-superset.md,
// step D): the level's par and gold leverage, the attempt's score and each
// settled shot's outcome, and a line of shots to play (the link's, else the
// level's par line), with a replay check on a fresh engine and a button that
// puts the attempt in the link and the scene file. Rendering is a pure
// function of DevView; the page owns the actions.
import { DEFAULT_GOLD, type LevelDef, type LevelScore, type Shot, type ShotOutcome, writeShots } from '@tb/keystone';
import { fmtLeverage, fmtPoints, starsText } from '@tb/game';
import { escapeHtml } from './html.ts';

export interface DevView {
  level: LevelDef;
  /** The line Play plays: the link's (keystone.shots) or the level's par solution; null when it has neither. */
  line: { from: 'link' | 'par'; shots: readonly Shot[] } | null;
  /** This attempt's shots as fired, and the outcome of each that has settled. */
  attempt: readonly Shot[];
  outcomes: readonly ShotOutcome[];
  score: LevelScore | null;
  /** A shot is in flight (no replay check until it settles). */
  running: boolean;
  /** An action is under way (buttons off). */
  busy: boolean;
  /** What the last action did. */
  status: string;
  /** The status is a failure (a replay that differs, a line that could not be played). */
  warn: boolean;
}

export type DevAction = 'play' | 'check' | 'keep';

const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

export function devHtml(v: DevView): string {
  const d = v.level;
  const head = `<div class="f"><span>${escapeHtml(d.id)} · par ${d.par} · gold ${fmtLeverage(d.lGold ?? DEFAULT_GOLD)}</span>${v.score ? `<span class="score">${starsText(v.score.stars)} ${fmtPoints(v.score.total)}</span>` : ''}</div>`;
  const rows = v.attempt.map((s, i) => {
    const o = v.outcomes[i];
    const cells = o
      ? [fmtLeverage(o.leverage), (o.dPE_mJ / 1000).toFixed(1), `${o.crownsDown}/${o.crownsTotal}`, String(o.heritageNew), String(o.settleStep - o.spawnStep)]
      : ['…', '', '', '', ''];
    return `<tr><td>${i + 1}</td><td>${s.ammo}</td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  }).join('');
  const table = v.attempt.length
    ? `<table class="shots"><tr><th>#</th><th>ammo</th><th title="leverage">lev</th><th title="potential energy released since the level began, J">ΔPE J</th><th title="crowns down (shot/total)">crowns</th><th title="heritage blocks broken">her.</th><th title="steps to settle">steps</th></tr>${rows}</table>`
    : '<div class="muted">no shots fired yet</div>';
  const line = v.line
    ? `<div class="line">${v.line.from === 'par' ? 'par line' : 'line from the link'}, ${n(v.line.shots.length, 'shot')}: <code>${escapeHtml(writeShots(v.line.shots))}</code></div>`
    : '<div class="line muted">no line: this level has no par solution and the link none</div>';
  const off = (b: boolean) => (b ? ' disabled' : '');
  const buttons = `<div class="buttons">`
    + `<button type="button" name="play"${off(v.busy || !v.line)}>Play line</button>`
    + `<button type="button" name="check"${off(v.busy || v.running || !v.attempt.length)} title="the attempt's shots on a fresh engine: same steps, phase and hash?">Replay check</button>`
    + `<button type="button" name="keep"${off(v.busy || v.running || !v.attempt.length)} title="this attempt's shots into the link and the scene file">Keep as line</button>`
    + `</div>`;
  return `${head}${table}<div class="h">Line</div>${line}${buttons}<div class="out${v.warn ? ' warn' : ''}">${escapeHtml(v.status)}</div>`;
}

/** Fills el (a details panel) and calls act for its buttons; show redraws it. */
export function mountDev(el: HTMLDetailsElement, act: (a: DevAction) => void): { show(v: DevView): void } {
  el.innerHTML = '<summary>Par and dev</summary><div class="dev"></div>';
  const body = el.querySelector<HTMLElement>('.dev')!;
  body.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b && !b.disabled) act(b.name as DevAction);
  });
  return { show: (v) => { body.innerHTML = devHtml(v); } };
}
