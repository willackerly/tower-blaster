# Renderer on the target machine (Apple M5 Max)

`pnpm bench:render`: Chrome 156 headless, Metal-3 adapter, 2560x1440, 4x MSAA HDR, shadows and bloom on. Two runs: commit 36525e9 (first) and bb1add0 (after the fixes below). The raw output of both is at the end.

## Headline numbers (bb1add0)

| World | 10k bodies | 100k bodies |
|---|---|---|
| near (rubble filling the view) | **0.65 ms** | **1.55 ms** |
| far (towers of cubes about 6 px wide) | **0.45 ms** | **1.38 ms** |

Wall time per frame, median over 10 interleaved batches of 30 frames (95% CI within ±1%). The 30 fps budget is 33 ms, so **100k cubes use under 5% of it**, and leave the rest for physics. The GPU frame span agrees with wall time (near 100k: 1.53 vs 1.55 ms).

| Marginal cost at 100k | near | far |
|---|---|---|
| Shadow pass | 0.39 ms (25%) | 0.12 ms (9%) |
| Post (bloom + AgX) | 0.18 ms (12%) | 0.19 ms (14%) |

## What the first run got wrong, and what changed

1. **Per-pass timestamps over-count on Apple's tile-based GPU.** The first run's "GPU p50" was the sum of per-pass intervals: 9.7 ms for far 100k, against 1.84 ms of wall time. Bloom alone summed to 3.7 ms in a 0.66 ms frame, but switching post off saved only 0.17 ms. Passes overlap, and each of the small bloom passes reports a long interval. The bench now reports the span from the first pass begin to the last pass end, and keeps the sum only for direction.
2. **Box path per pass.** The first run showed the 18-vertex hexagon fan faster in the shadow pass and slower in the scene pass than the 36-vertex cube. The path is now chosen per pass (scene: cube, shadow: fan). Between the runs, 100k frames got 18-25% faster (near 1.90 to 1.55 ms, far 1.84 to 1.38 ms). The fitted shadow map (R3 step 12) also landed between the runs, but the variants show the path change accounts for nearly all of it: the all-fan variant is +19% and +32%. The cube's shadow pass also now culls faces turned away from the light. Before, it drew all twelve triangles, which made that comparison unfair. With the culling, the fan still wins the shadow pass at 100k: 0.52 vs 0.55 ms near, 0.18 vs 0.25 ms far.
3. **Where the fan loses.** The flat-shading variants separate fragment shading from vertex, raster and binning cost. With flat albedo the fan is 4-10% *faster* than the cube at 100k, since it runs half the vertices. With the full box shader, the fan's scene pass costs 1.43 ms against the cube's 0.98 ms (far 100k). So the fan's loss is entirely in fragment shading: about 1.0 ms against 0.53 ms. The likely cause is more fragment-shader invocations per covered pixel with the fan's triangulation: either more pixels straddling internal edges under MSAA, or quad helpers for the derivatives the shader uses. Not confirmed; that needs a GPU frame capture. The fan's half-vertex advantage would come back with a shading model that does not depend on triangulation, such as a visibility buffer, which is a possible later option.

## Raw output: bb1add0

### Renderer, commit bb1add0

2026-10-25T11:39:52.107Z · Mac · Apple M5 Max × 18 · darwin · Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36

Adapter: apple metal-3 Apple M5 Max · 2560x1440 · timing: GPU timestamps + wall

GPU frame: first pass begin to last pass end. Pass columns and their sum are for direction only: on tile-based GPUs passes overlap and the sum over-counts.

