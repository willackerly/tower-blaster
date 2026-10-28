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
pnpm bench:browser --engines avbd-gpu:records=0,avbd-gpu:records=0,restitution=true --scenario S7 --bounce 0.5 --timing-mode throughput --channel chrome
```

`--bounce e` puts every body, spawn and the ground at restitution e (0 to 1), as the viewer's Bounce does; only an engine with `restitution=true` bounces, and the record's `scene.bounce` says it was set. The scenarios' own restitution is 0, so without it the pass has nothing to bounce.

GPU engines (`avbd-gpu`) only submit work in `step()`, so the harness waits for it with the engine's `finish()`. `--timing-mode latency` (the default) waits after every step: the cost of a step to a caller that needs its result. `--timing-mode throughput` waits once per block, so the GPU can overlap steps: the sustained cost per step, one sample per block, so no per-step p99 (the suite leaves its p95, p99 and budget columns blank). For CPU engines the two agree up to median against mean. A GPU error or a lost device makes `finish()` reject, so the run fails rather than timing work that never ran.

`bench:browser` serves the page, drives Chrome through Playwright with WebGPU developer features on (unquantized timestamps), and prints the page's result record. It exits with code 3 when timing can't be trusted there: no cross-origin isolation, a timer coarser than 20 µs, or a software GPU adapter for a GPU engine. Every run is also a URL, so the same benchmark can be opened by hand on any device.

### Standard suite

```sh
pnpm bench:suite --channel chrome       # about 5-10 minutes; writes results/suite-<time>.jsonl and .md
pnpm bench:suite --engine avbd-gpu --timing-mode throughput --channel chrome
pnpm bench:suite --engine avbd-gpu:boxBroadphase=true --cases kapla --channel chrome   # the Kapla cases only
```

### GPU primitives

```sh
pnpm bench:gpu --channel chrome         # copy roofline, dispatch overhead, scan, compaction, radix sort, readback latency
pnpm bench:gpu --quick                  # small sizes, for checking the pipeline
```

Writes `results/gpu-<time>.{json,md}`. GPU times come from timestamp queries, and each primitive's effective GB/s is reported as a fraction of a straight copy on the same device. The readback cases, `readback-<bytes>-fresh` and `readback-<bytes>-pooled` (by default 2 KB, an observation record, and 6.4 MB, a snapshot of 100k bodies), are wall-clock round trips from issuing the copy to holding the bytes on the CPU (`mapAsync` included): fresh makes a staging buffer each time (`readBuffer`), pooled reuses `Readback`'s. They are host latencies, not GPU kernels, so they have no "% of copy".

Results worth keeping go in `docs/benchmarks/` (the first is a CPU baseline from a cloud VM).

## Viewer

```sh
pnpm viewer                             # then open http://localhost:5173
```

Renders any engine live with WebGPU: drag to orbit, right-drag or shift-drag to pan, wheel to zoom, click to fire a ball, space to fire at the centre, R to reset, P to pause. Presets sit top right. The "Scene and projectile" panel under the HUD edits the current scenario's params and seed (Rebuild scene reloads it in place, without a page load) and what a click fires: a ball or a cube, its size, mass and speed. Scenario S14 (Buildings) sets a city by building count, width, depth, height, street and height variation. The scenario picker also lists the game's Keystone levels (URL key `level=L1` to `L5` in place of `scenario`): the level's bodies, materials and friction rule as the game builds them, drawn with its role tints (crowns gold, heritage celadon), after the game's 300-step presettle (`presettle=N`, any scene; settle steps in the panel). A level of your own is JSON (a `LevelDef`, `@tb/keystone` level.ts): Download level saves the picked level as a file to edit, Load level… runs an edited one in place, its `validateLevel` issues listed under the form (it loads anyway), and the URL carries it as `level.def=` (base64url JSON), a saved scene as `scene.levelDef`. The GPU engine's "Keystone settings" button sets the 40 iterations and gapSlop the game plays at. Keystone rules, aiming and scoring in the viewer come next (docs/design/viewer-superset.md). The panel's `bounce` box (off by default; GPU AVBD and avbd-ref only) turns restitution on, as the engine option `restitution=true`, and gives every body, the ground and what a click fires the restitution `bounce e` (URL key `bounce.e`, 0 to 1, default 0.5; the scenes' own surfaces are 0), applied by Rebuild scene: `?scenario=S1&param.F=3&param.H=6&engine=avbd-gpu:restitution=true&bounce.e=0.7`. At a cube size other than 1 m its threshold (1 m/s) is scaled with the rest of the world (docs/world-scale.md). Its Look section switches between `candy`, `hazy` and `real` (the photoreal look, docs/realism.md) and, for `real`, sets the sun's elevation and azimuth, the visibility (haze), sun strength, exposure, auto exposure and ground albedo, all live. The game takes the same `look=real&real.*` keys. The URL sets everything and the panel keeps it up to date, so a setup can be shared, for example `?scenario=S14&param.towers=16&param.H=20&proj=cube&proj.size=2&proj.speed=60` or `?scenario=S4&param.N=5000&param.F=5&param.H=16&engine=rapier` or `?scenario=S14&look=real&real.sunElevation=6&real.sunAzimuth=320&real.visibility=12`. The panel's Configuration section downloads the whole setup (scene with every param, engine and its options, loop, projectile, look with every `real` knob, and where the camera is) as a JSON file, named after the optional name you type or else after the scenario and time; Load… reads such a file back and rebuilds that setup in place (a different `loop` reloads the page). Unknown keys in a file are refused, so a typo in a hand-edited file is an error, and the file is self-contained, so later changes to defaults leave a saved scene as it was. The start camera is also the URL key `cam=x,y,z,yaw,pitch,distance`: R returns to it, and a preset or a scene rebuilt from the panel is framed afresh. The GPU engine sizes its broadphase grid for the projectile at start, so a projectile larger than every scene body rebuilds the scene when you pick it (and makes the grid coarser for the whole scene). The HUD shows physics ms/step (median and p95 over the last 30 steps) against the 7.5 ms budget, the step index, and sim speed: an engine slower than real time runs in slow motion rather than dropping steps. Physics steps in its own loop, back to back while steps are due, and every display frame draws the newest snapshot, interpolated from the one before it (about one step behind). With the GPU engine the frame rate does not wait for physics; a CPU engine steps on the main thread, so its frames run between steps and the frame rate is at most 1000 / (ms per step). The GPU engine's loop is pipelined: each step's snapshot read-back is queued right behind it, so when physics is behind, the next step goes to the GPU while the one before still runs (at most two queued), instead of the GPU idling through every read-back. Pipelined, the HUD's ms/step is each step's GPU time, to within the GPU's callback latency: from the later of its submit and the previous step's completion, to its own. `pipeline=0` times a step from before encoding to done, as before, so it reads encoding and callback latency more for the same work; compare the two by sim speed. The trade: while physics is behind, a click lands one step later than it would serially. `pipeline=0` waits for each read-back before the next step, for A/B runs. A hidden tab pauses physics. `loop=frame` restores stepping inside the frame: each frame steps, waits, reads back and renders, at most one step per frame, and `maxSteps=2` (up to 4) allows catch-up steps there.

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
| `gpu` | GPU primitives (profiler, scan, compaction, radix sort, bandwidth probe, pooled readback) and `bench:gpu` |
| `physics-gpu` | GPU AVBD engine (`GpuAvbdEngine`): broadphase, narrowphase, graph colouring and solver, matched step by step against `physics-ref` |
| `physics-ref` | Reference AVBD rigid-body solver in double precision: the oracle for the GPU solver (`avbd-ref` in the bench) |
| `testkit` | Headless Chromium WebGPU sessions for tests |
| `render` | WebGPU renderer: GPU culling and indirect draws straight from Body buffers (design: docs/render-design.md) |
| `viewer` | Interactive WebGPU viewer (`pnpm viewer`) |
