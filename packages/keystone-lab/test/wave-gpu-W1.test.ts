// W1 First Run on the GPU solver (lay-gpu.ts): Lay's representative on a PR (O5), its north run only, at about
// 100 s on a CI runner; a real GPU (TB_CHANNEL) or PHYSICS_GPU_SLOW=1 plays both runs and the nothing-built level.
import { W1 } from '@tb/keystone';
import { layGpuSuite } from './lay-gpu.ts';
import { SLOW } from './wave-gpu.ts';

layGpuSuite([W1], SLOW ? {} : { solutions: 1, bare: false });
