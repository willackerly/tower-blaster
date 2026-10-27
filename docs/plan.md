# Engine plan

Full report with research, measurements and sources: https://claude.ai/artifact/5ZzMkLSGUwCSunVGMMU8yK

## Summary

- **Targets.** 10k cubes all moving at 30 fps (p99) minimum; 100k stretch. Target machine: Apple M5 Max.
- **Physics.** GPU-only. CPU engines (Rapier measured at about 11 µs per active cube per step, single-threaded WASM) are references, not candidates.
- **World model.** Four tiers: lattice (intact towers, near-zero cost), active rigid (full solver), frozen rubble, debris particles. Loose towers first (exact column-support rule); glued towers as an option later.
- **Solver bake-off.** AVBD (primary), GPU Soft Step, mass-splitting Jacobi, substepped XPBD, all on shared broadphase, narrowphase, persistence and sleeping.
- **Harness first.** Scenarios S1 to S11, quality gates, interleaved A/B with bootstrap confidence intervals.

## Phases and gates

| Phase | Content | Gate |
|---|---|---|
| P0 | Day-one experiments: three-avbd demos on the M5 Max, CPU baselines in browser, packed-vs-gapped lattice on GPU | G0: 10k active under 7.5 ms per step |
| P1 | Harness skeleton: schema + codegen, scenarios, engine interface + Rapier adapter, metrics, stats, bench CLI, browser runner | G1: A/A shows no difference, injected 10% slowdown detected |
| P2 | GPU core: frame graph, profiler, scan/sort/compact, bandwidth probe | |
| P3 | Physics pipeline and solver bake-off | G2: quality gates pass and N_max ≥ 10k |
| P4 | Lattice world model, activation, settle, overflow | G3: 100k world idle under 1 ms, peak within budget |
| P5 | Rendering MVP (parallel with P3/P4) | |
| P6 | Game loop and feel | |
| P7 | Full quality and device scaling | |

## Scenario suite

| ID | Scenario |
|---|---|
| S1 | Tall tower at rest |
| S2 | Stepped cube pyramid |
| S3 | Wall |
| S4 | City of towers |
| S5 | Ball impact |
| S6 | Debris heap settle |
| S7 | Rain (worst case, no sleep) |
| S8 | Slab and rod tower |
| S9 | Mass-ratio stack |
| S10 | Far from origin |
| S11 | Determinism canary |

## Loaded-gap slop (AVBD reference)

Opt-in and off by default (`AvbdParams.gapSlop`, metres; off when absent or 0, and then the reference is bit-identical to before). The GPU engine applies the same rule in f32 (a pipeline constant: off, its pipelines are built as without it and, on SwiftShader, give the same floats; the point's flag is a bit of `SolverContact.used`, so contacts stay 128 B; with manifold records, `AvbdParams.records`, the GPU default since 2026-10-27, a bit of the record's `flags` or `stick` word). Full description: the header of `packages/physics-ref/src/avbd.ts`.

