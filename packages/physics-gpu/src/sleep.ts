// Per-body sleep on the GPU (roadmap E2; the E1 design doc's design C, "per-body sleep with wake fronts").
//
// A sleeper is an anchor (solver.ts, SLEEPING): its pose is fixed and its velocity 0, the colouring gives it no
// colour (coloring.ts, SLEEPER_COLOR), so the primal never visits it, and an awake body touching it solves against
// its fixed pose as against an infinite mass. Contacts between sleepers, and a sleeper's ground contact, are frozen:
// setup copies last step's state forward and the dual leaves it, so a woken body starts from the loads it slept with.
//
// Two passes a step, each one compute pass of a few dispatches:
//
// wake (after the narrowphase, before the colouring), on this step's contacts:
//   init        per body: union-find parent and wake mark reset.
//   hook        per pair slot with points: two members are joined (lock-free union-find, larger root under smaller,
//               as the island probe P6 in probe-sleep.ts). A member is a sleeper, or a body that slept last step and
//               was woken since by a blast (blast.ts sets the awake bit of every body it pushes).
//   compress    per body: its root.
//   rules       per pair slot with points between a sleeper and an awake body: the sleeper's group is marked to wake
//               when the awake body moves faster than wakeSpeed (|v| + |w| r: an impact, or anything still moving
//               into it) or the contact is deeper than wakeDepth (something pressed in without speed, e.g. spawned
//               overlapping).
//   blasted     per body woken by a blast: its group is marked.
//   apply       per body: a sleeper whose group is marked wakes (awake bit set); every body woken this step (here
//               or by a blast) gets quiet 0, a new window at its pose and wakes + 1; seed[i] tells the colouring
//               who sleeps.
// A group is every sleeper joined to another through contacts (the ground joins nothing), so one wake wakes the
// whole sleeping stack, tower or pile it belongs to. That is wider than the design's support closure, and safe:
// a column whose bottom is removed starts falling at the top on the same step.
// A removed body (engine-api remove.ts) wakes everything that could touch it: the engine adds a blast of no impulse
// around it, which pushes nothing but wakes every body in reach, and so their groups. (A rule that woke a sleeper on
// losing a contact was tried first: in a packed city the edge and corner contacts between cubes come and go by
// micrometres as bodies settle, so it woke whole towers at random.)
//
// sleep (after the solve):
//   quiet       per body: quiet this step when |v| + |w| r < speed (v_sleep) and it has moved no more than drift x r
//               since its window began (the centre's motion plus the chord a point at radius r sweeps,
//               2 r sin(angle / 2)); quiet + 1, or 0 and a new window at its pose. Clears the veto.
//   neighbours  per pair slot with points: a body whose partner has been quiet for fewer than steps / 2 is vetoed,
//               which keeps a one-body band of awake bodies next to anything still moving.
//   decide      per awake body: it falls asleep (awake bit 0, velocities 0) when it is not under a force this step
//               (SleepBody.forced, set by the force pass, force.ts) and quiet >= steps << min(wakes, 4)
//               (the backoff: each wake doubles the wait, up to 16x, so a body cannot flicker) and nothing vetoed it.
//               A sleeper stays asleep until the wake pass wakes it. Every body still awake adds 1 to the awake
//               count (the scratch buffer's last word), which the engine reads back: a step that starts with no
//               body awake and no input due changes nothing, so the engine skips it (GpuEngineOptions.sleepSkip).
// A sleeper's own state does not change from step to step (quiet skips it: its counter stays where it fell asleep,
// at least T, which is all the neighbour veto asks of it), so a skipped step and a run step leave the same state.
//
// r is BodyProps.radius, the bounding radius. Removed bodies (tier free) are neither: their flags stay as remove()
// wrote them, and the colouring treats them as before. Thresholds are in scene units (cube units, plank widths for
// S15), so they move with the scene's own scale.
import { type StateRegion, whole } from './checkpoint.ts';
import { Body, BodyProps, Manifold, SleepBody, SleepParams, TIER, wgslStruct, writeStruct } from '@tb/schema';
import { assertStorageFits } from '@tb/gpu';
import type { Quat, Vec3 } from '@tb/engine-api';
import { SLEEPER_COLOR } from './coloring.ts';

const WG = 64;
/** The pair kernels' indirect arguments (Broadphase.total[0..2]) are counted in workgroups of this many threads. */
const PAIR_WG = 64;
/** A woken body needs steps << min(wakes, MAX_BACKOFF) quiet steps to sleep again. */
export const MAX_BACKOFF = 4;

