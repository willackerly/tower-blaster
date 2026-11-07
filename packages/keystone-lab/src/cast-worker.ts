// A star-cast worker thread (cast.ts poolCastPlayer): plays one line of a level on a fresh engine, on the build
// nudge given, exactly as nodeCastPlayer does in the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { castPlay, compileLevel, type LevelDef, nudgedLevel, readShots } from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';

const spec = workerData.spec as EngineSpec;
parentPort!.on('message', async (job: { id: number; level: LevelDef; shots: string; nudge: number }) => {
  const e = makeEngine(spec);
  try {
    const c = compileLevel(job.level);
    parentPort!.postMessage({ id: job.id, result: await castPlay(e, job.nudge ? nudgedLevel(c, job.nudge) : c, readShots(job.shots)) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  } finally { e.dispose(); }
});
