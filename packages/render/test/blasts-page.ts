// Page-side drivers for the blast tests (render-blasts.test.ts): a small
// scene, a blast in front of the camera, and frames with and without it.
import { emptySnapshot, type BodyDesc, type Snapshot, TAG_BALL } from '@tb/engine-api';
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

/**
 * A ball 8 m ahead with a fuse marked: frames without the mark, with it, and
 * with the ball removed (tier free). Returns the brightening at the ball's
 * top and the largest change anywhere for the removed and unmarked cases.
 */
export async function fuseFrames() {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const ballDesc: BodyDesc = { shape: { kind: 'sphere', radius: 0.3 }, pos: [0, 2, -8], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: -1 };
  const descs = [box([3, 2, -10], [0.5, 0.5, 0.5]), ballDesc];
  const src = new SnapshotSource(device);
  src.reset(descs);
  const snap = snapshotOf(descs);
  src.update(snap, descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS.hazy!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  const f: FrameParams = { ...camera([0, 2, 0], [0, 2, -8]), time: 3 };
  const before = (await rend.render(f, true, true))!.pixels!;
  const compiledBefore = (rend.fuses as unknown as { gpu: unknown }).gpu !== null;
  rend.fuse(1);
  const lit = (await rend.render(f, true, true))!.pixels!;
  // Removed: the slot's tier is free, so nothing is drawn for it, spark included.
  const gone = snapshotOf(descs);
  gone.tier = Uint8Array.from([0, 255]);
  src.update(gone, descs);
  const removed = (await rend.render(f, true, true))!.pixels!;
  rend.fuse(1, false);
  const removedNoFuse = (await rend.render(f, true, true))!.pixels!;
  src.update(snap, descs);
  const unmarked = (await rend.render(f, true, true))!.pixels!;
  const err = await device.popErrorScope();
  rend.destroy();
  // The ball's top on screen (0.3 m above its centre at 8 m); the cord rises up and a little right of it, the spark at its end.
  const cx = Math.round((W - 1) / 2), top = Math.round((H - 1) / 2 - (0.3 / 8) / Math.tan(FOV / 2) * (H / 2));
  const maxDiff = (a: Px, b: Px) => { let m = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m = Math.max(m, Math.abs(luma(a, x, y) - luma(b, x, y))); return m; };
  let topGain = 0, cordDark = 0, at = [cx, top];
  for (let y = top - 16; y <= top + 1; y++) for (let x = cx - 4; x <= cx + 10; x++) {
    const g = luma(lit, x, y) - luma(before, x, y);
    if (g > topGain) { topGain = g; at = [x, y]; }
    cordDark = Math.min(cordDark, g);
  }
  return { error: err?.message ?? null, compiledBefore, topGain, cordDark, sparkAt: [at[0]! - cx, at[1]! - top], removedDiff: maxDiff(removed, removedNoFuse), unmarkedDiff: maxDiff(unmarked, before), topRgb: rgb(lit, at[0]!, at[1]!) };
}

/**
 * The aim preview's blast-reach zone: radius 2 around [0, 2, -10] seen from
 * above ([0, 6, 0]), with a box hiding part of its edge. Frames without the
 * zone, with it, and hidden again; returns the colour change at points of
 * the edge circle (visible, and behind the box) and at the centre, and what
 * changed outside the sphere's silhouette.
 */
export async function reachFrames() {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const centre: V3 = [0, 2, -10], R = 2;
  const descs = [box([1, 4, -5], [0.4, 0.4, 0.4])];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS.hazy!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  const eye: V3 = [0, 6, 0];
  const f: FrameParams = { ...camera(eye, centre), time: 0.5 };
  const before = (await rend.render(f, true, true))!.pixels!;
  const compiledBefore = (rend.reachZone as unknown as { gpu: unknown }).gpu !== null;
  const ids = (await rend.renderIds(f)).ids;
  rend.reach(centre, R);
  const shown = rend.reachZone.shown;
  const after = (await rend.render(f, true, true))!.pixels!;
  rend.reach(null);
  const hidden = (await rend.render(f, true, true))!.pixels!;
  const err = await device.popErrorScope();
  rend.destroy();

  // Screen pixel of a world point (the camera's matrix, as the renderer uses it with eye at the origin).
  const vp = multiply(perspective(FOV, W / H, 0.1, 400), lookAt(eye, centre));
  const px = (p: V3): [number, number] => {
    const [x, y, z] = p, c = [0, 1, 2, 3].map((r) => vp[r]! * x + vp[4 + r]! * y + vp[8 + r]! * z + vp[12 + r]!);
    return [Math.round(((c[0]! / c[3]! + 1) / 2) * W - 0.5), Math.round(((1 - c[1]! / c[3]!) / 2) * H - 0.5)];
  };
  // r: how much redder (red over green) the pixel got; g: the change in green.
  const gain = (x: number, y: number) => { const a = rgb(after, x, y), b = rgb(before, x, y); return { r: a[0]! - a[1]! - (b[0]! - b[1]!), g: a[1]! - b[1]!, l: luma(after, x, y) - luma(before, x, y) }; };
  const visible: { r: number; g: number; l: number }[] = [], blocked: { r: number; g: number; l: number }[] = [];
  for (let k = 0; k < 48; k++) {
    const a = (2 * Math.PI * k) / 48, [x, y] = px([centre[0] + 0.98 * R * Math.cos(a), centre[1] + 0.03, centre[2] + 0.98 * R * Math.sin(a)]);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    (ids[y * W + x] === 1 ? blocked : visible).push(gain(x, y));
  }
  const [cx0, cy0] = px([centre[0], centre[1] + 0.03, centre[2]]);
  // Outside the sphere's silhouette (projected radius plus a margin) nothing changes.
  const [scx, scy] = px(centre), sil = discPx(R, Math.hypot(6 - 2, 10)) + 2;
  let outsideChanged = 0, hiddenDiff = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    hiddenDiff = Math.max(hiddenDiff, Math.abs(luma(hidden, x, y) - luma(before, x, y)));
    if (Math.hypot(x - scx, y - scy) > sil && Math.abs(luma(after, x, y) - luma(before, x, y)) > 1) outsideChanged++;
  }
  const mean = (a: { r: number; g: number; l: number }[], k: 'r' | 'g' | 'l') => a.reduce((s, v) => s + v[k], 0) / Math.max(1, a.length);
  return {
    error: err?.message ?? null, compiledBefore, shown, outsideChanged, hiddenDiff,
    visible: { n: visible.length, r: mean(visible, 'r'), g: mean(visible, 'g') },
    blocked: { n: blocked.length, r: mean(blocked, 'r'), g: mean(blocked, 'g') },
    centre: gain(cx0, cy0),
  };
}

