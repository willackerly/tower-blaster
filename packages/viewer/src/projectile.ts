// What a click fires: a ball or a cube, its size, mass and launch speed.
// The defaults reproduce the viewer's original ball exactly (radius 0.7,
// density 8, 40 m/s), so a default setup fires the same body as before.
import { parseSpec } from '@tb/bench';
import { type BodyDesc, type SceneDesc, type ShapeDesc, TAG_BALL, volumeOf } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import type { V3 } from './math.ts';

export interface Projectile {
  shape: 'ball' | 'cube';
  /** Diameter of a ball or edge of a cube, in metres (a scene cube is 1). */
  size: number;
  /** kg (a scene cube is 1); null = density 8, the original ball's. */
  mass: number | null;
  /** Launch speed, m/s. */
  speed: number;
}

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

/** From URL keys proj (ball | cube), proj.size, proj.mass and proj.speed; absent keys keep the defaults. */
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
  return { shape, size: num('size', DEFAULT_PROJECTILE.size)!, mass: num('mass', null), speed: num('speed', DEFAULT_PROJECTILE.speed)! };
}

/** Writes the fields that differ from the defaults. */
export function writeProjectile(p: Projectile, q: URLSearchParams): void {
  if (p.shape !== DEFAULT_PROJECTILE.shape) q.set('proj', p.shape);
  if (p.size !== DEFAULT_PROJECTILE.size) q.set('proj.size', String(p.size));
  if (p.mass !== null) q.set('proj.mass', String(p.mass));
  if (p.speed !== DEFAULT_PROJECTILE.speed) q.set('proj.speed', String(p.speed));
}

/**
 * Largest bounding radius a body pushed into an engine built from spec (after engineSpec) for
 * scene may have. Only the GPU engine has one: it sizes its broadphase cells at init for the
 * larger of maxRadius and every scene body and input (GpuAvbdEngine.init). Infinity elsewhere.
 */
export function pushRadiusLimit(spec: string, scene: SceneDesc): number {
  const { name, options } = parseSpec(spec);
  if (name !== 'avbd-gpu') return Infinity;
  const all = [...scene.bodies, ...scene.inputs.map((e) => e.body)];
  return all.reduce((m, b) => Math.max(m, boundingRadius(b.shape)), typeof options.maxRadius === 'number' ? options.maxRadius : 0);
}
