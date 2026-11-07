# Quality tiers by device (roadmap P1)

Status 2026-11-07. A short probe on load picks one of three tiers, **low**, **mid** or **high**, and the player can override it under Advanced settings (**Quality**: Auto, High, Medium, Low) or for one visit with `?quality=auto|high|mid|low`. The names are the WeaponSpec caps' (`@tb/weapons` `tiers.ts`, roadmap C12), so a shared weapon capped for a tier cannot overload a device of that tier.

Code: `packages/game/src/quality.ts` (the tiers, the pick, pure), `packages/game/src/quality-probe.ts` (the probe on load), `packages/render/src/tier-probe.ts` (the two measurements), wired in `packages/game/src/main.ts`. The page reports what it decided as `window.__game.quality` (`GameHandle.quality`): the setting, the tier in effect and why, what the probe measured, and the knobs.

## What a tier sets

Every knob already existed at run time, so no tier has a shader of its own and **high is the game exactly as it was before tiers** (the pinned image hashes and every test that does not ask for a tier are unchanged).

| Knob | high | mid | low |
|---|---|---|---|
| Device pixels per CSS pixel, at most (`maxDpr`; Sharpness caps it too) | 2 | 1 | 0.5 |
| Sun shadows | on | on | on |
| Ambient occlusion | on | on | off |
| Effect particles (sparks; in Photoreal, impact dust and chips) | on | on | off |
| Frames drawn (`keystone.frames`, unless the URL says) | all | auto | auto |

- **Resolution is the main lever.** On a 2x screen mid draws a quarter of high's pixels and low a sixteenth. Below 1 the canvas is drawn smaller and stretched by the browser.
- **Why shadows stay.** They place the blocks on the ground and show where a block will land, which the aim reads. On SwiftShader the 2048² shadow map is a fixed ~27 ms of a 250-700 ms frame; on a real GPU it is a small share. A shadow-free tier is a follow-up if a real low-end machine needs it.
- **Frames 'auto'** draws half the frames only on a display of 110 Hz or more while physics is behind (frame-rate.ts, E7). It changes nothing on a 60 Hz screen. high stays on 'all' until the E7 round-3 A/B on the M5 decides the default for everyone.
- **Sharpness** (Full, Fast) still caps the canvas: the resolution is the lower of the two.

## The probe

