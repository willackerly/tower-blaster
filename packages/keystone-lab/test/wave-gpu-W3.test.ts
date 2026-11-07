// W3 Fall Line on the GPU solver (wave-gpu.ts): the west street from its south starter falls end to end and clears;
// the other two streets (12 towers, 384 bodies) are never reached, so the front stays under the street's 256 bodies,
// its starter and what its debris wakes.
import { W3 } from '@tb/keystone';
import { starterPart, starterShot } from '../src/wave.ts';
import { waveGpuSuite } from './wave-gpu.ts';

waveGpuSuite('W3', [
  { name: 'the west street north', def: W3, shot: (c) => starterShot(c, starterPart(W3, 0, 1), 1), falls: [0, 1, 2, 3, 4, 5, 6, 7], cleared: true, awakeMax: 8 * 32 + 2 },
]);
