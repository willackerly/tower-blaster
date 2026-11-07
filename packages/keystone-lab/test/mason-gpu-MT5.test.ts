// Mason's Trial MT5 on the GPU solver: mason-gpu.ts.
import { MT5 } from '@tb/keystone';
import { masonGpuSuite } from './mason-gpu.ts';

masonGpuSuite(MT5, true); // on PRs too (O5): the only test of a quake through the judge's islands on the GPU
