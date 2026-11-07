// Relative spawns on the GPU (engine-api spawn.ts): one thread per spawn due at
// a step that names a parent, in a pass before anything else of the step. The
// host has already written the child's slot as for any spawn (shape, props, the
// Body with the description's pos, rot and velocities, which are relative);
// this kernel reads the parent's Body as the step starts and writes the child's
// world pose and motion over it (relativeBody in f32), and the two other copies
// a spawn seeds from its description: SolverBody.prevVel (the adaptive warm
// start's previous velocity, = the initial velocity) and, with sleep, the quiet
// window's anchor pose.
//
// "As the step starts": nothing earlier in the step's command buffer writes a
// parent's slot. A parent cannot be spawned at the same step (checkInputQueue);
// blasts run in the next pass; and the engine writes removals as copies in the
// command buffer after this pass, not as queue writes (which would land before
// any of the step's work), so a shell that splits and is removed at one step
// hands its children its motion, not the tombstone's zeros.
//
// The spawns go up as u32 words: a header (spawn count, 1 when the sleep state
// is bound), then STRIDE words per spawn: child, parent, axes (0 world, 1 body,
// 2 heading), pad; pos (3) and pad; rot (4); linVel (3) and pad; angVel (3)
// and pad.
import { HEADING_MIN_SPEED, type SpawnAxes, SPAWN_AXES, type Vec3, type Quat } from '@tb/engine-api';
import { Body, SleepBody, SolverBody, wgslStruct } from '@tb/schema';

const WG = 64;
const HEADER = 4;
const STRIDE = 20;

const CODE = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(SolverBody)}
${wgslStruct(SleepBody)}
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read_write> solverBodies: array<SolverBody>;
@group(0) @binding(2) var<storage, read_write> sleepState: array<SleepBody>;
@group(0) @binding(3) var<storage, read> spawns: array<u32>;

fn word(k: u32) -> f32 { return bitcast<f32>(spawns[k]); }
fn vec3At(k: u32) -> vec3f { return vec3f(word(k), word(k + 1u), word(k + 2u)); }
// v rotated by unit quaternion q (engine-api rotateByQuat).
fn qrot(q: vec4f, v: vec3f) -> vec3f { let t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
// a b (engine-api quatProduct).
fn qmul(a: vec4f, b: vec4f) -> vec4f { return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }

@compute @workgroup_size(${WG})
fn relspawn(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= spawns[0]) { return; }
  let o = ${HEADER}u + id.x * ${STRIDE}u;
  let child = spawns[o];
  let p = bodies[spawns[o + 1u]];
  let axes = spawns[o + 2u];
  // spawnAxes: the images of local x, y, z.
  var fx = vec3f(1.0, 0.0, 0.0);
  var fy = vec3f(0.0, 1.0, 0.0);
  var fz = vec3f(0.0, 0.0, 1.0);
  if (axes == 1u) {
    fx = qrot(p.rot, fx); fy = qrot(p.rot, fy); fz = qrot(p.rot, fz);
  } else if (axes == 2u) {
    // headingBasis(headingOf(v)).
    let s = length(p.linVel);
    var a = vec3f(0.0, 1.0, 0.0);
    if (s > ${HEADING_MIN_SPEED}) { a = p.linVel / s; }
    let t = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(a.y) < 0.9);
    let u = cross(a, t);
    fx = u / length(u); fy = a; fz = cross(fx, a);
  }
  let lp = vec3At(o + 4u);
  let lr = vec4f(word(o + 8u), word(o + 9u), word(o + 10u), word(o + 11u));
  let lv = vec3At(o + 12u);
  let lw = vec3At(o + 16u);
  let r = fx * lp.x + fy * lp.y + fz * lp.z;
  let pos = p.pos + r;
  let rot = select(lr, qmul(p.rot, lr), axes == 1u);
  let linVel = p.linVel + cross(p.angVel, r) + fx * lv.x + fy * lv.y + fz * lv.z;
  bodies[child].pos = pos;
  bodies[child].rot = rot;
  bodies[child].linVel = linVel;
  bodies[child].angVel = p.angVel + fx * lw.x + fy * lw.y + fz * lw.z;
  solverBodies[child].prevVel = linVel;
  if (spawns[1] == 1u) {
    sleepState[child].anchorPos = pos;
    sleepState[child].anchorRot = rot;
  }
}`;

/** A relative spawn due this step: the child's slot, its parent and its description in the parent's frame. */
export interface DueSpawn { child: number; parent: number; axes: SpawnAxes; pos: Vec3; rot: Quat; linVel: Vec3; angVel: Vec3 }

export class RelativeSpawnPass {
  private readonly pipe: GPUComputePipeline;
  private buf: GPUBuffer | null = null;
  private bind: GPUBindGroup | null = null;
  private room = 0;
  private readonly sleepState: GPUBuffer;
  private readonly dummy: GPUBuffer | null;

  constructor(private readonly device: GPUDevice, private readonly bodies: GPUBuffer, private readonly solverBodies: GPUBuffer, sleepState: GPUBuffer | null) {
    this.pipe = device.createComputePipeline({ label: 'relative spawn', layout: 'auto', compute: { module: device.createShaderModule({ code: CODE, label: 'relative spawn' }), entryPoint: 'relspawn' } });
    // Without sleep a stand-in of one SleepBody is bound (the header's flag keeps the kernel off it).
    this.dummy = sleepState ? null : device.createBuffer({ size: SleepBody.size, usage: GPUBufferUsage.STORAGE, label: 'relative spawn: no sleep state' });
    this.sleepState = sleepState ?? this.dummy!;
  }

  /** Writes this step's relative spawns and encodes their dispatch (nothing when there are none). */
  encode(pass: GPUComputePassEncoder, due: readonly DueSpawn[]): void {
    if (!due.length) return;
    if (due.length > this.room) this.grow(due.length);
    const words = new Uint32Array(HEADER + STRIDE * due.length), f = new Float32Array(words.buffer);
    words[0] = due.length;
    words[1] = this.dummy ? 0 : 1;
    due.forEach((s, k) => {
      const o = HEADER + k * STRIDE;
      words[o] = s.child; words[o + 1] = s.parent; words[o + 2] = SPAWN_AXES.indexOf(s.axes);
      f.set(s.pos, o + 4); f.set(s.rot, o + 8); f.set(s.linVel, o + 12); f.set(s.angVel, o + 16);
    });
    this.device.queue.writeBuffer(this.buf!, 0, words);
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bind!);
    pass.dispatchWorkgroups(Math.ceil(due.length / WG));
  }

  private grow(spawns: number): void {
    this.buf?.destroy();
    this.room = Math.max(spawns, 2 * this.room, 8);
    this.buf = this.device.createBuffer({ size: 4 * (HEADER + STRIDE * this.room), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'relative spawns' });
    this.bind = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [this.bodies, this.solverBodies, this.sleepState, this.buf].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  destroy(): void {
    this.buf?.destroy();
    this.buf = null;
    this.dummy?.destroy();
  }
}
