<!-- The concept panel's prototype spec, 2026-10-25. Status per step and deviations are in findings.md. -->

# KEYSTONE prototype spec (Rapier, ≤ 2,500 bodies)

## 0. Principles
- **No change to `@tb/engine-api` in the prototype.** Every input is `{kind:'spawn'}`. Every rule reads `Snapshot`-derived data.
- **Rules are pure and step-keyed.** They never see frames, wall time, the camera or Rapier.
- **Every step lands with a test** (CLAUDE.md), and `pnpm check` stays green.
- **Slow tests stay out of the default run.** Anything over about 20 s, such as the L5 par replay and bot sweeps, runs only under `KEYSTONE_SLOW=1` (nightly or manual).
- **Timing numbers** from CI or cloud VMs are never performance results. Retry latency and step cost are measured with `pnpm bench` on the M5 Max.

## 1. Module boundaries
| Package | Depends on | Owns | Must not |
|---|---|---|---|
| `@tb/keystone` (packages/keystone) | `@tb/engine-api` only | Units, materials, tags; LevelDef plus compiler and validator; level data; Shot model, ballistics, inverse aim, arc raycast; X-ray load map; CPU reductions (the reference spec for the future GPU `reduce()`); settle detector; objectives; scoring; session state machine; feedback event types; ink assignment; session record codec | Import Rapier, DOM, WebGPU, `Date`/`performance`/`Math.random` |
| `@tb/keystone-sim` (packages/keystone-sim) | engine-api, keystone (tests and CLI use `@tb/adapter-rapier`) | `Driver` (step → observe → session loop for any `PhysicsEngine`), `CpuObserver`, headless `runSession`, bot (sweep, chaos audit, L_gold) and its CLI `pnpm keystone:bot` | Rendering, audio |
| `@tb/game` (packages/game, Vite app, `pnpm game`) | keystone, keystone-sim, viewer, adapter-rapier | Input and aim UI, HUD (DOM overlay), pacing scheduler, camera director, audio (WebAudio), render hooks (wake glow, ink, heatmap, Regrow), replay UI, telemetry export | Game rules (it only renders `Feedback` and state) |

An import-boundary test in keystone fails if any file under `packages/keystone/src` imports anything other than `@tb/engine-api` or a relative path. It also fails on `Math.random`, `Date` and `performance`.

