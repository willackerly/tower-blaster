// The blast-reach zone (the bomb visuals, step 3): while the player aims a
// blast weapon, a red danger zone shows how far the blast will reach from
// where the shot lands. Renderer.reach(centre, radius) shows it,
// Renderer.reach(null) hides it.
//
// What is drawn, all from one sphere imposter of the blast radius:
//   - a level disc through the landing point: a faint red fill, a solid red
//     edge exactly at the radius with a thin dark stroke outside it (so it
//     holds on light ground), a target reticle at the centre and a ripple that
//     runs out to the edge once a second (the blast travelling there);
//   - the upper half of the sphere's limb, faint, so the zone reads as a dome
//     (a volume) rather than a flat decal.
// Each pixel ray is intersected analytically with the disc's plane and the
// sphere, and the fragment writes the depth of what it shows, so blocks in
// front hide the zone. A second draw of the same quad with depth compare
// `greater` shows the hidden part at XRAY of the coverage and XRAY² of the
// glow: the whole circle is always readable, even where it passes through a
// wall or behind a tower, without hiding what is in front.
// The disc is lifted by max(1 cm per metre of radius, 2 cm) so a blast
// aimed at the floor does not depth-fight the floor.
//
// The same shader draws the impact marker (PT14: every aimed shot, not only a bomb, shows where it will
// hit): Renderer.impact(point, normal, radius) is a second zone whose disc lies on the face the arc meets
// (its plane through the point, square to the face's normal), in the aim beads' coral, with no dome and no
// ripple, so it reads as a reticle stamped on that face. A zone with the default normal (up), red tint,
// dome and ripple is the blast zone exactly as before.
//
// Cost: nothing while not aiming (no draw; nothing compiled before the
// first aim); while aiming, two quads over the sphere's silhouette with an
// arithmetic-only fragment.
//
// Alternatives considered: a ring of overlay beads (the first version)
// read as string lights, and its far half vanished behind any wall; a
// projected decal on the scene's surfaces needs the scene depth, which is
// 4x MSAA and never stored; a disc mesh depth-fights the floor and needs
// clipping to the sphere anyway; a stencil volume needs a stencil aspect the
// depth24plus target lacks; a filled translucent sphere hides the level it
// is meant to explain.
import { HDR_FORMAT } from './post.ts';
import type { Mat4, V3 } from './math.ts';

const SAMPLES = 4;
const UNIFORM_FLOATS = 48;
/** Strength of the part of the zone hidden behind geometry. */
export const XRAY = 0.3;

