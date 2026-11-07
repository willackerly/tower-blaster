// How the game decorates the renderer's bodies (@tb/render draws them
// straight from the snapshot): per-slot tints by role and material, the
// crown glow, the Regrow animation on retry as per-slot visual scales, and
// arc-preview beads as overlay spheres. Everything here is pure data for
// Renderer.setFx / setOverlay; none of it reaches the physics.
import { type CompiledLevel, itemRef, type LevelDef, MATERIALS, type RackItem, weaponOf } from '@tb/keystone';
import { COAT_GILT, COAT_GLAZE, COAT_NONE, COAT_PAINT, type CoatId, type EffectStyle, type FxOptions, MARK_HIT, MARK_KEEP, MARK_NONE, MARK_SAVE, type MarkId, srgbToLinear } from '@tb/render';
import { isWeaponSpec, type MunitionSpec, PROJECTILE_PRESETS } from '@tb/weapons';
import type { XrayMode } from './options/xray.ts';

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
/**
 * What the player built (a part placed in a build phase: PiecePart/RunPart/BallPart.placed), sRGB: a clear blue, its
 * own colour in every look (coats.ts COAT_PAINT), so the contraption reads as yours against the level's own parts
 * (PT26). Picked in OKLCh away from the other colours a build shows: hue 262 against the gilt bell's 79, heritage's
 * glaze 176, the ghost's green (about 142), the Go button's orange (about 45) and the aim beads' coral 35.
 */
export const BUILT_SRGB = 0x4a86e8;
/** BUILT_SRGB, linear (a tint: with coats on the colour itself, without a multiple of the look's). */
export const BUILT_TINT = [(BUILT_SRGB >> 16) & 255, (BUILT_SRGB >> 8) & 255, BUILT_SRGB & 255].map((x) => srgbToLinear(x / 255)) as [number, number, number];
/** The block a selected pull would take (play.ts setHover): warm white, glowing, so it reads on any material. */
export const PULL_HOVER = tintWordOf([1, 0.93, 0.8], 0.55);
/**
 * A weapon's shell: painted near-black satin iron (the look's warm ball glow would make it read as one
 * more ball), with a lit fuse the renderer draws on top (Renderer.fuse). Linear rgb.
 */
export const BOMB_FX = { tint: [0.012, 0.012, 0.015] as [number, number, number], paint: true, matte: true };

/**
 * How fired balls are drawn (PaceFeel.balls, URL key keystone.balls):
 * - painted: each in its own colour with a white band round it (ballFx), so a ball never reads as a
 *   bomb (near-black with a lit fuse) and its spin shows. The default since Will's 2026-11-06 playtest,
 *   where the big balls (the look's grey iron in the real look) looked like the bombs.
 * - plain: the look's own ball colour and glow, as before.
 */
export type BallStyle = 'painted' | 'plain';
export const BALL_STYLES: readonly BallStyle[] = ['painted', 'plain'];

/**
 * Keystone's own balls' paint, sRGB: a crimson cannonball and a blue marble, nothing near black or the crowns' gold.
 * Crimson rather than a warmer red, which read close to the coral aim beads and washed to pink in candy (review, 2026-11-06).
 */
export const BALL_PAINT = { cannonball: 0xc8102e, marble: 0x2e6fd6 } as const;

const linearOf = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((x) => srgbToLinear(x / 255)) as [number, number, number];

/**
 * The paint of a fired ball of rack item `item` in style `style`: its colour (Keystone's ammo from
 * BALL_PAINT, a preset its catalogue colour, PROJECTILE_PRESETS) with a white band. Null for what is
 * not a painted ball: a weapon's shell (a bomb, BOMB_FX), the anvil and the cue (boxes), a pull, and
 * every item in the plain style.
 */
