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
2. **Prefetch** (`?keystone.prefetch=0` turns it off). When a round ends, the level the result card's Next opens (a duel's Rematch: its other level) is built and pre-settled while the card shows. Next then swaps it in. It is the level a load would build, with the same def and the same pair room, checked when it is taken (a round that dropped pairs builds its level's next round with more room, so a spare built before that is dropped). A retry keeps the spare for a later Next. Loading any other level drops it, and its engine is disposed at once, which also stops a pre-settle still running.
3. **Phase timing.** `GameHandle.timing.load` splits every load into check, compile, init, presettle (and its steps), replay, swap, plus whether the level was prefetched and how long the load waited for it. `Driver.resetMs` gives the same for any driver.

### Alternatives considered

- **Fewer pre-settle steps, or sleep during it.** Either one changes the settled pose, and so every hash, par line and star cast pinned on it. Rejected.
- **Cache the settled pose across visits (IndexedDB).** The pose alone does not restore the warm-start state (contacts, lambdas, pair history), so play after it would not be exact. The whole state is up to about 85 MB at B3. Rejected for now.
- **Show the new level at once and settle it behind its regrow animation.** This would hide up to the regrow's length (0.3 s + 35 ms per course: about 1.1 s at 25 courses) on any load, not only Next. Every frame and every handle field reads the current driver, which is why a level swaps in whole, so this needs a pending-level state through the frame loop. Deferred: it is worth it only if the Mac numbers still show a wait on N/P and first open.
- **Reuse one engine across loads to skip pipeline builds.** init is already 70 to 100 ms after the first on SwiftShader, because the device dedups identical pipelines. Not worth the coupling unless Metal says otherwise.
- **Retry by restoring an exact engine checkpoint taken after the pre-settle.** This is the right way to make a retry instant. The undo thread ("Make undo instant with state snapshots") is building `PhysicsEngine.checkpoint()` and `Driver.checkpoint()`. Retry will take one right after reset once that lands, in a follow-up.

## Tests

- `keystone-lab/test/presettle-pace.test.ts`: paced and unpaced resets leave the same snapshot hash (L1, L2, Rapier, at any batch size). Batches run exactly the steps asked, two in flight, growing at most twofold up to `maxBatch`. A CPU engine yields between batches.
- `game/test/level-start-e2e.test.ts` (Rapier): the round's end prefetches the next level once. A retry keeps the spare. Next takes it, and its state equals a cold load of that level and a `replay([])`. `keystone.prefetch=0` builds nothing ahead. On B1, an unpaced reset holds the frames for the whole pre-settle, while a paced one's longest frame gap stays under 100 ms. On Rapier the paced pre-settle takes longer (464 against 286 ms on B1, SwiftShader container), because Rapier shares the page's thread with the frames. Rapier is not the default engine.
- The GPU engine's paced pre-settle against an unpaced one: every `*-gpu` test that compares the live state with `handle.replay` (whose `runSession` resets unpaced) checks it.
- `game/test/load-cost.test.ts` (`TB_LOAD_COST=1`, Mac only for numbers): for each level and pace, it times open, retry twice, then the line to the card and Next. It prints the phases and the longest frame gap.

## Mac numbers

Pending (queued for the Mac when it is idle):
`TB_CHANNEL=chrome TB_LOAD_COST=1 TB_LOAD_OUT=$HOME/tb-load-<sha>.txt pnpm vitest run packages/game/test/load-cost.test.ts`
