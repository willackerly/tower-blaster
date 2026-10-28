// Shots. Every player action is a quantised integer record, so a session is
// replayed exactly from (level, shots) and a shot fits in a few bytes. A shot
// becomes one engine spawn event; nothing else about the engine is touched.
import { type BodyDesc, massOf, type SpawnEvent, TAG_BALL, type Vec3 } from '@tb/engine-api';
import { GRAVITY, MATERIALS, materialId, type MaterialName } from './materials.ts';

export type AmmoKind = 'marble' | 'cannonball' | 'cue' | 'drop';
export const AMMO_KINDS: readonly AmmoKind[] = ['marble', 'cannonball', 'cue', 'drop'];

export interface AmmoSpec {
  /** Sphere radius, or box half-extents along (+x, y, z) before turning, in h. */
  size: { radius: number } | { half: Vec3 };
  material: MaterialName;
  /** Launch speed range in m/s, mapped linearly from power 0..100. */
  vMin: number;
  vMax: number;
}

export const AMMO: Record<AmmoKind, AmmoSpec> = {
  // The scalpel: knocks out or shoves one cube.
  marble: { size: { radius: 0.2 }, material: 'steel', vMin: 5, vMax: 15 },
  // Brute force: about 7x the marble's energy, so it costs leverage.
  cannonball: { size: { radius: 0.5 }, material: 'steel', vMin: 5, vMax: 12 },
  // The Jenga push: a rod fired along its own axis at a face.
  cue: { size: { half: [1.2, 0.1, 0.1] }, material: 'steel', vMin: 1.5, vMax: 5 },
  // An anvil released at rest above the structure.
  drop: { size: { half: [0.4, 0.4, 0.4] }, material: 'steel', vMin: 0, vMax: 0 },
};

/** Fired from the launcher ring: az in 0.5 deg, y in 1/4 h, yaw and pitch in 0.1 deg, power in %. */
export interface LaunchShot { ammo: 'marble' | 'cannonball'; az: number; y: number; yaw: number; pitch: number; power: number }
/** A cue tip at (x, y, z) in 1/4 cells, pushing along +x, -x, +z or -z. */
export interface CueShot { ammo: 'cue'; x: number; y: number; z: number; dir: 0 | 1 | 2 | 3; power: number }
/** An anvil released above (x, z) in 1/4 cells. */
export interface DropShot { ammo: 'drop'; x: number; z: number }
export type Shot = LaunchShot | CueShot | DropShot;

/** Where a level's shots come from; lengths in h, horizontal ones in cells. */
export interface LauncherDef { radius: number; y: number; dropY: number }

/** The level frame a shot needs: metres per h, horizontal cell pitch, lot centre and launcher. */
export interface ShotFrame { unit: number; pitch: number; centre: [number, number]; launcher: LauncherDef }

const DEG = Math.PI / 180;
const CUE_STANDOFF = 0.1; // h between the rod tip and the target point at spawn

export const speedOf = (ammo: AmmoKind, power: number) => AMMO[ammo].vMin + ((AMMO[ammo].vMax - AMMO[ammo].vMin) * power) / 100;

function assertInt(name: string, v: number, lo: number, hi: number) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`shot.${name} = ${v}, want an integer in [${lo}, ${hi}]`);
}

export function checkShot(s: Shot): void {
  if (s.ammo === 'drop') { assertInt('x', s.x, -4000, 4000); assertInt('z', s.z, -4000, 4000); return; }
  assertInt('power', s.power, 0, 100);
  if (s.ammo === 'cue') {
    assertInt('x', s.x, -4000, 4000); assertInt('y', s.y, 0, 4000); assertInt('z', s.z, -4000, 4000); assertInt('dir', s.dir, 0, 3);
    return;
  }
  assertInt('az', s.az, 0, 719); assertInt('y', s.y, 0, 4000); assertInt('yaw', s.yaw, -1800, 1800); assertInt('pitch', s.pitch, -890, 890);
}

/** Each ammo's fields after its name in shot text (writeShots), in this order. */
const SHOT_FIELDS: Record<AmmoKind, readonly string[]> = {
  marble: ['az', 'y', 'yaw', 'pitch', 'power'],
  cannonball: ['az', 'y', 'yaw', 'pitch', 'power'],
  cue: ['x', 'y', 'z', 'dir', 'power'],
  drop: ['x', 'z'],
};

