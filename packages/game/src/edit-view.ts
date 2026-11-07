// Draws edit mode (C9, docs/game/placement.md) into a page's renderer: the
// level as edited at its authored poses (time stopped), tinted, coated and
// marked as the game draws a level (the bell gilt, what the player built in its
// own blue: PT26 found the bell grey here, as the coats were never set), then the ghost's boxes after it in green or red, and
// the body erase would take in red. The world's shapes are described again
// only when they change (an edit, or a ghost of other boxes), so moving the
// pointer only rewrites poses.
import { emptySnapshot } from '@tb/engine-api';
import type { EditController } from './edit.ts';
import { structureCoats, structureMarks, structureTints } from './scene.ts';
import type { Renderer, SnapshotSource } from '@tb/render';

export class EditView {
  private sig = '';
  private slots = 0;

  constructor(private readonly renderer: Renderer, private readonly source: SnapshotSource) {}

  /** Draw the level as edited: marks and coats as the game's settings say (PaceFeel.marks, PaceFeel.coats). */
  show(e: EditController, marks: boolean, coats = true): void {
    const { world, ghost } = e.bodies(), all = [...world, ...ghost];
    const sig = `${e.version}|${ghost.map((g) => (g.shape.kind === 'box' ? g.shape.half.join(',') : `r${g.shape.radius}`)).join(';')}`;
    if (sig !== this.sig) {
      this.source.reset(world);
      // Every slot's effects from scratch (a page's own, such as a level's grow-in scales, too).
      this.renderer.clearFx(0, Math.max(this.slots, all.length));
      this.sig = sig;
    }
    const s = emptySnapshot(all.length);
    all.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); });
    this.source.update(s, all);
    const c = e.session.compiled();
    this.renderer.setFx(0, structureTints(c, coats));
    this.renderer.setMarks(0, structureMarks(c, marks));
    this.renderer.setCoats(0, structureCoats(c, coats));
    if (this.slots > world.length) this.renderer.clearFx(world.length, this.slots - world.length);
    for (const [slot, fx] of e.fx()) this.renderer.setFx(slot, fx);
    this.slots = all.length;
  }

  /** Forget what was drawn (leaving edit mode): the next show redescribes everything. */
  forget(): void {
    if (this.slots) this.renderer.clearFx(0, this.slots);
    this.slots = 0;
    this.sig = '';
  }
}
