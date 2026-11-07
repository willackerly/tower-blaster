// The game's opening camera for a level (no WebGPU or WebAudio here, so node CLIs can use it).
// Two choices (docs/game/opening-view.md): which way to look (openingDirection: the lowest, least turned view
// that shows the level's objectives and keeps its bodies apart), then how far and where (fitBox: the whole
// structure inside the screen's free area, an exact fit for that direction).
import type { Vec3 } from '@tb/engine-api';
import type { CompiledLevel } from '@tb/keystone';
import { DEFAULT_FRAMING, EYE_ABOVE_GROUND, eyeDistance, frame, type Framing, type Orbit, viewProj } from '@tb/render/camera';
import type { OpeningView } from './options/openview.ts';
import { compassArrow } from './fuse-timeline.ts';
import { idRaster, pixelCounts, type ScreenRect, seen } from './sightlines.ts';

/** The share of an upright phone's screen height the HUD takes at the top (the compact touch HUD with its opener and lot sheet line: about 300 of 844 px, plus a margin). */
export const PORTRAIT_HUD_SHARE = 0.4;
/**
 * The share of an upright phone's height the fuse panel may take at the bottom (fuse-panel.ts: max-height, a level with
 * charges, Fuse & Fold; 0.45 before PT21 folded its rows): such a level's opening view keeps clear of it (openingInsets),
 * or the panel hides the lot. On a docked phone HUD the panel's measured box joins the band instead (play.ts dockedHud).
 */
export const FUSE_PANEL_SHARE = 0.35;

/** The fuse panel's width on a wide screen with its margins, px (fuse-panel.ts: 300 px wide, 12 px from the right; 8 px to spare). */
export const FUSE_PANEL_PX = 320;

/**
 * The insets a level's own panels add to defaultInsets, as fitBox counts them: upright, the fuse panel's band when the
 * level shows it; wide (PT24: F1's yard opened under the panel), its column down the right side of a `screenW` px
 * screen, as the part of the framed middle square it covers (fitShares).
 */
export function openingInsets(aspect: number, fusePanel: boolean, screenW = 1280): Partial<Insets> | undefined {
  if (!fusePanel) return undefined;
  if (aspect < 1) return { bottom: FUSE_PANEL_SHARE };
  return { right: fitShares({ ...NO_INSETS, right: Math.min(0.5, FUSE_PANEL_PX / screenW) }, aspect).right };
}

/** Free sky kept over the structure on a wide screen, a share of the height (PT14: T-S1's top ran to the screen's edge). */
export const TOP_MARGIN = 0.1;

/** Screen shares (0..1 of the height for top and bottom, of the width for left and right) the framed structure keeps clear of. */
export interface Insets { top: number; bottom: number; left: number; right: number }
export const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * What every opening view keeps clear of: on a wide screen the top margin, upright the HUD's band at the top
 * (PORTRAIT_HUD_SHARE, a guess sized for the old tall panel). With `hud`, the docked phone HUD's band as measured
 * (docs/game/phone-hud.md, PT3b; play.ts dockedHud): that band over the top margin, in place of the guess.
 */
export function defaultInsets(aspect: number, hud?: Insets): Insets {
  return hud ? joinInsets({ ...NO_INSETS, top: TOP_MARGIN }, fitShares(hud, aspect)) : { ...NO_INSETS, top: aspect < 1 ? PORTRAIT_HUD_SHARE : TOP_MARGIN };
}

/**
 * Screen shares as fitBox counts them: upright (aspect < 1) as they are; wide, fitBox frames the middle square of
 * the screen (so every wide window opens on the same view), and a side's share of the whole width becomes the part
 * of that square it covers: a rail to L of an aspect-A screen ends at x = -A (1 - 2L) in the square's units, which
 * reach from -1 to 1, so it takes max(0, (1 - A (1 - 2L)) / 2) of it (844 x 390, a rail to 0.28: 0.025).
 */
export function fitShares(s: Insets, aspect: number): Insets {
  if (aspect < 1) return { ...s };
  const side = (l: number) => Math.max(0, (1 - aspect * (1 - 2 * l)) / 2);
  return { top: s.top, bottom: s.bottom, left: side(s.left), right: side(s.right) };
}

