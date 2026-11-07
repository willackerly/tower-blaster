// Per-slot visual effects the game sets on bodies: tint, glow, a fading
// flash, and a visual scale (Regrow). Four u32 per slot, encoded so that an
// all-zero record (a fresh buffer, or clearFx) means "no effect":
//
//   word 0  bits 0-23   255 - tint (r, g, b), 8 bits each; bits 24-31 emissive
//   word 1  bits 0-15   f16(1 - scale); bit 16 anchor the scale at the base;
//           bit 17 paint: on a sphere, the tint is its colour rather than a multiple of the look's
//           bit 18 matte: on a sphere, a satin finish with no clear coat and no ball glow (a bomb's iron)
//           bit 19 band: on a sphere, a white band round its body-space equator (a fired ball, so it reads as
//           a ball and never as a bomb, and its spin shows)
//           bits 20-21 mark: on a box, an engraved glyph (marks.ts: 1 hit, 2 save, 3 keep); kept by setFx until clearFx
//           bits 22-23 coat: on a box, its own colour instead of the look's (coats.ts: 1 gilt, 2 glaze, 3 paint: the tint is its colour); kept likewise
//           bits 24-25 xray: on a box, an objective drawn through what hides it while Renderer.xray is on (1 crown,
//           2 heritage, 3 a crown to hold: drawn as heritage); kept likewise
//   word 2  f32 flash start (frame time, seconds)
//   word 3  f32 flash duration (seconds); 0 = emissive is steady
//
// The cull pass applies the scale (so culling and shadows see it, and
// scale 0 hides the body); the scene pass applies tint and emissive.
import type { V3 } from './math.ts';
import { COAT_MASK, COAT_SHIFT, type CoatId } from './coats.ts';
import { MARK_MASK, MARK_SHIFT, type MarkId } from './marks.ts';

export const FX_WORDS = 4;
/** HDR multiple of the albedo at emissive 1 (blooms well above 1). */
export const FX_EMISSIVE_MAX = 16;
export const FX_ANCHOR = 1 << 16;
export const FX_PAINT = 1 << 17;
export const FX_MATTE = 1 << 18;
export const FX_BAND = 1 << 19;
/** The x-ray kind's bits in fx word 1 (Renderer.setXray, shaders.ts fsXray): 1 crown, 2 heritage. */
export const XRAY_SHIFT = 24;
export const XRAY_MASK = 3 << XRAY_SHIFT;
/** Bits of fx word 1 that a bulk setFx keeps (the engraved mark, the coat and the x-ray kind): set by their own calls, cleared by clearFx. */
export const FX_KEEP = MARK_MASK | COAT_MASK | XRAY_MASK;
/** The x-ray's colours, linear, times the look's sun luminance: crown gold and heritage teal, the same in every look (PT15). */
export const XRAY_HIT: readonly number[] = [1.0, 0.6, 0.06];
export const XRAY_SAVE: readonly number[] = [0.04, 0.7, 0.66];
/** The x-ray's opacity: a faint fill, and this much more along a face's edges. */
export const XRAY_FILL = 0.14;
export const XRAY_EDGE = 0.66;
/** The band's half-height on a unit sphere (|y| below it, in body space): a band of 30% of the diameter. */
export const BAND_HALF = 0.3;

export interface FxOptions {
  /** Multiplies the albedo, linear 0..1 per channel; [1, 1, 1] is none. */
  tint?: V3;
  /** Glow, 0..1 (to FX_EMISSIVE_MAX x albedo in HDR). */
  emissive?: number;
  /** Visual scale, 0 hides the body; 1 is none. */
  scale?: number;
  /** Grow from the body's base (-y in body space) instead of its centre. */
  anchor?: boolean;
  /** Spheres: the tint is the colour (a fired object's own), not a multiple of the look's ball or albedo. */
  paint?: boolean;
  /** Spheres: a satin finish without the clear coat or the look's ball glow, so a dark shell stays dark (a bomb's iron). */
  matte?: boolean;
  /** Spheres: a white band round the body-space equator, which turns with the ball (a fired ball's stripe). */
  band?: boolean;
  /**
   * Boxes: an engraved glyph (marks.ts MARK_HIT, MARK_SAVE, MARK_KEEP; MARK_NONE clears it). Absent, Renderer.setFx keeps
   * the slot's mark as it was (Renderer.setMarks sets marks in bulk).
   */
  mark?: MarkId;
  /**
   * Boxes: a coat, the block's own colour in every look (coats.ts COAT_GILT, COAT_GLAZE, COAT_PAINT; COAT_NONE clears it).
   * Absent, Renderer.setFx keeps the slot's coat as it was (Renderer.setCoats sets coats in bulk).
   */
  coat?: CoatId;
  /** Fade the emissive out over this many seconds from `flashAt`. */
  flash?: number;
  /** Flash start, frame time in seconds (default: the last rendered frame). */
  flashAt?: number;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = (x: number) => { f32[0] = x; return u32[0]!; };
const float = (b: number) => { u32[0] = b; return f32[0]!; };
const byte = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);