- **What it fixes (defect B).** Post-stabilization lifts a body out of its start-of-step penetration without velocity and leaves its other loaded points a few um in the air; the next main iterations counted that gap in full and dropped the body back with velocity, so rocking stacks gained energy every step and never came to rest (a sideways-kicked 8-cube column at 10 iterations, kicked packed towers). With `gapSlop`, a point still loaded from last step, not a rolling contact, counts its start gap less `gapSlop` in the main iterations. At 3e-5 m those cases come to rest or keep a bounded sub-mm sway.
- **Why it is off.** It is a fixed length, measured on unit cubes at 1/60 s: a plank on a narrow pivot and 0.1 m cubes need 1e-4 or more, while S13's rocking test is at its bounds by 5e-5, and at 10 iterations 3e-5 already puts S13 at its bound once the start is re-rolled (3 of 12 draws below). On Keystone it settles more shots but L2's real-rest check fails more often (table). Round 3 of the defect B work is evaluating scale-free versions (the length taken from the contact manifold or from the warm λ/k); the default waits for its verdict.
- **On the GPU** (SwiftShader, 2026-10-27; `engine-gapslop.test.ts`). The kicked column comes to rest as on the reference, and an excused gap stops closing a few um up in f32 (`solver.ts`). With 3e-5 injected into the GPU and reference sides of engine-stacks, engine-rest and engine-knock, all pass, with two shifts to weigh before a default: S13 2 deg keeps less margin (far side 1.164 deg against 1.192, 0.592 against 0.606 of the rigid swing, with 0.58 the backstop; the reference moves alike, 1.242 to 1.207 deg), and the S5 knock's every-step deepest penetration has a heavier tail (speeds 13-17, each unmoved and re-rolled 4 times, so 25 runs per arm: median 36 mm either way, over 55 mm in 9 runs on against 1 off, worst 99.6 against 79.0 mm; the reference 6 on, 8 off; the cut was chosen after looking, paired sign test p 0.42). Re-measure that with 40+ runs at Keystone's 20-40 iterations before it is on there. On the M5 Max (Metal, Chrome, 2026-10-27, at 8d5fffb) it builds with the default dispatch and costs nothing measurable: the S4 10k city at 10 iterations, throughput mode, 3.419 ms/step median with it on against 3.450 off (-0.84%, [-0.98, -0.76]; under the bench's 2% threshold). `engine-gapslop.test.ts`'s bit-exact on/off and cross-form checks were tuned on SwiftShader and have not run on Metal (vitest on the Mac runs SwiftShader).
- **Keystone's first par shots** (reference, f64; each run's start moved by up to 1e-6 m; the settle rule of `rules.ts` on main, spin counted on the structure only; 2026-10-27). "Settled" counts runs under the 600-step cap; "real rest fails" counts settles where a body still moves by position more than its velocity says; "late v" is the median over runs of the structure's largest speed late in the run.

  | Level, iterations | runs | settled, off / on | median steps, off / on | real rest fails, off / on | late v (m/s), off / on |
  |---|---|---|---|---|---|
  | L5, 20 | 16 | 9 / 12 | 568 / 462 | 1 / 0 | 4.0e-2 / 3.5e-2 |
  | L5, 30 | 16 | 15 / 15 | 393 / 364 | 1 / 1 | 2.4e-2 / 5.6e-3 |
  | L5, 40 | 16 | 14 / 16 | 428 / 340 | 1 / 2 | 1.3e-2 / 6.8e-4 |
  | L2, 20 | 6 | 5 / 6 | 439 / 389 | 2 / 5 | 3.5e-2 / 2.8e-2 |
  | L2, 30 | 6 | 6 / 5 | 374 / 380 | 3 / 3 | 2.4e-2 / 6.8e-3 |
  | L2, 40 | 6 | 6 / 6 | 353 / 452 | 3 / 1 | 3.6e-2 / 3.6e-4 |
  | L1, 20 | 8 | 1 / 1 | 600 / 600 | 0 / 0 | 8.4e-2 / 6.3e-2 |
  | L1, 30 | 8 | 8 / 8 | 369 / 372 | 0 / 0 | 4.0e-2 / 1.1e-2 |
  | L1, 40 | 8 | 8 / 8 | 282 / 300 | 1 / 1 | 2.8e-2 / 2.2e-2 |

  At 20 iterations the unsettled shots are mostly the convergence of tall columns, with or without the slop. At 30 and 40, what is left moving without the slop is mostly this pump: late v is lower with it (L5 4x at 30 and 19x at 40, L2 4x and 100x, L1 4x and 1.3x). Only 40 iterations with the slop settles every run under the cap: 30 with it caps one L5 and one L2 run, 40 without it two L5 runs. With it at 40, L2 settles later (3 of 6 after step 447; in the one traced, a 4-cube column rocks on its base edge, its peak spin 0.56 rad/s at step 329 falling irregularly to 0.12 by 507). No real-rest failure at 30 or 40 moves faster by position than the settle rule's QUIET_SPEED or QUIET_SPIN (at most 0.049 m/s and 0.12 rad/s), so none is a settle the rule called while a body really moved. Unjittered, at 40 iterations, the shots settle at L5 409 / 300, L1 356 / 313 and L2 377 / 356 steps, and the slop changes L1's and L2's outcomes (crowns down 3 to 2 and 6 to 5). L1 at 30 iterations settles on the same step in all 8 draws (the moved starts diverge only later), so that row shows no spread. Outcomes differ run by run either way, as the moved starts already make them: L5 scores 2 stars in 13-16 of 16 runs in every cell (else 3); L2 gets 3 stars in 0-5 of 6 (5 of 6 at 40 iterations with the slop, 3 of 6 without), and L1 no stars in any run. Keystone plays at 40 iterations with gapSlop 3e-5 (2026-10-27).

