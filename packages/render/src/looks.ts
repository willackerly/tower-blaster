// What a body looks like, packed into one u32 per slot (BodyLook). Computed
// on the CPU from the scene description, so it costs one upload per body at
// init or spawn and nothing per frame. Slots are stable and a lattice body's
// id is its scene index, so a look follows its cube through every tier.
import { TAG_BALL, type BodyDesc } from '@tb/engine-api';

export const MATERIAL = { candy: 0, ball: 1, debris: 2 } as const;

export interface LookRange { minY: number; maxY: number }

/** Height range of the scene's bodies, for the colour ramp. */
export function lookRange(bodies: BodyDesc[]): LookRange {
  let minY = Infinity, maxY = -Infinity;
  for (const b of bodies) {
    if (b.tag < 0) continue;
    minY = Math.min(minY, b.pos[1]);
    maxY = Math.max(maxY, b.pos[1]);
  }
  return Number.isFinite(minY) ? { minY, maxY } : { minY: 0, maxY: 1 };
}

/** Palette slot per body: towers cycle through 6 colours, balls and debris get their own. */
export function paletteOf(tag: number): number {
  if (tag === TAG_BALL) return 6;
  if (tag < 0) return 7;
  return ((tag % 6) + 6) % 6;
}

function hash16(x: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) & 0xffff;
}

/** Bits 0-7 ramp position (original height), 8-11 hue, 12-15 material, 16-31 seed. */
export function lookOf(b: BodyDesc, slot: number, range: LookRange): number {
  const span = Math.max(range.maxY - range.minY, 1e-6);
  const ramp = Math.round(Math.min(1, Math.max(0, (b.pos[1] - range.minY) / span)) * 255);
  const material = b.tag === TAG_BALL ? MATERIAL.ball : b.tag < 0 ? MATERIAL.debris : MATERIAL.candy;
  return (ramp | (paletteOf(b.tag) << 8) | (material << 12) | (hash16(slot) << 16)) >>> 0;
}

export function unpackLook(look: number): { ramp: number; hue: number; material: number; seed: number } {
  return { ramp: look & 0xff, hue: (look >>> 8) & 0xf, material: (look >>> 12) & 0xf, seed: look >>> 16 };
}