| World | Bodies | Variant | Frame ms (wall, median) | 95% CI | GPU frame p50 | GPU frame p95 | Pass sum p50 | cull | shadow | scene | bloom | composite | Boxes drawn | Shadow boxes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| near | 10,000 | full | 0.653 | 0.650-0.655 | 0.638 | 0.643 | 4.347 | 0.016 | 0.083 | 0.374 | 3.523 | 0.357 | 10,000 | 10,000 |
| near | 10,000 | no-shadow | 0.587 | 0.585-0.592 | 0.577 | 0.582 | 4.264 | 0.015 |  | 0.374 | 3.517 | 0.358 | 10,000 | 10,000 |
| near | 10,000 | no-post | 0.478 | 0.477-0.480 | 0.466 | 0.471 | 0.472 | 0.015 | 0.083 | 0.374 |  |  | 10,000 | 10,000 |
| near | 10,000 | fan | 0.650 | 0.650-0.650 | 0.628 | 0.639 | 4.450 | 0.015 | 0.083 | 0.372 | 3.604 | 0.372 | 10,000 | 10,000 |
| near | 10,000 | cube | 0.655 | 0.653-0.657 | 0.631 | 0.632 | 4.345 | 0.015 | 0.084 | 0.374 | 3.531 | 0.359 | 10,000 | 10,000 |
| near | 10,000 | flat-fan | 0.513 | 0.513-0.517 | 0.495 | 0.506 | 2.876 | 0.015 | 0.083 | 0.239 | 2.261 | 0.278 | 10,000 | 10,000 |
| near | 10,000 | flat-cube | 0.520 | 0.518-0.522 | 0.499 | 0.510 | 2.903 | 0.015 | 0.083 | 0.242 | 2.283 | 0.280 | 10,000 | 10,000 |
| near | 100,000 | full | 1.553 | 1.550-1.570 | 1.528 | 1.793 | 6.980 | 0.077 | 0.524 | 0.891 | 4.962 | 0.525 | 100,000 | 100,000 |
| near | 100,000 | no-shadow | 1.160 | 1.160-1.173 | 1.140 | 1.377 | 6.443 | 0.075 |  | 0.879 | 4.965 | 0.526 | 100,000 | 100,000 |
| near | 100,000 | no-post | 1.370 | 1.367-1.377 | 1.353 | 1.617 | 1.494 | 0.078 | 0.524 | 0.891 |  |  | 100,000 | 100,000 |
| near | 100,000 | fan | 1.853 | 1.850-1.863 | 1.833 | 2.094 | 7.226 | 0.077 | 0.516 | 1.196 | 4.913 | 0.521 | 100,000 | 100,000 |
| near | 100,000 | cube | 1.573 | 1.570-1.580 | 1.551 | 1.811 | 7.007 | 0.077 | 0.551 | 0.892 | 4.961 | 0.525 | 100,000 | 100,000 |
| near | 100,000 | flat-fan | 1.415 | 1.413-1.423 | 1.392 | 1.673 | 5.326 | 0.081 | 0.514 | 0.754 | 3.579 | 0.400 | 100,000 | 100,000 |
| near | 100,000 | flat-cube | 1.477 | 1.470-1.482 | 1.452 | 1.720 | 5.421 | 0.082 | 0.538 | 0.792 | 3.609 | 0.402 | 100,000 | 100,000 |
| far | 10,000 | full | 0.452 | 0.450-0.457 | 0.436 | 0.454 | 2.933 | 0.015 | 0.034 | 0.211 | 2.393 | 0.279 | 10,000 | 10,000 |
| far | 10,000 | no-shadow | 0.428 | 0.423-0.440 | 0.416 | 0.436 | 2.917 | 0.015 |  | 0.211 | 2.408 | 0.285 | 10,000 | 10,000 |
| far | 10,000 | no-post | 0.278 | 0.277-0.287 | 0.265 | 0.286 | 0.260 | 0.015 | 0.034 | 0.211 |  |  | 10,000 | 10,000 |
| far | 10,000 | fan | 0.493 | 0.490-0.497 | 0.479 | 0.493 | 2.990 | 0.015 | 0.034 | 0.253 | 2.404 | 0.284 | 10,000 | 10,000 |
| far | 10,000 | cube | 0.457 | 0.457-0.460 | 0.439 | 0.453 | 2.939 | 0.015 | 0.039 | 0.211 | 2.396 | 0.282 | 10,000 | 10,000 |
| far | 10,000 | flat-fan | 0.397 | 0.397-0.403 | 0.375 | 0.376 | 2.551 | 0.015 | 0.034 | 0.159 | 2.084 | 0.260 | 10,000 | 10,000 |
| far | 10,000 | flat-cube | 0.403 | 0.403-0.405 | 0.383 | 0.385 | 2.566 | 0.015 | 0.039 | 0.162 | 2.088 | 0.261 | 10,000 | 10,000 |
| far | 100,000 | full | 1.383 | 1.382-1.390 | 1.356 | 1.391 | 9.204 | 0.077 | 0.186 | 0.980 | 7.249 | 0.713 | 100,000 | 100,000 |
| far | 100,000 | no-shadow | 1.260 | 1.253-1.265 | 1.233 | 1.263 | 9.160 | 0.071 |  | 0.979 | 7.371 | 0.743 | 100,000 | 100,000 |
| far | 100,000 | no-post | 1.197 | 1.195-1.203 | 1.177 | 1.204 | 1.236 | 0.071 | 0.185 | 0.978 |  |  | 100,000 | 100,000 |
| far | 100,000 | fan | 1.833 | 1.830-1.838 | 1.809 | 2.055 | 9.675 | 0.077 | 0.184 | 1.432 | 7.252 | 0.713 | 100,000 | 100,000 |
| far | 100,000 | cube | 1.442 | 1.440-1.447 | 1.419 | 1.716 | 9.314 | 0.076 | 0.248 | 0.983 | 7.295 | 0.713 | 100,000 | 100,000 |
| far | 100,000 | flat-fan | 0.827 | 0.823-0.830 | 0.803 | 1.025 | 4.808 | 0.081 | 0.194 | 0.422 | 3.706 | 0.405 | 100,000 | 100,000 |
| far | 100,000 | flat-cube | 0.910 | 0.910-0.917 | 0.889 | 1.118 | 4.911 | 0.081 | 0.252 | 0.450 | 3.720 | 0.407 | 100,000 | 100,000 |

