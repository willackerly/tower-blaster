// Nightly only (vitest.nightly.json, PHYSICS_GPU_SLOW=1): one case over the 300 s a CI file may take.
// Rest stability at the game's settings, CI's struck case (rest-stability.ts):
// a 200-cube wall hit by a 10 kg ball at 20 m/s, at 40 iterations with
// gapSlop, must be at rest over frames 600-1200. Long enough for the debris to
// stop: a 600-frame run of the 1k city still had cubes rolling at 4 m/s in a
// window from frame 300. The opt-in matrix runs from rest-stability.test.ts.
import { restSuite } from './rest-stability.ts';

restSuite([{ structure: 'wall', mode: 'struck', n: 200, iterations: 40, gapSlop: true, frames: 1200 }]);
