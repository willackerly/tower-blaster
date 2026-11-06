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
import { blastArea, type BodyDesc, checkBlast, type InputEvent, type ShapeDesc, type Snapshot, type SpawnEvent, type Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import {
  chargeProblems, checkWeapon, type GrenadeBlast, thrownProblems, WeaponSpecError, type GrenadeSpec, type GrenadeWorld, type MunitionSpec, nominalYield, scaleWeapon, SHELL_FRICTION, SHELL_RESTITUTION, type ShellSpec,
  type WeaponScale, type WeaponSpec, WeaponRuntime, weaponBudget, type YieldFill,
} from '@tb/weapons';
import type { CompiledLevel } from './level.ts';
import { materialId } from './materials.ts';
import { chargeWeaponOf, grenadeShell, type ItemSpec, itemRef, levelWeapon, type RackItem, weaponOf } from './rack.ts';
import { MAX_CHARGES, type PlungerShot, pullEnergy } from './shots.ts';

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
  const spec = inLevel(c, raw);
  const thrown = thrownProblems(spec);
  if (thrown.length) throw new WeaponSpecError(thrown);
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

/** A WeaponSpec in cube units as one of this level (cubeScale), checked. Blast defaults are filled before scaling, so maxDv and maxSpeed scale too (the viewer's worldWeapon does the same). */
function inLevel(c: CompiledLevel, raw: WeaponSpec): WeaponSpec {
  const filled = JSON.parse(JSON.stringify(checkWeapon(raw)), (k, v) => (k === 'blast' ? fullBlast(v) : v)) as WeaponSpec;
  return checkWeapon(scaleWeapon(filled, cubeScale(c)));
}

/**
 * A level charge resolved (LevelDef.charges[index]; docs/design/charges.md): its spec in world units
 * (cubeScale, as w- items), the structure body it rides and its point there (host frame, m), how it is
 * armed, and its nominal yield: each blast's against levelFill times how often it can go off, plus a
 * pull's energy (shots.ts pullEnergy) per removeTarget.
 */
export interface ChargeArm { index: number; host: number; point: Vec3; arm: 'plunger' | 'start'; spec: WeaponSpec; yield: number }

const chargeCache = new WeakMap<CompiledLevel, ChargeArm[]>();

/** The level's charges resolved (ChargeArm), in LevelDef.charges order. Throws on the first that does not resolve (chargeIssues says why each). */
export function levelCharges(c: CompiledLevel): ChargeArm[] {
  const hit = chargeCache.get(c);
  if (hit) return hit;
  const issues = chargeIssues(c);
  if (issues.length) throw new Error(`${c.def.id}: ${issues.join('; ')}`);
  const out = chargesOf(c).arms;
  chargeCache.set(c, out);
  return out;
}

/** Why each of the level's charges does not resolve: one sentence per problem, empty when all do. */
export function chargeIssues(c: CompiledLevel): string[] {
  return chargesOf(c).issues;
}

function chargesOf(c: CompiledLevel): { arms: ChargeArm[]; issues: string[] } {
  const defs = c.def.charges ?? [], m = c.meta, h = c.frame.unit, issues: string[] = [], arms: ChargeArm[] = [];
  if (defs.length > MAX_CHARGES) issues.push(`${defs.length} charges, over ${MAX_CHARGES}`);
  const ice = materialId('ice');
  defs.forEach((d, i) => {
    const at = `charges.${i}`;
    if (!Number.isInteger(d.host) || d.host < 0 || d.host >= m.n) { issues.push(`${at}: host ${d.host} is not a structure body (0 to ${m.n - 1})`); return; }
    if (m.crowns.includes(d.host) || m.heritage.includes(d.host)) { issues.push(`${at}: host ${d.host} is a crown or heritage, which charges never ride`); return; }
    if (m.material[d.host] === ice) { issues.push(`${at}: host ${d.host} is ice, which shatters on its own`); return; }
    if (d.arm !== undefined && d.arm !== 'plunger' && d.arm !== 'start') { issues.push(`${at}: arm must be plunger or start, got ${JSON.stringify(d.arm)}`); return; }
    const p = d.at ?? [0, 0, 0];
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => Number.isFinite(x))) { issues.push(`${at}: at must be [x, y, z] in h`); return; }
    const half = [m.half[3 * d.host]!, m.half[3 * d.host + 1]!, m.half[3 * d.host + 2]!];
    const point: Vec3 = [p[0] * h, p[1] * h, p[2] * h];
    // Within the host's largest half-extent on every axis: inside it however it is turned (meta.half is its world box at rest).
    if (point.some((x) => Math.abs(x) > Math.max(...half) * (1 + 1e-9))) { issues.push(`${at}: at ${JSON.stringify(p)} h is outside its host`); return; }
    const raw = chargeWeaponOf(c.def, d.weapon);
    if (!raw) { issues.push(`${at}: weapon ${JSON.stringify(d.weapon)} is neither the level's nor a built-in charge (cutter, kicker, relay)`); return; }
    if (!('version' in raw)) { issues.push(`${at}: weapon ${d.weapon} is a GrenadeSpec; a charge is a WeaponSpec`); return; }
    let spec: WeaponSpec;
    try {
      spec = inLevel(c, raw);
      const bad = chargeProblems(spec);
      if (bad.length) throw new WeaponSpecError(bad);
    } catch (e) { issues.push(`${at}: ${(e as Error).message}`); return; }
    const fill = levelFill(c), b = weaponBudget(spec);
    const y = b.blasts.reduce((a, x) => a + x.count * nominalYield(fullBlast(x.blast), fill), 0) + b.targets * pullEnergy(c.frame);
    arms.push({ index: i, host: d.host, point, arm: d.arm ?? 'plunger', spec, yield: y });
  });
  return { arms, issues };
}

