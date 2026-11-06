// Sound materials: what a body of a given look sounds like, as plain data so
// the viewer can edit it (Scene panel, snd.* URL params, config JSON).
//
// Three body models, each turned into a mode table by modes.ts:
//   plank  a free-free beam (Kapla): bending across the thickness and the
//          width (Rayleigh-Timoshenko) and torsion, from dims and E, G.
//   shell  a hollow box whose six walls ring as clamped square plates: what a
//          bright plastic brick is. A solid block of any size only thuds (its
//          Hertz contact outlasts its mode periods), so "acrylic" needs this.
//   cube   a solid cube, from a finite-element table (cube-modes.ts).
// Contact (Hertz) and the click of the body's own acceleration (a compact
// dipole) come from mass, R and the contact modulus. ringDb, clickDb and
// gritDb are hand balances until calibrated against recordings (plan S9).
//
// Values: docs/sound.md, from Cremer & Heckl loss factors and the 2026-10-28
// collapse sound study (/mnt/project-files/sound/).

export type SoundModel = 'plank' | 'shell' | 'cube';

export interface SoundMaterial {
  model: SoundModel;
  /** plank: length, width, thickness in metres (a plank keeps its real size whatever the world scale). */
  dims?: [number, number, number];
  /** shell and cube: edge in metres the sound is made for; absent = the body's own edge (world scale). */
  size?: number;
  /** shell: wall thickness, metres. */
  wall?: number;
  /** shell: the six walls' frequency multipliers (absent: CLASSIC_WALLS, within 3%). */
  walls?: readonly number[];
  /** shell: plate modes up to this many half-waves each way, per wall (absent: Leissa's 8; plateTable). */
  plateModes?: number;
  /** Young's modulus (plank: along the grain), Pa. */
  E: number;
  /** plank: shear modulus, Pa (wood's is low, which lowers torsion and the higher bending modes). */
  G?: number;
  nu: number;
  /** Density, kg/m^3. */
  rho: number;
  /** Loss factor: a mode at f decays as exp(-pi f eta t). */
  eta: number;
  /** Body-to-body spread of every mode frequency, lognormal sigma (wood a few %). */
  jitter: number;
  /** Contact radius of curvature, metres (corners and edges: small; faces: large). */
  R: number;
  /** Contact modulus across the contact, Pa (wood across the grain is ~10x softer than along); default E. */
  Ec?: number;
  /** Effective mass of a collision as a share of the body's mass (1 against the ground, 0.5 between equals). */
  mstar: number;
  ringDb: number;
  clickDb: number;
  /** Chips and grit knocked off hard hits (stone), dB; -Infinity = none. */
  gritDb: number;
  /**
   * Contact roughness, dB: how much the contact force fluctuates, as a share of itself (several points
   * touching within the contact, asperities), as noise up to ~7 kHz (modes.ts forceSpectrum). A smooth
   * Hertz pulse of T seconds has almost nothing above 1 / T, so a heavy block's long contact sounds only
   * its lowest mode (a pure "plop"); the fluctuation drives the higher and dense modes too. Absent or
   * -Infinity: the smooth pulse.
   */
  roughDb?: number;
  /**
   * An asperity's contact time, s (absent: ROUGH_T, 0.15 ms): the roughness floor's bandwidth is ~1 / roughT.
   * Asperities are Hertz contacts too, so a soft partner lengthens them as (E*)^(-2/5): a steel ball on
   * plaster has plaster's (sound-map.ts pairs the game's ammo with the struck material this way).
   */
  roughT?: number;
  /**
   * The dense modes above the mode table (shell walls and solid cubes have thousands): played as a
   * statistical field, band noise per (sector, half-octave) decaying at each band's loss factor, with
   * the energy the same modes would carry (modal density x the table's per-mode law). dB over that;
   * absent or -Infinity: off (planks: their table already reaches 18 kHz).
   */
  denseDb?: number;
  /**
   * How loud each table mode is. 'velocity' (absent: G6's): every mode moves at the impact's dv, which
   * grows without bound with the mode count, so its levels are hand balances. 'energy': each mode gets
   * its share of the impact's energy and radiates by its efficiency (modes.ts modeGain), the dense
   * field's law, so the table, the field and the click (the rigid body's own) balance by physics.
   */
  law?: 'velocity' | 'energy';
}

/**
 * The materials as G6 shipped them (2026-11-01): smooth Hertz contacts, the mode tables alone, free-body
 * loss factors. A heavy block's long contact then rings only its lowest mode, a pure tone, and the
 * AudioSet judge (docs/sound.md, Realism) hears the game's collapses as "Music, Plop, Synthesizer".
 * Kept to compare against (viewer snd.set=classic, game keystone.sound=classic).
 */
