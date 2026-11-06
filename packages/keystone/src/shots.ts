// Shots. Every player action is a quantised integer record, so a session is
// replayed exactly from (level, shots) and a shot fits in a few bytes. A shot
// becomes one engine spawn event; nothing else about the engine is touched.
import { type BodyDesc, massOf, type RemoveEvent, type SpawnEvent, TAG_BALL, type Vec3 } from '@tb/engine-api';
import { GRAVITY } from './materials.ts';
import { AMMO, isRackItem, type ItemFrame, type ItemSpec, itemSpec, type LaunchItem, PLUNGER, PULL, RACK_ITEM_NAMES, type RackItem, speedOf } from './rack.ts';

/**
 * Fired from the launcher ring: az in 0.5 deg, y in 1/4 h, yaw and pitch in 0.1 deg, power in %.
 * Any launch item (marble, cannonball, p-<preset>, w-<weapon>; rack.ts) takes the same fields.
 */
export interface LaunchShot { ammo: LaunchItem; az: number; y: number; yaw: number; pitch: number; power: number }
/** A cue tip at (x, y, z) in 1/4 cells, pushing along +x, -x, +z or -z. */
export interface CueShot { ammo: 'cue'; x: number; y: number; z: number; dir: 0 | 1 | 2 | 3; power: number }
/** An anvil released above (x, z) in 1/4 cells. */
export interface DropShot { ammo: 'drop'; x: number; z: number }
/**
 * Take structure body `body` (its engine id) out of the world: an engine remove event, nothing
 * fired (Undercut, docs/game/undercut-bullet-time.md). Session.fire refuses crowns, heritage and
 * bodies already pulled.
 */
export interface PullShot { ammo: 'pull'; body: number }
/**
 * Press the plunger (docs/design/charges.md): a timeline of the level's charges, each [charge, delay]:
 * charge LevelDef.charges[charge] is armed `delay` engine steps after the shot goes in (its clock
 * starts there; a cutter goes off at once). Pairs go in in this order, which decides the order of
 * two charges' events at the same step. Session.fire refuses charges armed before, armed at start,
 * named twice, or past the level's charges, and delays at or past the settle cap.
 */
export interface PlungerShot { ammo: 'plunger'; fuse: [number, number][] }

/** Most charges one plunger sets off. */
export const MAX_TIMELINE = 16;
/** Longest delay a plunger may give a charge, steps (60 s at 60 Hz; the settle cap binds first: Session.plungerRefusal). */
export const MAX_FUSE_DELAY = 3600;
/** Most charges a level may hold (LevelDef.charges). */
export const MAX_CHARGES = 32;

/** Most structure bodies a pull can name (ids 0 to MAX_PULL_BODY): past any level the engines hold. */
export const MAX_PULL_BODY = 1_000_000;

/**
 * When a shot goes in. Absent: once the session is aiming (the shot before has settled), as every
 * shot did before rapid fire. `after`: that many engine steps after the shot before was fired, while
 * it is still running (rapid fire; Session.fire); a replay fires it there, or at once if the shot
 * before has settled by then (nothing steps while aiming, so no time passes); on a line's first
 * shot it changes nothing. Written `@after` at the end of the shot in text (writeShots).
 */
export interface ShotTiming { after?: number }
export type Shot = (LaunchShot | CueShot | DropShot | PullShot | PlungerShot) & ShotTiming;

/** The most steps a shot's `after` may name: about 4.6 hours at 60 Hz, past any shot's settle cap. */
export const MAX_AFTER = 1_000_000;

/** Where a level's shots come from; lengths in h, horizontal ones in cells. */
export interface LauncherDef { radius: number; y: number; dropY: number }

/**
 * The level frame a shot needs: metres per h, horizontal cell pitch, lot centre and launcher, and
 * the shells of the rack's weapons by item name (compileLevel; rack.ts itemSpec).
 */
export interface ShotFrame { unit: number; pitch: number; centre: [number, number]; launcher: LauncherDef; shells?: Readonly<Record<string, ItemSpec>> }

const DEG = Math.PI / 180;
const CUE_STANDOFF = 0.1; // h between the rod tip and the target point at spawn

function assertInt(name: string, v: number, lo: number, hi: number) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`shot.${name} = ${v}, want an integer in [${lo}, ${hi}]`);
}

