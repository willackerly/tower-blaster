// T-X3B stands at load on the GPU solver on CI (level-stability-gpu.ts): the promoted Kapla crib over the reference
// test's 160 bodies, in a file of its own so each CI file holds one SwiftShader level. On a real GPU or with
// PHYSICS_GPU_SLOW=1 level-stability-gpu.test.ts runs every level, this one among them, so this file stands down.
import { it } from 'vitest';
import { ALL, gpuStabilitySuite } from './level-stability-gpu.ts';

if (ALL) it.skip('T-X3B runs in level-stability-gpu.test.ts with every level', () => {});
else gpuStabilitySuite(['T-X3B']);
