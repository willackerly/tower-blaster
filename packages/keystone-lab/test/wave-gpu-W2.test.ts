// W2 Two Bells on the GPU solver (lay-gpu.ts): a real GPU (TB_CHANNEL) or PHYSICS_GPU_SLOW=1 only (O5: W1 is Lay's
// representative on a PR; this file took 190 s on a CI runner).
import { W2 } from '@tb/keystone';
import { layGpuSuite } from './lay-gpu.ts';

layGpuSuite([W2], { slow: true });
