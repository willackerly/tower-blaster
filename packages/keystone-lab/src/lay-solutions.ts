// The authored solutions of Wavefront's Lay levels (keystone lay-levels.ts): the strokes a designer drew,
// in h, as a player draws them on the ground with the brush. The Lay bot (lay.ts) perturbs these to find
// each level's parts par; the tests (lay-levels.test.ts, lay-W6.test.ts, wave-gpu-W1, W2 and W6.test.ts) play them.
import type { LaySolution } from './lay.ts';

export const LAY_SOLUTIONS: Record<string, readonly LaySolution[]> = {
  // Round either end of the wall to the bell behind it.
  W1: [
    { label: 'north', strokes: [[[1.5, 0], [4, 1.5], [6, 4.5], [8, 4.5], [10.5, 2], [11, 0.6]]] },
    { label: 'south', strokes: [[[1.5, 0], [4, -1.5], [6, -4.5], [8, -4.5], [10.5, -2], [11, -0.6]]] },
  ],
  W2: [
    // A short trunk (dominoes at 1.5, 2.7 and 3.9 h), then two branches side by side one gap past its last domino.
    // The trunk's end is held as well: it is the junction a player lines the branches up on.
    { label: 'fork', held: [[0, 1], [0, 4], [0, 4]], strokes: [[[1.5, 0], [4.2, 0]], [[5, 0.6], [6.2, 0.9], [8, 4], [10, 6], [12, 6.5]], [[5, -0.6], [6.2, -0.9], [8, -4], [10, -6], [12, -6.5]]] },
    // Two runs side by side at the ramp's foot: the ball strikes both.
    { label: 'split at the foot', strokes: [[[1.5, 0.6], [3, 1.2], [6, 4], [10, 6], [12, 6.5]], [[1.5, -0.6], [3, -1.2], [6, -4], [10, -6], [12, -6.5]]] },
  ],
  // Round the wall and on into the field's trunk: the dominoes that would clash with the trunk are left out, so
  // the run stops about a pitch (1.25 h) short of the trunk's first domino.
  W6: [
    { label: 'north', strokes: [[[1.5, 0], [4, 1.5], [6.5, 4.5], [10, 4.5], [13, 2], [16, 0], [25, 0]]] },
    { label: 'south', strokes: [[[1.5, 0], [4, -1.5], [6.5, -4.5], [10, -4.5], [13, -2], [16, 0], [25, 0]]] },
  ],
};