Marginal cost: change in frame time when the thing is switched off (paired over interleaved batches; median and 95% CI; "n.s." when the interval includes 0):

| World | Bodies | Without shadow | Without post (bloom + AgX) | Fan in both passes | Cube in both passes | Flat shading: cube vs fan |
|---|---|---|---|---|---|---|
| near | 10,000 | -10.1% [-10.2%, -9.5%] | -26.6% [-27.0%, -26.3%] | -0.5% [-1.0%, +0.0%] n.s. | +0.5% [+0.0%, +1.0%] n.s. | +1.3% [+0.6%, +1.6%] |
| near | 100,000 | -25.3% [-25.4%, -25.0%] | -11.8% [-12.3%, -11.4%] | +19.3% [+18.7%, +19.7%] | +1.2% [+0.5%, +1.7%] | +4.3% [+3.8%, +4.5%] |
| far | 10,000 | -5.9% [-6.6%, -4.8%] | -38.4% [-39.0%, -37.6%] | +8.9% [+7.3%, +9.6%] | +1.1% [+0.0%, +1.5%] | +1.7% [+0.8%, +2.1%] |
| far | 100,000 | -9.1% [-9.6%, -8.7%] | -13.5% [-13.7%, -13.2%] | +32.4% [+32.0%, +32.9%] | +4.1% [+3.6%, +4.6%] | +10.5% [+10.1%, +10.7%] |

## Raw output: 36525e9 (per-pass sums as "GPU p50"; cube shadow pass drew all faces)

### Renderer, commit 36525e9

2026-10-25T11:15:20.271Z · Mac · Apple M5 Max × 18 · darwin · Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36

Adapter: apple metal-3 Apple M5 Max · 2560x1440 · timing: GPU timestamps + wall

