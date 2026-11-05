// The rack's weapons at play (roadmap G3.3, G3.4; spectacle-mode.md sections 4 and 7):
// what a w-<key> item is in a level (its arm: what runs, its shell, its worst case),
// what it costs in energy fired, and the fuses of the ones in flight.
//
// - Arms: a level's weapons[key] (rack.ts weaponOf) resolved once per compiled level
//   (CompiledLevel.arms): a GrenadeSpec through levelWeapon in a GRENADE_SHELL; a
//   WeaponSpec checked (checkWeapon) and scaled from the viewer's cube units to the
//   level's commonest block (cubeScale). Its static budget (weaponBudget) gives the
//   bodies an engine must hold, every munition's shell and a bound on its speed (the
//   validator's tunnelling rule), and every blast with how often it can go off.
// - Cost: each blast is charged its nominal yield (@tb/weapons nominalYield) against a
//   solid fill of the level's commonest structure block, times how often it can go off:
//   a static figure, so a grenade placed in the dense base (the clever shot) costs what
//   one wasted in the air does.
// - Fuses: Arsenal wraps a @tb/weapons WeaponRuntime for one session (a GrenadeSpec runs
//   on it bit for bit as on Grenades). Driver tells it about each weapon it fires
//   (launch) and shows it every state it observes (observe); both return the input to
//   push (Driver.push: due after the state observed), the same rule a
//   PlayOptions.perStep hook follows, so a live session and its replay on the same
//   driver options push the same events at the same steps. pending() holds the shot's
//   settle while a rule or a blast is still to come.
import { blastArea, type BodyDesc, checkBlast, type InputEvent, type ShapeDesc, type Snapshot, type SpawnEvent } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import {
  checkWeapon, type GrenadeBlast, type GrenadeSpec, type GrenadeWorld, type MunitionSpec, nominalYield, scaleWeapon, SHELL_FRICTION, SHELL_RESTITUTION, type ShellSpec,
  type WeaponScale, type WeaponSpec, WeaponRuntime, weaponBudget, type YieldFill,
} from '@tb/weapons';
import type { CompiledLevel } from './level.ts';
import { grenadeShell, type ItemSpec, itemRef, levelWeapon, type RackItem, weaponOf } from './rack.ts';

/** The commonest structure block (by material and size; the first such body on a tie), or null for an empty level. */
export function levelBlock(c: CompiledLevel): { index: number; mass: number; half: [number, number, number] } | null {
  const m = c.meta, count = new Map<string, number>();
  let best = -1, bestN = 0;
  for (let i = 0; i < m.n; i++) {
    const key = `${m.material[i]} ${m.half[3 * i]} ${m.half[3 * i + 1]} ${m.half[3 * i + 2]}`, k = (count.get(key) ?? 0) + 1;
    count.set(key, k);
    if (k > bestN) { bestN = k; best = i; }
  }
  if (best < 0) return null;
  return { index: best, mass: m.mass[best]!, half: [m.half[3 * best]!, m.half[3 * best + 1]!, m.half[3 * best + 2]!] };
}

const fills = new WeakMap<CompiledLevel, YieldFill>();

/**
 * A solid fill of the level's commonest structure block: its mass over its lattice cell
 * (its box widened by the horizontal pitch), and its silhouette per mass. Empty levels
 * fill nothing.
 */
export function levelFill(c: CompiledLevel): YieldFill {
  const hit = fills.get(c);
  if (hit) return hit;
  const b = levelBlock(c), p = c.frame.pitch;
  const fill: YieldFill = b
    ? { density: b.mass / (8 * b.half[0] * b.half[1] * b.half[2] * p * p), areaPerMass: blastArea({ kind: 'box', half: b.half }) / b.mass }
    : { density: 0, areaPerMass: 0 };
  fills.set(c, fill);
  return fill;
}

/** Silhouette per mass of the viewer's scene cube (edge 1, 1 kg), the unit a cube-unit blast impulse is written against. */
const CUBE_AREA_PER_MASS = blastArea({ kind: 'box', half: [0.5, 0.5, 0.5] });

