// A quake search worker thread: plays every quake of a job on one nudged build (quake-search.ts playQuakes).
import { parentPort, workerData } from 'node:worker_threads';
import type { EngineSpec } from './engines.ts';
import { playQuakes } from './quake-search.ts';

const spec = workerData.spec as EngineSpec;
parentPort!.on('message', async (job: { id: number; level: Parameters<typeof playQuakes>[0]; quakes: Parameters<typeof playQuakes>[1]; nudge: number }) => {
  try {
    parentPort!.postMessage({ id: job.id, result: await playQuakes(job.level, job.quakes, job.nudge, spec) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});
