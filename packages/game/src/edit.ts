// Edit mode's controller (C9, docs/game/placement.md): the player's tool, the
// piece they hold and how it is turned, and what the pointer does with them,
// over a BuildSession (@tb/keystone build.ts). DOM-free: a page turns pointer
// and key events into rays and names, and draws bodies() with fx() over its
// renderer. Time is stopped throughout; play() is the level to compile and run.
import type { BodyDesc, Vec3 } from '@tb/engine-api';
import { BuildSession, CATALOG_NAMES, type CatalogName, type Ghost, type Hold, type LevelDef, type Obb, type P2, type Ray, smoothStroke, type StrokeGhost, turn } from '@tb/keystone';
import type { FxOptions } from '@tb/render';

export const EDIT_TOOLS = ['place', 'brush', 'erase'] as const;
export type EditTool = (typeof EDIT_TOOLS)[number];

/** Ghost colours: what fits glows green, what does not red; the body erase would take is tinted red. */
export const GHOST_OK: FxOptions = { tint: [0.3, 1, 0.3], emissive: 0.25 };
export const GHOST_BAD: FxOptions = { tint: [1, 0.22, 0.2], emissive: 0.25 };
export const ERASE_MARK: FxOptions = { tint: [1, 0.35, 0.3], emissive: 0.08 };

export interface EditOptions {
  /** The viewer's author mode: anything may be removed and no budget applies (BuildSession). */
  author?: boolean;
  tool?: EditTool;
  item?: CatalogName;
}

/** Modifier keys that change what the pointer does. */
export interface Mods { alt?: boolean; shift?: boolean }

const box = (b: Obb): BodyDesc => ({ shape: { kind: 'box', half: [...b.half] as Vec3 }, pos: [...b.c] as Vec3, rot: [...b.q] as BodyDesc['rot'], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 250, friction: 0.6, restitution: 0, tag: 0 });

export class EditController {
  readonly session: BuildSession;
  tool: EditTool;
  hold: Hold;
  /** Snap to faces' half-cell grids (Alt held turns it off for one move). */
  snap = true;
  ghost: Ghost | null = null;
  strokeGhost: StrokeGhost | null = null;
  /** The body erase would take (-1: none). */
  hover = -1;
  /** Counts edits: a page redescribes the world's bodies when it changes. */
  version = 0;
  /** The last thing that did not work, for the panel ('' when the last action did). */
  message = '';
  private stroke: P2[] | null = null;
  private lastRay: Ray | null = null;
  private lastMods: Mods = {};

  constructor(def: LevelDef, opts: EditOptions = {}) {
    this.session = new BuildSession(def, { author: opts.author });
    this.tool = opts.tool ?? 'place';
    const item = opts.item && this.session.items.some((i) => i.name === opts.item) ? opts.item : (this.session.items[0]?.name as CatalogName | undefined) ?? 'cube';
    this.hold = { item, yaw: 0, tip: 0 };
    if (this.tool === 'brush' && !this.session.brush) this.tool = 'place';
  }

  /** The level as edited: what Play compiles and runs. */
  play(): LevelDef { return this.session.def(); }

  /** The pointer moved (no button held, or a brush stroke under way). */
  move(ray: Ray, mods: Mods = {}): void {
    this.lastRay = ray;
    this.lastMods = mods;
    this.ghost = null;
    this.hover = -1;
    const hit = this.session.pick(ray);
    if (this.tool === 'brush') {
      if (this.stroke && hit) {
        const h = this.session.h, p: P2 = [hit.point[0] / h, hit.point[2] / h];
        this.stroke.push(p);
        this.strokeGhost = this.session.stroke(smoothStroke(this.stroke));
      }
      return;
    }
    if (!hit) return;
    if (this.tool === 'erase') { if (hit.body >= 0 && this.session.removable(hit.body)) this.hover = hit.body; return; }
    this.ghost = this.session.ghost(hit, this.hold, { snap: this.snap && !mods.alt });
  }

  /** A press: starts a brush stroke. Returns whether the press is the editor's (a page then does not orbit on the drag). */
  down(ray: Ray): boolean {
    if (this.tool !== 'brush') return false;
    const hit = this.session.pick(ray);
    if (!hit) return false;
    this.stroke = [];
    this.move(ray);
    return true;
  }

  /** Whether a brush stroke is under way (a press began it and no release or cancel has ended it). */
  get stroking(): boolean { return this.stroke !== null; }

  /** Drop the stroke under way, laying nothing (a touch cancelled, a second finger landed). */
  cancelStroke(): void {
    this.stroke = null;
    this.strokeGhost = null;
  }