/** The sleep rule's thresholds (GpuEngineOptions.sleepSpeed, sleepSteps, sleepDrift, wakeSpeed, wakeDepth). */
export interface SleepRule {
  /** v_sleep, scene units/s: |v| + |w| r must stay below it. */
  speed: number;
  /** T, steps: how long a body must stay quiet (doubled after each wake, up to 2^MAX_BACKOFF times). */
  steps: number;
  /** How far a body may move over its quiet window, as a fraction of its bounding radius. */
  drift: number;
  /** An awake body touching a sleeper wakes it when |v| + |w| r exceeds this, scene units/s. */
  wakeSpeed: number;
  /** A contact between an awake body and a sleeper wakes it when one of its points is this deep, scene units. */
  wakeDepth: number;
}

/**
 * The defaults: the E1 time-to-quiet study's rule (0.05 units/s for 30 steps, 0.5 s at 60 Hz; thresholds of 0.02
 * and 0.1 gave the same picture there) and the CPU tier's 2% displacement window. A body wakes its neighbours at twice
 * v_sleep, so the quiet band next to the sleepers does not; and at a centimetre of depth, several times a loaded
 * contact's resting depth (AvbdParams.restDepth, 3 mm).
 */
export const DEFAULT_SLEEP: SleepRule = { speed: 0.05, steps: 30, drift: 0.02, wakeSpeed: 0.1, wakeDepth: 0.01 };

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
// Per-body words, n each: the veto, the union-find parent, the group's wake mark; the last word is the awake count.
@group(0) @binding(4) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(6) var<storage, read> total: array<u32>;
// The colouring's seed (Coloring.encode): ${SLEEPER_COLOR} for a sleeper, 0xffffffff for the rest.
@group(0) @binding(7) var<storage, read_write> seed: array<u32>;

const QUIET_MAX = 0x7fffffffu;
const WAKES_MAX = 0xffffu;
// Bounded walks: a root is reached in far fewer steps; the bound only keeps a bug from hanging the GPU.
const BOUND = 1048576u;

fn veto(i: u32) -> u32 { return i; }
fn parent(i: u32) -> u32 { return p.n + i; }
fn mark(i: u32) -> u32 { return 2u * p.n + i; }
fn awakeCount() -> u32 { return arrayLength(&scratch) - 1u; }

fn removed(i: u32) -> bool { return ((bodies[i].flags >> 8u) & 0xffu) == ${TIER.free}u; }
fn asleep(i: u32) -> bool { return (bodies[i].flags & 1u) == 0u && !removed(i); }
// Asleep, or asleep at the end of last step and woken since by a blast.
fn member(i: u32) -> bool { return !removed(i) && ((bodies[i].flags & 1u) == 0u || state[i].slept != 0u); }
fn speedOf(i: u32) -> f32 { let b = bodies[i]; return length(b.linVel) + length(b.angVel) * props[i].radius; }

fn find(x0: u32) -> u32 {
  var x = x0;
  for (var k = 0u; k < BOUND; k++) {
    let q = atomicLoad(&scratch[parent(x)]);
    if (q == x) { return x; }
    let g = atomicLoad(&scratch[parent(q)]);
    // Path halving: x skips to its grandparent (still in its set, so any interleaving is safe).
    if (g != q) { _ = atomicCompareExchangeWeak(&scratch[parent(x)], q, g); }
    x = g;
  }
  return x;
}

// ---- wake: after the narrowphase ----

fn deepest(m: Manifold) -> f32 {
  var d = m.p0.w;
  if (m.count > 1u) { d = max(d, m.p1.w); }
  if (m.count > 2u) { d = max(d, m.p2.w); }
  if (m.count > 3u) { d = max(d, m.p3.w); }
  return d;
}


@compute @workgroup_size(${WG})
fn wakeInit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  atomicStore(&scratch[parent(i)], i);
  atomicStore(&scratch[mark(i)], 0u);
}

@compute @workgroup_size(${PAIR_WG})
fn wakeHook(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let m = manifolds[k];
  if (m.count == 0u) { return; }
  if (!(member(m.a) && member(m.b))) { return; }
  var a = find(m.a);
  var b = find(m.b);
  for (var t = 0u; t < BOUND; t++) {
    if (a == b) { return; }
    let hi = max(a, b);
    let lo = min(a, b);
    if (atomicCompareExchangeWeak(&scratch[parent(hi)], hi, lo).exchanged) { return; }
    a = find(hi);
    b = find(lo);
  }
}

@compute @workgroup_size(${WG})
fn wakeCompress(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  atomicStore(&scratch[parent(i)], find(i));
}

