// Page-side drivers for the blast tests (render-blasts.test.ts): a small
// scene, a blast in front of the camera, and frames with and without it.
import { emptySnapshot, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { sharedDevice } from '@tb/gpu';
import { LOOKS, lookAt, multiply, perspective, Renderer, SnapshotSource, type FrameParams, type V3 } from '../src/index.ts';

const W = 160, H = 100, FOV = 0.9;

function camera(eye: V3, target: V3): FrameParams {
  return { viewProj: multiply(perspective(FOV, W / H, 0.1, 400), lookAt(eye, target)), eye, groundY: -100 };
}

function box(pos: V3, half: V3): BodyDesc {
  return { shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 };
}

function snapshotOf(descs: BodyDesc[]): Snapshot {
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  return s;
}

type Px = { data: number[]; bytesPerRow: number };
const luma = (p: Px, x: number, y: number) => { const o = y * p.bytesPerRow + 4 * x; return (p.data[o]! + p.data[o + 1]! + p.data[o + 2]!) / 3; };
const rgb = (p: Px, x: number, y: number) => { const o = y * p.bytesPerRow + 4 * x; return [p.data[o]!, p.data[o + 1]!, p.data[o + 2]!]; };

/** Projected radius (pixels) of a sphere of radius r whose centre is d ahead on the view axis. */
const discPx = (r: number, d: number) => Math.tan(Math.asin(r / d)) / Math.tan(FOV / 2) * (H / 2);

export interface BlastCase {
  /** 'candy' (stylized, effects on) or 'real' (effects off: the light goes through packOnly). */
  look: 'candy' | 'real';
  /** Blast age when drawn, s. */
  age: number;
  /** Fireball and light off: only the shock shell is drawn. */
  shellOnly?: boolean;
  /** A box between the camera and the blast. */
  blocker?: boolean;
}

/**
 * Frames of a scene (a box to the side of the blast, optionally one in front
 * of it) without and with a blast of radius 2 at 10 m on the view axis.
 * Returns per-pixel changes and what the tests check.
 */
export async function blastFrames(c: BlastCase) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const centre: V3 = [0, 2, -10], R = 2;
  const descs = [box([3.2, 2, -10], [0.5, 0.5, 0.5]), ...(c.blocker ? [box([0, 2, -4], [0.6, 0.6, 0.6])] : [])];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...(c.look === 'real' ? LOOKS.real! : LOOKS.candy!), bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, 2, -10], 8);
  if (c.shellOnly) rend.blasts.config = { ...rend.blasts.config, glow: 0, light: 0 };
  const f: FrameParams = { ...camera([0, 2, 0], centre), time: 10 };
  const before = (await rend.render(f, true, true))!.pixels!;
  const compiledBefore = (rend.blasts as unknown as { gpu: unknown }).gpu !== null;
  const ids = (await rend.renderIds(f)).ids;
  rend.blast(centre, R, 10 - c.age);
  const after = (await rend.render(f, true, true))!.pixels!;
  // Toggled off: the frame without the blast again.
  rend.toggles.blasts = false;
  const off = (await rend.render(f, true, true))!.pixels!;
  const err = await device.popErrorScope();
  rend.destroy();

  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  const shellPx = discPx(R, 10);
  const outsideAt: number[][] = [];
  let outsideChanged = 0, insideChanged = 0, inside = 0, offDiff = 0;
  let rim = 0, rimN = 0, core = 0, coreN = 0;
  const coreRgb = [0, 0, 0];
  const boxSide = { before: 0, after: 0, n: 0 }, blocker = { before: 0, after: 0, n: 0 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy), id = ids[y * W + x]!;
    const dl = luma(after, x, y) - luma(before, x, y);
    offDiff = Math.max(offDiff, Math.abs(luma(off, x, y) - luma(before, x, y)));
    if (id === 1) { boxSide.before += luma(before, x, y); boxSide.after += luma(after, x, y); boxSide.n++; continue; }
    if (id === 2) { blocker.before += luma(before, x, y); blocker.after += luma(after, x, y); blocker.n++; continue; }
    // Body edges: antialiased pixels partly covered by a lit box (the ID pass is single-sampled).
    const nearBody = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (ids[Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))] ?? 0) !== 0));
    if (d > shellPx + 1.5 && nearBody) continue;
    if (d > shellPx + 1.5) { if (Math.abs(dl) > 1) { outsideChanged++; if (outsideAt.length < 12) outsideAt.push([x, y, Math.round(dl)]); } continue; }
    if (d < shellPx - 1.5) { inside++; if (dl > 3) insideChanged++; }
    if (d > shellPx - 3 && d < shellPx - 0.5) { rim += dl; rimN++; }
    if (d < shellPx * 0.4) { core += dl; coreN++; rgb(after, x, y).forEach((v, k) => { coreRgb[k]! += v; }); }
  }
  return {
    error: err?.message ?? null, compiledBefore, outsideAt, shellPx, offDiff,
    outsideChanged, insideFrac: insideChanged / Math.max(1, inside),
    rim: rim / Math.max(1, rimN), core: core / Math.max(1, coreN), coreRgb: coreRgb.map((v) => v / Math.max(1, coreN)),
    boxSide: { before: boxSide.before / Math.max(1, boxSide.n), after: boxSide.after / Math.max(1, boxSide.n), n: boxSide.n },
    blocker: { before: blocker.before / Math.max(1, blocker.n), after: blocker.after / Math.max(1, blocker.n), n: blocker.n },
  };
}
