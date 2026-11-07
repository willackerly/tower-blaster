// Mason's Trial MT4 on the GPU solver: mason-gpu.ts.
import { MT4 } from '@tb/keystone';
import { masonGpuSuite } from './mason-gpu.ts';

masonGpuSuite(MT4, true); // the representative level CI runs in full (O5)
