// What the game draws: structure bodies coloured by role and material, live
// ammo, and arc-preview beads, packed into the viewer's RenderInstance layout
// (boxes first, spheres after). The Regrow animation on retry scales each
// body up from its base, course by course; it only changes what is drawn.
import type { BodyDesc, Snapshot } from '@tb/engine-api';
import { type CompiledLevel, MATERIALS } from '@tb/keystone';
import { RenderInstance } from '@tb/schema';
import type { Packed } from '@tb/viewer';

const STRIDE = RenderInstance.size / 4;
const OFF = Object.fromEntries(RenderInstance.fields.map((f) => [f.name, f.offset / 4])) as Record<'pos' | 'palette' | 'rot' | 'half' | 'shape', number>;

/** Viewer palette slots: 0 coral, 1 amber, 2 teal, 3 blue, 4 purple, 5 cream, 6 dark, 7 grey. */
export const SLOT = { crown: 1, heritage: 2, ammo: 6, bead: 0, beadOut: 7 } as const;
const MATERIAL_SLOT: Record<string, number> = { plaster: 5, stone: 7, iron: 6, ice: 3, rubber: 4, steel: 6 };

/** Role wins over material: crowns are gold and heritage is celadon whatever they are made of. */
export function paletteFor(c: CompiledLevel, i: number): number {
  const role = c.meta.role[i];
  if (role === 1) return SLOT.crown;
  if (role === 2) return SLOT.heritage;
  return MATERIAL_SLOT[MATERIALS[c.meta.material[i]!]!.name] ?? 5;
}

export const BEAD_RADIUS = 0.06;
export const TARGET_SCALE = 1.8;
export const REGROW_STAGGER = 0.035; // s per course
export const REGROW_GROW = 0.3; // s per body

/** Ease-out with a little overshoot: 0 at x = 0, 1 at x = 1, peaks about 1.1. */
export function easeOutBack(x: number): number {
  const k = 1.70158, u = Math.min(1, Math.max(0, x)) - 1;
  return 1 + (k + 1) * u * u * u + k * u * u;
}

/** Scale of a body on course `course`, `t` seconds into Regrow. */
export function regrowScale(t: number, course: number): number {
  return easeOutBack((t - course * REGROW_STAGGER) / REGROW_GROW);
}
export const regrowDuration = (courses: number) => Math.max(0, courses - 1) * REGROW_STAGGER + REGROW_GROW;

export interface DrawOptions {
  /** Packed xyz bead centres, drawn as small spheres. */
  beads?: Float64Array;
  beadsReachable?: boolean;
  /** Seconds into Regrow, or null when not regrowing. */
  regrowT?: number | null;
}

/**
 * Pack a snapshot (structure bodies, then ammo spawned in order: `ammo[k]`
 * is body n + k) plus preview beads.
 */
export function packScene(s: Snapshot, c: CompiledLevel, ammo: BodyDesc[], o: DrawOptions = {}, out?: ArrayBuffer): Packed {
  const n = c.meta.n, h = c.frame.unit;
  const shapeOf = (i: number): BodyDesc['shape'] => (i < n ? c.scene.bodies[i]! : ammo[i - n]!).shape;
  const beads = o.beads ?? new Float64Array(0), nb = beads.length / 3;
  const total = s.count + nb;
  const bytes = Math.max(RenderInstance.size, total * RenderInstance.size);
  const data = out && out.byteLength >= bytes ? out : new ArrayBuffer(bytes);
  const f = new Float32Array(data), u = new Uint32Array(data);
  let boxes = 0;
  for (let i = 0; i < s.count; i++) if (shapeOf(i).kind === 'box') boxes++;
  let bi = 0, si = boxes;
  for (let i = 0; i < s.count; i++) {
    const shape = shapeOf(i);
    const o4 = (shape.kind === 'box' ? bi++ : si++) * STRIDE;
    let scale = 1;
    if (o.regrowT != null && i < n) scale = Math.max(0, regrowScale(o.regrowT, Math.floor(c.meta.home[3 * i + 1]! / h)));
    const hy = shape.kind === 'box' ? shape.half[1] : shape.radius;
    f[o4 + OFF.pos] = s.pos[3 * i]!;
    f[o4 + OFF.pos + 1] = s.pos[3 * i + 1]! - hy * (1 - scale); // grow up from the base
    f[o4 + OFF.pos + 2] = s.pos[3 * i + 2]!;
    u[o4 + OFF.palette] = i < n ? paletteFor(c, i) : SLOT.ammo;
    for (let k = 0; k < 4; k++) f[o4 + OFF.rot + k] = s.rot[4 * i + k]!;
    if (shape.kind === 'box') {
      for (let k = 0; k < 3; k++) f[o4 + OFF.half + k] = shape.half[k]! * scale;
      u[o4 + OFF.shape] = 0;
    } else {
      f[o4 + OFF.half] = f[o4 + OFF.half + 1] = f[o4 + OFF.half + 2] = shape.radius * scale;
      u[o4 + OFF.shape] = 1;
    }
  }
  for (let k = 0; k < nb; k++) {
    const o4 = si++ * STRIDE;
    f.set(beads.subarray(3 * k, 3 * k + 3), o4 + OFF.pos);
    u[o4 + OFF.palette] = o.beadsReachable === false ? SLOT.beadOut : SLOT.bead;
    f.set([0, 0, 0, 1], o4 + OFF.rot);
    // Beads shrink along the arc so its direction reads at a glance; the last marks the aim point.
    const r = k === nb - 1 ? BEAD_RADIUS * TARGET_SCALE : BEAD_RADIUS * (1 - (0.5 * k) / Math.max(1, nb));
    f[o4 + OFF.half] = f[o4 + OFF.half + 1] = f[o4 + OFF.half + 2] = r;
    u[o4 + OFF.shape] = 1;
  }
  return { data, boxes, spheres: total - boxes };
}