/**
 * Which HUD the search masks (hudRects): the game page's floating panel (wide, its top-left box; upright, the top
 * band), or the docked phone HUD, all of which lies in the insets the fit keeps the structure out of.
 */
export type HudShape = 'panel' | 'docked';

/** Each side the larger of a and b. */
export function joinInsets(a: Insets, b?: Partial<Insets>): Insets {
  return { top: Math.max(a.top, b?.top ?? 0), bottom: Math.max(a.bottom, b?.bottom ?? 0), left: Math.max(a.left, b?.left ?? 0), right: Math.max(a.right, b?.right ?? 0) };
}

/** The structure's box at home: every body's footprint grown by 1 sideways, from the ground to the level's height. */
export function structureBox(c: CompiledLevel): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  return { min, max };
}

/**
 * What an opening view frames: the structure's box, and on a fold level the lot too (the yard the building is to
 * land in) and the ground compass beside it (fuse-timeline.ts compassArrow), from the ground up (PT24: F1 opened on
 * the tower with its yard off the screen's edge or under the panel).
 */
export function framedBox(c: CompiledLevel): { min: Vec3; max: Vec3 } {
  const { min, max } = structureBox(c);
  if (c.def.objective.kind !== 'fold') return { min, max };
  const a = compassArrow(c), xs = [c.lot.min[0], c.lot.max[0], a.tail[0], a.tip[0]], zs = [c.lot.min[1], c.lot.max[1], a.tail[1], a.tip[1]];
  return { min: [Math.min(min[0], ...xs), 0, Math.min(min[2], ...zs)], max: [Math.max(max[0], ...xs), max[1], Math.max(max[2], ...zs)] };
}

/** A view direction: yaw and pitch in degrees, as Framing has them. */
export type Direction = Pick<Framing, 'yaw' | 'pitch'>;

/** The yaw (degrees) that puts the par line's launcher behind the camera, or the default 3/4 view's. */
export function baseYaw(c: CompiledLevel): number {
  const first = c.def.solutions?.par?.[0];
  return first && 'az' in first ? 90 - first.az / 2 : DEFAULT_FRAMING.yaw;
}

/**
 * How an opening view is made (viewOf): `insets` joined with defaultInsets (a level's own panels: openingInsets);
 * `hud` the docked phone HUD's band as measured, screen shares (layout.ts hudInsets via play.ts dockedHud), in place
 * of the upright guess; `mode` 'classic' (PaceFeel.view, keystone.view) skips the search.
 */
export interface ViewOptions { insets?: Partial<Insets>; hud?: Insets; mode?: OpeningView }

/**
 * The game's opening view of a level: the structure framed whole from openingDirection, clear of the screen's
 * insets (defaultInsets joined with opts.insets). The eye stays EYE_ABOVE_GROUND over the ground (y 0), as in the
 * viewer. A wide screen (aspect 1 and up) frames as a square one would, so every wide window opens on the same view.
 * opts.mode 'classic' skips the search: the base yaw at DEFAULT_FRAMING's pitch.
 * With `face` (degrees, as Framing has them) it is a duel's turn view instead, framed as before PT1 (faceView), where
 * `focus` and `only` apply.
 */
export function viewOf(c: CompiledLevel, aspect = 1, face?: Direction, focus?: Vec3, only?: ArrayLike<number>, opts: ViewOptions = {}): Orbit {
  if (face) return faceView(c, aspect, face, focus, only);
  const { min, max } = framedBox(c);
  const ins = joinInsets(defaultInsets(aspect, opts.hud), opts.insets);
  const dir = opts.mode === 'classic' ? { yaw: baseYaw(c), pitch: DEFAULT_FRAMING.pitch } : openingDirection(c, aspect, ins, opts.hud ? 'docked' : 'panel');
  return { ...fitBox(min, max, dir, aspect, ins), floor: EYE_ABOVE_GROUND };
}

