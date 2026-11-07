// Bodies that start asleep (roadmap C22, the Wavefront domino levels: docs/game/wavefront.md).
//
// A domino field or a city is thousands of bodies at rest, of which a wave
// reaches a few at a time. With sleep they fall asleep anyway (probe X1: at most
// 16 of 200 dominoes awake at once), but only after being solved, awake, for a
// quiet window: every one of them is solved through the level's pre-settle. A
// body given BodyDesc.asleep skips that: it is a sleeper from the first step.
//
// The rule, for every engine:
// - In a scene with SceneDesc.sleep, an engine that sleeps (GPU AVBD with
//   GpuEngineOptions.sleep, Rapier) holds the body asleep from step 0: a
//   snapshot reports awake 0, its pose stays exactly as given (as the engine
//   holds it) and its velocities are 0, whatever the description says.
// - It wakes by the engine's own rules and nothing else: something awake and
//   moving touching it, a blast, a removal next to it, a change of gravity. On
//   the GPU that wakes its sleeper group (every sleeper it touches, transitively),
//   so bodies spawned asleep in contact wake together.
// - An engine that does not sleep (the AVBD reference, the tiered engine), or a
//   scene without sleep, runs it awake: a body at rest where it is put stays at
//   rest, so this is the same physics up to the sleep approximation.
// - It is a hint for bodies at rest. A body put asleep in mid-air or overlapping
//   another stays where it is until woken, on engines that sleep.
// - A pinned body (pinned.ts) is asleep for good anyway; the flag adds nothing.
//
// Checked by @tb/testkit's asleep.ts case on each engine.
import type { BodyDesc, SceneDesc } from './index.ts';

/** Whether a body starts asleep where its scene and engine sleep (BodyDesc.asleep). */
export const startsAsleep = (b: BodyDesc): boolean => b.asleep === true;

/** Whether a scene holds a body that starts asleep. */
export const sceneAsleep = (scene: Pick<SceneDesc, 'bodies'>): boolean => scene.bodies.some(startsAsleep);
