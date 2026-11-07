// Forces on the GPU (engine-api force.ts): one thread per body under a force
// at a step, in the step's first pass after its blasts and before prepare, so
// the force acts after every other event of the step (spawns, removals and
// blasts are encoded before it) and the inertial target sees the new velocity.
//
// Each thread evaluates F from the body's state as the dispatch runs (after the
// step's blasts, as on the reference), then applies forceKick in f32:
//   linVel += h F / mass, SolverBody.prevVel += the same (as a blast's kick, so
//   the adaptive warm start does not read the force as an acceleration),
// and sets the awake bit. A pinned body (pins.ts) is skipped: it feels no force. A sleeper set awake so is woken with its group by the
// wake pass, as a blasted one is (sleep.ts); and SleepBody.forced keeps the body
// from falling asleep at the end of a step it is forced.
//
// Forces whose value does not depend on the body's state (forceIsWorld: world
// thrusts and vibrations) are evaluated on the host in f64 (forceAt) and go up
// as their world vector; thrusts in body or heading axes and pulls are
// evaluated here in f32 from the body's own state.
//
// The forces go up as u32 words: a header (count, 1 when the sleep state is
// bound, h as f32, pad), then STRIDE words per force: body, kind (0 world
// vector, 1 thrust in body axes, 2 thrust in heading axes, 3 pull), pad, pad;
// the vector (the world force, the thrust in its axes, or the pull's point)
// and pad; stiffness, damping, max (the largest f32 for none), pad.
import { type ActiveForce, type BodyMotion, forceAt, forceIsWorld, HEADING_MIN_SPEED } from '@tb/engine-api';
import { Body, BodyProps, SleepBody, SolverBody, wgslStruct } from '@tb/schema';

const WG = 64;
const HEADER = 4;
const STRIDE = 12;
/** A pull's max of Infinity goes up as the largest f32 (WGSL may assume no infinities). */
const F32_MAX = 3.4028234663852886e38;
/** A world force does not read the body's state (forceIsWorld); forceAt is handed this. */
const NO_STATE: BodyMotion = { pos: [0, 0, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0] };

const CODE = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(BodyProps)}
${wgslStruct(SolverBody)}
${wgslStruct(SleepBody)}
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> props: array<BodyProps>;
@group(0) @binding(2) var<storage, read_write> solverBodies: array<SolverBody>;
@group(0) @binding(3) var<storage, read_write> sleepState: array<SleepBody>;
@group(0) @binding(4) var<storage, read> forces: array<u32>;

fn word(k: u32) -> f32 { return bitcast<f32>(forces[k]); }
// v rotated by unit quaternion q (engine-api rotateByQuat).
fn qrot(q: vec4f, v: vec3f) -> vec3f { let t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }

@compute @workgroup_size(${WG})
fn force(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= forces[0]) { return; }
  let o = ${HEADER}u + id.x * ${STRIDE}u;
  let i = forces[o];
  let kind = forces[o + 1u];
  let v = vec3f(word(o + 4u), word(o + 5u), word(o + 6u));
  let b = bodies[i];
  // A pinned body (Body.flags bit 1, pins.ts) feels no force and is never woken (engine-api pinned.ts).
  if ((b.flags & 2u) != 0u) { return; }
  var F = v;
  if (kind == 1u) {
    F = qrot(b.rot, v);
  } else if (kind == 2u) {
    // spawnAxes 'heading': headingBasis(headingOf(linVel)), as the relative spawn pass (spawn.ts).
    let s = length(b.linVel);
    var a = vec3f(0.0, 1.0, 0.0);
    if (s > ${HEADING_MIN_SPEED}) { a = b.linVel / s; }
    let t = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(a.y) < 0.9);
    let u = cross(a, t);
    let fx = u / length(u);
    F = fx * v.x + a * v.y + cross(fx, a) * v.z;
  } else if (kind == 3u) {
    // A spring to the point and a dashpot, its length capped.
    F = word(o + 8u) * (v - b.pos) - word(o + 9u) * b.linVel;
    let l = length(F);
    let cap = word(o + 10u);
    if (l > cap) { F *= cap / l; }
  }
  let dv = word(2u) * F / props[i].mass;
  bodies[i].linVel = b.linVel + dv;
  bodies[i].flags = b.flags | 1u;
  solverBodies[i].prevVel += dv;
  if (forces[1] == 1u) { sleepState[i].forced = 1u; }
}`;

export class ForcePass {
  private readonly pipe: GPUComputePipeline;
  private buf: GPUBuffer | null = null;
  private bind: GPUBindGroup | null = null;
  private room = 0;
  private readonly sleepState: GPUBuffer;
  private readonly dummy: GPUBuffer | null;

  constructor(private readonly device: GPUDevice, private readonly bodies: GPUBuffer, private readonly props: GPUBuffer, private readonly solverBodies: GPUBuffer, sleepState: GPUBuffer | null) {
    this.pipe = device.createComputePipeline({ label: 'force', layout: 'auto', compute: { module: device.createShaderModule({ code: CODE, label: 'force' }), entryPoint: 'force' } });
    // Without sleep a stand-in of one SleepBody is bound (the header's flag keeps the kernel off it).
    this.dummy = sleepState ? null : device.createBuffer({ size: SleepBody.size, usage: GPUBufferUsage.STORAGE, label: 'force: no sleep state' });
    this.sleepState = sleepState ?? this.dummy!;
  }

  /**
   * Writes the forces acting at `step` (ForceTable.act, at most MAX_FORCED) and encodes their dispatch, with
   * step h (nothing when there are none). World forces are evaluated here (forceAt; the state is not read).
   */
  encode(pass: GPUComputePassEncoder, active: readonly ActiveForce[], step: number, h: number): void {
    if (!active.length) return;
    if (active.length > this.room) this.grow(active.length);
    const words = new Uint32Array(HEADER + STRIDE * active.length), f = new Float32Array(words.buffer);
    words[0] = active.length;
    words[1] = this.dummy ? 0 : 1;
    f[2] = h;
    active.forEach(({ id, force: c, start }, k) => {
      const o = HEADER + k * STRIDE;
      words[o] = id;
      if (forceIsWorld(c)) {
        words[o + 1] = 0;
        f.set(forceAt(c, step - start, h, NO_STATE), o + 4);
      } else if (c.kind === 'thrust') {
        words[o + 1] = c.axes === 'body' ? 1 : 2;
        f.set(c.thrust, o + 4);
      } else if (c.kind === 'pull') {
        words[o + 1] = 3;
        f.set(c.pull, o + 4);
        f[o + 8] = c.stiffness; f[o + 9] = c.damping; f[o + 10] = Math.min(c.max, F32_MAX);
      }
    });
    this.device.queue.writeBuffer(this.buf!, 0, words);
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bind!);
    pass.dispatchWorkgroups(Math.ceil(active.length / WG));
  }

  private grow(forces: number): void {
    this.buf?.destroy();
    this.room = Math.max(forces, 2 * this.room, 8);
    this.buf = this.device.createBuffer({ size: 4 * (HEADER + STRIDE * this.room), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'forces' });
    this.bind = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [this.bodies, this.props, this.solverBodies, this.sleepState, this.buf].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  destroy(): void {
    this.buf?.destroy();
    this.buf = null;
    this.dummy?.destroy();
  }
}
