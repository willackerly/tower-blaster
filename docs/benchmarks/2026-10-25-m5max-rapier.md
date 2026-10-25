# Rapier CPU baseline on the target machine (Apple M5 Max)

The first suite run on the target machine: Rapier (single-threaded WASM, SIMD) in headless Chrome 156 with the Metal-3 adapter. Selfcheck passed before the run, all 10 cases are valid, and background load was light. Compare with the [VM run](2026-10-25-vm-rapier.md).

## Comparison

| Case | M5 Max median (ms) | VM median (ms) | Speedup | M5 Max p99 (ms) |
|---|---|---|---|---|
| rain-awake-1000 | 2.50 | 5.05 | 2.0x | 3.93 |
| rain-awake-2000 | 4.86 | 9.69 | 2.0x | 8.39 |
| rain-awake-5000 | 14.4 | 32.0 | 2.2x | 24.2 |
| rain-awake-10000 | 31.6 | 79.2 | 2.5x | 50.2 |
| rain-awake-20000 | 64.0 | 165 | 2.6x | 100 |
| city-10k-asleep | 1.09 | 2.05 | 1.9x | 1.31 |
| city-10k-awake | 42.4 | 126 | 3.0x | 63.9 |
| impact-10k | 46.4 | 133 | 2.9x | 89.0 |
| tower-packed | 6.76 | 12.6 | 1.9x | 11.5 |
| tower-gapped | 0.21 | 0.29 | 1.4x | 0.33 |

## What this tells us

- **CPU is ruled out, as planned.** On the M5 Max, Rapier reaches the 7.5 ms budget at about 2,800 awake cubes (fit N^1.10, r² 0.999), against a 10k minimum. 10k awake cubes cost 31.6 ms median, 4.2x over budget. The ball-impact spike costs 46 ms median and 89 ms p99, about 12x over budget. The WASM build uses one of the 18 cores. A perfect 12-way parallel CPU solver would only just reach 10k, with no headroom for 100k.
- **The gap widens with load.** The speedup grows from 2.0x at 1k to 2.6x at 20k, and is about 3x for the 10k city cases. This fits a memory-bound workload that benefits from the M5's bandwidth and cache more than from its clock.
- **The packed-lattice penalty holds on the target: 33x** (VM 43x). Touching columns are still awake 1 s after load. A loose tower must not rely on the solver to settle; the lattice tier must hold intact towers out of the solver, as the plan says.
- **Idle cost is low but not zero.** A sleeping 10k city costs 1.09 ms per step, mostly broadphase upkeep. The lattice tier's target for a 100k idle world is under 1 ms (gate G3). This is the number to beat.

## Raw summary

Machine: Apple M5 Max × 18, Chrome 156 (headless), adapter apple metal-3, commit 5fbfc88.

| Case | Bodies | Median ms/step | p95 | p99 | Within 7.5 ms | Valid |
|---|---|---|---|---|---|---|
| rain-awake-1000 | 1000 | 2.50 | 3.66 | 3.93 | yes | yes |
| rain-awake-2000 | 2000 | 4.86 | 7.98 | 8.39 | no | yes |
| rain-awake-5000 | 5000 | 14.4 | 23.1 | 24.2 | no | yes |
| rain-awake-10000 | 10000 | 31.6 | 47.0 | 50.2 | no | yes |
| rain-awake-20000 | 20000 | 64.0 | 96.1 | 100 | no | yes |
| city-10k-asleep | 10000 | 1.09 | 1.24 | 1.31 | yes | yes |
| city-10k-awake | 10000 | 42.4 | 60.0 | 63.9 | no | yes |
| impact-10k | 10000 | 46.4 | 85.9 | 89.0 | no | yes |
| tower-packed | 1920 | 6.76 | 11.2 | 11.5 | no | yes |
| tower-gapped | 1920 | 0.21 | 0.28 | 0.33 | yes | yes |