/**
 * A duel's turn view (duel-view.ts duelView) frames as it did before PT1: render's frame() from `face`'s side, and
 * upright a taller box until the structure clears the HUD's band. Its pitch (DUEL_PITCH) was chosen at this distance
 * (duel-view.test.ts: the other keep shows whole over your own), and fitBox's tighter fit stands closer, where
 * perspective lifts your own keep into the view; the Siege Table's thread owns that choice.
 * `focus` puts that point at the screen's centre instead of the structure's middle, as far back as the framed bodies need;
 * `only` frames those structure bodies (all of them when absent; a duel's turn view frames all but the player's own).
 */
function faceView(c: CompiledLevel, aspect: number, face: Direction, focus?: Vec3, only?: ArrayLike<number>): Orbit {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  const all = only ?? { length: c.meta.n };
  for (let j = 0; j < all.length; j++) for (const k of [0, 2] as const) {
    const i = only ? only[j]! : j;
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const at = (top: number): Orbit => ({ ...frame(min, [max[0], top, max[2]], { ...DEFAULT_FRAMING, ...face }, 1, min[1], aspect, focus), floor: EYE_ABOVE_GROUND });
  if (aspect >= 1) return at(c.height);
  // Upright, with a focus, it goes to the middle of the screen below the HUD (PLAY_CENTRE_PORTRAIT), and the eye
  // backs off, 5% a try, until the box clears the HUD; without one, a taller box, taller until it clears.
  if (focus) {
    const base = at(c.height);
    let o = base;
    for (let k = 0; k < 60; k++) {
      o = lowered({ ...base, distance: base.distance * 1.05 ** k }, focus);
      if (clearOfHud(o, aspect, min, max)) break;
    }
    return o;
  }
  let top = c.height / (1 - PORTRAIT_HUD_SHARE), o = at(top);
  for (let k = 0; k < 40 && !clearOfHud(o, aspect, min, max); k++) o = at((top *= 1.05));
  return o;
}

/** Where the middle of what an upright phone shows below the HUD is, in normalised device coordinates: [0, -PORTRAIT_HUD_SHARE]. */
export const PLAY_CENTRE_PORTRAIT: readonly [number, number] = [0, -PORTRAIT_HUD_SHARE];

/**
 * The orbit o raised (its target and so its eye) until `focus`, at o's target, shows at PLAY_CENTRE_PORTRAIT: a point
 * at depth d + D sin(pitch) and D cos(pitch) below the view's middle shows at -s when D = s t d / (cos(pitch) - s t sin(pitch)),
 * t = tan(fovY / 2), s = PORTRAIT_HUD_SHARE.
 */
function lowered(o: Orbit, focus: Vec3): Orbit {
  const s = PORTRAIT_HUD_SHARE, t = Math.tan(o.fovY / 2), d = eyeDistance({ ...o, target: [...focus] });
  const up = (s * t * d) / (Math.cos(o.pitch) - s * t * Math.sin(o.pitch));
  return { ...o, target: [focus[0], focus[1] + up, focus[2]] };
}

/** Margin around the fit: the box fills 1 / FIT of the free area's height or width (DEFAULT_FRAMING.fit, as frame() had it). */
const FIT = DEFAULT_FRAMING.fit;
/** Closest an opening view stands, world units (as frame() had it). */
const MIN_DISTANCE = 8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * The closest orbit looking from `dir` that shows every corner of the box (min, max) inside the free area: the
 * screen less `insets`, shrunk about its middle by 1 / FIT. Exact: for a fixed view direction, keeping a corner
 * on the inside of each edge of the free area is linear in the eye's position, so the least distance (backing
 * off along the view) and the sideways shift that achieve it come in closed form (pairs of corners, per axis).
 * The orbit's target is the structure's centre (at 0.45 of its height, as frame() had it) moved across the
 * view by that shift, so dragging still turns about the structure. aspect >= 1 counts the width as a square's.
 */
