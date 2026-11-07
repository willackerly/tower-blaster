// W1 First Run on the GPU solver: lay-gpu.ts. (One level per file keeps each well under CI's per-file budget.)
import { W1 } from '@tb/keystone';
import { layGpuSuite } from './lay-gpu.ts';

layGpuSuite([W1]);