| World | Bodies | Variant | Frame ms (wall, median) | 95% CI | GPU p50 | GPU p95 | cull | shadow | scene | bloom | composite | Boxes drawn | Shadow boxes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| near | 10,000 | full | 0.660 | 0.660-0.667 | 4.576 | 4.688 | 0.016 | 0.098 | 0.373 | 3.701 | 0.380 | 10,000 | 10,000 |
| near | 10,000 | no-shadow | 0.588 | 0.587-0.592 | 4.457 | 4.560 | 0.015 |  | 0.373 | 3.691 | 0.381 | 10,000 | 10,000 |
| near | 10,000 | no-post | 0.487 | 0.483-0.490 | 0.489 | 0.490 | 0.015 | 0.100 | 0.373 |  |  | 10,000 | 10,000 |
| near | 10,000 | cube | 0.700 | 0.697-0.702 | 4.502 | 4.690 | 0.015 | 0.164 | 0.376 | 3.589 | 0.364 | 10,000 | 10,000 |
| near | 100,000 | full | 1.897 | 1.897-1.900 | 7.262 | 7.292 | 0.078 | 0.580 | 1.194 | 4.895 | 0.520 | 100,000 | 100,000 |
| near | 100,000 | no-shadow | 1.473 | 1.470-1.477 | 6.666 | 6.715 | 0.076 |  | 1.194 | 4.879 | 0.518 | 100,000 | 100,000 |
| near | 100,000 | no-post | 1.718 | 1.715-1.720 | 1.853 | 1.859 | 0.080 | 0.580 | 1.193 |  |  | 100,000 | 100,000 |
| near | 100,000 | cube | 1.923 | 1.920-1.925 | 7.460 | 7.522 | 0.076 | 1.032 | 0.901 | 4.935 | 0.523 | 100,000 | 100,000 |
| far | 10,000 | full | 0.493 | 0.493-0.493 | 3.035 | 3.319 | 0.015 | 0.034 | 0.253 | 2.437 | 0.295 | 10,000 | 10,000 |
| far | 10,000 | no-shadow | 0.470 | 0.467-0.472 | 3.008 | 3.201 | 0.015 |  | 0.253 | 2.444 | 0.296 | 10,000 | 10,000 |
| far | 10,000 | no-post | 0.320 | 0.317-0.320 | 0.303 | 0.331 | 0.016 | 0.034 | 0.253 |  |  | 10,000 | 10,000 |
| far | 10,000 | cube | 0.460 | 0.460-0.463 | 3.015 | 3.216 | 0.015 | 0.059 | 0.211 | 2.436 | 0.295 | 10,000 | 10,000 |
| far | 100,000 | full | 1.837 | 1.833-1.843 | 9.684 | 10.273 | 0.077 | 0.183 | 1.431 | 7.278 | 0.721 | 100,000 | 100,000 |
| far | 100,000 | no-shadow | 1.705 | 1.703-1.710 | 9.535 | 10.015 | 0.069 |  | 1.431 | 7.312 | 0.718 | 100,000 | 100,000 |
| far | 100,000 | no-post | 1.647 | 1.645-1.650 | 1.684 | 1.723 | 0.070 | 0.182 | 1.430 |  |  | 100,000 | 100,000 |
| far | 100,000 | cube | 1.497 | 1.497-1.500 | 9.426 | 9.829 | 0.077 | 0.384 | 0.980 | 7.282 | 0.710 | 100,000 | 100,000 |

Marginal cost: change in frame time when the thing is switched off (paired over interleaved batches; median and 95% CI; "n.s." when the interval includes 0):

| World | Bodies | Without shadow | Without post (bloom + AgX) | Cube instead of fan |
|---|---|---|---|---|
| near | 10,000 | -11.1% [-11.3%, -10.4%] | -26.8% [-27.0%, -26.3%] | +6.1% [+4.5%, +6.3%] |
| near | 100,000 | -22.4% [-22.5%, -22.1%] | -9.5% [-9.7%, -9.3%] | +1.2% [+1.1%, +1.4%] |
| far | 10,000 | -4.7% [-5.4%, -4.4%] | -35.1% [-35.6%, -35.1%] | -6.8% [-7.1%, -5.8%] |
| far | 100,000 | -7.1% [-7.6%, -6.8%] | -10.5% [-10.6%, -10.1%] | -18.5% [-18.8%, -18.3%] |