export function fitBox(min: Vec3, max: Vec3, dir: Direction, aspect: number, insets: Insets = NO_INSETS, fovDeg = DEFAULT_FRAMING.fov): Orbit {
  const fovY = rad(fovDeg), t = Math.tan(fovY / 2), yaw = rad(dir.yaw), pitch = rad(dir.pitch);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fw: Vec3 = [-cp * Math.sin(yaw), -sp, -cp * Math.cos(yaw)];
  const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: Vec3 = [right[1] * fw[2] - right[2] * fw[1], right[2] * fw[0] - right[0] * fw[2], right[0] * fw[1] - right[1] * fw[0]];
  const centre: Vec3 = [(min[0] + max[0]) / 2, (max[1] - min[1]) * 0.45 + min[1], (min[2] + max[2]) / 2];
  // The free area in tangent units (camera-space x / depth / t), shrunk by FIT about its middle. Upright, x on
  // screen is the tangent times 1/aspect, so the sides scale by aspect; wide, a square's width counts.
  const sx = Math.min(aspect, 1);
  const axis = (lo: number, hi: number) => { const m = (lo + hi) / 2, h = (hi - lo) / 2 / FIT; return [m - h, m + h] as const; };
  const [xl, xr] = axis((-1 + 2 * insets.left) * sx, (1 - 2 * insets.right) * sx);
  const [yb, yt] = axis(-1 + 2 * insets.bottom, 1 - 2 * insets.top);
  if (!(xr > xl && yt > yb)) throw new Error(`fitBox: the insets leave no room (${JSON.stringify(insets)})`);
  // Corners relative to the centre: across (right or up) and along the view (fw).
  const across: number[][] = [[], []], along: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const r = [x - centre[0], y - centre[1], z - centre[2]];
    across[0]!.push(r[0]! * right[0] + r[1]! * right[1] + r[2]! * right[2]);
    across[1]!.push(r[0]! * up[0] + r[1]! * up[1] + r[2]! * up[2]);
    along.push(r[0]! * fw[0] + r[1]! * fw[1] + r[2]! * fw[2]);
  }
  // Eye = centre + a right + b up - e fw. Corner k's depth is along[k] + e and its across offset a[k] - shift;
  // inside the band [lo, hi]: shift <= a[k] - lo t (along[k] + e) and shift >= a[k] - hi t (along[k] + e).
  // A shift exists iff every pair (i, j) has a[i] - hi t (along[i] + e) <= a[j] - lo t (along[j] + e):
  // e >= (a[i] - a[j] - t (hi along[i] - lo along[j])) / ((hi - lo) t). The largest such e over pairs is the least.
  const need = (a: number[], lo: number, hi: number) => {
    let e = -Infinity;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) e = Math.max(e, (a[i]! - a[j]! - t * (hi * along[i]! - lo * along[j]!)) / ((hi - lo) * t));
    return e;
  };
  const e = Math.max(MIN_DISTANCE, need(across[0]!, xl, xr), need(across[1]!, yb, yt), ...along.map((d) => 1e-3 - d));
  // The shift's interval at that distance; take its middle (centred in the free area along the axis with room to spare).
  const shift = (a: number[], lo: number, hi: number) => {
    let low = -Infinity, high = Infinity;
    for (let k = 0; k < 8; k++) { low = Math.max(low, a[k]! - hi * t * (along[k]! + e)); high = Math.min(high, a[k]! - lo * t * (along[k]! + e)); }
    return (low + high) / 2;
  };
  const a = shift(across[0]!, xl, xr), b = shift(across[1]!, yb, yt);
  const target: Vec3 = [centre[0] + a * right[0] + b * up[0], centre[1] + a * right[1] + b * up[1], centre[2] + a * right[2] + b * up[2]];
  return { target, yaw, pitch, distance: e, fovY };
}

/** Every corner of the box (min, max) in front of the eye and inside the screen less `insets` (default: an upright phone's HUD band). */
export function clearOfHud(o: Orbit, aspect: number, min: Vec3, max: Vec3, insets: Insets = defaultInsets(Math.min(aspect, 0.99))): boolean {
  const m = viewProj(o, aspect), eps = 1e-9;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (!(w > 0)) return false;
    const px = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w, py = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    if (px < -1 + 2 * insets.left - eps || px > 1 - 2 * insets.right + eps || py > 1 - 2 * insets.top + eps || py < -1 + 2 * insets.bottom - eps) return false;
  }
  return true;
}

// ---- Which way to look (PT1: B2 opened on a field of towers hiding the cathedral and the crowns) ----

