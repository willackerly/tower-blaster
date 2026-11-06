// Blasts on the GPU: engine-api blast.ts's blastKick() in f32, one dispatch
// over the bodies for every blast due at a step, before the step's prepare
// pass (so the sweep and the inertial target see the new velocity).
//
// The blasts of a step go up as one array of u32 words: a header (number of
// blasts, the largest body count among them), then STRIDE words per blast in
// event order. Each thread takes one body and applies the blasts in that
// order, so the result does not depend on scheduling. A blast only pushes
// bodies below its own count (the bodies that existed when it was due), as
// on the reference, and adds the kick to SolverBody.prevVel too (the adaptive
// warm start's previous velocity), as the reference does to prevLinVel. A
// body centre is read from Body.pos when the dispatch runs (blasts change
// velocities only, so every thread reads the same position). The arithmetic
// is the reference's (blastCentre, blastArea, blastWeight, blastVelocity) in
// f32; the speed cap is applied after each blast, as there. A pinned body
// (engine-api pinned.ts) is never pushed and never woken.
//
// The same records carry the field events' work (engine-api field.ts), in
// event order with the blasts: a kick record adds its dv to every body below
// its count (not removed, not pinned) and wakes it; a wake record wakes the
// same bodies without pushing them (a change of gravity under sleep).
import { type CheckedBlast, MAX_BLAST_EXCLUDE, type Vec3 } from '@tb/engine-api';
import { Body, BodyProps, Shape, SolverBody, TIER, wgslStruct } from '@tb/schema';

const WG = 64;
const HEADER = 4;
/**
 * point or offset (3), radius, impulse, falloff (u32), maxDv, count, nExclude, exclude (MAX_BLAST_EXCLUDE), core, centre
 * body (NO_BODY: a point), maxSpeed, kind (KIND_*). A kick record holds its dv in words 0-2 and its count in 7; a wake
 * record only its count.
 */
const STRIDE = 21;
const KIND_BLAST = 0, KIND_KICK = 1, KIND_WAKE = 2;
const NO_BODY = 0xffffffff;
/** maxSpeed Infinity goes up as the largest f32 (WGSL may assume no infinities). */
const F32_MAX = 3.4028234663852886e38;

const CODE = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(BodyProps)}
${wgslStruct(Shape)}
${wgslStruct(SolverBody)}
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> props: array<BodyProps>;
@group(0) @binding(2) var<storage, read> shapes: array<Shape>;
@group(0) @binding(3) var<storage, read> blasts: array<u32>;
@group(0) @binding(4) var<storage, read_write> solverBodies: array<SolverBody>;

fn word(k: u32) -> f32 { return bitcast<f32>(blasts[k]); }