export const REACH_WGSL = /* wgsl */ `
override XRAY: f32 = 1.0;
struct ReachFrame { viewProj: mat4x4f, invViewProj: mat4x4f, viewport: vec2f, time: f32, gain: f32, centre: vec3f, radius: f32, normal: vec3f, dome: f32, tint: vec3f, ripple: f32 }
@group(0) @binding(0) var<uniform> rf: ReachFrame;

@vertex fn vsReach(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let C = rf.centre;
  let R = rf.radius * 1.06; // room for the disc's dark outer stroke
  let corner = vec2f(array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0)[vi], array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0)[vi]);
  let d = length(C);
  if (d < R * 1.05) { return vec4f(corner, 0.5, 1.0); } // the eye is (nearly) inside: the whole screen
  let f = C / d;
  let up0 = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(f.y) > 0.99);
  let right = normalize(cross(f, up0));
  let up = cross(right, f);
  let half = R * d / sqrt(d * d - R * R); // the tangent cone's silhouette radius
  return rf.viewProj * vec4f(C + (right * corner.x + up * corner.y) * half, 1.0);
}


struct FOut { @location(0) c: vec4f, @builtin(frag_depth) depth: f32 }

fn depthAt(p: vec3f) -> f32 {
  let c = rf.viewProj * vec4f(p, 1.0);
  return clamp(c.z / c.w, 0.0, 1.0);
}

@fragment fn fsReach(@builtin(position) pos: vec4f) -> FOut {
  var out: FOut;
  let C = rf.centre;
  let R = rf.radius;
  let ndc = vec2f(pos.x / rf.viewport.x * 2.0 - 1.0, 1.0 - pos.y / rf.viewport.y * 2.0);
  let fp = rf.invViewProj * vec4f(ndc, 1.0, 1.0);
  let dir = normalize(fp.xyz / fp.w);
  // The disc's plane (through the centre lifted along the normal, camera-relative), every quantity computed before
  // any branch so the derivatives are valid. Level (normal up), its axes are x and z, as the blast zone always had.
  let n = rf.normal;
  let lift = max(0.01 * R, 0.02);
  let dn = dot(dir, n);
  let tp = (dot(C, n) + lift) / select(dn, 1e-6, abs(dn) < 1e-6);
  let level = abs(n.y) > 0.999;
  let ax = select(normalize(cross(vec3f(0.0, 1.0, 0.0), n)), vec3f(1.0, 0.0, 0.0), level);
  let az = select(cross(ax, n), vec3f(0.0, 0.0, 1.0), level);
  let rel = dir * tp - C;
  let q = vec2f(dot(rel, ax), dot(rel, az)) / R; // disc coordinates, 1 at the edge
  let r = length(q);
  let aa = max(fwidth(r), 1e-4);
  let qa = max(fwidth(q.x) + fwidth(q.y), 1e-4);
  // Edge band: 4% of the radius, at least two pixels, outside edge at exactly the radius.
  let bw = max(0.04, 2.0 * aa);
  let edge = smoothstep(1.0 - bw - aa, 1.0 - bw, r) * (1.0 - smoothstep(1.0 - aa, 1.0, r));
  // A target reticle at the landing point: four ticks on the axes with a gap in the middle (a plain cross read as a first-aid sign).
  let cw = max(0.012, 1.5 * qa);
  let m = max(abs(q.x), abs(q.y));
  let bar = (1.0 - smoothstep(cw - qa, cw, min(abs(q.x), abs(q.y)))) * smoothstep(0.035, 0.035 + qa, m) * (1.0 - smoothstep(0.12, 0.12 + qa, m));
  // A thin dark stroke just outside the edge, so the zone holds on light ground (sand, concrete, a pale wall).
  let sw = max(0.012, 1.2 * aa);
  let stroke = smoothstep(1.0, 1.0 + aa, r) * (1.0 - smoothstep(1.0 + sw, 1.0 + sw + aa, r));
  // A ripple running from the centre to the edge once a second.
  let ph = fract(rf.time);
  let ripple = rf.ripple * exp(-pow((r - ph) / max(0.03, 2.0 * aa), 2.0)) * (1.0 - ph);
  let onDisc = tp > 0.0 && r < 1.0 + sw + aa;

  // The sphere: front surface, and the chord through a thin layer at the limb (brightest at the silhouette).
  let b = dot(dir, C);
  let disc = b * b - (dot(C, C) - R * R);
  let sq = sqrt(max(disc, 0.0));
  let t0 = max(b - sq, 0.0);
  let p2 = max(dot(C, C) - b * b, 0.0);
  let w = 0.03 * R;
  let ri = R - w;
  let e = 2.0 * (sqrt(max(R * R - p2, 0.0)) - sqrt(max(ri * ri - p2, 0.0))) / (2.0 * sqrt(max(R * R - ri * ri, 1e-8)));
  let front = dir * t0;
  let onDome = rf.dome > 0.5 && disc > 0.0 && b + sq > 0.0 && dot(front - C, n) > lift;

  if (onDisc) {
    let inside = 1.0 - smoothstep(1.0, 1.0 + aa, r);
    let a = clamp((0.14 + 0.75 * edge + 0.8 * bar + 0.25 * ripple) * inside, 0.0, 1.0) * XRAY;
    let glow = 1.0 + 0.8 * max(edge, bar);
    let sa = 0.55 * stroke * XRAY;
    out.c = vec4f(rf.tint * rf.gain * glow * XRAY * a * (1.0 - sa), a + sa - a * sa);
    out.depth = depthAt(dir * tp);
    return out;
  }
  if (!onDome) { discard; }
  let a = clamp(0.4 * e * e * e, 0.0, 1.0) * XRAY;
  out.c = vec4f(rf.tint * rf.gain * 1.2 * XRAY * a, a);
  out.depth = depthAt(front);
  return out;
}
`;

