// What a body is made of, as far as drawing it goes: one u32 per slot that
// the game sets (Renderer.setSurface) and that stays until it is set again,
// unlike the fx record (fx.ts), which holds passing effects and is rewritten
// whole by every setFx. An all-zero word (a fresh buffer) is the default
// surface: the look's own block or ball.
//
//   bits 0-3    kind: 0 the look's own, 1 ice (ice.ts: its own draw list and pass)
//   bits 4-6    crack level, 0 (whole) to 7 (about to shatter)
//   bits 7-15   where the crack started, 3 bits per body axis: the point
//               (2 k / 7 - 1) * half, k = 0..7, so the corners and the centre
//               of each face are on the grid
//   bits 16-31  crack seed: a new seed is a new crack pattern from the same point
//
// The cull pass reads the kind (an ice box goes to SEG.boxIce, not SEG.box);
// the ice shader reads the crack.
import type { V3 } from './math.ts';

export const SURFACE_KINDS = ['default', 'ice'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];
export const SURFACE_ICE = 1;
/** Highest crack level (bits 4-6). */
export const CRACK_MAX = 7;

export interface SurfaceOptions {
  kind?: SurfaceKind;
  /** Crack level, 0 (none) to CRACK_MAX; rounded and clamped. */
  crack?: number;
  /** Where the crack started, body-normalized: each axis -1..1 (times the half extent); snapped to the 8-step grid. Default the body's centre. */
  at?: V3;
  /** Crack pattern seed, 0..65535 (default 0: the slot's own pattern). */
  seed?: number;
}

export interface Surface { kind: SurfaceKind; crack: number; at: V3; seed: number }

const clampInt = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(x)));
const cell = (x: number) => clampInt(((x + 1) / 2) * 7, 0, 7);

export function packSurface(s: SurfaceOptions): number {
  const kind = SURFACE_KINDS.indexOf(s.kind ?? 'default');
  if (kind < 0) throw new Error(`surface kind must be one of ${SURFACE_KINDS.join(', ')}: ${s.kind}`);
  const at = s.at ?? [0, 0, 0];
  // The centre is not on the 8-step grid (k = 3.5): it rounds to k = 4, a seventh of the half extent off.
  return (kind | (clampInt(s.crack ?? 0, 0, CRACK_MAX) << 4) | (cell(at[0]) << 7) | (cell(at[1]) << 10) | (cell(at[2]) << 13) | (clampInt(s.seed ?? 0, 0, 0xffff) << 16)) >>> 0;
}

export function unpackSurface(w: number): Surface {
  const k = (s: number) => ((w >>> s) & 7) * (2 / 7) - 1;
  return { kind: SURFACE_KINDS[w & 0xf] ?? 'default', crack: (w >>> 4) & 7, at: [k(7), k(10), k(13)], seed: w >>> 16 };
}

/** WGSL: decode a surface word. */
export const SURFACE_WGSL = /* wgsl */ `
fn surfaceKind(w: u32) -> u32 { return w & 0xfu; }
fn surfaceCrack(w: u32) -> u32 { return (w >> 4u) & 7u; }
// Crack origin, body-normalized (-1..1 per axis).
fn surfaceAt(w: u32) -> vec3f {
  return vec3f(f32((w >> 7u) & 7u), f32((w >> 10u) & 7u), f32((w >> 13u) & 7u)) * (2.0 / 7.0) - 1.0;
}
fn surfaceSeed(w: u32) -> u32 { return w >> 16u; }
`;
