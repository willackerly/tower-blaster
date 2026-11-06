// Per-island observers (C10; docs/design/islands.md). A question asked of every
// island at once, "how many of your bodies satisfy P?", is one histogram of
// the observer contract (observe.ts): each body carries its island index in a
// tag word, and `hist by tag` with `where P` counts the bodies of every island
// that satisfy P in one pass, K bins, exactly as the observer counts anything.
// So it costs one output per question, not one per island, and a native GPU
// observer (E3) runs it with no change here.
import type { Islands } from './islands.ts';
import { type Observer, type OutResult, type Pred, reduceRef, type ReduceSpec } from './observe.ts';
import type { Snapshot } from './index.ts';

/** Tag bits that hold an island index below K. */
export const islandBits = (K: number): number => Math.max(1, Math.ceil(Math.log2(K)));

/** One output per predicate: the count of each island's bodies that satisfy it, from the island index in tag word `word`. */
export function islandSpec(K: number, preds: readonly Pred[], word = 0): ReduceSpec {
  return { outputs: preds.map((where) => ({ op: 'hist', by: { tag: word, bits: islandBits(K), bins: K }, where }) as const) };
}

export interface IslandCounts {
  /** Steps taken when the state was sampled. */
  step: number;
  /** Per predicate, per island: bodies that satisfy it. */
  counts: Uint32Array[];
  /** Per predicate: bodies whose predicate evaluated to ⊥ (observe.ts), summed over the islands. */
  invalid: number[];
}

/** The counts in the outputs of islandSpec. */
export function islandCounts(step: number, out: readonly OutResult[]): IslandCounts {
  return { step, counts: out.map((o) => o.bins ?? new Uint32Array(0)), invalid: out.map((o) => o.invalid) };
}

/** islandSpec evaluated on a snapshot by the reference reducer, with the islands' tags (no prev: dv reads ⊥). */
export function reduceIslands(islands: Islands, s: Snapshot, preds: readonly Pred[], opts: { refs?: readonly (Float64Array | null)[]; prevLinVel?: Float64Array; prevCount?: number; step?: number } = {}): IslandCounts {
  const spec = islandSpec(islands.K, preds), g = islands.scene.gravity;
  const out = reduceRef(spec, {
    snap: s, prevLinVel: opts.prevLinVel ?? new Float64Array(0), prevCount: opts.prevCount ?? 0, shapes: islands.shapes(),
    tagWords: 1, tags: islands.tags(0, s.count), refs: opts.refs ?? [], gravity: g, dt: islands.scene.dt,
  });
  return islandCounts(opts.step ?? -1, out);
}

export interface IslandObserverOptions {
  /** The observer's tag words (its ObserveOptions.tagWords); default 1. */
  tagWords?: number;
  /** The word that holds the island index; default 0. */
  word?: number;
  /** Fills the other tag words of a body (words has tagWords entries, the island word already set). */
  fill?: (id: number, words: Uint32Array) => void;
}

/**
 * An Observer that counts per island. sync() tags the bodies the islands have
 * released since the last call (call it after pushing due()'s events, before
 * step()); query() takes plain predicates; result() returns the counts per island.
 */
export class IslandObserver {
  private tagged = 0;
  private readonly tagWords: number;
  private readonly word: number;

  constructor(readonly observer: Observer, readonly islands: Islands, private readonly opts: IslandObserverOptions = {}) {
    this.tagWords = opts.tagWords ?? 1;
    this.word = opts.word ?? 0;
    if (!(Number.isInteger(this.word) && this.word >= 0 && this.word < this.tagWords)) throw new RangeError(`IslandObserver: word ${this.word} is not one of the observer's ${this.tagWords} tag words`);
    this.sync();
  }

  /** Tags every body released since the last call with its island. */
  sync(): void {
    const n = this.islands.count;
    if (n <= this.tagged) return;
    const words = new Uint32Array((n - this.tagged) * this.tagWords), row = new Uint32Array(this.tagWords);
    for (let id = this.tagged; id < n; id++) {
      row.fill(0);
      row[this.word] = this.islands.islandOf(id);
      this.opts.fill?.(id, row);
      row[this.word] = this.islands.islandOf(id);
      words.set(row, (id - this.tagged) * this.tagWords);
    }
    this.observer.setTags(this.tagged, words);
    this.tagged = n;
  }

  /** Count, per island, the bodies that satisfy each predicate, from the next step() on; null stops it. */
  query(preds: readonly Pred[] | null): void {
    this.observer.query(preds === null ? null : islandSpec(this.islands.K, preds, this.word));
  }

  async result(step: number): Promise<IslandCounts> {
    const o = await this.observer.result(step);
    return islandCounts(o.step, o.out);
  }
}
