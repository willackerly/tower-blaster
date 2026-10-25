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
```

Results print as JSON; add `--out results/name.jsonl` to append them to a file.

### In a real browser

```sh
pnpm runner                             # serve the runner page (cross-origin isolated) for manual runs
pnpm bench:browser --engines rapier --scenario S4 --param N=10000 --channel chrome
pnpm bench:browser --engines rapier,rapier:iterations=8 --scenario S1 --sleep false --headed
```

`bench:browser` serves the page, drives Chrome through Playwright with WebGPU developer features on (unquantized timestamps), and prints the page's result record. It exits with code 3 when timing can't be trusted there: no cross-origin isolation, a timer coarser than 20 µs, or a software GPU adapter for a GPU engine. Every run is also a URL, so the same benchmark can be opened by hand on any device.

### Standard suite

```sh
pnpm bench:suite --channel chrome       # about 5-10 minutes; writes results/suite-<time>.jsonl and .md
```

### GPU primitives

```sh
pnpm bench:gpu --channel chrome         # copy roofline, dispatch overhead, scan, compaction, radix sort
pnpm bench:gpu --quick                  # small sizes, for checking the pipeline
```

Writes `results/gpu-<time>.{json,md}`. GPU times come from timestamp queries, and each primitive's effective GB/s is reported as a fraction of a straight copy on the same device.

Results worth keeping go in `docs/benchmarks/` (the first is a CPU baseline from a cloud VM).

## Layout

| Package | Role |
|---|---|
| `engine-api` | The `PhysicsEngine` contract shared by the game, the harness and every engine |
| `schema` | GPU buffer layouts, defined once; generates WGSL and TS accessors |
| `geom` | Double-precision reference geometry (SAT, broadphase) used as a test oracle |
| `scenarios` | Seeded benchmark scenes S1-S11 |
| `metrics` | Quality metrics and benchmark statistics |
| `adapter-rapier` | CPU baseline (Rapier WASM) |
| `bench` | Timing and quality runs, CLI |
| `runner` | Browser runner page, Playwright orchestrator (`bench:browser`) |
| `gpu` | GPU primitives (profiler, scan, compaction, radix sort, bandwidth probe) and `bench:gpu` |
| `physics-gpu` | GPU physics pipeline stages (broadphase so far) |
| `testkit` | Headless Chromium WebGPU sessions for tests |
