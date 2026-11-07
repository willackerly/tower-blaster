// Coats: a block finished in a colour of its own instead of its look's palette (PT15, agent playtest 1).
// A level's crowns are gilded and its heritage glazed, in every look: until now the game multiplied the
// look's colour by a role tint, and on candy's rainbow that turned a crown salmon (the aim beads' colour)
// and heritage violet. A coat replaces the palette colour, so its hue is the same whatever the look.
//
// The coat is two bits of a slot's fx record (fx.ts word 1, bits 22-23), set with Renderer.setCoats and
// kept through every other setFx until clearFx, as a mark is (marks.ts). Boxes only. The scene pass
// takes COAT_LINEAR[coat] as the block's base colour; the look's lighting, the stone's detail (real look),
// the carving and the role tint and glow then apply as to any block, so a felled crown still flashes.
//
// Colours, sRGB, picked in OKLCh against the HUD's own (ui.ts) and the aim beads (scene.ts BEAD_COLOUR):
//   gilt   #E3A62F  L 0.76  C 0.145  hue 79   (the HUD's crown gold #F7B955 is hue 77)
//   glaze  #2FA28A  L 0.64  C 0.107  hue 176  (the HUD's heritage #8FD3B6 is hue 166)
//   beads  #FF7A5A                    hue 35   (44 degrees from the gilt)
//
// COAT_PAINT: the block's colour is its own fx tint (word 0), not a multiple of the look's: a duel paints each
// side's blocks in its ink and the neutral wall a plain grey this way, so the inks read the same in every look
// (candy's rainbow had turned Gold's ink green, and hazy's blue-grey plaster read as Blue; docs/render/look-colours.md §6).
import { srgbToLinear } from './look.ts';
import type { V3 } from './math.ts';

export const COAT_NONE = 0;
export const COAT_GILT = 1;
export const COAT_GLAZE = 2;
/** The block's own fx tint is its colour (white base: the tint gives it), in every look. */
export const COAT_PAINT = 3;
export type CoatId = typeof COAT_NONE | typeof COAT_GILT | typeof COAT_GLAZE | typeof COAT_PAINT;
export const COAT_NAMES: Record<CoatId, string> = { 0: 'none', 1: 'gilt', 2: 'glaze', 3: 'paint' };

/** The coat's bits in fx word 1 (fx.ts). */
export const COAT_SHIFT = 22;
export const COAT_MASK = 3 << COAT_SHIFT;

/** Each coat's colour, sRGB (paint: white, so the fx tint is the colour). */
export const COAT_SRGB: Record<Exclude<CoatId, 0>, number> = { 1: 0xe3a62f, 2: 0x2fa28a, 3: 0xffffff };

const linear = (hex: number): V3 => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((x) => srgbToLinear(x / 255)) as V3;
/** Each coat's colour, linear (index 0 unused). */
export const COAT_LINEAR: readonly V3[] = [[1, 1, 1], linear(COAT_SRGB[1]), linear(COAT_SRGB[2]), [1, 1, 1]];

const f = (x: number) => x.toFixed(6);
const vec = (c: V3) => `vec3f(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;

/** WGSL: coatOf(w1) and coatAlbedo(coat). */
export const COAT_WGSL = /* wgsl */ `
fn coatOf(w1: u32) -> u32 { return (w1 >> ${COAT_SHIFT}u) & 3u; }
fn coatAlbedo(coat: u32) -> vec3f { return select(select(${vec(COAT_LINEAR[2]!)}, ${vec(COAT_LINEAR[1]!)}, coat == ${COAT_GILT}u), vec3f(1.0), coat == ${COAT_PAINT}u); }
`;
