// Page-side drivers for the engraved-mark tests (render-marks.test.ts): a row
// of tinted cubes facing the camera, unmarked, marked hit and marked save, and
// the WGSL carving against its TypeScript twin (marks.ts).
import { emptySnapshot, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { readBuffer, sharedDevice } from '@tb/gpu';
import { engrave, LOOKS, lookAt, MARK_HIT, MARK_NONE, MARK_SAVE, MARKS_WGSL, markPoint, multiply, perspective, Renderer, SnapshotSource, type FrameParams, type V3 } from '../src/index.ts';

const FOV = 0.9;

function box(pos: V3, half: V3, rot: [number, number, number, number] = [0, 0, 0, 1]): BodyDesc {
  return { shape: { kind: 'box', half }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 };
}

function snapshotOf(descs: BodyDesc[]): Snapshot {
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  return s;
}

/** The game's role tints (game scene.ts TINT), linear. */
const GOLD: V3 = [1, 0.72, 0.22];
const CELADON: V3 = [0.5, 0.86, 0.7];

export interface MarksCase {
  look: 'hazy' | 'real' | 'candy';
  /** Marks on (the default) or none set (the before frame). */
  marks?: boolean;
  /** Camera distance to the row, m (default 3: a cube is about 60 px tall at 320x200). */
  dist?: number;
  size?: [number, number];
  /** Also draw a turned cube and a rod (the screenshot lineup). */
  extras?: boolean;
  /** Keep the frame's pixels (for a screenshot). */
  keep?: boolean;
  /** After setMarks: a setFx flash without a mark and a bulk scale write, which must keep the marks. */
  restyle?: boolean;
}

const HALF = 0.25;
/** Cube centres along x: unmarked gold, hit gold, save celadon, unmarked celadon. */
const XS = [-0.9, -0.3, 0.3, 0.9];

/**
 * The row of cubes (half 0.25 m) at z = -dist, faces square to the camera, lit by the look's sun.
 * Returns the frame and, per marked cube, its face pixels classified by the glyph's own signed
 * distance (marks.ts markSd: carved or open, away from the edges), and by the other glyph's and by
 * its upside-down self's: what the tests compare.
 */
export async function marksFrames(c: MarksCase) {
  const [W, H] = c.size ?? [320, 200];
  const dist = c.dist ?? 3;
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const y = 1, z = -dist;
  const descs = XS.map((x) => box([x, y, z], [HALF, HALF, HALF]));
  if (c.extras) {
    descs.push(box([-0.6, y + 0.75, z], [HALF, HALF, HALF], [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)]));
    descs.push(box([0.45, y + 0.75, z], [3 * HALF, HALF, HALF]));
  }
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS[c.look]!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, y, z], 3);
  const tints: Array<{ tint: V3; emissive?: number }> = [{ tint: GOLD, emissive: 0.1 }, { tint: GOLD, emissive: 0.1 }, { tint: CELADON }, { tint: CELADON }, { tint: GOLD, emissive: 0.1 }, { tint: CELADON }];
  tints.slice(0, descs.length).forEach((t, i) => rend.setFx(i, t));
  const marks = [MARK_NONE, MARK_HIT, MARK_SAVE, MARK_NONE, MARK_HIT, MARK_SAVE].slice(0, descs.length);
  if (c.marks !== false) rend.setMarks(0, marks);
  if (c.restyle) {
    rend.setFx(1, { tint: GOLD, emissive: 0.1, flash: 0 });
    rend.setFx(0, null, new Float32Array(descs.length).fill(1), false);
  }
  const kept = descs.map((_, i) => rend.fxOf(i).mark);
  const eye: V3 = [0, y, 0];
  const f: FrameParams = { viewProj: multiply(perspective(FOV, W / H, 0.1, 400), lookAt(eye, [0, y, z])), eye, groundY: 0, time: 3 };
  const frame = (await rend.render(f, true, true))!.pixels!;
  rend.clearFx(0, descs.length);
  const cleared = descs.map((_, i) => rend.fxOf(i).mark);
  const err = await device.popErrorScope();
  rend.destroy();

  const vp = f.viewProj;
  const px = (p: V3): [number, number] => {
    const q = [0, 1, 2, 3].map((r) => vp[r]! * p[0] + vp[4 + r]! * p[1] + vp[8 + r]! * p[2] + vp[12 + r]!);
    return [Math.round(((q[0]! / q[3]! + 1) / 2) * W - 0.5), Math.round(((1 - q[1]! / q[3]!) / 2) * H - 0.5)];
  };
  const luma = (x: number, yy: number) => { const o = yy * frame.bytesPerRow + 4 * x; return (frame.data[o]! + frame.data[o + 1]! + frame.data[o + 2]!) / 3; };
  // Samples on a cube's front face (+z, toward the camera): glyph point p (cell half 1 = HALF m) and its pixel.
  const face = (i: number) => {
    const out: Array<{ p: [number, number]; l: number }> = [];
    for (let a = -0.85; a <= 0.85 + 1e-9; a += 0.05) for (let b = -0.85; b <= 0.85 + 1e-9; b += 0.05) {
      const lp: V3 = [a * HALF, b * HALF, HALF];
      const { p } = markPoint(lp, [0, 0, 1], [HALF, HALF, HALF]);
      const [x, yy] = px([XS[i]! + lp[0], y + lp[1], z + lp[2]]);
      out.push({ p, l: luma(x, yy) });
    }
    return out;
  };
  return {
    error: err?.message ?? null, kept, cleared, size: [W, H],
    pixels: c.keep ? frame : null,
    faces: [0, 1, 2, 3].map(face),
  };
}

