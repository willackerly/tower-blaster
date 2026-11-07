// F6 on the GPU solver: fuse-gpu.ts. The representative domino-fuse file on every PR (O5); F7 and F8 run on a real
// GPU (TB_CHANNEL) or with PHYSICS_GPU_SLOW=1.
import { fuseGpuSuite } from './fuse-gpu.ts';

fuseGpuSuite('F6');
