// Per-body sleep on the GPU (roadmap E2; the E1 design doc's design C, "per-body sleep with wake fronts").
//
// Step 1, this file so far: the bookkeeping alone. Nothing is skipped yet, so the trajectory is the
// same, bit for bit, with the pass on or off; only Body.flags bit 0 (awake) and Snapshot.awake change.
// After a step's solve, three dispatches in one compute pass:
//
//   quiet       per body: the body is quiet this step when |v| + |w| r < speed (v_sleep) and it has
//               moved no more than drift x r since its window began (anchorPos, anchorRot; the
//               displacement is the centre's plus the chord a point at radius r sweeps, 2 r sin(angle / 2)).
//               A quiet step adds one to SleepBody.quiet; any other step sets it to 0 and starts a new
//               window at the body's pose. Also clears the body's veto.
//   neighbours  per broadphase pair slot whose manifold has points (speculative ones included; the ground
//               is no neighbour): a body whose partner has been quiet for fewer than steps / 2 is vetoed.
//               This keeps a one-body band of awake bodies next to anything still moving.
//   decide      per body: asleep (awake bit 0) when quiet >= steps and nothing vetoed it; else awake.
//
// r is BodyProps.radius, the bounding radius. Removed bodies (tier free) are left alone: their flags
// stay as remove() wrote them (asleep). Thresholds are in scene units (cube units, plank widths for S15),
// so they move with the scene's own scale.
import { Body, BodyProps, Manifold, SleepBody, SleepParams, TIER, wgslStruct, writeStruct } from '@tb/schema';
import { assertStorageFits } from '@tb/gpu';
import type { Quat, Vec3 } from '@tb/engine-api';

const WG = 64;
/** The pair kernels' indirect arguments (Broadphase.total[0..2]) are counted in workgroups of this many threads. */
const PAIR_WG = 64;

/** The sleep rule's thresholds (GpuEngineOptions.sleepSpeed, sleepSteps, sleepDrift). */
export interface SleepRule {
  /** v_sleep, scene units/s: |v| + |w| r must stay below it. */
  speed: number;
  /** T, steps: how long a body must stay quiet. */
  steps: number;
  /** How far a body may move over its quiet window, as a fraction of its bounding radius. */
  drift: number;
}

/**
 * The defaults: the E1 time-to-quiet study's rule (0.05 units/s for 30 steps, 0.5 s at 60 Hz; thresholds
 * of 0.02 and 0.1 gave the same picture there) and the CPU tier's 2% displacement window.
 */
export const DEFAULT_SLEEP: SleepRule = { speed: 0.05, steps: 30, drift: 0.02 };

const CODE = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(BodyProps)}
${wgslStruct(Manifold)}
${wgslStruct(SleepBody)}
${wgslStruct(SleepParams)}
@group(0) @binding(0) var<uniform> p: SleepParams;
@group(0) @binding(1) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> props: array<BodyProps>;
@group(0) @binding(3) var<storage, read_write> state: array<SleepBody>;
@group(0) @binding(4) var<storage, read_write> veto: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(6) var<storage, read> total: array<u32>;

const QUIET_MAX = 0x7fffffffu;

fn removed(i: u32) -> bool { return ((bodies[i].flags >> 8u) & 0xffu) == ${TIER.free}u; }

@compute @workgroup_size(${WG})
fn quiet(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  atomicStore(&veto[i], 0u);
  if (removed(i)) { return; }
  let b = bodies[i];
  let r = props[i].radius;
  var s = state[i];
  // The rotation since the window began, q conj(q0): its vector part has length sin(angle / 2).
  let q0 = s.anchorRot;
  let dq = q0.w * b.rot.xyz - b.rot.w * q0.xyz - cross(b.rot.xyz, q0.xyz);
  let moved = length(b.pos - s.anchorPos) + 2.0 * length(dq) * r;
  let speed = length(b.linVel) + length(b.angVel) * r;
  if (speed < p.speed && moved <= p.drift * r) {
    s.quiet = min(s.quiet + 1u, QUIET_MAX);
  } else {
    s.quiet = 0u;
    s.anchorPos = b.pos;
    s.anchorRot = b.rot;
  }
  state[i] = s;
}