/**
 * The x-ray (Renderer.xray, fx.ts XRAY bits): a wall (half 1.5 x 1 x 0.1) 3 m ahead hides three cubes 5 m ahead: a crown
 * (x-ray 1) at x -0.5, a plain cube at x 0, a heritage cube (x-ray 2) at x 0.5; a fourth, a crown left in sight, stands at
 * x 3.2 beside the wall. Frames with the x-ray off, on, and on after a restyle (a setFx flash and a bulk scale write, which
 * must keep the kinds), in `look`. Returns the colour change at each cube's face centre and near its face's edge, and how
 * many pixels changed outside the two hidden objectives' outlines.
 */
export async function xrayFrames(c: { look: 'hazy' | 'real' | 'candy' }) {
  const [W, H] = [320, 200];
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const y = 1, X = [-0.5, 0, 0.5, 3.2], Z = -5;
  const descs = [...X.map((x) => box([x, y, Z], [HALF, HALF, HALF])), box([0, y, -3], [1.5, 1, 0.1])];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS[c.look]!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, y, -4], 4);
  rend.setXray(0, [1, 0, 2, 1, 0]);
  const eye: V3 = [0, y, 0];
  const f: FrameParams = { viewProj: multiply(perspective(FOV, W / H, 0.1, 400), lookAt(eye, [0, y, Z])), eye, groundY: 0, time: 3 };
  const off = (await rend.render(f, true, true))!.pixels!;
  rend.xray = true;
  const on = (await rend.render(f, true, true))!.pixels!;
  rend.setFx(0, { tint: GOLD, emissive: 0.1, flash: 0 });
  rend.setFx(0, null, new Float32Array(descs.length).fill(1), false);
  const restyled = (await rend.render(f, true, true))!.pixels!;
  const kinds = descs.map((_, i) => rend.fxOf(i).xray);
  const err = await device.popErrorScope();
  rend.destroy();
  const vp = f.viewProj;
  const px = (p: V3): [number, number] => {
    const q = [0, 1, 2, 3].map((r) => vp[r]! * p[0] + vp[4 + r]! * p[1] + vp[8 + r]! * p[2] + vp[12 + r]!);
    return [Math.round(((q[0]! / q[3]! + 1) / 2) * W - 0.5), Math.round(((1 - q[1]! / q[3]!) / 2) * H - 0.5)];
  };
  const rgb = (fr: typeof on, [x, yy]: [number, number]) => { const o = yy * fr.bytesPerRow + 4 * x; return [fr.data[o]!, fr.data[o + 1]!, fr.data[o + 2]!]; };
  const delta = (fr: typeof on, p: [number, number]) => { const a = rgb(fr, p), b = rgb(off, p); return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]; };
  // The front face (+z) of cube i: its centre, and a point 92% of the way to its left edge.
  const at = (i: number, u: number) => px([X[i]! + u * HALF, y, Z + HALF]);
  const cubes = X.map((_, i) => ({ centre: delta(on, at(i, 0)), edge: delta(on, at(i, -0.92)), restyled: delta(restyled, at(i, 0)) }));
  // Outside the hidden objectives' outlines (the front face's square grown by 3 px), nothing changes.
  const boxPx = (i: number) => { const a = px([X[i]! - HALF, y + HALF, Z + HALF]), b = px([X[i]! + HALF, y - HALF, Z + HALF]); return [a[0] - 3, a[1] - 3, b[0] + 3, b[1] + 3]; };
  const inside = [boxPx(0), boxPx(2)];
  let outsideChanged = 0;
  for (let yy = 0; yy < H; yy++) for (let x = 0; x < W; x++) {
    if (inside.some(([l, t, r, b]) => x >= l! && x <= r! && yy >= t! && yy <= b!)) continue;
    const d = delta(on, [x, yy]);
    if (Math.max(...d.map(Math.abs)) > 1) outsideChanged++;
  }
  return { error: err?.message ?? null, cubes, outsideChanged, kinds };
}