## 2. Interfaces (in `@tb/keystone`)
```ts
// units.ts / materials.ts
export const DEFAULT_UNIT = 0.5;                      // m per cube edge (h)
export type MaterialId = 0|1|2|3|4|5;                // plaster, stone, iron, ice, rubber, steel
export interface Material { density: number; friction: number; restitution: number }
export const MATERIALS: readonly Material[];
export const enum Role { Plain = 0, Crown = 1, Heritage = 2, Ammo = 7 }
export const encodeTag = (role: Role, part: number) => role * 4096 + part;  // ammo uses TAG_BALL

// level/def.ts — authored data; lengths in h, multiples of 0.25
export interface LevelDef {
  id: string; version: number; name: string; world: number; unit?: number;
  parts: Part[];
  lot: { min: [number, number]; max: [number, number] };
  crownLine: number;
  objective: { kind: 'crowns' } | { kind: 'skyline'; maxH: number; footprintMax?: number };
  heritage: boolean;
  par: number; ace: boolean; rack: AmmoKind[];          // rack ≤ 6
  launcher: { radius: number; minY: number; maxY: number; dropY: number };
  solutions: { par?: Shot[]; ace?: Shot[] };           // recorded, replay-tested
  thresholds?: { lGold: number; basin?: BasinReport };  // written by the bot
}
export type Part =
  | { kind: 'block'; at: [number, number, number]; size: [number, number, number];
      material: MaterialId; role?: Role;
      courses?: { k: number; material?: MaterialId; role?: Role; cells?: [number, number][] }[] }
  | { kind: 'slab' | 'rod'; at: [number, number, number]; half: [number, number, number];
      material: MaterialId; role?: Role };

// level/compile.ts
export interface BodyMeta {               // index-aligned with scene.bodies, then ammo appended
  n: number; role: Uint8Array; material: Uint8Array; mass: Float64Array;
  half: Float64Array;                     // 3 per body (sphere: r, r, r)
  home: Float64Array; homeRot: Float64Array; band: Uint8Array; part: Uint16Array;
  crowns: Int32Array; heritage: Int32Array;
}
export interface CompiledLevel { def: LevelDef; scene: SceneDesc; meta: BodyMeta; hash: string }
export function compileLevel(def: LevelDef): CompiledLevel;
export function validateLevel(c: CompiledLevel): Issue[];
// Checks: overlaps; lattice support; mass ratio ≤ 10 for touching bodies;
// static-load heuristic ≤ 12 cube masses; tunnelling per rack ammo; body count ≤ 2,500.

// shot.ts — all integers
export type AmmoKind = 'marble' | 'cannonball' | 'cue' | 'drop';
export type Shot =
  | { ammo: 'marble' | 'cannonball'; az: number /*0.5°*/; y: number /*¼h*/;
      yaw: number /*0.1°*/; pitch: number /*0.1°*/; power: number /*1%*/ }
  | { ammo: 'cue'; at: [number, number, number] /*¼h*/; face: 0|1|2|3|4|5; power: number }
  | { ammo: 'drop'; x: number; z: number /*¼h*/ };
export const AMMO: Record<AmmoKind, { body: (u: number) => BodyDesc; vMin: number; vMax: number }>;
export function shotToSpawn(def: LevelDef, shot: Shot, step: number): InputEvent;
export function ammoKE(ev: InputEvent): number;                     // ½mv², or m g y for drop
export function predictArc(ev: InputEvent, g: Vec3, dt: number, steps: number): Float64Array;
// Semi-implicit Euler, identical to the engine's free flight.
export function aimAt(def: LevelDef, ammo: AmmoKind, az: number, target: Vec3): Shot;
export function firstHit(arc: Float64Array, r: number, s: Snapshot, meta: BodyMeta):
  { step: number; body: number } | null;

// xray.ts — from LevelDef geometry, no physics
export function loadMap(c: CompiledLevel): Float32Array; // kg carried per body

// observe.ts — CPU reference; the GPU reduce() must match bit-for-bit on integer fields
export interface Baseline { step: number; pos: Float64Array; rot: Float64Array; pe_mJ: number }
export interface Reductions {
  step: number; nAwake: number; maxSpeed: number; maxAngSpeed: number;  // ammo out of range excluded
  pe_mJ: number;                     // Σ round(m g y · 1000) over structure, summed in index order
  displaced: number;                 // vs shot baseline, > 0.5 h
  outOfLot: number; heightHist: Uint32Array /*64*/; aabbAwake: Float64Array /*6*/;
  impacts: Uint32Array /*6 materials × 8 bands*/;
}
export interface Watched { step: number; idx: Int32Array; pos: Float64Array; rot: Float64Array;
                           linVel: Float64Array; awake: Uint8Array }  // ≤ 64 bodies
export function reduceCpu(s: Snapshot, prevLinVel: Float64Array | null, meta: BodyMeta,
                          base: Baseline, lot: LevelDef['lot'], unit: number): Reductions;
export function watchedIndices(meta: BodyMeta, liveAmmo: number[]): Int32Array;

// settle.ts / objectives.ts / score.ts
export interface SettleState { run: number; since: number }
export function settleStep(st: SettleState, r: Reductions, spawnStep: number): SettleState & { settled: boolean };
export function crownDown(p: Vec3, def: LevelDef): boolean;
export function heritageBroken(p: Vec3, q: Quat, home: Vec3, homeRot: Quat, unit: number): boolean;
export function skyline(hist: Uint32Array, hMax: number): number;
export function leverage(dPE_mJ: number, ke: number): number;
export function tier(L: number): 0|1|2|3;
export interface ShotOutcome { ke: number; dPE_mJ: number; crownsDown: number; heritageNew: number;
                               displaced: number; settleStep: number; tags: string[] }
export interface ScoreLine { label: string; value: number }
export function levelScore(def: LevelDef, shots: ShotOutcome[], cleared: boolean):
  { lines: ScoreLine[]; total: number; stars: 0|1|2|3; stamp: string };

// session.ts — the single state machine (pure reducer)
export type Phase = 'aiming' | 'flight' | 'settling' | 'cleared' | 'failed';
export type SessionInput =
  | { kind: 'fire'; shot: Shot; step: number }       // step = engine.stepIndex at request time
  | { kind: 'watched'; w: Watched }                   // every step
  | { kind: 'reductions'; r: Reductions }             // every K = 4 steps, plus forced at settle candidates
  | { kind: 'baseline'; b: Baseline };                // delivered by driver at each spawn step
export interface SessionState { phase: Phase; level: CompiledLevel; rackLeft: AmmoKind[];
  strokes: number; outcomes: ShotOutcome[]; crownDown: Uint8Array; heritageBroken: Uint8Array;
  settle: SettleState; liveL: number; tier: number; spawnStep: number; ammoIdx: number; /* … */ }
export interface SessionOutput { state: SessionState; spawns: InputEvent[];
  requests: ('baseline' | 'reduceNow')[]; feedback: Feedback[] }
export function newSession(c: CompiledLevel): SessionState;
export function sessionStep(s: SessionState, i: SessionInput): SessionOutput;

// feedback.ts — consumed by renderer, audio and pacing; never fed back into rules
export type Feedback =
  | { t: 'fired'; step: number; ammo: AmmoKind; ammoIdx: number }
  | { t: 'firstContact'; step: number; ammoIdx: number; strength: number }  // drives hit-stop, FOV punch
  | { t: 'crownDown'; step: number; body: number; ordinal: number }        // arpeggio degree
  | { t: 'heritageCrack'; step: number; body: number }
  | { t: 'leverage'; step: number; L: number; tier: number; crossed: boolean }
  | { t: 'impacts'; step: number; hist: Uint32Array }
  | { t: 'slowMo'; step: number; reason: 'crownTip' }
  | { t: 'settled'; step: number; shot: number; outcome: ShotOutcome; ink: Uint8Array }
  | { t: 'levelEnd'; step: number; cleared: boolean; score: ReturnType<typeof levelScore> };

// ink.ts / record.ts
export function inkFor(s: Snapshot, base: Baseline, meta: BodyMeta, shot: number, prev: Uint8Array): Uint8Array;
export interface SessionRecord { v: 1; level: string; levelHash: string; engine: string;
                                 inputs: { step: number; shot: Shot }[] }
export function encodeRecord(r: SessionRecord): string;   // base64url, ≤ 200 bytes for 6 shots
export function decodeRecord(s: string): SessionRecord;
```

