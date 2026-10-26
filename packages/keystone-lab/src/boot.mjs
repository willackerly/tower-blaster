// Worker entry: worker threads load plain JS, so register tsx and then load
// the TypeScript worker named in workerData.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.entry);
