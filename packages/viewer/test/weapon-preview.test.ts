// The weapon's flight as scene beads (weapon-preview.ts): the beads are previewWeapon's own points and
// blast spheres, coloured by depth, within the renderer's overlay budget.
import { describe, expect, it } from 'vitest';
import { CLUSTER, FIREWORK, previewWeapon } from '@tb/weapons';
import { BEAD_COLOURS, BLAST_COLOUR, PREVIEW_BEADS, previewBeads, scenePreview } from '../src/weapon-preview.ts';
import { CUBE_WORLD } from '../src/weapon-editor.ts';

const launch = (speed: number) => ({ shape: FIREWORK.shell.shape, pos: [0, 1.5, 0] as [number, number, number], vel: [speed * 0.6, speed * 0.8, 0] as [number, number, number], density: FIREWORK.shell.density });

describe('the flight as beads', () => {
  it('every track bead is a preview point, every blast is a centre and a ring at its radius', () => {
    const p = scenePreview(FIREWORK, launch(30), CUBE_WORLD, null, []);
    expect(p).toEqual(previewWeapon(FIREWORK, launch(30), CUBE_WORLD, {}));
    const { xyzr, colours } = previewBeads(p, 0.1);
    expect(xyzr.length).toBe(4 * colours.length);
    expect(colours.length).toBeLessThanOrEqual(PREVIEW_BEADS);
    const near = (a: ArrayLike<number>, b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    const points = p.tracks.flatMap((t) => t.points);
    let ring = 0;
    for (let i = 0; i < colours.length; i++) {
      const q = xyzr.subarray(4 * i, 4 * i + 3);
      if (colours[i] === BLAST_COLOUR) {
        // A centre, or on the horizontal circle of radius r around one.
        const on = p.blasts.some((b) => near(q, b.centre) < 1e-4 || (Math.abs(q[1]! - b.centre[1]) < 1e-4 && Math.abs(Math.hypot(q[0]! - b.centre[0], q[2]! - b.centre[2]) - b.radius) < 1e-4));
        expect(on).toBe(true);
        ring++;
      } else {
        expect(BEAD_COLOURS).toContain(colours[i]);
        expect(points.some((pt) => near(q, pt) < 1e-4)).toBe(true);
      }
    }
    expect(ring).toBeGreaterThanOrEqual(p.blasts.length * 5);
    // Shell beads white, the stars' orange.
    expect(colours).toContain(BEAD_COLOURS[0]);
    expect(colours).toContain(BEAD_COLOURS[1]);
  });

  it('a tight budget is kept, and every blast still shows', () => {
    const p = previewWeapon(CLUSTER, launch(20), CUBE_WORLD, {});
    const { colours } = previewBeads(p, 0.1, 64);
    expect(colours.length).toBeLessThanOrEqual(64);
    expect(colours.filter((c) => c === BLAST_COLOUR).length).toBeGreaterThanOrEqual(p.blasts.length);
  });
});
