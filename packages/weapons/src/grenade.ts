// Grenades: a fired body with a fuse that ends in a blast centred on itself
// (engine-api blast.ts, centre { body }). Pure logic over snapshots: the
// caller fires the grenade's spawn, tells Grenades about it (launch), and
// feeds it the states it observes (observe); both return the blasts to push.
//
// Fuses:
// - timer: the blast is due `delay` s after the spawn step, known at launch,
//   so it is returned by launch() and needs no observation at all.
// - prox: the blast is due at the first step whose state has the grenade
//   within `prox` of any other body's surface (or of the ground), and at
//   least `arm` s after launch.
// - proxTimer: as prox, then `delay` s later.
//
// Proximity is decided from an observed state k (a snapshot after k steps)
// and is due at k + 1 at the soonest, so a reader one step behind (pipelined
// read-back) still lands it at the same engine step as a serial one. To
// make up for seeing the world only every few steps, observe() also looks
// `lookahead` steps ahead: the grenade's own path is exact while it flies
// free (freeFlight, the engines' integrator), the other bodies are taken
// where state k has them. A trigger at predicted step j is due at j itself,
// so observing every step with lookahead 1, or every 4 steps with lookahead
// >= 4, detonates at the same step while nothing near the path moves much.
// A grenade that is not flying free is in contact, hence within prox at
// once (prox >= 0), so the prediction is never used past a contact.
//
// Distances are exact for spheres and boxes (box: point to oriented box);
// the grenade counts as its bounding sphere. A coarse test against the
// bounding sphere of the predicted path keeps observe() at one distance
// per body for the far ones.
import { type BlastEvent, checkBlast, freeFlight, type ShapeDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';

export type Fuse = 'timer' | 'prox' | 'proxTimer';
export const FUSES: readonly Fuse[] = ['timer', 'prox', 'proxTimer'];

/** The blast a grenade ends in: an engine-api Blast without centre and exclude (the grenade's own). */
export interface GrenadeBlast {
  radius: number;
  impulse: number;
  falloff: number;
  core: number;
  maxDv: number;
  maxSpeed: number;
}

export interface GrenadeSpec {
  fuse: Fuse;
  /** s: the timer fuse's delay from launch; proxTimer's from the step proximity is reached. */
  delay: number;
  /** Gap to the nearest other surface (a body's or the ground's) that sets a proximity fuse off, m (>= 0). */
  prox: number;
  /** s after launch before a proximity fuse is live (it is not set off near the launcher). */
  arm: number;
  /** Whether the ground is a surface a proximity fuse senses. */
  ground: boolean;
  blast: GrenadeBlast;
}

/**
 * A lot of energy, as a special shot should have: a scene cube (1 kg, 1 m) inside
 * 3 m gets the full maxDv (25 m/s), one at 4 m about 15 m/s.
 */
export const DEFAULT_GRENADE: GrenadeSpec = {
  fuse: 'prox', delay: 1, prox: 0.75, arm: 0.1, ground: true,
  blast: { radius: 5, impulse: 40, falloff: 1, core: 0.2, maxDv: 25, maxSpeed: 48 },
};

/** Accepted ranges (inclusive); checkGrenade refuses anything outside them. */
export const GRENADE_LIMITS = {
  delay: [0, 60], prox: [0, 20], arm: [0, 60],
  radius: [0.1, 100], impulse: [0, 1e5], falloff: [0, 8], core: [0, 0.99], maxDv: [0, 500], maxSpeed: [0.1, 1000],
} as const;

/** Throws on a spec no grenade should have; returns it. */
export function checkGrenade(g: GrenadeSpec): GrenadeSpec {
  if (!FUSES.includes(g.fuse)) throw new Error(`grenade.fuse must be one of ${FUSES.join(', ')}: ${g.fuse}`);
  if (typeof g.ground !== 'boolean') throw new Error(`grenade.ground must be true or false: ${g.ground}`);
  const range = (key: keyof typeof GRENADE_LIMITS, v: number) => {
    const [lo, hi] = GRENADE_LIMITS[key];
    if (!(typeof v === 'number' && v >= lo && v <= hi)) throw new Error(`grenade.${key} must be a number from ${lo} to ${hi}: ${v}`);
  };
  range('delay', g.delay); range('prox', g.prox); range('arm', g.arm);
  for (const k of Object.keys(DEFAULT_GRENADE.blast) as (keyof GrenadeBlast)[]) range(k, g.blast[k]);
  checkBlast({ centre: [0, 0, 0], ...g.blast });
  return g;
}

/** What Grenades needs of the world: the step, the integrator, gravity and the ground. */
export interface GrenadeWorld {
  /** s per engine step. */
  dt: number;
  /** EngineInfo.integrator.substeps. */
  substeps: number;
  gravity: Vec3;
  /** The ground plane's y, or null when there is none. */
  groundY: number | null;
}

interface Live {
  id: number;
  spec: GrenadeSpec;
  radius: number;
  /** First step whose state may set the proximity fuse off. */
  armStep: number;
}

/** Steps for a duration, rounded to the nearest. */
const stepsOf = (s: number, dt: number) => Math.round(s / dt);

export class Grenades {
  private live: Live[] = [];

  /** lookahead: steps beyond each observed state to predict (about the steps between observations). */
  constructor(readonly world: GrenadeWorld, readonly lookahead = 1) {
    if (!(world.dt > 0) || !Number.isInteger(world.substeps) || world.substeps < 1) throw new Error(`Grenades: bad world ${JSON.stringify(world)}`);
    if (!Number.isInteger(lookahead) || lookahead < 0) throw new Error(`Grenades: lookahead must be an integer >= 0: ${lookahead}`);
  }

  /** Grenades whose fuse still waits on an observation. */
  get pending(): number {
    return this.live.length;
  }

  /**
   * A grenade was fired: body `id`, whose spawn is due at engine step `step`.
   * Returns the input to push after the spawn: a timer fuse's blast; nothing for the others.
   */
  launch(id: number, step: number, spec: GrenadeSpec, shape: ShapeDesc): BlastEvent[] {
    checkGrenade(spec);
    if (spec.fuse === 'timer') return [blastOf(id, step + stepsOf(spec.delay, this.world.dt), spec)];
    this.live.push({ id, spec, radius: boundingRadius(shape), armStep: step + stepsOf(spec.arm, this.world.dt) });
    return [];
  }

  /**
   * The blasts set off by the state after `step` steps (s), each due after `step`.
   * shapes: every body's shape by id, at least s.count of them.
   */
  observe(s: Snapshot, step: number, shapes: readonly { shape: ShapeDesc }[]): BlastEvent[] {
    const out: BlastEvent[] = [];
    this.live = this.live.filter((g) => {
      // Not spawned yet as of this state.
      if (g.id >= s.count) return true;
      const j = this.trigger(g, s, step, shapes);
      if (j === null) return true;
      out.push(blastOf(g.id, g.spec.fuse === 'prox' ? j : j + stepsOf(g.spec.delay, this.world.dt), g.spec));
      return false;
    });
    return out;
  }

  /** The step the fuse is set off at (> step), or null if not within the lookahead. */
  private trigger(g: Live, s: Snapshot, step: number, shapes: readonly { shape: ShapeDesc }[]): number | null {
    const { dt, substeps, gravity, groundY } = this.world;
    const prox = g.spec.prox, sense = g.spec.ground && groundY !== null;
    // The grenade's position at each step from the observed one, while it flies free.
    let p: Vec3 = [s.pos[3 * g.id]!, s.pos[3 * g.id + 1]!, s.pos[3 * g.id + 2]!];
    let v: Vec3 = [s.linVel[3 * g.id]!, s.linVel[3 * g.id + 1]!, s.linVel[3 * g.id + 2]!];
    const path: { step: number; p: Vec3 }[] = [];
    for (let j = step; j <= step + this.lookahead; j++) {
      if (j > step) ({ pos: p, vel: v } = freeFlight(p, v, gravity, dt, substeps, 1));
      if (j >= g.armStep) path.push({ step: j, p });
    }
    if (!path.length) return null;
    // Bounding sphere of the path points; bodies farther than prox from it cannot set the fuse off.
    const lo = [0, 1, 2].map((k) => Math.min(...path.map((q) => q.p[k]!))), hi = [0, 1, 2].map((k) => Math.max(...path.map((q) => q.p[k]!)));
    const mid = [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2), reach = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 + g.radius + prox;
    const near: number[] = [];
    for (let i = 0; i < s.count; i++) {
      if (i === g.id) continue;
      const d = Math.hypot(s.pos[3 * i]! - mid[0]!, s.pos[3 * i + 1]! - mid[1]!, s.pos[3 * i + 2]! - mid[2]!);
      if (d - boundingRadius(shapes[i]!.shape) <= reach) near.push(i);
    }
    for (const { step: j, p: q } of path) {
      let gap = sense ? q[1] - groundY! : Infinity;
      for (const i of near) gap = Math.min(gap, surfaceDistance(shapes[i]!.shape, s, i, q));
      if (gap - g.radius <= prox) return Math.max(j, step + 1);
    }
    return null;
  }
}

/** The blast of grenade `id`, due at `step`: centred on it, not pushing it. */
function blastOf(id: number, step: number, spec: GrenadeSpec): BlastEvent {
  return { step, kind: 'blast', blast: { centre: { body: id }, exclude: [id], ...spec.blast } };
}

/** Distance from point q to the surface of body i (0 inside), from its pose in s. */
export function surfaceDistance(shape: ShapeDesc, s: Snapshot, i: number, q: Vec3): number {
  const d: Vec3 = [q[0] - s.pos[3 * i]!, q[1] - s.pos[3 * i + 1]!, q[2] - s.pos[3 * i + 2]!];
  if (shape.kind === 'sphere') return Math.max(0, Math.hypot(...d) - shape.radius);
  // Into the box's frame: rotate by the conjugate of (x, y, z, w).
  const x = -s.rot[4 * i]!, y = -s.rot[4 * i + 1]!, z = -s.rot[4 * i + 2]!, w = s.rot[4 * i + 3]!;
  const tx = 2 * (y * d[2] - z * d[1]), ty = 2 * (z * d[0] - x * d[2]), tz = 2 * (x * d[1] - y * d[0]);
  const l = [d[0] + w * tx + (y * tz - z * ty), d[1] + w * ty + (z * tx - x * tz), d[2] + w * tz + (x * ty - y * tx)];
  const h = shape.half;
  return Math.hypot(Math.max(0, Math.abs(l[0]!) - h[0]), Math.max(0, Math.abs(l[1]!) - h[1]), Math.max(0, Math.abs(l[2]!) - h[2]));
}