@compute @workgroup_size(${PAIR_WG})
fn wakeRules(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= total[3]) { return; }
  let m = manifolds[k];
  if (m.count == 0u) { return; }
  let sa = asleep(m.a);
  let sb = asleep(m.b);
  if (sa == sb) { return; }
  let s = select(m.b, m.a, sa);
  let w = select(m.a, m.b, sa);
  if (removed(w)) { return; }
  if (speedOf(w) > p.wakeSpeed || deepest(m) > p.wakeDepth) {
    atomicStore(&scratch[mark(atomicLoad(&scratch[parent(s)]))], 1u);
  }
}

@compute @workgroup_size(${WG})
fn wakeBlasted(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  if (member(i) && !asleep(i)) { atomicStore(&scratch[mark(atomicLoad(&scratch[parent(i)]))], 1u); }
}

@compute @workgroup_size(${WG})
fn wakeApply(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  var sleeps = asleep(i);
  let b = bodies[i];
  if (sleeps && atomicLoad(&scratch[mark(atomicLoad(&scratch[parent(i)]))]) != 0u) {
    bodies[i].flags = b.flags | 1u;
    sleeps = false;
  }
  var s = state[i];
  // Woken now, or by a blast before this pass (blast.ts sets the awake bit): a new quiet window, and the backoff.
  if (s.slept != 0u && !sleeps) {
    s.quiet = 0u;
    s.anchorPos = b.pos;
    s.anchorRot = b.rot;
    s.wakes = min(s.wakes + 1u, WAKES_MAX);
  }
  s.slept = select(0u, 1u, sleeps);
  state[i] = s;
  seed[i] = select(0xffffffffu, ${SLEEPER_COLOR}u, sleeps);
}

// ---- sleep: after the solve ----

@compute @workgroup_size(${WG})
fn quiet(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  atomicStore(&scratch[veto(i)], 0u);
  if (removed(i) || asleep(i)) { return; }
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
  if (state[m.b].quiet < half) { atomicStore(&scratch[veto(m.a)], 1u); }
  if (state[m.a].quiet < half) { atomicStore(&scratch[veto(m.b)], 1u); }
}