export const CLASSIC_SOUND_MATERIALS = {
  /** Kapla: maritime pine, 117 x 23.4 x 7.8 mm. */
  pine: { model: 'plank', dims: [0.117, 0.0234, 0.0078], E: 10e9, G: 0.7e9, nu: 0.35, rho: 480, eta: 0.01, jitter: 0.03, R: 0.003, Ec: 1e9, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -Infinity },
  /** Bright game brick: hollow acrylic (PMMA), as if 8 cm with 2.5 mm walls. */
  acrylic: { model: 'shell', size: 0.08, wall: 0.0025, E: 3.2e9, nu: 0.37, rho: 1190, eta: 0.02, jitter: 0.005, R: 0.02, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -Infinity },
  /** Real look: stone or concrete block at the body's own size. */
  stone: { model: 'cube', E: 30e9, nu: 0.2, rho: 2300, eta: 0.015, jitter: 0.02, R: 0.002, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -6 },
  // Keystone's materials (the game). Its blocks are model-scale maquettes (@tb/keystone materials.ts):
  // plaster and iron are hollow, so they ring as shells; ice and rubber are solid.
  /** Hollow plaster maquette block, 2 cm walls: a damped bonk (~300 Hz at 0.5 m) that crumbles. */
  plaster: { model: 'shell', wall: 0.02, E: 5e9, nu: 0.25, rho: 1000, eta: 0.04, jitter: 0.03, R: 0.01, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -6 },
  /** Hollow cast-iron box, 6 mm walls: a long clang (~200 Hz at 0.5 m, rings near a second). */
  iron: { model: 'shell', wall: 0.006, E: 170e9, nu: 0.27, rho: 7200, eta: 0.002, jitter: 0.01, R: 0.01, mstar: 0.7, ringDb: -6, clickDb: 0, gritDb: -Infinity },
  /** Solid ice: a thud a little brighter and longer than stone's, and it cracks. */
  ice: { model: 'cube', E: 9e9, nu: 0.33, rho: 917, eta: 0.005, jitter: 0.02, R: 0.002, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -6 },
  /** Solid rubber: a dull, low bomp (its contact lasts tens of ms). */
  rubber: { model: 'cube', E: 0.05e9, nu: 0.45, rho: 1100, eta: 0.1, jitter: 0.03, R: 0.02, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -Infinity },
  /** Solid steel (Keystone's ammo): a hard knock with a faint long ring. */
  steel: { model: 'cube', E: 200e9, nu: 0.29, rho: 7800, eta: 0.0005, jitter: 0.005, R: 0.01, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -Infinity },
} as const satisfies Record<string, SoundMaterial>;

/** Cast walls are not equal: thickness within ~10%, so wall frequencies within ~15% (plaster, iron). */
const CAST_WALLS = [1, 0.9, 1.11, 0.95, 1.17, 0.86] as const;

/**
 * The sound materials (2026-11-05, "real" set). Over CLASSIC_SOUND_MATERIALS: contact roughness and the
 * dense modes on every shell and cube, and loss factors for blocks in a pile, where contacts carry energy
 * into neighbours (contact damping: 2-15x a free body's). Each value was picked on a plateau of the
 * AudioSet judge's real-event share over the L1-L3 par lines (docs/sound.md, Realism), not a peak.
 */
export const SOUND_MATERIALS = {
  /** Kapla: maritime pine, 117 x 23.4 x 7.8 mm (a plank's table already reaches 18 kHz; unchanged). */
  pine: CLASSIC_SOUND_MATERIALS.pine,
  /** Bright game brick: hollow acrylic (PMMA), as if 8 cm with 2.5 mm walls. */
  acrylic: { ...CLASSIC_SOUND_MATERIALS.acrylic, law: 'energy', roughDb: -6, denseDb: 0 },
  /** Real look: stone or concrete block at the body's own size (eta 0.02: the judge's mineral band; 0.03 read soft). */
  stone: { ...CLASSIC_SOUND_MATERIALS.stone, law: 'energy', eta: 0.02, roughDb: -6, denseDb: 0 },
  /**
   * Plaster: a porous cast block at the game's own 250 kg/m^3, ringing as a solid (E 2 GPa, a light
   * gypsum's). As a hollow shell it read as a door at any damping (Material identity, step 1).
   */
  plaster: { model: 'cube', E: 2e9, nu: 0.25, rho: 250, eta: 0.035, jitter: 0.03, R: 0.01, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: 0, law: 'energy', roughDb: 0, denseDb: 0 },
  /**
   * Hollow cast-iron box with 22.6 mm walls, the thickness that gives the game's 1950 kg/m^3, and
   * plate modes up to 8 half-waves a wall: a clang (eta 0.003; at 0.03 it read as wood).
   */
  iron: { ...CLASSIC_SOUND_MATERIALS.iron, law: 'energy', wall: 0.0226, plateModes: 8, eta: 0.003, walls: CAST_WALLS, roughDb: -20, denseDb: 0 },
  /** Solid ice: a glassy clink, and it cracks (eta 0.005, ice's own; at 0.04 it read as rubber). */
  ice: { ...CLASSIC_SOUND_MATERIALS.ice, law: 'energy', eta: 0.005, roughDb: -6, denseDb: 0 },
  /** Solid rubber: a dull, low bomp (its contact lasts tens of ms). */
  rubber: { ...CLASSIC_SOUND_MATERIALS.rubber, law: 'energy', roughDb: -20, denseDb: 0 },
  /** Solid steel (Keystone's ammo): a hard clink. */
  steel: { ...CLASSIC_SOUND_MATERIALS.steel, law: 'energy', eta: 0.002, roughDb: -12, denseDb: 0 },
} as const satisfies Record<keyof typeof CLASSIC_SOUND_MATERIALS, SoundMaterial>;