/** Pitches tried, degrees, lowest first: 12 is the framing Will chose (lower to the ground); higher ones look over front rows. */
export const SEARCH_PITCHES: readonly number[] = [12, 20, 28, 36, 45, 55];
/** Yaw turns tried from the base yaw, degrees, nearest first (the base keeps the par line's launcher behind the camera). */
export const SEARCH_YAWS: readonly number[] = [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 135, -135, 180];
/** Of the crowns, at least this share in sight (the PT1 verify). */
export const CROWNS_SEEN = 0.75;
/** A view keeps the structure's bodies apart when it shows at least this share of the bodies the best yaw at its pitch shows (PT14: L5's row end-on showed one domino). */
export const SPREAD_SHARE = 0.8;
/** The search's raster: this many pixels on the screen's longer side (a fraction of a millisecond per thousand boxes). */
export const SEARCH_PX = 160;
/**
 * The raster a passing view is confirmed at before the search takes it (PT3b): at SEARCH_PX a small crown is a few
 * pixels and the coarse count can pass a crown the page's own frame hides (T-X3B upright, docked: 0.39 of a crown at
 * 74 x 160, 0.20 at 390 x 844). Only views that already pass are drawn again, so the search costs one more raster a pick.
 */
export const CONFIRM_PX = 480;
/**
 * The wide HUD panel at the top left, shares of the screen, on the large side (hud.ts: 290 x 245 of 1280 x 800 on B2,
 * 310 x 300 with L5's lot sheet, 550 wide with four chips): the GPU gate measures the real panels.
 */
export const WIDE_HUD: ScreenRect = { left: 0, top: 0, right: 0.33, bottom: 0.4 };
/**
 * The search counts a body in sight at this share of it, stricter than the gate's SEEN_SHARE: its raster is coarse
 * (SEARCH_PX) and at home poses, the gate's is the page's own at full size after the pre-settle, so a view the
 * search only just passes could miss there.
 */
export const SEARCH_SEEN_SHARE = 0.35;

/** How a view does: objectives in sight and the bodies it shows at all. */
export interface ViewScore {
  dir: Direction; crowns: number; crownsSeen: number; heritage: number; heritageSeen: number;
  /** The share of the structure's outline area the view shows (visible pixels over every body's unoccluded pixels): low when bodies hide each other, as a row seen end-on. */
  exposure: number;
}

/** Of the heritage, at least this share in sight, and at least one body (the PT1 verify asks one; a single cube of B2's 32-cube cathedral reads as a stray, so a quarter). */
export const HERITAGE_SEEN = 0.25;

/** The view passes the objective gate: CROWNS_SEEN of the crowns and HERITAGE_SEEN of the heritage in sight (each when the level has any). */
export const showsObjectives = (s: ViewScore): boolean =>
  s.crownsSeen >= CROWNS_SEEN * s.crowns - 1e-9 && (s.heritage === 0 || s.heritageSeen >= Math.max(1, HERITAGE_SEEN * s.heritage - 1e-9));

/** The search raster's size for a screen of this aspect (wide screens as the game's 16:10 reference, so every wide window agrees). */
export function searchSize(aspect: number, px = SEARCH_PX): { width: number; height: number; aspect: number } {
  const a = aspect >= 1 ? 1.6 : aspect;
  return a >= 1 ? { width: px, height: Math.round(px / a), aspect: a } : { width: Math.round(px * a), height: px, aspect: a };
}

/** Score one direction: fit it, rasterize the structure at search size, count what the screen (less the HUD) shows. */
export function scoreView(c: CompiledLevel, dir: Direction, aspect: number, insets: Insets, hud: HudShape = 'panel', rasterPx = SEARCH_PX): ViewScore {
  const { min, max } = framedBox(c), size = searchSize(aspect, rasterPx);
  const o = { ...fitBox(min, max, dir, size.aspect, insets), floor: EYE_ABOVE_GROUND }, m = viewProj(o, size.aspect);
  const covered = hudRects(size.aspect, insets, hud);
  const r = idRaster(c, m, size.width, size.height), px = pixelCounts(r, c.meta.n, covered);
  const count = (list: ArrayLike<number>) => Array.from(list).filter((i) => seen(px[i]!, r.solo[i]!, SEARCH_SEEN_SHARE)).length;
  let shown = 0, whole = 0;
  for (let i = 0; i < c.meta.n; i++) { shown += Math.min(px[i]!, r.solo[i]!); whole += r.solo[i]!; }
  const exposure = whole > 0 ? shown / whole : 0;
  return { dir, crowns: c.meta.crowns.length, crownsSeen: count(c.meta.crowns), heritage: c.meta.heritage.length, heritageSeen: count(c.meta.heritage), exposure };
}