@compute @workgroup_size(${PAIR_WG})
fn neighbours(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let m = manifolds[k];
  if (m.count == 0u) { return; }
  let half = p.steps / 2u;
  if (state[m.b].quiet < half) { atomicStore(&veto[m.a], 1u); }
  if (state[m.a].quiet < half) { atomicStore(&veto[m.b], 1u); }
}

@compute @workgroup_size(${WG})
fn decide(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  if (removed(i)) { return; }
  let asleep = state[i].quiet >= p.steps && atomicLoad(&veto[i]) == 0u;
  bodies[i].flags = (bodies[i].flags & ~1u) | select(1u, 0u, asleep);
}
`;

/** Throws on a rule out of range. */
export function checkSleepRule(r: SleepRule): void {
  if (!(Number.isFinite(r.speed) && r.speed >= 0)) throw new Error(`sleepSpeed must be a finite number >= 0, got ${r.speed}`);
  if (!(Number.isInteger(r.steps) && r.steps >= 1 && r.steps <= 0x7fffffff)) throw new Error(`sleepSteps must be an integer >= 1, got ${r.steps}`);
  if (!(Number.isFinite(r.drift) && r.drift >= 0)) throw new Error(`sleepDrift must be a finite number >= 0, got ${r.drift}`);
}

export class SleepPass {
  /** array<SleepBody>, one per body slot. */
  readonly state: GPUBuffer;
  private readonly veto: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly pipes: { quiet: GPUComputePipeline; neighbours: GPUComputePipeline; decide: GPUComputePipeline };
  private readonly bind: GPUBindGroup;

  /**
   * @param bodies, props the engine's Body[] and BodyProps[]
   * @param manifolds, total the narrowphase's manifold per pair slot and the broadphase's counts (total[0..2]: indirect arguments)
   */
  constructor(private readonly device: GPUDevice, readonly rule: SleepRule, capacity: number, bodies: GPUBuffer, props: GPUBuffer, manifolds: GPUBuffer, private readonly total: GPUBuffer) {
    checkSleepRule(rule);
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label }));
    this.state = buf(capacity * SleepBody.size, 'sleep state');
    this.veto = buf(capacity * 4, 'sleep veto');
    this.uniform = device.createBuffer({ size: SleepParams.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sleep params' });
    const types: GPUBufferBindingType[] = ['uniform', 'storage', 'read-only-storage', 'storage', 'storage', 'read-only-storage', 'read-only-storage'];
    const layout = device.createBindGroupLayout({ entries: types.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })) });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: CODE, label: 'sleep' });
    const pipe = (entryPoint: string) => device.createComputePipeline({ label: `sleep ${entryPoint}`, layout: pl, compute: { module, entryPoint } });
    this.pipes = { quiet: pipe('quiet'), neighbours: pipe('neighbours'), decide: pipe('decide') };
    this.bind = device.createBindGroup({ layout, entries: [this.uniform, bodies, props, this.state, this.veto, manifolds, total].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  /** A new body in slot i: not quiet, its window starting at its pose. */
  add(i: number, pos: Vec3, rot: Quat): void {
    const v = new DataView(new ArrayBuffer(SleepBody.size));
    writeStruct(v, SleepBody, 0, { anchorPos: pos, quiet: 0, anchorRot: rot });
    this.device.queue.writeBuffer(this.state, i * SleepBody.size, v.buffer);
  }

  /** Encodes the pass for n bodies, after the step's solve (it reads the final velocities and poses). */
  encode(enc: GPUCommandEncoder, n: number): void {
    if (n === 0) return;
    const v = new DataView(new ArrayBuffer(SleepParams.size));
    writeStruct(v, SleepParams, 0, { n, steps: this.rule.steps, speed: this.rule.speed, drift: this.rule.drift });
    this.device.queue.writeBuffer(this.uniform, 0, v.buffer);
    const pass = enc.beginComputePass({ label: 'sleep' });
    pass.setBindGroup(0, this.bind);
    pass.setPipeline(this.pipes.quiet);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
    pass.setPipeline(this.pipes.neighbours);
    pass.dispatchWorkgroupsIndirect(this.total, 0);
    pass.setPipeline(this.pipes.decide);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
    pass.end();
  }

  destroy(): void {
    for (const b of [this.state, this.veto, this.uniform]) b.destroy();
  }
}
