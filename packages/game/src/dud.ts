// A shot that did nothing (PT31, agent playtest 2, J1 #6): on L2 the marbles moved nothing for three shots and on L4
// the anvil sat on the fulcrum, in silence, and the card then said "×0.00 (Brute)". After such a shot the game floats
// one line over where it was aimed, saying so and what to try (play.ts, at the shot's settle). Pure, so tested alone.
import { massOf } from '@tb/engine-api';
import { ammoBody, type CompiledLevel, GRAVITY, itemRef, itemSpec, itemYield, type RackItem, type ShotOutcome } from '@tb/keystone';

/** A shot is a dud when it displaced fewer than this share of the structure's bodies (the judges' "under 1%"). */
export const DUD_SHARE = 0.01;

/**
 * Whether a settled shot did nothing: the bodies it displaced (its outcome's count less the shot before's, both
 * counted from the structure's start) under DUD_SHARE of the structure's `n`, and no crown down with it.
 */
export function isDud(o: Pick<ShotOutcome, 'displaced' | 'crownsDown'>, displacedBefore: number, n: number): boolean {
  return o.crownsDown === 0 && o.displaced - displacedBefore < DUD_SHARE * n;
}

/**
 * How hard a rack item hits on level `c`, J, to rank what to try next: a launched body's kinetic energy at full
 * power plus a weapon's yield; a drop's weight over the structure's height. Null for what fires no body (pull,
 * plunger, quake): those never get the note.
 */
export function itemPunch(c: CompiledLevel, item: RackItem): number | null {
  const r = itemRef(item);
  if (!r || r.kind === 'pull' || r.kind === 'plunger' || r.kind === 'quake') return null;
  const m = massOf(ammoBody(item, c.frame, [0, 0, 0], [0, 0, 0]));
  if (r.kind === 'ammo' && r.ammo === 'drop') return m * GRAVITY * c.height;
  const v = itemSpec(item, c.frame).vMax;
  return 0.5 * m * v * v + itemYield(c, item);
}

/**
 * The note after a dud: what to try. The hardest-hitting item still in the rack, when it hits clearly harder (1.5x)
 * than the one just fired ("Nothing moved: try the cannonball"); else another spot.
 */
export function dudNote(fired: RackItem, left: readonly RackItem[], punch: (item: RackItem) => number | null, label: (item: RackItem) => string): string {
  const mine = punch(fired);
  let best: RackItem | null = null, bestPunch = 0;
  for (const item of new Set(left)) {
    const p = punch(item);
    if (p !== null && p > bestPunch) { best = item; bestPunch = p; }
  }
  if (mine !== null && best !== null && best !== fired && bestPunch > 1.5 * mine) return `Nothing moved: try the ${label(best).toLowerCase()}`;
  return 'Nothing moved: try another spot';
}

/** An inner collapse is a shot that brought down at least this share of what could fall (collapse fraction D)... */
export const INNER_SHARE = 0.05;
/** ...while the top stood (the skyline, over its start, fell less than this) and under DUD_SHARE of the bodies left the lot. */
export const INNER_SKYLINE = 0.02;

/**
 * The note after a shot that gave way inside (PT31, J3 #20: T-X2's "Down 12%" with nothing to see): the slabs fell
 * inside a shell that still stands, so the picture shows no change. `down`: the shot's rise in collapse fraction D;
 * `skylineDrop`: its fall in the skyline ratio; `spilled`: bodies it put outside the lot; `n` the structure's bodies.
 * Null when the shot's change shows (the top came down, or debris spilled) or was small.
 */
export function innerNote(down: number, skylineDrop: number, spilled: number, n: number): string | null {
  if (!(down >= INNER_SHARE) || skylineDrop >= INNER_SKYLINE || spilled >= DUD_SHARE * n) return null;
  return `Gave way inside: ${Math.floor(100 * down)}% down`;
}
