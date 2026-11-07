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
// acts on a removed munition, which engines refuse; a split's also wait until
// its step is within the lookahead (its children start from the munition's
// state then). A step already passed when it is released (a reader observing
// less often than it looks ahead) is moved to the next one.
//
// A split places `into` children on its pattern (splitDirections) around the
// munition's state at the split step: the free-flight prediction from the
// observed state, right while it flies free, to rounding: the engines'
// free flight and freeFlight agree to an ulp or so, not bit for bit, so a
// reader observing less often places children alike, not identically (a
// later engine primitive spawns relative to the live state: docs/design/
// weapons.md step 5). Each child
// starts at pos + at * dir with velocity vel + spread * dir, unrotated and
// not spinning, then the munition is removed. Children run their own rules
// from their spawn step.
//
// Ids: a child's id is whatever the engine gives its spawn, by the engine's
// numbering (spawns in the order they apply: by step, then push order). The
// caller knows that order and passes idOf (the id of a spawn event it pushed,
// the same object the runtime returned), which the runtime asks once the
// spawn has applied (its step is before the observed state's).
//
// Charges (attach; docs/design/charges.md): a munition with no body, riding a
// host body at a point in the host's frame. Its triggers watch the host
// (moved), its blasts are centred on the host at that point (turned by the
// host's rotation in the state the event was decided from) and push the host
// too, removeTarget removes the host and remove spends the charge with no
// event. Its events are released just in time: only once due at the earliest
// step an event may still carry (the step after the observed one; at attach,
// the step given), so the caller can drop a charge whose host has gone
// before its events reach the engine (drop). A charge whose host shows as
// removed (Snapshot.tier TIER_FREE) is dropped by observe. A charge may watch
// another body than its host (attach's `watch`: Fuse & Fold's domino fuses,
// M5b): its moved trigger then reads that body's state, and everything else
// (blasts, removeTarget, riding and dropping) stays its host's.
import { type BodyDesc, freeFlight, type InputEvent, type ShapeDesc, type Snapshot, type SpawnEvent, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { checkGrenade, flightPath, type GrenadeSpec, type GrenadeWorld, type PathPoint, proximityStep, stepsOf } from './grenade.ts';
import {
  type Action, chargeProblems, checkWeapon, grenadeAsSpec, isWeaponSpec, type MunitionSpec, type Rule, splitDirections, thrownProblems, type Trigger, type WeaponSpec, WeaponSpecError,
} from './spec.ts';

/** Friction and restitution of a shell that sets none (BodyDesc needs both). */
export const SHELL_FRICTION = 0.5;
export const SHELL_RESTITUTION = 0;

type Node =
  | { k: 'after'; steps: number }
  | { k: 'near'; prox: number; arm: number; ground: boolean }
  | { k: 'apex' }
  /** ref: the centre in the first state observed once its clock started (set then). */
  | { k: 'moved'; d2: number; v2: number | null; ref: Vec3 | null }
  | { k: 'then'; a: Node; b: Node; aStep: number | null }
  | { k: 'any'; xs: Node[] };

interface RuleLive {
  rule: Rule;
  node: Node;
  /** The step it fires at, once committed. */
  due: number | null;
  spends: boolean;
  splits: boolean;
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
  /** A charge: its point in its host's frame (id is the host); null for a munition with a body. */
  charge: Vec3 | null;
  /** A charge's watched body (its moved trigger reads it): the host unless attach named another. */
  watch: number | null;
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

const spends = (a: Action) => 'remove' in a || 'removeTarget' in a || 'split' in a;
/** Whether a trigger has a clock running towards a step it will fire at (a timer), rather than only watching. */
const ticking = (n: Node): boolean => n.k === 'after' || (n.k === 'then' ? ticking(n.aStep === null ? n.a : n.b) : n.k === 'any' && n.xs.some(ticking));

export class WeaponRuntime {
  private live: Live[] = [];

  /** lookahead: steps beyond each observed state to predict (about the steps between observations). */
  constructor(readonly world: GrenadeWorld, readonly lookahead = 1) {
    if (!(world.dt > 0) || !Number.isInteger(world.substeps) || world.substeps < 1) throw new Error(`WeaponRuntime: bad world ${JSON.stringify(world)}`);
    if (!Number.isInteger(lookahead) || lookahead < 0) throw new Error(`WeaponRuntime: lookahead must be an integer >= 0: ${lookahead}`);
  }

  /** Munitions with a rule still to fire (charges included). */
  get pending(): number {
    return this.live.length;
  }

  /**
   * Munitions with a rule committed to a step and not yet fired, or a timer running: what holds a
   * shot open. A charge only watching (moved, no timer) could wait for ever, and does not count.
   */
  get waiting(): number {
    return this.live.filter((g) => g.rules.some((r) => r.due !== null || ticking(r.node))).length;
  }

  /**
   * A weapon was fired: body `id` with shape `shape`, whose spawn is due at
   * engine step `step`. A GrenadeSpec runs as grenadeAsSpec. Returns what can
   * be pushed already (rules on timers alone).
   */
  launch(id: number, step: number, weapon: WeaponSpec | GrenadeSpec, shape: ShapeDesc): InputEvent[] {
    const spec = isWeaponSpec(weapon) ? checkWeapon(weapon) : grenadeAsSpec(checkGrenade(weapon), { shape, density: 1, speed: [0, 0] });
    const bad = thrownProblems(spec);
    if (bad.length) throw new WeaponSpecError(bad);
    const g: Live = { id, spawn: null, m: spec, radius: boundingRadius(shape), base: step, rules: spec.rules.map((r) => this.ruleLive(r)), charge: null, watch: null };
    this.live.push(g);
    const out: InputEvent[] = [];
    this.pass(g, null, out, []);
    this.live = this.live.filter((x) => x.rules.length);
    return out;
  }

  /**
   * A charge (chargeProblems lists what one cannot have) on body `host` at `point` (host frame,
   * world units), its clock starting at engine step `step`. `now`, if given: the state after
   * now.step steps, to decide from at once, and `floor` (>= now.step), the earliest step an event
   * may carry (the engine's stepIndex: a plunger's fire step); the events due by then are returned.
   * Without it nothing is decided until the next observe. `watch`: the body its moved trigger reads (default the
   * host): a detonator on a column set off by a domino falling elsewhere (Fuse & Fold's fuses, M5b).
   */
  attach(host: number, step: number, weapon: WeaponSpec, point: Vec3 = [0, 0, 0], now?: { s: Snapshot; step: number; floor: number }, watch: number = host): InputEvent[] {
    const spec = checkWeapon(weapon), bad = chargeProblems(spec);
    if (bad.length) throw new WeaponSpecError(bad);
    if (!Number.isInteger(host) || host < 0) throw new Error(`WeaponRuntime.attach: bad host ${host}`);
    if (!Number.isInteger(watch) || watch < 0) throw new Error(`WeaponRuntime.attach: bad watched body ${watch}`);
    const g: Live = { id: host, spawn: null, m: spec, radius: 0, base: step, rules: spec.rules.map((r) => this.ruleLive(r)), charge: [point[0], point[1], point[2]], watch };
    this.live.push(g);
    const out: InputEvent[] = [];
    if (now) {
      if (now.floor < now.step) throw new Error(`WeaponRuntime.attach: floor ${now.floor} is before the observed step ${now.step}`);
      this.pass(g, { s: now.s, step: now.step, horizon: now.step + this.lookahead, path: [], shapes: [] }, out, [], now.floor);
    }
    this.live = this.live.filter((x) => x.rules.length);
    return out;
  }

  /** Forgets every charge riding body `host` (it has gone, or is going, before their events went in); how many. */
  drop(host: number): number {
    const before = this.live.length;
    this.live = this.live.filter((g) => !(g.charge && g.id === host));
    return before - this.live.length;
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
      if (g.charge) {
        // A watched body not in this state yet (it cannot be, for a structure body; checked as the host is).
        if (g.watch! >= s.count) continue;
        // A charge whose host is out of the world is gone with it.
        if (s.tier && s.tier[g.id] === TIER_FREE) { g.rules = []; continue; }
        this.pass(g, { s, step, horizon: step + this.lookahead, path: [], shapes }, out, born, step + 1);
        continue;
      }
      const seen: Seen = { s, step, horizon: step + this.lookahead, path: flightPath(s, g.id, step, this.lookahead, this.world), shapes };
      this.pass(g, seen, out, born);
    }
    this.live = [...this.live.filter((g) => g.rules.length), ...born];
    return out;
  }

  private ruleLive(rule: Rule): RuleLive {
    const dt = this.world.dt;
    const node = (t: Trigger): Node => {
      if ('after' in t) return { k: 'after', steps: stepsOf(t.after, dt) };
      if ('near' in t) return { k: 'near', prox: t.near, arm: stepsOf(t.arm ?? 0, dt), ground: t.ground ?? true };
      if ('apex' in t) return { k: 'apex' };
      if ('moved' in t) return { k: 'moved', d2: t.moved * t.moved, v2: t.speed === undefined ? null : t.speed * t.speed, ref: null };
      if ('then' in t) return { k: 'then', a: node(t.then[0]), b: node(t.then[1]), aStep: null };
      return { k: 'any', xs: t.any.map(node) };
    };
    return { rule, node: node(rule.when), due: null, spends: rule.do.some(spends), splits: rule.do.some((a) => 'split' in a) };
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
      case 'moved': {
        // Decided from observed states only: due at the step after the one that shows it.
        if (!seen || seen.step < base) return null;
        const i = g.watch ?? g.id!, s = seen.s, p: Vec3 = [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!];
        if (!n.ref) n.ref = p;
        const dx = p[0] - n.ref[0], dy = p[1] - n.ref[1], dz = p[2] - n.ref[2];
        if (dx * dx + dy * dy + dz * dz >= n.d2) return seen.step + 1;
        if (n.v2 !== null) {
          const vx = s.linVel[3 * i]!, vy = s.linVel[3 * i + 1]!, vz = s.linVel[3 * i + 2]!;
          if (vx * vx + vy * vy + vz * vz >= n.v2) return seen.step + 1;
        }
        return null;
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

  /**
   * Commits what g's rules can, then releases rules in step order while nothing open could come
   * first. floor (charges only): the earliest step an event may carry; a charge's rule is released
   * only once due by then (just in time).
   */
  private pass(g: Live, seen: Seen | null, out: InputEvent[], born: Live[], floor?: number): void {
    for (const r of g.rules) if (r.due === null) r.due = this.due(r.node, g.base, g, seen);
    const horizon = seen ? seen.horizon : -Infinity;
    for (;;) {
      // The next committed rule, by step then rule order.
      let next: RuleLive | null = null;
      for (const r of g.rules) if (r.due !== null && (!next || r.due < next.due!)) next = r;
      if (!next) return;
      if (g.charge && next.due! > floor!) return;
      const at = Math.max(next.due!, g.charge ? floor! : seen ? seen.step + 1 : -Infinity);
      // Another rule that spends g and is still open could fire before it.
      if (g.rules.some((r) => r !== next && r.spends && r.due === null) && at > horizon) return;
      if (next.splits && (!seen || at > Math.max(horizon, seen.step + 1))) return;
      this.fire(g, next, at, seen, out, born);
      g.rules = next.spends ? [] : g.rules.filter((r) => r !== next);
    }
  }

  private fire(g: Live, r: RuleLive, step: number, seen: Seen | null, out: InputEvent[], born: Live[]): void {
    const id = g.id!;
    if (g.charge) {
      for (const a of r.rule.do) {
        if ('removeTarget' in a) out.push({ step, kind: 'remove', id });
        else if ('blast' in a) {
          // The charge's point, turned into the world frame by the host's observed rotation, plus the blast's own offset.
          const q = seen!.s.rot, c = g.charge, w = rotate([q[4 * id]!, q[4 * id + 1]!, q[4 * id + 2]!, q[4 * id + 3]!], c);
          const { offset, ...b } = a.blast, o: Vec3 = offset ? [w[0] + offset[0], w[1] + offset[1], w[2] + offset[2]] : w;
          const zero = o[0] === 0 && o[1] === 0 && o[2] === 0;
          out.push({ step, kind: 'blast', blast: { centre: zero ? { body: id } : { body: id, offset: o }, ...b } });
        }
        // remove: the charge is spent; no engine event (and no split: chargeProblems).
      }
      return;
    }
    for (const a of r.rule.do) {
      if ('remove' in a) out.push({ step, kind: 'remove', id });
      else if ('blast' in a) {
        const { offset, ...b } = a.blast;
        out.push({ step, kind: 'blast', blast: { centre: offset ? { body: id, offset } : { body: id }, exclude: [id], ...b } });
      } else if ('split' in a) {
        const sp = a.split, child = g.m.children![sp.child]!;
        // The munition's state at the split step, from the observed state.
        const last = seen!.path[seen!.path.length - 1]!;
        let { p, v } = seen!.path.find((q) => q.step === step) ?? last;
        if (step > last.step) {
          const f = flightPathFrom(p, v, step - last.step, this.world);
          p = f.p; v = f.v;
        }
        const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        const axis: Vec3 = speed > 1e-9 ? [v[0] / speed, v[1] / speed, v[2] / speed] : [0, 1, 0];
        const dist = sp.at ?? g.radius, spread = sp.spread ?? 0;
        for (const d of splitDirections(sp.into, sp.pattern ?? 'sphere', sp.angle ?? 30, axis)) {
          const body: BodyDesc = {
            shape: child.shell.shape,
            pos: [p[0] + dist * d[0], p[1] + dist * d[1], p[2] + dist * d[2]],
            rot: [0, 0, 0, 1],
            linVel: [v[0] + spread * d[0], v[1] + spread * d[1], v[2] + spread * d[2]],
            angVel: [0, 0, 0],
            density: child.shell.density,
            friction: child.shell.friction ?? SHELL_FRICTION,
            restitution: child.shell.restitution ?? SHELL_RESTITUTION,
            tag: 0,
          };
          const spawn: SpawnEvent = { step, kind: 'spawn', body };
          out.push(spawn);
          born.push({ id: null, spawn, m: child, radius: boundingRadius(child.shell.shape), base: step, rules: child.rules.map((cr) => this.ruleLive(cr)), charge: null, watch: null });
        }
        out.push({ step, kind: 'remove', id });
      }
    }
  }
}

/** v turned by unit quaternion q = (x, y, z, w): v + 2 w (u x v) + 2 u x (u x v), u = (x, y, z). */
function rotate(q: [number, number, number, number], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function flightPathFrom(p: Vec3, v: Vec3, steps: number, world: GrenadeWorld): { p: Vec3; v: Vec3 } {
  let pos = p, vel = v;
  for (let k = 0; k < steps; k++) ({ pos, vel } = freeFlightStep(pos, vel, world));
  return { p: pos, v: vel };
}

const freeFlightStep = (p: Vec3, v: Vec3, w: GrenadeWorld) => freeFlight(p, v, w.gravity, w.dt, w.substeps, 1);