export interface LineupCase {
  look: 'hazy' | 'real' | 'candy';
  /** Turn the painted ball 90 degrees about the view axis (z): its band then runs up and down. */
  turned?: boolean;
  /** Keep the frame's pixels (for a screenshot). */
  keep?: boolean;
}

/**
 * Fired balls beside a bomb, 4 m ahead: a painted ball with a band (FX paint + band, as the game's
 * ballFx paints a cannonball) at x -1.2 (crimson, as the game's cannonball), a bomb (near-black matte with a lit fuse, the game's BOMB_FX)
 * at x 0, and a plain ball (the look's own) at x 1.2, radius 0.45 each. Returns each ball's mean colour
 * on its disc, the painted ball's colour along its band and away from it, and the bomb's.
 */
export async function lineupFrames(c: LineupCase) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const R = 0.45, Z = -4, X = [-1.2, 0, 1.2];
  const turn: [number, number, number, number] = c.turned ? [0, 0, Math.SQRT1_2, Math.SQRT1_2] : [0, 0, 0, 1];
  const ball = (x: number, rot: [number, number, number, number] = [0, 0, 0, 1]): BodyDesc => ({ shape: { kind: 'sphere', radius: R }, pos: [x, 2, Z], rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: TAG_BALL });
  const descs = [ball(X[0]!, turn), ball(X[1]!), ball(X[2]!)];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS[c.look]!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, 2, Z], 4);
  rend.setFx(0, { tint: [0.578, 0.0052, 0.027], paint: true, band: true }); // the game's crimson cannonball (scene.ts BALL_PAINT), linear
  rend.setFx(1, { tint: [0.012, 0.012, 0.015], paint: true, matte: true });
  rend.fuse(1);
  const f: FrameParams = { ...camera([0, 2, 0], [0, 2, Z]), time: 3 };
  const frame = (await rend.render(f, true, true))!.pixels!;
  const err = await device.popErrorScope();
  rend.destroy();
  const vp = multiply(perspective(FOV, W / H, 0.1, 400), lookAt([0, 2, 0], [0, 2, Z]));
  const px = (p: V3): [number, number] => {
    const [x, y, z] = p, q = [0, 1, 2, 3].map((r) => vp[r]! * x + vp[4 + r]! * y + vp[8 + r]! * z + vp[12 + r]!);
    return [((q[0]! / q[3]! + 1) / 2) * W - 0.5, ((1 - q[1]! / q[3]!) / 2) * H - 0.5];
  };
  const rPx = discPx(R, Math.hypot(1.2, 4)) * 0.9;
  const mean = (pts: [number, number][]) => { const s = [0, 0, 0]; for (const [x, y] of pts) rgb(frame, x, y).forEach((v, k) => { s[k]! += v; }); return s.map((v) => v / Math.max(1, pts.length)); };
  const disc = (i: number) => { const [cx, cy] = px([X[i]!, 2, Z]), pts: [number, number][] = []; for (let y = Math.floor(cy - rPx); y <= cy + rPx; y++) for (let x = Math.floor(cx - rPx); x <= cx + rPx; x++) if (Math.hypot(x - cx, y - cy) < 0.8 * rPx) pts.push([x, y]); return mean(pts); };
  // Along the band (its middle) and off it (60% of the radius out, across the band), on the painted ball.
  const [pcx, pcy] = px([X[0]!, 2, Z]), off = Math.round(0.6 * rPx), pts = (dx: number, dy: number): [number, number][] => [-2, -1, 0, 1, 2].map((k) => (c.turned ? [Math.round(pcx + dx), Math.round(pcy + dy + k)] : [Math.round(pcx + dx + k), Math.round(pcy + dy)]) as [number, number]);
  const along = mean(c.turned ? pts(0, 0) : pts(0, 0)), across = mean(c.turned ? [...pts(-off, 0), ...pts(off, 0)] : [...pts(0, -off), ...pts(0, off)]);
  return { error: err?.message ?? null, painted: disc(0), bomb: disc(1), plain: disc(2), along, across, pixels: c.keep ? frame : null, size: [W, H] };
}
