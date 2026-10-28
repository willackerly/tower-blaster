// What a click fires: a ball or a cube, its size, mass and launch speed,
// or a real object from @tb/weapons' catalogue (beach ball to the Raiders
// boulder), and optionally a weapon (a grenade). The defaults reproduce the
// viewer's original ball exactly (radius 0.7, density 8, 40 m/s), so a
// default setup fires the same body as before.
//
// Units: ball and cube are in the world's cube units, as everything else the
// scale knob scales (a world of smaller cubes shrinks them too, and their
// speed goes up as froudeSpeed). A catalogue object is real: its size in m,
// speed in m/s and mass in kg stay real whatever the cube size, so a beach
// ball is 2 cubes across among quarter-metre cubes; its mass is set against
// the real density the scene's blocks stand for (blockDensity).
import { parseSpec } from '@tb/bench';
import { type BodyDesc, type SceneDesc, type ShapeDesc, spawnedBodies, TAG_BALL, volumeOf } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { checkGrenade, DEFAULT_GRENADE, FUSES, type Fuse, type GrenadeBlast, type GrenadeSpec, isPreset, PRESET_NAMES, type PresetName, PROJECTILE_PRESETS, STONE_DENSITY } from '@tb/weapons';
import type { V3 } from './math.ts';

export interface Projectile {
  shape: 'ball' | 'cube';
  /** Diameter of a ball or edge of a cube: cube units (a scene cube is 1); a preset's in m. */
  size: number;
  /** kg (a scene cube is 1; a preset's real kg); null = density 8, the original ball's (a preset's own density). */
  mass: number | null;
  /** Launch speed: m/s at cube edge 1 m (froudeSpeed); a preset's real m/s. */
  speed: number;
  /** A catalogue object (URL key proj=<name>, @tb/weapons PROJECTILE_PRESETS); size, mass and speed are then real. */
  preset?: PresetName;
  /** Default 0.1 (a preset's own). */
  restitution?: number;
  /** Default 0.5 (a preset's own). */
  friction?: number;
  /** Real density a scene block of density 1 stands for, kg/m^3, for a preset's mass (URL key proj.blockDensity); default blockDensityOf the scene. */
  blockDensity?: number;
  /** What it does besides hitting (URL key proj.weapon): absent, nothing; grenade, a fused blast. */
  weapon?: Weapon;
  /** With weapon grenade (and only then): its fuse and blast (URL keys grenade.*), in cube units at scale 1 (worldGrenade). */
  grenade?: GrenadeSpec;
}

export const WEAPONS = ['grenade'] as const;
export type Weapon = (typeof WEAPONS)[number];

export const DEFAULT_PROJECTILE: Projectile = { shape: 'ball', size: 1.4, mass: null, speed: 40 };
const DEFAULT_DENSITY = 8;

/** Accepted ranges; parseProjectile rejects anything outside them. */
export const PROJECTILE_LIMITS = { size: [0.1, 20], mass: [0.01, 1e6], speed: [0, 500], restitution: [0, 1], friction: [0, 2], blockDensity: [1, 30000] } as const;
/** ball and cube, then the catalogue. */
export const PROJECTILE_KINDS: readonly string[] = ['ball', 'cube', ...PRESET_NAMES];

/**
 * The real density a scene block of density 1 stands for, kg/m^3: stone (STONE_DENSITY), but
 * pine for the Kapla planks (S15); a Keystone level's densities are its materials', with its
 * stone (625) standing for real stone.
 */
export function defaultBlockDensity(scenario: string, level: string | null): number {
  if (level) return STONE_DENSITY / 625;
  return scenario === 'S15' ? 450 : STONE_DENSITY;
}

/** What a projectile is in a world at this cube size (m per cube) whose blocks of density 1 stand for blockDensity kg/m^3. */
export interface WorldProjectile {
  shape: ShapeDesc;
  /** World units per second. */
  speed: number;
  /** In the scene's density units. */
  density: number;
  restitution: number;
  friction: number;
  /** A preset's colours (sRGB 0xrrggbb), null for ball and cube. */
  colour: { natural: number; candy: number } | null;
}

export function worldProjectile(p: Projectile, scale: number, blockDensity: number): WorldProjectile {
  const restitution = p.restitution ?? 0.1, friction = p.friction ?? 0.5;
  if (!p.preset) {
    const shape = projectileShape(p);
    return { shape, speed: p.speed / Math.sqrt(scale), density: p.mass === null ? DEFAULT_DENSITY : p.mass / volumeOf(shape), restitution, friction, colour: null };
  }
  const real = PROJECTILE_PRESETS[p.preset];
  const r = p.size / 2;
  const density = p.mass === null ? real.density : p.mass / ((4 / 3) * Math.PI * r ** 3);
  return { shape: { kind: 'sphere', radius: r / scale }, speed: p.speed / scale, density: density / blockDensity, restitution, friction, colour: { natural: real.colour, candy: real.candy } };
}

