# Level start

Playtest feedback (Will, 2026-11-06): "a lot of lag at the start of each level... not sure if there's an unnecessary reload happening each time but seems avoidable."

## What a load did

Every load (the page opening, Next, N and P, Retry, an undo) ran `loadNow` in `game/src/play.ts`:

1. `compileLevel`, then a new engine (`makeEngine`), then `Driver.reset()`.
2. `Driver.reset()` is the engine's `init()` (on the GPU: every buffer, and every shader module and compute pipeline), then **300 pre-settle steps** at 40 iterations (`PRESETTLE_STEPS`, so the settled pose and not the authored one is home), then a snapshot.
3. The new level swaps in whole.

The GPU engine's `step()` only submits, so the 300 steps went in as one burst: the page's thread was busy encoding them, and every frame submitted after them waited in the GPU queue until all 300 were done. The screen froze for the whole pre-settle, then the new level appeared.

Where the time goes (`GameHandle.timing.load`, `game/test/load-cost.test.ts`). SwiftShader, 2026-11-06, L1. These numbers show which phase holds the work; they are not performance results:

| load | wall | init | pre-settle |
|---|---|---|---|
| open | 21.7 s | 2.6 s | 19.0 s |
| retry | 22.5 s | 0.07 s | 21.7 s |
| next (L2) | 36.3 s | 0.09 s | 35.4 s |

So the pipelines cost once per page: after the first init, the device's pipeline cache makes init cheap. Nearly all of every load is the pre-settle, and every load repeats it, including a retry of the level just played. On Metal a step of the 10k city at 40 iterations is about 10.8 ms (G4 probe), so B3's pre-settle alone is about 3 s; the Mac numbers for each level are in the table at the end.

## What changed

Each change leaves the state a load gives exactly as before: the same steps run on the same engine, only when they run moves.

