// WeaponRuntime: runs WeaponSpecs (spec.ts) as Grenades runs grenades. Pure
// logic over snapshots: the caller fires a weapon's shell, tells the runtime
// (launch), and feeds it the states it observes (observe); both return the
// input events to push (blasts, removals, the spawns of split children).
//
// When rules fire. A trigger is decided as Grenades decides a fuse: from an
// observed state k (a snapshot after k steps), due at k + 1 at the soonest,
// looking `lookahead` steps ahead along the munition's free-flight path, so a
// reader observing every step with lookahead 1 and one observing every 4
// steps with lookahead 4 fire on the same step while nothing near the path
// moves much. A timer (after) is known without observing. Each trigger
// either commits to a step or says "not at any step up to the lookahead":
//   after   the munition's spawn step (or the step the first of a then held)
//           plus its delay, rounded to steps: committed at once;
//   near    proximityStep over the armed points of the path (Grenades' fuse);
//   apex    the first path point with vertical speed <= 0;
//   then    the second, its clock started at the step the first committed to;
//   any     the earliest of those committed, once none still open could come
//           before it (an open one cannot fire up to the lookahead).
// A rule fires once. Its events go out (are released) when no other rule of
// the munition that removes or splits it could still fire first, so nothing
// acts on a removed munition, which engines refuse. A step already passed when
// it is released (a reader observing less often than it looks ahead) is moved
// to the next one.
//
// A split spawns `into` children relative to the munition (engine-api spawn.ts:
// SpawnEvent.from), so the engine places them from the munition's own state as
// the split step starts, whatever the reader saw of it and when: every reader
// cadence that fires the split at the same step spawns the same children, bit
// for bit. Each child starts at `at` along its pattern direction (splitPattern:
// ring and sphere in world axes, cone and fan in heading axes, around the
// munition's velocity), moving with the munition plus `spread` along the
// direction (and with its spin, which the engine adds), then the munition is
// removed. With `conserve` the directions are centred first (their mean taken
// off), so the offsets and the spreads sum to zero and the children's centre of
// mass carries the munition's position and momentum on (per unit mass: equal to
// the munition's own when the children weigh what it weighed). Children run
// their own rules from their spawn step.
//
// A thrust or vibrate action pushes an engine-api ForceEvent on the munition
// at the rule's step: accel x its mass (shell density x volume), for `for`
// seconds rounded to steps (at least one). Engines refuse a queue that would
// force more than MAX_FORCED bodies at once, so the runtime counts the forces
// it has pushed (each from its step to its end or the munition's removal) and
// drops one that could make MAX_FORCED + 1 (forcesDropped counts them): it
// counts every force it pushed that overlaps the new one in steps, an upper
// bound on how many act together. Forces anyone else pushes are not counted.
// Near and apex triggers look ahead along the free-flight path (no force):
// with a lookahead of one step a force a moves the path by h^2 a, under a
// millimetre for any built-in.
//
// Ids: a child's id is whatever the engine gives its spawn, by the engine's
// numbering (spawns in the order they apply: by step, then push order). The
// caller knows that order and passes idOf (the id of a spawn event it pushed,
// the same object the runtime returned), which the runtime asks once the
// spawn has applied (its step is before the observed state's).
import { type BodyDesc, type Force, type ForceEvent, type InputEvent, MAX_FORCED, type ShapeDesc, type Snapshot, type SpawnEvent, type Vec3, volumeOf } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { checkGrenade, flightPath, type GrenadeSpec, type GrenadeWorld, type PathPoint, proximityStep, stepsOf } from './grenade.ts';
import { type Action, checkWeapon, grenadeAsSpec, isForceAction, isWeaponSpec, type MunitionSpec, type Rule, splitPattern, type ThrustSpec, type Trigger, type VibrateSpec, type WeaponSpec } from './spec.ts';

/** Friction and restitution of a shell that sets none (BodyDesc needs both). */
export const SHELL_FRICTION = 0.5;
export const SHELL_RESTITUTION = 0;