/**
 * Shots as URL-safe text, for sharing a line: `ammo.f1.f2...` per shot (fields in SHOT_FIELDS
 * order, integers as the shot holds them), shots joined by `_`; e.g. `cannonball.60.8.0.20.95_drop.4.-8`.
 */
export function writeShots(shots: readonly Shot[]): string {
  return shots.map((s) => [s.ammo, ...SHOT_FIELDS[s.ammo].map((k) => (s as unknown as Record<string, number>)[k])].join('.')).join('_');
}

/** The shots writeShots wrote, each checked (checkShot); throws naming the shot at fault. Empty text is no shots. */
export function readShots(text: string): Shot[] {
  if (text === '') return [];
  return text.split('_').map((part, i) => {
    const [ammo, ...vals] = part.split('.');
    const where = `shot ${i + 1} (${part})`;
    if (!AMMO_KINDS.includes(ammo as AmmoKind)) throw new Error(`${where}: ammo must be one of ${AMMO_KINDS.join(', ')}`);
    const fields = SHOT_FIELDS[ammo as AmmoKind];
    if (vals.length !== fields.length) throw new Error(`${where}: ${ammo} takes ${fields.length} fields (${fields.join('.')}), got ${vals.length}`);
    const shot: Record<string, unknown> = { ammo };
    fields.forEach((k, j) => {
      if (!/^-?\d+$/.test(vals[j]!)) throw new Error(`${where}: ${k} must be an integer, not ${vals[j] || 'empty'}`);
      shot[k] = Number(vals[j]);
    });
    try { checkShot(shot as unknown as Shot); } catch (e) { throw new Error(`${where}: ${(e as Error).message}`); }
    return shot as unknown as Shot;
  });
}

/** Launcher position in metres for azimuth quanta az at height quanta y. */
export function launcherPos(f: ShotFrame, az: number, y: number): Vec3 {
  const a = az * 0.5 * DEG, r = f.launcher.radius * f.pitch * f.unit;
  return [f.centre[0] + r * Math.cos(a), (y / 4) * f.unit, f.centre[1] + r * Math.sin(a)];
}

/** Unit launch direction: toward the lot centre, turned by yaw, raised by pitch. */
export function launchDir(az: number, yaw: number, pitch: number): Vec3 {
  const th = az * 0.5 * DEG + Math.PI + yaw * 0.1 * DEG, ph = pitch * 0.1 * DEG;
  return [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
}

const CUE_DIRS: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

export function ammoBody(kind: AmmoKind, unit: number, pos: Vec3, vel: Vec3, alongZ = false): BodyDesc {
  const spec = AMMO[kind], m = MATERIALS[materialId(spec.material)]!;
  const shape: BodyDesc['shape'] = 'radius' in spec.size
    ? { kind: 'sphere', radius: spec.size.radius * unit }
    : { kind: 'box', half: (alongZ ? [spec.size.half[2], spec.size.half[1], spec.size.half[0]] : spec.size.half).map((x) => x * unit) as Vec3 };
  return { shape, pos, rot: [0, 0, 0, 1], linVel: vel, angVel: [0, 0, 0], density: m.density, friction: m.friction, restitution: m.restitution, tag: TAG_BALL };
}

/** The spawn event for a shot fired at engine step `step`. */
export function shotToSpawn(f: ShotFrame, shot: Shot, step: number): SpawnEvent {
  checkShot(shot);
  const h = f.unit, ph = f.pitch * h;
  let body: BodyDesc;
  if (shot.ammo === 'drop') {
    body = ammoBody('drop', h, [(shot.x / 4) * ph, f.launcher.dropY * h, (shot.z / 4) * ph], [0, 0, 0]);
  } else if (shot.ammo === 'cue') {
    const d = CUE_DIRS[shot.dir]!, half = (AMMO.cue.size as { half: Vec3 }).half[0];
    const tip: Vec3 = [(shot.x / 4) * ph, (shot.y / 4) * h, (shot.z / 4) * ph];
    const back = (half + CUE_STANDOFF) * h, v = speedOf('cue', shot.power);
    body = ammoBody('cue', h, [tip[0] - d[0] * back, tip[1], tip[2] - d[2] * back], [d[0] * v, 0, d[2] * v], shot.dir >= 2);
  } else {
    const p = launcherPos(f, shot.az, shot.y), d = launchDir(shot.az, shot.yaw, shot.pitch), v = speedOf(shot.ammo, shot.power);
    body = ammoBody(shot.ammo, h, p, [d[0] * v, d[1] * v, d[2] * v]);
  }
  return { step, kind: 'spawn', body };
}

/** Energy the player spent on a shot: kinetic at launch, or potential above the ground for a drop. */
export function ammoKE(ev: SpawnEvent): number {
  const b = ev.body, m = massOf(b), v = b.linVel;
  return 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) + (b.linVel.every((x) => x === 0) ? m * GRAVITY * b.pos[1] : 0);
}