/** A named material set: 'real' (SOUND_MATERIALS, the default) or 'classic' (G6's). */
export type SoundSet = 'real' | 'classic';
export const SOUND_SETS = ['real', 'classic'] as const satisfies readonly SoundSet[];
export const soundMaterials = (set: SoundSet = 'real'): Record<keyof typeof SOUND_MATERIALS, SoundMaterial> => (set === 'classic' ? CLASSIC_SOUND_MATERIALS : SOUND_MATERIALS);

const POSITIVE = ['E', 'nu', 'rho', 'eta', 'R', 'mstar'] as const;

const KEYS = new Set(['model', 'dims', 'size', 'wall', 'walls', 'plateModes', 'E', 'G', 'nu', 'rho', 'eta', 'jitter', 'R', 'Ec', 'mstar', 'ringDb', 'clickDb', 'gritDb', 'roughDb', 'roughT', 'denseDb', 'law']);

/** A material from JSON-ish input over `base` (a whole material when absent); throws on a value that can't make sound. */
export function parseSoundMaterial(input: Partial<Record<keyof SoundMaterial, unknown>>, base?: SoundMaterial): SoundMaterial {
  const m = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(input)) {
    if (!KEYS.has(k)) throw new Error(`unknown sound material key ${k}`);
    m[k] = v;
  }
  const out = m as unknown as SoundMaterial;
  if (!['plank', 'shell', 'cube'].includes(out.model)) throw new Error(`unknown sound model ${String(out.model)}`);
  for (const k of POSITIVE) if (!(typeof out[k] === 'number' && out[k] > 0 && Number.isFinite(out[k]))) throw new Error(`sound material ${k} must be a positive number`);
  if (out.nu >= 0.5) throw new Error('sound material nu must be below 0.5');
  if (!(out.jitter >= 0 && out.jitter < 0.5)) throw new Error('sound material jitter must be in [0, 0.5)');
  for (const k of ['ringDb', 'clickDb', 'gritDb'] as const) if (typeof out[k] !== 'number' || Number.isNaN(out[k])) throw new Error(`sound material ${k} must be a number`);
  for (const k of ['roughDb', 'denseDb'] as const) if (out[k] !== undefined && (typeof out[k] !== 'number' || Number.isNaN(out[k]))) throw new Error(`sound material ${k} must be a number`);
  if (out.model === 'plank' && !(out.dims?.length === 3 && out.dims.every((x) => x > 0))) throw new Error('a plank needs dims [length, width, thickness] > 0');
  if (out.model === 'plank' && !(out.G! > 0)) throw new Error('a plank needs G > 0');
  if (out.model === 'shell' && !(out.wall! > 0)) throw new Error('a shell needs wall > 0');
  if (out.law !== undefined && out.law !== 'velocity' && out.law !== 'energy') throw new Error(`sound material law must be velocity or energy: ${String(out.law)}`);
  if (out.plateModes !== undefined && !(Number.isInteger(out.plateModes) && out.plateModes >= 1 && out.plateModes <= 16)) throw new Error('sound material plateModes must be an integer 1-16');
  if (out.roughT !== undefined && !(out.roughT >= 1e-5 && out.roughT <= 0.05)) throw new Error('sound material roughT must be 1e-5 to 0.05 s');
  if (out.walls !== undefined && !(Array.isArray(out.walls) && out.walls.length === 6 && out.walls.every((x) => typeof x === 'number' && x > 0 && Number.isFinite(x)))) throw new Error('sound material walls must be six positive numbers');
  return out;
}

/** JSON-safe copy (dB of -Infinity becomes null and back). */
export const materialToJson = (m: SoundMaterial): string => JSON.stringify(m, (_, v) => (v === -Infinity ? null : v));
export const materialFromJson = (s: string): SoundMaterial =>
  parseSoundMaterial(JSON.parse(s, (k, v) => (v === null && k.endsWith('Db') ? -Infinity : v)));
