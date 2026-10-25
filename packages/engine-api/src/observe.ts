// Exact reductions and sparse reads (docs/design/reduce.md). Pure TS, no
// dependencies: everything here is the definition every engine's observer
// must match bit for bit.
import type { Vec3 } from './index.ts';

/** Fixed-point exponent: x is read as the integer quant(x, s) ≈ x·2^s. Integer 0..24; default 16 (2^-16 ≈ 15 µm, 15 µm/s). */
export type Scale = number;

/**
 * Per-body 3-vectors.
 * 'dv': quant(linVel) − quant(prevLinVel) − G, G = quant(gravity·dt); ⊥ for ids not in the
 *       domain at the previous evaluated step.
 * { disp: slot }: quant(pos) − quant(ref[slot]); ⊥ where the slot holds no position.
 */
export type VecSrc = 'pos' | 'linVel' | 'angVel' | 'dv' | { disp: number };

export type Scalar =
  /** One component. i32, |x| < 3·2^29. */
  | { comp: VecSrc; axis: 0 | 1 | 2; s?: Scale }
  /** Σ min(|c|, 2^25)² over the components. 0 ≤ x < 3·2^50. */
  | { norm2: VecSrc; s?: Scale }
  /** Face of the world AABB of the body's own shape. i32. */
  | { aabb: 'lo' | 'hi'; axis: 0 | 1 | 2; s?: Scale }
  /** (tags[word] >>> shift) & (2^bits − 1); shift 0..31 (default 0), bits 1..31 (default 31), shift + bits ≤ 32. Never ⊥. */
  | { tag: number; shift?: number; bits?: number };

export type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type Pred =
  | 'all'
  /** Snapshot awake = 1 (GPU: Body.flags bit 0). Never ⊥. */
  | 'awake'
  /** k: integer, |k| < 2^31 for i32 scalars; 0 ≤ k < 2^50 for norm2. */
  | { cmp: Scalar; op: CmpOp; k: number }
  | { and: readonly Pred[] }
  | { or: readonly Pred[] }
  | { not: Pred };

export type HistBy =
  /** bin = the tag field (same shift/bits rules as the tag scalar); a field ≥ bins goes to `dropped`. */
  | { tag: number; shift?: number; bits: number; bins: number }
  /** bin = #{ j : edges[j] ≤ x }: edges.length + 1 bins. Non-decreasing integers in x's range. */
  | { x: Scalar; edges: readonly number[] };

export type Output =
  | { op: 'count'; where: Pred }
  /** Σ clamp(⌊w·x / 2^shift⌋, ±(2^31 − 1)); w = tags[weight] read as i32 (absent: 1); shift 0..62; x not norm2. */
  | { op: 'sum'; x: Scalar; weight?: number; shift?: number; where: Pred }
  | { op: 'max'; x: Scalar; where: Pred }
  | { op: 'hist'; by: HistBy; where: Pred };

export interface ReduceSpec { outputs: readonly Output[] }

export interface OutResult {
  /** Bodies that contributed: where = true and every scalar valid (hist: binned, not dropped). */
  n: number;
  /** Bodies whose where, x or bin evaluated to ⊥. */
  invalid: number;
  sum?: number;          // exact integer, |sum| < 2^53
  sat?: number;          // sum terms that were clamped
  max?: number | null;   // null when n = 0
  bins?: Uint32Array;
  dropped?: number;
}

export interface ObserverCaps {
  /** Awaiting result(stepIndex − lag) right after step() never waits on that step's GPU work. CPU 0, GPU 1. */
  lag: number;
  /** result(k) rejects for k ≤ stepIndex − keep. 64. */
  keep: number;
  maxBodies: number;     // 2^22
  maxOutputs: number;    // 16
  maxScalars: number;    // 32 distinct scalars
  maxPredNodes: number;  // 64
  maxTagWords: number;   // 4
  maxBins: number;       // 256 per hist
  maxWatch: number;      // 256
  refSlots: number;      // 2
  /** Words of workgroup accumulators the spec needs (counts, sum limbs, max, bins, dropped, n, invalid). 1024. */
  maxRecordWords: number;
  /** Words of the encoded program, edges included. 4096 (16 KB uniform). */
  maxProgramWords: number;
}