/** Energy a plunger shot is charged: the nominal yields of the charges it arms (the press itself is free). */
export function plungerYield(c: CompiledLevel, shot: PlungerShot): number {
  const arms = levelCharges(c);
  return shot.fuse.reduce((a, [i]) => a + (arms[i]?.yield ?? 0), 0);
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

/**
 * Whether body `id` is gone or going by engine step `step`: a removal of it pushed, due at or before
 * that step (the Driver keeps every removal it pushes). A charge event on such a body would be refused.
 */
export type Gone = (id: number, step: number) => boolean;

export class Arsenal {
  private readonly runtime: WeaponRuntime;
  /** The level's charges (docs/design/charges.md), each attached once armed: by a plunger, or at start. */
  private readonly charges: WeaponRuntime;
  /** Steps of the blasts pushed so far, to hold a settle until the last is due. */
  private blastSteps: number[] = [];

  constructor(readonly level: CompiledLevel, substeps: number) {
    const s = level.scene, world: GrenadeWorld = { dt: s.dt, substeps, gravity: s.gravity, groundY: s.ground?.y ?? null };
    // Observed every step: one step of lookahead is the serial reader's (as Grenades).
    this.runtime = new WeaponRuntime(world, 1);
    this.charges = new WeaponRuntime(world, 1);
  }

  /** Item `item` was fired as body `id`, its spawn due at `step`: the input to push now (a timer's blast). */
  launch(item: RackItem, id: number, step: number, shape: ShapeDesc): InputEvent[] {
    const arm = armOf(this.level, item);
    if (!arm) return [];
    return this.track(this.runtime.launch(id, step, arm.spec, shape));
  }

  /**
   * Arms the charges a level arms at start (ChargeDef.arm 'start'), their clocks at engine step
   * `step`, with `s` the state after it: what is due at once (pushed at `step`, before anything moves).
   */
  armStart(s: Snapshot, step: number, gone: Gone): InputEvent[] {
    const out: InputEvent[] = [];
    for (const ch of levelCharges(this.level)) if (ch.arm === 'start') out.push(...this.charges.attach(ch.host, step, ch.spec, ch.point, { s, step, floor: step }));
    return this.charged(out, gone);
  }

  /**
   * A plunger went in at engine step `step` (Session.fire accepted it): each charge it names armed at
   * step + delay, in its order. `s`: the state observed last (after sStep steps). What is due at once.
   */
  plunger(shot: PlungerShot, step: number, s: Snapshot, sStep: number, gone: Gone): InputEvent[] {
    const arms = levelCharges(this.level), out: InputEvent[] = [];
    for (const [i, delay] of shot.fuse) {
      const ch = arms[i]!;
      out.push(...this.charges.attach(ch.host, step + delay, ch.spec, ch.point, { s, step: sStep, floor: step }));
    }
    return this.charged(out, gone);
  }

  /**
   * The input the state after `step` steps sets off; bodies: every body's description by
   * id; idOf: the id a spawn this arsenal returned was given (a split's children); gone: removals
   * already pushed (a charge riding a body gone by its event's step is dropped).
   */
  observe(s: Snapshot, step: number, bodies: readonly BodyDesc[], idOf: (spawn: SpawnEvent) => number, gone: Gone = () => false): InputEvent[] {
    const out = this.runtime.pending ? this.track(this.runtime.observe(s, step, bodies, idOf)) : [];
    if (this.charges.pending) out.push(...this.charged(this.charges.observe(s, step, bodies), gone));
    return out;
  }

  /**
   * Whether a rule is still to fire or a blast has yet to show in the state after `step`
   * steps: an event due at step b applies when the engine steps from b, so that state first
   * shows it at b + 1. The shot is not over. A charge counts while its timer runs or a rule of
   * it is committed, not while it only watches (a relay could wait for ever).
   */
  pending(step: number): boolean {
    return this.runtime.pending > 0 || this.charges.waiting > 0 || this.blastSteps.some((b) => b >= step);
  }

  /** Charges armed and still to fire or watching (for tests and the HUD). */
  get chargesLive(): number {
    return this.charges.pending;
  }

  /** Charge events less those on a body gone by then (its charges dropped with it), in order; blasts tracked. */
  private charged(events: InputEvent[], gone: Gone): InputEvent[] {
    const out: InputEvent[] = [], removed = new Map<number, number>();
    const dead = (id: number, step: number) => gone(id, step) || (removed.has(id) && removed.get(id)! <= step);
    for (const e of events) {
      const host = e.kind === 'remove' ? e.id : e.kind === 'blast' && typeof e.blast.centre === 'object' && 'body' in e.blast.centre ? e.blast.centre.body : -1;
      if (host >= 0 && dead(host, e.step)) { this.charges.drop(host); continue; }
      if (e.kind === 'remove') removed.set(e.id, e.step);
      out.push(e);
    }
    return this.track(out);
  }

  private track(events: InputEvent[]): InputEvent[] {
    for (const e of events) if (e.kind === 'blast') this.blastSteps.push(e.step);
    return events;
  }
}
