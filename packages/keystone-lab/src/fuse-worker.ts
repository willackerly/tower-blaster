// A fuse search worker thread: plays every line of a job on one nudged build (fuse-search.ts playNudge).
import { parentPort, workerData } from 'node:worker_threads';
import type { EngineSpec } from './engines.ts';
import { playNudge } from './fuse-search.ts';

const spec = workerData.spec as EngineSpec;
parentPort!.on('message', async (job: { id: number; level: Parameters<typeof playNudge>[0]; lines: Parameters<typeof playNudge>[1]; nudge: number }) => {
  try {
    parentPort!.postMessage({ id: job.id, result: await playNudge(job.level, job.lines, job.nudge, spec) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
});