/**
 * Free flight of a spawned body under gravity: positions at the spawn and
 * after each of `steps` fixed steps, with semi-implicit Euler (v += g dt,
 * then x += v dt) over `substeps` equal substeps per step. Engines differ
 * here: Rapier substeps once per solver iteration (4 by default), which puts
 * a single-substep prediction 6 cm off after one second.
 */
export function predictArc(ev: SpawnEvent, g: Vec3, dt: number, steps: number, substeps = 1): Float64Array {
  const out = new Float64Array(3 * (steps + 1));
  const x = [...ev.body.pos], v = [...ev.body.linVel], h = dt / substeps;
  out.set(x, 0);
  for (let n = 1; n <= steps; n++) {
    for (let s = 0; s < substeps; s++) for (let k = 0; k < 3; k++) { v[k]! += g[k]! * h; x[k]! += v[k]! * h; }
    out.set(x, 3 * n);
  }
  return out;
}

/** Closest distance from a polyline (packed xyz) to a point. */
export function closestApproach(arc: Float64Array, p: Vec3): number {
  let best = Infinity;
  for (let i = 0; i + 5 < arc.length; i += 3) {
    const ax = arc[i]!, ay = arc[i + 1]!, az = arc[i + 2]!;
    const dx = arc[i + 3]! - ax, dy = arc[i + 4]! - ay, dz = arc[i + 5]! - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1], az + t * dz - p[2]));
  }
  return best;
}

export interface Aim { shot: LaunchShot; error: number }

/**
 * Inverse ballistics: the quantised launch shot (at the given azimuth, height
 * and power) whose arc passes closest to `target`. Yaw is exact up to
 * quantisation; pitch is searched coarse-to-fine over [-45, 80] degrees,
 * preferring the flatter arc on ties. Unreachable targets return the closest miss.
 */
export function aimAt(f: ShotFrame, ammo: 'marble' | 'cannonball', at: { az: number; y: number; power: number }, target: Vec3, opts: { dt?: number; maxSteps?: number; substeps?: number } = {}): Aim {
  const dt = opts.dt ?? 1 / 60, maxSteps = opts.maxSteps ?? 240, substeps = opts.substeps ?? 1;
  const p = launcherPos(f, at.az, at.y);
  const th = Math.atan2(target[2] - p[2], target[0] - p[0]);
  let yaw = Math.round(((th - (at.az * 0.5 * DEG + Math.PI)) / DEG) * 10);
  yaw = ((((yaw + 1800) % 3600) + 3600) % 3600) - 1800;
  const g: Vec3 = [0, -GRAVITY, 0];
  const errorAt = new Map<number, number>();
  const err = (pitch: number) => {
    let e = errorAt.get(pitch);
    if (e === undefined) {
      const shot: LaunchShot = { ammo, az: at.az, y: at.y, yaw, pitch, power: at.power };
      e = closestApproach(predictArc(shotToSpawn(f, shot, 0), g, dt, maxSteps, substeps), target);
      errorAt.set(pitch, e);
    }
    return e;
  };
  // Coarse pass every degree, then every quantum around each local minimum:
  // about 300 arcs instead of 1,251, with the same answer for smooth error curves.
  const lo = -450, hi = 800, coarse: number[] = [];
  for (let p = lo; p <= hi; p += 10) coarse.push(p);
  coarse.forEach((p, i) => {
    const e = err(p);
    if (i > 0 && e > err(coarse[i - 1]!)) return;
    if (i + 1 < coarse.length && e > err(coarse[i + 1]!)) return;
    for (let q = Math.max(lo, p - 10); q <= Math.min(hi, p + 10); q++) err(q);
  });
  // Low and high arcs can both hit; take the flattest within 1 cm of the best.
  const min = Math.min(...errorAt.values());
  const pitch = [...errorAt.keys()].sort((a, b) => a - b).find((p) => errorAt.get(p)! <= min + 0.01)!;
  return { shot: { ammo, az: at.az, y: at.y, yaw, pitch, power: at.power }, error: errorAt.get(pitch)! };
}
