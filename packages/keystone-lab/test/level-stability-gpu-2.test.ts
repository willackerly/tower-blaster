// Part 2 of every level at load on the GPU solver (level-stability-gpu.ts deals them over three files, largest
// first, so no file holds the whole sweep): on a real GPU (TB_CHANNEL=chrome) or with PHYSICS_GPU_SLOW=1. CI runs
// T-X4 and T-X3B in level-stability-gpu.test.ts and level-stability-gpu-X3B.test.ts, so this file stands down.
import { it } from 'vitest';
import { ALL, gpuStabilitySuite } from './level-stability-gpu.ts';

if (!ALL) it.skip('part 2 of every level runs with TB_CHANNEL=chrome or PHYSICS_GPU_SLOW=1', () => {});
else gpuStabilitySuite(null, undefined, 2);