/** How a zone is drawn: its tint (linear RGB, scaled by the look's sun), whether the dome and the ripple show. */
export interface ZoneStyle { tint: V3; dome: boolean; ripple: boolean }
/** The blast zone: red, a dome, a ripple running out to the edge. */
export const BLAST_STYLE: ZoneStyle = { tint: [1.0, 0.1, 0.03], dome: true, ripple: true };
/** The impact marker: the aim beads' coral (scene.ts BEAD_COLOUR), flat on the face, still. */
export const IMPACT_STYLE: ZoneStyle = { tint: [1.0, 0.36, 0.22], dome: false, ripple: false };

/** CPU side: the zone (if shown), the two pipelines (made at the first show) and the draws. */
export class BlastReach {
  private zone: { centre: V3; radius: number; normal: V3 } | null = null;
  private gpu: { front: GPURenderPipeline; hidden: GPURenderPipeline; uniform: GPUBuffer; bind: GPUBindGroup } | null = null;
  private live = false;

  constructor(private readonly device: GPUDevice, readonly style: ZoneStyle = BLAST_STYLE) {}

  /**
   * Show the zone of radius (world units) at centre, its disc square to `normal` (default up: a level disc);
   * null (or a radius that is not positive, or a normal of no length) hides it.
   */
  set(centre: readonly number[] | null, radius = 0, normal: readonly number[] = [0, 1, 0]): void {
    const l = Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0);
    this.zone = centre && radius > 0 && centre.length >= 3 && centre.every(Number.isFinite) && l > 1e-9 && Number.isFinite(l)
      ? { centre: [centre[0]!, centre[1]!, centre[2]!], radius, normal: [normal[0]! / l, normal[1]! / l, normal[2]! / l] } : null;
  }

  /** The zone shown, if any. */
  get shown(): Readonly<{ centre: V3; radius: number; normal: V3 }> | null { return this.zone; }

  /** Upload this frame's uniforms; returns whether draw() has anything to record. viewProj is camera-relative; gain is the look's sun luminance. */
  prepare(f: { eye: V3; viewProj: Mat4; invViewProj: Mat4; viewport: [number, number]; time: number; gain: number }): boolean {
    this.live = this.zone !== null;
    if (!this.zone) return false;
    const g = (this.gpu ??= this.make());
    const u = new Float32Array(UNIFORM_FLOATS);
    u.set(f.viewProj, 0); u.set(f.invViewProj, 16);
    u[32] = f.viewport[0]; u[33] = f.viewport[1]; u[34] = f.time; u[35] = f.gain;
    const c = this.zone.centre;
    u[36] = c[0] - f.eye[0]; u[37] = c[1] - f.eye[1]; u[38] = c[2] - f.eye[2]; u[39] = this.zone.radius;
    u.set(this.zone.normal, 40); u[43] = this.style.dome ? 1 : 0;
    u.set(this.style.tint, 44); u[47] = this.style.ripple ? 1 : 0;
    this.device.queue.writeBuffer(g.uniform, 0, u);
    return true;
  }

  /** Record both draws (visible, then hidden at XRAY) into the open scene pass; the caller re-sets its own bind group after. */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.live || !this.gpu) return;
    pass.setBindGroup(0, this.gpu.bind);
    pass.setPipeline(this.gpu.front);
    pass.draw(6);
    pass.setPipeline(this.gpu.hidden);
    pass.draw(6);
  }

  private make(): NonNullable<BlastReach['gpu']> {
    const d = this.device, module = d.createShaderModule({ code: REACH_WGSL, label: 'blast reach' });
    const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const pipe = (compare: GPUCompareFunction, xray: number) => d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsReach' },
      fragment: {
        module, entryPoint: 'fsReach', constants: { XRAY: xray },
        // Alpha adds the coverage: what it covers is kept in colour under Bullet Time's frozen grade (fx.ts KEEP_ALPHA, PT33).
        targets: [{ format: HDR_FORMAT, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: compare },
      multisample: { count: SAMPLES },
    });
    const uniform = d.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'blast reach frame' });
    const bind = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
    return { front: pipe('less', 1), hidden: pipe('greater', XRAY), uniform, bind };
  }

  destroy(): void {
    this.gpu?.uniform.destroy();
  }
}