`probeQuality(device, adapter, cssWidth, cssHeight, devicePixelRatio)` runs once, after the device is created and before the renderer and the first level (so its pipelines warm Dawn's cache for them):

1. **A software adapter** (SwiftShader, llvmpipe, lavapipe, or a fallback adapter: `isSoftwareAdapter` in `@tb/gpu`) is **low** at once, in about 0.1 ms.
2. **The step's proxy.** A chain of 64 dependent compute dispatches (4,096 threads each, every dispatch reading what the last wrote) in one submit, after a warmup round, three rounds: wall ms per dispatch. The GPU solver is latency bound (a step is a long chain of small dependent dispatches; see the M5 cost model in the benchmarks), so a 1k level's step is predicted as `STEP_DISPATCHES` (2400) of these.
3. **The frame budget**: half of what that step leaves of a 60 Hz frame, `0.5 × (16.7 − step)`, where the proxy is calibrated (`ProbeResult.calibrated`: software adapters, so far). Physics and frames share one GPU queue (docs/pipelining.md), so a device whose physics is slow has less room to draw. Under 1 ms of budget, the tier is **low** (reason `physics`). On a GPU the step is reported and the budget is a frame's without physics, 8.3 ms (below, "The M5 read low").
4. **Frames at high's size and toggles**: an offscreen renderer drawing the render bench's 'near' heap of 1,000 cubes (the worst overdraw, `bench-world.ts`) at the canvas's own size at 2x, in the maquette look; one warmup frame, then up to 5 timed frames within 250 ms. The median fits the budget: **high**. Otherwise the same at mid's size and toggles: **mid**. Otherwise **low** (reason `frame`). A tier whose first timed frame is 3x over budget is ruled out at once, so a slow device spends one frame per size.

An offscreen page (`offscreen=1`, every browser test) runs no probe unless the URL says `quality=auto`, and keeps high. A probe that throws leaves **mid** (reason `error`).

## Measurements so far

SwiftShader in this cloud container (4 cores; **not performance results**, CLAUDE.md, but they set the calibration and show the shape of the cost):

- Render bench, 1,000 cubes, hazy look: `near` 716 ms a frame at 640x400, 288 at 320x200, 148 at 160x100; `far` 112, 111, 90. Fixed passes that do not shrink with the pixels: culling ~22-27 ms (the sparks' detector ~15 of it), the shadow map ~27 ms, bloom and composite ~2-6 ms. Per pass at 640x400: no shadow −5%, no AO −9%, no sparks −4%; real look +45%.
- The probe's frames match the bench (718, 723, 691 ms at 640x400). The renderer's warmup frame: 2.2 s on a fresh device, about 1.2 s for a second renderer on the same device.
- The chain: 0.125-0.142 ms a dispatch. B1 on the GPU solver during a shot: a median 299 ms a step. So `STEP_DISPATCHES` = 299 / 0.125 ≈ 2400, and SwiftShader's predicted step is 300-340 ms: physics alone runs at about 3 steps a second, the budget is negative, and the measured probe picks low (reason `physics`) in about 50 ms. Named rather than measured (the default path), it picks low in 0.1 ms.

On the M5 Max (bench queue, out of Low Power Mode): `TB_CHANNEL=chrome pnpm vitest run packages/game/test/quality-e2e.test.ts` runs the Metal case: Will's screen (1728 x 1117 points at 2x) must pick high in under a second with the proxy uncalibrated, and it prints B1's real step cost on the GPU solver against the predicted one and the `STEP_DISPATCHES` that run implies (data, no assertion; see "The M5 read low"). Checked on the live build after the fix (b5fda7e, 2026-11-07, Chrome headless, apple metal-3, B1, Low Power Mode unknown): **high, reason `fits`**; the chain 0.0314 ms a dispatch (so an uncalibrated 75 ms step at 2400, past every tier's budget, where B1's real step is ~5 ms), the high frame 4.3 ms against the 8.3 ms budget, mid not timed, the probe 134 ms in all. A 1k step of ~5 ms over 0.031 ms is about 160 chain dispatches on the M5, against 2400 on SwiftShader: a 15x gap, so one constant cannot serve both. Numbers from one non-M5 machine with a real GPU are still wanted for mid's boundary.

## The M5 read low (2026-11-07), and the fix

The live build (main 95d36c7) on the M5 Max in Chrome (headless, Metal, Low Power Mode possibly on) picked **low, reason `physics`**. `STEP_DISPATCHES` was calibrated on SwiftShader, where a chain dispatch is mostly work (4,096 threads on 4 CPU cores) and B1's step is 2400 of them. On a GPU a dependent dispatch is mostly latency (about 5 µs on the M5, docs/benchmarks/2026-10-25-m5max-gpu-primitives.md), and the ratio is the solver's own dispatch count, several times smaller: a 1k step on the M5 costs about 5 ms (rain 1k, 4.97 ms), but 2400 chain dispatches of 6 µs or more already predict a step past a frame. The constant does not transfer between a CPU rasteriser and a GPU, so one number cannot serve both.

Fix: the step proxy rules a tier out only on adapters it was calibrated on (software). On a GPU the probe still runs the chain and reports `dispatchMs` and `stepMs` (in `__game.quality.probe`), but frames are held to a whole frame's budget, and only slow frames step a GPU down. The tier cannot make physics cheaper anyway: the step costs the same at every tier, and a slow step is the frame governor's and the pacing valve's to absorb. Unit test: the M5's case (12 µs a dispatch, a 2 ms frame) is high, and is low by physics through the calibrated rule, as the live build did.

Alternatives considered:
- **Recalibrate `STEP_DISPATCHES` for GPUs** from the M5's numbers. Right in principle, but one GPU's ratio is a guess for the next (a latency ratio depends on the driver and the power state), and the M5's raw chain number was not captured. The Metal case of quality-e2e now prints it and the ratio to B1's real step, as the data a GPU calibration would start from.
- **Floor a GPU at mid** whatever physics says. Simple, but keeps the uncalibrated number in charge of the M5's tier: mid draws a quarter of high's pixels on Will's screen.
- **Time real solver steps in the probe** (a GPU engine on a 1k heap). The truest number, but it adds an engine's build to every load and depends on the heap's contacts; a later step if a real GPU needs physics in its tier.

## The 30 fps gate, changed

The roadmap asked for SwiftShader in CI to hold 30 fps on a 1k level at the low tier. Measured, it cannot, at any tier this renderer has: the fixed passes alone are ~55 ms (18 fps at zero pixels), and low at the CI viewport (320 x 200 device pixels, no AO, no sparks) is ~245 ms a frame. Getting to 33 ms would take a separate renderer for software adapters (no shadow map, no culling pass, a flat shader), which no player would see: Chrome offers SwiftShader to WebGPU pages only behind a flag, and a machine without a GPU gets the no-WebGPU page. Also, headless SwiftShader loses its device when a page draws to a canvas (load-cost.test.ts; checked again here), so CI cannot count presented frames at all.

So the gate in CI is functional: SwiftShader lands on low, by name in 0.1 ms and by measurement in ~50 ms; the tier's knobs reach the canvas size, the frame governor and the renderer (the same still view drawn high, low, high again: ~3% of pixels change for low, none for high again). CI compares no wall times (a shared runner can reorder two SwiftShader frames: one shard drew low at 952 ms and high at 630). The 30 fps question moves to a real low-end GPU (roadmap P6).

## Alternatives considered

- **Adapter identity only** (a table of vendors, architectures, `isFallbackAdapter`). Free and instant, but WebGPU's adapter info is deliberately coarse (often just a vendor and an architecture family) and says nothing about the screen the frames are drawn at or the power state: an M5 in Low Power Mode, or a 4K screen on an integrated GPU. Kept only for software adapters, which it names exactly.
- **A synthetic fill-rate kernel** (one fragment shader of fixed cost, then a model from ms per megapixel to the renderer's frame). Cheap to compile, but the model needs a calibration factor per architecture: on SwiftShader the renderer's cost is dominated by per-pass overhead, on a GPU by fragments, so one factor cannot serve both. Timing the real renderer at the real size needs no such factor; its compile is paid by the game's renderer anyway (Dawn's cache), so it costs only the timed frames.
- **Measure the game's own first frames** (the level behind the door). The truest workload, but it depends on the level (B1's 1,000 blocks or B3's 10,000) and the look, the tier would differ by which level the page opened on, and offscreen pages never draw. A fixed workload gives a device tier.
- **Dynamic resolution** (adjust the render scale every second from the frame times). The best long-run answer for steady frame rates, but it changes the picture during play, which reads as a bug in a game about watching collapses, and it needs GPU timings the game does not ask for. A later step can add a one-way step down when play runs far over budget (roadmap P1c, idea).
- **Cache the probe's tier** in storage. It would save ~50 ms on the M5, but keep a tier picked in Low Power Mode or on another screen. The probe runs on every load; the stored Quality setting is the player's way to pin a tier.
- **Fold Sharpness into Quality.** Sharpness stays as it was (a stored setting and `?sharp=`) and caps the tier's resolution, so a stored Fast keeps working.
- **Shadows off in low.** Kept on (above).

## Verification

- `game/test/quality.test.ts` (pure): the knob table (high as before tiers, each tier down no costlier, shadows everywhere), Sharpness and `keystone.frames` over a tier, the budget, the pick for software, SwiftShader's measured numbers, the M5's case (the proxy rules nothing out on a GPU), fast and slow devices, a missing measurement, the tier for each setting, the canvas size, the setting and `?quality=`, the door's Quality row.
- `game/test/quality-e2e.test.ts` (SwiftShader): the probe on load picks low in under a second and low's knobs are in effect; measured instead of named, it is low by physics in under a second; an offscreen page keeps high with no probe, `?quality=low` and `mid` set their knobs, `keystone.frames` wins; the toggles reach the renderer (high, low, high again); the door's row applies at once, is stored and drops `?quality=`, and Auto names the probe's tier. With `TB_CHANNEL=chrome`: the M5 case above.
- `render/test/tier-probe.test.ts` (SwiftShader): the probe's frames and dispatch chains run without validation errors, the stop rule.
