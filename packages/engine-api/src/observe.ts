// Exact reductions and sparse reads (docs/design/reduce.md). Pure TS, no
// dependencies: everything here is the definition every engine's observer
// must match bit for bit.
import type { PhysicsEngine, ShapeDesc, Snapshot, Vec3 } from './index.ts';

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

/** Exact copies of snapshot() rows. present 0 unless 0 ≤ id < count (then zeros, rot (0, 0, 0, 1), awake 0). */
export interface BodyRows {
  ids: Int32Array;
  present: Uint8Array;
  pos: Float64Array;     // 3 per row
  rot: Float64Array;     // 4 per row
  linVel: Float64Array;  // 3 per row
  angVel: Float64Array;  // 3 per row
  awake: Uint8Array;
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

export interface Observation {
  /** Steps taken when the state was sampled. */
  step: number;
  /** Domain: ids 0 .. count − 1. */
  count: number;
  /** One per spec output, in order. */
  out: OutResult[];
  /** The watch list in force for that step, in its order. */
  rows: BodyRows;
}

export interface ObserveOptions {
  /** u32 tag words per id, fixed for the observer's life (0..maxTagWords). */
  tagWords: number;
}

export interface Observer {
  readonly caps: ObserverCaps;
  /**
   * Standing query, evaluated after every step from the next step() on; null stops it.
   * A bad spec throws (checkSpec) and changes nothing. The first query after observe(),
   * or after query(null), sets prev := linVel of the current state (ids < count).
   */
  query(spec: ReduceSpec | null): void;
  /** Rows gathered into every observation from the next step() on. Any order, duplicates allowed, ≤ maxWatch. */
  watch(ids: Int32Array): void;
  /** Tags of ids first .. first + words.length / tagWords − 1, from the next step() on. Words never set read 0. */
  setTags(first: number, words: Uint32Array): void;
  /** ref[slot] := pos of ids < count in the current state (after the last step taken). Other ids, and slots never captured, are ⊥. */
  captureRef(slot: number): void;
  /** The observation of the state after `step` steps. Rejects if no query was active for that step, step > stepIndex, or step ≤ stepIndex − keep. */
  result(step: number): Promise<Observation>;
}

/** Any engine observed through snapshot() after every step (lag 0). Mirrors the engine's id assignment from init() and its spawns. */
export interface ObservedEngine extends PhysicsEngine {
  readonly inner: PhysicsEngine;
  observe(opts: ObserveOptions): Promise<Observer>;
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

/** A scalar with defaults applied. Equal keys are one scalar, one table entry. */
type ScalarDef =
  | { kind: 'comp'; key: string; src: Src; axis: number; s: number }
  | { kind: 'norm2'; key: string; src: Src; s: number }
  | { kind: 'aabb'; key: string; hi: boolean; axis: number; s: number }
  | { kind: 'tag'; key: string; word: number; shift: number; bits: number };

/** A distinct predicate node; x and children are table indices, children before parents. */
type PredDef =
  | { t: 'all' | 'awake' }
  | { t: 'cmp'; x: number; mask: number; k: number }
  | { t: 'and' | 'or'; c: number[] }
  | { t: 'not'; c: number };

/** An output with defaults applied; x and where are table indices. A hist by tag bins its tag scalar. */
type OutDef =
  | { op: 'count'; where: number }
  | { op: 'sum'; where: number; x: number; weight: number | null; shift: number }
  | { op: 'max'; where: number; x: number }
  | { op: 'hist'; where: number; x: number; bins: number; edges: readonly number[] | null };

interface SpecAnalysis {
  /** Distinct scalars, in first-use order. */
  scalars: ScalarDef[];
  preds: PredDef[];
  outs: OutDef[];
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

// cmp as a mask over the sign of x − k.
const LT = 1, EQ = 2, GT = 4;
const CMP_MASK: Record<string, number> = { '<': LT, '<=': LT | EQ, '>': GT, '>=': GT | EQ, '==': EQ, '!=': LT | GT };

class Analyzer {
  readonly scalars: ScalarDef[] = [];
  readonly preds: PredDef[] = [];
  private readonly scalarAt = new Map<string, number>();
  private readonly predAt = new Map<string, number>();
  /** Per predicate object: its table index and node count, or null while it is being walked. */
  private readonly predSeen = new Map<object, { i: number; nodes: number } | null>();
  predNodes = 0;
  recordWords = 0;
  edgeWords = 0;
  constructor(private readonly b: Bounds) {}

