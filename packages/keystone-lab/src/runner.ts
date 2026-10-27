// Plays sessions for the probe and the bot, in this thread or on a pool of
// worker threads. Each session runs on a fresh engine, so where it runs does
// not change its result; a test holds the two runners equal.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Snapshot } from '@tb/engine-api';
import { type CompiledLevel, compileLevel, Driver, type LevelDef, playShots, runSession, type Session, type SessionResult, type Shot } from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';
import { forkDeep } from './fork.ts';

/** What a session leaves behind: plain data, so it crosses threads unchanged. */
export interface PlayResult {
  session: Pick<Session, 'phase' | 'rackLeft' | 'outcomes' | 'inputs' | 'crownDown' | 'heritageBroken' | 'score' | 'home'>;
  steps: number;
  snapshot: Snapshot;
}

export interface Runner {
  readonly spec: EngineSpec;
  /** Number of sessions that run at once. */
  readonly jobs: number;
  play(level: LevelDef, shots: Shot[]): Promise<PlayResult>;
  close(): Promise<void>;
}

const compiled = new Map<string, CompiledLevel>();
function compileCached(level: LevelDef): CompiledLevel {
  const key = JSON.stringify(level);
  let c = compiled.get(key);
  if (!c) compiled.set(key, (c = compileLevel(level)));
  return c;
}

/** Engines whose whole state forkDeep can copy (plain JS data), so sessions can start from a cached one. */
export const forkable = (spec: EngineSpec): boolean => spec.kind === 'ref';

/**
 * Copies of sessions while aiming, keyed by level and the shots fired so far:
 * the state after the pre-settle, and before each later shot. A play starts
 * from a copy of the longest cached prefix of its shots, so the bot's
 * attempts share the pre-settle and their first shots. Least recently used
 * entries go first. One per thread; entries are never played themselves.
 */
export class SessionCache {
  private readonly map = new Map<string, Driver>();
  hits = 0;
  misses = 0;
  constructor(readonly capacity = 32) {}

  static key(level: LevelDef, shots: readonly Shot[]): string { return JSON.stringify([level, shots]); }

  /** A copy of the cached driver for this prefix, or null. */
  take(key: string, shared: CompiledLevel): Driver | null {
    const d = this.map.get(key);
    if (!d) return null;
    this.map.delete(key);
    this.map.set(key, d);
    return forkDeep(d, [shared]);
  }

  /** Store a copy of a driver that is aiming. */
  put(key: string, d: Driver, shared: CompiledLevel): void {
    this.map.delete(key);
    this.map.set(key, forkDeep(d, [shared]));
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number { return this.map.size; }
}

/**
 * One session on a fresh engine, freed afterwards (WASM engines leak
 * otherwise). With a cache and a forkable engine it starts from the longest
 * cached prefix of the shots instead; the result is the same (a test holds
 * them equal).
 */
export async function playOnce(spec: EngineSpec, level: LevelDef, shots: Shot[], cache?: SessionCache): Promise<PlayResult> {
  const c = compileCached(level);
  if (!cache || !forkable(spec)) {
    const e = makeEngine(spec);
    try {
      return result(await runSession(e, c, shots));
    } finally {
      e.dispose();
    }
  }
  let k = shots.length - 1, d: Driver | null = null;
  for (; k >= 0 && !d; k--) d = cache.take(SessionCache.key(level, shots.slice(0, k)), c);
  if (d) {
    cache.hits++;
    k++;
  } else {
    cache.misses++;
    d = new Driver(makeEngine(spec), c);
    await d.reset();
    cache.put(SessionCache.key(level, []), d, c);
    k = 0;
  }
  try {
    return result(await playShots(d, shots, k, { onAiming: (at, next) => cache.put(SessionCache.key(level, shots.slice(0, next)), at, c) }));
  } finally {
    d.engine.dispose();
  }
}

function result({ session: s, steps, snapshot }: SessionResult): PlayResult {
  return { session: { phase: s.phase, rackLeft: s.rackLeft, outcomes: s.outcomes, inputs: s.inputs, crownDown: s.crownDown, heritageBroken: s.heritageBroken, score: s.score, home: s.home }, steps, snapshot };
}

/** Sessions one at a time in this thread (so only one engine is alive at once). */
export function inlineRunner(spec: EngineSpec, cache: SessionCache | undefined = new SessionCache()): Runner {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    spec, jobs: 1,
    play(level, shots) {
      const r = tail.then(() => playOnce(spec, level, shots, cache));
      tail = r.catch(() => {});
      return r;
    },
    close: async () => {},
  };
}

interface Job { id: number; level: LevelDef; shots: Shot[] }
type Reply = { id: number; result: PlayResult } | { id: number; error: string };

/** Sessions on `jobs` worker threads, each playing one at a time. */
export function poolRunner(spec: EngineSpec, jobs: number): Runner {
  const queue: Job[] = [];
  const pending = new Map<number, { resolve(r: PlayResult): void; reject(e: Error): void }>();
  const busy = new Map<Worker, number>();
  let next = 0, closed = false;
  const workers = Array.from({ length: jobs }, () => {
    const w = new Worker(new URL('./boot.mjs', import.meta.url), { workerData: { entry: new URL('./worker.ts', import.meta.url).href, spec } });
    w.on('message', (m: Reply) => {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      busy.delete(w);
      if ('error' in m) p.reject(new Error(m.error));
      else p.resolve(m.result);
      pump();
    });
    // A worker only dies on a bug in the lab itself: fail everything rather than hang.
    w.on('error', (err) => {
      closed = true;
      queue.length = 0;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
    return w;
  });
  function pump() {
    for (const w of workers) {
      if (busy.has(w) || !queue.length) continue;
      const job = queue.shift()!;
      busy.set(w, job.id);
      w.postMessage(job);
    }
  }
  return {
    spec, jobs,
    play(level, shots) {
      if (closed) return Promise.reject(new Error('runner closed'));
      const id = next++;
      const r = new Promise<PlayResult>((resolve, reject) => pending.set(id, { resolve, reject }));
      queue.push({ id, level, shots });
      pump();
      return r;
    },
    async close() {
      closed = true;
      for (const p of pending.values()) p.reject(new Error('runner closed'));
      pending.clear();
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

/** `jobs` defaults to one per core; 1 plays in this thread. */
export function makeRunner(spec: EngineSpec, jobs = availableParallelism()): Runner {
  return jobs <= 1 ? inlineRunner(spec) : poolRunner(spec, jobs);
}
