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
