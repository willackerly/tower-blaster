// Page-side driver for the sleep tint test (render-sleep.test.ts): a row of cubes and two balls facing the
// camera, some asleep (Snapshot.awake 0), drawn with Renderer.toggles.sleepTint off and on.
import { emptySnapshot, TAG_BALL, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { sharedDevice } from '@tb/gpu';
import { lookAt, multiply, perspective, Renderer, SnapshotSource, type FrameParams, type V3 } from '../src/index.ts';
import { LOOKS } from './looks.ts';

const FOV = 0.9;
const HALF = 0.25;
/** Body centres along x: four cubes, then two balls (radius HALF). */
const XS = [-1.5, -0.9, -0.3, 0.3, 0.9, 1.5];
/** Which of them are asleep in the mixed frames. */
export const ASLEEP = [false, true, false, true, true, false];

function body(i: number, y: number, z: number): BodyDesc {
  const ball = i >= 4;
  return { shape: ball ? { kind: 'sphere', radius: HALF } : { kind: 'box', half: [HALF, HALF, HALF] }, pos: [XS[i]!, y, z], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: ball ? TAG_BALL : i % 2 };
}

function snapshotOf(descs: BodyDesc[], asleep: boolean[]): Snapshot {
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = asleep[i] ? 0 : 1; });
  return s;
}

/**
 * Three frames of the row in `look`: mixed sleepers with the tint off, mixed with it on, and every body
 * awake with it on. Per frame and body, the mean display RGB (0-255) of a 5x5 patch at the middle of its
 * camera-facing side.
 */
export async function sleepFrames(look: string) {
  const [W, H] = [480, 160];
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const y = 1, z = -4;
  const descs = XS.map((_, i) => body(i, y, z));
  const src = new SnapshotSource(device);
  src.reset(descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS[look]!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, y, z], 3);
  const eye: V3 = [0, y, 0];
  const f: FrameParams = { viewProj: multiply(perspective(FOV, W / H, 0.1, 400), lookAt(eye, [0, y, z])), eye, groundY: 0, time: 3 };
  const vp = f.viewProj;
  const px = (p: V3): [number, number] => {
    const q = [0, 1, 2, 3].map((r) => vp[r]! * p[0] + vp[4 + r]! * p[1] + vp[8 + r]! * p[2] + vp[12 + r]!);
    return [Math.round(((q[0]! / q[3]! + 1) / 2) * W - 0.5), Math.round(((1 - q[1]! / q[3]!) / 2) * H - 0.5)];
  };
  const frame = async (asleep: boolean[], tint: boolean) => {
    src.update(snapshotOf(descs, asleep), descs);
    rend.toggles.sleepTint = tint;
    const img = (await rend.render(f, true, true))!.pixels!;
    return XS.map((x) => {
      const [cx, cy] = px([x, y, z + HALF]);
      const m = [0, 0, 0];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const o = (cy + dy) * img.bytesPerRow + 4 * (cx + dx);
        for (let k = 0; k < 3; k++) m[k]! += img.data[o + k]! / 25;
      }
      return m as [number, number, number];
    });
  };
  const off = await frame(ASLEEP, false);
  const on = await frame(ASLEEP, true);
  const allAwake = await frame(ASLEEP.map(() => false), true);
  const err = await device.popErrorScope();
  rend.destroy();
  return { error: err?.message ?? null, off, on, allAwake };
}
