// Page-side drivers for the sleep probe tests (bundled by loadBundle).
import { sharedDevice } from '@tb/gpu';
import type { SceneDesc } from '@tb/engine-api';
import { GpuAvbdEngine, STEP_STAGES } from '../src/index.ts';
import { contactEdges, runP6 } from '../src/probe-sleep.ts';
import type { Stat } from '../src/probe.ts';

export { runProbe } from '../src/probe.ts';

/**
 * probeStages() against step(): engine A runs step(), engine B probeStages() with a marker pass that
 * writes a buffer of its own at every mark. Returns both final states, the marks in the order they came,
 * and whether every mark got an encoder (the same one within a step).
 */
export async function stagesHook(scene: SceneDesc, steps: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const a = new GpuAvbdEngine({ iterations: 4 }, { device }), b = new GpuAvbdEngine({ iterations: 4 }, { device });
  await a.init(scene);
  await b.init(scene);
  const sink = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const marks: string[][] = [];
  let sameEncoder = true;
  for (let s = 0; s < steps; s++) {
    a.step();
    const seen: string[] = [];
    let first: GPUCommandEncoder | null = null;
    b.probeStages((enc, at) => {
      first ??= enc;
      if (enc !== first) sameEncoder = false;
      seen.push(at);
      enc.clearBuffer(sink);
    });
    marks.push(seen);
  }
  await Promise.all([a.finish(), b.finish()]);
  const [sa, sb] = await Promise.all([a.snapshot(), b.snapshot()]);
  const error = await device.popErrorScope();
  a.dispose(); b.dispose(); sink.destroy();
  const plain = (s: typeof sa) => [...s.pos, ...s.rot, ...s.linVel, ...s.angVel];
  return { error: error?.message ?? null, a: plain(sa), b: plain(sb), marks, sameEncoder, stages: [...STEP_STAGES] };
}

const wall = (device: GPUDevice) => async (record: (pass: GPUComputePassEncoder) => void): Promise<Stat> => {
  const t0 = performance.now();
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  record(pass);
  pass.end();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  return { median: ms, p10: ms, p90: ms, samples: 1 };
};

/** P6 on a graph given as edge pairs; also returns the GPU labels so the test can compare them itself. */
export async function islands(n: number, edges: number[]) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const r = await runP6(device, n, Uint32Array.from(edges), wall(device));
  const error = await device.popErrorScope();
  return { error: error?.message ?? null, ...r };
}

/** contactEdges() after `steps` steps of a scene: every edge is a pair of distinct bodies below n. */
export async function edgesOf(scene: SceneDesc, steps: number) {
  const { device } = await sharedDevice();
  const e = new GpuAvbdEngine({ iterations: 4 }, { device });
  await e.init(scene);
  for (let s = 0; s < steps; s++) e.step();
  await e.finish();
  const edges = await contactEdges(e);
  const n = e.probeParts().n;
  e.dispose();
  return { n, edges: [...edges] };
}
