// What a click fires: a ball or a cube, its size, mass and launch speed,
// and optionally a weapon (a grenade: @tb/weapons). The defaults reproduce
// the viewer's original ball exactly (radius 0.7, density 8, 40 m/s), so a
// default setup fires the same body as before.
import { parseSpec } from '@tb/bench';
import { type BodyDesc, type SceneDesc, type ShapeDesc, spawnedBodies, TAG_BALL, volumeOf } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { checkGrenade, DEFAULT_GRENADE, FUSES, type Fuse, type GrenadeBlast, type GrenadeSpec } from '@tb/weapons';
import type { V3 } from './math.ts';

export interface Projectile {
  shape: 'ball' | 'cube';
  /** Diameter of a ball or edge of a cube, in metres (a scene cube is 1). */
  size: number;
  /** kg (a scene cube is 1); null = density 8, the original ball's. */
  mass: number | null;
  /** Launch speed, m/s. */
  speed: number;
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
export const PROJECTILE_LIMITS = { size: [0.1, 20], mass: [0.01, 1e6], speed: [0, 500] } as const;

export function projectileShape(p: Projectile): ShapeDesc {
  const h = p.size / 2;
  return p.shape === 'ball' ? { kind: 'sphere', radius: h } : { kind: 'box', half: [h, h, h] };
}

/** The projectile's mass in kg, whether set or from the default density. */
export function projectileMass(p: Projectile): number {
  return p.mass ?? DEFAULT_DENSITY * volumeOf(projectileShape(p));
}

/** Fired from origin along the unit vector dir, starting just clear of the camera. */
export function projectileBody(p: Projectile, origin: V3, dir: V3): BodyDesc {
  const shape = projectileShape(p);
  const ahead = Math.max(2, boundingRadius(shape) + 1);
  return {
    shape,
    pos: [origin[0] + dir[0] * ahead, origin[1] + dir[1] * ahead, origin[2] + dir[2] * ahead],
    rot: [0, 0, 0, 1],
    linVel: [dir[0] * p.speed, dir[1] * p.speed, dir[2] * p.speed],
    angVel: [0, 0, 0],
    density: p.mass === null ? DEFAULT_DENSITY : p.mass / volumeOf(shape),
    friction: 0.5,
    restitution: 0.1,
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

/** From URL keys proj (ball | cube), proj.size, proj.mass, proj.speed, proj.weapon and grenade.*; absent keys keep the defaults. */
export function parseProjectile(q: URLSearchParams): Projectile {
  const shape = q.get('proj') ?? DEFAULT_PROJECTILE.shape;
  if (shape !== 'ball' && shape !== 'cube') throw new Error(`proj must be ball or cube: ${shape}`);
  const num = (key: 'size' | 'mass' | 'speed', fallback: number | null) => {
    const raw = q.get(`proj.${key}`);
    if (raw === null || raw === '') return fallback;
    const v = Number(raw), [lo, hi] = PROJECTILE_LIMITS[key];
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`proj.${key} must be a number from ${lo} to ${hi}: ${raw}`);
    return v;
  };
  const p: Projectile = { shape, size: num('size', DEFAULT_PROJECTILE.size)!, mass: num('mass', null), speed: num('speed', DEFAULT_PROJECTILE.speed)! };
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

/** Writes the fields that differ from the defaults. */
export function writeProjectile(p: Projectile, q: URLSearchParams): void {
  if (p.shape !== DEFAULT_PROJECTILE.shape) q.set('proj', p.shape);
  if (p.size !== DEFAULT_PROJECTILE.size) q.set('proj.size', String(p.size));
  if (p.mass !== null) q.set('proj.mass', String(p.mass));
  if (p.speed !== DEFAULT_PROJECTILE.speed) q.set('proj.speed', String(p.speed));
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
