// Art direction as data: every colour, light and post setting the shaders
// read, so a preset is a uniform block, not a shader variant. Includes the
// CPU twins of the colour math (OKLab, AgX) that tests compare the GPU with.
import type { V3 } from './math.ts';
import { CLEAR_DAY, type AtmosphereParams } from './atmosphere.ts';
import { type Ground, GROUNDS, type Stone, STONE_PALETTES, STONES } from './materials.ts';

export interface LookParams {
  name: string;
  skyZenith: V3;
  skyHorizon: V3;
  /** Soft glow on the horizon behind the focus point. */
  glow: V3;
  floor: V3;
  /** Grid line contrast on the floor, 0 for none. */
  floorGrid: number;
  sunColor: V3;
  ambSky: V3;
  ambGround: V3;
  /** Overhead softbox and rim softbox, seen in reflections. */
  keyColor: V3;
  keyDir: V3;
  keySize: number;
  rimColor: V3;
  rimDir: V3;
  rimSize: number;
  /** Base-lobe GGX roughness and clearcoat weight of the candy material. */
  roughness: number;
  clearcoat: number;
  /** Bevel radius in metres (widened to 1.5 px, faded out when that exceeds 45% of the half extent). */
  bevel: number;
  /** Colour ramp by original height, bottom to top, sRGB 0..1. */
  ramp: [V3, V3, V3, V3, V3];
  /** Hue offset per tower palette step, degrees. */
  hueStep: number;
  ball: V3;
  ballEmissive: number;
  /** Exponential fog per metre and its fall-off with height per metre. */
  fogDensity: number;
  fogHeight: number;
  exposure: number;
  /** Fraction of the bloom pyramid mixed into the image (energy-conserving). */
  bloomMix: number;
  vignette: number;
  /** Direction toward the sun (default SUN in renderer.ts). */
  sunDir?: V3;
  /**
   * A physically based sky (atmosphere.ts). When set, the sky, haze, sun
   * colour and ambient light come from it, and skyZenith, skyHorizon, glow,
   * fog, sunColor, ambSky, ambGround and the softboxes are unused.
   */
  atmosphere?: AtmosphereParams;
  /** With an atmosphere: how far exposure adapts to the light, 0 (fixed) to 1 (auto exposure); see adaptedExposure. */
  autoExposure?: number;
  /**
   * With an atmosphere: the blocks' stone (materials.ts), texture scale (1 = a tile per MATERIAL_TILE
   * metres), edge wear and dirt (0 to 1), texture strength, and fade: the pixel footprint (metres)
   * where the texture has faded out (from half that), past which blocks drop the stone code.
   */
  stone?: { kind: Stone; scale: number; wear: number; dirt: number; detail: number; fade: number };
  /**
   * With an atmosphere: the ground's material (materials.ts GROUNDS), texture scale (1 = a tile per
   * GROUND_TILE metres), texture strength (0: flat floor, nothing sampled) and macro variation (0 to 1):
   * brightness, tint and a second, coarser scale that hide the tile's repeat.
   */
  ground?: { kind: Ground; scale: number; detail: number; variation: number };
  /** With an atmosphere: hills on the horizon, their greatest height (degrees above the horizon; 0: none) and distance (km). */
  hills?: { height: number; distance: number };
  /** With an atmosphere: sun shadow penumbrae as wide as the sun's disc times softness (0: the stylized looks' 3x3 taps). Default 1. */
  shadow?: { softness: number };
  /** With an atmosphere and effects off: impact dust and chips, as multiples of the default amounts (0: none), and a puff's full size (m). */
  debris?: { dust: number; chips: number; size: number };
  /** false: none of the stylized effects (sparks, ball trail, heat glow, ball and impact lights). Default true. */
  effects?: boolean;
}

const hex = (h: string): V3 => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as V3;

