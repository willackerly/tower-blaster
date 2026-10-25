// Drivers that run inside the browser page. gpu.test.ts bundles this file with
// loadBundle() and calls the exports through page.evaluate; each driver checks
// its GPU result against the CPU reference in the page and returns a small
// summary, so large arrays never cross the Playwright boundary.
import { compactIndices, Compactor, createDevice, exclusiveScanU32, RadixSorter, sortPairs, GpuProfiler, readBuffer, Scanner, uploadU32 } from '../src/index.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export type Fill = 'random' | 'max' | 'small';
function fill(n: number, kind: Fill, seed: number): Uint32Array {
  const r = rng(seed);
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = kind === 'max' ? 0xffffffff : kind === 'small' ? r() & 3 : r();
  return a;
}

/** First index where a and b differ, or -1. */
function firstDiff(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

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

export interface ScanCase { n: number; capacity: number; fill: Fill; seed: number }

/**
 * For each case: fill capacity elements, scan the first n, and check the
 * prefix against the reference and the tail for being untouched. Cases share
 * one Scanner per capacity, so later cases also test reuse at a smaller n.
 */
export async function scan(cases: ScanCase[]) {
  const { device } = await createDevice();
  const scanners = new Map<number, { buf: GPUBuffer; scanner: Scanner }>();
  const out = [];
  for (const c of cases) {
    let s = scanners.get(c.capacity);
    if (!s) {
      const buf = uploadU32(device, new Uint32Array(c.capacity));
      s = { buf, scanner: new Scanner(device, buf, c.capacity) };
      scanners.set(c.capacity, s);
    }
    const input = fill(c.capacity, c.fill, c.seed);
    device.queue.writeBuffer(s.buf, 0, input);
    device.pushErrorScope('validation');
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    s.scanner.encode(pass, c.n);
    pass.end();
    device.queue.submit([enc.finish()]);
    const error = await device.popErrorScope();
    const got = new Uint32Array(await readBuffer(device, s.buf, c.capacity * 4));
    const prefix = firstDiff(got.subarray(0, c.n), exclusiveScanU32(input.subarray(0, c.n)));
    const tail = firstDiff(got.subarray(c.n), input.subarray(c.n));
    out.push({ ...c, error: error?.message ?? null, prefixDiff: prefix, tailDiff: tail });
  }
  device.destroy();
  return out;
}

export interface CompactCase { n: number; capacity: number; density: number; seed: number }

const MARK = /* wgsl */ `
@group(0) @binding(0) var<storage, read> list: array<u32>;
@group(0) @binding(1) var<storage, read> count: array<u32, 4>;
@group(0) @binding(2) var<storage, read_write> marks: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < count[3]) { marks[list[id.x]] = 1u; }
}`;

/**
 * Compact random flags (arbitrary nonzero values, to exercise normalization),
 * check the list and count, then consume the list through
 * dispatchWorkgroupsIndirect to prove the indirect arguments cover it.
 */
export async function compact(cases: CompactCase[]) {
  const { device } = await createDevice();
  const markPipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: MARK }), entryPoint: 'main' } });
  const out = [];
  for (const c of cases) {
    const r = rng(c.seed);
    const flags = new Uint32Array(c.capacity);
    for (let i = 0; i < c.capacity; i++) flags[i] = r() / 2 ** 32 < c.density ? r() | 1 : 0;
    const flagBuf = uploadU32(device, flags);
    const listBuf = uploadU32(device, new Uint32Array(Math.max(1, c.capacity)).fill(0xdeadbeef));
    const marks = uploadU32(device, new Uint32Array(Math.max(1, c.capacity)));
    const compactor = new Compactor(device, flagBuf, listBuf, c.capacity, 64);
    device.pushErrorScope('validation');
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    compactor.encode(pass, c.n);
    pass.setPipeline(markPipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: markPipe.getBindGroupLayout(0), entries: [listBuf, compactor.count, marks].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    pass.dispatchWorkgroupsIndirect(compactor.count, 0);
    pass.end();
    device.queue.submit([enc.finish()]);
    const error = await device.popErrorScope();
    const count = Array.from(new Uint32Array(await readBuffer(device, compactor.count)));
    const expected = compactIndices(flags.subarray(0, c.n));
    const list = new Uint32Array(await readBuffer(device, listBuf, Math.max(1, c.capacity) * 4));
    const marked = new Uint32Array(await readBuffer(device, marks, Math.max(1, c.capacity) * 4));
    const wantMarks = new Uint32Array(Math.max(1, c.capacity));
    for (const i of expected) wantMarks[i] = 1;
    out.push({
      ...c, error: error?.message ?? null, count, expectedCount: expected.length,
      listDiff: firstDiff(list.subarray(0, expected.length), expected),
      untouchedAfter: list.subarray(expected.length).every((x) => x === 0xdeadbeef),
      marksDiff: firstDiff(marked, wantMarks),
    });
    compactor.destroy();
  }
  device.destroy();
  return out;
}

export type KeyKind = 'random' | 'dupes' | 'sorted' | 'reversed' | 'max';
export interface SortCase { n: number; capacity: number; keys: KeyKind; keyBits: number; seed: number }

/**
 * Sort (key, original index) pairs and compare with the stable reference.
 * Values are the original indices, so any instability shows up as a value
 * mismatch among equal keys. Also checks the caller's tail is untouched.
 */
export async function sort(cases: SortCase[]) {
  const { device } = await createDevice();
  const out = [];
  for (const c of cases) {
    const r = rng(c.seed);
    const mask = c.keyBits >= 32 ? 0xffffffff : (1 << c.keyBits) - 1;
    const keys = new Uint32Array(c.capacity);
    for (let i = 0; i < c.capacity; i++) {
      const k = c.keys === 'dupes' ? r() & 7 : c.keys === 'sorted' ? i : c.keys === 'reversed' ? c.capacity - i : c.keys === 'max' ? 0xffffffff : r();
      keys[i] = (k & mask) >>> 0;
    }
    const vals = Uint32Array.from({ length: c.capacity }, (_, i) => i);
    const kb = uploadU32(device, keys), vb = uploadU32(device, vals);
    const sorter = new RadixSorter(device, kb, vb, c.capacity);
    device.pushErrorScope('validation');
    const enc = device.createCommandEncoder();
    sorter.encode(enc, c.n, c.keyBits);
    device.queue.submit([enc.finish()]);
    const error = await device.popErrorScope();
    const gotK = new Uint32Array(await readBuffer(device, kb, c.capacity * 4));
    const gotV = new Uint32Array(await readBuffer(device, vb, c.capacity * 4));
    const want = sortPairs(keys.subarray(0, c.n), vals.subarray(0, c.n), c.keyBits);
    out.push({
      ...c, error: error?.message ?? null,
      keyDiff: firstDiff(gotK.subarray(0, c.n), want.keys),
      valDiff: firstDiff(gotV.subarray(0, c.n), want.vals),
      tailDiff: firstDiff(gotK.subarray(c.n), keys.subarray(c.n)),
    });
    sorter.destroy();
  }
  device.destroy();
  return out;
}
