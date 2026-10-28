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
}

export const SOUND_MATERIALS = {
  /** Kapla: maritime pine, 117 x 23.4 x 7.8 mm. */
  pine: { model: 'plank', dims: [0.117, 0.0234, 0.0078], E: 10e9, G: 0.7e9, nu: 0.35, rho: 480, eta: 0.01, jitter: 0.03, R: 0.003, Ec: 1e9, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -Infinity },
  /** Bright game brick: hollow acrylic (PMMA), as if 8 cm with 2.5 mm walls. */
  acrylic: { model: 'shell', size: 0.08, wall: 0.0025, E: 3.2e9, nu: 0.37, rho: 1190, eta: 0.02, jitter: 0.005, R: 0.02, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: -Infinity },
  /** Real look: stone or concrete block at the body's own size. */
  stone: { model: 'cube', E: 30e9, nu: 0.2, rho: 2300, eta: 0.015, jitter: 0.02, R: 0.002, mstar: 0.7, ringDb: 0, clickDb: 0, gritDb: 0 },
} as const satisfies Record<string, SoundMaterial>;

const POSITIVE = ['E', 'nu', 'rho', 'eta', 'R', 'mstar'] as const;

const KEYS = new Set(['model', 'dims', 'size', 'wall', 'E', 'G', 'nu', 'rho', 'eta', 'jitter', 'R', 'Ec', 'mstar', 'ringDb', 'clickDb', 'gritDb']);

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
  if (out.model === 'plank' && !(out.dims?.length === 3 && out.dims.every((x) => x > 0))) throw new Error('a plank needs dims [length, width, thickness] > 0');
  if (out.model === 'plank' && !(out.G! > 0)) throw new Error('a plank needs G > 0');
  if (out.model === 'shell' && !(out.wall! > 0)) throw new Error('a shell needs wall > 0');
  return out;
}

/** JSON-safe copy (dB of -Infinity becomes null and back). */
export const materialToJson = (m: SoundMaterial): string => JSON.stringify(m, (_, v) => (v === -Infinity ? null : v));
export const materialFromJson = (s: string): SoundMaterial =>
  parseSoundMaterial(JSON.parse(s, (k, v) => (v === null && k.endsWith('Db') ? -Infinity : v)));