export const CANDY_NIGHT: LookParams = {
  name: 'candy',
  skyZenith: [0.004, 0.006, 0.02],
  skyHorizon: [0.012, 0.022, 0.07],
  glow: [0.05, 0.05, 0.12],
  floor: [0.016, 0.02, 0.042],
  floorGrid: 0.3,
  sunColor: [3.0, 2.85, 2.65],
  ambSky: [0.5, 0.55, 0.8],
  ambGround: [0.12, 0.1, 0.14],
  keyColor: [3.2, 3.0, 2.8],
  keyDir: [0.25, 0.92, 0.3],
  keySize: 0.55,
  rimColor: [0.6, 1.1, 1.6],
  rimDir: [-0.55, 0.25, -0.8],
  rimSize: 0.7,
  roughness: 0.3,
  clearcoat: 0.35,
  bevel: 0.06,
  ramp: [hex('#FF9F5A'), hex('#FFD966'), hex('#8FE388'), hex('#6FD6E8'), hex('#B9A3F0')],
  hueStep: 5,
  ball: [1.0, 0.72, 0.52],
  ballEmissive: 6,
  fogDensity: 0.004,
  fogHeight: 0.02,
  exposure: 1.15,
  bloomMix: 0.06,
  vignette: 0.25,
};

export const HAZY_DAY: LookParams = {
  ...CANDY_NIGHT,
  name: 'hazy',
  skyZenith: [0.45, 0.55, 0.72],
  skyHorizon: [0.75, 0.8, 0.86],
  glow: [0.2, 0.18, 0.12],
  floor: [0.42, 0.42, 0.44],
  floorGrid: 0.12,
  sunColor: [3.0, 2.8, 2.4],
  ambSky: [0.55, 0.62, 0.75],
  ambGround: [0.3, 0.28, 0.25],
  keyColor: [1.2, 1.2, 1.25],
  rimColor: [0.4, 0.45, 0.5],
  roughness: 0.55,
  clearcoat: 0.05,
  ramp: [hex('#9FA8C6'), hex('#A9B2D0'), hex('#B4BCD8'), hex('#C0C7E0'), hex('#CCD2E8')],
  hueStep: 1,
  ballEmissive: 1.5,
  fogDensity: 0.012,
  fogHeight: 0.05,
  exposure: 0.85,
  bloomMix: 0.03,
  vignette: 0.15,
};

/** The knobs of the real look (all optional; realLook fills the rest). */
export interface RealOptions {
  /** Sun elevation above the horizon and azimuth (clockwise from -z, toward +x), degrees. */
  sunElevation: number;
  sunAzimuth: number;
  /** Meteorological visibility, km: 10 is hazy, 40 a clear summer day, 150 crisp. */
  visibility: number;
  /** Sun illuminance multiplier (1 = the default exposure's daylight). */
  sunStrength: number;
  /** Linear albedo of the ground (also what the sky's multiple scattering sees). */
  groundAlbedo: V3;
  /** Exposure at the default sun; autoExposure (0 to 1) is how far it follows the light as the sun moves or haze thickens. */
  exposure: number;
  autoExposure: number;
  /** The blocks' stone, its texture strength (0: flat colour, nothing sampled) and scale (2 = features twice as large), edge wear and dirt at the base (0 to 1). */
  stone: Stone;
  stoneDetail: number;
  stoneScale: number;
  /** Pixel footprint (cm) where the stone texture has faded out, from half that; past it blocks use the cheaper shader. */
  stoneFade: number;
  wear: number;
  dirt: number;
  /** The ground's material, its texture strength (0: flat, nothing sampled) and scale, and how much it varies over tens of metres (0 to 1). */
  groundMaterial: Ground;
  groundDetail: number;
  groundScale: number;
  groundVariation: number;
  /** Hills on the horizon: their greatest height in degrees above it (0: none) and how far away they are, km. */
  hills: number;
  hillDistance: number;
  /** The sun's angular diameter, degrees (0.53 is the real one): the disc in the sky and, times shadowSoftness, how fast shadows soften with distance (0: hard 3x3 taps). */
  sunSize: number;
  shadowSoftness: number;
  /** Impacts throw dust puffs and stone chips (multiples of the default amounts, 0: none); a puff grows to a radius of dustSize metres. */
  dust: number;
  chips: number;
  dustSize: number;
}

