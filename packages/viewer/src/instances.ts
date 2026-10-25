// Pack engine snapshots into RenderInstance records (layout from @tb/schema),
// boxes first and spheres after, so each pipeline draws one contiguous range.
import type { BodyDesc, Snapshot } from '@tb/engine-api';
import { RenderInstance } from '@tb/schema';

const STRIDE = RenderInstance.size / 4;
const OFF = Object.fromEntries(RenderInstance.fields.map((f) => [f.name, f.offset / 4])) as Record<'pos' | 'palette' | 'rot' | 'half' | 'shape', number>;

/** Palette slot per body: towers cycle through 6 colours, balls and debris get their own. */
export function paletteOf(tag: number): number {
  if (tag === -1) return 6;
  if (tag < 0) return 7;
  return ((tag % 6) + 6) % 6;
}

export interface Packed { data: ArrayBuffer; boxes: number; spheres: number }

export function packInstances(s: Snapshot, shapes: BodyDesc[], out?: ArrayBuffer): Packed {
  const n = s.count;
  const bytes = Math.max(RenderInstance.size, n * RenderInstance.size);
  const data = out && out.byteLength >= bytes ? out : new ArrayBuffer(bytes);
  const f = new Float32Array(data), u = new Uint32Array(data);
  let boxes = 0;
  for (let i = 0; i < n; i++) if (shapes[i]!.shape.kind === 'box') boxes++;
  let bi = 0, si = boxes;
  for (let i = 0; i < n; i++) {
    const b = shapes[i]!;
    const slot = b.shape.kind === 'box' ? bi++ : si++;
    const o = slot * STRIDE;
    f[o + OFF.pos] = s.pos[3 * i]!; f[o + OFF.pos + 1] = s.pos[3 * i + 1]!; f[o + OFF.pos + 2] = s.pos[3 * i + 2]!;
    u[o + OFF.palette] = paletteOf(b.tag);
    for (let k = 0; k < 4; k++) f[o + OFF.rot + k] = s.rot[4 * i + k]!;
    if (b.shape.kind === 'box') {
      f[o + OFF.half] = b.shape.half[0]; f[o + OFF.half + 1] = b.shape.half[1]; f[o + OFF.half + 2] = b.shape.half[2];
      u[o + OFF.shape] = 0;
    } else {
      f[o + OFF.half] = f[o + OFF.half + 1] = f[o + OFF.half + 2] = b.shape.radius;
      u[o + OFF.shape] = 1;
    }
  }
  return { data, boxes, spheres: n - boxes };
}