export function ballFx(item: RackItem, style: BallStyle = 'painted'): FxOptions | null {
  if (style === 'plain') return null;
  const r = itemRef(item);
  if (r?.kind === 'preset') return { tint: linearOf(PROJECTILE_PRESETS[r.preset].colour), paint: true, band: true };
  if (r?.kind === 'ammo' && (r.ammo === 'cannonball' || r.ammo === 'marble')) return { tint: linearOf(BALL_PAINT[r.ammo]), paint: true, band: true };
  return null;
}

/**
 * A ram's paint, sRGB: weathered bronze, the colour of a battering ram's head, far from the bombs' near-black
 * iron, the crowns' gold, the crimson cannonball and the blue marble. Banded as a ball is: a ram is a heavy
 * ball that never goes off (PT19, the agent playtest of 2026-11-06: rams drawn as bombs read as duds).
 */
export const RAM_PAINT = 0x8c5a2b;

/** Whether munition spec m ever acts: blasts, splits or removes itself (or a child that does). */
function acts(m: MunitionSpec): boolean {
  return m.rules.some((r) => r.do.length > 0) || Object.values(m.children ?? {}).some(acts);
}

/**
 * A rack item's kind of fired body, by what it does: 'bomb' for a weapon that goes off (a rule that blasts,
 * splits or removes it: a lit fuse and BOMB_FX), 'ram' for a weapon that never does (rules: [], a heavy
 * shell such as big-levels.ts RAM), 'ball' for the rest (marbles, cannonballs, presets, the anvil...). A
 * level's own grenades always go off.
 */
export function firedKind(def: Pick<LevelDef, 'weapons'>, item: RackItem): 'bomb' | 'ram' | 'ball' {
  const r = itemRef(item);
  if (r?.kind !== 'weapon') return 'ball';
  const w = weaponOf(def, r.key);
  return w && isWeaponSpec(w) && !acts(w) ? 'ram' : 'bomb';
}

/** A fired ram's paint (painted style; null in plain, which draws it as a bomb as before PT19). */
export function ramFx(style: BallStyle = 'painted'): FxOptions | null {
  return style === 'plain' ? null : { tint: linearOf(RAM_PAINT), paint: true, band: true };
}

/** Spent ammo's grey (linear): a dull stone, darker than the blocks, so it reads as rubble and not as a live ball. */
export const SPENT_GREY: [number, number, number] = [0.16, 0.16, 0.17];
/** How far spent ammo goes toward SPENT_GREY (1: all the way), and how long the fade takes, s. */
export const SPENT_MIX = 0.75;
export const SPENT_FADE = 0.6;

/**
 * Spent ammo's look `t` of the way into its fade (0 live, 1 spent; PaceFeel.spent): its paint (or the plain
 * look's, taken as white) mixed toward SPENT_GREY, matte (no clear coat or glow), its band kept so it still
 * reads as a fired ball, not a block.
 */
export function spentFx(fx: FxOptions | null, t: number): FxOptions {
  const k = SPENT_MIX * Math.min(1, Math.max(0, t)), from = fx?.paint ? fx.tint ?? [1, 1, 1] : [1, 1, 1];
  return { tint: from.map((x, i) => x + (SPENT_GREY[i]! - x) * k) as [number, number, number], paint: true, matte: t > 0, band: fx?.band ?? false };
}
// (The game fades only painted balls and rams: play.ts spendFired. A null fx fades from white, for tools.)

/**
 * How the game paints the structure's role events under effect style `style` (PaceFeel.fx): the flash of a felled
 * crown and of cracked heritage, and the glow each keeps after (also when an undo or a line restores them). In
 * 'damage' (PT2) a cracked heritage block flashes teal and stays its teal, and a felled crown stays gold without
 * a glow, as play leaves them; 'classic' flashes them to white (emissive 1, 16x the albedo) and an undo restored
 * them glowing (crown 0.9, heritage 1), unlike play.
 */
