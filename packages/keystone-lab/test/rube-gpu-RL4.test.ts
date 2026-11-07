// Nightly only (vitest.nightly.json, PHYSICS_GPU_SLOW=1): one case over the 300 s a CI file may take.
// RL4 on the GPU solver: rube-gpu.ts.
import { RL4 } from '@tb/keystone';
import { rubeGpuSuite } from './rube-gpu.ts';

rubeGpuSuite(RL4);
