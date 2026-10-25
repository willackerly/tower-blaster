// A second, deliberately plain reading of §3.3-§3.5: one body at a time,
// recursive, BigInt throughout, sharing no code with reduceRef.
import type { OutResult, Pred, ReduceInput, ReduceSpec, Scalar, VecSrc } from '../src/index.ts';
import { bitsOf, quantBig } from './oracle.ts';

type V = bigint | null;
type Tri = 'T' | 'F' | 'U';

const ONE = 1n << 28n, CLAMP = 1n << 25n, TERM = (1n << 31n) - 1n;
const abs = (x: bigint) => (x < 0n ? -x : x);
const q = (x: number | undefined, s: number): V => quantBig(bitsOf(x ?? NaN), s);

function component(src: VecSrc, inp: ReduceInput, i: number, a: number, s: number): V {
  const { snap } = inp;
  if (src === 'dv') {
    if (i >= inp.prevCount) return null;
    const v = q(snap.linVel[3 * i + a], s), p = q(inp.prevLinVel[3 * i + a], s), g = q(inp.gravity[a]! * inp.dt, s);
    return v === null || p === null || g === null ? null : v - p - g;
  }
  if (typeof src === 'object') {
    const ref = inp.refs[src.disp];
    if (!ref || 3 * i + 3 > ref.length) return null;
    const p = q(snap.pos[3 * i + a], s), r = q(ref[3 * i + a], s);
    return p === null || r === null ? null : p - r;
  }
  return q(snap[src][3 * i + a], s);
}

function tagField(inp: ReduceInput, i: number, word: number, shift: number, bits: number): bigint {
  const t = BigInt((inp.tags[i * inp.tagWords + word] ?? 0) >>> 0);
  return (t >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n);
}

/** The full rotation matrix of §3.3 from Q14 components; throws if an entry leaves ±2^30. */
export function rotation(Q: readonly bigint[]): bigint[][] {
  const [x, y, z, w] = Q as [bigint, bigint, bigint, bigint];
  const R = [
    [ONE - 2n * (y * y + z * z), 2n * (x * y - w * z), 2n * (x * z + w * y)],
    [2n * (x * y + w * z), ONE - 2n * (x * x + z * z), 2n * (y * z - w * x)],
    [2n * (x * z - w * y), 2n * (y * z + w * x), ONE - 2n * (x * x + y * y)],
  ];
  for (const row of R) for (const e of row) if (abs(e) > 1n << 30n) throw new Error(`R entry ${e} beyond 2^30`);
  return R;
}

export function scalar(x: Scalar, inp: ReduceInput, i: number): V {
  if ('comp' in x) return component(x.comp, inp, i, x.axis, x.s ?? 16);
  if ('norm2' in x) {
    let t = 0n;
    for (let a = 0; a < 3; a++) {
      const c = component(x.norm2, inp, i, a, x.s ?? 16);
      if (c === null) return null;
      const m = abs(c) < CLAMP ? abs(c) : CLAMP;
      t += m * m;
    }
    return t;
  }
  if ('aabb' in x) {
    const s = x.s ?? 16, shape = inp.shapes[i]!;
    const P = q(inp.snap.pos[3 * i + x.axis], s);
    const H = (h: number): V => {
      const v = q(h, s);
      return v !== null && v >= 0n && v <= 1n << 20n ? v : null;
    };
    let ext: V;
    if (shape.kind === 'sphere') ext = H(shape.radius);
    else {
      const hs = shape.half.map(H);
      const Q = [0, 1, 2, 3].map((c) => {
        const v = q(inp.snap.rot[4 * i + c], 14);
        return v !== null && abs(v) <= 1n << 14n ? v : null;
      });
      if (hs.includes(null) || Q.includes(null)) ext = null;
      else {
        const row = rotation(Q as bigint[])[x.axis]!;
        ext = (abs(row[0]!) * hs[0]! + abs(row[1]!) * hs[1]! + abs(row[2]!) * hs[2]!) / ONE;
      }
    }
    if (P === null || ext === null) return null;
    return x.aabb === 'hi' ? P + ext : P - ext;
  }
  return tagField(inp, i, x.tag, x.shift ?? 0, x.bits ?? 31);
}

export function pred(p: Pred, inp: ReduceInput, i: number): Tri {
  if (p === 'all') return 'T';
  if (p === 'awake') return inp.snap.awake[i] === 1 ? 'T' : 'F';
  if ('cmp' in p) {
    const v = scalar(p.cmp, inp, i);
    if (v === null) return 'U';
    const k = BigInt(p.k);
    const r = { '<': v < k, '<=': v <= k, '>': v > k, '>=': v >= k, '==': v === k, '!=': v !== k }[p.op];
    return r ? 'T' : 'F';
  }
  if ('and' in p) {
    for (const c of p.and) {
      const r = pred(c, inp, i);
      if (r !== 'T') return r;
    }
    return 'T';
  }
  if ('or' in p) {
    for (const c of p.or) {
      const r = pred(c, inp, i);
      if (r !== 'F') return r;
    }
    return 'F';
  }
  const r = pred(p.not, inp, i);
  return r === 'U' ? 'U' : r === 'T' ? 'F' : 'T';
}

function floorDiv(a: bigint, d: bigint): bigint {
  const t = a / d;
  return a < 0n && t * d !== a ? t - 1n : t;
}

export function naiveReduce(spec: ReduceSpec, inp: ReduceInput, lo = 0, hi = inp.snap.count): OutResult[] {
  return spec.outputs.map((o) => {
    let n = 0, invalid = 0, sat = 0, dropped = 0, sum = 0n, max: bigint | null = null;
    const bins = o.op === 'hist' ? new Uint32Array('bins' in o.by ? o.by.bins : o.by.edges.length + 1) : null;
    for (let i = lo; i < hi; i++) {
      const w = pred(o.where, inp, i);
      if (w === 'F') continue;
      if (w === 'U') {
        invalid++;
        continue;
      }
      if (o.op === 'count') {
        n++;
        continue;
      }
      if (o.op === 'hist' && 'bins' in o.by) {
        const f = Number(tagField(inp, i, o.by.tag, o.by.shift ?? 0, o.by.bits));
        if (f >= o.by.bins) dropped++;
        else {
          bins![f]!++;
          n++;
        }
        continue;
      }
      const x = scalar(o.op === 'hist' ? (o.by as { x: Scalar }).x : o.x, inp, i);
      if (x === null) {
        invalid++;
        continue;
      }
      n++;
      if (o.op === 'sum') {
        const wt = o.weight === undefined ? 1n : BigInt((inp.tags[i * inp.tagWords + o.weight] ?? 0) | 0);
        let t = floorDiv(wt * x, 1n << BigInt(o.shift ?? 0));
        if (t > TERM || t < -TERM) {
          t = t > 0n ? TERM : -TERM;
          sat++;
        }
        sum += t;
      } else if (o.op === 'max') max = max === null || x > max ? x : max;
      else bins![(o.by as { edges: readonly number[] }).edges.filter((e) => BigInt(e) <= x).length]!++;
    }
    switch (o.op) {
      case 'count': return { n, invalid };
      case 'sum': return { n, invalid, sum: Number(sum), sat };
      case 'max': return { n, invalid, max: max === null ? null : Number(max) };
      case 'hist': return { n, invalid, bins: bins!, dropped };
    }
  });
}
