// Sleep holds the Kapla tower (roadmap E2 step 2b; Will's choice 2026-11-01): at the game's 40 iterations a real-size
// tower creeps and, at 10k planks, loses its spire within 2 s (E5, kapla/speed-study.md). Settled at 120 iterations
// for its first frames (GpuEngineOptions.settleSteps) and left to sleep, it freezes: every plank asleep, then not a
// bit of motion. A small tower here (SwiftShader); the 10k gate is the M5 run of kapla-hold.test.ts (KAPLA_SLEEP=1).
// The topple ball still brings it down: kapla-sleep-topple.test.ts.
import { KAPLA_SLEEP_IDLE } from './kapla-sleep-case.ts';
import { restSuite } from './rest-stability.ts';

restSuite([KAPLA_SLEEP_IDLE]);
