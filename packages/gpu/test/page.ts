// Drivers that run inside the browser page. gpu.test.ts bundles this file with
// loadBundle() and calls the exports through page.evaluate; each driver checks
// its GPU result against the CPU reference in the page and returns a small
// summary, so large arrays never cross the Playwright boundary.
import { BandwidthProbe, compactIndices, Compactor, createDevice, exclusiveScanU32, RadixSorter, Readback, sortPairs, GpuProfiler, readBuffer, Scanner, uploadU32 } from '../src/index.ts';

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

/** The copy kernel must actually copy, or its GB/s means nothing. */
export async function bandwidthCopy(bytes: number) {
  const { device } = await createDevice();
  const probe = new BandwidthProbe(device, bytes);
  const words = probe.bytes / 4;
  const src = new Uint32Array(words);
  const r = rng(9);
  for (let i = 0; i < words; i++) src[i] = r();
  device.queue.writeBuffer(probe.src, 0, src);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  probe.encode(pass);
  pass.end();
  device.queue.submit([enc.finish()]);
  const got = new Uint32Array(await readBuffer(device, probe.dst));
  const res = { bytes: probe.bytes, traffic: probe.traffic, diff: firstDiff(got, src) };
  probe.destroy();
  device.destroy();
  return res;
}

export interface ReadCase { size: number; bytes?: number; offset?: number }

