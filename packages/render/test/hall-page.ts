// Page-side driver for the hall tracer's GPU twin test (hall-gpu.test.ts).
import { readBuffer, sharedDevice } from '@tb/gpu';
import { HALL_WGSL, hallTraceCpu, hallUniform, OLYMPIA, type HallParams } from '../src/hall.ts';
import type { V3 } from '../src/math.ts';

/**
 * n rays from random points inside the hall in random directions, traced by
 * hallTrace on the GPU and by hallTraceCpu on the f32-rounded inputs. Rays
 * whose hit is within 2 mm of another surface (on the CPU, by nudging the
 * ray) may legitimately disagree; they are counted apart as edges.
 */
export async function hallTwins(seed: number, n: number, h: HallParams = OLYMPIA) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const f = Math.fround;
  const rays: Array<[V3, V3]> = [];
  for (let i = 0; i < n; i++) {
    const o: V3 = [(r() - 0.5) * 50, 0.2 + r() * 25, (r() - 0.5) * 130];
    const v: V3 = [r() - 0.5, r() - 0.35, r() - 0.5];
    const l = Math.hypot(...v);
    rays.push([o.map(f) as V3, v.map((x) => f(x / l)) as V3]);
  }
  const u = hallUniform(h);
  const vec = (k: number) => `vec4f(${Array.from(u.slice(4 * k, 4 * k + 4)).map((x) => x.toPrecision(9)).join(', ')})`;
  const code = `${HALL_WGSL}
@group(0) @binding(0) var<storage, read> xs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> ys: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= ${n}u) { return; }
  let hit = hallTrace(Hall(${[0, 1, 2, 3, 4, 5].map(vec).join(', ')}), xs[2u * i].xyz, xs[2u * i + 1u].xyz);
  ys[2u * i] = vec4f(hit.t, f32(hit.mat), hit.n.x, hit.n.y);
  ys[2u * i + 1u] = vec4f(hit.n.z, hit.uv, 0.0);
}`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const xs = device.createBuffer({ size: n * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(xs, 0, new Float32Array(rays.flatMap(([o, d]) => [...o, 0, ...d, 0])));
  const ys = device.createBuffer({ size: n * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: xs } }, { binding: 1, resource: { buffer: ys } }] }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const out = new Float32Array(await readBuffer(device, ys));
  const error = await device.popErrorScope();
  xs.destroy(); ys.destroy();
  let hits = 0, matMismatch = 0, edges = 0, tErr = 0, nErr = 0;
  let worstT: unknown = null, worstN: unknown = null;
  const mats = new Map<number, number>();
  const examples: unknown[] = [];
  rays.forEach(([o, d], i) => {
    const c = hallTraceCpu(h, o, d);
    const gt = out[8 * i]!, gm = out[8 * i + 1]!, gn: V3 = [out[8 * i + 2]!, out[8 * i + 3]!, out[8 * i + 4]!];
    mats.set(c.mat, (mats.get(c.mat) ?? 0) + 1);
    if (c.mat === 0 && gm === 0) return;
    // Near an edge: a 2 mm nudge of the ray's origin changes what the CPU hits.
    const near = [[0.002, 0, 0], [0, 0.002, 0], [0, 0, 0.002], [-0.002, 0, 0], [0, -0.002, 0], [0, 0, -0.002]].some((e) => {
      const q = hallTraceCpu(h, [o[0] + e[0]!, o[1] + e[1]!, o[2] + e[2]!], d);
      return q.mat !== c.mat || Math.abs(q.t - c.t) > 0.01;
    });
    if (gm !== c.mat || Math.abs(gt - c.t) > 1e-3 * (1 + c.t)) {
      if (near) { edges++; return; }
      matMismatch++;
      if (examples.length < 4) examples.push({ o, d, cpu: c, gpu: { t: gt, mat: gm, n: gn } });
      return;
    }
    hits++;
    const te = Math.abs(gt - c.t) / (1 + c.t);
    if (te > tErr) { tErr = te; worstT = { o, d, cpu: c, gpu: { t: gt, mat: gm, n: gn } }; }
    const ne = Math.hypot(gn[0] - c.n[0], gn[1] - c.n[1], gn[2] - c.n[2]);
    if (!near && ne > nErr) { nErr = ne; worstN = { o, d, cpu: c, gpu: { t: gt, mat: gm, n: gn } }; }
  });
  return { error: error?.message ?? null, n, hits, matMismatch, edges, tErr, nErr, mats: Object.fromEntries(mats), examples, worstT, worstN };
}