/** The caps of §2 with the CPU lag. A GPU observer reports lag 1. */
export const OBSERVER_CAPS: Readonly<ObserverCaps> = Object.freeze({
  lag: 0, keep: 64, maxBodies: 2 ** 22, maxOutputs: 16, maxScalars: 32, maxPredNodes: 64, maxTagWords: 4,
  maxBins: 256, maxWatch: 256, refSlots: 2, maxRecordWords: 1024, maxProgramWords: 4096,
});

const DEFAULT_S = 16;
const I32_K = 2 ** 31;
const NORM2_K = 2 ** 50;
const CMP_OPS: readonly string[] = ['<', '<=', '>', '>=', '==', '!='];

/** A vector source with defaults applied: a ref slot is its number. */
type Src = 'pos' | 'linVel' | 'angVel' | 'dv' | number;

/** A scalar with defaults applied; `key` identifies it, so equal scalars are one table entry. */
type ScalarDef =
  | { kind: 'comp'; key: string; src: Src; axis: number; s: number }
  | { kind: 'norm2'; key: string; src: Src; s: number }
  | { kind: 'aabb'; key: string; hi: boolean; axis: number; s: number }
  | { kind: 'tag'; key: string; word: number; shift: number; bits: number };

interface SpecAnalysis {
  /** Distinct scalars, in first-use order. */
  scalars: ScalarDef[];
  /** Predicate nodes over every output's where, a shared subtree counted at each use. */
  predNodes: number;
  /** s of each distinct 'dv' scalar, each with its own G. */
  dvScales: number[];
  recordWords: number;
  programWords: number;
}

