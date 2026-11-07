// F8 on the GPU solver: fuse-gpu.ts. On a real GPU (TB_CHANNEL) or with PHYSICS_GPU_SLOW=1 only: F6 is the PR's
// representative domino-fuse file (O5's CI rule).
import { describe, it } from 'vitest';
import { fuseGpuSuite } from './fuse-gpu.ts';

if (process.env.TB_CHANNEL || process.env.PHYSICS_GPU_SLOW === '1') fuseGpuSuite('F8');
else describe('domino fuses on the GPU solver', () => { it.skip('F8: on a real GPU or with PHYSICS_GPU_SLOW=1', () => {}); });