type Node =
  | { k: 'after'; steps: number }
  | { k: 'near'; prox: number; arm: number; ground: boolean }
  | { k: 'apex' }
  | { k: 'then'; a: Node; b: Node; aStep: number | null }
  | { k: 'any'; xs: Node[] };

interface RuleLive {
  rule: Rule;
  node: Node;
  /** The step it fires at, once committed. */
  due: number | null;
  spends: boolean;
}

interface Live {
  /** Body id, or null while its spawn has not applied. */
  id: number | null;
  /** The spawn event (children only), to ask idOf for its id. */
  spawn: SpawnEvent | null;
  m: MunitionSpec;
  radius: number;
  /** Step its spawn is due: the clock of its after triggers. */
  base: number;
  rules: RuleLive[];
  /** Its shell's mass (forces are accel x mass). */
  mass: number;
}

/** What a pass of the rules sees: the observed state and its path, or nothing (at launch). */
interface Seen {
  s: Snapshot;
  step: number;
  /** step + lookahead: an open trigger cannot fire at or before it. */
  horizon: number;
  path: PathPoint[];
  shapes: readonly { shape: ShapeDesc }[];
}

const spends = (a: Action) => 'remove' in a || 'split' in a;

/** The engine-api Force a thrust or vibrate action puts on a munition of `mass` in a world of step `dt`: accel x mass, its burn in steps (at least 1). */
export function forceOfAction(a: { thrust: ThrustSpec } | { vibrate: VibrateSpec }, mass: number, dt: number): Force {
  const t = 'thrust' in a ? a.thrust : a.vibrate, steps = Math.max(1, stepsOf(t.for, dt));
  const F: Vec3 = [t.accel[0] * mass, t.accel[1] * mass, t.accel[2] * mass];
  if ('thrust' in a) return { steps, thrust: F, axes: a.thrust.axes ?? 'heading' };
  return { steps, vibrate: F, period: a.vibrate.period, ...(a.vibrate.phase ? { phase: a.vibrate.phase } : {}) };
}

/** A force a munition takes on a timer from its spawn (a rule whose trigger is `after` alone): s after it, and the action. */
export interface TimedForce { after: number; action: { thrust: ThrustSpec } | { vibrate: VibrateSpec } }

/**
 * The forces munition `m` is sure to take on timers, in rule then action order (a later one at the same step
 * replaces an earlier, as in the engines): its motor, which an aim can fly. Rules after a timer that spends it
 * are left out (as the runtime drops them); forces on other triggers (near, apex) are not foreseeable and are
 * left out too.
 */
export function timedForces(m: MunitionSpec): TimedForce[] {
  const spentAt = Math.min(...m.rules.filter((r) => 'after' in r.when && r.do.some(spends)).map((r) => (r.when as { after: number }).after));
  const out: TimedForce[] = [];
  for (const r of m.rules) {
    if (!('after' in r.when) || r.when.after > spentAt) continue;
    for (const a of r.do) if (isForceAction(a)) out.push({ after: r.when.after, action: a });
  }
  return out;
}

export class WeaponRuntime {
  private live: Live[] = [];
  /** Forces pushed, by munition: [from, to) in steps (to shortened when it is removed). */
  private forced: { live: Live; from: number; to: number }[] = [];
  /** Force actions dropped because MAX_FORCED bodies could already be forced then. */
  forcesDropped = 0;

  /** lookahead: steps beyond each observed state to predict (about the steps between observations). */
  constructor(readonly world: GrenadeWorld, readonly lookahead = 1) {
    if (!(world.dt > 0) || !Number.isInteger(world.substeps) || world.substeps < 1) throw new Error(`WeaponRuntime: bad world ${JSON.stringify(world)}`);
    if (!Number.isInteger(lookahead) || lookahead < 0) throw new Error(`WeaponRuntime: lookahead must be an integer >= 0: ${lookahead}`);
  }