/** The WGSL engrave against its TypeScript twin on random points of random box faces, marks and pixel sizes: the largest differences. */
export async function engraveMatches(n = 4096) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  let seed = 7;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const f32 = Math.fround;
  const cases = Array.from({ length: n }, () => {
    const half: V3 = [0.05 + r() * 1.2, 0.05 + r() * 1.2, 0.05 + r() * 1.2].map(f32) as V3;
    const axis = Math.floor(r() * 3), sgn = r() < 0.5 ? -1 : 1, faceN: V3 = [0, 0, 0];
    faceN[axis] = sgn;
    const lp = half.map((h, k) => f32(k === axis ? sgn * h : (r() * 2 - 1) * h)) as V3;
    return { mark: Math.floor(r() * 3), lp, faceN, half, pxM: f32(10 ** (r() * 3 - 4)) };
  });
  const xs = new Float32Array(cases.flatMap((k) => [...k.lp, k.pxM, ...k.faceN, k.mark, ...k.half, 0]));
  const code = `${MARKS_WGSL}
@group(0) @binding(0) var<storage, read> xs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> ys: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= ${n}u) { return; }
  let a = xs[3u * i]; let b = xs[3u * i + 1u]; let c = xs[3u * i + 2u];
  let k = engrave(u32(b.w), a.xyz, b.xyz, c.xyz, a.w);
  ys[i] = vec4f(k.dn, k.shade);
}`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const xb = device.createBuffer({ size: xs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(xb, 0, xs);
  const yb = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: xb } }, { binding: 1, resource: { buffer: yb } }] }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const ys = new Float32Array(await readBuffer(device, yb));
  xb.destroy();
  yb.destroy();
  let shadeErr = 0, dnErr = 0, carved = 0, tilted = 0;
  cases.forEach((k, i) => {
    const want = engrave(k.mark, k.lp, k.faceN, k.half, k.pxM);
    shadeErr = Math.max(shadeErr, Math.abs(want.shade - ys[4 * i + 3]!));
    want.dn.forEach((v, j) => { dnErr = Math.max(dnErr, Math.abs(v - ys[4 * i + j]!)); });
    if (want.shade < 0.99) carved++;
    if (Math.hypot(...want.dn) > 0.1) tilted++;
  });
  const err = await device.popErrorScope();
  return { error: err?.message ?? null, shadeErr, dnErr, carved, tilted, n };
}
