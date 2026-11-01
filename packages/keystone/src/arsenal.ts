// The rack's weapons at play (roadmap G3.3, spectacle-mode.md sections 4 and 7):
// what a w-<key> item costs in energy fired, and the fuses of the ones in flight.
//
// - Cost: a blast is charged its nominal yield (@tb/weapons nominalYield) against
//   a solid fill of the level's commonest structure block, a static figure, so a
//   grenade placed in the dense base (the clever shot) costs what one wasted in
//   the air does.
// - Fuses: Arsenal wraps @tb/weapons Grenades for one session. Driver tells it
//   about each weapon it fires (launch) and shows it every state it observes
//   (observe); both return the input to push (Driver.push: due after the state
//   observed), the same rule a PlayOptions.perStep hook follows, so a live
//   session and its replay on the same driver options push the same events at
//   the same steps. pending() holds the shot's settle while a fuse or a blast is
//   still to come.
import { blastArea, type BodyDesc, type InputEvent, type ShapeDesc, type Snapshot } from '@tb/engine-api';
import { Grenades, type GrenadeWorld, nominalYield, type YieldFill } from '@tb/weapons';
import type { CompiledLevel } from './level.ts';
import { itemRef, levelWeapon, type RackItem } from './rack.ts';

const fills = new WeakMap<CompiledLevel, YieldFill>();

/**
 * A solid fill of the level's commonest structure block (by material and size; the
 * first such body on a tie): its mass over its lattice cell (its box widened by the
 * horizontal pitch), and its silhouette per mass. Empty levels fill nothing.
 */
export function levelFill(c: CompiledLevel): YieldFill {
  const hit = fills.get(c);
  if (hit) return hit;
  const m = c.meta, count = new Map<string, number>();
  let best = -1, bestN = 0;
  for (let i = 0; i < m.n; i++) {
    const key = `${m.material[i]} ${m.half[3 * i]} ${m.half[3 * i + 1]} ${m.half[3 * i + 2]}`, k = (count.get(key) ?? 0) + 1;
    count.set(key, k);
    if (k > bestN) { bestN = k; best = i; }
  }
  let fill: YieldFill = { density: 0, areaPerMass: 0 };
  if (best >= 0) {
    const hx = m.half[3 * best]!, hy = m.half[3 * best + 1]!, hz = m.half[3 * best + 2]!, mass = m.mass[best]!, p = c.frame.pitch;
    fill = { density: mass / (8 * hx * hy * hz * p * p), areaPerMass: blastArea({ kind: 'box', half: [hx, hy, hz] }) / mass };
  }
  fills.set(c, fill);
  return fill;
}

/** Energy fired by a rack item beyond its launch: a weapon's nominal yield, J; 0 for anything else. */
export function itemYield(c: CompiledLevel, item: RackItem): number {
  const r = itemRef(item);
  if (r?.kind !== 'weapon') return 0;
  const w = levelWeapon(c.def, r.key);
  if (!w) throw new Error(`${item}: ${c.def.id} has no weapons.${r.key}`);
  return nominalYield(w.blast, levelFill(c));
}

export class Arsenal {
  private readonly grenades: Grenades;
  /** Steps of the blasts pushed so far, to hold a settle until the last is due. */
  private blastSteps: number[] = [];

  constructor(readonly level: CompiledLevel, substeps: number) {
    const s = level.scene, world: GrenadeWorld = { dt: s.dt, substeps, gravity: s.gravity, groundY: s.ground?.y ?? null };
    // Observed every step: one step of lookahead is the serial reader's (Grenades).
    this.grenades = new Grenades(world, 1);
  }

  /** Item `item` was fired as body `id`, its spawn due at `step`: the input to push now (a timer fuse's blast). */
  launch(item: RackItem, id: number, step: number, shape: ShapeDesc): InputEvent[] {
    const r = itemRef(item);
    if (r?.kind !== 'weapon') return [];
    const w = levelWeapon(this.level.def, r.key);
    if (!w) throw new Error(`${item}: ${this.level.def.id} has no weapons.${r.key}`);
    return this.track(this.grenades.launch(id, step, w, shape));
  }

  /** The input the state after `step` steps sets off; bodies: every body's description by id. */
  observe(s: Snapshot, step: number, bodies: readonly BodyDesc[]): InputEvent[] {
    if (!this.grenades.pending) return [];
    return this.track(this.grenades.observe(s, step, bodies));
  }

  /**
   * Whether a fuse is still live or a blast has yet to show in the state after `step` steps:
   * an event due at step b applies when the engine steps from b, so that state first shows it
   * at b + 1. The shot is not over.
   */
  pending(step: number): boolean {
    return this.grenades.pending > 0 || this.blastSteps.some((b) => b >= step);
  }

  private track(events: InputEvent[]): InputEvent[] {
    for (const e of events) if (e.kind === 'blast') this.blastSteps.push(e.step);
    return events;
  }
}
