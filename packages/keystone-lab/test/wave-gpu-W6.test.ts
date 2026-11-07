// W6 Orchard (1,021 dominoes, sixteen bells) on the GPU solver, its north run only, capped at 2,250 steps (its last bell rings at 2,087), no bare run: lay-gpu.ts.
import { W6 } from '@tb/keystone';
import { layGpuSuite } from './lay-gpu.ts';

layGpuSuite([W6], 1, 2250, false);
