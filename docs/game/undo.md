# Undo last shot and restart (roadmap U6)

Status 2026-11-06. Code: `@tb/game` play.ts (`GameHandle.undo`, `retry`), undo-marks.ts, hud.ts (the result card's Undo shot, the touch HUD's `touchActs` icons); `@tb/keystone` driver.ts (`Driver.checkpoint`); `@tb/physics-gpu` checkpoint.ts; `@tb/adapter-rapier` (`RapierEngine.checkpoint`).

## What a player gets

- **U** (or **Ctrl+Z**, **Cmd+Z** on a Mac, or the result card's **Undo shot**) takes the last shot back, instantly: the world is as it was the moment that shot went in, and the player aims again. It works while the shot still runs, after a rapid-fire shot that cut the one before (that one is back in flight and plays on), and after the round has ended (the card closes). Pressed again, it takes the next shot back, down to the level's start.
- **R** restarts: the level as it loaded. R existed as Retry; it is now named in the hint line. The result card keeps "Retry".
- **On a touch screen** (touch.ts, body class `kg-touch`) the HUD shows **Undo shot** and **Restart** buttons once a shot is in, 44 px tall like the power buttons; they do what U and R do. Not in a duel: its turns belong to the two players.

## How: a checkpoint at each shot, replay as the fallback

Status 2026-11-06 (thread "Make undo instant with state snapshots"; Will 04:22Z: "memory snapshot the state right as you click launch so that you dont have to re-sim to undo").

As each shot goes in (play.ts `fireNow`, before `Driver.fire`), the page takes a checkpoint of the whole world (`Driver.checkpoint`, @tb/keystone): the engine's own (`PhysicsEngine.checkpoint`, @tb/engine-api `EngineCheckpoint`) and a deep copy (`forkDeep`) of everything the driver keeps (the rules' session, the observer, the weapons' fuses, the spawns, the observed snapshot), plus what the page shows of that moment (Bullet Time's freeze, the goals as judged then, which bodies are drawn as bombs). Undo of shot k restores mark k in place, the same engine and driver: no rebuild, no pre-settle, no steps replayed. The page then redraws as a load after an undo does (tints, felled crowns and cracked heritage lit from the session, effects reset).

**Semantics: the moment the shot went in.** A shot fired from aiming went in at the last settle (physics is frozen while aiming), so the checkpoint is exactly the state the old replay reached, and both undo paths agree bit for bit (tested). A rapid-fire shot that cut the one before went in mid-flight: its checkpoint puts the world back mid-flight with that shot running on, and the shot plays out live to the same settle the replay reaches out of sight (tested). A shot fired while frozen comes back frozen, the freeze it spent unspent.

**Engines.**

