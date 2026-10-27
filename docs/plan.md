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

## Restitution (AVBD reference)

Opt-in and off by default (`AvbdParams.restitution`); off, the reference is bit-identical to before. The GPU engine throws on it until it is ported, and Keystone keeps it off. Full description: the header and `restitute()` in `packages/physics-ref/src/avbd.ts`.

- **Rule.** A velocity pass after post-stabilization. A contact point that carried force and approached at `restitutionThreshold` (1 m/s, compared with >=) or faster at the start of the step is raised to the normal velocity -e vn0. The points of a manifold are solved together (a centroid line search, then one Gauss-Seidel sweep), and manifolds are coupled by mass splitting over `restitutionRounds` (8) rounds, with the other loaded contacts of their bodies as one-sided supports (depth 1). A bounced point that will separate starts the next step with no force.
- **Coefficients.** e = `combineRestitution(SceneDesc.restitutionCombine, e_a, e_b)`, clamped to [0, 1]. The rule defaults to average (`DEFAULT_RESTITUTION_COMBINE`, Rapier's, used by every engine). The ground's e is `SceneDesc.ground.restitution` (default 0), so under average a body bounces off the ground at half its e.
- **Known limits** (10 iterations; e is the pair's):
  - e = 1 is not energy-safe: tilted rods gained about 0.8 of their energy. Every probe is clean at e <= 0.9.
  - The impulse is along n only: a cube landing on an edge at mu 0.6 keeps 0.36-0.83 of the rigid rebound and spins at 1.66-3.06x the rigid spin.
  - A 510 kg ball landing at 10 m/s on a 1 kg cube sinks 0.18 m into it, against 0.11 m with the switch off.
- **G6 exception.** The restitution gates' energy check fails on 5 zero-g box-pair cases, and only there.
  - A 1:1 pair at 10 m/s ends at 1.023, 1.158 and 1.383x its kinetic energy at e 0.3, 0.6 and 0.9 (10 iterations).
  - A 1:5 pair reaches 1.015x at e 0.9, and the 1:1 pair at e 0.9 reaches 1.061x at 20 iterations.
  - The gain is inherited from main's box-pair momentum drift, not added by the pass: with the switch off, momentum drifts by up to 46% at 10 iterations (15% at 20). G6 cannot pass until that drift is fixed.
