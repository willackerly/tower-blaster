// Ground truth for the layout code: a real WGSL compiler (Tint, in Chromium)
// reads structs written by writeStruct and echoes every field back as raw
// bits. If our offsets disagree with the compiler's, this fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWebGPU, type WebGPUSession } from '@tb/testkit';
import { ALL_STRUCTS, defineStruct, type StructLayout, wgslStruct, writeStruct } from '../src/index.ts';

// The production structs are packed so that padding never occurs; this probe
// forces every padding rule so a wrong alignment table cannot pass.
const Probe = defineStruct('Probe', [
  ['a', 'f32'], ['b', 'vec3f'], ['c', 'u32'], ['d', 'vec2f'], ['e', 'i32'], ['f', 'vec4u'],
  ['g', 'f32'], ['h', 'mat4x4f'], ['i', 'vec2i'], ['j', 'vec3u'],
]);

let gpu: WebGPUSession | null = null;
beforeAll(async () => { gpu = await openWebGPU(); });
afterAll(async () => { await gpu?.close(); });

function echoShader(s: StructLayout): string {
  const writes: string[] = [];
  let k = 0;
  for (const f of s.fields) {
    for (let c = 0; c < f.components; c++) {
      const access = f.type === 'mat4x4f' ? `[${Math.floor(c / 4)}][${c % 4}]` : f.components > 1 ? `[${c}]` : '';
      writes.push(`  outp[base + ${k}u] = bitcast<u32>(inp[i].${f.name}${access});`);
      k++;
    }
  }
  return `${wgslStruct(s)}
@group(0) @binding(0) var<storage, read> inp: array<${s.name}>;
@group(0) @binding(1) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let base = i * ${k}u;
${writes.join('\n')}
}`;
}

describe.each([...ALL_STRUCTS, Probe].map((s) => [s.name, s] as const))('GPU layout of %s', (_name, s) => {
  it('matches writeStruct byte for byte', async (ctx) => {
    if (!gpu) return ctx.skip();
    const COUNT = 3;
    const view = new DataView(new ArrayBuffer(s.size * COUNT));
    const expected: number[] = [];
    let seed = 1;
    for (let i = 0; i < COUNT; i++) {
      const value: Record<string, number[]> = {};
      for (const f of s.fields) {
        const comps: number[] = [];
        for (let c = 0; c < f.components; c++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          comps.push(f.scalar === 'f32' ? (seed % 10000) / 7 - 500 : f.scalar === 'i32' ? (seed % 2000) - 1000 : seed);
        }
        value[f.name] = comps;
      }
      writeStruct(view, s, i, value);
      for (const f of s.fields) {
        for (let c = 0; c < f.components; c++) {
          const tmp = new DataView(new ArrayBuffer(4));
          if (f.scalar === 'f32') tmp.setFloat32(0, value[f.name]![c]!, true);
          else if (f.scalar === 'i32') tmp.setInt32(0, value[f.name]![c]!, true);
          else tmp.setUint32(0, value[f.name]![c]!, true);
          expected.push(tmp.getUint32(0, true));
        }
      }
    }
    const got = await gpu.page.evaluate(
      async ({ code, bytes, outWords, count }) => {
        const adapter = (await navigator.gpu.requestAdapter())!;
        const device = await adapter.requestDevice();
        device.pushErrorScope('validation');
        const module = device.createShaderModule({ code });
        const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        const inp = device.createBuffer({ size: bytes.length, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(inp, 0, new Uint8Array(bytes));
        const outp = device.createBuffer({ size: outWords * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const read = device.createBuffer({ size: outWords * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: inp } }, { binding: 1, resource: { buffer: outp } }],
        });
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(count);
        pass.end();
        enc.copyBufferToBuffer(outp, 0, read, 0, outWords * 4);
        device.queue.submit([enc.finish()]);
        const err = await device.popErrorScope();
        if (err) return { error: err.message };
        await read.mapAsync(GPUMapMode.READ);
        return { words: Array.from(new Uint32Array(read.getMappedRange())) };
      },
      { code: echoShader(s), bytes: Array.from(new Uint8Array(view.buffer)), outWords: expected.length, count: COUNT },
    );
    expect(got).toEqual({ words: expected });
  });
});
