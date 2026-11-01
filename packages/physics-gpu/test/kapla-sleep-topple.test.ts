// The sleeping Kapla tower still falls (roadmap E2 step 2b): the same tower as kapla-sleep.test.ts, asleep by 1 s;
// S15's topple ball arrives at 2 s, wakes it (an awake body moving into sleepers wakes every sleeper they touch), and
// it comes down at the game's 40 iterations.
import { KAPLA_SLEEP_TOPPLE } from './kapla-sleep-case.ts';
import { restSuite } from './rest-stability.ts';

restSuite([KAPLA_SLEEP_TOPPLE]);