1. **Paced pre-settle** (`keystone` `presettlePaced`, `Driver.reset(pace)`; `?keystone.loadpace=<ms>`, default 8, 0 as before). The steps go in batches sized to about 8 ms. On the GPU two batches are in flight: batch k+1 is submitted before batch k is waited for (`finish()`), so the GPU does not idle on the round trip and a frame waits behind at most two batches. On a CPU engine (Rapier) each batch is followed by a task boundary. The page keeps drawing (the level being left, the front door, the banner) while the next one settles.
2. **Prefetch** (`?keystone.prefetch=aim|card|0`, default `aim`). The level the result card's Next opens (a duel's Rematch: its other level) is built and pre-settled ahead of time. With `aim`, this starts as soon as a level loads, while the player aims at it. Each batch first waits at a gate (`PresettlePace.gate`) that stays shut while a shot runs, because the live level's steps and the spare's share the one GPU queue (or, on Rapier, the one thread). The gate opens when the round is ending and the card is up, or when a load waits on the spare. A shot fired mid-batch waits behind at most the two batches in flight. Between shots the live world rests, so the GPU has little else to do then. With `card`, the build starts only when the round ends. That is the default on offscreen pages (tests and probes), where a second level built as every page opens would cost minutes of SwiftShader CPU across the suite. Unpaced (`keystone.loadpace=0`), `aim` acts as `card`, because an unpaced pre-settle holds the frames. Next then swaps the spare in. It is the level a load would build, with the same def and the same pair room, checked when it is taken (a round that dropped pairs builds its level's next round with more room, so a spare built before that is dropped). A retry, or an undo, keeps the spare for a later Next. Loading any other level drops it, and its engine is disposed at once, which also stops a pre-settle still running. `handle.spare` names the level being built and whether it has settled. `counts.prefetchHeld` counts the batches the gate held. Two engines are held at once, the live level's and the spare's (B2 and B3 together hold 15,184 bodies).
3. **Instant retry** (`?keystone.retry=rebuild` turns it off). Right after a level loads, the game takes a `Driver.checkpoint()` (the undo work's exact engine and driver copy). Retry (R, the card's Retry, a duel's Same start) restores it in place, on the same engine, instead of building and pre-settling the level again. It is used only for the level and pair room it was taken at, so a round that dropped pairs still rebuilds with more room. It dies with its engine when another level loads, or when an undo replays onto a fresh build. Its memory is one checkpoint per loaded level (about 85 MB at B3), outside the undo budget.
4. **Phase timing.** `GameHandle.timing.load` splits every load into check, compile, init, presettle (and its steps), replay, swap, plus whether the level was prefetched and how long the load waited for it. `Driver.resetMs` gives the same for any driver.

### Alternatives considered

- **Fewer pre-settle steps, or sleep during it.** Either one changes the settled pose, and so every hash, par line and star cast pinned on it. Rejected.
- **Cache the settled pose across visits (IndexedDB).** The pose alone does not restore the warm-start state (contacts, lambdas, pair history), so play after it would not be exact. The whole state is up to about 85 MB at B3. Rejected for now.
- **Show the new level at once and settle it behind its regrow animation.** This would hide up to the regrow's length (0.3 s + 35 ms per course: about 1.1 s at 25 courses) on any load, not only Next. Every frame and every handle field reads the current driver, which is why a level swaps in whole, so this needs a pending-level state through the frame loop. Deferred: it is worth it only if the Mac numbers still show a wait on N/P and first open.
- **Reuse one engine across loads to skip pipeline builds.** init is already 70 to 100 ms after the first on SwiftShader, because the device dedups identical pipelines. Not worth the coupling unless Metal says otherwise.
- **Keep a second, pre-settled copy of the level for retry.** That would double the engine memory and spend GPU time on a copy that is often never used. The start checkpoint (change 3) copies only the state a step reads, and restoring it costs a few buffer copies.

## Tests

- `keystone-lab/test/presettle-pace.test.ts`: paced and unpaced resets leave the same snapshot hash (L1, L2, Rapier, at any batch size). Batches run exactly the steps asked, two in flight, growing at most twofold up to `maxBatch`. A CPU engine yields between batches.
- `keystone-lab/test/presettle-pace.test.ts`, the gate: no step runs while it is shut, and then every step runs, on engines with and without `finish()`. Time held at the gate is not counted in a batch's rate. A reset whose gate holds every other batch leaves the same hash.
- `game/test/level-start-e2e.test.ts` (Rapier), `aim`: L2 is built from L1's load and is built only once. L1's par line, played beside it, equals its replay on a fresh engine. Next takes L2 with the state `replay([])` gives, and starts L3. On B1, the first shot goes in while B2 is still settling: the gate holds the build, the build finishes between shots, and the shot lands where a fresh engine's does.
- `game/test/level-start-gpu.test.ts` (GPU engine), `aim`: the same L1 to L2 check on one device. L1's line equals its replay, and the L2 that Next takes equals `replay([])`.
- `game/test/level-start-e2e.test.ts` (Rapier), `card`: the round's end prefetches the next level once. A retry keeps the spare. Next takes it, and its state equals a cold load of that level and a `replay([])`. `keystone.prefetch=0` builds nothing ahead. On B1, an unpaced reset holds the frames for the whole pre-settle, while a paced one's longest frame gap stays under 100 ms. On Rapier the paced pre-settle takes longer (464 against 286 ms on B1, SwiftShader container), because Rapier shares the page's thread with the frames. Rapier is not the default engine.
- The GPU engine's paced pre-settle against an unpaced one: every `*-gpu` test that compares the live state with `handle.replay` (whose `runSession` resets unpaced) checks it.
- `game/test/level-start-e2e.test.ts`, instant retry (Rapier): a retry restores in place, with no pre-settle, to the state the level loaded with, twice in a row. The par line then plays to the same state and score as the first time, and the same as with `keystone.retry=rebuild`. On the GPU, `undo-gpu.test.ts` presses R after undos and expects the exact loaded state, and `par-gpu-L4.test.ts` reloads the level (frames keep running through its pre-settle) and then retries it: restored in place, no pre-settle, the state the load gave.
- `game/test/load-cost.test.ts` (`TB_LOAD_COST=1`, Mac only for numbers): for each level and pace, it times open, retry twice, then the line to the card and Next. It prints the phases and the longest frame gap.

## Mac numbers

M5 Max, Chrome (Metal), main at 23c0df8, 2026-11-06. The result card showed for 1.5 s before Next. The page ran offscreen. **Low Power Mode was on**, so absolute times may be up to about 2x high; the ratios hold. Each load ran at loadpace 8 and at 0, and retry ran both as `checkpoint` (the default) and as `rebuild`. Raw files: `tb-load-23c0df8.txt` and `tb-load-23c0df8-rebuild.txt` in the project files.

Wall time of each load, until the level can be fired at. The regrow column is the growing-in animation, during which firing waits (0.3 s + 35 ms a course). It is in every wall time except open's.

| level | bodies | open | pre-settle | retry, checkpoint | retry, rebuild | regrow | Next into it, from the level before |
|---|---|---|---|---|---|---|---|
| L1 | 40 | 0.97 s | 0.87 s | 0.76 s | 1.63 to 1.66 s | 0.62 s | |
| L2 | 139 | not run | 1.30 to 1.54 s (prefetched) | not run | not run | 0.76 s | 0.80 to 1.07 s, no wait |
| B1 | 1,000 | 1.52 s | 1.41 s | 1.27 s | 2.68 to 2.72 s | 1.14 s | |
| B2 | 5,184 | 3.60 s | 3.48 s | 1.02 s | 4.51 to 4.54 s | 0.83 s | 2.96 to 3.01 s, waited 1.9 s |
| B3 | 10,000 | 5.47 to 5.79 s | 5.3 to 5.7 s | 1.28 s | 6.64 to 7.11 s | 1.14 s | 5.0 to 5.9 s, waited 3.7 to 4.5 s |

What it says:

- **Retry is now its regrow animation and nothing else.** A restored retry's own phases sum to under 15 ms. The rest of its wall time is the regrow (0.6 to 1.1 s), plus about 150 ms of polling in the probe. Rebuild adds the whole pre-settle again: about 2.1x on L1 and 4.4x on B2.
- **Open is the pre-settle.** init is 90 to 107 ms on a page's first engine, and 4 to 29 ms after that; compile is at most 13 ms.
- **Next is instant when the pre-settle fits inside the card's time, and otherwise waits for the rest.** Into L2 it never waited. Into B2 and B3 the pre-settle (3.5 and 5.2 to 6.1 s) outlasts a 1.5 s card, so Next waited 1.9 s and 3.7 to 4.5 s. At loadpace 0 the same wait shows up in the `check` phase instead (1.9 and 4.1 to 4.2 s). There the outgoing level's last read-back sits in the one GPU queue behind the whole unpaced pre-settle.
- **Pacing costs no throughput on Metal.** Paced and unpaced pre-settles take the same time to within the run-to-run spread (L1 874 against 894 ms, B3 5,614 against 5,663 ms).
- **This run cannot show the frame gap pacing fixes.** Offscreen, the page queues no draws on the GPU, so a frame never waits behind the pre-settle, and the longest gap is 17 to 33 ms at both paces. A run with `TB_LOAD_DRAW=1` (frames drawn to the canvas) and Low Power Mode off measures that.

What is left, in order of the wait it removes:

1. **Next into a big level** (up to 4.5 s here). Done after this run: the prefetch now starts from the load (`keystone.prefetch=aim`, change 2). B3's 5 to 6 s pre-settle now runs during the time a player spends aiming at B2, which over a round usually exceeds it; only what is left by the card is waited for. Measure it with the same command (`TB_LOAD_PREFETCH` defaults to `aim`).
2. **Open of a big level** (up to 5.8 s, first visit only). Nothing cheap removes it without changing the settled pose (see the alternatives above). Settling behind the regrow hides about 1.1 s of it.
3. **The regrow on retry** (0.6 to 1.1 s of firing held back). This is a look choice, not a load: a retry could skip the regrow or shorten it.

Command: `TB_CHANNEL=chrome TB_LOAD_COST=1 TB_LOAD_CARD_MS=1500 TB_LOAD_OUT=$HOME/tb-load-<sha>.txt pnpm vitest run packages/game/test/load-cost.test.ts --no-file-parallelism` (add `TB_LOAD_RETRY=rebuild` for the old retry, and `TB_LOAD_DRAW=1` to draw).