export const REAL_DEFAULTS: RealOptions = {
  sunElevation: 35, sunAzimuth: 140, visibility: 40, sunStrength: 1, groundAlbedo: [0.2, 0.19, 0.17], exposure: 1.1, autoExposure: 0.75,
  stone: 'limestone', stoneDetail: 1, stoneScale: 1, stoneFade: 8, wear: 0.5, dirt: 0.4,
  groundMaterial: 'gravel', groundDetail: 1, groundScale: 1, groundVariation: 0.5, hills: 1.5, hillDistance: 6,
  sunSize: 0.53, shadowSoftness: 1,
  dust: 1, chips: 1, dustSize: 0.9,
};

/** Direction toward the sun from elevation and azimuth in degrees. */
export function sunFrom(elevation: number, azimuth: number): V3 {
  const e = (elevation * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

/**
 * The photoreal look (docs/realism.md), from its knobs. Stone-coloured
 * blocks, no studio softboxes, the sky and light from the atmosphere.
 * Sky lighting arrives in a later realism step.
 */
export function realLook(o: Partial<RealOptions> = {}): LookParams {
  const r = { ...REAL_DEFAULTS, ...o };
  return {
    ...HAZY_DAY,
    name: 'real',
    sunDir: sunFrom(r.sunElevation, r.sunAzimuth),
    atmosphere: { ...CLEAR_DAY, visibility: r.visibility, groundAlbedo: r.groundAlbedo, sunRadius: (r.sunSize * Math.PI) / 360, sunIlluminance: CLEAR_DAY.sunIlluminance.map((x) => x * r.sunStrength) as V3 },
    floor: r.groundAlbedo,
    floorGrid: 0,
    keyColor: [0, 0, 0],
    rimColor: [0, 0, 0],
    roughness: 0.8,
    clearcoat: 0,
    bevel: 0.012,
    ramp: STONE_PALETTES[r.stone].map(hex) as LookParams['ramp'],
    stone: { kind: r.stone, scale: r.stoneScale, wear: r.wear, dirt: r.dirt, detail: r.stoneDetail, fade: r.stoneFade / 100 },
    ground: { kind: r.groundMaterial, scale: r.groundScale, detail: r.groundDetail, variation: r.groundVariation },
    hills: { height: r.hills, distance: r.hillDistance },
    shadow: { softness: r.shadowSoftness },
    debris: { dust: r.dust, chips: r.chips, size: r.dustSize },
    hueStep: 4,
    ball: hex('#8A8D90'),
    ballEmissive: 0,
    exposure: r.exposure,
    autoExposure: r.autoExposure,
    // Sparks and glows are not real; impacts throw dust and chips instead (debris).
    effects: false,
    bloomMix: 0.02,
    vignette: 0.08,
  };
}

/** The real look's scalar knobs: URL key real.<name>, panel label, accepted range and step. */
export const REAL_KNOBS = {
  sunElevation: { label: 'sun elevation (deg)', min: -10, max: 90, step: 1 },
  sunAzimuth: { label: 'sun azimuth (deg)', min: -360, max: 360, step: 5 },
  visibility: { label: 'visibility (km)', min: 1, max: 400, step: 1 },
  sunStrength: { label: 'sun strength x', min: 0.05, max: 10, step: 0.05 },
  exposure: { label: 'exposure', min: 0.05, max: 20, step: 0.05 },
  autoExposure: { label: 'auto exposure 0-1', min: 0, max: 1, step: 0.05 },
  stoneDetail: { label: 'stone texture 0-1', min: 0, max: 1, step: 0.05 },
  stoneScale: { label: 'stone texture scale', min: 0.1, max: 10, step: 0.1 },
  stoneFade: { label: 'stone fade-out (cm/px)', min: 0.5, max: 1000, step: 0.5 },
  wear: { label: 'edge wear 0-1', min: 0, max: 1, step: 0.05 },
  dirt: { label: 'dirt 0-1', min: 0, max: 1, step: 0.05 },
  groundDetail: { label: 'ground texture 0-1', min: 0, max: 1, step: 0.05 },
  groundScale: { label: 'ground texture scale', min: 0.1, max: 10, step: 0.1 },
  groundVariation: { label: 'ground variation 0-1', min: 0, max: 1, step: 0.05 },
  hills: { label: 'horizon hills (deg)', min: 0, max: 10, step: 0.1 },
  hillDistance: { label: 'hill distance (km)', min: 0.5, max: 100, step: 0.5 },
  sunSize: { label: 'sun size (deg)', min: 0.05, max: 5, step: 0.01 },
  shadowSoftness: { label: 'shadow softness x (0: hard)', min: 0, max: 4, step: 0.1 },
  dust: { label: 'impact dust x', min: 0, max: 4, step: 0.1 },
  chips: { label: 'impact chips x', min: 0, max: 4, step: 0.1 },
  dustSize: { label: 'dust puff radius (m)', min: 0.1, max: 5, step: 0.1 },
} as const;
export type RealKnob = keyof typeof REAL_KNOBS;

/**
 * The real look's options from URL keys real.<knob>, real.stone (a STONES
 * name), real.groundMaterial (a GROUNDS name) and real.ground (linear albedo r,g,b, each 0 to 1); absent keys are left out, so realLook fills
 * them from REAL_DEFAULTS. Rejects values that are not numbers or are out of range.
 */
export function parseRealOptions(q: URLSearchParams): Partial<RealOptions> {
  const o: Partial<RealOptions> = {};
  for (const [key, k] of Object.entries(REAL_KNOBS) as [RealKnob, (typeof REAL_KNOBS)[RealKnob]][]) {
    const raw = q.get(`real.${key}`);
    if (raw === null || raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < k.min || v > k.max) throw new Error(`real.${key} must be a number from ${k.min} to ${k.max}: ${raw}`);
    o[key] = v;
  }
  const stone = q.get('real.stone');
  if (stone !== null && stone !== '') {
    if (!(STONES as readonly string[]).includes(stone)) throw new Error(`real.stone must be one of ${STONES.join(', ')}: ${stone}`);
    o.stone = stone as Stone;
  }
  const material = q.get('real.groundMaterial');
  if (material !== null && material !== '') {
    if (!(GROUNDS as readonly string[]).includes(material)) throw new Error(`real.groundMaterial must be one of ${GROUNDS.join(', ')}: ${material}`);
    o.groundMaterial = material as Ground;
  }
  const ground = q.get('real.ground');
  if (ground !== null && ground !== '') {
    const v = ground.split(',').map(Number);
    if (v.length !== 3 || v.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error(`real.ground must be three numbers from 0 to 1 (linear albedo r,g,b): ${ground}`);
    o.groundAlbedo = v as V3;
  }
  return o;
}

/** Writes the options that are set as URL keys (parseRealOptions reads them back). */
export function writeRealOptions(o: Partial<RealOptions>, q: URLSearchParams): void {
  for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) if (o[key] !== undefined) q.set(`real.${key}`, String(o[key]));
  if (o.stone) q.set('real.stone', o.stone);
  if (o.groundMaterial) q.set('real.groundMaterial', o.groundMaterial);
  if (o.groundAlbedo) q.set('real.ground', o.groundAlbedo.join(','));
}

/** A look by name; real takes its options (the others have none). Unknown names give fallback. */
export function lookByName(name: string, real: Partial<RealOptions> = {}, fallback: LookParams = CANDY_NIGHT): LookParams {
  return name === 'real' ? realLook(real) : LOOKS[name] ?? fallback;
}

export const REAL = realLook();

export const LOOKS: Record<string, LookParams> = { candy: CANDY_NIGHT, hazy: HAZY_DAY, real: REAL };

// ---------------------------------------------------------------- colour math (CPU twins)

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function linearToOklab([r, g, b]: V3): V3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear([L, a, b]: V3): V3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const OKLAB_WGSL = /* wgsl */ `
fn oklabToLinear(c: vec3f) -> vec3f {
  let l = pow3(c.x + 0.3963377774 * c.y + 0.2158037573 * c.z);
  let m = pow3(c.x - 0.1055613458 * c.y - 0.0638541728 * c.z);
  let s = pow3(c.x - 0.0894841775 * c.y - 1.2914855480 * c.z);
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
fn pow3(x: f32) -> f32 { return x * x * x; }
`;

// AgX (Troy Sobotka), fitted by Benjamin Wrensch: inset matrix, log2
// encoding over [-12.47, 4.03] EV, a 6th-order contrast polynomial, the
// "punchy" look, and the outset matrix. Output is display-encoded.
const AGX_IN = [0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104];
const AGX_OUT = [1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116];
const MIN_EV = -12.47393, MAX_EV = 4.026069;

const mat3 = (m: number[], v: V3): V3 => [0, 1, 2].map((r) => m[r]! * v[0] + m[3 + r]! * v[1] + m[6 + r]! * v[2]) as V3;
const contrast = (x: number) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

/** Linear scene colour to display-encoded colour (0..1), punchy look. */
export function agx(c: V3): V3 {
  let v = mat3(AGX_IN, c).map((x) => Math.min(MAX_EV, Math.max(MIN_EV, Math.log2(Math.max(x, 1e-10)))));
  v = v.map((x) => contrast((x - MIN_EV) / (MAX_EV - MIN_EV)));
  const luma = 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  v = v.map((x) => luma + 1.4 * (Math.max(x, 0) ** 1.35 - luma));
  return mat3(AGX_OUT, v as V3).map((x) => Math.min(1, Math.max(0, x))) as V3;
}

const f = (x: number) => x.toPrecision(17).replace(/0+$/, '').replace(/\.$/, '.0');
export const AGX_WGSL = /* wgsl */ `
fn agx(c: vec3f) -> vec3f {
  let inset = mat3x3f(${AGX_IN.map(f).join(', ')});
  let outset = mat3x3f(${AGX_OUT.map(f).join(', ')});
  var v = clamp(log2(max(inset * c, vec3f(1e-10))), vec3f(${MIN_EV}), vec3f(${MAX_EV}));
  v = (v - ${MIN_EV}) / (${MAX_EV} - ${MIN_EV});
  let x2 = v * v;
  let x4 = x2 * x2;
  v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232;
  let luma = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  v = luma + 1.4 * (pow(max(v, vec3f(0.0)), vec3f(1.35)) - luma);
  return clamp(outset * v, vec3f(0.0), vec3f(1.0));
}
`;

// ---------------------------------------------------------------- bevel (CPU twin of BEVEL_WGSL)

/**
 * Body-local shading normal of a rounded box at metric local surface point
 * lp on face faceN. pxM is the pixel footprint in metres. The radius is at
 * least one pixel, is capped at 45% of the smallest half extent, and fades
 * to the flat face as it nears the cap (so the normal never inverts) and
 * once the true bevel is under a third of a pixel: there, one-sided bevel
 * shading reads as noise, and the symmetric seam darkening takes over.
 */
export function bevelNormal(lp: V3, faceN: V3, half: V3, pxM: number, rBevel: number): V3 {
  const rMax = 0.45 * Math.min(...half);
  const rWant = Math.max(rBevel, pxM);
  const ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const w = (1 - ss(0.6 * rMax, rMax, rWant)) * (1 - ss(rBevel, 3 * rBevel, pxM));
  const r = Math.min(rWant, rMax);
  const d = lp.map((x, k) => x - Math.min(half[k]! - r, Math.max(-(half[k]! - r), x)));
  const dl = Math.hypot(...d) || 1;
  const m = faceN.map((x, k) => x + (d[k]! / dl - x) * w);
  const ml = Math.hypot(...m);
  return m.map((x) => x / ml) as V3;
}

export const BEVEL_WGSL = /* wgsl */ `
fn bevelNormal(lp: vec3f, faceN: vec3f, half: vec3f, pxM: f32, rBevel: f32) -> vec3f {
  let rMax = 0.45 * min(half.x, min(half.y, half.z));
  let rWant = max(rBevel, pxM);
  let w = (1.0 - smoothstep(0.6 * rMax, rMax, rWant)) * (1.0 - smoothstep(rBevel, 3.0 * rBevel, pxM));
  let r = min(rWant, rMax);
  let d = lp - clamp(lp, -(half - r), half - r);
  let dl = length(d);
  let nb = select(faceN, d / dl, dl > 0.0);
  return normalize(mix(faceN, nb, w));
}
`;
