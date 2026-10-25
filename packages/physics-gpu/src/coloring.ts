// GPU graph colouring of the contact graph, for the Gauss-Seidel solver
// sweep: bodies of one colour share no contact and update in parallel.
//
//   1. degree: every manifold with points adds one to each end (atomics)
//   2. scan the degrees into row starts (CSR); 3. fill the adjacency
//   4. Jones-Plassmann rounds: an uncoloured body whose priority beats every
//      uncoloured neighbour takes the smallest colour its neighbours lack
//   5. stable radix sort of (colour, body) gives each colour's body list
//
// The result equals the reference's greedy colouring in priority order
// (physics-ref/src/coloring.ts; same lowbias32 priority, same index
// tie-break), independent of thread scheduling: a body colours only after
// all higher-priority neighbours have, and lower-priority neighbours wait
// for it. Rounds read the colours of the previous round and write a second
// buffer, so no thread ever reads a colour written in the same round. (An
// in-place version would also be correct under sequential consistency, but
// WGSL atomics are relaxed.)
//
// Adjacency order within a row is not deterministic (atomic fill) and does
// not need to be: nothing reads it in order.
import { RadixSorter, Scanner } from '@tb/gpu';
import { Manifold, wgslStruct } from '@tb/schema';

const WG = 64;
/** Colours are tracked in a 64-bit mask; a body needing more sets the overflow flag. */
export const MAX_COLORS = 64;
const UNCOLORED = 0xffffffff;

const PRIORITY = /* wgsl */ `
fn priority(i: u32) -> u32 {
  var x = i;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
fn outranks(i: u32, j: u32) -> bool {
  let pi = priority(i);
  let pj = priority(j);
  return pi > pj || (pi == pj && i < j);
}`;

// Graph building (CSR). Kept apart from the rounds so each stays within the
// default 8 storage buffers per stage.
const GRAPH = /* wgsl */ `
${wgslStruct(Manifold)}
struct Params { n: u32, maxEdges: u32 }
@group(0) @binding(0) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(1) var<storage, read> total: array<u32, 8>;
@group(0) @binding(2) var<storage, read_write> degree: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> rowStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cursor: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> adj: array<u32>;
@group(0) @binding(6) var<uniform> p: Params;

@compute @workgroup_size(${WG})
fn countDegree(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let m = manifolds[k];
  if (m.count == 0u) { return; }
  atomicAdd(&degree[m.a], 1u);
  atomicAdd(&degree[m.b], 1u);
}

@compute @workgroup_size(${WG})
fn fill(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let m = manifolds[k];
  if (m.count == 0u) { return; }
  let sa = rowStart[m.a] + atomicAdd(&cursor[m.a], 1u);
  let sb = rowStart[m.b] + atomicAdd(&cursor[m.b], 1u);
  if (sa < p.maxEdges) { adj[sa] = m.b; }
  if (sb < p.maxEdges) { adj[sb] = m.a; }
}`;

const ROUNDS = /* wgsl */ `
${PRIORITY}
struct Params { n: u32, maxEdges: u32 }
@group(0) @binding(0) var<storage, read> rowStart: array<u32>;
@group(0) @binding(1) var<storage, read> rowLength: array<u32>;
@group(0) @binding(2) var<storage, read> adj: array<u32>;
@group(0) @binding(3) var<storage, read_write> colorIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> colorOut: array<u32>;
// [colours used, uncoloured after the last round, overflow, ...]
@group(0) @binding(5) var<storage, read_write> info: array<atomic<u32>, 8>;
@group(0) @binding(6) var<storage, read_write> order: array<u32>;
@group(0) @binding(7) var<uniform> p: Params;

@compute @workgroup_size(${WG})
fn init(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  colorIn[i] = ${UNCOLORED}u;
}

@compute @workgroup_size(${WG})
fn round(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let c = colorIn[i];
  if (c != ${UNCOLORED}u) { colorOut[i] = c; return; }
  let start = rowStart[i];
  let end = min(start + rowLength[i], p.maxEdges);
  var used = vec2u(0u, 0u);
  for (var k = start; k < end; k++) {
    let u = adj[k];
    let cu = colorIn[u];
    if (cu == ${UNCOLORED}u) {
      if (outranks(u, i)) { colorOut[i] = ${UNCOLORED}u; return; }
    } else if (cu < 32u) {
      used.x |= 1u << cu;
    } else if (cu < 64u) {
      used.y |= 1u << (cu - 32u);
    }
  }
  var mine = 0u;
  if (used.x != 0xffffffffu) { mine = countTrailingZeros(~used.x); }
  else if (used.y != 0xffffffffu) { mine = 32u + countTrailingZeros(~used.y); }
  else { mine = ${MAX_COLORS - 1}u; atomicStore(&info[2], 1u); }
  colorOut[i] = mine;
}

// After the rounds: colour count, uncoloured count, sort keys and values.
@compute @workgroup_size(${WG})
fn finish(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let c = colorIn[i];
  if (c == ${UNCOLORED}u) { atomicAdd(&info[1], 1u); colorOut[i] = ${MAX_COLORS - 1}u; }
  else { atomicMax(&info[0], c + 1u); colorOut[i] = c; }
  order[i] = i;
}`;

