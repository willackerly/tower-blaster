// A runner's worker thread: plays each job it is sent on the runner's engine.
import { parentPort, workerData } from 'node:worker_threads';
import type { EngineSpec } from './engines.ts';
import { playOnce, SessionCache } from './runner.ts';

const spec = workerData.spec as EngineSpec;
const cache = new SessionCache();
parentPort!.on('message', async (job: { id: number; level: Parameters<typeof playOnce>[1]; shots: Parameters<typeof playOnce>[2] }) => {
  try {
    parentPort!.postMessage({ id: job.id, result: await playOnce(spec, job.level, job.shots, cache) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});
