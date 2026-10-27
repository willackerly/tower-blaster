// The keystone game's spec from §4, as data: the fixture that proves the
// contract covers today's reduceCpu.
import { quant, type Pred, type ReduceSpec, type Scalar } from '../src/index.ts';

export interface KeystoneLevel {
  /** Lot rectangle in (x, z). */
  lot: { min: [number, number]; max: [number, number] };
  /** c.frame.unit, h. */
  unit: number;
  /** c.height. */
  height: number;
}

export const q = (x: number): number => {
  const v = quant(x, 16);
  if (v === null) throw new Error(`quant(${x}, 16) is ⊥`);
  return v;
};
const P = (axis: 0 | 1 | 2): Scalar => ({ comp: 'pos', axis });

/** ⌈j·top·2^10⌉ of top's exact binary value (top > 0). */
export function exactEdge(j: number, top: number): number {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, top);
  const bits = v.getBigUint64(0), e = Number((bits >> 52n) & 0x7ffn), f = bits & ((1n << 52n) - 1n);
  const m = e === 0 ? f : f | (1n << 52n), exp = (e === 0 ? -1074 : e - 1075) + 10;
  const num = BigInt(j) * m;
  if (exp >= 0) return Number(num << BigInt(exp));
  const den = 1n << BigInt(-exp);
  return Number((num + den - 1n) / den);
}

export function keystoneSpec(c: KeystoneLevel): ReduceSpec {
  const h = c.unit, top = Math.max(c.height, 1e-9), { lot } = c;
  const structure: Pred = { cmp: { tag: 0, bits: 1 }, op: '==', k: 1 };
  const inLot = (g: number): Pred[] => [
    { cmp: P(0), op: '>=', k: q(lot.min[0] - g) }, { cmp: P(0), op: '<=', k: q(lot.max[0] + g) },
    { cmp: P(2), op: '>=', k: q(lot.min[1] - g) }, { cmp: P(2), op: '<=', k: q(lot.max[1] + g) }];
  const live: Pred = { and: [{ not: structure }, ...inLot(4 * h), { cmp: P(1), op: '>=', k: q(0.6 * h) }] };
  const inc: Pred = { or: [structure, live] };
  const awakeInc: Pred = { and: ['awake', inc] };
  return {
    outputs: [
      { op: 'count', where: awakeInc }, // nAwake
      { op: 'max', x: { norm2: 'linVel' }, where: awakeInc }, // maxSpeed
      { op: 'max', x: { norm2: 'angVel' }, where: { and: ['awake', structure] } }, // maxAngSpeed: structure only
      { op: 'sum', x: P(1), weight: 1, shift: 16, where: structure }, // pe_mJ
      { op: 'count', where: { and: [structure, { cmp: { norm2: { disp: 0 } }, op: '>', k: Math.floor((0.5 * h * 2 ** 16) ** 2) }] } }, // displaced
      { op: 'count', where: { and: [structure, { not: { and: inLot(0.5 * h) } }] } }, // outOfLot
      { op: 'hist', by: { x: { aabb: 'hi', axis: 1 }, edges: Array.from({ length: 63 }, (_, i) => exactEdge(i + 1, top)) }, where: structure }, // heightHist
      { op: 'hist', by: { tag: 0, shift: 8, bits: 6, bins: 48 }, where: { and: [structure, 'awake', { cmp: { norm2: 'dv' }, op: '>', k: Math.floor((0.8 * 2 ** 16) ** 2) }] } }, // impacts
    ],
  };
}

export const KEYSTONE = { nAwake: 0, maxSpeed: 1, maxAngSpeed: 2, pe: 3, displaced: 4, outOfLot: 5, heightHist: 6, impacts: 7 } as const;
