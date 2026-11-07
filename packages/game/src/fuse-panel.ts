// Fuse & Fold's timeline panel (M5, docs/game/fuse-and-fold.md): one row per charge with its delay on a
// 0 to 2 s track (click or drag the track, or step it with - and +), a Sweep tool (a direction and the spacing
// between rows), and the Plunger button (key Enter), which fires every charge at its delay. Shown on levels
// whose rack holds a plunger and whose charges it arms. It never moves the camera (Will's camera rule).
import type { CompiledLevel, PlungerShot } from '@tb/keystone';
import { compassArrow, delayCss, MAX_SNAPS, northOnScreen, panelTimeline, RELAY_CSS, SWEEP_DIRS, type Timeline, timelineOverlay, yardArrow } from './fuse-timeline.ts';
import { FUSE_PANEL_SHARE } from './view.ts';

export const FUSE_CSS = `
  .kg-fuse { right: 12px; bottom: 12px; width: 300px; max-height: calc(100vh - 140px); box-sizing: border-box; overflow: hidden; font: 13px/1.35 system-ui, sans-serif; display: none; }
  /* A column whose rows alone scroll (PT21): the head, the Sweep and the Plunger stay in sight whatever the panel's height. */
  .kg-fuse.show { display: flex; flex-direction: column; }
  .kg-fuse > * { flex: none; }
  .kg-fuse > .rows { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
  .kg-fuse.off .rows, .kg-fuse.off .sweep { opacity: 0.4; pointer-events: none; }
  .kg-fuse .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .kg-fuse .head b { font-size: 15px; }
  .kg-fuse .head span { color: #9aa3b8; font-size: 12px; }
  .kg-fuse .sweep { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 6px; }
  .kg-fuse .sweep button, .kg-fuse .sp button, .kg-fuse .r button { font: inherit; border: 0; border-radius: 5px; background: #2b3242; color: #e8ebf2; cursor: pointer; padding: 3px 0; }
  .kg-fuse .sweep button.on { background: #d8693f; }
  .kg-fuse .sp { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 8px; color: #9aa3b8; }
  .kg-fuse .sp button { width: 28px; }
  .kg-fuse .rows { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .kg-fuse .r { display: grid; grid-template-columns: 44px 22px 1fr 22px 34px; align-items: center; gap: 4px; }
  .kg-fuse .r.sel .lab { color: #f7b955; font-weight: 700; }
  .kg-fuse .track { position: relative; height: 14px; border-radius: 7px; background: #2b3242; cursor: pointer; touch-action: none; }
  .kg-fuse .track i { position: absolute; top: 2px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; box-shadow: 0 0 0 1px #1a1f2a; }
  .kg-fuse .t { text-align: right; color: #c8cfdc; }
  .kg-fuse .head .compass { display: inline-flex; align-items: center; gap: 8px; }
  .kg-fuse .head .compass small { font: 700 10px/1 system-ui, sans-serif; color: #f08a5d; margin-right: -5px; }
  .kg-fuse .needle { display: inline-block; width: 22px; height: 22px; border-radius: 50%; background: #2b3242; box-shadow: inset 0 0 0 1px #3b4458; position: relative; }
  .kg-fuse .needle::before { content: ''; position: absolute; left: 6px; top: 2px; border: 5px solid transparent; border-bottom: 9px solid #f08a5d; border-top: 0; }
  .kg-fuse .needle::after { content: ''; position: absolute; left: 10px; top: 11px; width: 2px; height: 8px; background: #6b7488; }
  .kg-fuse button.plunger kbd { font: 600 11px/1 system-ui, sans-serif; padding: 2px 5px; margin-right: 6px; border-radius: 4px; background: rgba(0, 0, 0, 0.25); vertical-align: 1px; }
  .kg-fuse .relays { margin: 0 0 8px; color: #9aa3b8; font-size: 12px; }
  .kg-fuse .relays i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; vertical-align: -1px; }
  .kg-fuse button.plunger { width: 100%; font: 700 15px/1 system-ui, sans-serif; padding: 9px 0; border: 0; border-radius: 7px; background: #c8402e; color: #fff; cursor: pointer; }
  .kg-fuse button.plunger:disabled { background: #4a3a3a; color: #9aa3b8; cursor: default; }
  .kg-fuse .hint { margin: -2px 0 6px; color: #9aa3b8; font-size: 12px; }
  /* The plan's tags in the scene (PT24): each charge's grid label and delay, N at the ground compass's tip, Yard at the yard arrow's. */
  .kg-fuse-tags { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  .kg-fuse-tags.hide, body.ended .kg-fuse-tags { display: none; }
  .kg-fuse-tags span { position: absolute; left: 0; top: 0; padding: 1px 5px; border-radius: 4px; background: rgba(17, 20, 28, 0.72); color: #e8ebf2; font: 600 11px/1.3 system-ui, sans-serif; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .kg-fuse-tags span i { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; vertical-align: 0; }
  .kg-fuse-tags span.n { background: #f08a5d; color: #1a1f2a; font-weight: 800; }
  .kg-fuse-tags span.yard { background: rgba(143, 211, 182, 0.9); color: #1a1f2a; }
  .kg-fuse .fold { display: none; width: 100%; margin-bottom: 6px; font: inherit; border: 0; border-radius: 5px; background: #2b3242; color: #e8ebf2; cursor: pointer; padding: 3px 8px; text-align: left; }
  /* The round is over: the card is the screen's (PT21); Undo or Retry takes the card away and brings the panel back. */
  body.ended .kg-fuse.show { display: none; }
  /* A phone (or a short window): the per-charge rows fold behind Delays (the Sweep sets them all), one row of directions. */
  @media (max-width: 640px), (max-height: 500px) {
    .kg-fuse .fold { display: block; }
    .kg-fuse:not(.open) .rows { display: none; }
    .kg-fuse .sweep { grid-template-columns: repeat(8, 1fr); }
    body.kg-touch .kg-fuse .sweep button, body.kg-touch .kg-fuse .sp button, body.kg-touch .kg-fuse .fold { min-height: 30px; }
  }
  /* Upright, a band at the bottom (on the docked HUD's tray: FusePanel.dock); its height is view.ts FUSE_PANEL_SHARE's. */
  @media (max-width: 640px) { .kg-fuse { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: ${FUSE_PANEL_SHARE * 100}vh; } }
  /* Sideways, down the right side under the Menu button (the docked HUD's rail is on the left). */
  @media (orientation: landscape) and (max-height: 500px) { .kg-fuse { right: 8px; bottom: 8px; width: 300px; max-height: calc(100vh - 72px); } }
`;