export function checkShot(s: Shot): void {
  if (!isRackItem(s.ammo)) throw new Error(`shot.ammo = ${JSON.stringify(s.ammo)}, want one of ${RACK_ITEM_NAMES}`);
  if (s.after !== undefined) assertInt('after', s.after, 0, MAX_AFTER);
  if (s.ammo === 'drop') { assertInt('x', s.x, -4000, 4000); assertInt('z', s.z, -4000, 4000); return; }
  if (s.ammo === PULL) { assertInt('body', s.body, 0, MAX_PULL_BODY); return; }
  if (s.ammo === PLUNGER) {
    if (!Array.isArray(s.fuse) || s.fuse.length < 1 || s.fuse.length > MAX_TIMELINE) throw new Error(`shot.fuse must list 1 to ${MAX_TIMELINE} [charge, delay] pairs`);
    s.fuse.forEach((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) throw new Error(`shot.fuse.${i} must be [charge, delay]`);
      assertInt(`fuse.${i}.charge`, p[0], 0, MAX_CHARGES - 1); assertInt(`fuse.${i}.delay`, p[1], 0, MAX_FUSE_DELAY);
    });
    return;
  }
  assertInt('power', s.power, 0, 100);
  if (s.ammo === 'cue') {
    assertInt('x', s.x, -4000, 4000); assertInt('y', s.y, 0, 4000); assertInt('z', s.z, -4000, 4000); assertInt('dir', s.dir, 0, 3);
    return;
  }
  assertInt('az', s.az, 0, 719); assertInt('y', s.y, 0, 4000); assertInt('yaw', s.yaw, -1800, 1800); assertInt('pitch', s.pitch, -890, 890);
}

const LAUNCH_FIELDS = ['az', 'y', 'yaw', 'pitch', 'power'] as const;
/**
 * An item's fields after its name in shot text (writeShots), in this order: every launch item's are
 * LaunchShot's. A plunger's are its fuse pairs, charge then delay, as many as it has (none listed here).
 */
export const shotFields = (ammo: RackItem): readonly string[] => (ammo === 'drop' ? ['x', 'z'] : ammo === 'cue' ? ['x', 'y', 'z', 'dir', 'power'] : ammo === PULL ? ['body'] : ammo === PLUNGER ? [] : LAUNCH_FIELDS);

/** The integers after a shot's name in text: its fields, or a plunger's fuse pairs flattened. */
const shotValues = (s: Shot): number[] => (s.ammo === PLUNGER ? s.fuse.flat() : shotFields(s.ammo).map((k) => (s as unknown as Record<string, number>)[k]!));

/**
 * Shots as URL-safe text, for sharing a line: `ammo.f1.f2...` per shot (fields in SHOT_FIELDS
 * order, integers as the shot holds them), shots joined by `_`; e.g. `cannonball.60.8.0.20.95_drop.4.-8`, `pull.17` or
 * `p-wreckingball.60.8.0.20.95_w-grenade.120.4.0.35.80`. Item names never hold `.` or `_` (rack.ts).
 * A rapid-fire shot ends `@after` (ShotTiming): `w-grenade.120.4.0.35.80@12` went in 12 steps after
 * the shot before it, while that one was still running. Text without `@` reads as it always has.
 * A plunger lists its fuse pairs: `plunger.0.0.2.20.1.45` arms charge 0 at once, 2 at 20 steps, 1 at 45.
 */
export function writeShots(shots: readonly Shot[]): string {
  return shots.map((s) => [s.ammo, ...shotValues(s)].join('.') + (s.after === undefined ? '' : `@${s.after}`)).join('_');
}

