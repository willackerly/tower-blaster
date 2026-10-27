// Executes a RunConfig in the page and produces the same result records as
// the Node CLI, plus the browser environment.
import { compareBlocks, makeEngine, qualityGates, qualityRun, timeInterleaved, timingSummary } from '@tb/bench';
import { type RunConfig, runScene, sceneKey } from './config.ts';
import { browserEnv, timingProblems } from './env.ts';

export async function execute(c: RunConfig, onProgress: (msg: string) => void = () => {}) {
  const env = await browserEnv();
  const scene = runScene(c);
  const engines = c.engines.map(makeEngine);
  onProgress(`timing ${c.engines.join(' vs ')} on ${scene.id} (${scene.bodies.length} bodies)`);
  const blocks = await timeInterleaved(engines, scene, c.timing);
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
  };
  if (engines.length === 2) record.comparison = compareBlocks(blocks[0]!, blocks[1]!);
  if (c.qualitySteps > 0) {
    onProgress(`quality pass, ${c.qualitySteps} steps`);
    const q = await qualityRun(engines[0]!, scene, { steps: c.qualitySteps, sampleEvery: 30 });
    record.quality = { ...q, series: undefined, gates: qualityGates(q, scene.inputs.length === 0) };
  }
  for (const e of engines) e.dispose();
  return record;
}