/** Read each case's range of a random source buffer through one Readback. */
export async function readbackData(cases: ReadCase[]) {
  const { device } = await createDevice();
  const rb = new Readback(device);
  device.pushErrorScope('validation');
  const out = [];
  for (const [k, c] of cases.entries()) {
    const words = fill(c.size / 4, 'random', 50 + k);
    const src = device.createBuffer({ size: c.size, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(src, 0, words);
    const got = await (c.bytes === undefined ? rb.read(src) : rb.read(src, c.bytes, c.offset));
    const first = (c.offset ?? 0) / 4;
    out.push({ ...c, byteLength: got.byteLength, diff: firstDiff(new Uint32Array(got), words.subarray(first, first + (c.bytes ?? c.size) / 4)) });
    src.destroy();
  }
  const error = await device.popErrorScope();
  const res = { cases: out, error: error?.message ?? null, created: rb.created, bytesRead: rb.bytesRead };
  rb.destroy();
  device.destroy();
  return res;
}

/**
 * The Readback rules, step by step: pool reuse and growth, concurrency,
 * queue order, alignment and range errors, a failed map and destroy().
 * Each entry is what the test expects to be exact.
 */
export async function readbackRules() {
  const { device } = await createDevice();
  let submits = 0;
  const submit = device.queue.submit.bind(device.queue);
  device.queue.submit = (cmds) => { submits++; submit(cmds); };
  device.pushErrorScope('validation');
  const source = (words: Uint32Array) => {
    const b = device.createBuffer({ size: words.byteLength, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, words);
    return b;
  };
  const u32 = async (p: Promise<ArrayBuffer>) => Array.from(new Uint32Array(await p));
  const fails = async (f: () => Promise<unknown>) => { try { await f(); return 'no error'; } catch (err) { return (err as Error).message; } };
  type Pool = { free: GPUBuffer[]; all: Set<GPUBuffer> };
  const pool = (rb: Readback) => rb as unknown as Pool;
  const freeSizes = (rb: Readback) => pool(rb).free.map((b) => b.size).sort((a, b) => a - b);
  const inFlight = (rb: Readback) => [...pool(rb).all].filter((b) => !pool(rb).free.includes(b));
  // Copying into a destroyed buffer is a validation error; into a live,
  // unmapped one it is not. (A mapped one fails too, hence mapState.)
  const probe = source(new Uint32Array(1));
  const isDestroyed = async (b: GPUBuffer) => {
    if (b.mapState !== 'unmapped') return false;
    device.pushErrorScope('validation');
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(probe, 0, b, 0, 4);
    submit([enc.finish()]);
    return (await device.popErrorScope()) !== null;
  };

  const big = fill(2 ** 18, 'random', 1), small = fill(250, 'random', 2);
  const a = source(big), b = source(small);
  const rb = new Readback(device);

  // Pool: three 1000-byte reads share one 1 KiB buffer; a 1 MiB read adds
  // one; a 1000-byte read then takes the 1 KiB buffer, not the larger one.
  const seq = [];
  for (let i = 0; i < 3; i++) seq.push((await u32(rb.read(b))).every((x, k) => x === small[k]));
  const afterSequential = { created: rb.created, free: freeSizes(rb) };
  const largeOk = firstDiff(new Uint32Array(await rb.read(a)), big) === -1;
  const afterLarge = { created: rb.created, free: freeSizes(rb) };
  const pending = rb.read(b);
  const freeWhileSmallInFlight = freeSizes(rb);
  const smallAgainOk = (await u32(pending)).every((x, k) => x === small[k]);
  const afterSmall = { created: rb.created, free: freeSizes(rb) };

  // Concurrent reads on a fresh pool: two buffers, both correct.
  const rc = new Readback(device);
  const [ca, cb] = await Promise.all([rc.read(a), rc.read(b)]);
  const concurrent = { created: rc.created, a: firstDiff(new Uint32Array(ca), big), b: firstDiff(new Uint32Array(cb), small) };
  rc.destroy();

  // Queue order: a read sees exactly what was submitted before it was called.
  const c = source(Uint32Array.from([1, 2, 3, 4]));
  const before = rb.read(c);
  device.queue.writeBuffer(c, 0, Uint32Array.from([5, 6, 7, 8]));
  const after = rb.read(c);
  const order = { before: await u32(before), after: await u32(after) };

  // Errors and the empty read do no GPU work at all.
  const n0 = submits, created0 = rb.created, bytes0 = rb.bytesRead;
  const misaligned = { bytes: await fails(() => rb.read(c, 6)), offset: await fails(() => rb.read(c, 4, 2)), range: await fails(() => rb.read(c, 8, 12)), negative: await fails(() => rb.read(c, -4)) };
  const empty = (await rb.read(c, 0)).byteLength;
  const idle = { submits: submits - n0, created: rb.created - created0, bytesRead: rb.bytesRead - bytes0 };
  // One submit per read, and only the bytes read are mapped (of a 1 KiB buffer here).
  const oneSubmit = submits;
  const maps: Array<[number | undefined, number | undefined]> = [];
  const mapAsync = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function (mode, offset, size) { maps.push([offset, size]); return mapAsync.call(this, mode, offset, size); };
  try { await rb.read(c, 4, 12); } finally { GPUBuffer.prototype.mapAsync = mapAsync; }
  const submitsPerRead = submits - oneSubmit;

  // A failed map: the read rejects, its buffer is destroyed and never
  // returns to the pool, so the next read on this pool makes a new one.
  const rf = new Readback(device);
  const failing = rf.read(b, 64);
  const victim = inFlight(rf)[0]!;
  victim.unmap(); // rejects the pending mapAsync
  const failedMap = await fails(() => failing);
  const victimGone = pool(rf).all.size === 0 && pool(rf).free.length === 0;
  const victimDestroyed = await isDestroyed(victim);
  const recovered = (await u32(rf.read(b, 64))).every((x, k) => x === small[k]);
  const recoveredCreated = rf.created;
  rf.destroy();

  // destroy(): every buffer, a read in flight rejects, later reads throw.
  const flying = rb.read(a);
  const buffers = [...pool(rb).all];
  rb.destroy();
  const destroyedInFlight = await fails(() => flying);
  const allDestroyed = (await Promise.all(buffers.map(isDestroyed))).every(Boolean);
  const readAfterDestroy = await fails(() => rb.read(b));

  // isDestroyed's own errors were taken by its scopes; anything else is a bug.
  const error = await device.popErrorScope();
  device.destroy();
  return {
    error: error?.message ?? null, seq, afterSequential, largeOk, afterLarge, freeWhileSmallInFlight, smallAgainOk, afterSmall, concurrent, order,
    misaligned, empty, idle, submitsPerRead, maps, failedMap, victimGone, victimDestroyed, recovered, recoveredCreated,
    destroyedInFlight, buffers: buffers.length, allDestroyed, readAfterDestroy,
  };
}

export { runGpuBench } from '../src/bench.ts';
