// The small sleeping Kapla tower of kapla-sleep.test.ts and kapla-sleep-topple.test.ts (roadmap E2 step 2b).
import type { RestCase } from './rest-stability.ts';

/** About 300 planks idle for 2 s, settled at 120 iterations for 20 frames: asleep by 1 s, and from then on no plank moves (the window starts at frame 60). */
export const KAPLA_SLEEP_IDLE: RestCase = {
  structure: 'kapla', mode: 'idle', n: 300, iterations: 40, gapSlop: true, frames: 120, substeps: 7,
  settle: { frames: 20, iterations: 120 }, sleep: {}, asleepBy: 60, watchFrom: 60,
};

/** The same tower asleep by 1 s and still asleep at 2 s, when S15's topple ball arrives: it must come down. */
export const KAPLA_SLEEP_TOPPLE: RestCase = { ...KAPLA_SLEEP_IDLE, mode: 'struck', frames: 180, watchFrom: undefined, asleepBy: 120, expect: 'collapse' };
