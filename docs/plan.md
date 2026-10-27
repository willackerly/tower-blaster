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

Opt-in and off by default (`AvbdParams.gapSlop`, metres; off when absent or 0, and then the reference is bit-identical to before). The GPU engine throws on it until it is ported. Full description: the header of `packages/physics-ref/src/avbd.ts`.

- **What it fixes (defect B).** Post-stabilization lifts a body out of its start-of-step penetration without velocity and leaves its other loaded points a few um in the air; the next main iterations counted that gap in full and dropped the body back with velocity, so rocking stacks gained energy every step and never came to rest (a sideways-kicked 8-cube column at 10 iterations, kicked packed towers). With `gapSlop`, a point still loaded from last step, not a rolling contact, counts its start gap less `gapSlop` in the main iterations. At 3e-5 m those cases come to rest or keep a bounded sub-mm sway.
- **Why it is off.** It is a fixed length, measured on unit cubes at 1/60 s: a plank on a narrow pivot and 0.1 m cubes need 1e-4 or more, while S13's rocking test is at its bounds by 5e-5, and at 10 iterations 3e-5 already puts S13 at its bound once the start is re-rolled (3 of 12 draws below). On Keystone it settles more shots but L2's real-rest check fails more often (table). Round 3 of the defect B work is evaluating scale-free versions (the length taken from the contact manifold or from the warm λ/k); the default and the GPU port wait for its verdict.
- **Keystone's first par shots** (reference, f64; each run's start moved by up to 1e-6 m; the settle rule of `rules.ts` on main, spin counted on the structure only; 2026-10-27). "Settled" counts runs under the 600-step cap; "real rest fails" counts settles where a body still moves by position more than its velocity says; "late v" is the median over runs of the structure's largest speed late in the run.

  | Level, iterations | runs | settled, off / on | median steps, off / on | real rest fails, off / on | late v (m/s), off / on |
  |---|---|---|---|---|---|
  | L5, 20 | 16 | 9 / 12 | 568 / 462 | 1 / 0 | 4.0e-2 / 3.5e-2 |
  | L2, 20 | 6 | 5 / 6 | 439 / 389 | 2 / 5 | 3.5e-2 / 2.8e-2 |
  | L1, 20 | 8 | 1 / 1 | 600 / 600 | 0 / 0 | 8.4e-2 / 6.3e-2 |
  | L5, 40 | 16 | 14 / 16 | 428 / 340 | 1 / 2 | 1.3e-2 / 6.8e-4 |

  At 20 iterations the unsettled shots are mostly the convergence of tall columns, with or without the slop. At 40 iterations they settle either way, but what is left moving without the slop is mostly this pump (late v 20x lower with it). Outcomes differ run by run either way, as the moved starts already make them: L5 scores 2 stars in 13-15 of 16 runs off or on (else 3), and L2 gets 3 stars in 2-3 of 6.

## Restitution (AVBD reference)

Opt-in and off by default (`AvbdParams.restitution`); off, the reference is bit-identical to before. The GPU engine throws on it until it is ported, and Keystone keeps it off. Full description: the header and `restitute()` in `packages/physics-ref/src/avbd.ts`.

- **Rule.** A velocity pass after post-stabilization. A contact point that carried force and approached at `restitutionThreshold` (1 m/s, compared with >=) or faster at the start of the step is raised to the normal velocity -e vn0. The points of a manifold are solved together (a centroid line search, then one Gauss-Seidel sweep), and manifolds are coupled by mass splitting over `restitutionRounds` (8) rounds, with the other loaded contacts of their bodies as one-sided supports (depth 1). A bounced point that will separate starts the next step with no force.
- **Coefficients.** e = `combineRestitution(SceneDesc.restitutionCombine, e_a, e_b)`, clamped to [0, 1]. The rule defaults to average (`DEFAULT_RESTITUTION_COMBINE`, Rapier's), in every engine that applies restitution: Rapier, and the reference with `AvbdParams.restitution` on. The ground's e is `SceneDesc.ground.restitution` (default 0), so under average a body bounces off the ground at half its e.
- **Known limits** (10 iterations; e is the pair's; under the default average unless a rule is named):
  - The bounce is step-based: measured at contact, a drop's rebound falls short of e by 2-7% at 5-10 m/s, and at 2 m/s keeps 0.76 of e at e 0.3 and 0.62 at e 0.15 (an e 0.3 body on the default ground).
  - Outside zero-g pairs and chains (below), no probe gains energy beyond the switch-off solve at e <= 0.9.
  - e = 1 is not energy-safe: tilted rods gained about 0.8 of their energy, and with the ground at e 1 (rule max) tilted cubes up to 16% and tumbling ones 3.1%. A pair e of 0.95 gained 1.5% once. Beyond 8 rounds the pass overshoots at e = 1 (+0.3% at 32-64 rounds where 8 gains nothing).
  - The impulse is along n only: a cube landing on an edge at mu 0.6 keeps 0.36-0.83 of the rigid rebound and spins at 1.66-3.06x the rigid spin (rule max).
  - Heavy on light: the supports hold a struck body only as far as the rounds converge, which is slower the heavier the striker. A ball dropped at 10 m/s on a 1 kg cube on the ground rebounds at 0.59-0.67 of e v at 1 kg, 0.27-0.32 at 5 kg and 0.02-0.04 at 50 kg (no better than off), and the cube is driven into the ground at about the bounce's speed (4.7-5.7 m/s at 5 kg against 0.09 off). A 510 kg ball sinks up to 0.17 m into the cube (0.18 under max) against 0.11 m off, and from 2000 kg the ball can go through it (off holds up to 5000 kg at 10 m/s). A 144 kg rubber ball (e 0.6) at 20 m/s on a 10-cube plaster column (e 0.05) sinks 0.19 m against 0.08 m off (0.11 under max). More rounds help the bounce slowly and not steadily (5 kg at 10 m/s, e 0.9: 0.30 of e at 8 rounds, 0.19 at 16, 0.60 at 32) and let the heavy ball sink deeper (the column, rule max: up to 0.12 m at 8 rounds, 0.21 m at 32). Follow-up for the GPU port: measure a closing supports-only round, or the supports solved after the bounce, before settling the rounds default.
- **Energy-check exception.** The energy check the pass was landed with (gate G6 of the restitution review, not a phase gate: kinetic or shadow energy never above its start by more than 1e-9 relative, over drops, oblique impacts, stack drops and zero-g head-on pairs) fails on zero-g box pairs, and zero-g chains (outside the check) gain too. The pass keeps momentum to rounding (at most 7.1e-15 N s over 78 zero-g scenes); the gain is the solve's momentum drift, which shows once contacts stop absorbing energy.
  - A 1:1 box pair at 10 m/s ends at 1.023, 1.158 and 1.383x its kinetic energy at e 0.3, 0.6 and 0.9 (10 iterations). A 1:5 pair reaches 1.015x at e 0.9, and the 1:1 pair at e 0.9 reaches 1.061x at 20 iterations. With the switch off, these pairs' momentum already drifts by up to 46% at 10 iterations (15% at 20).
  - Chains of 3 and 5 unit cubes 0.05 m apart, struck at 10 m/s, end at 1.14 and 1.48x at e 0.9 (none at 20 iterations). There the solve drifts momentum 4.6 and 2.8x as much as with the switch off (the chain of 5 from 10 to 17.0 N s, against 12.5). A chain of 5 spheres gains 23% at e 1 (2.6% at 20 iterations).
  - The check cannot pass until the solve's drift is fixed.
