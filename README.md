# tower-blaster

A browser game about knocking down cube towers with balls, built to simulate as many rigid blocks as possible in real time on WebGPU (target: 10,000 cubes at 30 fps minimum, 100,000 stretch).

The engine plan, research and phase gates are in [docs/plan.md](docs/plan.md).

## Getting started

```sh
pnpm install
pnpm exec playwright install chromium   # headless WebGPU for GPU correctness tests
pnpm check                              # typecheck + all tests
pnpm bench selfcheck                    # harness gate G1: A/A and injected 10% slowdown
pnpm bench scenarios                    # list S1-S11 and their parameters
pnpm bench run --engine rapier --scenario S4 --param N=10000 --quality
pnpm bench compare --a rapier --b rapier:iterations=8 --scenario S1 --no-sleep
pnpm bench run --engine tiered --scenario S4 --param N=10000   # dormant lattice tier over Rapier
pnpm tiers:compare --scenario S5 --param N=1600 --runs 4      # tiered vs all-dynamic Rapier on one shot
```

Results print as JSON; add `--out results/name.jsonl` to append them to a file.

### In a real browser

```sh
pnpm runner                             # serve the runner page (cross-origin isolated) for manual runs
pnpm bench:browser --engines rapier --scenario S4 --param N=10000 --channel chrome
pnpm bench:browser --engines rapier,rapier:iterations=8 --scenario S1 --sleep false --headed
pnpm bench:browser --engines avbd-gpu --scenario S7 --param N=10000 --timing-mode throughput --channel chrome
```

GPU engines (`avbd-gpu`) only submit work in `step()`, so the harness waits for it with the engine's `finish()`. `--timing-mode latency` (the default) waits after every step: the cost of a step to a caller that needs its result. `--timing-mode throughput` waits once per block, so the GPU can overlap steps: the sustained cost per step, one sample per block, so no per-step p99 (the suite leaves its p95, p99 and budget columns blank). For CPU engines the two agree up to median against mean. A GPU error or a lost device makes `finish()` reject, so the run fails rather than timing work that never ran.

`bench:browser` serves the page, drives Chrome through Playwright with WebGPU developer features on (unquantized timestamps), and prints the page's result record. It exits with code 3 when timing can't be trusted there: no cross-origin isolation, a timer coarser than 20 µs, or a software GPU adapter for a GPU engine. Every run is also a URL, so the same benchmark can be opened by hand on any device.

### Standard suite

```sh
pnpm bench:suite --channel chrome       # about 5-10 minutes; writes results/suite-<time>.jsonl and .md
pnpm bench:suite --engine avbd-gpu --timing-mode throughput --channel chrome
```

### GPU primitives

```sh
pnpm bench:gpu --channel chrome         # copy roofline, dispatch overhead, scan, compaction, radix sort
pnpm bench:gpu --quick                  # small sizes, for checking the pipeline
```

Writes `results/gpu-<time>.{json,md}`. GPU times come from timestamp queries, and each primitive's effective GB/s is reported as a fraction of a straight copy on the same device.

Results worth keeping go in `docs/benchmarks/` (the first is a CPU baseline from a cloud VM).

## Viewer

```sh
pnpm viewer                             # then open http://localhost:5173
```

Renders any engine live with WebGPU: drag to orbit, right-drag or shift-drag to pan, wheel to zoom, click to fire a ball, space to fire at the centre, R to reset, P to pause. Presets sit top right. The URL sets everything, for example `?scenario=S4&param.N=5000&param.F=5&param.H=16&engine=rapier`. The HUD shows physics ms/step (median and p95 over the last 120 steps) against the 7.5 ms budget, plus sim speed: an engine slower than real time runs in slow motion rather than dropping steps.

## Layout

| Package | Role |
|---|---|
| `engine-api` | The `PhysicsEngine` contract shared by the game, the harness and every engine |
| `schema` | GPU buffer layouts, defined once; generates WGSL and TS accessors |
| `geom` | Double-precision reference geometry (SAT, broadphase, contact manifolds) used as a test oracle |
| `scenarios` | Seeded benchmark scenes S1-S11 |
| `metrics` | Quality metrics and benchmark statistics |
| `lattice` | Dormant tier: intact towers as a voxel lattice, support rules (loose columns), GPU brick export |
| `adapter-rapier` | CPU baseline (Rapier WASM) |
| `bench` | Timing and quality runs, CLI |
| `runner` | Browser runner page, Playwright orchestrator (`bench:browser`) |
| `gpu` | GPU primitives (profiler, scan, compaction, radix sort, bandwidth probe) and `bench:gpu` |
| `physics-gpu` | GPU AVBD engine (`GpuAvbdEngine`): broadphase, narrowphase, graph colouring and solver, matched step by step against `physics-ref` |
| `physics-ref` | Reference AVBD rigid-body solver in double precision: the oracle for the GPU solver (`avbd-ref` in the bench) |
| `testkit` | Headless Chromium WebGPU sessions for tests |
| `render` | WebGPU renderer: GPU culling and indirect draws straight from Body buffers (design: docs/render-design.md) |
| `viewer` | Interactive WebGPU viewer (`pnpm viewer`) |
