// Edit mode's panel (C9, docs/game/placement.md): enter and leave edit mode,
// Play, the tools (place, domino brush, erase), what to place, turn, tip, slide, undo,
// clear and snap, and one status line. Rendering is a pure function of the
// controller's state (editHtml); the page owns the actions.
import type { EditController, EditTool } from './edit.ts';

export type EditAction =
  | { a: 'enter' } | { a: 'play' } | { a: 'cancel' } | { a: 'undo' } | { a: 'clear' } | { a: 'turn'; deg: number } | { a: 'tip' } | { a: 'slide'; d: -1 | 1 }
  | { a: 'tool'; tool: EditTool } | { a: 'item'; item: string } | { a: 'snap'; on: boolean };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The panel's body for a controller (null: not editing). `keys` adds the keyboard hints (not on touch). `run`: Play
 * is Run, which also releases the ball (Rube Lab under its mode's HUD, mode-ui.ts: one start verb, PT23).
 */
export function editHtml(e: EditController | null, keys = true, run = false): string {
  const k = (s: string) => (keys ? ` <span class="key">${s}</span>` : '');
  if (!e) return `<div class="buttons"><button type="button" data-a="enter" title="Stop time and place pieces, lay dominoes, then Play">Build${k('B')}</button></div>`;
  const on = (b: boolean) => (b ? ' class="on"' : '');
  const tools = (['place', 'brush', 'erase'] as const).map((t) => {
    const off = t === 'brush' && !e.session.brush;
    const label = t === 'place' ? 'Place' : t === 'brush' ? `Domino brush${k('B')}` : `Erase${k('X')}`;
    return `<button type="button" data-a="tool" data-tool="${t}"${on(e.tool === t)}${off ? ' disabled' : ''}>${label}</button>`;
  }).join('');
  const items = e.session.items.map((it, i) => `<button type="button" data-a="item" data-item="${it.name}"${on(e.tool === 'place' && e.hold.item === it.name)} title="costs ${it.cost}">${esc(it.label)}${k(String(i + 1))}</button>`).join('');
  const play = run ? `<button type="button" data-a="play" class="go" title="Play the build and release the ball">Run${k('Enter')}</button>`
    : `<button type="button" data-a="play" class="go" title="Compile the level as built and run it">Play${k('Enter')}</button>`;
  return `<div class="buttons">${play}<button type="button" data-a="cancel" title="Leave edit mode without the edits">Cancel${k('Esc')}</button></div>`
    + `<div class="buttons">${tools}</div>`
    + `<div class="buttons items">${items}</div>`
    + `<div class="buttons"><button type="button" data-a="turn" data-deg="-90">Turn left${k('Q')}</button><button type="button" data-a="turn" data-deg="90">Turn right${k('E')}</button><button type="button" data-a="tip">Tip${k('T')}</button>`
    + (e.tool === 'place' && e.session.slideMax(e.hold) > 0 ? `<button type="button" data-a="slide" data-d="-1" title="Move the piece back along its length, off the point">Slide back${k('[')}</button><button type="button" data-a="slide" data-d="1" title="Move the piece out along its length, so it can reach past an edge">Slide out${k(']')}</button>` : '')
    + `<button type="button" data-a="undo"${e.session.canUndo ? '' : ' disabled'}>Undo${k('Z')}</button><button type="button" data-a="clear">Clear</button></div>`
    + `<label class="snap"><input type="checkbox" name="snap"${e.snap ? ' checked' : ''}> snap to faces and the grid${keys ? '<span class="kg-desk"> (Alt: off while held)</span>' : ''}</label>`
    + `<div class="out${e.ghost && !e.ghost.ok ? ' warn' : ''}">${esc(e.status())}</div>`;
}

/** Fills el (a details panel) and calls act for its controls; show redraws it. */
export function mountEditPanel(el: HTMLDetailsElement, act: (a: EditAction) => void, keys = true): { show(e: EditController | null, run?: boolean): void } {
  el.innerHTML = '<summary>Build</summary><div class="edit"></div>';
  const body = el.querySelector<HTMLElement>('.edit')!;
  body.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'tool') act({ a, tool: b.dataset.tool as EditTool });
    else if (a === 'item') act({ a, item: b.dataset.item! });
    else if (a === 'turn') act({ a, deg: Number(b.dataset.deg) });
    else if (a === 'slide') act({ a, d: Number(b.dataset.d) < 0 ? -1 : 1 });
    else if (a === 'enter' || a === 'play' || a === 'cancel' || a === 'undo' || a === 'clear' || a === 'tip') act({ a });
  });
  body.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.name === 'snap') act({ a: 'snap', on: t.checked });
  });
  let last = '';
  return {
    show(e, run = false) {
      const html = editHtml(e, keys, run);
      if (html !== last) { body.innerHTML = html; last = html; }
    },
  };
}

/** Applies a panel action other than enter, play and cancel (the page's) to the controller; returns whether it did anything. */
export function applyEditAction(e: EditController, x: EditAction): boolean {
  switch (x.a) {
    case 'undo': return e.undo();
    case 'clear': return e.clear();
    case 'turn': return e.key(x.deg < 0 ? 'q' : 'e');
    case 'tip': return e.key('t');
    case 'slide': return e.slide(x.d);
    case 'tool': e.setTool(x.tool); return true;
    case 'item': e.select(x.item as Parameters<EditController['select']>[0]); return true;
    case 'snap': e.snap = x.on; return true;
    default: return false;
  }
}
