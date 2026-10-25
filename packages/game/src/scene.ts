// How the game decorates the renderer's bodies (@tb/render draws them
// straight from the snapshot): per-slot tints by role and material, the
// crown glow, the Regrow animation on retry as per-slot visual scales, and
// arc-preview beads as overlay spheres. Everything here is pure data for
// Renderer.setFx / setOverlay; none of it reaches the physics.
import { type CompiledLevel, MATERIALS } from '@tb/keystone';

/** Linear rgb (0..1) and emissive (0..1) to the renderer's bulk tint word: r low byte, emissive high byte. */
export function tintWordOf(rgb: [number, number, number], emissive = 0): number {
  const b = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return (b(rgb[0]) | (b(rgb[1]) << 8) | (b(rgb[2]) << 16) | (b(emissive) << 24)) >>> 0;
}

/** Role tints (multiply the look's albedo). Crowns also glow a little until they fall. */
export const TINT = {
  crown: [1, 0.72, 0.22] as [number, number, number],
  heritage: [0.5, 0.86, 0.7] as [number, number, number],
  none: [1, 1, 1] as [number, number, number],
};
export const CROWN_GLOW = 0.1;
const MATERIAL_TINT: Record<string, [number, number, number]> = {
  plaster: TINT.none, stone: [0.62, 0.62, 0.66], iron: [0.3, 0.3, 0.34], ice: [0.62, 0.85, 1], rubber: [0.9, 0.45, 0.55], steel: [0.4, 0.42, 0.46],
};

/** Role wins over material: crowns are gold and heritage is celadon whatever they are made of. */
export function tintOf(c: CompiledLevel, i: number): number {
  const role = c.meta.role[i];
  if (role === 1) return tintWordOf(TINT.crown, CROWN_GLOW);
  if (role === 2) return tintWordOf(TINT.heritage);
  return tintWordOf(MATERIAL_TINT[MATERIALS[c.meta.material[i]!]!.name] ?? TINT.none);
}

/** One tint word per structure slot, for one bulk setFx at level load. */
export function structureTints(c: CompiledLevel): Uint32Array {
  return Uint32Array.from({ length: c.meta.n }, (_, i) => tintOf(c, i));
}

export const REGROW_STAGGER = 0.035; // s per course
export const REGROW_GROW = 0.3; // s per body

/** Ease-out cubic: 0 at x = 0, 1 at x = 1, never above 1 (the renderer clamps visual scale to [0, 1]). */
export function easeOut(x: number): number {
  const u = 1 - Math.min(1, Math.max(0, x));
  return 1 - u * u * u;
}

/** Scale of a body on course `course`, `t` seconds into Regrow. */
export function regrowScale(t: number, course: number): number {
  return easeOut((t - course * REGROW_STAGGER) / REGROW_GROW);
}
export const regrowDuration = (courses: number) => Math.max(0, courses - 1) * REGROW_STAGGER + REGROW_GROW;

/** Per-structure-slot scales `t` seconds into Regrow (anchored at each body's base by the renderer). */
export function regrowScales(c: CompiledLevel, t: number, out: Float32Array<ArrayBuffer> = new Float32Array(c.meta.n)): Float32Array<ArrayBuffer> {
  const h = c.frame.unit;
  for (let i = 0; i < c.meta.n; i++) out[i] = regrowScale(t, Math.floor(c.meta.home[3 * i + 1]! / h));
  return out;
}

export const BEAD_RADIUS = 0.06;
export const TARGET_SCALE = 1.8;
/** sRGB 0..255 channels and emissive 0..1 to an overlay colour word: r in the low byte, emissive in the high byte. */
export const rgbe = (r: number, g: number, b: number, e: number) => (r | (g << 8) | (b << 16) | (Math.round(e * 255) << 24)) >>> 0;
export const BEAD_COLOUR = rgbe(255, 122, 90, 0.38); // coral, glowing
export const BEAD_OUT_COLOUR = rgbe(154, 163, 184, 0.06); // grey: out of reach

/**
 * Overlay spheres for an arc preview: beads shrink along the arc so its
 * direction reads at a glance, and the last one marks the aim point.
 */
export function beadOverlay(beads: Float64Array, reachable: boolean): { xyzr: Float32Array<ArrayBuffer>; colours: Uint32Array<ArrayBuffer> } {
  const n = beads.length / 3, xyzr = new Float32Array(4 * n);
  for (let k = 0; k < n; k++) {
    xyzr[4 * k] = beads[3 * k]!; xyzr[4 * k + 1] = beads[3 * k + 1]!; xyzr[4 * k + 2] = beads[3 * k + 2]!;
    xyzr[4 * k + 3] = k === n - 1 ? BEAD_RADIUS * TARGET_SCALE : BEAD_RADIUS * (1 - (0.5 * k) / Math.max(1, n));
  }
  return { xyzr, colours: new Uint32Array(n).fill(reachable ? BEAD_COLOUR : BEAD_OUT_COLOUR) };
}
