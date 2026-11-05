// The Lot Sheet in the HUD and on the result card (docs/game/lot-sheets.md):
// a level's side goals with a tick each, provisional while the round runs
// ("so far": a goal like "one shot only" can still be lost) and final on the
// card, plus the grade the round reached on the level's cast cloud. Pure
// formatting, like hud.ts.
import type { Grade } from '@tb/keystone';
import { esc } from './hud.ts';

/** A goal as shown: its text, whether the round meets it now, and whether the player has met it on this level before. */
export interface GoalLine { id: string; text: string; met: boolean; before?: boolean }

/** ?keystone.goals: shown (proven goals, the default), all (unproven too) or off (no sheet). */
export type GoalsMode = 'shown' | 'all' | 'off';
export function goalsMode(q: URLSearchParams): GoalsMode {
  const v = q.get('keystone.goals') ?? 'shown';
  if (v !== 'shown' && v !== 'all' && v !== 'off') throw new Error(`keystone.goals must be shown, all or off: ${v}`);
  return v;
}

const tick = (g: GoalLine) => (g.met ? '☑' : g.before ? '☒' : '☐');

/** The HUD's sheet: one line per goal, ticked while the round meets it ("so far" until it ends). */
export function goalsHudHtml(goals: readonly GoalLine[]): string {
  if (!goals.length) return '';
  const met = goals.filter((g) => g.met).length;
  const lines = goals.map((g) => `<li class="${g.met ? 'met' : ''}${g.before ? ' before' : ''}" title="${g.before ? 'met on an earlier play' : ''}"><span class="tick">${tick(g)}</span>${esc(g.text)}</li>`).join('');
  return `<div class="goals"><div class="row"><span>Lot sheet</span><span class="small">${met}/${goals.length} so far</span></div><ul>${lines}</ul></div>`;
}

/** The result card's sheet: the goals this round met, the ones met for the first time marked new, and the grade. */
export function goalsResultHtml(goals: readonly GoalLine[], grade: Grade | null, graded: boolean): string {
  if (!goals.length && !graded) return '';
  const lines = goals.map((g) => `<li class="${g.met ? 'met' : ''}"><span class="tick">${g.met ? '✓' : '·'}</span>${esc(g.text)}${g.met && !g.before ? ' <b class="new">new</b>' : ''}</li>`).join('');
  const sheet = goals.length ? `<div class="line goals-head"><span>Lot sheet</span><span>${goals.filter((g) => g.met).length} / ${goals.length}</span></div><ul class="goals">${lines}</ul>` : '';
  const gradeLine = graded ? `<div class="line grade"><span>Grade</span><span class="g g-${grade ?? 'none'}" title="against the competent plays the level was cast from: E beats 1 in 10, A beats 9 in 10">${grade ?? '–'}</span></div>` : '';
  return `<div class="lot">${sheet}${gradeLine}</div>`;
}

export const LOT_CSS = `
  .kg-hud .goals { margin-top: 8px; border-top: 1px solid #3a4459; padding-top: 6px; }
  .kg-hud .goals ul, .kg-result ul.goals { list-style: none; margin: 4px 0 0; padding: 0; font-size: 12.5px; }
  .kg-hud .goals li, .kg-result ul.goals li { display: flex; gap: 6px; color: #9aa3b8; }
  .kg-hud .goals li.met, .kg-result ul.goals li.met { color: #8fd3b6; }
  .kg-hud .goals li.before:not(.met) { color: #c2b48a; }
  .kg-hud .goals .tick, .kg-result .goals .tick { width: 1em; flex: none; }
  .kg-result .lot { margin-top: 8px; }
  .kg-result .new { font-size: 11px; padding: 0 5px; border-radius: 4px; background: #d8693f; color: #fff; }
  .kg-result .grade .g { font-weight: 900; font-size: 18px; color: #f7b955; }
`;