export interface FusePanelHooks {
  /** Fire the plunger shot (GameHandle.fire); false when the game refused it. */
  fire(shot: PlungerShot): boolean;
}

/** A tag in the scene: a world point (m), the screen point it was last put at (px, NaN when hidden), and its size (px, measured once a render). */
interface WorldTag { at: readonly [number, number, number]; x: number; y: number; w: number; h: number }

/**
 * Which tags show (PT24: F4's twelve tags piled up on a phone): in `order`, each tag whose box (centred over its point,
 * above it, `pad` px apart) misses every box already shown; a tag with no point (off screen) is hidden.
 */
export function placeTags(points: readonly ([number, number] | null)[], sizes: readonly { w: number; h: number }[], order: readonly number[], pad = 2): boolean[] {
  const shown = points.map(() => false), boxes: [number, number, number, number][] = [];
  for (const k of order) {
    const p = points[k], sz = sizes[k];
    if (!p || !sz) continue;
    const b: [number, number, number, number] = [p[0] - sz.w / 2 - pad, p[1] - sz.h - pad, p[0] + sz.w / 2 + pad, p[1] + pad];
    if (boxes.some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3])) continue;
    boxes.push(b);
    shown[k] = true;
  }
  return shown;
}

/**
 * The order tags claim their place: N and Yard first (the plan's anchors), then the selected charge, then one charge
 * of each delay (the earliest first, so every row of a sweep is named), then the rest in charge order.
 */
