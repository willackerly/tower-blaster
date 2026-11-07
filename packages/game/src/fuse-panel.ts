// Fuse & Fold's timeline panel (M5, docs/game/fuse-and-fold.md): one row per charge with its delay on a
// 0 to 2 s track (click or drag the track, or step it with - and +), a Sweep tool (a direction and the spacing
// between rows), and the Plunger button (key Enter), which fires every charge at its delay. Shown on levels
// whose rack holds a plunger and whose charges it arms. It never moves the camera (Will's camera rule).
import type { CompiledLevel, PlungerShot } from '@tb/keystone';
import { delayCss, MAX_SNAPS, northOnScreen, panelTimeline, RELAY_CSS, SWEEP_DIRS, type Timeline } from './fuse-timeline.ts';

export const FUSE_CSS = `
  .kg-fuse { right: 12px; bottom: 12px; width: 300px; max-height: calc(100vh - 140px); overflow-y: auto; font: 13px/1.35 system-ui, sans-serif; display: none; }
  .kg-fuse.show { display: block; }
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
  @media (max-width: 640px) { .kg-fuse { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: 45vh; } }
`;

export interface FusePanelHooks {
  /** Fire the plunger shot (GameHandle.fire); false when the game refused it. */
  fire(shot: PlungerShot): boolean;
}

/** The panel for one page; `level` switches it to a level's timeline (or hides it when the level has none). */
export class FusePanel {
  readonly el: HTMLElement;
  timeline: Timeline | null = null;
  private dir = 'W';
  private spacing = 6;
  private enabled = false;
  private drag: { k: number; track: HTMLElement } | null = null;
  /** The compass needle's last angle (radians clockwise from screen-up), so a still camera writes no style. */
  private north = NaN;

  constructor(parent: HTMLElement, private readonly hooks: FusePanelHooks) {
    this.el = document.createElement('div');
    this.el.className = 'kg-panel kg-fuse';
    parent.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', () => { this.drag = null; });
  }

  /** Shows the timeline of `c` (all delays at 0), or hides the panel when it has none (panelTimeline). */
  level(c: CompiledLevel): void {
    this.timeline = panelTimeline(c);
    this.el.classList.toggle('show', this.timeline !== null);
    this.render();
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
      + `<div class="sweep">${SWEEP_DIRS.map((d) => `<button data-act="sweep" data-dir="${d.name}" class="${d.name === this.dir ? 'on' : ''}" title="Fall ${d.name}: the ${d.name} row goes first">${d.name}</button>`).join('')}</div>`
      + `<div class="sp"><span>Sweep spacing</span><button data-act="sp-">-</button><b>${(this.spacing / 10).toFixed(1)} s</b><button data-act="sp+">+</button><button data-act="clear" style="width:auto;padding:3px 8px">All at 0</button></div>`
      + `<div class="rows">${rows}</div>`
      + (t.relays.length ? `<p class="relays"><i style="background:${RELAY_CSS}"></i>${t.relays.length} relay${t.relays.length > 1 ? 's' : ''} on storey ${[...new Set(t.relays.map((x) => x.storey))].join(', ')}: they go off when jolted</p>` : '')
      + `<button class="plunger" data-act="plunger"${this.enabled ? '' : ' disabled'}><kbd>Enter</kbd> Plunger</button>`;
  }

  private onClick(e: MouseEvent): void {
    const t = this.timeline, b = (e.target as HTMLElement).closest('button');
    if (!t || !b) return;
    const act = b.dataset.act, k = Number(b.dataset.k);
    if (act === 'plunger') { this.press(); return; }
    if (act === 'inc' || act === 'dec') { t.set(k, t.snaps[k]! + (act === 'inc' ? 1 : -1)); t.selected = k; }
    if (act === 'sweep') { this.dir = b.dataset.dir!; t.sweep(this.dir, this.spacing); }
    if (act === 'sp+' || act === 'sp-') { this.spacing = Math.max(1, Math.min(10, this.spacing + (act === 'sp+' ? 1 : -1))); t.sweep(this.dir, this.spacing); }
    if (act === 'clear') t.clear();
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