/**
 * How a WeaponSpec in the viewer's cube units (a scene of 1 kg cubes of edge 1, speeds in
 * m/s at a 1 m edge: the viewer's Download weapon, @tb/weapons' built-ins) becomes one of
 * this level, its commonest block standing for the cube: lengths x h; speeds and spreads
 * x sqrt(h / 1 m) (Froude, as the viewer's world scale); densities x the block's; blast
 * impulse so a block gets the speed change the cube got, Froude-scaled (x sqrt(h) x the
 * cube's area per mass over the block's), and maxDv, maxSpeed x sqrt(h). Times stay.
 * A shell of density 1 is then as dense as the block, and a blast moves the block as it
 * moved the cube in a scene of that edge.
 */
export function cubeScale(c: CompiledLevel): WeaponScale {
  const b = levelBlock(c);
  if (!b) throw new Error(`${c.def.id}: a WeaponSpec scales to the level's blocks, and it has none`);
  const h = c.frame.unit, v = Math.sqrt(h), rho = b.mass / (8 * b.half[0] * b.half[1] * b.half[2]), aPerM = blastArea({ kind: 'box', half: b.half }) / b.mass;
  return { length: h, speed: v, density: rho, impulse: (v * CUBE_AREA_PER_MASS) / aPerM, maxDv: v, maxSpeed: v };
}

/** A munition of an arm in world units: its shell, mass, a bound on its speed (m/s) and how many of it can exist. */
export interface ArmMunition { path: string; shape: ShapeDesc; mass: number; speed: number; count: number }

/** A w- item resolved in a level (levelArm). */
export interface Arm {
  /** What the runtime runs, in world units: a GrenadeSpec (fired in `shell`) or a WeaponSpec. */
  spec: GrenadeSpec | WeaponSpec;
  /** The body it is fired as. */
  shell: ItemSpec;
  /** Engine bodies one firing can add, its shell included (weaponBudget). */
  bodies: number;
  /** Every munition; the shell first, its speed bound the launch's top speed. */
  munitions: ArmMunition[];
  /** Every blast, with the engine's defaults filled in, and how often it can go off. */
  blasts: { path: string; blast: GrenadeBlast; count: number }[];
  /** Nominal yield, J: sum of count x nominalYield(blast) against levelFill. */
  yield: number;
  /** Largest bounding radius of its munitions, m (the GPU engine's broadphase reach). */
  maxRadius: number;
}

const fullBlast = (b: { radius: number; impulse: number; falloff?: number; core?: number; maxDv?: number; maxSpeed?: number }): GrenadeBlast => {
  const k = checkBlast({ centre: [0, 0, 0], ...b });
  return { radius: k.radius, impulse: k.impulse, falloff: k.falloff, core: k.core, maxDv: k.maxDv, maxSpeed: k.maxSpeed };
};

const shellItem = (s: ShellSpec): ItemSpec => ({
  size: s.shape.kind === 'sphere' ? { radius: s.shape.radius } : { half: [s.shape.half[0], s.shape.half[1], s.shape.half[2]] },
  density: s.density, friction: s.friction ?? SHELL_FRICTION, restitution: s.restitution ?? SHELL_RESTITUTION, vMin: s.speed?.[0] ?? 0, vMax: s.speed?.[1] ?? 0,
});

const shapeOf = (s: ItemSpec): ShapeDesc => ('radius' in s.size ? { kind: 'sphere', radius: s.size.radius } : { kind: 'box', half: s.size.half });
const volumeOf = (s: ShapeDesc) => (s.kind === 'sphere' ? (4 / 3) * Math.PI * s.radius * s.radius * s.radius : s.kind === 'box' ? 8 * s.half[0] * s.half[1] * s.half[2] : 0);

/**
 * Weapon `key` of a level, resolved (Arm). Throws if the level has none, or it fails its
 * checks (checkGrenade, checkWeapon).
 */