/**
 * Where the HUD covers the screen for the search: the panel wide, its top-left box; upright, the top band (the insets
 * keep the structure out of it anyway). Docked, nothing: the measured band is all in the insets, and fitBox keeps
 * every corner of the structure's box inside the rest, so no body can be under it.
 */
export function hudRects(aspect: number, insets: Insets, hud: HudShape = 'panel'): ScreenRect[] {
  if (hud === 'docked') return [];
  return aspect >= 1 ? [WIDE_HUD] : [{ left: 0, top: 0, right: 1, bottom: insets.top }];
}

/**
 * Which way the opening view looks. A level with no crowns or heritage keeps the base view (baseYaw, 12 degrees).
 * Otherwise pitches are tried lowest first and, at each, yaws nearest the base first; the first view that shows the
 * objectives (showsObjectives, on the search raster and again at CONFIRM_PX) and keeps the bodies apart (SPREAD_SHARE
 * of the best yaw at that pitch) wins. When
 * none does, the view showing the most objectives (then the most bodies, then the lowest and least turned) wins.
 * Deterministic and pure: the same level and screen shape always open on the same view.
 */
export function openingDirection(c: CompiledLevel, aspect: number, insets: Insets = defaultInsets(aspect), hud: HudShape = 'panel'): Direction {
  if (c.meta.crowns.length === 0 && c.meta.heritage.length === 0) return { yaw: baseYaw(c), pitch: DEFAULT_FRAMING.pitch };
  // Remembered per level, screen shape, insets and HUD: a retry, an undo or a return to the level costs nothing (B2's search is ~0.2 s).
  const key = `${c.hash}|${searchSize(aspect).aspect.toFixed(4)}|${insets.top},${insets.bottom},${insets.left},${insets.right}|${hud}`;
  let dir = picked.get(key);
  if (!dir) {
    dir = searchViews(c, aspect, insets, hud).pick;
    if (picked.size >= PICKED_MAX) picked.delete(picked.keys().next().value!);
    picked.set(key, dir);
  }
  return { ...dir };
}

const PICKED_MAX = 64;
const picked = new Map<string, Direction>();

/** The search behind openingDirection, with every view it scored (tests and the design note read them). */
export function searchViews(c: CompiledLevel, aspect: number, insets: Insets = defaultInsets(aspect), hud: HudShape = 'panel'): { pick: Direction; scored: ViewScore[] } {
  const base = baseYaw(c), scored: ViewScore[] = [];
  let fallback: ViewScore | null = null;
  const better = (a: ViewScore, b: ViewScore | null) => {
    if (!b) return true;
    const part = (s: ViewScore) => Math.min(1, s.crownsSeen / Math.max(1, CROWNS_SEEN * s.crowns)) + Math.min(1, s.heritageSeen / Math.max(1, HERITAGE_SEEN * s.heritage));
    const oa = part(a), ob = part(b);
    return oa !== ob ? oa > ob : a.exposure > b.exposure;
  };
  for (const pitch of SEARCH_PITCHES) {
    const row = SEARCH_YAWS.map((d) => scoreView(c, { yaw: base + d, pitch }, aspect, insets, hud));
    scored.push(...row);
    const best = Math.max(...row.map((s) => s.exposure));
    // A view that passes on the coarse raster is taken once it passes at CONFIRM_PX too (its objectives only: the spread
    // is a ratio of whole-structure areas, which the coarse raster measures well).
    const pick = row.find((s) => showsObjectives(s) && s.exposure >= SPREAD_SHARE * best && showsObjectives(scoreView(c, s.dir, aspect, insets, hud, CONFIRM_PX)));
    if (pick) return { pick: pick.dir, scored };
    for (const s of row) if (better(s, fallback)) fallback = s;
  }
  return { pick: fallback!.dir, scored };
}