/** The projectile's bounding radius in the world, units. */
export const projectileRadius = (p: Projectile, scale = 1) => boundingRadius(worldProjectile(p, scale, STONE_DENSITY).shape);

export function projectileShape(p: Projectile): ShapeDesc {
  const h = p.size / 2;
  return p.shape === 'ball' ? { kind: 'sphere', radius: h } : { kind: 'box', half: [h, h, h] };
}

/** The projectile's mass in kg (a preset's real kg), whether set or from the default (its own) density. */
export function projectileMass(p: Projectile): number {
  if (p.mass !== null) return p.mass;
  return (p.preset ? PROJECTILE_PRESETS[p.preset].density : DEFAULT_DENSITY) * volumeOf(projectileShape(p));
}

/** Fired from origin along the unit vector dir, starting just clear of the camera (a projectile at cube edge 1 m: worldBody for others). */
export function projectileBody(p: Projectile, origin: V3, dir: V3): BodyDesc {
  return worldBody(worldProjectile(p, 1, STONE_DENSITY), origin, dir);
}

/** A world projectile fired from origin along the unit vector dir, starting just clear of the camera. */
export function worldBody(w: WorldProjectile, origin: V3, dir: V3): BodyDesc {
  const ahead = Math.max(2, boundingRadius(w.shape) + 1);
  return {
    shape: w.shape,
    pos: [origin[0] + dir[0] * ahead, origin[1] + dir[1] * ahead, origin[2] + dir[2] * ahead],
    rot: [0, 0, 0, 1],
    linVel: [dir[0] * w.speed, dir[1] * w.speed, dir[2] * w.speed],
    angVel: [0, 0, 0],
    density: w.density,
    friction: w.friction,
    restitution: w.restitution,
    tag: TAG_BALL,
  };
}

/** The grenade's URL keys (grenade.<key>) and where each lives in a GrenadeSpec; ground is 0 or 1, fuse a word. */
export const GRENADE_NUMBERS = ['delay', 'prox', 'arm'] as const;
export const GRENADE_BLAST_KEYS = Object.keys(DEFAULT_GRENADE.blast) as (keyof GrenadeBlast)[];

/** A grenade from URL keys grenade.*, absent keys at DEFAULT_GRENADE; checked (checkGrenade). */
export function parseGrenade(q: URLSearchParams): GrenadeSpec {
  const num = (key: string, fallback: number) => {
    const raw = q.get(`grenade.${key}`);
    if (raw === null) return fallback;
    const v = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(v)) throw new Error(`grenade.${key} must be a number: ${raw}`);
    return v;
  };
  const fuse = q.get('grenade.fuse') ?? DEFAULT_GRENADE.fuse;
  if (!FUSES.includes(fuse as Fuse)) throw new Error(`grenade.fuse must be one of ${FUSES.join(', ')}: ${fuse}`);
  const ground = q.get('grenade.ground');
  if (ground !== null && ground !== '0' && ground !== '1') throw new Error(`grenade.ground must be 0 or 1: ${ground}`);
  const g: GrenadeSpec = {
    fuse: fuse as Fuse,
    delay: num('delay', DEFAULT_GRENADE.delay), prox: num('prox', DEFAULT_GRENADE.prox), arm: num('arm', DEFAULT_GRENADE.arm),
    ground: ground === null ? DEFAULT_GRENADE.ground : ground === '1',
    blast: Object.fromEntries(GRENADE_BLAST_KEYS.map((k) => [k, num(k, DEFAULT_GRENADE.blast[k])])) as unknown as GrenadeBlast,
  };
  return checkGrenade(g);
}

/** Writes the grenade's fields that differ from DEFAULT_GRENADE. */
export function writeGrenade(g: GrenadeSpec, q: URLSearchParams): void {
  if (g.fuse !== DEFAULT_GRENADE.fuse) q.set('grenade.fuse', g.fuse);
  for (const k of GRENADE_NUMBERS) if (g[k] !== DEFAULT_GRENADE[k]) q.set(`grenade.${k}`, String(g[k]));
  if (g.ground !== DEFAULT_GRENADE.ground) q.set('grenade.ground', g.ground ? '1' : '0');
  for (const k of GRENADE_BLAST_KEYS) if (g.blast[k] !== DEFAULT_GRENADE.blast[k]) q.set(`grenade.${k}`, String(g.blast[k]));
}

/**
 * A grenade for a world at this scale and substeps (ViewerConfig.scale, substeps): its speeds
 * froudeSpeed times as fast, as the projectile's (impulse and maxDv), and its speed cap, a
 * fraction of the sweep limit per step, substeps times as high. Lengths and times stay as set.
 */
