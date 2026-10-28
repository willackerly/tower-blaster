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
// The atomic fill leaves each row in scheduling order; rows are then sorted
// by manifold slot so the solver, which walks a body's row to sum its
// contact forces, is bit-for-bit reproducible.
//
// Options (ColoringOptions, from AvbdParams.colorMode and colorPriority; the
// reference's coloring.ts says why the rules are proper and what they buy;
// the engine colours with colorMode 3 unless told otherwise, gpuColorMode):
//   - colorMode 1-4: before the rounds, `cells` takes each body's lattice cell
//     parities and `prefer` its preferred colour; a round then takes that
//     colour when no higher-priority neighbour holds it. The priority, and so
//     the rounds, are the hash colouring's. 4 colours instead of 9-11 on resting
//     lattices of cubes; the hash colouring's choice off the lattice.
//   - colorPriority 1: largest degree first, then the hash (more rounds).
// The reference's coloring.ts gives their quality record. colorMode 0 with
// colorPriority 0 builds the hash colouring's shaders, character for character.
import { assertStorageFits, RadixSorter, Scanner } from '@tb/gpu';
import { COLOR_MODES, COLOR_PRIORITIES, LATTICE_MIN_ALIGNED } from '@tb/physics-ref';
import { Body, Manifold, Shape, wgslStruct } from '@tb/schema';

const WG = 64;
/** Colours are tracked in a 64-bit mask; a body needing more sets the overflow flag. */
export const MAX_COLORS = 64;
const UNCOLORED = 0xffffffff;

const HASH = /* wgsl */ `
fn priority(i: u32) -> u32 {
  var x = i;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}`;
const PRIORITY = /* wgsl */ `${HASH}
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
@group(0) @binding(7) var<storage, read_write> adjSlot: array<u32>;

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
  if (sa < p.maxEdges) { adj[sa] = m.b; adjSlot[sa] = k; }
  if (sb < p.maxEdges) { adj[sb] = m.a; adjSlot[sb] = k; }
}

// Sort each row by manifold slot (insertion sort; rows are short). The fill
// order is scheduling-dependent; the solver sums forces in row order, so
// sorted rows make its results bit-for-bit reproducible.
@compute @workgroup_size(${WG})
fn sortRows(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let start = rowStart[i];
  let end = min(start + atomicLoad(&cursor[i]), p.maxEdges);
  for (var k = start + 1u; k < end; k++) {
    let s = adjSlot[k];
    let a = adj[k];
    var j = k;
    while (j > start && adjSlot[j - 1u] > s) {
      adjSlot[j] = adjSlot[j - 1u];
      adj[j] = adj[j - 1u];
      j--;
    }
    adjSlot[j] = s;
    adj[j] = a;
  }
}`;

/** Colouring rules (see the header); 0 is the hash colouring's for each (the engine passes colorMode 3 when unset, gpuColorMode). */
export interface ColoringOptions {
  /** AvbdParams.colorMode: 0 none, 1 eight lattice colours, 2 four (corner kernel), 3 four (in-plane-diagonal kernel), 4 as 3 for the lattice interior only. */
  colorMode?: number;
  /** AvbdParams.colorPriority: 0 the hash, 1 largest degree first. */
  colorPriority?: number;
}

// Largest degree first: the row length (neighbours with points) decides, then the hash.
const DEGREE_FIRST = /* wgsl */ `${HASH}
fn outranks(i: u32, j: u32) -> bool {
  let di = rowLength[i];
  let dj = rowLength[j];
  if (di != dj) { return di > dj; }
  let pi = priority(i);
  let pj = priority(j);
  return pi > pj || (pi == pj && i < j);
}`;

