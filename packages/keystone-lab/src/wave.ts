// Wavefront (M6) helpers for the lab and its tests: aiming a push at a tower or a
// domino from the launcher ring, and the body groups wavePlay times.
import type { Vec3 } from '@tb/engine-api';
import { aimAt, type CompiledLevel, type LaunchItem, type LaunchShot, type LevelDef } from '@tb/keystone';

/**
 * The launch shot of `ammo` at `power` that hits `target` (metres) travelling along `dir` (a horizontal unit
 * vector, the way the push should knock it), fired from the point of the launcher ring behind the target on that
 * line, `y` quarter h up. Throws when the ring does not reach behind the target or the aim misses by over 5 cm.
 */
export function pushShot(c: CompiledLevel, target: Vec3, dir: [number, number], ammo: LaunchItem = 'cannonball', power = 30, y = 24): LaunchShot {
  const f = c.frame, R = f.launcher.radius * f.pitch * f.unit, cx = target[0] - f.centre[0], cz = target[2] - f.centre[1];
  // |c - t d| = R for t > 0: t^2 - 2 t (c.d) + |c|^2 - R^2 = 0.
  const b = cx * dir[0] + cz * dir[1], disc = b * b - (cx * cx + cz * cz - R * R);
  if (disc < 0) throw new Error('pushShot: the ring does not reach behind the target');
  const t = b + Math.sqrt(disc), px = cx - t * dir[0], pz = cz - t * dir[1];
  const az = ((Math.round((Math.atan2(pz, px) * 180) / Math.PI / 0.5) % 720) + 720) % 720;
  // The least power from `power` up (steps of 5) whose arc reaches the target: a soft push tips a tower, a hard one blows its top off.
  let best = { error: Infinity, shot: null as LaunchShot | null };
  for (let pw = power; pw <= 100; pw += 5) {
    const a = aimAt(f, ammo, { az, y, power: pw }, target);
    if (a.error < best.error) best = { error: a.error, shot: a.shot as LaunchShot };
    if (a.error <= 0.05) return a.shot as LaunchShot;
  }
  throw new Error(`pushShot: the aim misses ${target.map((v) => v.toFixed(2))} by ${best.error.toFixed(3)} m from az ${az} at any power from ${power}`);
}

/** The body groups of a level's parts (one group per part, in part order): what wavePlay times as towers or runs. */
export function partGroups(c: CompiledLevel): number[][] {
  const out: number[][] = c.def.parts.map(() => []);
  for (let i = 0; i < c.meta.n; i++) out[c.meta.part[i]!]!.push(i);
  return out;
}

/** A tower part's face centre at `frac` of its height, in metres: the point a push along dir hits (the face it meets first). */
export function towerFace(c: CompiledLevel, def: LevelDef, part: number, dir: [number, number], frac = 0.75): Vec3 {
  const p = def.parts[part]!;
  if (p.kind !== 'block') throw new Error(`towerFace: part ${part} is a ${p.kind}`);
  const ph = c.frame.pitch * c.frame.unit, h = c.frame.unit;
  // A block's cell (i, j) is centred at (at + i + 0.5) * pitch (level.ts compileLevel); its cubes are h wide.
  const x0 = (p.at[0] + 0.5) * ph - 0.5 * h, x1 = (p.at[0] + p.size[0] - 0.5) * ph + 0.5 * h, z0 = (p.at[2] + 0.5) * ph - 0.5 * h, z1 = (p.at[2] + p.size[2] - 0.5) * ph + 0.5 * h;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, y = (p.at[1] + frac * p.size[1]) * h;
  return [dir[0] > 0 ? x0 : dir[0] < 0 ? x1 : mx, y, dir[1] > 0 ? z0 : dir[1] < 0 ? z1 : mz];
}