  /** Munitions with a rule still to fire. */
  get pending(): number {
    return this.live.length;
  }

  /**
   * A weapon was fired: body `id` with shape `shape`, whose spawn is due at
   * engine step `step`. A GrenadeSpec runs as grenadeAsSpec. Returns what can
   * be pushed already (rules on timers alone).
   */
  launch(id: number, step: number, weapon: WeaponSpec | GrenadeSpec, shape: ShapeDesc): InputEvent[] {
    const spec = isWeaponSpec(weapon) ? checkWeapon(weapon) : grenadeAsSpec(checkGrenade(weapon), { shape, density: 1, speed: [0, 0] });
    const g: Live = { id, spawn: null, m: spec, radius: boundingRadius(shape), base: step, rules: spec.rules.map((r) => this.ruleLive(r)), mass: spec.shell.density * volumeOf(shape) };
    this.live.push(g);
    const out: InputEvent[] = [], born: Live[] = [];
    this.pass(g, null, out, born);
    this.live = [...this.live.filter((x) => x.rules.length), ...born];
    return out;
  }

  /**
   * The events set off by the state after `step` steps (s), each due after
   * `step`. shapes: every body's shape by id, at least s.count of them. idOf:
   * the id the engine gave a spawn this runtime returned (needed once a split
   * has fired).
   */
  observe(s: Snapshot, step: number, shapes: readonly { shape: ShapeDesc }[], idOf?: (spawn: SpawnEvent) => number): InputEvent[] {
    const out: InputEvent[] = [], born: Live[] = [];
    for (const g of this.live) {
      if (g.id === null) {
        // Applied once its step is before the observed state's.
        if (g.spawn!.step >= step) continue;
        if (!idOf) throw new Error('WeaponRuntime.observe: a split child has spawned; pass idOf to number it');
        g.id = idOf(g.spawn!);
      }
      if (g.id >= s.count) continue;
      const seen: Seen = { s, step, horizon: step + this.lookahead, path: flightPath(s, g.id, step, this.lookahead, this.world), shapes };
      this.pass(g, seen, out, born);
    }
    this.live = [...this.live.filter((g) => g.rules.length), ...born];
    this.forced = this.forced.filter((f) => f.to > step);
    return out;
  }

  private ruleLive(rule: Rule): RuleLive {
    const dt = this.world.dt;
    const node = (t: Trigger): Node => {
      if ('after' in t) return { k: 'after', steps: stepsOf(t.after, dt) };
      if ('near' in t) return { k: 'near', prox: t.near, arm: stepsOf(t.arm ?? 0, dt), ground: t.ground ?? true };
      if ('apex' in t) return { k: 'apex' };
      if ('then' in t) return { k: 'then', a: node(t.then[0]), b: node(t.then[1]), aStep: null };
      return { k: 'any', xs: t.any.map(node) };
    };
    return { rule, node: node(rule.when), due: null, spends: rule.do.some(spends) };
  }

  /** The step `n` commits to, with its clock at `base`; null: not at any step up to the horizon. */
  private due(n: Node, base: number, g: Live, seen: Seen | null): number | null {
    switch (n.k) {
      case 'after':
        return base + n.steps;
      case 'near': {
        if (!seen) return null;
        const arm = base + n.arm;
        return proximityStep(seen.path.filter((q) => q.step >= arm), seen.s, seen.step, g.id!, g.radius, n.prox, n.ground ? this.world.groundY : null, seen.shapes);
      }
      case 'apex': {
        if (!seen) return null;
        const q = seen.path.find((p) => p.step >= base && p.v[1] <= 0);
        return q ? Math.max(q.step, seen.step + 1) : null;
      }
      case 'then':
        if (n.aStep === null) n.aStep = this.due(n.a, base, g, seen);
        return n.aStep === null ? null : this.due(n.b, n.aStep, g, seen);
      case 'any': {
        const ds = n.xs.map((x) => this.due(x, base, g, seen));
        const known = ds.filter((d): d is number => d !== null);
        if (!known.length) return null;
        const first = Math.min(...known);
        // An open one could still come first unless the earliest is within the horizon.
        if (known.length < ds.length && first > (seen ? seen.horizon : -Infinity)) return null;
        return first;
      }
    }
  }

