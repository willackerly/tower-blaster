// A weapon's flight, worked out before it is fired: the editor's arc preview
// (docs/design/weapon-editor.md). It runs the weapon's own WeaponRuntime, so
// every trigger, split and blast is decided by the code that decides them in
// play, over a stand-in world that only knows free flight:
//   - munitions fly by freeFlight (the engines' integrator), so while a
//     munition flies free its track is the engine's path to rounding;
//   - a blast kicks the other munitions as every engine does (engine-api
//     blastVelocity, mass from density and volume), so a star blown off
//     course by its neighbour is blown off course in the preview too;
//   - the ground and `obstacles` (bodies already in the world, held where a
//     snapshot has them) are sensed by near triggers exactly as in play, but
//     a munition that touches one simply stops there: no bounce, roll or
//     knock-on. From its first contact (PreviewTrack.contact) a track is an
//     approximation, and obstacles never move, so a blast's effect on the
//     world is not shown (the preview draws its sphere instead).
// The match with a real firing is tested against the f64 reference engine
// (test/preview.test.ts): before contact, every point, split and blast is the
// engine's to 1e-9.
import { blastArea, blastCentre, blastVelocity, checkBlast, freeFlight, type InputEvent, massOf, queueInputs, type ShapeDesc, type Snapshot, type SpawnEvent, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { type GrenadeWorld, surfaceDistance } from './grenade.ts';
import { WeaponRuntime } from './runtime.ts';
import { checkWeapon, type MunitionSpec, weaponBudget, type WeaponSpec } from './spec.ts';

/** Steps a preview runs at most when not told: 10 s at 60 Hz, past every built-in's last blast. */
export const PREVIEW_STEPS = 600;

/** The fired shell: what the launcher spawns (in play its spawn is due at step 0 of the preview). */
export interface PreviewLaunch {
  shape: ShapeDesc;
  pos: Vec3;
  vel: Vec3;
  density: number;
}

export interface PreviewOptions {
  /** Steps to run at most (default PREVIEW_STEPS); the preview stops sooner once nothing is left. */
  steps?: number;
  /**
   * Bodies already in the world, held where `s` has them (ids 0 .. s.count - 1): sensed by near
   * triggers, and a munition that touches one stops. Absent: an empty world (the ground only).
   */
  obstacles?: { s: Snapshot; shapes: readonly { shape: ShapeDesc }[] };
}

export interface PreviewTrack {
  /** Which munition: '' the shell, 'star' a child, 'star.spark' a grandchild (as weaponBudget's paths). */
  path: string;
  /** Step its spawn is due: points[0] is where it spawns, points[k] where it is after step start + k - 1. */
  start: number;
  points: Vec3[];
  /** split or removed: its last point is where that happened; open: still there when the preview stopped. */
  end: 'split' | 'removed' | 'open';
  /** The first step after which it touched the ground or an obstacle (from there on the preview holds it still), or null. */
  contact: number | null;
}

export interface PreviewBlast {
  /** Step it is due at, and the munition it is centred on (track index and path). */
  step: number;
  track: number;
  path: string;
  centre: Vec3;
  radius: number;
}

export interface WeaponPreview {
  tracks: PreviewTrack[];
  blasts: PreviewBlast[];
  /** Steps run. */
  steps: number;
}

interface Mun {
  track: number;
  shape: ShapeDesc;
  radius: number;
  mass: number;
  p: Vec3;
  v: Vec3;
  gone: boolean;
  still: boolean;
}

/** The flight of `spec` fired as `launch` in `world` (WeaponRuntime's world: dt, substeps, gravity, ground). */
export function previewWeapon(spec: WeaponSpec, launch: PreviewLaunch, world: GrenadeWorld, opts: PreviewOptions = {}): WeaponPreview {
  const weapon = checkWeapon(spec);
  const maxSteps = opts.steps ?? PREVIEW_STEPS;
  const obs = opts.obstacles ?? null, nObs = obs?.s.count ?? 0;
  const cap = nObs + weaponBudget(weapon).bodies;
  // One snapshot, reused: obstacles copied once, munitions written after every step.
  const s: Snapshot = {
    count: nObs, pos: new Float64Array(3 * cap), rot: new Float64Array(4 * cap), linVel: new Float64Array(3 * cap),
    angVel: new Float64Array(3 * cap), awake: new Uint8Array(cap), tier: new Uint8Array(cap),
  };
  const shapes: { shape: ShapeDesc }[] = [];
  if (obs) {
    s.pos.set(obs.s.pos.subarray(0, 3 * nObs));
    s.rot.set(obs.s.rot.subarray(0, 4 * nObs));
    if (obs.s.tier) s.tier!.set(obs.s.tier.subarray(0, nObs));
    for (let i = 0; i < nObs; i++) shapes.push({ shape: obs.shapes[i]!.shape });
  }
  const muns: Mun[] = [], tracks: PreviewTrack[] = [], blasts: PreviewBlast[] = [];
  // Each spawn's munition path: the shell's is '', a split child's its parent's plus the child's name.
  const byId = (id: number): Mun | undefined => muns[id - nObs];
  const pathOf = new Map<SpawnEvent, string>(), idOfSpawn = new Map<SpawnEvent, number>();
  const rt = new WeaponRuntime(world, 1);
  const fired: SpawnEvent = { step: 0, kind: 'spawn', body: { shape: launch.shape, pos: [...launch.pos], rot: [0, 0, 0, 1], linVel: [...launch.vel], angVel: [0, 0, 0], density: launch.density, friction: 0.5, restitution: 0, tag: 0 } };
  pathOf.set(fired, '');
  let queue: InputEvent[] = [fired];
  // A split returns its children's spawns, then the munition's removal (runtime.ts fire): that removal names the parent.
  const splits = new Set<InputEvent>();
  const take = (evs: InputEvent[]) => {
    let kids: SpawnEvent[] = [];
    for (const e of evs) {
      if (e.kind === 'spawn') { kids.push(e); continue; }
      if (e.kind === 'remove' && kids.length) {
        const parent = tracks[byId(e.id)!.track]!.path;
        const name = childName(weapon, parent, kids);
        for (const k of kids) pathOf.set(k, parent ? `${parent}.${name}` : name);
        splits.add(e);
      }
      kids = [];
    }
    queue = queueInputs(queue, evs);
  };
  take(rt.launch(nObs, 0, weapon, launch.shape));
  const groundY = world.groundY;
  const touches = (m: Mun): boolean => {
    if (groundY !== null && m.p[1] - m.radius <= groundY) return true;
    for (let i = 0; i < nObs; i++) if (s.tier![i] !== TIER_FREE && surfaceDistance(shapes[i]!.shape, s, i, m.p) <= m.radius) return true;
    return false;
  };

  let step = 0;
  for (; step < maxSteps; step++) {
    // Inputs due at this step, in the engines' order, before the step runs.
    while (queue.length && queue[0]!.step <= step) {
      const e = queue.shift()!;
      if (e.kind === 'spawn') {
        const b = e.body, id = nObs + muns.length;
        idOfSpawn.set(e, id);
        tracks.push({ path: pathOf.get(e) ?? '', start: e.step, points: [[...b.pos]], end: 'open', contact: null });
        muns.push({ track: tracks.length - 1, shape: b.shape, radius: boundingRadius(b.shape), mass: massOf(b), p: [...b.pos], v: [...b.linVel], gone: false, still: false });
        shapes.push({ shape: b.shape });
        s.count = id + 1;
      } else if (e.kind === 'blast') {
        const b = checkBlast(e.blast), host = b.point ? null : byId(b.body)!;
        const centre = blastCentre(b, host ? host.p : null);
        blasts.push({ step: e.step, track: host ? host.track : -1, path: host ? tracks[host.track]!.path : '', centre, radius: b.radius });
        muns.forEach((m, k) => {
          if (m.gone) return;
          const v = blastVelocity(b, centre, nObs + k, m.p, m.v, m.mass, blastArea(m.shape));
          if (v) { m.v = v; m.still = false; }
        });
      } else if (e.kind === 'remove') {
        // A weapon's runtime emits spawns, blasts and removals only; it never schedules a field event.
        const m = byId(e.id);
        if (m && !m.gone) {
          m.gone = true;
          tracks[m.track]!.end = splits.has(e) ? 'split' : 'removed';
        }
      }
    }
    if (!queue.length && !rt.pending && muns.every((m) => m.gone)) break;
    // The step: free flight, held still from the first contact.
    muns.forEach((m) => {
      if (m.gone) return;
      if (!m.still) {
        const f = freeFlight(m.p, m.v, world.gravity, world.dt, world.substeps, 1);
        m.p = f.pos; m.v = f.vel;
        if (touches(m)) {
          m.still = true;
          m.v = [0, 0, 0];
          if (groundY !== null && m.p[1] - m.radius < groundY) m.p = [m.p[0], groundY + m.radius, m.p[2]];
          tracks[m.track]!.contact ??= step + 1;
        }
      }
      tracks[m.track]!.points.push([...m.p]);
    });
    muns.forEach((m, k) => {
      const i = nObs + k;
      s.pos.set(m.p, 3 * i);
      s.linVel.set(m.v, 3 * i);
      s.rot.set([0, 0, 0, 1], 4 * i);
      s.awake[i] = m.gone ? 0 : 1;
      s.tier![i] = m.gone ? TIER_FREE : 0;
    });
    const evs = rt.observe(s, step + 1, shapes, (e) => {
      const id = idOfSpawn.get(e);
      if (id === undefined) throw new Error('previewWeapon: a spawn the runtime asked about was not applied');
      return id;
    });
    take(evs);
  }
  return { tracks, blasts, steps: step };
}

/**
 * Which child of munition `parent` a split's spawns are: the child some split of that munition names
 * with as many children, whose shell they have (the spawns do not carry the name; two children alike
 * in both are told apart by nothing a preview draws).
 */
function childName(weapon: WeaponSpec, parent: string, kids: readonly SpawnEvent[]): string {
  let m: MunitionSpec = weapon;
  for (const k of parent ? parent.split('.') : []) m = m.children![k]!;
  const b = kids[0]!.body;
  const named = m.rules.flatMap((r) => r.do.flatMap((a) => ('split' in a && a.split.into === kids.length ? [a.split.child] : [])));
  const fits = named.filter((n) => { const c = m.children![n]!.shell; return c.density === b.density && JSON.stringify(c.shape) === JSON.stringify(b.shape); });
  return fits[0] ?? named[0] ?? '?';
}
