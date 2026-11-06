// Pinned bodies on the GPU (engine-api pinned.ts, roadmap C8): a never-wake sleeper.
//
// A sleeper is already an anchor (sleep.ts, solver.ts SLEEPING): awake bit clear, its pose fixed and its velocity 0,
// no colour, so the primal never visits it and every awake body touching it solves against its fixed pose as an
// infinite mass; contacts with both ends anchored are frozen. Probe X5 (docs/game/mode-probes.md) measured that path
// as solid as the ground plane. A pinned body is a sleeper that never wakes: Body.flags bit 1 (PINNED) marks it, its
// awake bit stays clear, and the passes that set awake bits leave it alone:
// - blasts, field kicks and the wake of a removal never push or wake it (blast.ts);
// - the sleep pass never wakes it, never joins sleepers through it (a group of sleepers on one pin is not one group,
//   as the ground joins nothing), and a body touching it is not kept awake by it (its quiet counter is not read).
//
// The anchor path is compiled in (the solver's sleepOn) when the engine sleeps or when the scene can hold a pinned
// body (scenePins, or GpuEngineOptions.pins). Without sleep there is no sleep pass to write the colouring's seed, so
// PinSeed writes it, one dispatch a step: SLEEPER_COLOR for an anchored body (awake bit clear, not removed: only
// pinned ones, without sleep), uncoloured for the rest.
import { Body, TIER, wgslStruct } from '@tb/schema';
import { assertStorageFits } from '@tb/gpu';
import { SLEEPER_COLOR } from './coloring.ts';

/** Body.flags bit 1: pinned (engine-api pinned.ts). */
export const PINNED = 2;
/** Body.flags bit 0: awake. */
export const AWAKE = 1;

const WG = 64;

const CODE = /* wgsl */ `
${wgslStruct(Body)}
@group(0) @binding(0) var<uniform> n: vec4u;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read_write> seed: array<u32>;

@compute @workgroup_size(${WG})
fn pinSeed(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= n.x) { return; }
  let f = bodies[i].flags;
  let anchored = (f & 1u) == 0u && ((f >> 8u) & 0xffu) != ${TIER.free}u;
  seed[i] = select(0xffffffffu, ${SLEEPER_COLOR}u, anchored);
}`;

/** The colouring's seed without sleep: the pinned bodies, as sleepers. */
export class PinSeed {
  /** u32 per body slot: the colouring's seed (Coloring.encode). */
  readonly seed: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly pipe: GPUComputePipeline;
  private readonly bind: GPUBindGroup;

  constructor(private readonly device: GPUDevice, capacity: number, bodies: GPUBuffer) {
    assertStorageFits(device, capacity * 4, 'pin colour seed');
    this.seed = device.createBuffer({ size: Math.max(16, capacity * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'pin colour seed' });
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'pin seed params' });
    this.pipe = device.createComputePipeline({ label: 'pin seed', layout: 'auto', compute: { module: device.createShaderModule({ code: CODE, label: 'pin seed' }), entryPoint: 'pinSeed' } });
    this.bind = device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [this.uniform, bodies, this.seed].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  /** Writes this step's seed; encode after anything that changes awake bits this step (blasts) and before the colouring. */
  encode(enc: GPUCommandEncoder, n: number): void {
    if (n === 0) return;
    this.device.queue.writeBuffer(this.uniform, 0, Uint32Array.of(n, 0, 0, 0));
    const pass = enc.beginComputePass({ label: 'pin seed' });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bind);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
    pass.end();
  }

  destroy(): void {
    this.seed.destroy();
    this.uniform.destroy();
  }
}
