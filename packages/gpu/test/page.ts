// Drivers that run inside the browser page. gpu.test.ts bundles this file with
// loadBundle() and calls the exports through page.evaluate; each driver checks
// its GPU result against the CPU reference in the page and returns a small
// summary, so large arrays never cross the Playwright boundary.
import { createDevice, GpuProfiler } from '../src/index.ts';

const BUSY = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = data[id.x];
  for (var i = 0u; i < 256u; i++) { x = x * 1664525u + 1013904223u; }
  data[id.x] = x;
}`;

export async function profiler(frames: number) {
  const { device, timestamps } = await createDevice();
  const prof = new GpuProfiler(device, 8);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: BUSY }), entryPoint: 'main' } });
  const data = device.createBuffer({ size: 64 * 1024 * 4, usage: GPUBufferUsage.STORAGE });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: data } }] });
  const results: Array<Record<string, number>> = [];
  device.pushErrorScope('validation');
  for (let f = 0; f < frames; f++) {
    prof.begin();
    const enc = device.createCommandEncoder();
    for (const label of ['a', 'b', 'a']) {
      const pass = enc.beginComputePass({ ...prof.pass(label) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(1024);
      pass.end();
    }
    prof.resolve(enc);
    device.queue.submit([enc.finish()]);
  }
  // Collect after all submits: exercises the pool with several frames in flight.
  for (let f = 0; f < frames; f++) results.push(await prof.collect());
  const error = await device.popErrorScope();
  const extra = await prof.collect();
  prof.destroy();
  device.destroy();
  return { timestamps, supported: prof.supported, results, extra, error: error?.message ?? null };
}
