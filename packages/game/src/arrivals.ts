// Interpolating between snapshots by when they arrive. Shared by the
// viewer's free physics loop (viewer loop.ts runFree) and the game's
// (play.ts): both draw every frame while physics runs at its own pace.

/** When the newest snapshot arrived and the usual time between snapshots (EMA), ms. */
export interface Arrivals { last: number; interval: number }

export function newArrivals(): Arrivals {
  return { last: NaN, interval: NaN };
}

/**
 * Record a snapshot arriving at now (ms). A gap counts as at most the larger
 * of 8 steps and twice the usual interval: one stall barely moves the
 * interval, while an engine that takes longer than 8 steps every step still
 * reaches its own interval (each sample can raise it by a fifth).
 */
export function arrived(a: Arrivals, now: number, dtMs: number): void {
  if (!Number.isNaN(a.last)) {
    const gap = Math.min(now - a.last, Math.max(8 * dtMs, Number.isNaN(a.interval) ? 0 : 2 * a.interval));
    a.interval = Number.isNaN(a.interval) ? gap : 0.8 * a.interval + 0.2 * gap;
  }
  a.last = now;
}

/**
 * The renderer's alpha for a frame at now: 0 draws the snapshot before the
 * newest, 1 the newest. It ramps over the usual time between snapshots (at
 * least one dt), so motion stays smooth when steps and frames run at different
 * rates; the price is drawing up to one snapshot interval behind.
 *
 * Why arrival time and not sim time (each snapshot stamped with the time its
 * step was due, drawn at now minus a fixed delay): sim time is the exact
 * cadence while physics keeps up, but in slow motion snapshots arrive slower
 * than their stamps advance, so a fixed delay runs out of snapshots and the
 * pose stalls and jumps. Arrival time stretches with the engine.
 */
export function alphaAt(a: Arrivals, now: number, dtMs: number): number {
  if (Number.isNaN(a.last)) return 1;
  const span = Math.max(dtMs, Number.isNaN(a.interval) ? dtMs : a.interval);
  return Math.min(1, Math.max(0, (now - a.last) / span));
}