const roundsWgsl = (mode: number, degreeFirst: boolean) => /* wgsl */ `
${degreeFirst ? DEGREE_FIRST : PRIORITY}
struct Params { n: u32, maxEdges: u32 }
@group(0) @binding(0) var<storage, read> rowStart: array<u32>;
@group(0) @binding(1) var<storage, read> rowLength: array<u32>;
@group(0) @binding(2) var<storage, read> adj: array<u32>;
@group(0) @binding(3) var<storage, read_write> colorIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> colorOut: array<u32>;
// [colours used, uncoloured after the last round, overflow, ...]
@group(0) @binding(5) var<storage, read_write> info: array<atomic<u32>, 8>;
@group(0) @binding(6) var<storage, read_write> order: array<u32>;
@group(0) @binding(7) var<uniform> p: Params;${mode ? `
// Each body's preferred colour (lattice cells, below), ${UNCOLORED} for none.
@group(0) @binding(8) var<storage, read> pref: array<u32>;` : ''}

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
  else { mine = ${MAX_COLORS - 1}u; atomicStore(&info[2], 1u); }${mode ? `
  // A preferred colour (< 8) is taken when no higher-priority neighbour holds it.
  let want = pref[i];
  if (want < 32u && (used.x & (1u << want)) == 0u) { mine = want; }` : ''}
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

// Lattice preferences (colorMode 1-4), as physics-ref's latticeParity,
// latticeColor and latticePreferences, in f32: a body's cell parities from
// its pose, then its preferred colour from its own and its row's. Two
// kernels, since the second reads every neighbour's parities.
const PREFER = (mode: number) => /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(Shape)}
struct Params { n: u32, maxEdges: u32, groundY: f32 }
@group(0) @binding(0) var<storage, read> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var<storage, read> rowStart: array<u32>;
@group(0) @binding(3) var<storage, read> rowLength: array<u32>;
@group(0) @binding(4) var<storage, read> adj: array<u32>;
// Cell parities (bit 0 x, 1 y, 2 z), ${UNCOLORED} off the lattice.
@group(0) @binding(5) var<storage, read_write> parity: array<u32>;
@group(0) @binding(6) var<storage, read_write> pref: array<u32>;
@group(0) @binding(7) var<uniform> p: Params;

// A cube in the world lattice of its own size: axes within ~11 deg of the
// world's, centre within 0.15 cell of a cell centre or corner on each axis
// (y from the ground); each parity on the nearer of the two lattices.
@compute @workgroup_size(${WG})
fn cells(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let b = bodies[i];
  let s = shapes[b.shape];
  parity[i] = ${UNCOLORED}u;
  if (s.kind != 0u || s.half.x != s.half.y || s.half.x != s.half.z || !(s.half.x > 0.0)) { return; }
  let x = b.rot.x; let y = b.rot.y; let z = b.rot.z; let w = b.rot.w;
  // Columns of the rotation matrix.
  let c0 = vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y));
  let c1 = vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x));
  let c2 = vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
  let big = vec3f(max(max(abs(c0.x), abs(c0.y)), abs(c0.z)), max(max(abs(c1.x), abs(c1.y)), abs(c1.z)), max(max(abs(c2.x), abs(c2.y)), abs(c2.z)));
  if (any(big < vec3f(0.98))) { return; }
  let q = vec3f(b.pos.x, b.pos.y - p.groundY, b.pos.z) / (2.0 * s.half.x);
  let h = 2.0 * q;
  if (any(abs(h - round(h)) >= vec3f(0.3))) { return; }
  let f = floor(q);
  let cell = select(floor(q + 0.5), f, abs(q - f - 0.5) < vec3f(0.25));
  let bit = vec3u(bitcast<vec3u>(vec3i(cell)) & vec3u(1u));
  parity[i] = bit.x | (bit.y << 1u) | (bit.z << 2u);
}

fn color4(bits: u32) -> u32 {
  let px = bits & 1u; let py = (bits >> 1u) & 1u; let pz = (bits >> 2u) & 1u;
  ${mode === 1 ? 'return 4u * py + 2u * px + pz;' : mode === 2 ? 'return 2u * (px ^ py) + (py ^ pz);' : 'return 2u * (px ^ pz) + py;' /* 3 and 4 */}
}

// Prefer the pattern colour with ${LATTICE_MIN_ALIGNED} or more aligned neighbours;${mode === 4 ? ' only when every neighbour is aligned and none has the same 4-colour (the lattice interior);' : mode === 1 ? '' : ' with one of the same 4-colour, the fallback 4-colour + 4 x (x parity);'} else none.
@compute @workgroup_size(${WG})
fn prefer(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  let mine = parity[i];
  pref[i] = ${UNCOLORED}u;
  if (mine == ${UNCOLORED}u) { return; }
  let c = color4(mine);
  var aligned = 0u;
  var clash = false;
  let start = rowStart[i];
  let end = min(start + rowLength[i], p.maxEdges);
  for (var k = start; k < end; k++) {
    let pu = parity[adj[k]];
    if (pu == ${UNCOLORED}u) { continue; }
    aligned++;
    clash = clash || color4(pu) == c;
  }
  if (aligned < ${LATTICE_MIN_ALIGNED}u) { return; }
  ${mode === 4 ? 'if (aligned == end - start && !clash) { pref[i] = c; }' : mode === 1 ? 'pref[i] = c;' : 'pref[i] = select(c, c + 4u * (mine & 1u), clash);'}
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
  /** Contact graph rows (CSR): body i's neighbours are adj[rowStart[i] .. + rowLength[i]], sorted by manifold slot. */
  readonly rowStart: GPUBuffer;
  /** Row lengths (u32 per body). */
  readonly rowLength: GPUBuffer;
  readonly adj: GPUBuffer;
  /** Manifold slot of each adjacency entry. */
  readonly adjSlot: GPUBuffer;
  private readonly degree: GPUBuffer;
  private readonly ping: [GPUBuffer, GPUBuffer];
  private readonly uniform: GPUBuffer;
  private readonly rangesUniform: GPUBuffer;
  private readonly scanner: Scanner;
  private readonly sorter: RadixSorter;
  private readonly pipes: Record<'countDegree' | 'fill' | 'sortRows' | 'init' | 'round' | 'finish', GPUComputePipeline>;
  private readonly graphBind: GPUBindGroup;
  private readonly binds: [GPUBindGroup, GPUBindGroup];
  private readonly rangesPipe: GPUComputePipeline;
  private readonly rangesBind: GPUBindGroup;
  /** colorMode 1-4: each body's lattice cell parities and preferred colour (u32, ${UNCOLORED} for none), and the kernels that fill them. */
  readonly parity: GPUBuffer | null = null;
  readonly pref: GPUBuffer | null = null;
  private readonly prefer: { cells: GPUComputePipeline; prefer: GPUComputePipeline; bind: GPUBindGroup } | null = null;

  /**
   * @param manifolds narrowphase output, one per pair slot
   * @param total broadphase total buffer (u32 x 8; [3] = pair slots written)
   * @param rounds Jones-Plassmann rounds; info[1] > 0 means too few
   * @param options opt-in rules; a colorMode needs the bodies and shapes, whose poses it reads
   */
  constructor(
    private readonly device: GPUDevice, manifolds: GPUBuffer, private readonly total: GPUBuffer, readonly capacity: number, maxPairs: number, readonly rounds = 64,
    readonly options: ColoringOptions & { bodies?: GPUBuffer; shapes?: GPUBuffer } = {},
  ) {
    if (rounds % 2 !== 0) throw new Error('Coloring: rounds must be even (the result ends in the first buffer)');
    const mode = options.colorMode ?? 0, priority = options.colorPriority ?? 0;
    if (!(COLOR_MODES as readonly number[]).includes(mode)) throw new Error(`Coloring: colorMode must be one of ${COLOR_MODES.join(', ')}, got ${mode}`);
    if (!(COLOR_PRIORITIES as readonly number[]).includes(priority)) throw new Error(`Coloring: colorPriority must be one of ${COLOR_PRIORITIES.join(', ')}, got ${priority}`);
    if (mode && !(options.bodies && options.shapes)) throw new Error('Coloring: a colorMode needs the bodies and shapes buffers');
    this.maxEdges = 2 * maxPairs;
    const buf = (bytes: number, label: string, extra = 0) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra, label }));
    this.degree = buf(capacity * 4, 'col degree');
    this.rowStart = buf(capacity * 4, 'col row start');
    this.rowLength = buf(capacity * 4, 'col row length (fill cursor)');
    this.adj = buf(this.maxEdges * 4, 'col adjacency');
    this.adjSlot = buf(this.maxEdges * 4, 'col adjacency slot');
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
    const graphLayout = layoutOf(['read-only-storage', 'read-only-storage', 'storage', 'storage', 'storage', 'storage', 'uniform', 'storage']);
    // With a colorMode (the engine's default, 3) the rounds bind 8 storage buffers, the default limit per stage:
    // one more binding here fails pipeline creation on default limits (colorMode 0 tests would not see it).
    const roundLayout = layoutOf(['read-only-storage', 'read-only-storage', 'read-only-storage', 'storage', 'storage', 'storage', 'storage', 'uniform', ...(mode ? ['read-only-storage' as const] : [])]);
    const graph = device.createShaderModule({ code: GRAPH, label: 'coloring graph' });
    const roundsModule = device.createShaderModule({ code: roundsWgsl(mode, priority === 1), label: 'coloring rounds' });
    const mk = (layout: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string) => device.createComputePipeline({ layout, compute: { module, entryPoint } });
    this.pipes = {
      countDegree: mk(graphLayout, graph, 'countDegree'), fill: mk(graphLayout, graph, 'fill'), sortRows: mk(graphLayout, graph, 'sortRows'),
      init: mk(roundLayout, roundsModule, 'init'), round: mk(roundLayout, roundsModule, 'round'), finish: mk(roundLayout, roundsModule, 'finish'),
    };
    const entries = (buffers: GPUBuffer[]) => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
    this.graphBind = device.createBindGroup({ layout: this.pipes.countDegree.getBindGroupLayout(0), entries: entries([manifolds, total, this.degree, this.rowStart, this.rowLength, this.adj, this.uniform, this.adjSlot]) });
    // After fill, rowLength (the fill cursor) holds each row's length.
    if (mode) {
      this.parity = buf(capacity * 4, 'col lattice parity');
      this.pref = buf(capacity * 4, 'col lattice preference');
      const layout = layoutOf(['read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'storage', 'storage', 'uniform']);
      const module = device.createShaderModule({ code: PREFER(mode), label: 'coloring lattice preference' });
      const cells = mk(layout, module, 'cells');
      this.prefer = {
        cells, prefer: mk(layout, module, 'prefer'),
        bind: device.createBindGroup({ layout: cells.getBindGroupLayout(0), entries: entries([options.bodies!, options.shapes!, this.rowStart, this.rowLength, this.adj, this.parity, this.pref, this.uniform]) }),
      };
    }
    const bindWith = (cin: GPUBuffer, cout: GPUBuffer) => device.createBindGroup({
      layout: this.pipes.round.getBindGroupLayout(0),
      entries: entries([this.rowStart, this.rowLength, this.adj, cin, cout, this.info, this.order, this.uniform, ...(this.pref ? [this.pref] : [])]),
    });
    this.binds = [bindWith(this.ping[0], this.ping[1]), bindWith(this.ping[1], this.ping[0])];
    const rmod = device.createShaderModule({ code: RANGES, label: 'coloring ranges' });
    this.rangesPipe = device.createComputePipeline({ layout: 'auto', compute: { module: rmod, entryPoint: 'ranges' } });
    this.rangesBind = device.createBindGroup({
      layout: this.rangesPipe.getBindGroupLayout(0),
      entries: [this.ping[0], this.colorStart, this.dispatch, this.rangesUniform].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  /** @param groundY the ground's height, from which a colorMode measures lattice cells in y (needed with one) */
  encode(encoder: GPUCommandEncoder, n: number, groundY?: number): void {
    if (n > this.capacity) throw new Error(`Coloring: n ${n} exceeds capacity ${this.capacity}`);
    if (this.prefer && groundY === undefined) throw new Error('Coloring.encode: a colorMode measures lattice cells from the ground, so it needs groundY');
    if (this.prefer) this.device.queue.writeBuffer(this.uniform, 0, new Uint32Array([n, this.maxEdges, new Uint32Array(Float32Array.of(groundY!).buffer)[0]!, 0]));
    else this.device.queue.writeBuffer(this.uniform, 0, new Uint32Array([n, this.maxEdges]));
    this.device.queue.writeBuffer(this.rangesUniform, 0, new Uint32Array([n]));
    for (const b of [this.degree, this.rowLength, this.info]) encoder.clearBuffer(b);
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
    pass.setPipeline(this.pipes.sortRows);
    pass.dispatchWorkgroups(groups);
    pass.end();
    // A new pass, because the rounds read rowLength and adj through read-only bindings.
    pass = encoder.beginComputePass();
    if (this.prefer) {
      pass.setBindGroup(0, this.prefer.bind);
      pass.setPipeline(this.prefer.cells);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(this.prefer.prefer);
      pass.dispatchWorkgroups(groups);
    }
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
    for (const b of [this.degree, this.rowStart, this.rowLength, this.adj, this.adjSlot, ...this.ping, this.order, this.colorStart, this.dispatch, this.info, this.uniform, this.rangesUniform]) b.destroy();
    this.parity?.destroy();
    this.pref?.destroy();
  }
}
