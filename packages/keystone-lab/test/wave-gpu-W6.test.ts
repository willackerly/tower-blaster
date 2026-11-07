// W6 Orchard (1,021 dominoes, sixteen bells) on the GPU solver (lay-gpu.ts), its north run only, capped at 2,250
// steps (its last bell rings at 2,103), no bare run. A real GPU (TB_CHANNEL) or PHYSICS_GPU_SLOW=1 only: 361 s on a
// CI runner, over the per-file budget (O5).
import { W6 } from '@tb/keystone';
import { layGpuSuite } from './lay-gpu.ts';

layGpuSuite([W6], { solutions: 1, maxSteps: 2250, bare: false, slow: true });