export function rolePaint(style: EffectStyle) {
  return style === 'damage'
    ? { crownFlash: { tint: TINT.crown, emissive: 0.9, flash: 0.5 }, heritageFlash: { tint: TINT.heritage, emissive: 0.2, flash: 0.8 }, crownKept: { tint: TINT.crown }, heritageKept: { tint: TINT.heritage } }
    : { crownFlash: { tint: TINT.crown, emissive: 0.9, flash: 0.5 }, heritageFlash: { tint: TINT.heritage, emissive: 1, flash: 0.8 }, crownKept: { tint: TINT.crown, emissive: 0.9 }, heritageKept: { tint: TINT.heritage, emissive: 1 } };
}

// Ice is drawn by the renderer's ice pass (@tb/render ice.ts), which makes its own blue from the light's
// path through the block (absorption): a tint here would multiply it a second time, so ice is untinted.
const MATERIAL_TINT: Record<string, [number, number, number]> = {
  plaster: TINT.none, stone: [0.62, 0.62, 0.66], iron: [0.3, 0.3, 0.34], ice: TINT.none, rubber: [0.9, 0.45, 0.55], steel: [0.4, 0.42, 0.46],
};

const isIce = (c: CompiledLevel, i: number) => MATERIALS[c.meta.material[i]!]!.name === 'ice';
/** Body i belongs to a part the player placed in a build phase (BuildSession: PiecePart/RunPart/BallPart.placed). */
export const isBuilt = (c: CompiledLevel, i: number): boolean => {
  const p = c.def.parts[c.meta.part[i]!];
  return !!p && 'placed' in p && p.placed === true;
};

/**
 * The coat of structure body i (@tb/render coats.ts; PaceFeel.coats): crowns gilded and heritage glazed, their
 * own colour in every look (PT15: multiplying candy's rainbow turned crowns salmon, the aim beads' colour, and
 * heritage violet). Ice is drawn by its own pass, which takes no coat: an ice crown keeps the gold tint.
 */
export function coatOf(c: CompiledLevel, i: number): CoatId {
  if (isIce(c, i)) return COAT_NONE;
  const role = c.meta.role[i];
  return role === 1 ? COAT_GILT : role === 2 ? COAT_GLAZE : isBuilt(c, i) ? COAT_PAINT : COAT_NONE;
}

/** One coat per structure slot (coatOf), or none at all when `on` is false, for one Renderer.setCoats at level load. */
export function structureCoats(c: CompiledLevel, on = true): Uint8Array {
  return on ? Uint8Array.from({ length: c.meta.n }, (_, i) => coatOf(c, i)) : new Uint8Array(c.meta.n);
}

/**
 * The role tint of structure body i (multiplies what it is drawn in): with coats on, a coated block's colour
 * is its coat and the tint is none; without (or on ice), crowns gold and heritage celadon, as before PT15.
 */
export function roleTint(c: CompiledLevel, i: number, coats = true): [number, number, number] {
  const role = c.meta.role[i];
  // A built part's colour is its tint (painted with coats on; a multiple of the look's without).
  if (role !== 1 && role !== 2) return isBuilt(c, i) && !isIce(c, i) ? BUILT_TINT : TINT.none;
  if (coats && coatOf(c, i) !== COAT_NONE) return TINT.none;
  return role === 1 ? TINT.crown : TINT.heritage;
}

/** Role wins over material: crowns are gold and heritage is celadon whatever they are made of (by their coat, with coats on). Crowns also glow a little. */
export function tintOf(c: CompiledLevel, i: number, coats = true): number {
  const role = c.meta.role[i];
  if (role === 1) return tintWordOf(roleTint(c, i, coats), CROWN_GLOW);
  if (role === 2) return tintWordOf(roleTint(c, i, coats));
  if (isBuilt(c, i) && !isIce(c, i)) return tintWordOf(BUILT_TINT);
  return tintWordOf(MATERIAL_TINT[MATERIALS[c.meta.material[i]!]!.name] ?? TINT.none);
}

/**
 * The glyph carved on structure body i (Renderer.setMarks; PaceFeel.marks): a crosshair (hit) on a crown, which
 * the level asks the player to bring down, a shield (save) on heritage, which must stay intact, and a crown
 * (keep) on a crown under a hold objective (Undercut's Hollow), which must stay up: there the crown's gold says
 * nothing of which way it goes, and the carving does, in a glyph of its own (playtest PT17: the shield it carried
 * before read as heritage). Plain blocks carry none.
 */