// Separate small module: colour ranges and per-colour indirect dispatch
// arguments from the sorted keys.
const RANGES = /* wgsl */ `
struct Params { n: u32 }
@group(0) @binding(0) var<storage, read> keys: array<u32>;
// colourStart[c], c in [0, ${MAX_COLORS}]: bodies of colour c are order[colourStart[c] .. colourStart[c + 1])
@group(0) @binding(1) var<storage, read_write> colorStart: array<u32>;
// [groupsX, 1, 1] per colour, for dispatchWorkgroupsIndirect at ${WG} threads per group
@group(0) @binding(2) var<storage, read_write> dispatch: array<u32>;
@group(0) @binding(3) var<uniform> p: Params;

var<workgroup> starts: array<u32, ${MAX_COLORS + 1}>;

// One thread per colour boundary: colourStart[c] = first k with keys[k] >= c (binary search).
@compute @workgroup_size(${MAX_COLORS + 1})
fn ranges(@builtin(local_invocation_id) lid: vec3u) {
  let c = lid.x;
  var lo = 0u;
  var hi = p.n;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (keys[mid] < c) { lo = mid + 1u; } else { hi = mid; }
  }
  starts[c] = lo;
  colorStart[c] = lo;
  workgroupBarrier();
  if (c < ${MAX_COLORS}u) {
    let count = starts[c + 1u] - lo;
    dispatch[3u * c] = (count + ${WG - 1}u) / ${WG}u;
    dispatch[3u * c + 1u] = 1u;
    dispatch[3u * c + 2u] = 1u;
  }
}`;

export class Coloring {
  /** u32 colour per body (valid when info[1] == 0 and info[2] == 0). */
  readonly colors: GPUBuffer;
  /** Body indices sorted by colour, ascending index within a colour. */
  readonly order: GPUBuffer;
  /** u32 x (MAX_COLORS + 1): start of each colour in `order`. */
  readonly colorStart: GPUBuffer;
  /** u32 x 3 per colour: indirect dispatch arguments (64 threads per group). */
  readonly dispatch: GPUBuffer;
  /** u32 x 8: [colours used, uncoloured, overflow]. */
  readonly info: GPUBuffer;
  readonly maxEdges: number;
  private readonly degree: GPUBuffer;
  private readonly rowStart: GPUBuffer;
  private readonly cursor: GPUBuffer;
  private readonly adj: GPUBuffer;
  private readonly ping: [GPUBuffer, GPUBuffer];
  private readonly uniform: GPUBuffer;
  private readonly rangesUniform: GPUBuffer;
  private readonly scanner: Scanner;
  private readonly sorter: RadixSorter;
  private readonly pipes: Record<'countDegree' | 'fill' | 'init' | 'round' | 'finish', GPUComputePipeline>;
  private readonly graphBind: GPUBindGroup;
  private readonly binds: [GPUBindGroup, GPUBindGroup];
  private readonly rangesPipe: GPUComputePipeline;
  private readonly rangesBind: GPUBindGroup;

