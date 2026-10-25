// Plays sessions for the probe and the bot, in this thread or on a pool of
// worker threads. Each session runs on a fresh engine, so where it runs does
// not change its result; a test holds the two runners equal.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Snapshot } from '@tb/engine-api';
import { type CompiledLevel, compileLevel, type LevelDef, runSession, type Session, type Shot } from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';

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

/** One session on a fresh engine, freed afterwards (WASM engines leak otherwise). */
export async function playOnce(spec: EngineSpec, level: LevelDef, shots: Shot[]): Promise<PlayResult> {
  const e = makeEngine(spec);
  try {
    const { session: s, steps, snapshot } = await runSession(e, compileCached(level), shots);
    return { session: { phase: s.phase, rackLeft: s.rackLeft, outcomes: s.outcomes, inputs: s.inputs, crownDown: s.crownDown, heritageBroken: s.heritageBroken, score: s.score, home: s.home }, steps, snapshot };
  } finally {
    e.dispose();
  }
}

/** Sessions one at a time in this thread (so only one engine is alive at once). */
export function inlineRunner(spec: EngineSpec): Runner {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    spec, jobs: 1,
    play(level, shots) {
      const r = tail.then(() => playOnce(spec, level, shots));
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