## Restitution (AVBD)

Opt-in and off by default (`AvbdParams.restitution`); off, the reference is bit-identical to before. The GPU engine applies the same pass in f32 (`packages/physics-gpu/src/restitution.ts`, whose header has the kernels and the f32 departures). It reads points or exact manifold records (`AvbdParams.records` 0, or 1, the GPU default) through one view of either, and on SwiftShader the two give the same floats and restitution stats every step (`packages/physics-gpu/test/engine-restitution-records.test.ts`). Centre-friction records (2) and the fused dual refuse it. On SwiftShader its drops rebound at the reference's ratio to 1.5e-6 (2-10 m/s, e 0.3-0.9, sphere, flat and edge), and its threshold (>=), combine rules (a NaN e bounces nothing, as on the reference), depth-1 supports, mass splitting, start-of-step inertia and lambda reset match the reference's cases (`packages/physics-gpu/test/engine-restitution.test.ts`). Off, it allocates no buffer, builds no pipeline, encodes no extra dispatch and gives the same floats as before the port. On, it costs 6 + 2 × `restitutionRounds` dispatches a step (22 at 8 rounds; when nothing bounces, all but 3 of them are indirect with 0 workgroups) and (maxPairs + capacity) × 80 B. Keystone keeps it off. Full description: the header and `restitute()` in `packages/physics-ref/src/avbd.ts`.