export function levelArm(c: CompiledLevel, key: string): Arm {
  const raw = weaponOf(c.def, key);
  if (!raw) throw new Error(`${c.def.id} has no weapons.${key}`);
  const fill = levelFill(c);
  if (!('version' in raw)) {
    const g = levelWeapon(c.def, key)!, shell = grenadeShell(c.frame.unit), shape = shapeOf(shell);
    return {
      spec: g, shell, bodies: 1, munitions: [{ path: '', shape, mass: shell.density * volumeOf(shape), speed: shell.vMax, count: 1 }],
      blasts: [{ path: 'blast', blast: g.blast, count: 1 }], yield: nominalYield(g.blast, fill), maxRadius: boundingRadius(shape),
    };
  }
  // Blast defaults filled before scaling, so maxDv and maxSpeed scale too (the viewer's worldWeapon does the same).
  const filled = JSON.parse(JSON.stringify(checkWeapon(raw)), (k, v) => (k === 'blast' ? fullBlast(v) : v)) as WeaponSpec;
  const spec = checkWeapon(scaleWeapon(filled, cubeScale(c)));
  const budget = weaponBudget(spec), shell = shellItem(spec.shell);
  // Speed bounds: a child leaves its parent at the parent's speed plus its split's spread.
  const munitions: ArmMunition[] = [];
  const walk = (m: MunitionSpec, path: string, speed: number, count: number) => {
    munitions.push({ path, shape: m.shell.shape, mass: m.shell.density * volumeOf(m.shell.shape), speed, count });
    for (const [name, child] of Object.entries(m.children ?? {})) {
      let n = 0, spread = 0;
      for (const r of m.rules) for (const a of r.do) if ('split' in a && a.split.child === name) { n += a.split.into; spread = Math.max(spread, a.split.spread ?? 0); }
      if (n) walk(child, path ? `${path}.${name}` : name, speed + spread, count * n);
    }
  };
  walk(spec, '', shell.vMax, 1);
  const blasts = budget.blasts.map((b) => ({ path: b.path, blast: fullBlast(b.blast), count: b.count }));
  return {
    spec, shell, bodies: budget.bodies, munitions, blasts,
    yield: blasts.reduce((a, b) => a + b.count * nominalYield(b.blast, fill), 0),
    maxRadius: Math.max(...munitions.map((x) => boundingRadius(x.shape))),
  };
}

/**
 * The arms of the level's rack, by item name, and their shells (ShotFrame.shells). An item
 * whose weapon does not resolve is left out: the validator reports it, and firing it throws.
 */
export function rackArms(c: CompiledLevel): Record<string, Arm> {
  const arms: Record<string, Arm> = {};
  for (const item of new Set(c.def.rack)) {
    const r = itemRef(item);
    if (r?.kind !== 'weapon') continue;
    try { arms[item] = levelArm(c, r.key); } catch { /* reported by validateLevel */ }
  }
  return arms;
}

/** The arm of rack item `item`, or null for an item that is no weapon; throws for a weapon the level cannot fire. */
function armOf(c: CompiledLevel, item: RackItem): Arm | null {
  const r = itemRef(item);
  if (r?.kind !== 'weapon') return null;
  return c.arms[item] ?? levelArm(c, r.key);
}

/** Energy fired by a rack item beyond its launch: a weapon's nominal yield, J; 0 for anything else. */
export function itemYield(c: CompiledLevel, item: RackItem): number {
  return armOf(c, item)?.yield ?? 0;
}

export class Arsenal {
  private readonly runtime: WeaponRuntime;
  /** Steps of the blasts pushed so far, to hold a settle until the last is due. */
  private blastSteps: number[] = [];

  constructor(readonly level: CompiledLevel, substeps: number) {
    const s = level.scene, world: GrenadeWorld = { dt: s.dt, substeps, gravity: s.gravity, groundY: s.ground?.y ?? null };
    // Observed every step: one step of lookahead is the serial reader's (as Grenades).
    this.runtime = new WeaponRuntime(world, 1);
  }

  /** Item `item` was fired as body `id`, its spawn due at `step`: the input to push now (a timer's blast). */
  launch(item: RackItem, id: number, step: number, shape: ShapeDesc): InputEvent[] {
    const arm = armOf(this.level, item);
    if (!arm) return [];
    return this.track(this.runtime.launch(id, step, arm.spec, shape));
  }

  /**
   * The input the state after `step` steps sets off; bodies: every body's description by
   * id; idOf: the id a spawn this arsenal returned was given (a split's children).
   */
  observe(s: Snapshot, step: number, bodies: readonly BodyDesc[], idOf: (spawn: SpawnEvent) => number): InputEvent[] {
    if (!this.runtime.pending) return [];
    return this.track(this.runtime.observe(s, step, bodies, idOf));
  }

  /**
   * Whether a rule is still to fire or a blast has yet to show in the state after `step`
   * steps: an event due at step b applies when the engine steps from b, so that state first
   * shows it at b + 1. The shot is not over.
   */
  pending(step: number): boolean {
    return this.runtime.pending > 0 || this.blastSteps.some((b) => b >= step);
  }

  private track(events: InputEvent[]): InputEvent[] {
    for (const e of events) if (e.kind === 'blast') this.blastSteps.push(e.step);
    return events;
  }
}
