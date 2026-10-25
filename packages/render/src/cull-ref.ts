// CPU twin of the cull pass (cull.ts), for tests: same interpolation rule,
// same classification, same list order. Plane tests use float64, so bodies
// within EPS of a plane are reported as ambiguous instead of guessed.
import { Body, Shape, TIER } from '@tb/schema';
import { frustumPlanes, MAX_STEP_JUMP, SEGMENTS, type CullFrame } from './cull.ts';

const EPS = 1e-3;
const BO = Object.fromEntries(Body.fields.map((f) => [f.name, f.offset / 4])) as Record<string, number>;
const SO = Object.fromEntries(Shape.fields.map((f) => [f.name, f.offset / 4])) as Record<string, number>;

export interface CpuWorld {
  /** Body[] and prev Body[] words (Float32 view; flags and shape read as u32). */
  bodies: ArrayBuffer;
  prev: ArrayBuffer;
  shapes: ArrayBuffer;
  looks: Uint32Array;
  count: number;
}

export interface RefRecord { pos: number[]; look: number; rot: number[]; half: number[]; slot: number }

export interface CullRef {
  records: Map<number, RefRecord>;
  /** Per segment: slots that must be listed (in order) and slots that may be. */
  must: number[][];
  may: number[][];
}

type Test = 'in' | 'out' | 'maybe';
function classify(planes: Float32Array, c: number[], r: number): Test {
  let worst = Infinity;
  for (let k = 0; k < 6; k++) worst = Math.min(worst, planes[4 * k]! * c[0]! + planes[4 * k + 1]! * c[1]! + planes[4 * k + 2]! * c[2]! + planes[4 * k + 3]! + r);
  return worst > EPS ? 'in' : worst < -EPS ? 'out' : 'maybe';
}

export function cullReference(w: CpuWorld, f: CullFrame): CullRef {
  const bf = new Float32Array(w.bodies), bu = new Uint32Array(w.bodies);
  const pf = new Float32Array(w.prev), pu = new Uint32Array(w.prev);
  const sf = new Float32Array(w.shapes), su = new Uint32Array(w.shapes);
  const cam = frustumPlanes(f.viewProj), light = frustumPlanes(f.lightViewProj);
  const alpha = Math.min(1, Math.max(0, f.alpha));
  const records = new Map<number, RefRecord>();
  const must: number[][] = SEGMENTS.map(() => []), may: number[][] = SEGMENTS.map(() => []);
  for (let i = 0; i < w.count; i++) {
    const o = i * (Body.size / 4);
    const tier = (bu[o + BO.flags!]! >>> 8) & 0xff;
    if (tier === TIER.latticeProxy || tier === TIER.free) continue;
    const shape = bu[o + BO.shape!]!, so = shape * (Shape.size / 4);
    const half = [0, 1, 2].map((k) => sf[so + SO.half! + k]!);
    const kind = su[so + SO.kind!]!;
    let pos = [0, 1, 2].map((k) => bf[o + BO.pos! + k]!);
    let rot = [0, 1, 2, 3].map((k) => bf[o + BO.rot! + k]!);
    const qp = [0, 1, 2].map((k) => pf[o + BO.pos! + k]!), qr = [0, 1, 2, 3].map((k) => pf[o + BO.rot! + k]!);
    const qTier = (pu[o + BO.flags!]! >>> 8) & 0xff;
    const valid = pu[o + BO.shape!] === shape && qTier === tier && qr.reduce((a, x) => a + x * x, 0) > 0.5 && Math.hypot(qp[0]! - pos[0]!, qp[1]! - pos[1]!, qp[2]! - pos[2]!) < MAX_STEP_JUMP;
    if (valid && alpha < 1) {
      pos = pos.map((x, k) => qp[k]! + (x - qp[k]!) * alpha);
      const sgn = qr.reduce((a, x, k) => a + x * rot[k]!, 0) < 0 ? -1 : 1;
      const m = rot.map((x, k) => sgn * qr[k]! + (x - sgn * qr[k]!) * alpha);
      const l = Math.hypot(...m);
      rot = m.map((x) => x / l);
    }
    const rel = pos.map((x, k) => x - f.eye[k]!);
    records.set(i, { pos: rel, look: w.looks[i]!, rot, half, slot: i });
    const seg = Math.min(kind, 1);
    const r = kind === 1 ? half[0]! : Math.hypot(...half);
    const tests: Test[] = f.noCull ? ['in', 'in'] : [classify(cam, rel, r), classify(light, rel, r)];
    tests.forEach((t, j) => {
      const s = seg + 2 * j;
      if (t === 'in') must[s]!.push(i);
      if (t !== 'out') may[s]!.push(i);
    });
  }
  return { records, must, may };
}

/** Whether a GPU list is consistent with the reference: ordered, all musts, only mays. */
export function listMatches(list: number[], must: number[], may: number[]): string | null {
  const allowed = new Set(may), seen = new Set(list);
  for (let k = 1; k < list.length; k++) if (list[k]! <= list[k - 1]!) return `not ascending at ${k}`;
  for (const s of list) if (!allowed.has(s)) return `slot ${s} listed but culled`;
  for (const s of must) if (!seen.has(s)) return `slot ${s} missing`;
  return null;
}
