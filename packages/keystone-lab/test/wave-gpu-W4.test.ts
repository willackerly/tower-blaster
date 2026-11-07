// W4 Avenue on the GPU solver (wave-gpu.ts; a real GPU or PHYSICS_GPU_SLOW=1 only, O5: W5 is the PR representative): with a relay slab built in the middle of the avenue, the street falls
// end to end from its south starter and clears. (Bare, it dies at the avenue: D 0.27 on SwiftShader, 2026-11-07, as
// on Rapier, which pins it in wave-levels.test.ts; left out here to keep the file near a minute and a half.)
import { W4 } from '@tb/keystone';
import { build, ground } from '../src/rube.ts';
import { starterPart, starterShot } from '../src/wave.ts';
import { waveGpuSuite } from './wave-gpu.ts';

/** W4 with its relay 4.75 h into the avenue (the middle of the 3.5 to 6 h window wave-levels.test.ts pins). */
const RELAY = build(W4, (s) => [{ place: 'relay', hit: ground(s, 1.02, 9.5 * 1.02 + 0.5 + 4.75 + 0.5) }])!.def;

waveGpuSuite('W4', [
  { name: 'a relay, north', def: RELAY, shot: (c) => starterShot(c, starterPart(RELAY, 0, 1), 1), falls: [0, 1, 2, 3, 4, 5, 6], cleared: true, awakeMax: 7 * 32 + 3 },
], { slow: true });
