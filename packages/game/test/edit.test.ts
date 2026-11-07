// Edit mode's controller (C9, edit.ts): the pointer places, lays and erases
// through rays as a page sends them, keys turn and tip what is held, the
// ghost's bodies and colours follow, and play() is the edited level.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import { compileLevel, type LevelDef } from '@tb/keystone';
import { EditController, GHOST_BAD, GHOST_OK } from '../src/index.ts';
import { applyEditAction, editHtml } from '../src/edit-panel.ts';

const level: LevelDef = {
  id: 'EDIT', name: 'edit', version: 1, world: 0, lot: { min: [-10, -10], max: [10, 10] }, crownLine: 1, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble'], launcher: { radius: 12, y: 1, dropY: 8 }, build: { budget: 30 },
  parts: [{ kind: 'block', at: [0, 0, 0], size: [2, 1, 1], material: 'plaster' }],
};
/** Straight down onto (x, z), metres. */
const at = (x: number, z: number) => ({ origin: [x, 20, z] as Vec3, dir: [0, -1, 0] as Vec3 });

describe('edit controller', () => {
  it('a click places what is held where the ghost showed it; the ghost is drawn after the world, green', () => {
    const e = new EditController(level);
    e.move(at(3, 0));
    const { world, ghost } = e.bodies();
    expect(world.length).toBe(2);
    expect(ghost.length).toBe(1);
    expect(e.fx()).toEqual([[2, GHOST_OK]]);
    const shown = ghost[0]!.pos;
    expect(e.up()).toBe(true);
    expect(e.version).toBe(1);
    const c = compileLevel(e.play());
    expect(c.meta.n).toBe(3);
    expect(c.scene.bodies[2]!.pos).toEqual(shown);
    expect(e.status()).toMatch(/^Cube, 0° · 29 of 30 left/);
  });

  it('keys turn, tip and pick items; a ghost into the world is red and a click there changes nothing', () => {
    const e = new EditController(level);
    e.key('e');
    expect(e.hold.yaw).toBe(90);
    e.key('q', { shift: true });
    expect(e.hold.yaw).toBe(75);
    e.key('t');
    expect(e.hold.tip).toBe(1);
    e.key('5'); // the beam
    expect(e.hold.item).toBe('beam');
    expect(e.key('?')).toBe(false);
    // A cube on the ground (snapped to x = 12 half-cells, 3.06 m, half 0.25 m), then the tipped beam (a pier,
    // 0.25 m half across) with snap off (Alt) just beside it on the ground: it reaches into the cube.
    e.key('1');
    e.move(at(3, 0));
    expect(e.up()).toBe(true);
    e.key('5');
    e.move(at(3.45, 0), { alt: true });
    expect(e.ghost!.ok).toBe(false);
    expect(e.fx().every(([, fx]) => fx === GHOST_BAD)).toBe(true);
    expect(e.up()).toBe(false);
    expect(e.message).toMatch(/overlaps 1 body/);
    expect(e.version).toBe(1);
  });

  it('the brush lays a run along a drag; erase takes one domino of it back; undo puts it back', () => {
    const e = new EditController(level);
    e.key('b');
    expect(e.tool).toBe('brush');
    expect(e.down(at(-4, -3))).toBe(true);
    for (let z = -3; z <= 3; z += 0.05) e.move(at(-4, z));
    const preview = e.bodies().ghost.length;
    expect(preview).toBe(Math.floor(6 / 0.6) + 1);
    expect(e.status()).toMatch(/11 dominoes/);
    expect(e.up()).toBe(true);
    expect(compileLevel(e.play()).meta.n).toBe(2 + preview);
    e.key('x');
    e.move({ origin: [-10, 0.5, 0], dir: [1, 0, 0] });
    expect(e.hover).toBeGreaterThanOrEqual(2);
    expect(e.up()).toBe(true);
    expect(compileLevel(e.play()).meta.n).toBe(1 + preview);
    e.key('z');
    expect(compileLevel(e.play()).meta.n).toBe(2 + preview);
    // The authored block may not be erased outside author mode.
    e.move({ origin: [0.25, 0.25, -10], dir: [0, 0, 1] });
    expect(e.hover).toBe(-1);
  });

  it('[ and ] slide the plank along its length off the pointer, to its reach; the panel offers Slide only for what slides', () => {
    const e = new EditController(level);
    e.select('plank');
    expect(e.hold.item).toBe('plank');
    e.move(at(-4, 0));
    const x0 = e.ghost!.boxes[0]!.c[0], step = (1.02 * 0.5) / 2;
    expect(e.key(']')).toBe(true);
    expect(e.key(']')).toBe(true);
    expect(e.ghost!.boxes[0]!.c[0] - x0).toBeCloseTo(2 * step, 9);
    expect(e.status()).toMatch(/^Plank, 0°, slid \+2 · /);
    for (let i = 0; i < 6; i++) e.key('[');
    expect(e.hold.slide).toBe(-4);
    expect(e.key('[')).toBe(false);
    expect(e.message).toBe('slid as far as it goes');
    expect(e.ghost!.boxes[0]!.c[0] - x0).toBeCloseTo(-4 * step, 9);
    expect(editHtml(e)).toMatch(/data-a="slide" data-d="1"/);
    expect(applyEditAction(e, { a: 'slide', d: 1 })).toBe(true);
    expect(e.hold.slide).toBe(-3);
    // A cube does not slide: no Slide buttons, and the key says why.
    e.key('1');
    expect(e.key(']')).toBe(false);
    expect(e.message).toBe('this piece does not slide');
    expect(editHtml(e)).not.toMatch(/data-a="slide"/);
  });

  it('a level that offers no brush keeps the place tool; author mode has no budget', () => {
    const e = new EditController({ ...level, build: { brush: false } }, { tool: 'brush' });
    expect(e.tool).toBe('place');
    e.key('b');
    expect(e.tool).toBe('place');
    expect(e.message).toMatch(/not offered/);
    const a = new EditController(level, { author: true, item: 'domino' });
    expect(a.hold.item).toBe('domino');
    expect(a.session.budget).toBeNull();
  });
});
