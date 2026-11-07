# Test tiers: PR, nightly, Mac (O5)

Every test case runs in one of three places. None is dropped.

| tier | where | what | when |
|---|---|---|---|
| PR / main | `ci.yml`, 20 shards on GitHub runners (SwiftShader) | every test file except the nightly-only ones, slow cases off | every push |
| nightly | `nightly.yml`, 4 shards, `PHYSICS_GPU_SLOW=1 TB_TIER=slow` | the files in `vitest.nightly.json`, plus every file with `PHYSICS_GPU_SLOW` cases of its own, slow cases on | 06:30 UTC on main, and by hand (Actions, Run workflow) |
| Mac | Will's M5 Max, real Metal GPU, `TB_CHANNEL=chrome` | the GPU solver's levels too big for SwiftShader | queued as an idle job (see below) |

`PHYSICS_GPU_SLOW=1 pnpm test` runs the PR and nightly tiers together.

When the nightly fails, it opens an issue labelled `nightly`, or comments on the one already open.

## What the nightly loads on the GPU solver

On SwiftShader, the GPU solver's slow tests load levels of up to `SWIFT_SLOW_MAX` (2,000) bodies. The limit is in `packages/keystone-lab/test/level-stability-gpu.ts`.

The first nightly run (42394058839) showed why bigger levels can't run there:
- B2 (5,184 bodies) rested for 25 min.
- B3 (10,000) passed 30 min without a result, and the lost page failed every level after it.
- B1 (1,000) took 313 s.

The rest of the slow tier:
- **Level sweep.** The sweep of every level is dealt over `level-stability-gpu.test.ts` and `-2`, `-3`, largest first, about 40 min each.
- **Reference levels.** With the flag, the reference levels go up to 2,000 bodies. Each case gets 180 s plus 1.5 s a body.

## The Mac run

Run it on the Mac (real GPU) when it is idle. It covers B2, B3, T-S4, T-S14T, T-B2C, T-B3B and T-B5A-C at rest, plus the B2 and B3 showcase lines:

```
TB_CHANNEL=chrome PHYSICS_GPU_SLOW=1 pnpm vitest run \
  packages/keystone-lab/test/level-stability-gpu.test.ts \
  packages/keystone-lab/test/level-stability-gpu-2.test.ts \
  packages/keystone-lab/test/level-stability-gpu-3.test.ts \
  packages/keystone-lab/test/big-levels-gpu.test.ts
```

With `TB_CHANNEL` set, every level runs, the big ones included. Each file's "names the levels left" case lists anything this adapter didn't run.
