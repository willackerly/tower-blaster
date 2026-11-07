// The other worlds of a Chorus level (roadmap M9, docs/game/chorus.md, keystone chorus.ts). The hero world,
// world 0, is the level the game frames and draws as usual; this panel shows the rest beside it, by the
// keystone.chorusview option: an 8 x 8 grid of live side-view thumbnails ('grid', the default), a heat strip
// of one cell per world ('strip'), or only the count ('off'). Each world's tile is edged green once it
// clears, and the count reads "21 of 64 clear". Nothing here moves the camera; it reads the engine and draws.
//
// Cost: a thumbnail is one rectangle per body on a 2D canvas, drawn at most VIEW_HZ times a second, so 64
// worlds of 100 bodies are 6.4k small rectangles, well under a millisecond; judge() (every world's counts in
// the observer's arithmetic) runs at the same rate.
import { ChorusEngine, type ChorusJudgement, type CompiledLevel, ROLE_ID } from '@tb/keystone';
import { rotate } from '@tb/geom';
import type { Vec3 } from '@tb/engine-api';
import type { ChorusView as ViewMode } from './options/chorusview.ts';

/** Redraws a second, at most, while a shot runs. */
export const VIEW_HZ = 6;

/** A tile's look: what the edge says about its world. */
export type TileState = 'waiting' | 'running' | 'cleared' | 'failed';

/** Per world, its tile state from the judgement: cleared, else running until the round ends, then failed. */
export function tileStates(j: ChorusJudgement, over: boolean): TileState[] {
  return j.cleared.map((c) => (c ? 'cleared' : over ? 'failed' : 'running'));
}

/** Heat of a world for the strip, 0 to 1: its crowns down over the crowns it needs (1 when cleared, 0.9 at most otherwise). */
export function heatOf(j: ChorusJudgement, k: number): number {
  if (j.cleared[k]) return 1;
  return Math.min(0.9, j.need > 0 ? j.crownsDown[k]! / j.need : 0);
}

/** The count line: "21 of 64 clear" (and "so far" while the shot runs). */
export function countText(j: ChorusJudgement | null, worlds: number, over: boolean): string {
  if (!j) return `${worlds} worlds: one shot fires into all of them`;
  return `${j.clears} of ${j.worlds} clear${over ? '' : ' so far'}`;
}

const CSS = `
.kg-chorus { position: absolute; right: 12px; bottom: 12px; z-index: 6; background: rgba(12, 16, 24, 0.78); border: 1px solid rgba(255,255,255,0.15);
  border-radius: 8px; padding: 6px 8px; color: #e8eef8; font: 12px/1.3 system-ui, sans-serif; pointer-events: none; }
.kg-chorus .count { font-weight: 700; margin-bottom: 4px; letter-spacing: 0.02em; }
.kg-chorus canvas { display: block; }
.kg-chorus[data-mode="off"] canvas { display: none; }
body.kg-building .kg-chorus { display: none; }
`;

const COLOURS = { plain: '#9aa3ad', crown: '#f2c14e', crownDown: '#b9533f', heritage: '#7fb2e5', ammo: '#30343a' } as const;
const EDGES: Record<TileState, string> = { waiting: 'rgba(255,255,255,0.18)', running: 'rgba(255,255,255,0.35)', cleared: '#5ad17a', failed: 'rgba(230,90,80,0.65)' };

/** The panel; one per game page, attached to each Chorus level's engine as it loads. */
export class ChorusPanel {
  readonly el: HTMLElement;
  private readonly count: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private engine: ChorusEngine | null = null;
  private level: CompiledLevel | null = null;
  private last = 0;
  private over = false;
  /** The last judgement drawn (tests read it). */
  judgement: ChorusJudgement | null = null;

