// Draws edit mode (C9, docs/game/placement.md) into a page's renderer: the
// level as edited at its authored poses (time stopped), tinted and marked as
// the game draws a level, then the ghost's boxes after it in green or red, and
// the body erase would take in red. The world's shapes are described again
// only when they change (an edit, or a ghost of other boxes), so moving the
// pointer only rewrites poses.
import { emptySnapshot } from '@tb/engine-api';
import type { EditController } from './edit.ts';
import { structureMarks, structureTints } from './scene.ts';
import type { Renderer, SnapshotSource } from '@tb/render';

export class EditView {
  private sig = '';
  private slots = 0;

  constructor(private readonly renderer: Renderer, private readonly source: SnapshotSource) {}

  show(e: EditController, marks: boolean): void {
    const { world, ghost } = e.bodies(), all = [...world, ...ghost];
    const sig = `${e.version}|${ghost.map((g) => (g.shape.kind === 'box' ? g.shape.half.join(',') : '')).join(';')}`;
    if (sig !== this.sig) {
      this.source.reset(world);
      if (this.slots) this.renderer.clearFx(0, this.slots);
      this.sig = sig;
    }
    const s = emptySnapshot(all.length);
    all.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); });
    this.source.update(s, all);
    const c = e.session.compiled();
    this.renderer.setFx(0, structureTints(c));
    this.renderer.setMarks(0, structureMarks(c, marks));
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