  /** A click (a press and release that did not drag) or the end of a stroke: place, lay or erase. Returns whether the level changed. */
  up(ray: Ray | null = this.lastRay, mods: Mods = this.lastMods): boolean {
    if (this.tool === 'brush') {
      const s = this.strokeGhost;
      this.stroke = null;
      this.strokeGhost = null;
      if (!s) return false;
      return this.after(this.session.lay(s), s.why);
    }
    if (!ray) return false;
    this.move(ray, mods);
    if (this.tool === 'erase') {
      const ok = this.hover >= 0 && this.session.remove(this.hover);
      return this.after(ok, ok ? '' : 'nothing here may be taken back');
    }
    const g = this.ghost;
    return this.after(!!g && this.session.place(g), g?.why || 'point at a face or the ground');
  }

  private after(changed: boolean, why: string): boolean {
    this.message = changed ? '' : why;
    if (changed) {
      this.version++;
      if (this.lastRay) this.move(this.lastRay, this.lastMods);
    }
    return changed;
  }

  /** A key in edit mode; returns whether it was one (Q / E turn 90 deg, 15 with Shift; T tip; 1 to 8 items; B brush; X erase; P place; Z undo). */
  key(k: string, mods: Mods = {}): boolean {
    const step = mods.shift ? 15 : 90;
    const lower = k.toLowerCase();
    if (lower === 'q') this.hold = turn(this.hold, -step);
    else if (lower === 'e') this.hold = turn(this.hold, step);
    else if (lower === 't') this.hold = { ...this.hold, tip: ((this.hold.tip + 1) % 3) as 0 | 1 | 2 };
    else if (/^[1-9]$/.test(k)) { const it = this.session.items[Number(k) - 1]; if (!it) return false; this.select(it.name as CatalogName); }
    else if (lower === 'b') this.setTool(this.tool === 'brush' ? 'place' : 'brush');
    else if (lower === 'x') this.setTool(this.tool === 'erase' ? 'place' : 'erase');
    else if (lower === 'z') { this.undo(); return true; }
    else return false;
    if (this.lastRay) this.move(this.lastRay, this.lastMods);
    return true;
  }

  select(item: CatalogName): void {
    if (!this.session.items.some((i) => i.name === item)) return;
    this.hold = { ...this.hold, item };
    if (this.tool !== 'place') this.setTool('place');
    if (this.lastRay) this.move(this.lastRay, this.lastMods);
  }

  setTool(t: EditTool): void {
    if (t === 'brush' && !this.session.brush) { this.message = 'the domino brush is not offered here'; return; }
    this.tool = t;
    this.stroke = null;
    this.strokeGhost = null;
    if (this.lastRay) this.move(this.lastRay, this.lastMods);
  }

  undo(): boolean { return this.after(this.session.undo(), 'nothing to undo'); }
  clear(): boolean { return this.after(this.session.clear(), 'nothing placed'); }

  /** The world's bodies (the level as edited, at its authored poses) followed by the ghost's. */
  bodies(): { world: BodyDesc[]; ghost: BodyDesc[] } {
    const world = this.session.compiled().scene.bodies;
    const boxes = this.strokeGhost?.boxes ?? this.ghost?.boxes ?? [];
    return { world, ghost: boxes.map(box) };
  }

  /** Effects for the ghost's slots (after the world's n) and the erase target. */
  fx(): Array<[number, FxOptions]> {
    const n = this.session.compiled().meta.n, out: Array<[number, FxOptions]> = [];
    if (this.strokeGhost) this.strokeGhost.clash.forEach((bad, i) => out.push([n + i, bad ? GHOST_BAD : GHOST_OK]));
    else if (this.ghost) this.ghost.boxes.forEach((_, i) => out.push([n + i, this.ghost!.ok ? GHOST_OK : GHOST_BAD]));
    if (this.hover >= 0) out.push([this.hover, ERASE_MARK]);
    return out;
  }

  /** One line for the panel: what is held, how it is turned, what is left, and why the ghost does not fit. */
  status(): string {
    const s = this.session, left = s.left();
    const what = this.tool === 'brush' ? 'domino brush' : this.tool === 'erase' ? 'erase' : `${s.items.find((i) => i.name === this.hold.item)?.label ?? this.hold.item}, ${this.hold.yaw} deg${this.hold.tip ? `, tipped ${this.hold.tip === 1 ? 'on x' : 'on z'}` : ''}`;
    const budget = left === null ? `${s.spent()} placed` : `${left} of ${s.budget} left`;
    const why = this.strokeGhost ? (this.strokeGhost.why || `${this.strokeGhost.cost} dominoes${this.strokeGhost.clash.some(Boolean) ? `, ${this.strokeGhost.clash.filter(Boolean).length} left out` : ''}`) : this.ghost && !this.ghost.ok ? this.ghost.why : this.message;
    return [what, budget, why].filter(Boolean).join(' · ');
  }
}

export const isCatalogName = (x: string): x is CatalogName => (CATALOG_NAMES as readonly string[]).includes(x);
export const isEditTool = (x: string): x is EditTool => (EDIT_TOOLS as readonly string[]).includes(x);