export function tagOrder(snaps: readonly number[], selected: number, anchors: number): number[] {
  const n = snaps.length, order: number[] = [];
  for (let a = 0; a < anchors; a++) order.push(n + a);
  if (selected >= 0 && selected < n) order.push(selected);
  const firsts = new Map<number, number>();
  snaps.forEach((s, k) => { if (!firsts.has(s)) firsts.set(s, k); });
  for (const s of [...firsts.keys()].sort((a, b) => a - b)) order.push(firsts.get(s)!);
  for (let k = 0; k < n; k++) order.push(k);
  return [...new Set(order)];
}

/**
 * Where a world point shows on a screen box, px, under a view-projection matrix (column-major, as viewProj makes it),
 * or null when it is behind the eye or off the box.
 */
export function screenPoint(m: ArrayLike<number>, at: readonly [number, number, number], box: { left: number; top: number; width: number; height: number }): [number, number] | null {
  const [x, y, z] = at, w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(w > 0)) return null;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w, ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return null;
  return [box.left + ((nx + 1) / 2) * box.width, box.top + ((1 - ny) / 2) * box.height];
}

/** The panel's hint under its head (PT24): what the Sweep's directions are for, and the step after. */
export const FUSE_HINT = 'Sweep toward the yard, then Plunger';

/** The panel for one page; `level` switches it to a level's timeline (or hides it when the level has none). */
export class FusePanel {
  readonly el: HTMLElement;
  /** The plan's tags in the scene (PT24), behind every panel. */
  readonly tagsEl: HTMLElement;
  timeline: Timeline | null = null;
  /** The last Sweep's direction (lit in the panel), or null: none at load (PT24: W was lit while every delay was 0) and after All at 0. */
  dir: string | null = null;
  private tags: WorldTag[] = [];
  private spacing = 6;
  private enabled = false;
  /** Whether the per-charge rows are unfolded where they fold (a phone: the Delays button, PT21). */
  private rowsOpen = false;
  /** The panel's bottom edge set by dock, px from the screen's bottom (null: the stylesheet's). */
  private docked: number | null = null;
  private drag: { k: number; track: HTMLElement } | null = null;
  /** The compass needle's last angle (radians clockwise from screen-up), so a still camera writes no style. */
  private north = NaN;

  constructor(parent: HTMLElement, private readonly hooks: FusePanelHooks) {
    this.el = document.createElement('div');
    this.el.className = 'kg-panel kg-fuse';
    parent.appendChild(this.el);
    this.tagsEl = document.createElement('div');
    this.tagsEl.className = 'kg-fuse-tags hide';
    // Over the scene's canvas, under every panel: right after the canvas (the page's first child), else first.
    const canvas = parent.querySelector(':scope > canvas');
    if (canvas) canvas.after(this.tagsEl);
    else parent.prepend(this.tagsEl);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', () => { this.drag = null; });
  }

  /** Shows the timeline of `c` (all delays at 0), or hides the panel when it has none (panelTimeline). */
  level(c: CompiledLevel): void {
    this.timeline = panelTimeline(c);
    this.dir = null;
    this.el.classList.toggle('show', this.timeline !== null);
    // The tags' world points: each charge's marker (timelineOverlay), then the compass's tip and the yard arrow's on a fold level.
    const t = this.timeline, tags: WorldTag[] = [];
    if (t) {
      const o = timelineOverlay(t);
      t.charges.forEach((_, k) => tags.push({ at: [o.xyzr[4 * k]!, o.xyzr[4 * k + 1]! + 2 * o.xyzr[4 * k + 3]!, o.xyzr[4 * k + 2]!], x: NaN, y: NaN, w: 0, h: 0 }));
      if (c.def.objective.kind === 'fold') {
        const n = compassArrow(c), y = yardArrow(c);
        tags.push({ at: [n.tip[0], 0, n.tip[1]], x: NaN, y: NaN, w: 0, h: 0 });
        if (y) tags.push({ at: [y.tip[0], 0, y.tip[1]], x: NaN, y: NaN, w: 0, h: 0 });
      }
    }
    this.tags = tags;
    this.render();
  }