- **Rule.** A velocity pass after post-stabilization. A contact point that carried force and approached at `restitutionThreshold` (1 m/s, compared with >=) or faster at the start of the step is raised to the normal velocity -e vn0. The points of a manifold are solved together (a centroid line search, then one Gauss-Seidel sweep), and manifolds are coupled by mass splitting over `restitutionRounds` (8) rounds, with the other loaded contacts of their bodies as one-sided supports (depth 1). A bounced point that will separate starts the next step with no force.
- **Coefficients.** e = `combineRestitution(SceneDesc.restitutionCombine, e_a, e_b)`, clamped to [0, 1]. The rule defaults to average (`DEFAULT_RESTITUTION_COMBINE`, Rapier's), in every engine that applies restitution: Rapier, and the reference with `AvbdParams.restitution` on. The ground's e is `SceneDesc.ground.restitution` (default 0), so under average a body bounces off the ground at half its e.
- **Known limits** (10 iterations; e is the pair's; under the default average unless a rule is named):
  - The bounce is step-based: measured at contact, a drop's rebound falls short of e by 2-7% at 5-10 m/s, and at 2 m/s keeps 0.76 of e at e 0.3 and 0.62 at e 0.15 (an e 0.3 body on the default ground).
  - Outside zero-g pairs and chains (below), no probe gains energy beyond the switch-off solve at e <= 0.9.
  - e = 1 is not energy-safe: tilted rods gained about 0.8 of their energy, and with the ground at e 1 (rule max) tilted cubes up to 16% and tumbling ones 3.1%. A pair e of 0.95 gained 1.5% once. Beyond 8 rounds the pass overshoots at e = 1 (+0.3% at 32-64 rounds where 8 gains nothing).
  - `restitutionThreshold` 0 rests an undisturbed stack but not a struck one. A cube landing at 3 m/s on an 8-cube column (e 0.5 on every surface and the ground) left the column moving: on the reference 0.088 J and 8.9 mm of side drift 50 s into the run (0.057 m/s at 20-25 s; the GPU 0.21 m/s there). Thresholds of 0.01 and 0.1 m/s rest it to rounding. `gapSlop` (3e-5) shrinks it (reference 1.7e-4 m/s, GPU 0.023) without removing it.
  - The impulse is along n only: a cube landing on an edge at mu 0.6 keeps 0.36-0.83 of the rigid rebound and spins at 1.66-3.06x the rigid spin (rule max).
  - Heavy on light: the supports hold a struck body only as far as the rounds converge, which is slower the heavier the striker. A ball dropped at 10 m/s on a 1 kg cube on the ground rebounds at 0.59-0.67 of e v at 1 kg, 0.27-0.32 at 5 kg and 0.02-0.04 at 50 kg (no better than off), and the cube is driven into the ground at about the bounce's speed (4.7-5.7 m/s at 5 kg against 0.09 off). A 510 kg ball sinks up to 0.17 m into the cube (0.18 under max) against 0.11 m off, and from 2000 kg the ball can go through it (off holds up to 5000 kg at 10 m/s). A 144 kg rubber ball (e 0.6) at 20 m/s on a 10-cube plaster column (e 0.05) sinks 0.19 m against 0.08 m off (0.11 under max). More rounds help the bounce slowly and not steadily (5 kg at 10 m/s, e 0.9: 0.30 of e at 8 rounds, 0.19 at 16, 0.60 at 32) and let the heavy ball sink deeper (the column, rule max: up to 0.12 m at 8 rounds, 0.21 m at 32). The GPU port keeps this rule and its weakness (its 510 kg ball drives the cube down and comes back as the reference's, to 1e-4 m/s). Still open: measure a closing supports-only round, or the supports solved after the bounce, before settling the rounds default.
- **Energy-check exception.** The energy check the pass was landed with (gate G6 of the restitution review, not a phase gate: kinetic or shadow energy never above its start by more than 1e-9 relative, over drops, oblique impacts, stack drops and zero-g head-on pairs) fails on zero-g box pairs, and zero-g chains (outside the check) gain too. The pass keeps momentum to rounding (at most 7.1e-15 N s over 78 zero-g scenes); the gain is the solve's momentum drift, which shows once contacts stop absorbing energy.
  - A 1:1 box pair at 10 m/s ends at 1.023, 1.158 and 1.383x its kinetic energy at e 0.3, 0.6 and 0.9 (10 iterations). A 1:5 pair reaches 1.015x at e 0.9, and the 1:1 pair at e 0.9 reaches 1.061x at 20 iterations. With the switch off, these pairs' momentum already drifts by up to 46% at 10 iterations (15% at 20).
  - Chains of 3 and 5 unit cubes 0.05 m apart, struck at 10 m/s, end at 1.14 and 1.48x at e 0.9 (none at 20 iterations). There the solve drifts momentum 4.6 and 2.8x as much as with the switch off (the chain of 5 from 10 to 17.0 N s, against 12.5). A chain of 5 spheres gains 23% at e 1 (2.6% at 20 iterations).
  - The check cannot pass until the solve's drift is fixed.
- **Viewer.** The Scene panel's `bounce` box (off by default; the AVBD engines only, disabled on Rapier and the tiers) is the engine option `restitution=true` (`?engine=avbd-gpu:restitution=true`), applied by Rebuild scene. While it is on, every body, spawn, fired projectile and the ground get the restitution `bounce e` (URL key `bounce.e`, 0 to 1, default 0.5; saved in the setup JSON as `scene.bounce`): the scenarios' surfaces are all 0 and the fired ball 0.1, so the switch alone would bounce only the ball, at 0.05 under average. One e on every surface makes every pair bounce at e under average, min and max. Off, the viewer's scene and engine spec are exactly as before. At a cube size s other than 1 m, `worldEngineSpec` scales the threshold by 1/sqrt(s) with the rest of `froudeParams`. 0.5 is visible and well inside the e <= 0.9 the energy probes cover. A CPU probe (reference against Rapier, which applies restitution always, at the same e; not a test) fired the viewer's default ball (11.5 kg, 40 m/s) at mid-height into small scenes and took the highest any cube rose in 4 s. At e 0.5 the reference reached 12.2 m on a 3x3x6 tower (Rapier 14.7; with Bounce off 6.9, and Rapier at the scenes' own e 13.2), 10.5 on a 2x2x10 tower (13.5), 8.7 on a C = 8 pyramid (16.2) and 7.3 on a 10x6 wall (7.2). Aimed 0.25 m higher at the 3x3x6 tower, the pass threw a top cube (2.9 m above the ball) up at 16 m/s, to 18.4 m against Rapier's 9.2, in one step with 28 bouncing points. It takes a heavy, fast striker: a 1 kg ball at 40 m/s, or the default ball at 15 m/s, on the same aim tops out at 7.2 and 6.4 m (Rapier 6.3 and 6.6). So it is likely heavy on light (above); it was not traced further. On that shot (e 0.3 to 0.9) the largest total mechanical energy after the shot was 1.0000 x its value then, to 4 decimals. On 300 falling cubes (S6) it was 0.9999 x its start.