/** The shots writeShots wrote, each checked (checkShot); throws naming the shot at fault. Empty text is no shots. */
export function readShots(text: string): Shot[] {
  if (text === '') return [];
  return text.split('_').map((part, i) => {
    const where = `shot ${i + 1} (${part})`;
    const at = part.split('@');
    if (at.length > 2) throw new Error(`${where}: at most one @after`);
    const [ammo, ...vals] = at[0]!.split('.');
    if (!isRackItem(ammo!)) throw new Error(`${where}: ammo must be one of ${RACK_ITEM_NAMES}`);
    const fields = shotFields(ammo);
    const shot: Record<string, unknown> = { ammo };
    if (ammo === PLUNGER) {
      if (vals.length < 2 || vals.length % 2) throw new Error(`${where}: ${ammo} takes charge.delay pairs, got ${vals.length} fields`);
      vals.forEach((v) => { if (!/^\d+$/.test(v)) throw new Error(`${where}: charges and delays are whole numbers, not ${v || 'empty'}`); });
      shot.fuse = Array.from({ length: vals.length / 2 }, (_, j) => [Number(vals[2 * j]), Number(vals[2 * j + 1])]);
    } else {
      if (vals.length !== fields.length) throw new Error(`${where}: ${ammo} takes ${fields.length} fields (${fields.join('.')}), got ${vals.length}`);
      fields.forEach((k, j) => {
        if (!/^-?\d+$/.test(vals[j]!)) throw new Error(`${where}: ${k} must be an integer, not ${vals[j] || 'empty'}`);
        shot[k] = Number(vals[j]);
      });
    }
    if (at.length === 2) {
      if (!/^\d+$/.test(at[1]!)) throw new Error(`${where}: after must be a whole number of steps, not ${at[1] || 'empty'}`);
      shot.after = Number(at[1]);
    }
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

/** The body rack item `kind` fires at pos with velocity vel, at `at` (a level's frame, or its m per h); alongZ turns a box's x onto z. */
export function ammoBody(kind: RackItem, at: ItemFrame, pos: Vec3, vel: Vec3, alongZ = false): BodyDesc {
  const spec = itemSpec(kind, at);
  const shape: BodyDesc['shape'] = 'radius' in spec.size
    ? { kind: 'sphere', radius: spec.size.radius }
    : { kind: 'box', half: alongZ ? [spec.size.half[2], spec.size.half[1], spec.size.half[0]] : spec.size.half };
  return { shape, pos, rot: [0, 0, 0, 1], linVel: vel, angVel: [0, 0, 0], density: spec.density, friction: spec.friction, restitution: spec.restitution, tag: TAG_BALL };
}

/**
 * The engine event for a shot fired at engine step `step`: a spawn, or for a pull the removal of its
 * body; a plunger has none of its own (its charges' events come from the Driver's arsenal).
 */
export function shotEvent(f: ShotFrame, shot: Shot, step: number): SpawnEvent | RemoveEvent | null {
  if (shot.ammo === PULL) { checkShot(shot); return { step, kind: 'remove', id: shot.body }; }
  if (shot.ammo === PLUNGER) { checkShot(shot); return null; }
  return shotToSpawn(f, shot, step);
}

/** The spawn event for a shot fired at engine step `step`; throws for a pull, which spawns nothing (shotEvent). */
export function shotToSpawn(f: ShotFrame, shot: Shot, step: number): SpawnEvent {
  checkShot(shot);
  if (shot.ammo === PULL) throw new Error(`a ${PULL} spawns nothing: it removes body ${shot.body} (shotEvent)`);
  if (shot.ammo === PLUNGER) throw new Error(`a ${PLUNGER} spawns nothing: it sets off charges (shotEvent)`);
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
    const p = launcherPos(f, shot.az, shot.y), d = launchDir(shot.az, shot.yaw, shot.pitch), v = speedOf(shot.ammo, shot.power, f);
    body = ammoBody(shot.ammo, f, p, [d[0] * v, d[1] * v, d[2] * v]);
  }
  return { step, kind: 'spawn', body };
}

/**
 * The energy a pull is charged (J), so leverage stays defined on a level of pulls: the launch energy
 * of the gentlest shot there is, a marble at power 0 at the level's unit (409 J at h = 0.5 m), the
 * poke a pull stands in for. Alternatives (the block's weight lifted one h, the friction work under
 * its load) are weighed in docs/game/undercut-bullet-time.md.
 */
export function pullEnergy(f: { unit: number }): number {
  const v = itemSpec('marble', f.unit).vMin;
  return 0.5 * massOf(ammoBody('marble', f.unit, [0, 0, 0], [v, 0, 0])) * v * v;
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
export function aimAt(f: ShotFrame, ammo: LaunchItem, at: { az: number; y: number; power: number }, target: Vec3, opts: { dt?: number; maxSteps?: number; substeps?: number } = {}): Aim {
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