- GPU (`GpuAvbdEngine.checkpoint`, physics-gpu checkpoint.ts): only the GPU ranges a step reads as the step before left them, declared next to the code that reads them (each stage's `carried()`): bodies, shapes and props; solver bodies (prevVel for the adaptive warm start, dp and phi for rolling contacts); the step meta; the contact-history half the last step wrote (warm-start lambdas and penalties), with its pair list and offsets; the manifolds (match() hands their SAT axes back as each pair's preferred axis); the broadphase total (the sticky pair counters); the sleep state. The other history half is overwritten before it is read, so it is not copied: that halves the largest buffer. Copies are queue-ordered `copyBufferToBuffer` into pooled buffers: nothing is read back and nothing waits. The CPU side (step index, queued inputs, removed set, the sleep skip's bookkeeping, the solver's half index) is copied too; an awake-count read in flight at a restore is dropped.
- Rapier (`RapierEngine.checkpoint`): `World.takeSnapshot()` (bodies, colliders, islands, both phases with the contacts' warm-start impulses, integration parameters) and the adapter's own state; restore swaps in `World.restoreSnapshot`.
- An engine without `checkpoint()` (the f64 reference) gets no marks: undo replays.

**Memory: the undo budget.** One checkpoint per shot, within `PaceFeel.undoMB` (URL `keystone.undo`, MB; the viewer's Scene panel; scene files' `rules.undo`; default 1024, 0 = always replay). The oldest go first, room is made before a checkpoint is taken, and one that alone would not fit is not taken (UndoMarks, undo-marks.ts). Per checkpoint (one contact half dominates):

| level | bodies | pairs per body | checkpoint |
|---|---|---|---|
| L1-L5 | 38-139 | 20-71 | 0.4-5 MB |
| B1 | 1,000 | 65 | 33 MB |
| B2 | 5,184 | 16 | 44 MB |
| B3 | 10,000 | 16 | 85 MB |
| a 100k level | 100,000 | 16 | about 850 MB |

So the default holds every shot of every level today (B3's three shots: 255 MB), a dozen shots on a 10k level with rapid fire, and one shot at 100k. Undo past the oldest checkpoint held replays, as before. Checkpoint buffers released by an undo or by eviction go back to the engine's pool and are reused by the next shot's checkpoint, so rapid fire does not churn GPU allocations; they are freed with the engine (any load).

**Fallback: replay.** With no checkpoint for the shot (budget, a duel, a page input hook, an engine without checkpoints), undo after N shots rebuilds the level on a new engine, built as the live one, pre-settles it and plays shots 1..N-1 on it out of sight through `playShots` (the same loop as `runSession`, the headless tools and a saved session), left aiming at their settle and not banked; then it swaps in, as a load does. While it replays, the old world stays on screen under an "Undo: replaying n shots…" banner. Its cost: one level load plus the steps of shots 1..N-1, headless. A page input hook (the viewer's `inputHook`, PerStep) turns checkpoints off because the hook's own state is a closure no copy can take, and a duel because its turns are the players'.

Either way the attempt's line (`GameHandle.line`, the saved session) is the kept shots then the new ones: a round with an undo saves, records progress and replays like any other, because it is a line that can be played from the start. (Undo is a time saver, not a new power: R already let a player retry a shot, from the start.) `GameHandle.undone` says how the last undo went back and its wall time; `GameHandle.undoMemory()` the checkpoints held.

The M5 measure is `TB_UNDO_COST=1 TB_CHANNEL=chrome pnpm exec vitest run packages/game/test/undo-cost.test.ts` (B1, B2, B3: undo every shot of the ace line, from checkpoints and by replay), queued with the Mac bench.

## Alternatives considered

- **Replay only** (#205, the first version): exact by construction with no engine change, but an undo costs a level load plus every kept shot's steps (on B3, 1,000 to 3,000 steps after the third shot). Kept as the fallback and as the oracle the checkpoint tests compare against.
- **Copy every engine buffer** instead of the declared carried ranges: no list to keep, but twice the contact buffer and every scratch buffer (about 2.3x the memory at B3). Rejected: the poisoned-scratch tests make the declared list safe to rely on (below).
- **Read the state back to the CPU** at each shot (smaller GPU footprint): a read-back of tens of MB per click on the critical path, and an upload on restore. Rejected: the GPU-side copy is free in time, and on Apple silicon GPU memory is the same RAM.
- **Compact the contact half** (copy only the slots in use, by an indirect-dispatched kernel): a packed 10k tower uses about 13 of 16 slots per body, so it would save under 20% at the cost of a kernel and a count read. Not worth it now.
- **A shadow engine one shot behind** (a second engine replaying each shot as it settles): undo becomes a swap, but it doubles physics cost during play. Rejected.
- **Replay from the newest checkpoint held** (when the one wanted was evicted): would bound the fallback's cost, but replays in place on the live engine (the world would visibly fast-forward) or needs a second engine. Left for later; the default budget holds every shot of every current level.
- **Undo marks the round custom** (no stars, no progress): rejected, as above; the line after an undo is a real line.

## Verification

Each layer is tested on its own, then the page end to end in both modes (checkpoint, and `keystone.undo=0` replay).

- `physics-gpu/test/engine-checkpoint.test.ts` (GPU, own device): checkpoint at step k, run a different future (other spawns, removes, a blast), restore, and the steps after it match the uninterrupted run bit for bit, twice from one checkpoint. Between restore and replay every uncarried STORAGE range is overwritten (a poisoned scratch: the bit pattern of pi, and small integers 1 and 3, which pass as valid indices and counts where pi would not), so a range a step reads but the checkpoint leaves out shows up as a mismatch. Cases: a knock mid-collision, records off, restitution, a settling scene with the sleep skip. Negative controls: corrupting the saved contact half or solver bodies must make it fail. Each carried range was checked by dropping it and seeing a case fail (shapes, broadphase total, manifolds, sleep state, meta, pair and offset history). Also: pooled buffers are reused, and restore after `dispose()` or `init()` throws.
- `adapter-rapier/test/checkpoint.test.ts`: the same exactness for Rapier over 200 steps, twice, with bodies asleep; refusals as above.
- `keystone-lab/test/driver-checkpoint.test.ts` (Rapier, serial and pipelined drivers): a checkpoint while aiming, a different shot, restore, and the original shot gives exactly a fresh session's state; a checkpoint mid-shot with cluster fuses pending, and the same rapid shot again is the same state; restore with no shot plays out to the solo session's result; an engine without `checkpoint()` gives null.
- `game/test/undo-marks.test.ts`: the budget (oldest first, room made before, too big not taken, 0 takes none), drop and pop.
- `game/test/undo-e2e.test.ts` (Rapier, headless Chromium, both modes): on L1 after three shots, the key U leaves exactly the state of a fresh headless session of the first two (`playShots`, not banked) and of the page's own `replay()`; the same third shot again is exactly the state it gave before; Ctrl+Z and U again go back to one shot; R is the level's start state exactly. A rapid-fire shot that cut the one before, undone while it runs, leaves the first played out (from a checkpoint it is still running when the undo returns); the result card's Undo shot closes the card and leaves the line but its last shot. `undone.mode` and `undoMemory()` say which path ran.
  On an emulated phone (390x844, touch), the HUD's Undo shot and Restart appear after the first shot, are at least 44 px tall, keep the HUD within the top `PORTRAIT_HUD_SHARE` of the screen, and when tapped give the same states; on a desktop they are in the HUD but hidden.
- `game/test/undo-gpu.test.ts`: the same on the GPU solver (pipelined driver) on L1, both modes: after two shots, undo equals the page's fresh replay of the first, step and hash; the same second shot again is the state it gave before (warm starts and contact history came back); R equals the start. Mid-flight: a rapid shot undone while it runs lets the shot it cut settle where its replay does.
- `game/test/freeze-e2e.test.ts`: a shot fired while frozen, undone, comes back frozen at the same state with the freeze unspent.
- `game/test/undo-cost.test.ts` (`TB_UNDO_COST=1`, Mac bench): wall time of each undo on B1, B2, B3, both modes, and the checkpoints held.
