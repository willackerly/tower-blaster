# GPU primitives on the target machine (Apple M5 Max)

`pnpm bench:gpu --channel chrome`: Chrome 156 headless, Metal-3 adapter, GPU timestamp queries without quantization, commit 408ddbe. The raw output is at the end.

## Headline numbers

| Measure | Value | What it means for the engine |
|---|---|---|
| Copy, 256 MiB (beyond the system-level cache) | **522 GB/s** | The DRAM roofline. Every other figure is read against it |
| Back-to-back dispatch | **0.85 µs** | A step pipeline of about 60 dispatches costs about 50 µs of fixed overhead, under 1% of the 7.5 ms budget |
| Scan, 100k | 8 µs | Latency-bound: small arrays cost a near-constant 7-13 µs per primitive |
| Compact, 100k, 30% kept | 13 µs | Rebuilding the awake list every step costs almost nothing |
| Radix sort, 100k keys, 20-bit | **125 µs** | A full sort for a 100k-body spatial hash is 1.7% of the step budget |
| Radix sort, 1M keys, 32-bit | 1.2 ms (210 GB/s, 40% of copy) | Fine for pair lists. Fusing passes or using subgroups could double it, but it is not on the critical path |

## Reading the "% of copy" column

- **Above 100%** (scan at 1M and 16M, compaction at 1M): the working set fits in, or largely reuses, the system-level cache, and the traffic model counts both passes as DRAM traffic. These are cache effects, not a measurement error. The 256 MiB copy is the DRAM figure.
- **Below about 25%** (anything at 10k to 100k): launch and inter-dispatch latency dominate. For 10k to 100k bodies the engine will be latency-bound rather than bandwidth-bound. The pass count per step matters more than bytes per pass.
- **Radix sort at about 40%** at large n: the four in-shared-memory splits per pass cost compute and barriers. Known improvements are a subgroup ballot split, an 8-bit digit with a fused histogram, and skipping passes whose digit is constant. Not worth doing until a profile shows sort on the critical path.

## Projection for the solver

The plan estimates 5 to 15 KB of memory traffic per active body per step for AVBD. Assuming the solver reaches about 40% of copy bandwidth, as the sort does, gives 209 GB/s, or about 1.57 GB per 7.5 ms step:

| Traffic per body per step | Bodies in 7.5 ms at 40% of copy | At 70% of copy |
|---|---|---|
| 5 KB (debris pile, about 8 contacts per body) | about 310k | about 550k |
| 15 KB (packed lattice, about 20 contacts per body) | about 105k | about 180k |

So **10k active bodies uses an estimated 3 to 10% of the budget**, and 100k is plausible on this machine, which matches three-avbd's 110k bricks at 10.4 ms on an M4 Max. At 10k the real constraint will be latency (pass count × about 5 µs per dependent dispatch), not bandwidth. This is an estimate to check against the P3 solver, not a measurement.

## Raw output

## GPU primitives, commit 408ddbe

2026-10-25T07:37:16.436Z · Mac · Apple M5 Max × 18 · darwin · Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36

Adapter: apple metal-3 Apple M5 Max
Timing: GPU timestamp queries

| Case | n | Median ms | p10 | p90 | M elem/s | Effective GB/s | % of copy |
|---|---|---|---|---|---|---|---|
| copy-256MiB | 268,435,456 | 1.028 | 0.981 | 1.120 | 261120 | 522 | 100% |
| dispatch-x200 | 200 | 0.170 | 0.159 | 0.250 |  |  |  |
| scan-10000 | 10,000 | 0.007 | 0.007 | 0.008 | 1437 | 23.0 | 4% |
| scan-100000 | 100,000 | 0.008 | 0.008 | 0.045 | 12060 | 193 | 37% |
| scan-1000000 | 1,000,000 | 0.030 | 0.029 | 0.049 | 33852 | 542 | 104% |
| scan-16000000 | 16,000,000 | 0.464 | 0.459 | 0.560 | 34494 | 552 | 106% |
| compact-100000-30pct | 100,000 | 0.013 | 0.013 | 0.013 | 7818 | 260 | 50% |
| compact-1000000-30pct | 1,000,000 | 0.050 | 0.050 | 0.058 | 19984 | 663 | 127% |
| sort-10000-32bit | 10,000 | 0.119 | 0.113 | 0.121 | 84.2 | 21.5 | 4% |
| sort-10000-20bit | 10,000 | 0.075 | 0.070 | 0.077 | 134 | 21.4 | 4% |
| sort-100000-32bit | 100,000 | 0.200 | 0.198 | 0.333 | 500 | 128 | 25% |
| sort-100000-20bit | 100,000 | 0.125 | 0.125 | 0.160 | 798 | 128 | 24% |
| sort-1000000-32bit | 1,000,000 | 1.196 | 1.193 | 1.348 | 836 | 214 | 41% |
| sort-1000000-20bit | 1,000,000 | 0.763 | 0.746 | 0.895 | 1311 | 210 | 40% |
| sort-4000000-32bit | 4,000,000 | 5.253 | 5.031 | 5.428 | 762 | 195 | 37% |
| sort-4000000-20bit | 4,000,000 | 3.229 | 3.055 | 3.393 | 1239 | 198 | 38% |

**Dispatch overhead**: 0.848 µs per back-to-back dispatch in one pass.

Effective GB/s uses a nominal traffic model per primitive (see packages/gpu/src/bench.ts); "% of copy" compares it with the straight copy on the same device.
