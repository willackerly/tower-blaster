# Test tiers: PR, nightly, Mac (O5)

Every test case runs in one of three places. None is dropped.

| tier | where | what | when |
|---|---|---|---|
| PR / main | `ci.yml`, 20 shards on GitHub runners (SwiftShader) | every test file except the nightly-only ones, slow cases off | every push |
| nightly | `nightly.yml`, 6 shards (330 min limit each), `PHYSICS_GPU_SLOW=1 TB_TIER=slow`, balanced on `vitest.durations.nightly.json` | the files in `vitest.nightly.json`, plus every file with `PHYSICS_GPU_SLOW` cases of its own, slow cases on | 06:30 UTC on main (when GitHub runs it, see below), and by hand (Actions, Run workflow) |
| Mac | Will's M5 Max, real Metal GPU, `TB_CHANNEL=chrome` | the GPU solver's levels too big for SwiftShader | queued as an idle job (see below) |

`PHYSICS_GPU_SLOW=1 pnpm test` runs the PR and nightly tiers together.

When the nightly fails, it opens an issue labelled `nightly`, or comments on the one already open.

## What the nightly loads on the GPU solver

On SwiftShader, the GPU solver's slow tests load levels of up to `SWIFT_SLOW_MAX` (2,000) bodies. The limit is in `packages/keystone-lab/test/level-stability-gpu.ts`. A Chorus level counts every world it loads (`loadBodies`: its lot times 64), so CH1-CH3 (2,560 to 8,896) are Mac levels.

The first nightly run (42394058839) showed why bigger levels can't run there:
- B2 (5,184 bodies) rested for 25 min.
- B3 (10,000) passed 30 min without a result, and the lost page failed every level after it.
- B1 (1,000) took 313 s.

The second (42469639500, 2026-11-08) ran every shard to the end, in 37 min to 2 h 50 min:
- CH2, counted then by its 139-body lot, passed 30 min without a result. The page it left busy failed the 15 levels after it in its file. Now a Chorus level counts its worlds, and a level that times out gets the next level a fresh page.
- The 10k viewer level's full case passed 60 min while loading. It now runs only on a real GPU (`TB_CHANNEL`), which takes `e2e-keystone-10k.test.ts` out of the nightly tier.
- rest-stability's matrix at 400 bodies took 2 h 49 min, the longest file now.

The rest of the slow tier:
- **Level sweep.** The sweep of every level is dealt over `level-stability-gpu.test.ts` and `-2`, `-3`, largest first, about 40 min each.
- **Reference levels.** With the flag, the reference levels go up to 2,000 bodies. Each case gets 180 s plus 1.5 s a body.

## The Mac run

Run it on the Mac (real GPU) when it is idle. It covers B2, B3, CH1-CH3, T-S4, T-S14T, T-B2C, T-B3B and T-B5A-C at rest, the B2 and B3 showcase lines, and the 10k viewer level's full case:

```
TB_CHANNEL=chrome PHYSICS_GPU_SLOW=1 pnpm vitest run \
  packages/keystone-lab/test/level-stability-gpu.test.ts \
  packages/keystone-lab/test/level-stability-gpu-2.test.ts \
  packages/keystone-lab/test/level-stability-gpu-3.test.ts \
  packages/keystone-lab/test/big-levels-gpu.test.ts \
  packages/viewer/test/e2e-keystone-10k.test.ts
```

With `TB_CHANNEL` set, every level runs, the big ones included. Each file's "names the levels left" case lists anything this adapter didn't run.

The rest-stability matrix at full size is a Mac run too. On SwiftShader the nightly runs its 17 cases at 400 bodies for 600 frames (CI's own case; struck cases run 1,200). At 1,000 bodies for 3,600 frames it would take some 8 h there, and the first nightly hit its job limit inside it:

```
TB_CHANNEL=chrome PHYSICS_GPU_SLOW=1 REST_SIZES=1000,10000 REQUIRE_WEBGPU=1 \
  REST_LOG=rest.txt pnpm vitest run packages/physics-gpu/test/rest-stability.test.ts
```

## Nightly times

`vitest.durations.nightly.json` holds the nightly tier's per-file times, in CI-runner seconds. They come from the first nightly's logs, and are estimates where a file failed or has since changed. Merge a new run's times with:

```
pnpm durations --file vitest.durations.nightly.json --from-log <slow shard log>
```

The longest file, rest-stability (~170 min), sets the longest shard.

## GitHub may skip the schedule

GitHub runs `schedule` triggers on a best-effort basis and drops them under load. On the night of 2026-11-07 it ran
the merge train's half-hourly schedule twice in about 12 h and skipped the nightly's 06:30 run entirely. A day
with no nightly run is therefore not a pass. When one is missed, run it by hand (Actions, nightly, Run workflow).
