// A runner's worker thread: plays each job it is sent on the runner's engine.
import { parentPort, workerData } from 'node:worker_threads';
import type { EngineSpec } from './engines.ts';
import { playOnce } from './runner.ts';

const spec = workerData.spec as EngineSpec;
parentPort!.on('message', async (job: { id: number; level: Parameters<typeof playOnce>[1]; shots: Parameters<typeof playOnce>[2] }) => {
  try {
    parentPort!.postMessage({ id: job.id, result: await playOnce(spec, job.level, job.shots) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});