@compute @workgroup_size(${WG})
fn blast(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= blasts[1]) { return; }
  let b = bodies[i];
  // A removed body (tier free, engine-api remove.ts) is never pushed, nor a pinned one (bit 1, pins.ts): it is not
  // woken either, so it stays an anchor.
  if (((b.flags >> 8u) & 0xffu) == ${TIER.free}u || (b.flags & 2u) != 0u) { return; }
  let s = shapes[b.shape];
  let h = s.half;
  // blastArea: a quarter of the surface.
  let area = select(2.0 * (h.x * h.y + h.y * h.z + h.z * h.x), 3.14159265358979 * h.x * h.x, s.kind == 1u);
  let areaPerMass = area / props[i].mass;
  var v = b.linVel;
  var pushed = false;
  for (var k = 0u; k < blasts[0]; k++) {
    let o = ${HEADER}u + k * ${STRIDE}u;
    if (i >= blasts[o + 7u]) { continue; }
    let kind = blasts[o + 20u];
    // A field kick: the same dv for every body (engine-api field.ts), no cap.
    if (kind == ${KIND_KICK}u) { v += vec3f(word(o), word(o + 1u), word(o + 2u)); pushed = true; continue; }
    // A wake: no push.
    if (kind == ${KIND_WAKE}u) { pushed = true; continue; }
    var excluded = false;
    for (var e = 0u; e < blasts[o + 8u]; e++) { if (blasts[o + 9u + e] == i) { excluded = true; } }
    if (excluded) { continue; }
    // blastCentre: the point, or the centre body's position plus the offset.
    var c = vec3f(word(o), word(o + 1u), word(o + 2u));
    if (blasts[o + 18u] != 4294967295u) { c += bodies[blasts[o + 18u]].pos; }
    let r = b.pos - c;
    let d = length(r);
    let radius = word(o + 3u);
    if (!(d < radius)) { continue; }
    // blastWeight: 1 inside the core, then an integer power of the rest.
    let r0 = word(o + 17u) * radius;
    var w = 1.0;
    if (d > r0) {
      let t = (radius - d) / (radius - r0);
      for (var e = 0u; e < blasts[o + 5u]; e++) { w *= t; }
    }
    let dv = min(word(o + 6u), word(o + 4u) * w * areaPerMass);
    // blastVelocity: the kick, then the speed cap.
    var u = v + select(vec3f(0.0, 1.0, 0.0), r / d, d > 0.0) * dv;
    let speed = length(u);
    let cap = word(o + 19u);
    if (speed > cap) { u *= cap / speed; }
    v = u;
    pushed = true;
  }
  if (!pushed) { return; }
  bodies[i].linVel = v;
  // A pushed sleeper wakes (sleep.ts; awake already without sleep, so off this writes what was there).
  bodies[i].flags = b.flags | 1u;
  solverBodies[i].prevVel += v - b.linVel;
}`;

/**
 * What the pass applies at a step, in event order, each to the bodies below its count: a checked blast (checkBlast), a
 * field kick (engine-api field.ts: dv for every moving body), or a wake of every moving body (a change of gravity).
 */
export type DueBlast = { blast: CheckedBlast; count: number } | { kick: Vec3; count: number } | { wake: true; count: number };

export class BlastPass {
  private readonly pipe: GPUComputePipeline;
  private buf: GPUBuffer | null = null;
  private bind: GPUBindGroup | null = null;
  private room = 0;

  constructor(private readonly device: GPUDevice, private readonly bodies: GPUBuffer, private readonly props: GPUBuffer, private readonly shapes: GPUBuffer, private readonly solverBodies: GPUBuffer) {
    this.pipe = device.createComputePipeline({ label: 'blast', layout: 'auto', compute: { module: device.createShaderModule({ code: CODE, label: 'blast' }), entryPoint: 'blast' } });
  }

  /** Writes this step's blasts and encodes their dispatch (nothing when there are none). */
  encode(pass: GPUComputePassEncoder, due: readonly DueBlast[]): void {
    if (!due.length) return;
    if (due.length > this.room) this.grow(due.length);
    const words = new Uint32Array(HEADER + STRIDE * due.length), f = new Float32Array(words.buffer);
    let n = 0;
    due.forEach((d, k) => {
      const o = HEADER + k * STRIDE, count = d.count;
      n = Math.max(n, count);
      words[o + 7] = count;
      if ('kick' in d) { f.set(d.kick, o); words[o + 20] = KIND_KICK; return; }
      if ('wake' in d) { words[o + 20] = KIND_WAKE; return; }
      const b = d.blast;
      words[o + 20] = KIND_BLAST;
      f.set(b.point ?? b.offset, o);
      f[o + 3] = b.radius; f[o + 4] = b.impulse; words[o + 5] = b.falloff; f[o + 6] = b.maxDv;
      words[o + 7] = count; words[o + 8] = b.exclude.length;
      words.set(b.exclude.slice(0, MAX_BLAST_EXCLUDE), o + 9);
      f[o + 17] = b.core;
      words[o + 18] = b.point ? NO_BODY : b.body;
      f[o + 19] = Math.min(b.maxSpeed, F32_MAX);
    });
    words[0] = due.length; words[1] = n;
    if (n === 0) return;
    this.device.queue.writeBuffer(this.buf!, 0, words);
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bind!);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
  }

  private grow(blasts: number): void {
    this.buf?.destroy();
    this.room = Math.max(blasts, 2 * this.room, 4);
    this.buf = this.device.createBuffer({ size: 4 * (HEADER + STRIDE * this.room), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'blasts' });
    this.bind = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [this.bodies, this.props, this.shapes, this.buf, this.solverBodies].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  destroy(): void {
    this.buf?.destroy();
    this.buf = null;
  }
}