**Driver contract** (`@tb/keystone-sim`). Each step:
1. `await engine.step()`.
2. Take a snapshot (on Rapier, every step).
3. `watched = watch(snapshot)`; feed it to the session.
4. If `stepIndex % 4 == 0`, or the session requested `reduceNow`: compute `reduceCpu` and feed it.
5. If a spawn was applied this step: capture the baseline from the snapshot.
6. Forward any `spawns` to `engine.push`, append them to the `SessionRecord`, and emit `feedback`.

Replay pushes the recorded spawns, so it is the same code path.

**Pacing** (`@tb/game/pacing.ts`, pure): `stepsThisFrame(clock, frameMs, dt, { hitStopFrames, scaleCurve, valve, fastForward })` extends `viewer/loop.ts` `stepsDue`. It decides only how many identical steps run per frame.

## 3. Ordered atomic steps
| # | Step | Test that proves it |
|---|---|---|
| 1 | Scaffold `@tb/keystone`, `@tb/keystone-sim`, `@tb/game` (workspace entries, tsconfig paths, `pnpm game` script) | Import-boundary test; `pnpm check` green |
| 2 | Units, materials, tags | A plaster cube at h = 0.5 has `massOf` = 125.000 kg; tag encode/decode round-trips for every role and part < 4096; ammo uses `TAG_BALL` |
| 3 | LevelDef, compiler, validator; L1–L5 as data | Body counts exactly 360 / 151 / 172 / 42 / 1,218; compile is pure (two compiles are deep-equal, same hash); body order is stable; the validator rejects a floating cube, an overlapping pair, a 12:1 resting mass ratio, and a marble whose v_max violates the tunnelling rule for a slab of 0.12 m |
| 4 | **Mechanics probe** (keystone-sim, Rapier, slow test plus a CLI report): six micro-scenes, one per B1–B6, each with a 7×5 jitter grid of shots | The report lists success rate and basin per behaviour. The test asserts only that it runs and writes JSON. **Decision gate:** fewer than 3 robust behaviours triggers the Risk-1 pivot before more level work |
| 5 | At-rest validity on Rapier for every level | Over 120 steps from init, no body moves more than 2 mm and rotates more than 0.5°, and the KE settle criterion holds by step 60. A failure makes the level invalid; this also covers "start-unstable" leverage gaming |
| 6 | Shot model: `shotToSpawn`, `ammoKE`, `predictArc` | Unit: quantisation is exact (no float drift for az/yaw/pitch/power over the integer ranges). Sim: a lone marble spawn in an empty scene matches `predictArc` within 1e-9 m for 60 steps on Rapier (same integrator) |
| 7 | `aimAt` (inverse ballistics) | For 200 random targets in launcher range, the closest-approach error of the chosen quantised shot is ≤ the error caused by one quantum; unreachable targets return the max-range shot flagged as such |
| 8 | `firstHit` against oriented boxes and spheres | Synthetic snapshots: a ray through a gap hits the box behind it; a rotated 45° box is hit or missed correctly; the step returned matches brute-force sampling |
| 9 | `loadMap` (X-ray) | A 1×1×n column's base carries (n−1)·m; a slab on two columns splits its load 50/50 when centred and 75/25 when offset by a quarter span; the L4 prop carries ≈ 650 kg ±5% |
| 10 | `reduceCpu` + `watchedIndices` | Synthetic snapshots with hand-computed expectations: pe_mJ exact integer; displaced threshold 0.5 h (inclusive/exclusive boundary pinned); outOfLot with the 0.5 h margin; heightHist top-of-AABB for a 45° rotated cube; impacts binned by material × band from prevLinVel; ammo beyond the lot + 4 h excluded from maxSpeed |
| 11 | Settle detector | Series fixtures: 30 quiet steps settle at exactly step 29 of the run; a spike resets; settles at the 600-step cap; never before spawn + 20 |
| 12 | Objectives and score | Crown-down boundary cases; heritage at 0.3 h and 15° (just under / just over); skyline ignores 2 stray bodies but counts 3; `levelScore` reproduces the design doc's L2 example (5,738) and the star/stamp table rows |
| 13 | Session state machine | Driven by synthetic inputs: fire is rejected unless aiming with rack left; aiming → flight → settling → aiming; clear on the objective; fail on an empty rack; baseline is requested at spawn; `firstContact` is emitted once; `crownDown` ordinals increase; `leverage.crossed` fires once per tier; retry (`newSession`) restores everything |
| 14 | Driver + headless `runSession` on Rapier | L1 with a recorded 2-cannonball solution clears; the result is identical across two runs (same final snapshot hash, same score). This extends the S11 determinism canary |
| 15 | Session record codec + replay | Encode/decode round-trips; 6 shots ≤ 200 bytes; replaying a record via `scene.inputs` gives the same final hash as the interactive push path |
| 16 | Bot: grid sweep, chaos audit, L_gold, basin report (worker pool, `pnpm keystone:bot L2`) | Fast test on a 30-body toy level with a 5×3×2 grid: the landscape JSON has the expected shape; the chaos audit computes the success fraction; L_gold = P25 of perturbed L. Nightly (`KEYSTONE_SLOW=1`) runs every level: par solution clears, the ±0.5° yaw × ±3% power box succeeds ≥ 80% over 50 samples, and thresholds are written back to the level data |
| 17 | Par-replay regression | L1–L4 recorded par solutions clear in `pnpm check`; L5 under `KEYSTONE_SLOW=1`. A physics or adapter change that breaks a level fails here |
| 18 | `@tb/game` shell: render a compiled level with the viewer renderer, a launcher that follows the camera azimuth, arc preview, click-to-fire, HUD (rack, strokes/par, leverage counter, crown count), result card with tally | Playwright via `@tb/testkit` (SwiftShader allowed): load L1, fire the scripted shots through the UI, see the result card with the expected stars. Asserts outcomes only, never timing |
| 19 | Pacing scheduler | Pure tests: hit-stop gives 0 steps for exactly N frames; slow-mo curve values at given times; valve clamps to [0.25, 1]; fast-forward gives 4 steps; total steps never depend on whether juice is on (same record, same hash) |
| 20 | Juice v1: camera director, shake, wake glow (renderer reads awake transitions), shot ink, crown arpeggio, collapse audio from `impacts`, settle bowl, Regrow, stamp and tally | Unit tests for pure parts: trauma accumulator; ink lerp schedule; audio voice allocator respects 32 voices and the bin→pitch map; Regrow schedule ordered by home height. A manual feel checklist covers the rest |
| 21 | Retry and replay UX: R re-inits (cached `CompiledLevel`) during Regrow; V replay with scrub by re-sim from the record and H heatmap | Functional: retry then the same shot gives the same hash. Latency (< 300 ms) is measured on the M5 Max with `pnpm bench`, not asserted in CI |
| 22 | X-ray UI (Tab, from L3), snap views, load threads | Playwright: Tab toggles the X-ray material uniform; tinting is checked against the `loadMap` order (hottest body is the expected L4 prop) |
| 23 | Telemetry: every attempt saved as a `SessionRecord` plus UI events (orbit seconds, X-ray seconds, time to fire), exported as a JSON download; `pnpm keystone:metrics` computes aha rate, reading time, retry pull and ammo-switch rate | Fixture logs give known metric values |
| 24 | Twist levels L1b, L2b, L5b, authored with bot feedback | Steps 3, 5, 16 and 17 tests extended to cover them |
| 25 | (Stretch) Scale preview: offline-baked 10k "Domino Boulevard" on Rapier (non-realtime, snapshots every step to disk), played back in the game renderer with the same audio and ink | Playback test: frame N renders the recorded snapshot N; used only for the scale A/B in playtests |

**Ordering rationale.** Steps 1–5 de-risk the physics premise before any UI work. Steps 6–17 make the rules complete and verified headlessly. Steps 18–23 make it playable and instrumented. Step 4 is an explicit go/no-go.

## 4. Explicitly out of scope
- Any change to `@tb/engine-api`, GPU `reduce()`, static/anchor bodies, bonds/glue.
- Charges, Plank, Quickdraw, Extraction objective.
- Daily puzzle, leaderboards, ghosts, share links (codec only), level editor, procedural generation.
- Cross-machine determinism (Rapier enhanced-determinism build) and per-engine re-verification on AVBD.
- Touch input, cosmetics (Topple skin), dust/bloom/sparks beyond crown sparks, music, assist ladder, star gates and world map (a flat level list instead).
- Any performance claim from CI/SwiftShader.