  /**
   * Put the plan's tags where their points show under the view-projection `m` on the canvas box `box`, or hide them
   * (m null: no plunger to set, or no timeline). Every frame; a tag's style is written only when it moves a pixel.
   */
  world(m: ArrayLike<number> | null, box: { left: number; top: number; width: number; height: number }): void {
    this.tagsEl.classList.toggle('hide', m === null || !this.timeline);
    const t = this.timeline;
    if (m === null || !t) return;
    const spans = this.tagsEl.children as HTMLCollectionOf<HTMLElement>;
    if (spans.length !== this.tags.length) return;
    // Sizes once a render (the spans' text changes only then): the first frame after it measures.
    if (this.tags.some((g) => g.w === 0)) this.tags.forEach((g, k) => { g.w = spans[k]!.offsetWidth; g.h = spans[k]!.offsetHeight; });
    const points = this.tags.map((g) => screenPoint(m, g.at, box));
    const shown = placeTags(points, this.tags, tagOrder(t.snaps, t.selected, this.tags.length - t.charges.length));
    this.tags.forEach((g, k) => {
      const el = spans[k]!, p = shown[k] ? points[k]! : null;
      if (!p) { if (!Number.isNaN(g.x)) { g.x = g.y = NaN; el.style.visibility = 'hidden'; } return; }
      if (Math.abs(p[0] - g.x) < 0.5 && Math.abs(p[1] - g.y) < 0.5) return;
      if (Number.isNaN(g.x)) el.style.visibility = '';
      [g.x, g.y] = p;
      el.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px) translate(-50%, -100%)`;
    });
  }

  /** Whether the plunger can go now (aiming with a plunger left); called every frame, re-renders on change only. */
  ready(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.el.classList.toggle('off', !on);
    const b = this.el.querySelector<HTMLButtonElement>('button.plunger');
    if (b) b.disabled = !on;
  }

  /** Turn the compass needle to where north is on screen for the camera (every frame; writes on change only). */
  heading(yaw: number, pitch: number): void {
    const a = northOnScreen(yaw, pitch), n = this.el.querySelector<HTMLElement>('.needle');
    if (!n || Math.abs(a - this.north) < 0.005) return;
    this.north = a;
    n.style.transform = `rotate(${a.toFixed(3)}rad)`;
  }

  /**
   * Stand the panel `bottom` px above the screen's bottom (upright on a phone: on the docked HUD's tray, PT21),
   * or back to the stylesheet's place (null). Called every frame on a level with a timeline; writes on change only.
   */
  dock(bottom: number | null): void {
    if (bottom !== null) bottom = Math.round(bottom);
    if (bottom === this.docked) return;
    this.docked = bottom;
    this.el.style.bottom = bottom === null ? '' : `${bottom}px`;
  }

  /** Press the plunger (key Enter, the button): false when there is no timeline or the game refused. */
  press(): boolean {
    if (!this.timeline || !this.enabled) return false;
    return this.hooks.fire(this.timeline.shot());
  }

  private render(): void {
    const t = this.timeline;
    if (!t) { this.el.innerHTML = ''; return; }
    const rows = t.charges.map((ch, k) => {
      const s = t.snaps[k]!;
      return `<div class="r${k === t.selected ? ' sel' : ''}" data-k="${k}"><span class="lab">${ch.label}</span><button data-act="dec" data-k="${k}">-</button>`
        + `<div class="track" data-k="${k}"><i style="left:${(100 * s) / MAX_SNAPS}%;background:${delayCss(s)}"></i></div>`
        + `<button data-act="inc" data-k="${k}">+</button><span class="t">${(s / 10).toFixed(1)} s</span></div>`;
    }).join('');
    this.el.innerHTML = `<div class="head"><b class="compass"><small>N</small><span class="needle" title="North, as the camera sees it" style="transform:rotate(${(Number.isFinite(this.north) ? this.north : 0).toFixed(3)}rad)"></span>Timeline</b><span>${t.charges.length} charges, last at ${t.span.toFixed(1)} s</span></div>`
      + `<p class="hint">${FUSE_HINT}</p>`
      + `<div class="sweep">${SWEEP_DIRS.map((d) => `<button data-act="sweep" data-dir="${d.name}" class="${d.name === this.dir ? 'on' : ''}" title="Fall ${d.name}: the ${d.name} row goes first">${d.name}</button>`).join('')}</div>`
      + `<div class="sp"><span>Sweep spacing</span><button data-act="sp-">-</button><b>${(this.spacing / 10).toFixed(1)} s</b><button data-act="sp+">+</button><button data-act="clear" style="width:auto;padding:3px 8px">All at 0</button></div>`
      + `<button class="fold" data-act="rows" aria-expanded="${this.rowsOpen}">${this.rowsOpen ? 'Delays ▾' : 'Delays ▸'} <span>${t.charges.length} charges</span></button>`
      + `<div class="rows">${rows}</div>`
      + (t.relays.length ? `<p class="relays"><i style="background:${RELAY_CSS}"></i>${t.relays.length} relay${t.relays.length > 1 ? 's' : ''} on storey ${[...new Set(t.relays.map((x) => x.storey))].join(', ')}: they go off when jolted</p>` : '')
      + `<button class="plunger" data-act="plunger"${this.enabled ? '' : ' disabled'}><kbd>Enter</kbd> Plunger</button>`;
    this.el.classList.toggle('open', this.rowsOpen);
    // The tags' text: each charge's label and delay in its delay's colour, then N and Yard (their points set by level).
    const fold = this.tags.length - t.charges.length;
    this.tagsEl.innerHTML = t.charges.map((ch, k) => `<span style="visibility:hidden"><i style="background:${delayCss(t.snaps[k]!)}"></i>${ch.label} ${(t.snaps[k]! / 10).toFixed(1)}</span>`).join('')
      + (fold >= 1 ? '<span class="n" style="visibility:hidden">N</span>' : '') + (fold >= 2 ? '<span class="yard" style="visibility:hidden">Yard</span>' : '');
    for (const g of this.tags) { g.x = g.y = NaN; g.w = g.h = 0; }
  }

  private onClick(e: MouseEvent): void {
    const t = this.timeline, b = (e.target as HTMLElement).closest('button');
    if (!t || !b) return;
    const act = b.dataset.act, k = Number(b.dataset.k);
    if (act === 'plunger') { this.press(); return; }
    if (act === 'rows') this.rowsOpen = !this.rowsOpen;
    if (act === 'inc' || act === 'dec') { t.set(k, t.snaps[k]! + (act === 'inc' ? 1 : -1)); t.selected = k; }
    if (act === 'sweep') { this.dir = b.dataset.dir!; t.sweep(this.dir, this.spacing); }
    // The spacing re-sweeps the last direction; before any Sweep it only sets the spacing the next one uses.
    if (act === 'sp+' || act === 'sp-') { this.spacing = Math.max(1, Math.min(10, this.spacing + (act === 'sp+' ? 1 : -1))); if (this.dir) t.sweep(this.dir, this.spacing); }
    if (act === 'clear') { t.clear(); this.dir = null; }
    this.render();
  }

  private setFromTrack(k: number, track: HTMLElement, clientX: number): void {
    const r = track.getBoundingClientRect(), t = this.timeline!;
    t.set(k, ((clientX - r.left) / Math.max(1, r.width)) * MAX_SNAPS);
    t.selected = k;
    this.render();
  }

  private onDown(e: PointerEvent): void {
    const track = (e.target as HTMLElement).closest<HTMLElement>('.track');
    if (!track || !this.timeline) return;
    const k = Number(track.dataset.k);
    this.drag = { k, track };
    this.setFromTrack(k, track, e.clientX);
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return;
    // The panel re-renders on every change: find the live track for the row being dragged.
    const track = this.el.querySelector<HTMLElement>(`.track[data-k="${this.drag.k}"]`) ?? this.drag.track;
    this.setFromTrack(this.drag.k, track, e.clientX);
  }
}
