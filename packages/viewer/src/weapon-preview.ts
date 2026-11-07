// The weapon's flight drawn in the scene (roadmap C12 step 3, docs/design/weapon-editor.md): from
// where a click would fire it, every munition's track as beads (the renderer's overlay spheres), each
// blast as a ring at its reach. The flight is @tb/weapons previewWeapon (the weapon's own runtime over
// free flight) with the scene's bodies held where the last snapshot has them (it senses only those near
// a munition, through a grid), so a proximity fuse goes off where it would. Pure: main.ts calls it and hands the beads to the renderer.
import { type ShapeDesc, type Snapshot } from '@tb/engine-api';
import { type GrenadeWorld, type PreviewLaunch, previewWeapon, type WeaponPreview, type WeaponSpec } from '@tb/weapons';

/** Overlay spheres the renderer draws at most (render MAX_OVERLAY). */
export const PREVIEW_BEADS = 1024;

/** The flight of `spec` fired as `launch` into the scene `s` (its bodies held where they are; none: the open). */
export function scenePreview(spec: WeaponSpec, launch: PreviewLaunch, world: GrenadeWorld, s: Snapshot | null, shapes: readonly { shape: ShapeDesc }[]): WeaponPreview {
  return previewWeapon(spec, launch, world, s && s.count ? { obstacles: { s, shapes } } : {});
}

/** rgb8 + emissive8 as the renderer's overlay colour word (r in the low byte). */
const word = (rgb: number, glow: number) => (((rgb >> 16) & 0xff) | (((rgb >> 8) & 0xff) << 8) | ((rgb & 0xff) << 16) | ((glow & 0xff) << 24)) >>> 0;
/** Shell white, children orange, grandchildren yellow (as the editor's side view), blasts red. */
export const BEAD_COLOURS = [word(0xe8ebf2, 0x50), word(0xf5b169, 0x60), word(0xf2e36b, 0x60)];
export const BLAST_COLOUR = word(0xff2a1a, 0xa0);
const RING = 24;

/**
 * Beads for a preview: each blast as a ring of RING beads at its radius around its centre, in the
 * horizontal plane (first, so a tight budget keeps them); along each track a bead every few steps (fewer
 * per track as tracks multiply, within `max`), up to its first contact; the split point as a bigger bead.
 * bead: a bead's radius.
 */
export function previewBeads(p: WeaponPreview, bead: number, max = PREVIEW_BEADS): { xyzr: Float32Array; colours: Uint32Array } {
  const xyzr: number[] = [], colours: number[] = [];
  const put = (q: readonly number[], r: number, c: number) => { if (colours.length < max) { xyzr.push(q[0]!, q[1]!, q[2]!, r); colours.push(c); } };
  const ringBeads = Math.min(p.blasts.length * (RING + 1), Math.floor(max / 3));
  const perRing = p.blasts.length ? Math.max(4, Math.floor(ringBeads / p.blasts.length) - 1) : 0;
  const perTrack = Math.max(3, Math.floor((max - p.blasts.length * (perRing + 1)) / Math.max(1, p.tracks.length)));
  // Blasts first: a tight budget thins the tracks, never drops a blast.
  for (const b of p.blasts) {
    put(b.centre, bead * 1.2, BLAST_COLOUR);
    for (let k = 0; k < perRing; k++) {
      const a = (2 * Math.PI * k) / perRing;
      put([b.centre[0] + b.radius * Math.cos(a), b.centre[1], b.centre[2] + b.radius * Math.sin(a)], bead * 0.6, BLAST_COLOUR);
    }
  }
  for (const t of p.tracks) {
    const depth = t.path ? t.path.split('.').length : 0, c = BEAD_COLOURS[Math.min(depth, 2)]!;
    const end = t.contact === null ? t.points.length : Math.min(t.points.length, t.contact - t.start + 1);
    const every = Math.max(1, Math.ceil(end / perTrack));
    for (let k = 0; k < end; k += every) put(t.points[k]!, depth ? bead * 0.7 : bead, c);
    if (t.end === 'split') put(t.points[t.points.length - 1]!, bead * 2, c);
  }
  return { xyzr: new Float32Array(xyzr), colours: new Uint32Array(colours) };
}
