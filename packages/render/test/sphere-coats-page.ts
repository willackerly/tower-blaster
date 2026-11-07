// Page-side driver for render-sphere-coats.test.ts (PT26): a row of structure spheres (not balls) facing the camera,
// coated gilt, glaze, painted (COAT_PAINT, tinted blue) and uncoated, each drawn at a fixed renderer time so a flash
// is measured where it is, not where a slow frame happened to land.
import { emptySnapshot, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { sharedDevice } from '@tb/gpu';
import { COAT_GILT, COAT_GLAZE, COAT_NONE, COAT_PAINT, linearToOklab, lookAt, multiply, perspective, Renderer, SnapshotSource, srgbToLinear, type FrameParams, type V3 } from '../src/index.ts';
import { LOOKS } from './looks.ts';

const FOV = 0.9, R = 0.25, XS = [-0.9, -0.3, 0.3, 0.9];
/** A built part's blue (game scene.ts BUILT_SRGB #4A86E8), linear. */
const BLUE: V3 = [0x4a, 0x86, 0xe8].map((v) => srgbToLinear(v / 255)) as V3;

const sphere = (x: number, y: number, z: number): BodyDesc => ({ shape: { kind: 'sphere', radius: R }, pos: [x, y, z], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });

function snapshotOf(descs: BodyDesc[]): Snapshot {
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  return s;
}

export interface SphereCase {
  look: 'hazy' | 'real' | 'candy';
  /** Flash sphere 0 (gilt) as a rung bell does (game rube-view.ts BELL_FLASH) at time 3 s; frames are drawn at `times`. */
  flash?: { emissive: number; flash: number };
  /** Renderer times (s) to draw at (default [3.1]). */
  times?: number[];
}

/** Per frame (time), per sphere: mean OKLab over its middle disc, as L, hue (degrees) and chroma. */
export async function sphereFrames(c: SphereCase) {
  const [W, H] = [320, 200];
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const y = 1, z = -3;
  const descs = XS.map((x) => sphere(x, y, z));
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...LOOKS[c.look]!, bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, y, z], 3);
  // Untinted but the painted one: the coat alone gives the colour (game scene.ts tintOf: BUILT_TINT on a built part).
  descs.forEach((_, i) => rend.setFx(i, { tint: i === 2 ? BLUE : [1, 1, 1] }));
  rend.setCoats(0, [COAT_GILT, COAT_GLAZE, COAT_PAINT, COAT_NONE]);
  if (c.flash) rend.setFx(0, { ...c.flash, tint: [1, 1, 1], flashAt: 3 });
  const coats = descs.map((_, i) => rend.fxOf(i).coat);
  const eye: V3 = [0, y, 0];
  const vp = multiply(perspective(FOV, W / H, 0.1, 400), lookAt(eye, [0, y, z]));
  const px = (p: V3): [number, number] => {
    const q = [0, 1, 2, 3].map((r) => vp[r]! * p[0] + vp[4 + r]! * p[1] + vp[8 + r]! * p[2] + vp[12 + r]!);
    return [((q[0]! / q[3]! + 1) / 2) * W - 0.5, ((1 - q[1]! / q[3]!) / 2) * H - 0.5];
  };
  const frames: Array<Array<{ L: number; hue: number; chroma: number; n: number }>> = [];
  for (const time of c.times ?? [3.1]) {
    const f: FrameParams = { viewProj: vp, eye, groundY: 0, time };
    const frame = (await rend.render(f, true, true))!.pixels!;
    frames.push(XS.map((x) => {
      const [cx, cy] = px([x, y, z]), rr = Math.abs(px([x + R, y, z])[0] - cx) * 0.6;
      let L = 0, a = 0, b = 0, n = 0;
      for (let yy = Math.floor(cy - rr); yy <= Math.ceil(cy + rr); yy++) for (let xx = Math.floor(cx - rr); xx <= Math.ceil(cx + rr); xx++) {
        if (Math.hypot(xx - cx, yy - cy) > rr) continue;
        const o = yy * frame.bytesPerRow + 4 * xx;
        const lab = linearToOklab([0, 1, 2].map((k) => srgbToLinear(frame.data[o + k]! / 255)) as V3);
        L += lab[0]; a += lab[1]; b += lab[2]; n++;
      }
      return { L: L / n, hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(a, b) / n, n };
    }));
  }
  const err = await device.popErrorScope();
  rend.destroy();
  return { error: err?.message ?? null, coats, frames };
}
