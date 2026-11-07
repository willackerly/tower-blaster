// W5 Firebreak on the GPU solver (wave-gpu.ts), Steer and Cut's representative on a PR (O5): the street pushed from its starter, the second relay pulled 2 s
// later while the wave runs (a Cut level's pulls go in only then): the slums fall, the village stands, cleared
// (SwiftShader: D 0.430, Rapier 0.434).
import { W5 } from '@tb/keystone';
import { starterPart, starterShot } from '../src/wave.ts';
import { waveGpuSuite } from './wave-gpu.ts';

waveGpuSuite('W5', [
  {
    name: 'the second relay cut live', def: W5,
    shot: (c) => [starterShot(c, starterPart(W5, 0, 1), 1), { ammo: 'pull', body: c.meta.n - 1, after: 120 }],
    // The slums' debris wakes some of the village (SwiftShader: 218 awake at most, 2026-11-07) without felling it.
    falls: [0, 1, 2, 3, 4, 5], cleared: true, awakeMax: 7 * 32 + 3, heritage: 0,
  },
]);