/** IEEE half from a float (round to nearest, no NaN handling; inputs are 0..1). */
export function toHalf(x: number): number {
  const u = bits(x);
  const sign = (u >>> 16) & 0x8000, e = ((u >>> 23) & 0xff) - 112, m = u & 0x7fffff;
  if (e <= 0) return sign | Math.round((m | 0x800000) / 2 ** (14 - e));
  if (e >= 31) return sign | 0x7c00;
  const h = sign | (e << 10) | (m >>> 13);
  return h + ((m >>> 12) & 1); // round half up on the dropped bits
}

export function fromHalf(h: number): number {
  const e = (h >>> 10) & 0x1f, m = h & 0x3ff, s = h & 0x8000 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Pack options into the four words at out[o..o+3]. */
export function packFx(fx: FxOptions, out: Uint32Array, o = 0, now = 0): void {
  const t = fx.tint ?? [1, 1, 1];
  out[o] = ((255 - byte(t[0])) | ((255 - byte(t[1])) << 8) | ((255 - byte(t[2])) << 16) | (byte(fx.emissive ?? 0) << 24)) >>> 0;
  out[o + 1] = (toHalf(1 - Math.min(1, Math.max(0, fx.scale ?? 1))) | (fx.anchor ? FX_ANCHOR : 0) | (fx.paint ? FX_PAINT : 0) | (fx.matte ? FX_MATTE : 0) | (fx.band ? FX_BAND : 0) | (((fx.mark ?? 0) & 3) << MARK_SHIFT) | (((fx.coat ?? 0) & 3) << COAT_SHIFT)) >>> 0;
  out[o + 2] = fx.flash ? bits(fx.flashAt ?? now) : 0;
  out[o + 3] = fx.flash ? bits(fx.flash) : 0;
}

export interface Fx { tint: V3; emissive: number; scale: number; anchor: boolean; paint: boolean; matte: boolean; band: boolean; mark: MarkId; coat: CoatId; xray: number; flashAt: number; flash: number }

export function unpackFx(w: Uint32Array, o = 0): Fx {
  const w0 = w[o]!, w1 = w[o + 1]!;
  return {
    tint: [0, 8, 16].map((s) => (255 - ((w0 >>> s) & 0xff)) / 255) as V3,
    emissive: (w0 >>> 24) / 255,
    scale: 1 - fromHalf(w1 & 0xffff),
    anchor: (w1 & FX_ANCHOR) !== 0,
    paint: (w1 & FX_PAINT) !== 0,
    matte: (w1 & FX_MATTE) !== 0,
    band: (w1 & FX_BAND) !== 0,
    mark: ((w1 & MARK_MASK) >>> MARK_SHIFT) as MarkId,
    coat: ((w1 & COAT_MASK) >>> COAT_SHIFT) as CoatId,
    xray: (w1 & XRAY_MASK) >>> XRAY_SHIFT,
    flashAt: float(w[o + 2]!),
    flash: float(w[o + 3]!),
  };
}

/** Game-facing bulk tint: rgb8 + emissive8 (r in the low byte, emissive in the high byte) to word 0. */
export function tintWord(rgbe: number): number {
  return ((~rgbe & 0xffffff) | (rgbe & 0xff000000)) >>> 0;
}

/** WGSL: decode a slot's record (scale side for the cull pass, colour side for the scene pass). */
export const FX_WGSL = /* wgsl */ `
struct FxScale { scale: f32, anchor: bool }
fn fxScale(w1: u32) -> FxScale {
  return FxScale(1.0 - unpack2x16float(w1).x, (w1 & ${FX_ANCHOR}u) != 0u);
}
fn fxTint(w0: u32) -> vec3f {
  return 1.0 - unpack4x8unorm(w0).rgb;
}
// Emissive multiple of the albedo at frame time t.
fn fxGlow(w: vec4u, t: f32) -> f32 {
  let e = f32(w.x >> 24u) / 255.0 * ${FX_EMISSIVE_MAX}.0;
  let dur = bitcast<f32>(w.w);
  let fade = select(1.0, clamp(1.0 - (t - bitcast<f32>(w.z)) / max(dur, 1e-6), 0.0, 1.0), dur > 0.0);
  return e * fade;
}
`;