export function worldGrenade(g: GrenadeSpec, froude: number, substeps: number): GrenadeSpec {
  if (froude === 1 && substeps === 1) return g;
  return { ...g, blast: { ...g.blast, impulse: g.blast.impulse * froude, maxDv: g.blast.maxDv * froude, maxSpeed: g.blast.maxSpeed * substeps } };
}

/** The fields a preset starts from: its real size and speed, its own density (mass null), bounce and friction. */
export function presetProjectile(name: PresetName): Projectile {
  const r = PROJECTILE_PRESETS[name];
  return { shape: 'ball', size: r.diameter, mass: null, speed: r.speed, preset: name, restitution: r.restitution, friction: r.friction };
}

/** From URL keys proj (ball | cube | a preset), proj.size, proj.mass, proj.speed, proj.restitution, proj.friction, proj.blockDensity, proj.weapon and grenade.*; absent keys keep the defaults (a preset's own). */
export function parseProjectile(q: URLSearchParams): Projectile {
  const kind = q.get('proj') ?? DEFAULT_PROJECTILE.shape;
  if (!PROJECTILE_KINDS.includes(kind)) throw new Error(`proj must be one of ${PROJECTILE_KINDS.join(', ')}: ${kind}`);
  const base = isPreset(kind) ? presetProjectile(kind) : { ...DEFAULT_PROJECTILE, shape: kind as Projectile['shape'] };
  const num = (key: keyof typeof PROJECTILE_LIMITS) => {
    const raw = q.get(`proj.${key}`);
    if (raw === null || raw === '') return undefined;
    const v = Number(raw), [lo, hi] = PROJECTILE_LIMITS[key];
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`proj.${key} must be a number from ${lo} to ${hi}: ${raw}`);
    return v;
  };
  const p: Projectile = { ...base, size: num('size') ?? base.size, mass: num('mass') ?? base.mass, speed: num('speed') ?? base.speed };
  for (const k of ['restitution', 'friction', 'blockDensity'] as const) {
    const v = num(k);
    if (v !== undefined) p[k] = v;
  }
  const weapon = q.get('proj.weapon');
  if (weapon !== null && !WEAPONS.includes(weapon as Weapon)) throw new Error(`proj.weapon must be ${WEAPONS.join(' or ')}: ${weapon}`);
  const grenadeKeys = [...q.keys()].filter((k) => k.startsWith('grenade.'));
  if (weapon !== 'grenade') {
    if (grenadeKeys.length) throw new Error(`${grenadeKeys[0]} applies to proj.weapon=grenade`);
    return p;
  }
  const known = new Set(['fuse', 'ground', ...GRENADE_NUMBERS, ...GRENADE_BLAST_KEYS].map((k) => `grenade.${k}`));
  const unknown = grenadeKeys.find((k) => !known.has(k));
  if (unknown) throw new Error(`unknown key ${unknown}; known: ${[...known].join(', ')}`);
  return { ...p, weapon, grenade: parseGrenade(q) };
}

/** Writes the fields that differ from the defaults (a preset's own). */
export function writeProjectile(p: Projectile, q: URLSearchParams): void {
  const base = p.preset ? presetProjectile(p.preset) : DEFAULT_PROJECTILE;
  if ((p.preset ?? p.shape) !== DEFAULT_PROJECTILE.shape) q.set('proj', p.preset ?? p.shape);
  if (p.size !== base.size) q.set('proj.size', String(p.size));
  if (p.mass !== null) q.set('proj.mass', String(p.mass));
  if (p.speed !== base.speed) q.set('proj.speed', String(p.speed));
  for (const k of ['restitution', 'friction'] as const) if (p[k] !== undefined && p[k] !== base[k]) q.set(`proj.${k}`, String(p[k]));
  if (p.blockDensity !== undefined) q.set('proj.blockDensity', String(p.blockDensity));
  if (p.weapon) q.set('proj.weapon', p.weapon);
  if (p.weapon === 'grenade') writeGrenade(p.grenade ?? DEFAULT_GRENADE, q);
}

/**
 * Largest bounding radius a body pushed into an engine built from spec (after engineSpec) for
 * scene may have. Only the GPU engine has one: it sizes its broadphase cells at init for the
 * larger of maxRadius and every scene body and input (GpuAvbdEngine.init). Infinity elsewhere.
 */
export function pushRadiusLimit(spec: string, scene: SceneDesc): number {
  const { name, options } = parseSpec(spec);
  if (name !== 'avbd-gpu') return Infinity;
  const all = [...scene.bodies, ...spawnedBodies(scene.inputs)];
  return all.reduce((m, b) => Math.max(m, boundingRadius(b.shape)), typeof options.maxRadius === 'number' ? options.maxRadius : 0);
}
