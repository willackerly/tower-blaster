# Grid reductions (capability C11)

2026-11-06. Roadmap node C11 ("Grid reductions: occupancy, heightmap and projection histograms with a target-mask distance (fill, spill, IoU)"), needed by M5 Fuse & Fold (footprint spread and rubble height) and later by outcome targets (Shadowfall, Rubble Writ) and Aftermath. See `docs/game/modes-roadmap.md`, section 8.

## What it answers

- **Where did the mass end up?** Occupancy: per grid cell, how many bodies have their centre there, and their integer weight (grams).
- **How high is the rubble?** Heightmap: per cell, the highest top of any body whose bounding box covers it.
- **How far did it spread?** Projection histograms along each grid axis, and the distance of covered cells from a target.
- **Did it land where it should?** A target mask (a set of cells) scored against the grid: **fill** (share of the mask covered), **spill** (share of the weight whose centre is outside the mask), **IoU** (covered cells against mask cells), **reach** (how many cells beyond the mask the furthest covered cell is), and the highest top inside and outside the mask.

## Layers

1. `@tb/engine-api` `grid.ts`: `reduceGrid(spec, input)` and `maskScore(grid, mask)`. Engine-agnostic: a snapshot, the bodies' shapes, the ids to count and optional integer weights. This is the definition a later GPU path (roadmap E3) has to match bit for bit, so it is integer throughout, reusing the reduce spec's fixed point (`quant`, scale `s`, default 16) and its exact rotated-box extent (the `aabb` scalar of `observe.ts`).
2. `@tb/keystone` `footprint.ts`: a grid aligned to a level's lattice (`lotGrid`), the mask of a group's home footprint grown by k cells (`homeMask`), and the facts a goal reads.
3. Goals (`goals.ts`): a lot sheet can name **footprints** and test them with a `footprint` term (spill, fill, iou, reach, height). Nothing about a level's hash, score or stars changes; a sheet without footprints judges as before.

## Definition (engine-api)

A grid spec is `{ origin: [o_u, o_v], cell: [c_u, c_v], n: [n_u, n_v], axes?: [u, v], s? }`. `axes` are the two world axes the grid lies on (default `[0, 2]`, a plan view; `[0, 1]` is an elevation seen along z). The third axis `w` is depth: the heightmap holds the highest box face along it.

All arithmetic is on integers at scale s:

- `O = quant(origin)`, `C = quant(cell)` (must be ≥ 1), `P = quant(pos)` per axis.
- Extent `E_a` = the reduce spec's `aabb` extent on axis a (sphere: `quant(radius)`; box: `⌊Σ_b |R_ab|·H_b / 2^28⌋` from Q14 quaternion components). `lo = P − E`, `hi = P + E`.
- Centre cell: `i = ⌊(P_u − O_u) / C_u⌋`, same on v. Inside when `0 ≤ i < n_u` and `0 ≤ j < n_v`.
- Covered cells: the half-open box `[lo, hi)` meets cell `[O + iC, O + (i+1)C)`, so `i` runs from `⌊(lo − O)/C⌋` to `⌊(max(hi − 1, lo) − O)/C⌋`, clipped to the grid. Half-open on the high side means a cube exactly one cell wide and aligned to the grid covers one cell, not two.
- `top[k] = max(P_w + E_w)` over bodies covering k; empty cells hold `EMPTY_TOP = −2^31`.
- A body is **invalid** (counted, never binned) when any quantity it needs is ⊥ (NaN, infinite, or beyond the fixed-point range). A body whose tier is `TIER_FREE` (removed) is skipped and counted as **removed**.

Output: `count`, `weight`, `cover`, `top` per cell (row-major, `k = j·n_u + i`); `projU`, `projV` (centre counts and weights per column and row, over every body whose centre is within that axis's range, whatever the other axis says); `outside` (count and weight of centres off the grid); totals; `invalid`; `removed`. Every result is an integer, so any summation order (and a GPU's atomics) gives the same answer.

Weights are integers in `[0, 2^31)`; per-cell sums stay below 2^53 for any body count the observer allows (2^22).

`maskScore(grid, mask, minCover = 1)`: a cell is **occupied** when `cover ≥ minCover`. With M the mask cells, O the occupied ones and H = M ∩ O: fill = |H| / |M|, IoU = |H| / |M ∪ O| (1 when both are empty), spill = (weight outside M, off-grid weight included) / total weight (0 when there is no weight), reach = the largest chessboard distance in cells from an occupied cell to the nearest mask cell (0 when every occupied cell is in the mask). The integer numerators and denominators are returned beside the ratios. An empty mask throws.

## Alternatives considered

1. **A `grid` output op inside `ReduceSpec`** (the standing per-step query of `observe.ts`). It would inherit predicates, tags and the observer's lag. Rejected for now: nothing reads a grid every step (goals read the end snapshot, as `groups.ts` does), and the spec's GPU budget (`maxRecordWords` 1,024 words of workgroup memory, no global atomics) cannot hold one 32 × 32 grid beside the game's own outputs; a GPU grid wants global atomics (`atomicAdd`, `atomicMax` on i32), a different kernel shape. The definition here is written so it can become that op later without changing a single result: same `quant`, same extent, integer outputs.
2. **Float keystone-only functions over level cells** (as `groups.ts` does with home poses). Simpler, but a GPU path would then have to reproduce float rounding. The integer form costs nothing extra on the CPU.
3. **Exact box-cell overlap area** (rasterising the rotated box) instead of the AABB. More faithful for a plank lying diagonally, but neither exact in integers nor cheap on a GPU. The AABB over-covers a 45° plank by at most its width; at a one-cell grid that is a cell either side, which the mask's `grow` already absorbs.
4. **Centre-only occupancy** (no `cover`). One cell per body is GPU-cheapest, but a fallen 4-cell plank would leave three holes in fill and IoU. Both are kept: spill uses centres and mass (as probe X2's skill gate does), fill/IoU/reach/height use cover.
5. **Euclidean or chamfer distance for reach.** Chessboard distance is exact in integers and matches "within k cells", which is how the mask is grown; Euclidean would read better on diagonals but needs a real-valued transform.

## Relation to probe X2

X2's spill is "the share of the remaining mass whose centre ends outside the footprint grown by one cell". `footprint.ts` with `grow: 1` measures the same thing on the lattice: the home cells of the building, grown by one cell (one pitch, 0.51 m, against X2's 0.5 m), mass-weighted by centres, removed bodies skipped.

## Tests

- `packages/engine-api/test/grid.test.ts`: every cell of `reduceGrid` against a brute-force BigInt reading that shares no code with it (per body, per cell, the naive `aabb` scalar of `test/naive.ts`), over random worlds of boxes and spheres in random poses, both axis pairs, odd origins and cell sizes; order independence; cell boundaries (half-open); invalid and removed bodies; `maskScore` on hand-built shapes with known fill, spill, IoU and reach.
- `packages/keystone/test/footprint.test.ts`: the home mask of a known building, a shifted building's IoU, the reference engine folding a tower (spill grows), and lot-sheet footprint terms judged and checked.