class SpecError extends Error {
  constructor(path: string, msg: string) {
    super(`spec.${path}: ${msg}`);
    this.name = 'SpecError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const show = (v: unknown) => (typeof v === 'number' ? String(v) : JSON.stringify(v));

function fields(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new SpecError(path, `unknown field "${k}"`);
}

function intIn(v: unknown, lo: number, hi: number, path: string, what: string): number {
  if (!isInt(v) || v < lo || v > hi) throw new SpecError(path, `${what} must be an integer ${lo}..${hi}, got ${show(v)}`);
  return v;
}

function below(v: unknown, n: number, path: string, what: string, cap: string): number {
  if (!isInt(v) || v < 0 || v >= n) throw new SpecError(path, `${what} must be an integer below ${cap} = ${n}, got ${show(v)}`);
  return v;
}

interface Bounds { tagWords: number; refSlots: number; maxBins: number }

class Analyzer {
  readonly scalars: ScalarDef[] = [];
  private readonly byKey = new Map<string, ScalarDef>();
  predNodes = 0;
  recordWords = 0;
  edgeWords = 0;
  constructor(private readonly b: Bounds) {}

  private intern(d: ScalarDef): ScalarDef {
    const had = this.byKey.get(d.key);
    if (had) return had;
    this.byKey.set(d.key, d);
    this.scalars.push(d);
    return d;
  }

  private src(v: unknown, path: string): Src {
    if (v === 'pos' || v === 'linVel' || v === 'angVel' || v === 'dv') return v;
    if (isObj(v) && 'disp' in v) {
      fields(v, ['disp'], path);
      return below(v.disp, this.b.refSlots, `${path}.disp`, 'ref slot', 'refSlots');
    }
    throw new SpecError(path, `vector source must be 'pos', 'linVel', 'angVel', 'dv' or { disp: slot }, got ${show(v)}`);
  }

  /** The tag field of a tag scalar or a hist-by-tag, interned as a tag scalar. */
  private tagField(o: Record<string, unknown>, path: string, bitsDefault: number | null): ScalarDef {
    const word = below(o.tag, this.b.tagWords, `${path}.tag`, 'tag word', 'tagWords');
    const shift = o.shift === undefined ? 0 : intIn(o.shift, 0, 31, `${path}.shift`, 'tag shift');
    if (o.bits === undefined && bitsDefault === null) throw new SpecError(path, 'bits is required');
    const bits = o.bits === undefined ? bitsDefault! : intIn(o.bits, 1, 31, `${path}.bits`, 'tag bits');
    if (shift + bits > 32) throw new SpecError(path, `tag shift + bits must be ≤ 32, got ${shift} + ${bits}`);
    return this.intern({ kind: 'tag', key: `tag:${word}:${shift}:${bits}`, word, shift, bits });
  }

  scalar(v: unknown, path: string): ScalarDef {
    if (!isObj(v)) throw new SpecError(path, `scalar must be an object, got ${show(v)}`);
    const scale = () => (v.s === undefined ? DEFAULT_S : intIn(v.s, 0, 24, `${path}.s`, 's'));
    const axis = () => intIn(v.axis, 0, 2, `${path}.axis`, 'axis');
    if ('comp' in v) {
      fields(v, ['comp', 'axis', 's'], path);
      const src = this.src(v.comp, `${path}.comp`), a = axis(), s = scale();
      return this.intern({ kind: 'comp', key: `comp:${src}:${a}:${s}`, src, axis: a, s });
    }
    if ('norm2' in v) {
      fields(v, ['norm2', 's'], path);
      const src = this.src(v.norm2, `${path}.norm2`), s = scale();
      return this.intern({ kind: 'norm2', key: `norm2:${src}:${s}`, src, s });
    }
    if ('aabb' in v) {
      fields(v, ['aabb', 'axis', 's'], path);
      if (v.aabb !== 'lo' && v.aabb !== 'hi') throw new SpecError(`${path}.aabb`, `must be 'lo' or 'hi', got ${show(v.aabb)}`);
      const a = axis(), s = scale();
      return this.intern({ kind: 'aabb', key: `aabb:${v.aabb}:${a}:${s}`, hi: v.aabb === 'hi', axis: a, s });
    }
    if ('tag' in v) {
      fields(v, ['tag', 'shift', 'bits'], path);
      return this.tagField(v, path, 31);
    }
    throw new SpecError(path, 'scalar must have one of comp, norm2, aabb, tag');
  }

  /** k or an edge, in its scalar's range. */
  private bound(x: ScalarDef, k: unknown, path: string, what: string): number {
    const ok = x.kind === 'norm2' ? isInt(k) && k >= 0 && k < NORM2_K : isInt(k) && Math.abs(k) < I32_K;
    if (!ok) throw new SpecError(path, `${what} must be an integer ${x.kind === 'norm2' ? 'in 0 ≤ k < 2^50 for norm2' : 'with |k| < 2^31'}, got ${show(k)}`);
    return k as number;
  }

  pred(p: unknown, path: string): void {
    this.predNodes++;
    if (p === 'all' || p === 'awake') return;
    if (!isObj(p)) throw new SpecError(path, `predicate must be 'all', 'awake' or an object, got ${show(p)}`);
    if ('cmp' in p) {
      fields(p, ['cmp', 'op', 'k'], path);
      const x = this.scalar(p.cmp, `${path}.cmp`);
      if (typeof p.op !== 'string' || !CMP_OPS.includes(p.op)) throw new SpecError(`${path}.op`, `must be one of ${CMP_OPS.join(' ')}, got ${show(p.op)}`);
      this.bound(x, p.k, `${path}.k`, 'k');
      return;
    }
    for (const op of ['and', 'or'] as const)
      if (op in p) {
        fields(p, [op], path);
        const list = p[op];
        if (!Array.isArray(list)) throw new SpecError(`${path}.${op}`, 'must be an array');
        list.forEach((c: unknown, i) => this.pred(c, `${path}.${op}[${i}]`));
        return;
      }
    if ('not' in p) {
      fields(p, ['not'], path);
      this.pred(p.not, `${path}.not`);
      return;
    }
    throw new SpecError(path, 'predicate must have one of cmp, and, or, not');
  }

  private where(o: Record<string, unknown>, path: string): void {
    if (o.where === undefined) throw new SpecError(path, 'where is required');
    this.pred(o.where, `${path}.where`);
  }

  output(o: unknown, path: string): void {
    if (!isObj(o)) throw new SpecError(path, `output must be an object, got ${show(o)}`);
    switch (o.op) {
      case 'count':
        fields(o, ['op', 'where'], path);
        this.where(o, path);
        this.recordWords += 2;
        return;
      case 'sum': {
        fields(o, ['op', 'x', 'weight', 'shift', 'where'], path);
        if (this.scalar(o.x, `${path}.x`).kind === 'norm2') throw new SpecError(`${path}.x`, 'a sum cannot take norm2');
        if (o.weight !== undefined) below(o.weight, this.b.tagWords, `${path}.weight`, 'weight tag word', 'tagWords');
        if (o.shift !== undefined) intIn(o.shift, 0, 62, `${path}.shift`, 'sum shift');
        this.where(o, path);
        this.recordWords += 2 + 5;
        return;
      }
      case 'max':
        fields(o, ['op', 'x', 'where'], path);
        this.scalar(o.x, `${path}.x`);
        this.where(o, path);
        this.recordWords += 2 + 2;
        return;
      case 'hist': {
        fields(o, ['op', 'by', 'where'], path);
        const by = o.by, bp = `${path}.by`;
        if (!isObj(by)) throw new SpecError(bp, `must be an object, got ${show(by)}`);
        let bins: number;
        if ('tag' in by) {
          fields(by, ['tag', 'shift', 'bits', 'bins'], bp);
          this.tagField(by, bp, null);
          bins = intIn(by.bins, 1, this.b.maxBins, `${bp}.bins`, 'bins');
        } else if ('x' in by) {
          fields(by, ['x', 'edges'], bp);
          const x = this.scalar(by.x, `${bp}.x`), edges = by.edges;
          if (!Array.isArray(edges)) throw new SpecError(`${bp}.edges`, 'must be an array');
          if (edges.length + 1 > this.b.maxBins) throw new SpecError(`${bp}.edges`, `${edges.length} edges make ${edges.length + 1} bins, over ${this.b.maxBins}`);
          edges.forEach((e: unknown, j) => {
            const k = this.bound(x, e, `${bp}.edges[${j}]`, 'edge');
            if (j > 0 && k < edges[j - 1]) throw new SpecError(`${bp}.edges[${j}]`, `edges must be non-decreasing, ${k} after ${show(edges[j - 1])}`);
          });
          bins = edges.length + 1;
          this.edgeWords += edges.length * (x.kind === 'norm2' ? 2 : 1);
        } else throw new SpecError(bp, 'must have tag or x');
        this.where(o, path);
        this.recordWords += 2 + bins + 1;
        return;
      }
      default:
        throw new SpecError(`${path}.op`, `must be count, sum, max or hist, got ${show(o.op)}`);
    }
  }
}

function analyze(spec: unknown, b: Bounds): SpecAnalysis {
  if (!isObj(spec) || !Array.isArray(spec.outputs)) throw new SpecError('outputs', 'must be an array');
  fields(spec, ['outputs'], 'outputs');
  const an = new Analyzer(b), n = spec.outputs.length;
  spec.outputs.forEach((o: unknown, i) => an.output(o, `outputs[${i}]`));
  const dvScales: number[] = [];
  for (const d of an.scalars) if ((d.kind === 'comp' || d.kind === 'norm2') && d.src === 'dv') dvScales.push(d.s);
  const programWords = 4 * an.scalars.length + 4 * an.predNodes + 4 * n + an.edgeWords + 3 * dvScales.length;
  return { scalars: an.scalars, predNodes: an.predNodes, dvScales, recordWords: an.recordWords, programWords };
}

const UNBOUNDED: Bounds = { tagWords: Infinity, refSlots: Infinity, maxBins: Infinity };

/**
 * The words a spec needs: a conservative bound that the GPU encoder must fit inside.
 * - recordWords: per output, 2 (n, invalid), plus count 0, sum 5 (four 16-bit
 *   limb words and sat), max 2 (a u64, or a biased i32), hist bins + 1 (dropped).
 * - programWords: 4 per distinct scalar (a hist-by-tag field counts as a tag
 *   scalar), 4 per predicate node (a shared subtree at every use), 4 per output,
 *   1 per edge (2 when x is norm2), and 3 per distinct 'dv' scalar (its G).
 * Throws on a malformed spec. Ranges that depend on caps or tagWords are checkSpec's.
 */
export function specCost(spec: ReduceSpec): { recordWords: number; programWords: number } {
  const a = analyze(spec, UNBOUNDED);
  return { recordWords: a.recordWords, programWords: a.programWords };
}

/** G of a 'dv' scalar at scale s: quant(gravity_a·dt, s) on each axis. */
const gravityStep = (gravity: Vec3, dt: number, s: Scale) => [0, 1, 2].map((a) => quant(gravity[a]! * dt, s));

/** Throws (a SpecError naming the field) on the first rule the spec breaks. Pure: changes nothing. */
export function checkSpec(spec: ReduceSpec, caps: ObserverCaps, tagWords: number, gravity: Vec3, dt: number): void {
  if (!isInt(tagWords) || tagWords < 0 || tagWords > caps.maxTagWords) throw new RangeError(`checkSpec: tagWords must be an integer 0..${caps.maxTagWords}, got ${tagWords}`);
  const a = analyze(spec, { tagWords, refSlots: caps.refSlots, maxBins: caps.maxBins });
  const cap = (what: string, n: number, max: number) => {
    if (n > max) throw new SpecError('outputs', `${n} ${what}, over the cap of ${max}`);
  };
  cap('outputs', spec.outputs.length, caps.maxOutputs);
  cap('distinct scalars', a.scalars.length, caps.maxScalars);
  cap('predicate nodes', a.predNodes, caps.maxPredNodes);
  for (const s of a.dvScales)
    if (gravityStep(gravity, dt, s).includes(null)) throw new SpecError('outputs', `G = quant(gravity·dt, ${s}) is ⊥ on some axis, for a 'dv' scalar at s = ${s}`);
  cap('record words', a.recordWords, caps.maxRecordWords);
  cap('program words', a.programWords, caps.maxProgramWords);
}

const Q_LIMIT = 2 ** 29;

/**
 * quant on v = fround(x)·2^s, with ⊥ as NaN so hot loops stay on numbers.
 * The product is exact (24-bit significand, power-of-two scale), so only the
 * rounding remains: Math.round sends ties up, so odd results move to even.
 */
function quantScaled(v: number): number {
  if (!(Math.abs(v) < Q_LIMIT)) return NaN; // NaN, ±Inf, |v| ≥ 2^29
  let r = Math.round(v);
  if (r - v === 0.5 && r % 2) r -= 1;
  return r + 0; // −0 → +0
}

/** ⊥ (null) for NaN, ±Inf, and |fround(x)|·2^s ≥ 2^29; else fround(x)·2^s rounded to nearest, ties to even, −0 → 0. */
export function quant(x: number, s: Scale): number | null {
  if (!(Number.isInteger(s) && s >= 0 && s <= 24)) throw new RangeError(`quant: s must be an integer 0..24, got ${s}`);
  const r = quantScaled(Math.fround(x) * 2 ** s);
  return Number.isNaN(r) ? null : r;
}
