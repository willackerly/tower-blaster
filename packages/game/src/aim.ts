// Aiming: pick the point under the cursor, turn it into a quantised shot,
// and preview the shot's arc. The launcher follows the camera around the
// ring, so the player always shoots away from the eye.
import type { Quat, Snapshot, Vec3 } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { aimAt, type AmmoKind, type CompiledLevel, GRAVITY, predictArc, type Shot, shotToSpawn } from '@tb/keystone';

/**
 * Substeps per step for the arc, when the engine doesn't report them
 * (EngineInfo.integrator): Rapier's default of one per solver iteration.
 */
export const SUBSTEPS = 4;
/** A target the arc misses by more than this (m) is out of reach at this power. */
export const REACH = 0.15;

/**
 * Launcher azimuth quanta (0.5 deg) for an orbit camera at `yaw`. The orbit
 * eye sits at target + d (sin yaw, ., cos yaw) and the launcher at centre +
 * r (cos a, sin a), so a = 90 deg - yaw puts the launcher behind the camera.
 */
export function azFromYaw(yaw: number): number {
  const deg = 90 - (yaw * 180) / Math.PI;
  return ((Math.round(deg * 2) % 720) + 720) % 720;
}

export interface Ray { origin: Vec3; dir: Vec3 }
export interface Hit { body: number; t: number; point: Vec3; normal: Vec3 }

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Ray against an oriented box (slab test in the box frame): entry distance and world normal. */
export function rayBox(r: Ray, pos: Vec3, rot: Quat, half: Vec3): { t: number; normal: Vec3 } | null {
  const inv = conj(rot);
  const o = rotate(inv, [r.origin[0] - pos[0], r.origin[1] - pos[1], r.origin[2] - pos[2]]);
  const d = rotate(inv, r.dir);
  let tIn = -Infinity, tOut = Infinity, axis = -1, sign = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) {
      if (Math.abs(o[k]!) > half[k]!) return null;
      continue;
    }
    const a = (-half[k]! - o[k]!) / d[k]!, b = (half[k]! - o[k]!) / d[k]!;
    const t0 = Math.min(a, b), t1 = Math.max(a, b);
    if (t0 > tIn) { tIn = t0; axis = k; sign = d[k]! > 0 ? -1 : 1; }
    tOut = Math.min(tOut, t1);
    if (tIn > tOut) return null;
  }
  if (tOut < 0 || axis < 0) return null;
  const n: Vec3 = [0, 0, 0];
  n[axis] = sign;
  return { t: Math.max(0, tIn), normal: rotate(rot, n) };
}

export function raySphere(r: Ray, c: Vec3, radius: number): number | null {
  const o: Vec3 = [r.origin[0] - c[0], r.origin[1] - c[1], r.origin[2] - c[2]];
  const b = o[0] * r.dir[0] + o[1] * r.dir[1] + o[2] * r.dir[2];
  const disc = b * b - (o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - radius * radius);
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -b + Math.sqrt(disc) >= 0 ? 0 : null;
}

/**
 * Nearest structure body under the ray (ammo is never a target), or the
 * ground plane (body -1) if the ray hits no body.
 */
export function pick(r: Ray, s: Snapshot, c: CompiledLevel, groundY = 0): Hit | null {
  let best: Hit | null = null;
  const n = Math.min(c.meta.n, s.count);
  for (let i = 0; i < n; i++) {
    const half = (c.scene.bodies[i]!.shape as { half: Vec3 }).half;
    const pos: Vec3 = [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!];
    // Cheap reject on the bounding sphere first.
    if (raySphere(r, pos, Math.hypot(...half)) === null) continue;
    const h = rayBox(r, pos, [s.rot[4 * i]!, s.rot[4 * i + 1]!, s.rot[4 * i + 2]!, s.rot[4 * i + 3]!], half);
    if (h && (!best || h.t < best.t)) best = { body: i, t: h.t, normal: h.normal, point: [r.origin[0] + r.dir[0] * h.t, r.origin[1] + r.dir[1] * h.t, r.origin[2] + r.dir[2] * h.t] };
  }
  if (best) return best;
  if (r.dir[1] >= -1e-9) return null;
  const t = (groundY - r.origin[1]) / r.dir[1];
  return t >= 0 ? { body: -1, t, normal: [0, 1, 0], point: [r.origin[0] + r.dir[0] * t, groundY, r.origin[2] + r.dir[2] * t] } : null;
}

export interface Aimed { shot: Shot; error: number; reachable: boolean }

/** The quantised shot of `ammo` that best reaches `target` from azimuth `az` at `power`. */
export function shotFor(c: CompiledLevel, ammo: AmmoKind, az: number, power: number, target: Vec3, substeps = SUBSTEPS): Aimed | null {
  const f = c.frame, ph = f.pitch * f.unit;
  if (ammo === 'drop') {
    const shot: Shot = { ammo, x: Math.round((4 * target[0]) / ph), z: Math.round((4 * target[2]) / ph) };
    const err = Math.hypot((shot.x / 4) * ph - target[0], (shot.z / 4) * ph - target[2]);
    return { shot, error: err, reachable: true };
  }
  if (ammo === 'cue') return null; // no starter level racks a cue yet
  const a = aimAt(f, ammo, { az, y: Math.round(f.launcher.y * 4), power }, target, { substeps });
  return { shot: a.shot, error: a.error, reachable: a.error <= REACH };
}

/**
 * Bead positions along a shot's predicted flight, ending where it passes
 * closest to `target` (or where it reaches the ground): packed xyz.
 */
export function previewBeads(c: CompiledLevel, shot: Shot, target: Vec3, substeps = SUBSTEPS, maxBeads = 40, every = 2): Float64Array {
  const ev = shotToSpawn(c.frame, shot, 0);
  if (shot.ammo === 'drop') {
    const top = ev.body.pos[1], bottom = Math.min(top, target[1]), n = Math.min(maxBeads, Math.max(2, Math.ceil((top - bottom) / 0.3)));
    const out = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) out.set([ev.body.pos[0], top - ((top - bottom) * k) / (n - 1), ev.body.pos[2]], 3 * k);
    return out;
  }
  const steps = 240, arc = predictArc(ev, [0, -GRAVITY, 0], c.scene.dt, steps, substeps);
  // Last step before the arc starts moving away from the target, or hits the ground.
  let end = steps, best = Infinity;
  for (let k = 0; k <= steps; k++) {
    if (arc[3 * k + 1]! < 0) { end = k; break; }
    const d = Math.hypot(arc[3 * k]! - target[0], arc[3 * k + 1]! - target[1], arc[3 * k + 2]! - target[2]);
    if (d < best) { best = d; end = k; } else if (d > best + 0.5) break;
  }
  const idx: number[] = [];
  for (let k = 0; k <= end; k += every) idx.push(k);
  if (idx.at(-1) !== end) idx.push(end);
  const pick = idx.length > maxBeads ? idx.filter((_, i) => i % Math.ceil(idx.length / maxBeads) === 0 || i === idx.length - 1) : idx;
  const out = new Float64Array(3 * pick.length);
  pick.forEach((k, i) => out.set(arc.subarray(3 * k, 3 * k + 3), 3 * i));
  return out;
}
