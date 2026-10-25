# reduce() and sparse readBodies() for `@tb/engine-api`: final design

Status: agreed with the game thread (PR #10) and the tier thread (PR #8), 2026-10-25 (answers in §11). Implementation follows §9.

How this was produced: three independent designs (A declarative spec, B consumer-supplied WGSL kernel, C readback-minimal), scored by two judges with different lenses (numerical correctness; engineering fit), synthesized, then adversarially verified with a WGSL experiment. §10 has the scores and why each alternative lost; §12 lists what verification refuted and how this text was corrected.

Checked against: `engine-api/src/index.ts`, `physics-gpu/src/{engine,solver}.ts`, `schema/src/structs.ts` and `gpu/src/device.ts` on p3-broadphase; `finish()` in tb-p34; `host.ts`, `lattice/src/{tiered,lattice}.ts` and the M5 Max benchmark docs on 20vknu; `keystone/src/{rules,driver,session,materials,level}.ts`, `game/src/main.ts` and findings §7 on h4nzb6; `render/src/sparks.ts` on sw0fj8.

The arithmetic core was checked in WGSL on a real adapter (SwiftShader, Tint → SPIR-V) against an independent TypeScript/BigInt reference, with 0 mismatches:
- `quant` with the ⊥ semantics of §3.2: 1,621,350 cases (all 256 exponents × s = 0..24 × both signs × 103 edge mantissas, ties at both parities, the 2^29 boundary, ±0, subnormals, four NaN patterns, ±Inf, 300k random). A ties-away mutant gave 3,438 mismatches.
- `mul64`, `sar64` and the clamped sum term: 307,005 cases. `sar64` without its shift-0 case gave 5,145 wrong results (WGSL takes shift amounts mod 32).
- Q14 rotation rows, ext and AABB faces: every 7^4 corner combination plus 60k random at s = 0..24. max |R| is exactly 2^30.
- K1 + K2 reductions: 138 runs over n ∈ {0, 1, 255, 256, 257, 1023, 1024, 1025, 100003}, two (workgroup × bodies per thread) variants; every workgroup partial equals the reference over its slice; 100,000 × (2^31−1) sums to exactly 214,748,364,700,000.

A node prototype reproduces design A's overflow: its ±(2^15−1) clamp wraps 96 rotation entries across its 16 corners. The experiments were throwaway; steps 2, 9 and 10 are their durable versions. They prove exactness on one conformant implementation; Metal is checked once on the M5 Max (step 9).

Every cost below is an estimate unless it is marked as measured, and each one states its basis.

---

## 1. Summary and recommendation

**Recommendation.** Adopt one generic, declarative `Observer` contract in `@tb/engine-api`, built from design A.
- The game supplies data only: a spec, tag words and integer thresholds.
- Engines evaluate it with integer-only arithmetic. On the GPU this is one interpreter pipeline, so no WGSL is generated per spec.
- One TypeScript function, `reduceRef`, defines the result. Every engine must match it bit for bit.

**What gets added.**
- `reduce()` becomes a standing query (`query()` and `Observation.out`).
- `readBodies()` becomes its watch list (`watch()` and `Observation.rows`).

**Delivery order** (C's sequencing, endorsed by both judges):
1. Fix `GpuAvbdEngine.snapshot()`, and measure `mapAsync` latency.
2. Ship the exact CPU path, `withSnapshotObserver`, and migrate the game onto it.
3. Land the GPU reducer.
4. Add the tier host's one-pass path last (v2).

**The premise, checked with numbers** (estimates; see §6):
- **At 10k awake bodies**, a fixed snapshot plus the CPU reference costs about 1–4 ms of main thread per step. The game's stepping budget is 10 ms per frame (`budgetMs: 10`, main.ts:324), so the CPU path covers the minimum target, only just.
- **At 100k** it costs about 9–14 ms per step or more, which is over budget. The GPU reducer is needed there: about 50–85 µs of GPU time and under 2 KB of readback per step.
- **Today's `snapshot()`** is the largest cost in either case:
  - it calls `readStruct` once per body (engine.ts:133–140);
  - it hard-codes `awake = 1` (engine.ts:140);
  - `readBuffer` creates a new staging buffer on every call (device.ts:29–37).

  This gets fixed first, whatever else is decided.

**Design decisions that differ from all three inputs:**
- **`dv` comes from an observer-owned "previous evaluated state".** `dv(k)` is a pure function of the snapshots at k and k−1 (§3.1). This removes A's `Snapshot.linVel0`, which would have touched every engine, and its coupling to `SolverBody.prevVel`. `prevVel` goes stale when iterations = 0, because `velocities()` runs only at `it === iterations − 1` (solver.ts:665), and it would break under solver compaction.
  - On TieredEngine, a woken dormant cube reads its `dv` from 0, which is what an all-dynamic run would see.
  - The renderer's spark detector already uses the same rule ("change since last seen; no event for a slot not seen before", sparks.ts).
- **Values out of range are ⊥ (invalid), not saturated.** NaN, ±Inf, |x·2^s| ≥ 2^29 and quaternion components beyond ±1 are counted in `invalid`, never folded silently into a sum. The only clamp is inside `norm2`, and it provably cannot change any allowed comparison.
- **Sums stay below 2^53 as plain `number`.**
  - Each body's term is clamped to ±(2^31−1), and every clamp is counted in `sat`.
  - The domain is capped at 2^22 bodies.
  - This removes A's i128 and `bigint`.
- **The lag is fixed by the consumer (B).** The Driver always consumes `result(stepIndex − L)` with `L = 1` on every engine. The GPU observer and the CPU reference then produce identical sessions on the same engine.
- **The tier path is staged.**
  - v1: `TieredEngine` is observed through `withSnapshotObserver`. It is exact, and it needs no new tier invariant.
  - v2: a GPU host reduces all tiers in one pass under a pose invariant. That invariant is put to the tier thread (§11).
  - No incremental dormant partials (A) and no multisets (B).

**Judges' fatal flaws and what this design does about them:**

| Flaw | Resolution |
|---|---|
| A: rotation entries overflow i32 under the ±(2^15−1) clamp | Q14 components are ⊥ beyond ±2^14. Then \|R\| ≤ 2^30, checked with no wrap across all 7^4 extreme combinations and 1M random cases. A corner test and a mutant guard it (§8) |
| A: largest contract surface | Removed from A: the `rot` scalar, `min`, `ids`, `mode`, i128/`bigint`, per-spec codegen and async compile. `ids` comes back in v2 as `select`, with B's semantics, if the tier thread wants it |
| A: cross-thread pose invariant; `prevVel` coupling | v1 needs no invariant. `dv` uses the observer's own `prev` buffer |
| B: consumer WGSL plus TS twins in the contract; the lint can be bypassed with `unpack*`; tier re-evaluation; ambiguous `flags` | No consumer code at all. No dormant re-evaluation. Only `flags` bit 0 is exposed, as `'awake'` |
| C: game rules hard-coded in the contract and the kernel | Generic spec. Keystone is about 20 lines of data (§4) |
| C: stateful `prevV` reset by `configure()`, re-primed on tier transitions | `prev` is primed once, on the first query. Changing the spec does not reset it. Tier transitions need nothing, because dormant ids stay in the domain with v = 0 |
| C: weight below 2^22 leaves no headroom; velocity saturates at 64 m/s | Weight is an i32 word. The per-body term clamp is counted. Velocities are valid up to 8192 m/s at s = 16 |
| C: lag depends on the engine | Fixed L in the Driver |

## 2. API

```ts
// packages/engine-api/src/observe.ts (new; re-exported from index.ts). Pure TS, no dependencies.
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

// ---- The definition (oracle), also the CPU path ----

/** ⊥ (null) for NaN, ±Inf, and |fround(x)|·2^s ≥ 2^29; else fround(x)·2^s rounded to nearest, ties to even, −0 → 0. */
export function quant(x: number, s: Scale): number | null;

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
/** lo/hi restrict the domain to ids lo .. hi − 1 (partition tests). */
export function reduceRef(spec: ReduceSpec, inp: ReduceInput, lo?: number, hi?: number): OutResult[];
/** Exact merge of results over disjoint id sets. */
export function mergeOut(spec: ReduceSpec, a: readonly OutResult[], b: readonly OutResult[]): OutResult[];
export function checkSpec(spec: ReduceSpec, caps: ObserverCaps, tagWords: number, gravity: Vec3, dt: number): void;
export function gatherRows(snap: Snapshot, ids: Int32Array): BodyRows;

/** Any engine observed through snapshot() after every step (lag 0). Mirrors the engine's id assignment from init() and push(). */
export interface ObservedEngine extends PhysicsEngine {
  readonly inner: PhysicsEngine;
  observe(opts: ObserveOptions): Promise<Observer>;
}
export function withSnapshotObserver(inner: PhysicsEngine): ObservedEngine;
```

Changes to `index.ts`. `Snapshot` itself is unchanged.

```ts
export interface PhysicsEngine {
  // ...existing members...
  /** Exact reductions and sparse reads. Valid until the next init() or dispose(). Engines without it are wrapped with withSnapshotObserver(). */
  observe?(opts: ObserveOptions): Promise<Observer>;
}
export * from './observe.ts';
```

Proposed `host.ts` additions. These are v2, step 15, and are pending the tier thread's answers to T1–T3:

```ts
export interface CellChange { /* ... */ pos?: Vec3; rot?: Quat }   // the pose TieredEngine.snapshot() reports for the cell
export interface HostBatch  { /* ... */ domain?: number }           // observation domain from the next step: ids < domain
export interface PhysicsHost {
  /* ... */
  /** Ids < domain; off/static ids read as posed by the tier, v = 0, awake 0. caps.lag = stateLag. */
  observe?(opts: ObserveOptions): Promise<Observer>;
}
```

**Who owns what**

| Party | Owns |
|---|---|
| Contract (lead) | Types, `quant`, `reduceRef`, `mergeOut`, `checkSpec`, `gatherRows`, `withSnapshotObserver`, `observerConformance` (testkit) |
| GPU thread | `GpuReducer` (interpreter, prelude, staging), `GpuAvbdEngine.observe()`, the `snapshot()` fix |
| Game thread | `gameSpec(level)`, tags, thresholds, `toReductions`, the Driver on L |
| Tier thread | Observing `TieredEngine` (v1: the wrapper); v2: host pose invariant and `HostBatch.domain` |

## 3. Semantics

### 3.1 Domain and inputs

An observer evaluates step k over the domain of ids 0..count_k−1:
- an engine: its bodies;
- `TieredEngine`: every spawned id, with dormant ids at their cell or rubble pose, v = 0 and awake 0, exactly as `TieredEngine.snapshot()` reports them.

Inputs:
- Every state word is read as an f32 bit pattern: `fround(x)` in TS, the stored bits on the GPU.
  - For f32 engines (GPU, Rapier), `snapshot()` is an exact widening, so this is the identity.
  - For physics-ref (f64), the reduction is over its f32-rounded state. This is documented as part of the definition.
- `prev`:
  - ids < prevCount: the linVel of the previous evaluated state;
  - the first query: the state when it was issued;
  - ids ≥ prevCount: `dv` is ⊥.
- `awake` = `snapshot().awake` (GPU: `Body.flags` bit 0).

For the plain GPU engine, `prev` equals the velocity each body starts the step from: inputs only add new ids, and `initBodies` clamps angVel only (solver.ts:259–261), never linVel.

### 3.2 Quantization

`quant(x, s)`, for s ∈ 0..24:

| Input | Result |
|---|---|
| NaN or ±Inf (exponent 255) | ⊥ |
| \|x\|·2^s ≥ 2^29 | ⊥ |
| otherwise | x·2^s rounded to nearest, ties to even; −0 → 0 |

Subnormals give 0: |x·2^24| < 2^-102, so flush-to-zero cannot change a result. Valid results satisfy |q| < 2^29. At s = 16 that is ±8192 m (S10 sits at 5 km) and ±8192 m/s.

**GPU: integer bit operations only.**

```
e = (b >> 23) & 255; e == 255 → ⊥; e == 0 → 0
m = (b & 0x7fffff) | 0x800000; sh = e − 150 + s
sh ≥ 6         → ⊥            (m·2^6 ≥ 2^29)
0 ≤ sh ≤ 5     → mag = m << sh
−25 ≤ sh < 0   → k = −sh; q = m >> k; r = m & ((1 << k) − 1); h = 1 << (k − 1)
                 mag = q + u32(r > h || (r == h && (q & 1) == 1))
sh < −25       → 0
sign bit       → −mag
```

**TS oracle: an independent float formulation.**

```ts
v = fround(x) * 2**s                    // exact: 24-bit significand, power-of-two scale
if (!isFinite(v) || Math.abs(v) >= 2**29) return null
r = Math.round(v); if (r - v === 0.5 && r % 2) r -= 1   // Math.round sends ties up; move odd results to even
return r + 0                            // −0 → +0
```

Both formulations matched a BigInt rational oracle on 3,830,600 cases, with 0 mismatches. The cases cover all 256 exponents × s = 0..24 × both signs × about 100 mantissas each (edge patterns plus random), 2M random patterns, NaN payloads, ±Inf and ±0.

### 3.3 Derived scalars

All derived scalars are exact integers.
- **`comp` of `pos`, `linVel` or `angVel`:** quant(c, s).
- **`dv`:** quant(v_a) − quant(prev_a) − G_a.
  - G_a = quant(gravity_a·dt, s) for that scalar's own s. It is computed in TS and carried in the scalar's program record (not one global uniform: two `dv` scalars may use different s); `checkSpec` throws if any is ⊥.
  - |dv| < 3·2^29 < 2^31.
- **`disp`:** quant(pos_a) − quant(ref_a). |disp| < 2^30. A ref slot is NaN-filled until it is captured, so a missing ref is ⊥ through the same exponent test.
- **`norm2`:** Σ min(|c_a|, 2^25)².
  - Each square is ≤ 2^50 and the sum is ≤ 3·2^50. That is exact as a double in TS, and held as u64 (two u32 words) in WGSL.
  - The clamp cannot change a comparison, because `checkSpec` requires k < 2^50. A clamped component already gives norm2 ≥ 2^50 > k, and the unclamped value is larger still.
  - The clamp only caps a reported max, at 512 m/s or 512 m when s = 16.
- **`aabb`.** Quaternion components are Q_c = quant(q_c, 14), and ⊥ if |Q_c| > 2^14. Unit quaternions never reach ⊥ (|q_c| ≤ 1), and f32 normalization error is about 1e-7, far below the 2^-15 margin.
  - The entries are R = 2^28·I − 2·(…) by the standard formula. Row 1, for example:
    - R10 = 2(QxQy + QwQz);
    - R11 = 2^28 − 2(Qx² + Qz²);
    - R12 = 2(QyQz − QwQx).
  - Every product is ≤ 2^28, every pair sum ≤ 2^29, and every entry satisfies |R| ≤ 2^30 < 2^31. No i32 wrap was found across every combination of {−2^14, −2^14+1, −1, 0, 1, 2^14−1, 2^14}^4 or across 1M random cases.
  - H_b = quant(half_b, s); for a sphere it is the radius on every axis. H is ⊥ unless 0 ≤ H ≤ 2^20 (16 m at s = 16), so a negative half extent or radius is ⊥ on both sides rather than read as unsigned on the GPU.
  - A sphere's aabb does not use R and ignores its quaternion entirely: it is valid even when Q would be ⊥.
  - ext_a = ⌊Σ_b |R_ab|·H_b / 2^28⌋. The numerator is < 3·2^50 (mul64 to u64 on the GPU), so ext ≤ 3·2^22.
  - aabb hi/lo = quant(pos_a) ± ext_a, with |aabb| < 2^29 + 3·2^22 < 2^31.
  - At the identity rotation R = 2^28·I, so ext = H exactly.
  - Non-unit quaternions with components ≤ 1 are evaluated as they are, with no normalization.
- **`tag`:** an unsigned field, < 2^31.

There is no division, square root, transcendental, float operation or `round()` on the GPU. Thresholds, edges, weights and G are integers computed once in JS, and JS never contracts into an FMA.

### 3.4 Predicates

Predicates are three-valued (T, F, ⊥) and evaluated left to right:
- `cmp(⊥)` = ⊥.
- `not(⊥)` = ⊥.
- `and(c1..cn)`: the first F gives F. A ⊥ reached before any F gives ⊥. Otherwise T. An empty `and` is T.
- `or`: the same rule with T and F swapped.

So `and(structure, norm2(disp) > K)` never marks ammo invalid when it has no ref. The GPU evaluates every operand and combines them by this table, so there is no data-dependent branching around barriers.

### 3.5 Outputs (per body, per output)

| Case | Effect |
|---|---|
| where = ⊥ | `invalid++` |
| where = F | nothing |
| where = T and x or bin is ⊥ | `invalid++` |
| where = T, all valid | `count` n++; `sum` adds t = clamp(⌊w·x/2^shift⌋, ±(2^31−1)) and `sat += (clamped)`; `max` compares x; `hist` bins (tag field ≥ bins → `dropped`; edges: upper bound of x in `edges`) |

`reduceRef` computes w·x exactly, using BigInt where |w·x| may exceed 2^53. The clamp is to ±(2^31−1), so a term of exactly −2^31 (for example w = tag word 0x80000000 read as i32, x = 1, shift 0) clamps to −(2^31−1) and counts in `sat`. On the GPU the "fits in i32" test is `hi == (lo >> 31) && lo != 0x80000000`, not the sign-extension test alone; random testing cannot reach this case, so it is an explicit adversarial case and mutant.

### 3.6 Why GPU results equal `reduceRef` bit for bit

1. **Each body's contribution is an exact integer function of that body's inputs alone.** The inputs are its state bits, prev, ref, tags, shape and the constants.
2. **Every combiner is commutative and associative:**
   - + on integers that provably never overflow (§3.7);
   - max;
   - bin-wise +.

   So body order, workgroup size, bodies per thread, fold shape and any partition of the domain (workgroups, tiers) give the same result. `mergeOut` is that combiner.
3. **No floating-point operation runs on state.** That makes the reduction immune to:
   - FMA contraction;
   - implementations assuming no NaN or Inf (which WGSL allows);
   - FTZ;
   - WGSL `round()` (half to even) versus `Math.round` (half up);
   - the precision of `sqrt` and `/`.

   WGSL is also used with no `/`, no `%`, no float→int conversion, and shift amounts < 32. Concrete integer arithmetic wraps mod 2^32 only where wrapping is the algorithm (limb adds with carry detection).
4. **No 64-bit integers or atomics are needed.** u64 and i64 values are word pairs. Sums are split into 16-bit limbs inside a workgroup, and workgroup partials are folded by one workgroup. No global atomics are used.

This holds on any conformant implementation, SwiftShader included. Exactness tests in CI are therefore meaningful even though CI timings are not.

### 3.7 Ranges and overflow bounds

| Quantity | Bound (any N ≤ 2^22) | Held in | At 100k (keystone) |
|---|---|---|---|
| quant | \|q\| < 2^29 | i32 | same |
| dv, disp | < 3·2^29, < 2^30 | i32 | same |
| Q, R | ≤ 2^14, ≤ 2^30 | i32 | same |
| Σ\|R\|·H, ext, aabb | < 3·2^50, ≤ 3·2^22, < 2^31 | u64, i32, i32 | same |
| norm2 | ≤ 3·2^50 | u64 → exact `number` | same |
| sum product w·x | ≤ 2^31·(2^31−1) < 2^62 (tag x included) | i64 (16-bit-limb `mul64`) | pe: w ≤ 2,391,188 (iron cube, 243.75 kg) × y_q |
| sum term | ≤ 2^31−1 (clamp counted) | i32 | pe term < 2^31 mJ up to y ≈ 898 m for an iron cube |
| per-thread sum (4 bodies) | < 2^33 | i64 | — |
| workgroup limbs (1024 bodies) | lo Σ < 2^26; hi Σ ∈ [−2^25, 2^25) | u32 atomics (hi as two's complement) | — |
| total sum | ≤ 2^22·(2^31−1) < 2^53 | i64 → `number` | pe ≈ 3.1e11 mJ ≈ 2^38 (100k plaster cubes, w = 306,563, mean y = 10 m) |
| counts, bins | ≤ N | u32 | ≤ 1e5 |
| partials | W = ⌈N/1024⌉ | — | 98 |

## 4. Mapping of `reduceCpu` and `watch()`

**Tags** (`tagWords = 2`), uploaded once per level for ids < m.n. Ammo stays untagged, so it reads 0.
- word0 = structure (bit 0) | (material·8 + band) << 8;
- word1 = round(m·9.81·1000) in mJ per metre, as i32.

Notation: h = `c.frame.unit`, q(x) = `quant(x, 16)!`, P(a) = `{ comp: 'pos', axis: a }`, `top = max(c.height, 1e-9)`.

```ts
const structure: Pred = { cmp: { tag: 0, bits: 1 }, op: '==', k: 1 };
const inLot = (g: number): Pred[] => [
  { cmp: P(0), op: '>=', k: q(lot.min[0] - g) }, { cmp: P(0), op: '<=', k: q(lot.max[0] + g) },
  { cmp: P(2), op: '>=', k: q(lot.min[1] - g) }, { cmp: P(2), op: '<=', k: q(lot.max[1] + g) }];
const live: Pred = { and: [{ not: structure }, ...inLot(4 * h), { cmp: P(1), op: '>=', k: q(0.6 * h) }] };
const inc: Pred = { or: [structure, live] };
```

| `reduceCpu` field | Output | Notes |
|---|---|---|
| nAwake | `count`, `and(awake, inc)` | Same rule; ammo "live" uses integer box tests |
| maxSpeed | `max`, `norm2(linVel)`, `and(awake, inc)` | Settle: `max < ⌈(0.05·2^16)²⌉ = 10,737,419`. Display: `Math.sqrt(max) / 65536` |
| maxAngSpeed | same over `angVel` | QUIET_SPIN: `< ⌈(0.2·2^16)²⌉ = 171,798,692` |
| pe_mJ | `sum`, x = P(1), weight = word 1, shift 16, where `structure` | Σ ⌊w·y_q/2^16⌋ mJ, an exact `number` |
| displaced | `count`, `and(structure, { cmp: { norm2: { disp: 0 } }, op: '>', k: ⌊(0.5h·2^16)²⌋ })` | h = 0.5 gives 2^28 exactly, so exactly 0.5 h is still not displaced |
| outOfLot | `count`, `and(structure, { not: { and: inLot(0.5 h) } })` | Equivalent to the four strict tests on integers |
| heightHist | `hist`, by `{ x: { aabb: 'hi', axis: 1 }, edges: j = 1..63 ↦ e_j }`, where `structure` | The bins are defined by the integer edges, which are data, so GPU and CPU agree whatever they are. With e_j = ⌈j·top·2^10⌉ computed as an exact rational ceiling of top's binary value, bin = clamp(⌊64T/(top·2^16)⌋, 0, 63) exactly. The naive f64 `Math.ceil(j*top*1024)` is off by one quantum on some edges for decimal tops (top = 0.1, j = 5 gives 512, not 513), so `gameSpec` uses the exact form |
| impacts | `hist`, by `{ tag: 0, shift: 8, bits: 6, bins: 48 }`, where `and(structure, awake, { cmp: { norm2: 'dv' }, op: '>', k: ⌊(0.8·2^16)²⌋ = 2,748,779,069 })` | `dv` against the previous evaluated step, as today |
| watch() | `observer.watch(session.watchIdx)` → `Observation.rows` (pos, rot, linVel; present 0 for id ≥ count) | Same values as today: exact f32 on GPU and Rapier. The crown, heritage and contact logic stays f64 on the CPU and is deterministic from identical inputs |
| Baseline / basePe | `captureRef(0)` in `Driver.reset` (after presettle) and `Driver.fire`; basePe = the pe output of `result(fireStep)` | Same state as today's `baselineOf(this.snapshot)` |

**Changes `reduceCpu` and the Driver need** (game thread):
1. **Reimplement on the oracle.** `reduceCpu(s, prevLinVel, c, base, step)` becomes `toReductions(reduceRef(gameSpec(c), { snap: s, prevLinVel, … refs: [base.pos] }))`. CPU and GPU then agree because of the contract tests, not because two copies are kept in step. `CpuObserver` is replaced by `Observer`; on Rapier that is `withSnapshotObserver(engine)`.
2. **Thresholds become integer comparisons** on 2^-16 quantized values (the table above).
3. **pe** becomes Σ ⌊w·y_q/2^16⌋ with w = round(m g 1000). It differs from Σ round(m g y 1000) by less than 0.5|y| + w·2^-17 + 1.5 mJ per body (plus w·|y|·2^-24 on the f64 reference engine, from rounding y to f32): about 24 mJ for an iron cube at 10 m. It remains a per-body integer and independent of order.
4. **heightHist** bins by integer edges. `skyline` is unchanged.
5. **impacts:**
   - `prev` is primed at `query()`, so impacts are counted on the first observation after reset (today `prevLinVel` is null there).
   - Ids that entered this step give ⊥, but ammo is excluded by `structure`, so nothing is counted invalid.
   - On TieredEngine, a woken cube reads dv from 0.
6. **New `invalid` counts:** a NaN body no longer turns pe into NaN; it is counted instead.
7. **Driver on a fixed lag L = 1:**
   - after each `step()`, consume `result(stepIndex − 1)`;
   - when the consumed step equals the fire step, record basePe;
   - `observe` is called once after presettle.

   Settle, aiming and level end therefore happen one step later than today on every engine, so goldens change once.
8. **Full snapshots** remain only for `Session` home (once, at reset) and `pick()` (once, on entering aiming; see question G3). `packScene` goes away with PR #9.

Since every observer returns identical integers, any deterministic JS computed from them (sqrt, division) is identical too. The game can keep float displays.

## 5. GPU implementation

**Files.**
- `physics-gpu/src/observe/` holds:
  - `GpuReducer(device, bodies, shapes, capacity)`, which the GPU host reuses;
  - `prelude.wgsl.ts` (`quant`, `mul64`, `add64`, `sar64`, rotation rows, `ext`);
  - `program.ts` (spec → u32 program; record layout, used by both the kernel constants and the decoder).
- `ObsParams` (n, nPrev, step, nWatch) goes in `schema/src/structs.ts`, followed by `pnpm codegen`. G lives in each `dv` scalar's program record.

**Buffers** (capacity C):

| Buffer | Size | Initial content |
|---|---|---|
| tags | C·tagWords u32 | 0 |
| prev | C·3 u32 (raw linVel bits) | — |
| refs | refSlots·C·3 u32 | NaN bits 0x7fc00000 |
| program (uniform, `array<vec4u>`) | ≤ 16 KB | — |
| partials | ⌈C/1024⌉·R u32 | — |
| record | about 140 + 17·maxWatch u32 | — |
| staging | pool of MAP_READ buffers | — |

At 100k, tags + prev + refs come to about 4 MB.

**Kernels.** One pipeline per (workgroup size, bodies per thread). They are built once in `observe()` with `createComputePipelineAsync`. A spec is data, so changing it never recompiles anything, and CI compiles at most 4 pipelines.

- **K1 `reduce`** (256 threads × 4 bodies, ids `wg·1024 + j·256 + t`, guard `i < n`). The other caps alone do not bound the record (16 histograms × 256 bins need over 4,096 workgroup words, the default `maxComputeWorkgroupStorageSize`), so `checkSpec` enforces `maxRecordWords` and `maxProgramWords` from the encoded program; an over-size spec is rejected, never indexed out of bounds:
  - **Bindings:** Body and Shape as `array<u32>` (read), tags (read), prev (read-write), refs (read), partials (write), plus 2 uniforms. That is 6 storage bindings, within the default of 8.
  - **Per body:**
    1. evaluate the scalar table, with private arrays holding value and ⊥;
    2. evaluate each output's postfix predicate on a private stack;
    3. accumulate counts, sums (i64) and maxes into thread-private registers; bins go directly to workgroup atomics; hist-by-edges uses a binary search;
    4. write `prev[i] = Body.linVel` bits.
  - **Then:**
    1. flush to `array<atomic<u32>, ≤1024>`, with sums as lo16/hi limbs and i32 max as `x ^ 0x80000000` → `atomicMax`;
    2. barrier; the second phase of u64 max (`atomicMax(lo)` where hi equals the workgroup maximum hi);
    3. barrier; write R words to `partials[wg]`.
  - The program comes from a uniform buffer, so the output loop and its barriers are in uniform control flow.
- **K2 `fold` + gather** (one workgroup): each lane folds the W partials (u32 add, i64 add with carry, biased max, lexicographic u64 max) and writes the record. Threads `< nWatch` copy watched Body words, with a present flag set to id < n.
- **`prime`** (first query) and **`captureRef`**: one-off dispatches, each submitted as soon as it is called. Queue order makes them see the state after the last submitted step. They copy Body.linVel into prev (with nPrev := n), or Body.pos into a ref slot.

**Placement.** In `GpuAvbdEngine.step()`, after `parts.solver.solve(enc, n, …)` (engine.ts:125), the engine encodes K1, K2 and `copyBufferToBuffer(record → staging)` in the same encoder, then makes the one existing submit, then calls `mapAsync`. There are 2 dispatches and 1 copy per observed step; with no query active, nothing is added.

**Staging and lag.**
- On map resolve, the engine decodes the record (sums from word pairs, rows f32 → f64), unmaps straight away and returns the buffer to the pool (B). A mapped slot therefore never blocks the queue.
- Decoded observations are kept for `keep` = 64 steps.
- When more than 64 maps are in flight, `step()` throws. Nothing is dropped silently.
- `caps.lag` = 1 nominally; the real value comes from step 0.
- After `finish()` resolves, every `result(k ≤ stepIndex)` resolves through map callbacks only.

**Notes for the GPU thread:**
- prev, tags and refs are keyed by id. If Body slots are ever permuted (the renderer's `slotToId` proposal), K1 reads the id from that map, and the results are unchanged by the permutation property.
- When sleeping lands, it must write `flags` bit 0, which `snapshot()` will read after step 1.

## 6. Cost model (estimates)

**GPU time per observed step.** Basis: the M5 Max primitives doc, which measured:
- 522 GB/s copy;
- 0.85 µs per back-to-back dispatch;
- 7–13 µs per latency-bound primitive at 10k–100k;
- compaction at 50% of copy and sort at about 40%.

| | 10k | 100k | Basis |
|---|---|---|---|
| K1 traffic | 1.24 MB | 12.4 MB | 124 B/body: Body 64, Shape 16, tags 8, prev 12 read + 12 write, ref 12 |
| K1 time | 8–15 µs | 40–60 µs | 10k: latency floor; 100k: 40–60% of copy |
| K1 interpreter ALU | 1–2 µs | 10–25 µs, overlaps memory | About 1–2k integer ops per body for keystone, at an assumed 8–10 T int ops/s (not measured) |
| K2 fold + gather | 5–8 µs | 8–20 µs | One workgroup; W = 10 / 98 partials × about 140 words |
| Copy + dispatch overhead | 2–3 µs | 2–3 µs | Record ≤ 2 KB |
| **Total** | **15–30 µs (0.2–0.4% of 7.5 ms)** | **50–85 µs (0.7–1.1%)** | |
| prime / captureRef (one-off) | < 5 µs | < 15 µs | Body read plus 12 B written per body |

The main thread decodes about 2 KB per step plus a promise: an estimated 10–30 µs. `mapAsync` round-trip latency is **not measured**. Lag 1 hides it if it stays under one step's wall time, which is 16.7 ms in real time and about 4 ms in 8× fast-forward. Step 0 measures it.

**The alternatives on the CPU.**
- VM numbers are from a throwaway node 22 benchmark on the cloud VM (one run; design C's earlier runs are given where they differ). Step 1's test and step 14's bench replace them with repo-tracked measurements.
- The M5 Max estimate divides by 2–3, based on the Rapier suite's 1.9–3.0× VM→M5 speedups on memory-heavy cases (docs/benchmarks/2026-10-25-m5max-rapier.md).
- None of these are performance results.

| Path | VM 10k | VM 100k | Est. M5 10k | Est. M5 100k |
|---|---|---|---|---|
| `snapshot()` today (`readStruct` per body) | 18.8 ms (C: 5.6–6.1) | 74 ms (C: 57–60) | 2–9 ms | 20–37 ms |
| Snapshot with typed views (step 1) | 0.14 | 1.7 | 0.05–0.07 | 0.6–0.9 |
| `reduceCpu` today | 1.6 | 18 | 0.5–0.8 | 6–9 |
| Specialized integer reduce (C's) | 2.4 (C: 1.7–1.9) | 25 (C: 15–17) | 0.6–1.2 | 5–13 |

The generic `reduceRef` interprets the spec, so it is probably 1–3× slower than C's specialized loop (estimate). The CPU path therefore costs about 1–4 ms per step at 10k and well over 10 ms at 100k. That is fine as the oracle and for Rapier-sized levels. The GPU reducer is required for 100k and preferable at 10k.

## 7. Tier host

**Semantics.** `TieredEngine`'s observation is defined as `reduceRef` over consecutive `TieredEngine.snapshot()` states:
- the domain is every spawned id;
- dynamic ids come from `host.current()`;
- lattice cells sit at `lat.center` with `CUBE_ROTATIONS[rotAt]`, and rubble at `rubblePos/rubbleRot`, all with v = 0 and awake 0 (tiered.ts:1072–1095).

This is one exact reduction across all tiers. A cube woken by a hit reads `dv` from 0, which also counts the impulse the tier handed back, as an all-dynamic run would. That helps the tier's differential tests against all-dynamic Rapier.

**v1: `withSnapshotObserver(tiered)`.** It is exact by construction, adds no invariant, and costs O(spawned) per step on the CPU. That is acceptable for Rapier hosts, which reach the 7.5 ms budget at about 2,800 awake cubes on the M5 Max and cannot run 100k anyway.

**v2: a GPU host's one-pass reduction.** `GpuReducer` runs over all ids < `HostBatch.domain`, and its result lag = `stateLag`. It equals v1 only if every off or static id's Body slot holds the exact pose that `snapshot()` reports, with v = 0 and flags bit 0 clear. Three things in the current code break that:
- **Native cells.** `CellChange` carries no pose (tiered.ts:737). The host can recompute the centre with the same f64 expression `o + i·e` (lattice.ts:114–116), but it cannot know the cell's rotation.
- **Initial dormant cells** are never posed in non-native mode. Their host slot holds the table pose, which is not guaranteed to equal `lat.center`.
- **Freeze with stateLag > 0.** Freeze sends `{ mode: MODE_STATIC }` "in place" (tiered.ts:804). The host keeps its step-k pose, while `rubblePos` comes from the state at k − lag, so the two differ.

These are questions T1–T3. Proxies already match: settling sends `pos: center, rot: cubeRot` (tiered.ts:740).

**`read()` at 100k is not made cheaper by v1.**
- The replica of the tier's step-1 loop costs 4 ms at 10k and 92 ms at 100k on the VM (C's runs: 48–84 ms). That is an estimated 30–46 ms on the M5, before `settle()`'s blocked check, which rescans `state.ids` for every candidate (tiered.ts:719–727, O(n·cands)).
- The route to O(selected) is a tier refactor in three parts:
  - a v2 `select` output: ids where a predicate holds, ascending, with an exact count and rows null on overflow (B's design: workgroup-atomic slot, then a CPU sort by id);
  - a host-side rest detector that keeps quiet counters and anchors per id on the GPU. It needs an integer chord metric in place of the `acos` turn (tiered.ts:363);
  - a neighbour query from the GPU manifolds for `touching()` and the blocked check.
- During a full collapse most bodies exceed vWake = 0.25 m/s, so selection alone saves little there. This is question T4.

`TierStats` come from the tier's own state and need no reduction.

## 8. Test plan

**Oracle layers:**
1. `quant` against a BigInt rational oracle, plus a bit-level TS twin that mirrors the WGSL.
2. `reduceRef` against hand-computed fixtures, and against a naive BigInt per-body evaluator written separately inside the test, on random specs and states (fast-check 4.10.2, already a devDependency).
3. Properties:
   - `mergeOut` over a random partition equals the whole;
   - permuting ids, with their tags, shapes, refs and prev, gives the same result.
4. `GpuReducer` on synthetic raw buffers against `reduceRef`. There is one pipeline, so thousands of random specs cost no compiles.
5. `observerConformance(factory)` in testkit: `result(k)` equals `reduceRef(snapshot_k, snapshot_{k−1})` at every step of a 200-step S5 run that includes:
   - a spawn mid-run;
   - `captureRef` at step 50;
   - `setTags` mid-run;
   - watch-list changes;
   - a query swap at step 120;
   - `query(null)` and a re-query (re-prime) at step 150.
6. A recorded game session gives identical feedback with the native GPU observer and with `withSnapshotObserver` on the same engine, at L = 1.

**Adversarial cases:**

| Area | Cases |
|---|---|
| `quant` | Ties m + ½ for even and odd m at both signs; −0; smallest and largest subnormal; \|x\|·2^s just under 2^29 and exactly 2^29 (⊥); largest finite; ±Inf; NaN 0x7fc00000, 0x7f800001, 0xffffffff; every s from 0 to 24 |
| Thresholds | norm2 = K and K + 1; T on an edge and edge − 1; displacement exactly 0.5 h; x on the lot edge; y = 0.6 h |
| Quaternions | All {−2^14, −2^14+1, −1, 0, 1, 2^14−1, 2^14}^4 (catches A's overflow); components 1 + 2^-14 (⊥); norm 1.5 with components ≤ 1; −0 components |
| AABB | H = 2^20 and 2^20 + 1; a negative half extent (⊥); a sphere with a ⊥ quaternion (valid); the identity rotation gives ext = H exactly |
| Sums | Terms of ±(2^31−1), products of exactly −2^31 (w = −2^31, x = 2^k, shift k), and clamp boundaries (`sat`); 0xFFFF limb carries; alternating signs; totals beyond 2^32; 100k terms of 2^31−1 (exactly 214,748,364,700,000) |
| Hist | Tag field ≥ bins (`dropped`); duplicate edges; T < 0, T = 0 |
| Domain | n ∈ {0, 1, 255, 256, 257, 1023, 1024, 1025, 100,003}; empty sets (max null, n 0); every body ⊥ |
| dv, refs | Entering ids (⊥); prime on the first query; a query swap does not re-prime; null then a query re-primes; a ref captured before a spawn; a slot never captured |
| Watch | negative ids, ids ≥ count, duplicates, unsorted, a body spawned this step, an empty list, `maxWatch` |
| Lag and ring | `result(k)` for k > stepIndex, k older than keep, or a step with no query: all reject; L = 0, 1, 2 in order; 65 maps in flight throws; all resolve after `finish()` |
| Invariance | Workgroup sizes 64 and 256 × 1 and 4 bodies per thread give equal results; each workgroup's partial equals `reduceRef(lo, hi)` |

**Mutation checks.** A test-only `mutate` option in the WGSL builder and in `reduceRef`. `mutants.test.ts` requires each mutant to fail at least one test:
- a tie rounds up instead of to even;
- the validity bound is `sh ≥ 7`;
- NaN is read as 0;
- Inf is accepted as valid;
- the quaternion clamp is ±2^15 (A's original);
- R row 1 uses row 0;
- the norm2 clamp is 2^26;
- the carry is dropped in `add64`;
- `sar64` loses its shift-0 case;
- a term of −2^31 is not clamped;
- a negative H is read as unsigned;
- the hi-limb sign extension is dropped;
- the workgroup accumulate is not atomic;
- the tail guard is `i <= n`;
- the bodies-per-thread stride skips slice 3;
- the fold skips the last partial;
- the edge compare is `>` instead of `≥`;
- prev is not updated;
- prime is skipped;
- Kleene `and` (⊥ ∧ F = F);
- `sat` is not counted.

## 9. Implementation steps (each lands with the test that proves it)

0. **Readback latency bench** in `@tb/gpu`: `mapAsync` round trip at 2 KB and 6.4 MB, fresh against reused staging. Test: the case runs (SwiftShader), with no timing assertion. Then record the M5 Max numbers in `docs/benchmarks` and choose L.
1. **`GpuAvbdEngine.snapshot()`**: a reused staging buffer, typed views, `awake = flags & 1`. Tests:
   - bitwise equal to the `readStruct` decode on S5 after 50 steps;
   - a body with flags 0 reads awake 0;
   - no buffer is created per call.
2. **`quant`.** Test: the BigInt oracle over all exponents × s × edge mantissas × signs plus 2M random, the boundary table, and the quant mutants.
3. **Spec types and `checkSpec`.** Test: the keystone spec is accepted. Each limit is rejected:
   - s > 24;
   - k out of range;
   - norm2 k ≥ 2^50;
   - norm2 used in a sum;
   - unsorted edges;
   - bins > maxBins;
   - tag word ≥ tagWords;
   - shift > 62;
   - bits outside 1..31;
   - slot ≥ refSlots;
   - more outputs, scalars or nodes than the caps;
   - any G is ⊥;
   - a tag shift outside 0..31 or shift + bits > 32;
   - one word over `maxRecordWords` or `maxProgramWords` (and exactly at the limit is accepted).
4. **`reduceRef`, `mergeOut`, `gatherRows`.** Test: hand fixtures for every scalar, predicate and output (the three-valued table, rotated AABB, `sat`, `dropped`), the naive BigInt evaluator (fast-check), partition and permutation properties, and the mirrored mutants.
5. **`withSnapshotObserver`.** Test: physics-ref through the §8 scenario, plus the rejection rules.
6. **testkit `observerConformance`.** Test: passes on physics-ref and Rapier, both wrapped; an observer with an off-by-one step fails it.
7. **TieredEngine through the wrapper.** Test: conformance on the tier's S5 differential scene through wake, settle and freeze; a woken cube's dv is measured from 0.
8. **Game on the CPU path:**
   - `gameSpec`, `toReductions`, `reduceCpu` on `reduceRef`;
   - the Driver on `observe()` with L = 1 and the `captureRef` baseline.

   Tests:
   - rules tests updated to integer thresholds (0.5 h not displaced; edges; K and K + 1);
   - session goldens regenerated;
   - keystone-lab solutions still clear their levels on Rapier.
9. **WGSL prelude.** Tests in headless Chromium via testkit, with `REQUIRE_WEBGPU=1` in CI:
   - the GPU equals TS on the step-2 corpus (about 3.8M quant cases);
   - 1M random `mul64` and `sar64` cases;
   - the quaternion corner set;
   - the prelude mutants;
   - run once on the M5 Max (real adapter, via the Mac thread), recording the adapter in the output: SwiftShader proves exactness on Tint → SPIR-V, not on Tint → MSL.
10. **`GpuReducer` K1 + K2 on synthetic buffers**, with `ObsParams` in schema and `pnpm codegen` run. Tests:
    - random specs and raw words equal `reduceRef`;
    - the n set;
    - the four (workgroup size, bodies per thread) variants agree;
    - per-workgroup partials equal `reduceRef(lo, hi)`;
    - the plumbing mutants.
11. **Watch gather, staging pool and result store.** Test: rows equal snapshot rows (adversarial ids), plus the lag and ring cases in §8.
12. **`GpuAvbdEngine.observe()`**: prime, prev maintenance, `captureRef`, `setTags`. Test: `observerConformance` on S5; equal to the results of `withSnapshotObserver(GpuAvbdEngine)` at every step.
13. **Game differential on the GPU.** Test: a recorded session gives identical feedback with the native observer and with the wrapper at L = 1.
14. **Bench `observe` variant** (PR #12): latency and throughput at 10k and 100k on the M5 Max. Test: the case runs, with no timing assertion.
15. **v2, once a GPU host exists and T1–T3 are agreed:** `PhysicsHost.observe`, the pose invariant and `HostBatch.domain`. Test: equals `withSnapshotObserver(TieredEngine)` at every step through wake, settle and freeze on S5 with stateLag 1.

## 10. Alternatives considered

| Design | Judge 1 (correctness / modularity / performance / risk / testability) | Judge 2 | Winner of |
|---|---|---|---|
| A, declarative `Observer` | 6.5 / 8.5 / 8 / 5 / 9 | 7.5 / 8 / 8 / 5 / 9 | Judge 2 |
| B, consumer WGSL kernel plus TS twin | 6 / 6 / 7 / 5 / 7 | 7 / 5.5 / 7.5 / 4 / 7 | — |
| C, readback-minimal fixed kernel | 8.5 / 4 / 7 / 8 / 9 | 8.5 / 4 / 8 / 8.5 / 8.5 | Judge 1 |

- **A is the base**, because it keeps the layering right: the game supplies data, the engine owns evaluation, and the contract owns one oracle.
  - Kept: integer histogram edges, NaN-filled refs, left-sequential three-valued predicates with `invalid`, partials plus fold with no global atomics, `captureRef`, and an independent TS rounding cross-checked against the integer WGSL.
  - Not kept:
    - the overflowing rotation bound;
    - i128 and `bigint`;
    - per-spec codegen and async compile;
    - `Snapshot.linVel0` and `SolverBody.prevVel`;
    - `rot`, `min`, `ids` and `mode`;
    - the dormant ± partials for voxel hosts.
- **B is not chosen**, because it puts WGSL and TS twins into `@tb/engine-api`.
  - Its twins are checked only by random-word fuzzing, which rarely lands on a threshold.
  - Its lint can be bypassed with `unpack*` builtins.
  - Its tier upkeep re-evaluates every dormant cube on each epoch change (11–30 ms per 100k by its own VM estimate).
  - B's own fallback, an expression builder, is essentially A.
  - Kept: the fixed consumer lag, limb-split sums and the 2^22 capacity rule for exact `number` sums, unmapping on resolve, and selection semantics for v2.
- **C is not chosen as the contract**, because it encodes keystone's rules (lot, live box, roles, 64 bins) in the engine contract and kernel.
  - Kept: its sequencing (snapshot fix and latency bench first, then the CPU path as the oracle before the GPU), the `snapshot()` findings, observer-owned previous velocity, Q14 components at ±2^14, threshold-safe clamping (here only in `norm2`), and the per-body floor form of pe.

## 11. Open questions

**To the game thread** (answered 2026-10-25 15:06; full reasoning in the game thread's reduce-answers-game.md)
- G1: all accepted. Today's comparisons are already strict and match the integer forms; dv is the same quantity; the pe bias moves leverage by under 1e-3 relative. Keep `invalid` and `sat`: Session asserts both are 0 in tests and dev builds.
- G2: L = 1 accepted (L = 2 also fine), as a Driver constant the tests read. Condition: `out` and `rows` of one Observation come from the same step (they do: §2). The game thread owns the Driver change and the par-line re-pin.
- G3: one snapshot on entering aiming is enough (physics is frozen while aiming); no GPU pick. The HUD reads `count` from the observation.
- G4: layout accepted. Worst body today w ≈ 3.07e6 mJ/m (limit about 700 m); the game adds a `pe-range` validateLevel check, w·(height + 10 m) < 2^31 − 1, so `sat` stays 0 in shipped levels.
- G5: yes; a woken cube really was hit.

Original questions:
- **G1.** Do you accept the semantic changes in §4?
  - integer thresholds at 2^-16;
  - pe as Σ ⌊w·y_q/2^16⌋, with less than 0.5|y| + w·2^-17 + 1.5 mJ difference per body;
  - integer histogram edges;
  - impacts counted on the first observation after `query()`, and ⊥ for ids that entered this step;
  - the `invalid` counts;
  - settling on an integer norm2.
- **G2.** Do you accept a fixed L = 1 on every engine (2 if step 0 shows `mapAsync` exceeds a fast-forward step)?
  - Hit-stop, crown and settle feedback land one step (16.7 ms) later.
  - Settle, then aiming, then the next shot all shift one step, so goldens change once.
- **G3.** `pick()` and the HUD's body count read `driver.snapshot`. Is one snapshot on entering aiming acceptable? That is about 1 ms at 100k after step 1, plus map latency (estimate). Or do you want a GPU ray pick later?
- **G4.** The tag layout is word0 = structure | class << 8 and word1 = w (i32 mJ/m), with ammo untagged. Does any planned level put w·y ≥ 2^31 mJ on one body, for example a 9.6e6 mJ/m iron slab above 223 m? Such a body would be counted in `sat`.
- **G5.** On TieredEngine, a cube woken by a hit reads `dv` from 0, so it counts as an impact, as it would in an all-dynamic run. Is that what the impacts feedback should show?

**To the tier thread** (answered 2026-10-25 15:05, against PR #8 at 758f9bc; tier line numbers below are from before that head)
- T1: yes. `CellChange` gains an optional `rot` (CUBE_ROTATIONS[rotAt]) for every id ≥ 0; the host computes the centre from `HostLattice` with the same f64 expression, origin + i·edge per axis (lattice.ts `center()`). The init table carries dormant ids already at their cell pose, so no MODE_OFF changes are needed at init.
- T2: freeze passes pos/rot = rubblePos/rubbleRot; the tier pose is authoritative (a teleport of at most the quiet drift over the lag; a no-op on Rapier).
- T3: `HostBatch.domain` accepted, result lag = stateLag, TieredEngine passes `spawned`. It lands with v2 (step 15) in the engine thread's PR.
- T4: not now. The tier fixes the O(n·cands) blocked scan on the CPU with its mover hash; `select` plus a GPU rest detector wait for a tiered-on-GPU profile showing read() matters. An integer chord metric is fine when needed.
- T5: confirmed; TierStats stay CPU tier state.

Original questions:
- **T1.** For a GPU host, will every off or static id hold the exact pose that `TieredEngine.snapshot()` reports, with v = 0 and awake 0? That covers the cell centre (f64 `o + i·e`, then f32), `CUBE_ROTATIONS[rotAt]`, and the rubble pose. It needs two things:
  - either `CellChange.pos/rot`, or `rot` alone with the host using the same f64 centre expression;
  - dormant poses passed at init, as `MODE_OFF` changes with pos/rot.
- **T2.** With stateLag > 0, freeze sends `{ mode: MODE_STATIC }` in place, so the host keeps its step-k pose while `rubblePos` comes from step k − lag. Should freeze pass pos/rot (a teleport of at most restDrift), or should `snapshot()` report the host's static pose?
- **T3.** Is `HostBatch.domain` (ids < domain, applied with the batch; TieredEngine passes `spawned`) acceptable, with the result lag equal to `stateLag`?
- **T4.** Do you want v2 `select` outputs and a host-side rest detector, so that `read()` becomes O(selected)? That means an integer chord metric in place of the `acos` turn, and a neighbour query for `touching()` and the O(n·cands) blocked scan at tiered.ts:719. During a full collapse, most movers exceed vWake anyway.
- **T5.** Can you confirm that `TierStats` stay computed on the CPU from tier state, with no reduction needed?
## 12. Verification record (2026-10-25)

An adversarial verifier checked 23 claims this design depends on; 12 held as first written. The rest were specification gaps or wrong evidence, all corrected above:

| Refuted or unverified claim | Correction |
|---|---|
| The prototype's 3.8M quant cases validated the ⊥ semantics | They tested a saturating quant. Re-run with ⊥ in WGSL: 1.62M cases, 0 mismatches (§1 header) |
| One uniform G serves every `dv` scalar | G per `dv` scalar's s, in its program record (§3.3, §5) |
| aabb fully specified | H is ⊥ unless 0 ≤ H ≤ 2^20; spheres ignore rot (§3.3) |
| Sum term clamp evidence | A product of exactly −2^31 slipped through the prototype's fits test (57 wrong GPU terms). Fits test, adversarial case and mutant added (§3.5, §8) |
| Caps bound the workgroup record and program | They did not (16 × 256 bins > 4,096 words). `maxRecordWords`, `maxProgramWords` added (§2, §5) |
| Tag extraction fully specified | shift 0..31, shift + bits ≤ 32 (§2) |
| Negative watch ids | present 0 unless 0 ≤ id < count (§2) |
| heightHist edges equal ⌊64T/top⌋ | False for decimal tops with f64 edges; exact rational edges (§4) |
| pe bound + 1 mJ | + 1.5 mJ (§4) |
| Exact on Metal | Unverified until step 9 runs on the M5 Max |
| v2 tier one-pass equals v1 | Unverified; gated on T1–T3 |
