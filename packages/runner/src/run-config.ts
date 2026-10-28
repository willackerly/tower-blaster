// Executes a RunConfig in the page and produces the same result records as
// the Node CLI, plus the browser environment.
import { compareBlocks, engineHealth, makeEngine, qualityGates, qualityRun, timeInterleaved, timingSummary } from '@tb/bench';
import { type RunConfig, runScene, sceneKey } from './config.ts';
import { browserEnv, timingProblems } from './env.ts';

export async function execute(c: RunConfig, onProgress: (msg: string) => void = () => {}) {
  const env = await browserEnv();
  const scene = runScene(c);
  const engines = c.engines.map(makeEngine);
  onProgress(`timing ${c.engines.join(' vs ')} on ${scene.id} (${scene.bodies.length} bodies)`);
  const blocks = await timeInterleaved(engines, scene, c.timing);
  // Over every step since init(): warmup and the timed blocks.
  const health = await engineHealth(engines, c.engines.map((spec, i) => `engine ${i} (${spec})`));
  const problems = timingProblems(env, engines.map((e) => e.info.backend));
  const record: Record<string, unknown> = {
    schema: 1,
    kind: engines.length === 2 ? 'compare' : 'run',
    env: { browser: env, time: new Date().toISOString() },
    engines: engines.map((e) => e.info),
    scene: sceneKey(c, scene),
    // The steps run before the first block: the blocks time steps warmup + 1 to warmup + blocks x stepsPerBlock.
    warmup: c.timing.warmup,
    timing: blocks.map(timingSummary),
    timingValid: problems.length === 0,
    timingProblems: problems,
    // Each engine's limits over the timing (null without health()), and a sentence per limit that
    // changed the physics: with any, the timing is of a different simulation from the one asked for.
    health: health.health,
    limitProblems: health.limitProblems,
  };
  if (engines.length === 2) record.comparison = compareBlocks(blocks[0]!, blocks[1]!);
  if (c.qualitySteps > 0) {
    onProgress(`quality pass, ${c.qualitySteps} steps`);
    const q = await qualityRun(engines[0]!, scene, { steps: c.qualitySteps, sampleEvery: 30 });
    // The quality run starts the engine again, so its limits are its own: with any, its metrics are of a different simulation.
    const qh = await engineHealth([engines[0]!], [`quality run (${c.engines[0]})`]);
    record.quality = { ...q, series: undefined, gates: qualityGates(q, scene.inputs.length === 0), health: qh.health[0], limitProblems: qh.limitProblems };
  }
  for (const e of engines) e.dispose();
  return record;
}