  constructor(parent: HTMLElement, private readonly mode: () => ViewMode) {
    if (!document.getElementById('kg-chorus-css')) {
      const st = document.createElement('style');
      st.id = 'kg-chorus-css';
      st.textContent = CSS;
      document.head.append(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'kg-chorus';
    this.el.hidden = true;
    this.count = document.createElement('div');
    this.count.className = 'count';
    this.canvas = document.createElement('canvas');
    this.el.append(this.count, this.canvas);
    parent.append(this.el);
  }

  /** A level loaded (or retried): shown when its engine is a Chorus one, hidden otherwise. */
  attach(engine: unknown, level: CompiledLevel): void {
    this.engine = engine instanceof ChorusEngine ? engine : null;
    this.level = this.engine ? level : null;
    this.over = false;
    this.judgement = null;
    this.last = 0;
    this.el.hidden = !this.engine;
    if (this.engine) this.draw();
  }

  /** After a step: redraws at most VIEW_HZ times a second. */
  tick(now = performance.now()): void {
    if (!this.engine || now - this.last < 1000 / VIEW_HZ) return;
    this.last = now;
    // An undo back before the shot: the round is open again.
    if (!this.engine.fired) this.over = false;
    this.draw();
  }

  /** The round is over and scored: the final count and edges. */
  end(): void {
    if (!this.engine) return;
    this.over = true;
    this.draw();
  }

  private draw(): void {
    const e = this.engine!, c = this.level!, mode = this.mode();
    this.el.dataset.mode = mode;
    const j = e.fired ? e.judge() : null;
    this.judgement = j;
    this.count.textContent = countText(j, e.worlds, this.over);
    if (mode === 'off') return;
    const K = e.worlds, states = j ? tileStates(j, this.over) : Array<TileState>(K).fill('waiting');
    if (mode === 'strip') this.drawStrip(K, j, states);
    else this.drawGrid(K, c, states);
  }

  private drawStrip(K: number, j: ChorusJudgement | null, states: TileState[]): void {
    const cell = 6, gap = 1, cv = this.canvas, dpr = devicePixelRatio || 1;
    const w = K * (cell + gap) - gap, h = 14;
    size(cv, w, h, dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    for (let k = 0; k < K; k++) {
      const heat = j ? heatOf(j, k) : 0;
      g.fillStyle = states[k] === 'cleared' ? EDGES.cleared : `hsl(${20 + 30 * heat}, ${30 + 50 * heat}%, ${25 + 30 * heat}%)`;
      g.fillRect(k * (cell + gap), k === 0 ? 0 : 2, cell, k === 0 ? h : h - 4);
    }
  }

  private drawGrid(K: number, c: CompiledLevel, states: TileState[]): void {
    const cols = Math.ceil(Math.sqrt(K)), rows = Math.ceil(K / cols), tile = 30, gap = 3, cv = this.canvas, dpr = devicePixelRatio || 1;
    const w = cols * (tile + gap) - gap, h = rows * (tile + gap) - gap;
    size(cv, w, h, dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // One frame for every tile: the lot's width along x (a margin each side) and the level's height and a half.
    const x0 = c.lot.min[0], x1 = c.lot.max[0], top = Math.max(c.height * 1.5, (x1 - x0) * 0.5), span = Math.max(x1 - x0, top);
    const sc = (tile - 4) / span, ox = 2 + ((tile - 4) - (x1 - x0) * sc) / 2;
    const n = c.meta.n, role = c.meta.role, crownLine = c.def.crownLine * c.frame.unit;
    for (let k = 0; k < K; k++) {
      const s = this.engine!.worldState(k);
      const tx = (k % cols) * (tile + gap), ty = Math.floor(k / cols) * (tile + gap);
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(tx, ty, tile, tile);
      if (s) {
        for (let i = 0; i < s.count; i++) {
          if (s.tier?.[i] === 255) continue; // removed (a pull, the fence)
          const half: Vec3 = i < n ? [c.meta.half[3 * i]!, c.meta.half[3 * i + 1]!, c.meta.half[3 * i + 2]!] : [0.1, 0.1, 0.1];
          const q: [number, number, number, number] = [s.rot[4 * i]!, s.rot[4 * i + 1]!, s.rot[4 * i + 2]!, s.rot[4 * i + 3]!];
          // The box's extent on x and y once turned: the side view's rectangle.
          const ax = rotate(q, [half[0], 0, 0]), ay = rotate(q, [0, half[1], 0]), az = rotate(q, [0, 0, half[2]]);
          const ex = Math.abs(ax[0]) + Math.abs(ay[0]) + Math.abs(az[0]), ey = Math.abs(ax[1]) + Math.abs(ay[1]) + Math.abs(az[1]);
          const px = s.pos[3 * i]!, py = s.pos[3 * i + 1]!;
          g.fillStyle = i >= n ? COLOURS.ammo : role[i] === ROLE_ID.crown ? (py < crownLine ? COLOURS.crownDown : COLOURS.crown) : role[i] === ROLE_ID.heritage ? COLOURS.heritage : COLOURS.plain;
          const rx = tx + ox + (px - ex - x0) * sc, ry = ty + tile - 2 - (py + ey) * sc;
          g.fillRect(rx, ry, Math.max(0.6, 2 * ex * sc), Math.max(0.6, 2 * ey * sc));
        }
      }
      g.strokeStyle = EDGES[states[k]!];
      g.lineWidth = k === 0 ? 2 : 1;
      g.strokeRect(tx + 0.5, ty + 0.5, tile - 1, tile - 1);
    }
  }
}

function size(cv: HTMLCanvasElement, w: number, h: number, dpr: number): void {
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  }
}
