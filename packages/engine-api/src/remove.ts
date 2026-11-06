// Removal: an input event that takes a body out of the world (a spent
// grenade, a shell that splits into its children). Every engine applies it
// as this file says, and the shared case in @tb/testkit's remove.ts checks it.
//
// When: at the start of the step the event is due, in event order with the
// spawns and blasts due at the same step, before anything of the step runs.
// So a blast and then the removal of its grenade at the same step push the
// bodies around the grenade (exclude keeps the grenade out), then take it away.
//
// What a removed body is: its slot is a tombstone. Ids stay as they were
// (slots are never reused, so a body spawned later gets the next id, and a
// GPU engine's capacity counts removed bodies too). From that step on the
// body touches nothing (no pair, no ground contact), feels no gravity, no
// blast and no solve, and stays exactly where it was removed, with zero
// velocity. A snapshot reports it with tier TIER_FREE (the renderer's
// TIER.free, which every pass skips) and awake 0. Every other body moves
// as it would have had the removed one vanished at that point.
//
// Engines refuse (at init and push, before anything changes) a removal of a
// body that does not exist when it is due or was already removed, and a
// blast centred on a removed body (checkInputQueue).
import type { InputEvent } from './index.ts';
import { checkBlast } from './blast.ts';
import { checkField } from './field.ts';

/** Snapshot.tier of a removed body: @tb/schema TIER.free (an unused slot; every render pass skips it). */
export const TIER_FREE = 255;

/**
 * Throws unless every event in `queue` (the events an engine will apply, in
 * order) can be applied: each field event passes checkField (field.ts); each blast passes checkBlast and, centred on a body,
 * names one that exists and is not removed when it is due; each removal names
 * a body that exists then and is not removed yet. `existing` bodies are there
 * at the start, `removed` of them already removed.
 */
export function checkInputQueue(existing: number, queue: readonly InputEvent[], removed: ReadonlySet<number> = new Set()): void {
  let n = existing;
  const gone = new Set(removed);
  for (const ev of queue) {
    if (ev.kind === 'spawn') { n++; continue; }
    if (ev.kind === 'field') { checkField(ev); continue; }
    if (ev.kind === 'remove') {
      const id = ev.id;
      if (!Number.isInteger(id) || id < 0) throw new Error(`remove at step ${ev.step}: id must be a body id, got ${JSON.stringify(id)}`);
      if (id >= n) throw new Error(`remove at step ${ev.step} names body ${id}, which does not exist then (${n} bodies)`);
      if (gone.has(id)) throw new Error(`remove at step ${ev.step} names body ${id}, which is already removed`);
      gone.add(id);
      continue;
    }
    const b = checkBlast(ev.blast);
    if (b.body >= n) throw new Error(`blast at step ${ev.step} is centred on body ${b.body}, which does not exist then (${n} bodies)`);
    if (b.body >= 0 && gone.has(b.body)) throw new Error(`blast at step ${ev.step} is centred on body ${b.body}, which is removed then`);
  }
}

/** checkInputQueue, by its earlier name (a queue of spawns and blasts). */
export const checkBlastQueue = (existing: number, queue: readonly InputEvent[]): void => checkInputQueue(existing, queue);