  /** Commits what g's rules can, then releases rules in step order while nothing open could come first. */
  private pass(g: Live, seen: Seen | null, out: InputEvent[], born: Live[]): void {
    for (const r of g.rules) if (r.due === null) r.due = this.due(r.node, g.base, g, seen);
    const horizon = seen ? seen.horizon : -Infinity;
    for (;;) {
      // The next committed rule, by step then rule order.
      let next: RuleLive | null = null;
      for (const r of g.rules) if (r.due !== null && (!next || r.due < next.due!)) next = r;
      if (!next) return;
      const at = Math.max(next.due!, seen ? seen.step + 1 : -Infinity);
      // Another rule that spends g and is still open could fire before it.
      if (g.rules.some((r) => r !== next && r.spends && r.due === null) && at > horizon) return;
      this.fire(g, next, at, out, born);
      g.rules = next.spends ? [] : g.rules.filter((r) => r !== next);
    }
  }

  private fire(g: Live, r: RuleLive, step: number, out: InputEvent[], born: Live[]): void {
    const id = g.id!;
    const spent = () => { for (const f of this.forced) if (f.live === g) f.to = Math.min(f.to, step); };
    for (const a of r.rule.do) {
      if ('remove' in a) { out.push({ step, kind: 'remove', id }); spent(); }
      else if ('blast' in a) {
        const { offset, ...b } = a.blast;
        out.push({ step, kind: 'blast', blast: { centre: offset ? { body: id, offset } : { body: id }, exclude: [id], ...b } });
      } else if ('thrust' in a || 'vibrate' in a) {
        const force = forceOfAction(a, g.mass, this.world.dt), steps = force.steps;
        // An overlapping force of this munition is replaced by this one (engine-api force.ts), so it does not count.
        const others = this.forced.filter((f) => f.live !== g && f.from < step + steps && f.to > step).length;
        if (others >= MAX_FORCED) { this.forcesDropped++; continue; }
        for (const f of this.forced) if (f.live === g && f.to > step) f.to = Math.max(f.from, step);
        this.forced.push({ live: g, from: step, to: step + steps });
        const ev: ForceEvent = { step, kind: 'force', id, force };
        out.push(ev);
      } else {
        // Children in the munition's frame; the engine places them from its state as the step starts (spawn.ts).
        const sp = a.split, child = g.m.children![sp.child]!;
        const dist = sp.at ?? g.radius, spread = sp.spread ?? 0;
        const { dirs, axes } = splitPattern(sp.into, sp.pattern ?? 'sphere', sp.angle ?? 30, sp.conserve ?? false);
        for (const d of dirs) {
          const body: BodyDesc = {
            shape: child.shell.shape,
            pos: [dist * d[0], dist * d[1], dist * d[2]],
            rot: [0, 0, 0, 1],
            linVel: [spread * d[0], spread * d[1], spread * d[2]],
            angVel: [0, 0, 0],
            density: child.shell.density,
            friction: child.shell.friction ?? SHELL_FRICTION,
            restitution: child.shell.restitution ?? SHELL_RESTITUTION,
            tag: 0,
          };
          const spawn: SpawnEvent = { step, kind: 'spawn', body, from: { body: id, axes } };
          out.push(spawn);
          born.push({ id: null, spawn, m: child, radius: boundingRadius(child.shell.shape), base: step, rules: child.rules.map((cr) => this.ruleLive(cr)), mass: body.density * volumeOf(body.shape) });
        }
        out.push({ step, kind: 'remove', id });
        spent();
      }
    }
  }
}