export function markOf(c: CompiledLevel, i: number): MarkId {
  const role = c.meta.role[i];
  if (role === 1) return c.def.objective.kind === 'hold' ? MARK_KEEP : MARK_HIT;
  if (role === 2) return MARK_SAVE;
  return MARK_NONE;
}

/** One mark per structure slot (markOf), or none at all when `on` is false, for one Renderer.setMarks at level load. */
export function structureMarks(c: CompiledLevel, on = true): Uint8Array {
  return on ? Uint8Array.from({ length: c.meta.n }, (_, i) => markOf(c, i)) : new Uint8Array(c.meta.n);
}

/** A level is city-scale from this many structure bodies (B1 to B3 and their trials): where 'auto' shows the x-ray. */
export const CITY_BODIES = 1000;

/** Whether the objectives show through what hides them on level c under mode (PaceFeel.xray): auto on city-scale levels with crowns or heritage. */
export function xrayOn(c: CompiledLevel, mode: XrayMode): boolean {
  if (mode === 'off') return false;
  let objectives = false;
  for (let i = 0; i < c.meta.n && !objectives; i++) objectives = markOf(c, i) !== 0;
  return objectives && (mode === 'on' || c.meta.n >= CITY_BODIES);
}

/** One tint word per structure slot, for one bulk setFx at level load (coats as PaceFeel.coats says). */
export function structureTints(c: CompiledLevel, coats = true): Uint32Array {
  return Uint32Array.from({ length: c.meta.n }, (_, i) => tintOf(c, i, coats));
}

/**
 * A duel's neutral blocks (owned by neither side: D1's wall), sRGB: a plain mid grey, neither ink in any look. Painted
 * (COAT_PAINT) it is its own colour; left to the look, hazy's blue-grey plaster read as Blue's and candy's yellow as
 * Gold's (the Siege Table look review, 2026-11-06; docs/render/look-colours.md §6).
 */
export const DUEL_NEUTRAL: [number, number, number] = [0x9e, 0x9a, 0x94].map((x) => srgbToLinear(x / 255)) as [number, number, number];

/** Each structure block's linear tint in a duel: its side's ink, or DUEL_NEUTRAL; with paint off, neutral blocks keep their role/material tint. */
export function duelTint(c: CompiledLevel, owned: readonly (Int32Array | readonly number[])[], inks: readonly (readonly number[])[], i: number, paint = true): [number, number, number] {
  const k = owned.findIndex((g) => g.includes(i));
  if (k >= 0) return [...inks[k]!] as [number, number, number];
  return paint && !isIce(c, i) ? DUEL_NEUTRAL : roleTint(c, i, false);
}

/** A duel's structure tints for one Renderer.setFx at load (duelTint; kings glow a little as crowns do). */
export function duelTints(c: CompiledLevel, owned: readonly (Int32Array | readonly number[])[], inks: readonly (readonly number[])[], paint = true): Uint32Array {
  const t = structureTints(c, false);
  for (let i = 0; i < c.meta.n; i++) {
    const own = owned.some((g) => g.includes(i));
    if (own || (paint && !isIce(c, i))) t[i] = tintWordOf(duelTint(c, owned, inks, i, paint), c.meta.role[i] === 1 ? CROWN_GLOW : 0);
  }
  return t;
}

/**
 * A duel's coats: every block but ice painted (COAT_PAINT), so each side's ink and the neutral grey are their own
 * colours in every look rather than multiples of its palette (candy turned Gold's ink green). None with `paint` off
 * (PaceFeel.coats false: the inks multiply the look's colours, as before).
 */
export function duelCoats(c: CompiledLevel, paint = true): Uint8Array {
  return Uint8Array.from({ length: c.meta.n }, (_, i) => (paint && !isIce(c, i) ? COAT_PAINT : COAT_NONE));
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
