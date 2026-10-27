// Page-side drivers for the solver probe tests (bundled by loadBundle).
import { createDevice, GpuProfiler } from '@tb/gpu';
import type { SceneDesc } from '@tb/engine-api';
import type { AvbdParams } from '@tb/physics-ref';
import { GpuAvbdEngine } from '../src/index.ts';

export { runProbe } from '../src/probe.ts';

/**
 * The probe's hooks against the default path, on one scene: engine A runs
 * step(); engine B runs probeStep() (when the device has timestamps) and,
 * after every step, every primal piece of the sweep and the tail through
 * encodeProbe(). Returns both final states, and the dispatches encodeProbe
 * issued for one colour and for the tail (workgroup counts). params: both engines'.
 */
export async function probeHooks(scene: SceneDesc, steps: number, reps: number, params: Partial<AvbdParams> = { iterations: 4 }) {
  const { device, timestamps } = await createDevice();
  device.pushErrorScope('validation');
  const a = new GpuAvbdEngine(params, { device }), b = new GpuAvbdEngine(params, { device });
  await a.init(scene);
  await b.init(scene);
  const prof = timestamps ? new GpuProfiler(device, 2) : null;
  const solveMs: number[] = [];
  let direct: number[] = [], tail: number[] = [];
  for (let s = 0; s < steps; s++) {
    a.step();
    if (prof) {
      prof.begin();
      b.probeStep(prof.pass('solve').timestampWrites!);
      const enc = device.createCommandEncoder();
      prof.resolve(enc);
      device.queue.submit([enc.finish()]);
      solveMs.push((await prof.collect()).solve ?? NaN);
    } else b.step();
    const { solver, n, dispatch } = b.probeParts();
    const proto = GPUComputePassEncoder.prototype;
    const original = proto.dispatchWorkgroups;
    const seen: number[] = [];
    proto.dispatchWorkgroups = function (this: GPUComputePassEncoder, ...x: Parameters<GPUComputePassEncoder['dispatchWorkgroups']>) { seen.push(x[0]); return original.apply(this, x); };
    try {
      for (let c = 0; c <= dispatch.colorTail; c++) {
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        solver.encodeProbe(pass, n, c < dispatch.colorTail ? { primal: c } : 'tail', reps);
        pass.end();
        device.queue.submit([enc.finish()]);
        if (c === 0) direct = seen.splice(0);
        else if (c === dispatch.colorTail) tail = seen.splice(0);
        else seen.length = 0;
      }
    } finally {
      proto.dispatchWorkgroups = original;
    }
  }
  await Promise.all([a.finish(), b.finish()]);
  const [sa, sb] = await Promise.all([a.snapshot(), b.snapshot()]);
  const n = b.probeParts().n;
  let threw = '';
  try { b.probeParts().solver.encodeProbe(device.createCommandEncoder().beginComputePass(), n, { primal: 63 }, 1); } catch (e) { threw = (e as Error).message; }
  const error = await device.popErrorScope();
  a.dispose(); b.dispose(); prof?.destroy();
  device.destroy();
  const plain = (s: typeof sa) => [...s.pos, ...s.rot, ...s.linVel, ...s.angVel];
  return { error: error?.message ?? null, timestamps, a: plain(sa), b: plain(sb), direct, tail, groups: Math.ceil(n / 64), solveMs, threw };
}