  /**
   * @param manifolds narrowphase output, one per pair slot
   * @param total broadphase total buffer (u32 x 8; [3] = pair slots written)
   * @param rounds Jones-Plassmann rounds; info[1] > 0 means too few
   */
  constructor(private readonly device: GPUDevice, manifolds: GPUBuffer, private readonly total: GPUBuffer, readonly capacity: number, maxPairs: number, readonly rounds = 64) {
    if (rounds % 2 !== 0) throw new Error('Coloring: rounds must be even (the result ends in the first buffer)');
    this.maxEdges = 2 * maxPairs;
    const buf = (bytes: number, label: string, extra = 0) => device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra, label });
    this.degree = buf(capacity * 4, 'col degree');
    this.rowStart = buf(capacity * 4, 'col row start');
    this.cursor = buf(capacity * 4, 'col cursor');
    this.adj = buf(this.maxEdges * 4, 'col adjacency');
    this.ping = [buf(capacity * 4, 'col colours A'), buf(capacity * 4, 'col colours B')];
    this.colors = this.ping[1];
    this.order = buf(capacity * 4, 'col order');
    this.colorStart = buf((MAX_COLORS + 1) * 4, 'col colour start');
    this.dispatch = buf(MAX_COLORS * 12, 'col dispatch', GPUBufferUsage.INDIRECT);
    this.info = buf(32, 'col info');
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.rangesUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.scanner = new Scanner(device, this.rowStart, capacity);
    // Sort keys live in the first colour buffer once the rounds are done.
    this.sorter = new RadixSorter(device, this.ping[0], this.order, capacity);
    const layoutOf = (kinds: GPUBufferBindingType[]) => device.createPipelineLayout({
      bindGroupLayouts: [device.createBindGroupLayout({ entries: kinds.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })) })],
    });
    const graphLayout = layoutOf(['read-only-storage', 'read-only-storage', 'storage', 'storage', 'storage', 'storage', 'uniform']);
    const roundLayout = layoutOf(['read-only-storage', 'read-only-storage', 'read-only-storage', 'storage', 'storage', 'storage', 'storage', 'uniform']);
    const graph = device.createShaderModule({ code: GRAPH, label: 'coloring graph' });
    const roundsModule = device.createShaderModule({ code: ROUNDS, label: 'coloring rounds' });
    const mk = (layout: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string) => device.createComputePipeline({ layout, compute: { module, entryPoint } });
    this.pipes = {
      countDegree: mk(graphLayout, graph, 'countDegree'), fill: mk(graphLayout, graph, 'fill'),
      init: mk(roundLayout, roundsModule, 'init'), round: mk(roundLayout, roundsModule, 'round'), finish: mk(roundLayout, roundsModule, 'finish'),
    };
    const entries = (buffers: GPUBuffer[]) => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
    this.graphBind = device.createBindGroup({ layout: this.pipes.countDegree.getBindGroupLayout(0), entries: entries([manifolds, total, this.degree, this.rowStart, this.cursor, this.adj, this.uniform]) });
    // After fill, cursor[i] is body i's row length.
    const bindWith = (cin: GPUBuffer, cout: GPUBuffer) => device.createBindGroup({
      layout: this.pipes.round.getBindGroupLayout(0),
      entries: entries([this.rowStart, this.cursor, this.adj, cin, cout, this.info, this.order, this.uniform]),
    });
    this.binds = [bindWith(this.ping[0], this.ping[1]), bindWith(this.ping[1], this.ping[0])];
    const rmod = device.createShaderModule({ code: RANGES, label: 'coloring ranges' });
    this.rangesPipe = device.createComputePipeline({ layout: 'auto', compute: { module: rmod, entryPoint: 'ranges' } });
    this.rangesBind = device.createBindGroup({
      layout: this.rangesPipe.getBindGroupLayout(0),
      entries: [this.ping[0], this.colorStart, this.dispatch, this.rangesUniform].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  encode(encoder: GPUCommandEncoder, n: number): void {
    if (n > this.capacity) throw new Error(`Coloring: n ${n} exceeds capacity ${this.capacity}`);
    this.device.queue.writeBuffer(this.uniform, 0, new Uint32Array([n, this.maxEdges]));
    this.device.queue.writeBuffer(this.rangesUniform, 0, new Uint32Array([n]));
    for (const b of [this.degree, this.cursor, this.info]) encoder.clearBuffer(b);
    const groups = Math.max(1, Math.ceil(n / WG));
    let pass = encoder.beginComputePass();
    pass.setBindGroup(0, this.graphBind);
    pass.setPipeline(this.pipes.countDegree);
    pass.dispatchWorkgroupsIndirect(this.total, 0);
    pass.end();
    encoder.copyBufferToBuffer(this.degree, 0, this.rowStart, 0, n * 4);
    pass = encoder.beginComputePass();
    if (n > 0) this.scanner.encode(pass, n);
    pass.setBindGroup(0, this.graphBind);
    pass.setPipeline(this.pipes.fill);
    pass.dispatchWorkgroupsIndirect(this.total, 0);
    pass.end();
    // A new pass, because the rounds read cursor and adj through read-only bindings.
    pass = encoder.beginComputePass();
    pass.setBindGroup(0, this.binds[0]);
    pass.setPipeline(this.pipes.init);
    pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.pipes.round);
    for (let r = 0; r < this.rounds; r++) {
      pass.setBindGroup(0, this.binds[r % 2]!);
      pass.dispatchWorkgroups(groups);
    }
    // Rounds end in ping[0]; finish writes final colours (and sort keys) to ping[1]...
    pass.setBindGroup(0, this.binds[0]);
    pass.setPipeline(this.pipes.finish);
    pass.dispatchWorkgroups(groups);
    pass.end();
    // ...and the sort consumes a copy in ping[0], keeping ping[1] as the per-body colours.
    encoder.copyBufferToBuffer(this.ping[1], 0, this.ping[0], 0, n * 4);
    this.sorter.encode(encoder, n, 8);
    pass = encoder.beginComputePass();
    pass.setPipeline(this.rangesPipe);
    pass.setBindGroup(0, this.rangesBind);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  destroy(): void {
    this.scanner.destroy();
    this.sorter.destroy();
    for (const b of [this.degree, this.rowStart, this.cursor, this.adj, ...this.ping, this.order, this.colorStart, this.dispatch, this.info, this.uniform, this.rangesUniform]) b.destroy();
  }
}