  private intern(d: ScalarDef): number {
    let i = this.scalarAt.get(d.key);
    if (i === undefined) {
      this.scalarAt.set(d.key, (i = this.scalars.length));
      this.scalars.push(d);
    }
    return i;
  }

  private internPred(key: string, d: PredDef): number {
    let i = this.predAt.get(key);
    if (i === undefined) {
      this.predAt.set(key, (i = this.preds.length));
      this.preds.push(d);
    }
    return i;
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
  private tagField(o: Record<string, unknown>, path: string, bitsDefault: number | null): number {
    const word = below(o.tag, this.b.tagWords, `${path}.tag`, 'tag word', 'tagWords');
    const shift = o.shift === undefined ? 0 : intIn(o.shift, 0, 31, `${path}.shift`, 'tag shift');
    if (o.bits === undefined && bitsDefault === null) throw new SpecError(path, 'bits is required');
    const bits = o.bits === undefined ? bitsDefault! : intIn(o.bits, 1, 31, `${path}.bits`, 'tag bits');
    if (shift + bits > 32) throw new SpecError(path, `tag shift + bits must be ≤ 32, got ${shift} + ${bits}`);
    return this.intern({ kind: 'tag', key: `tag:${word}:${shift}:${bits}`, word, shift, bits });
  }

  scalar(v: unknown, path: string): number {
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
  private bound(x: number, k: unknown, path: string, what: string): number {
    const norm2 = this.scalars[x]!.kind === 'norm2';
    const ok = norm2 ? isInt(k) && k >= 0 && k < NORM2_K : isInt(k) && Math.abs(k) < I32_K;
    if (!ok) throw new SpecError(path, `${what} must be an integer ${norm2 ? 'in 0 ≤ k < 2^50 for norm2' : 'with |k| < 2^31'}, got ${show(k)}`);
    return k as number;
  }

  /** A subtree shared by object is walked once and counted at every use, so a doubling DAG costs its depth, not 2^depth. */
  pred(p: unknown, path: string): number {
    if (!isObj(p)) return this.node(p, path);
    const seen = this.predSeen.get(p);
    if (seen === null) throw new SpecError(path, 'a predicate cannot contain itself');
    if (seen) {
      this.predNodes += seen.nodes;
      return seen.i;
    }
    this.predSeen.set(p, null);
    const before = this.predNodes, i = this.node(p, path);
    this.predSeen.set(p, { i, nodes: this.predNodes - before });
    return i;
  }

  private node(p: unknown, path: string): number {
    this.predNodes++;
    if (p === 'all' || p === 'awake') return this.internPred(p, { t: p });
    if (!isObj(p)) throw new SpecError(path, `predicate must be 'all', 'awake' or an object, got ${show(p)}`);
    if ('cmp' in p) {
      fields(p, ['cmp', 'op', 'k'], path);
      const x = this.scalar(p.cmp, `${path}.cmp`);
      if (typeof p.op !== 'string' || !CMP_OPS.includes(p.op)) throw new SpecError(`${path}.op`, `must be one of ${CMP_OPS.join(' ')}, got ${show(p.op)}`);
      const k = this.bound(x, p.k, `${path}.k`, 'k'), mask = CMP_MASK[p.op]!;
      return this.internPred(`cmp ${x} ${mask} ${k}`, { t: 'cmp', x, mask, k });
    }
    for (const t of ['and', 'or'] as const)
      if (t in p) {
        fields(p, [t], path);
        const list = p[t];
        if (!Array.isArray(list)) throw new SpecError(`${path}.${t}`, 'must be an array');
        const c = list.map((q: unknown, i) => this.pred(q, `${path}.${t}[${i}]`));
        return this.internPred(`${t} ${c.join(' ')}`, { t, c });
      }
    if ('not' in p) {
      fields(p, ['not'], path);
      const c = this.pred(p.not, `${path}.not`);
      return this.internPred(`not ${c}`, { t: 'not', c });
    }
    throw new SpecError(path, 'predicate must have one of cmp, and, or, not');
  }

  private where(o: Record<string, unknown>, path: string): number {
    if (o.where === undefined) throw new SpecError(path, 'where is required');
    return this.pred(o.where, `${path}.where`);
  }

  output(o: unknown, path: string): OutDef {
    if (!isObj(o)) throw new SpecError(path, `output must be an object, got ${show(o)}`);
    switch (o.op) {
      case 'count':
        fields(o, ['op', 'where'], path);
        this.recordWords += 2;
        return { op: 'count', where: this.where(o, path) };
      case 'sum': {
        fields(o, ['op', 'x', 'weight', 'shift', 'where'], path);
        const x = this.scalar(o.x, `${path}.x`);
        if (this.scalars[x]!.kind === 'norm2') throw new SpecError(`${path}.x`, 'a sum cannot take norm2');
        const weight = o.weight === undefined ? null : below(o.weight, this.b.tagWords, `${path}.weight`, 'weight tag word', 'tagWords');
        const shift = o.shift === undefined ? 0 : intIn(o.shift, 0, 62, `${path}.shift`, 'sum shift');
        this.recordWords += 2 + 5;
        return { op: 'sum', where: this.where(o, path), x, weight, shift };
      }
      case 'max': {
        fields(o, ['op', 'x', 'where'], path);
        const x = this.scalar(o.x, `${path}.x`);
        this.recordWords += 2 + 2;
        return { op: 'max', where: this.where(o, path), x };
      }
      case 'hist': {
        fields(o, ['op', 'by', 'where'], path);
        const by = o.by, bp = `${path}.by`;
        if (!isObj(by)) throw new SpecError(bp, `must be an object, got ${show(by)}`);
        let x: number, bins: number, edges: number[] | null = null;
        if ('tag' in by) {
          fields(by, ['tag', 'shift', 'bits', 'bins'], bp);
          x = this.tagField(by, bp, null);
          bins = intIn(by.bins, 1, this.b.maxBins, `${bp}.bins`, 'bins');
        } else if ('x' in by) {
          fields(by, ['x', 'edges'], bp);
          x = this.scalar(by.x, `${bp}.x`);
          if (!Array.isArray(by.edges)) throw new SpecError(`${bp}.edges`, 'must be an array');
          const e = by.edges as unknown[];
          if (e.length + 1 > this.b.maxBins) throw new SpecError(`${bp}.edges`, `${e.length} edges make ${e.length + 1} bins, over ${this.b.maxBins}`);
          edges = e.map((v, j) => this.bound(x, v, `${bp}.edges[${j}]`, 'edge'));
          for (let j = 1; j < edges.length; j++)
            if (edges[j]! < edges[j - 1]!) throw new SpecError(`${bp}.edges[${j}]`, `edges must be non-decreasing, ${edges[j]} after ${edges[j - 1]}`);
          bins = edges.length + 1;
          this.edgeWords += edges.length * (this.scalars[x]!.kind === 'norm2' ? 2 : 1);
        } else throw new SpecError(bp, 'must have tag or x');
        this.recordWords += 2 + bins + 1;
        return { op: 'hist', where: this.where(o, path), x, bins, edges };
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
  const outs = spec.outputs.map((o: unknown, i) => an.output(o, `outputs[${i}]`));
  const dvScales: number[] = [];
  for (const d of an.scalars) if ((d.kind === 'comp' || d.kind === 'norm2') && d.src === 'dv') dvScales.push(d.s);
  const programWords = 4 * an.scalars.length + 4 * an.predNodes + 4 * n + an.edgeWords + 3 * dvScales.length;
  return { scalars: an.scalars, preds: an.preds, outs, predNodes: an.predNodes, dvScales, recordWords: an.recordWords, programWords };
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

export interface ReduceInput {
  snap: Snapshot;                          // state after step k; domain = ids < snap.count
  prevLinVel: Float64Array;                // linVel of the previous evaluated state, 3 per id, ids < prevCount
  prevCount: number;
  shapes: readonly ShapeDesc[];            // per id, length ≥ snap.count
  tagWords: number;
  tags: Uint32Array;                       // tagWords per id; beyond its length reads 0
  refs: readonly (Float64Array | null)[];  // per slot; 3 per id for ids < length / 3
  gravity: Vec3;
  dt: number;
}

const MAX_BODIES = 2 ** 22;
// Bodies per pass: scalar columns and predicate rows are evaluated a chunk at a time.
const CHUNK = 1024;
// Predicate rows: three-valued.
const F = 0, T = 1, U = 2;
const TERM_MAX = 2 ** 31 - 1;
const ONE_Q14 = 2 ** 14, ONE_R = 2 ** 28, H_MAX = 2 ** 20, NORM2_CLAMP = 2 ** 25;
const fround = Math.fround;

/** Fills the columns of one chunk, ids b0 .. b1 − 1. */
type Fill = (b0: number, b1: number) => void;

/**
 * Fills the quantized components of a state vector (3 columns, NaN for ⊥).
 * x holds 3 per id; ids ≥ n read ⊥.
 */
function quantFill(x: Float64Array, n: number, s: number, out: Float64Array[]): Fill {
  const sc = 2 ** s, [o0, o1, o2] = out as [Float64Array, Float64Array, Float64Array];
  return (b0, b1) => {
    for (let i = b0, j = 0; i < b1; i++, j++) {
      if (i < n) {
        o0[j] = quantScaled(fround(x[3 * i]!) * sc);
        o1[j] = quantScaled(fround(x[3 * i + 1]!) * sc);
        o2[j] = quantScaled(fround(x[3 * i + 2]!) * sc);
      } else o0[j] = o1[j] = o2[j] = NaN;
    }
  };
}

/** out = a − b − g per component, ⊥ wherever a or b is. */
function diffFill(a: Float64Array[], b: Float64Array[], g: readonly number[], out: Float64Array[]): Fill {
  return (b0, b1) => {
    for (let c = 0; c < 3; c++) {
      const x = a[c]!, y = b[c]!, o = out[c]!, gc = g[c]!;
      for (let j = 0; j < b1 - b0; j++) o[j] = x[j]! - y[j]! - gc;
    }
  };
}

/** H: ⊥ unless 0 ≤ H ≤ 2^20, so a negative half extent is never read as a large one. */
function halfQ(h: number, sc: number): number {
  const q = quantScaled(fround(h) * sc);
  return q >= 0 && q <= H_MAX ? q : NaN;
}

/** Q14 quaternion component: ⊥ beyond ±2^14, which keeps every R entry within ±2^30. */
function q14(c: number): number {
  const q = quantScaled(fround(c) * ONE_Q14);
  return Math.abs(q) <= ONE_Q14 ? q : NaN;
}

/** ext_a = ⌊Σ_b |R_ab|·H_b / 2^28⌋ for row a of R = 2^28·I − 2(…). Every product and sum is an exact double. */
function boxExt(half: readonly number[], rot: Float64Array, i: number, a: number, sc: number): number {
  const h0 = halfQ(half[0]!, sc), h1 = halfQ(half[1]!, sc), h2 = halfQ(half[2]!, sc);
  const x = q14(rot[4 * i]!), y = q14(rot[4 * i + 1]!), z = q14(rot[4 * i + 2]!), w = q14(rot[4 * i + 3]!);
  let r0: number, r1: number, r2: number;
  if (a === 0) {
    r0 = ONE_R - 2 * (y * y + z * z); r1 = 2 * (x * y - w * z); r2 = 2 * (x * z + w * y);
  } else if (a === 1) {
    r0 = 2 * (x * y + w * z); r1 = ONE_R - 2 * (x * x + z * z); r2 = 2 * (y * z - w * x);
  } else {
    r0 = 2 * (x * z - w * y); r1 = 2 * (y * z + w * x); r2 = ONE_R - 2 * (x * x + y * y);
  }
  return Math.floor((Math.abs(r0) * h0 + Math.abs(r1) * h1 + Math.abs(r2) * h2) / ONE_R);
}

/** Column storage for one reduceRef call: vector columns are filled before the scalars that read them. */
class Columns {
  readonly fills: Fill[] = [];
  private readonly vecs = new Map<string, Float64Array[]>();
  constructor(private readonly inp: ReduceInput) {}

  /** The quantized components of a vector source at s, shared by every scalar that reads it. */
  vec(src: Src | 'prev' | `ref${number}`, s: number): Float64Array[] {
    const key = `${src}:${s}`, had = this.vecs.get(key);
    if (had) return had;
    const { snap } = this.inp, v = [new Float64Array(CHUNK), new Float64Array(CHUNK), new Float64Array(CHUNK)];
    let fill: Fill;
    if (src === 'dv') {
      // A ⊥ G (checkSpec rejects such specs) leaves dv ⊥ everywhere.
      const g = [0, 1, 2].map((a) => quantScaled(fround(this.inp.gravity[a]! * this.inp.dt) * 2 ** s));
      fill = diffFill(this.vec('linVel', s), this.vec('prev', s), g, v);
    } else if (typeof src === 'number') fill = diffFill(this.vec('pos', s), this.vec(`ref${src}`, s), [0, 0, 0], v);
    else if (src === 'prev') fill = quantFill(this.inp.prevLinVel, this.inp.prevCount, s, v);
    else if (src.startsWith('ref')) {
      const ref = this.inp.refs[Number(src.slice(3))] ?? null;
      fill = quantFill(ref ?? new Float64Array(0), ref ? Math.floor(ref.length / 3) : 0, s, v);
    } else fill = quantFill(snap[src as 'pos' | 'linVel' | 'angVel'], snap.count, s, v);
    this.vecs.set(key, v);
    this.fills.push(fill);
    return v;
  }

  scalar(d: ScalarDef): Float64Array {
    const inp = this.inp;
    if (d.kind === 'comp') return this.vec(d.src, d.s)[d.axis]!;
    const col = new Float64Array(CHUNK);
    if (d.kind === 'norm2') {
      const [c0, c1, c2] = this.vec(d.src, d.s) as [Float64Array, Float64Array, Float64Array];
      this.fills.push((b0, b1) => {
        for (let j = 0; j < b1 - b0; j++) {
          const x = Math.min(Math.abs(c0[j]!), NORM2_CLAMP), y = Math.min(Math.abs(c1[j]!), NORM2_CLAMP), z = Math.min(Math.abs(c2[j]!), NORM2_CLAMP);
          col[j] = x * x + y * y + z * z;
        }
      });
    } else if (d.kind === 'aabb') {
      const sc = 2 ** d.s, a = d.axis, sign = d.hi ? 1 : -1, rot = inp.snap.rot, shapes = inp.shapes, p = this.vec('pos', d.s)[a]!;
      if (shapes.length < inp.snap.count) throw new RangeError(`reduceRef: ${shapes.length} shapes for ${inp.snap.count} bodies`);
      this.fills.push((b0, b1) => {
        for (let i = b0, j = 0; i < b1; i++, j++) {
          const sh = shapes[i]!;
          // A sphere's extent is its radius on every axis: no R, so its quaternion is never read.
          col[j] = p[j]! + sign * (sh.kind === 'sphere' ? halfQ(sh.radius, sc) : boxExt(sh.half, rot, i, a, sc));
        }
      });
    } else {
      const { tags, tagWords } = inp, { word, shift } = d, mask = 2 ** d.bits - 1;
      this.fills.push((b0, b1) => {
        for (let i = b0, j = 0; i < b1; i++, j++) col[j] = ((tags[i * tagWords + word] ?? 0) >>> shift) & mask;
      });
    }
    return col;
  }
}

/** Fills row p of the predicate table; children rows are already filled. */
function evalPred(d: PredDef, rows: Uint8Array[], p: number, cols: Float64Array[], awake: Uint8Array, b0: number, m: number): void {
  const out = rows[p]!;
  switch (d.t) {
    case 'all':
      out.fill(T, 0, m);
      return;
    case 'awake':
      for (let j = 0; j < m; j++) out[j] = awake[b0 + j] === 1 ? T : F;
      return;
    case 'cmp': {
      const col = cols[d.x]!, { k, mask } = d;
      for (let j = 0; j < m; j++) {
        const v = col[j]!;
        out[j] = v !== v ? U : mask & (v < k ? LT : v > k ? GT : EQ) ? T : F;
      }
      return;
    }
    case 'and':
    case 'or': {
      // Left to right: the first operand that is not the identity (T for and,
      // F for or) decides, so a ⊥ after an F in an and is never reached.
      const id = d.t === 'and' ? T : F;
      out.fill(id, 0, m);
      for (const c of d.c) {
        const row = rows[c]!;
        for (let j = 0; j < m; j++) if (out[j] === id) out[j] = row[j]!;
      }
      return;
    }
    case 'not': {
      const row = rows[d.c]!;
      for (let j = 0; j < m; j++) {
        const v = row[j]!;
        out[j] = v === U ? U : v === T ? F : T;
      }
    }
  }
}

/** t = clamp(⌊w·x / 2^shift⌋, ±(2^31 − 1)), exact: BigInt only once |w·x| may pass 2^53. */
function sumTerm(w: number, x: number, shift: number, div: number): number {
  const p = w * x;
  return Math.abs(p) < 2 ** 53 ? Math.floor(p / div) : Number((BigInt(w) * BigInt(x)) >> BigInt(shift));
}

/** Number of edges ≤ x. */
function upperBound(edges: readonly number[], x: number): number {
  let lo = 0, hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function emptyOut(o: OutDef): OutResult {
  switch (o.op) {
    case 'count': return { n: 0, invalid: 0 };
    case 'sum': return { n: 0, invalid: 0, sum: 0, sat: 0 };
    case 'max': return { n: 0, invalid: 0, max: null };
    case 'hist': return { n: 0, invalid: 0, bins: new Uint32Array(o.bins), dropped: 0 };
  }
}

function accumulate(o: OutDef, r: OutResult, where: Uint8Array, col: Float64Array | null, inp: ReduceInput, b0: number, m: number): void {
  let n = 0, invalid = 0;
  if (o.op === 'count') {
    for (let j = 0; j < m; j++) {
      const w = where[j];
      if (w === T) n++;
      else if (w === U) invalid++;
    }
  } else {
    const { tags, tagWords } = inp, weight = o.op === 'sum' ? o.weight : null, shift = o.op === 'sum' ? o.shift : 0, div = 2 ** shift;
    let sum = 0, sat = 0, max = r.max ?? -Infinity, dropped = 0;
    for (let j = 0; j < m; j++) {
      const w = where[j];
      if (w === F) continue;
      const x = col![j]!;
      if (w === U || x !== x) {
        invalid++;
        continue;
      }
      if (o.op === 'sum') {
        let t = sumTerm(weight === null ? 1 : (tags[(b0 + j) * tagWords + weight] ?? 0) | 0, x, shift, div);
        if (t > TERM_MAX || t < -TERM_MAX) {
          t = t > 0 ? TERM_MAX : -TERM_MAX;
          sat++;
        }
        sum += t;
      } else if (o.op === 'max') {
        if (x > max) max = x;
      } else {
        const bin = o.edges ? upperBound(o.edges, x) : x;
        if (bin >= o.bins) {
          dropped++;
          continue;
        }
        r.bins![bin]! += 1;
      }
      n++;
    }
    if (o.op === 'sum') {
      r.sum! += sum;
      r.sat! += sat;
    } else if (o.op === 'max') r.max = r.n + n > 0 ? max : null;
    else r.dropped! += dropped;
  }
  r.n += n;
  r.invalid += invalid;
}

/**
 * The definition of every observation: spec over ids lo .. hi − 1 of inp
 * (default: the whole domain), with plain doubles where they are exact.
 */
export function reduceRef(spec: ReduceSpec, inp: ReduceInput, lo = 0, hi = inp.snap.count): OutResult[] {
  const { snap } = inp;
  if (snap.count > MAX_BODIES) throw new RangeError(`reduceRef: ${snap.count} bodies, over 2^22: sums could pass 2^53`);
  if (!(isInt(lo) && isInt(hi) && lo >= 0 && lo <= hi && hi <= snap.count)) throw new RangeError(`reduceRef: bad id range ${lo}..${hi} for ${snap.count} bodies`);
  const a = analyze(spec, { tagWords: inp.tagWords, refSlots: Infinity, maxBins: Infinity });
  const columns = new Columns(inp), cols = a.scalars.map((d) => columns.scalar(d)), rows = a.preds.map(() => new Uint8Array(CHUNK));
  const out = a.outs.map(emptyOut);
  for (let b0 = lo; b0 < hi; b0 += CHUNK) {
    const b1 = Math.min(hi, b0 + CHUNK), m = b1 - b0;
    for (const f of columns.fills) f(b0, b1);
    a.preds.forEach((d, p) => evalPred(d, rows, p, cols, snap.awake, b0, m));
    a.outs.forEach((o, i) => accumulate(o, out[i]!, rows[o.where]!, o.op === 'count' ? null : cols[o.x]!, inp, b0, m));
  }
  return out;
}

/** Exact merge of results over disjoint id sets. */
export function mergeOut(spec: ReduceSpec, a: readonly OutResult[], b: readonly OutResult[]): OutResult[] {
  if (a.length !== spec.outputs.length || b.length !== spec.outputs.length) throw new RangeError('mergeOut: one result per spec output');
  return spec.outputs.map((o, i) => {
    const x = a[i]!, y = b[i]!, r: OutResult = { n: x.n + y.n, invalid: x.invalid + y.invalid };
    if (o.op === 'sum') {
      r.sum = x.sum! + y.sum!;
      r.sat = x.sat! + y.sat!;
    } else if (o.op === 'max') r.max = x.max == null ? (y.max ?? null) : y.max == null ? x.max : Math.max(x.max, y.max);
    else if (o.op === 'hist') {
      r.bins = x.bins!.map((v, j) => v + y.bins![j]!);
      r.dropped = x.dropped! + y.dropped!;
    }
    return r;
  });
}

export function gatherRows(snap: Snapshot, ids: Int32Array): BodyRows {
  const n = ids.length;
  const r: BodyRows = {
    ids: Int32Array.from(ids), present: new Uint8Array(n), pos: new Float64Array(3 * n), rot: new Float64Array(4 * n),
    linVel: new Float64Array(3 * n), angVel: new Float64Array(3 * n), awake: new Uint8Array(n),
  };
  for (let j = 0; j < n; j++) {
    const id = ids[j]!;
    if (!(id >= 0 && id < snap.count)) {
      r.rot[4 * j + 3] = 1;
      continue;
    }
    r.present[j] = 1;
    r.pos.set(snap.pos.subarray(3 * id, 3 * id + 3), 3 * j);
    r.rot.set(snap.rot.subarray(4 * id, 4 * id + 4), 4 * j);
    r.linVel.set(snap.linVel.subarray(3 * id, 3 * id + 3), 3 * j);
    r.angVel.set(snap.angVel.subarray(3 * id, 3 * id + 3), 3 * j);
    r.awake[j] = snap.awake[id]!;
  }
  return r;
}