@compute @workgroup_size(${WG})
fn decide(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.n) { return; }
  if (removed(i) || asleep(i)) { return; }
  let s = state[i];
  let need = p.steps << min(s.wakes, ${MAX_BACKOFF}u);
  // A body under a force (force.ts set forced this step) stays awake; the flag is for this step only.
  if (s.forced != 0u) { state[i].forced = 0u; }
  if (s.forced == 0u && s.quiet >= need && atomicLoad(&scratch[veto(i)]) == 0u) {
    bodies[i].flags = bodies[i].flags & ~1u;
    bodies[i].linVel = vec3f(0.0);
    bodies[i].angVel = vec3f(0.0);
    state[i].slept = 1u;
    return;
  }
  atomicAdd(&scratch[awakeCount()], 1u);
}
`;

/** Throws on a rule out of range. */
export function checkSleepRule(r: SleepRule): void {
  const nonNegative = (k: 'speed' | 'drift' | 'wakeSpeed' | 'wakeDepth', name: string) => {
    if (!(Number.isFinite(r[k]) && r[k] >= 0)) throw new Error(`${name} must be a finite number >= 0, got ${r[k]}`);
  };
  nonNegative('speed', 'sleepSpeed');
  // T << MAX_BACKOFF must fit the quiet counter (QUIET_MAX).
  if (!(Number.isInteger(r.steps) && r.steps >= 1 && r.steps <= 0x7fffffff >> MAX_BACKOFF)) throw new Error(`sleepSteps must be an integer >= 1, got ${r.steps}`);
  nonNegative('drift', 'sleepDrift');
  nonNegative('wakeSpeed', 'wakeSpeed');
  nonNegative('wakeDepth', 'wakeDepth');
}

export class SleepPass {
  /** array<SleepBody>, one per body slot. */
  readonly state: GPUBuffer;
  /** u32 per body: the colouring's seed (Coloring.encode), written by the wake pass. */
  readonly seed: GPUBuffer;
  /** The veto, union-find and wake-mark words (3 per body slot), then the awake count after the last sleep pass (u32 at countOffset). */
  readonly scratch: GPUBuffer;
  readonly countOffset: number;
  private readonly uniform: GPUBuffer;
  private readonly pipes: Record<'wakeInit' | 'wakeHook' | 'wakeCompress' | 'wakeRules' | 'wakeBlasted' | 'wakeApply' | 'quiet' | 'neighbours' | 'decide', GPUComputePipeline>;
  private readonly bind: GPUBindGroup;

  /**
   * @param bodies, props the engine's Body[] and BodyProps[]
   * @param manifolds, total the narrowphase's manifold per pair slot and the broadphase's counts (total[0..2]: indirect arguments)
   */
  constructor(private readonly device: GPUDevice, readonly rule: SleepRule, capacity: number, bodies: GPUBuffer, props: GPUBuffer, manifolds: GPUBuffer, private readonly total: GPUBuffer) {
    checkSleepRule(rule);
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label }));
    this.state = buf(capacity * SleepBody.size, 'sleep state');
    this.seed = buf(capacity * 4, 'sleep colour seed');
    // Exactly 3 words a slot and the count (no rounding up: the count is the last word, arrayLength - 1).
    this.countOffset = 3 * capacity * 4;
    this.scratch = buf(this.countOffset + 4, 'sleep scratch');
    this.uniform = device.createBuffer({ size: SleepParams.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sleep params' });
    const types: GPUBufferBindingType[] = ['uniform', 'storage', 'read-only-storage', 'storage', 'storage', 'read-only-storage', 'read-only-storage', 'storage'];
    const layout = device.createBindGroupLayout({ entries: types.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })) });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: CODE, label: 'sleep' });
    const pipe = (entryPoint: string) => device.createComputePipeline({ label: `sleep ${entryPoint}`, layout: pl, compute: { module, entryPoint } });
    this.pipes = {
      wakeInit: pipe('wakeInit'), wakeHook: pipe('wakeHook'), wakeCompress: pipe('wakeCompress'), wakeRules: pipe('wakeRules'), wakeBlasted: pipe('wakeBlasted'), wakeApply: pipe('wakeApply'),
      quiet: pipe('quiet'), neighbours: pipe('neighbours'), decide: pipe('decide'),
    };
    this.bind = device.createBindGroup({ layout, entries: [this.uniform, bodies, props, this.state, this.scratch, manifolds, total, this.seed].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  /** A new body in slot i: awake, not quiet, never woken, its window starting at its pose. */
  add(i: number, pos: Vec3, rot: Quat): void {
    const v = new DataView(new ArrayBuffer(SleepBody.size));
    writeStruct(v, SleepBody, 0, { anchorPos: pos, quiet: 0, anchorRot: rot, wakes: 0, slept: 0, forced: 0 });
    this.device.queue.writeBuffer(this.state, i * SleepBody.size, v.buffer);
  }

  /** This step's uniforms; call once per step, before encodeWake(). */
  writeParams(n: number): void {
    const v = new DataView(new ArrayBuffer(SleepParams.size));
    const r = this.rule;
    writeStruct(v, SleepParams, 0, { n, steps: r.steps, speed: r.speed, drift: r.drift, wakeSpeed: r.wakeSpeed, wakeDepth: r.wakeDepth });
    this.device.queue.writeBuffer(this.uniform, 0, v.buffer);
  }

  /** The wake pass, after the narrowphase and before the colouring (which reads seed). */
  encodeWake(enc: GPUCommandEncoder, n: number): void {
    if (n === 0) return;
    const groups = Math.ceil(n / WG);
    const pass = enc.beginComputePass({ label: 'sleep: wake' });
    pass.setBindGroup(0, this.bind);
    pass.setPipeline(this.pipes.wakeInit); pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.pipes.wakeHook); pass.dispatchWorkgroupsIndirect(this.total, 0);
    pass.setPipeline(this.pipes.wakeCompress); pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.pipes.wakeRules); pass.dispatchWorkgroupsIndirect(this.total, 0);
    pass.setPipeline(this.pipes.wakeBlasted); pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.pipes.wakeApply); pass.dispatchWorkgroups(groups);
    pass.end();
  }

  /** The sleep pass, after the step's solve (it reads the final velocities and poses); it leaves the awake count at countOffset. */
  encodeSleep(enc: GPUCommandEncoder, n: number): void {
    enc.clearBuffer(this.scratch, this.countOffset, 4);
    if (n === 0) return;
    const groups = Math.ceil(n / WG);
    const pass = enc.beginComputePass({ label: 'sleep: sleep' });
    pass.setBindGroup(0, this.bind);
    pass.setPipeline(this.pipes.quiet); pass.dispatchWorkgroups(groups);
    pass.setPipeline(this.pipes.neighbours); pass.dispatchWorkgroupsIndirect(this.total, 0);
    pass.setPipeline(this.pipes.decide); pass.dispatchWorkgroups(groups);
    pass.end();
  }

  /** What a step reads as the step before left it (checkpoint.ts): each body's sleep state (quiet counter, anchor pose, wakes). */
  carried(): StateRegion[] {
    return [whole(this.state)];
  }

  destroy(): void {
    for (const b of [this.state, this.seed, this.scratch, this.uniform]) b.destroy();
  }
}
