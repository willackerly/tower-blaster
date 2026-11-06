# Undo last shot and restart (roadmap U6)

Status 2026-11-06. Code: `@tb/game` play.ts (`GameHandle.undo`, `retry`), hud.ts (the result card's Undo shot, the touch HUD's `TOUCH_ACTS`).

## What a player gets

- **U** (or **Ctrl+Z**, **Cmd+Z** on a Mac, or the result card's **Undo shot**) takes the last shot back: the world is where the shots before it left it, settled, and the player aims again. It works while the shot still runs, after a rapid-fire shot that cut the one before (that one then plays out to its settle), and after the round has ended (the card closes). Pressed again, it takes the next shot back, down to the level's start.
- **R** restarts: the level as it loaded. R existed as Retry; it is now named in the hint line. The result card keeps "Retry".
- **On a touch screen** (touch.ts, body class `kg-touch`) the HUD shows **Undo shot** and **Restart** buttons once a shot is in, 44 px tall like the power buttons; they do what U and R do. Not in a duel: its turns belong to the two players.

## How: replay, not a checkpoint

A session is (level, shots) and replays bit for bit on one device (G3). Undo after N shots rebuilds the level on a new engine, built as the live one, pre-settles it and plays shots 1..N-1 on it out of sight through `playShots` (the same loop as `runSession`, the headless tools and a saved session), left aiming at their settle and not banked; then it swaps in, as a load does. The weapons' per-step input hook is fresh for the replay and goes on with live play, as on a load. Felled crowns and cracked heritage are lit from the session; Regrow is skipped. While it replays, the old world stays on screen under an "Undo: replaying n shots…" banner.

So by construction the state after an undo is a fresh replay of shots 1..N-1 on this device, and the attempt's line (`GameHandle.line`, the saved session) is the kept shots then the new ones: a round with an undo saves, records progress and replays like any other, because it is a line that can be played from the start. (Undo is a time saver, not a new power: R already let a player retry a shot, from the start.)

Cost: one level load plus the steps of shots 1..N-1, headless (no frames drawn, physics as fast as the engine goes). On the GPU solver a 10k level settles a shot in a few hundred to about 1,500 steps, so undo after the third shot of B3 replays roughly 1,000 to 3,000 steps on top of the load. The M5 measure is `TB_UNDO_COST=1 TB_CHANNEL=chrome pnpm exec vitest run packages/game/test/undo-cost.test.ts` (B1 and B2, three undos after each ace line), queued with the Mac bench; if an undo there takes over about 3 s, the checkpoint below is the follow-up.

## Alternatives considered

- **A checkpoint at each fire** (the engine's whole state copied when a shot goes in, restored on undo): fast and constant-time, but `PhysicsEngine` has no save or restore. Each engine would need one that is exact: on the GPU, every buffer that carries over between steps (bodies, warm-start and contact caches, pair lists, sleep counters, the step index and pending inputs), copied on the GPU (memory doubles per checkpoint); Rapier's world snapshot; the reference engine's state. That touches physics-gpu, where the sleep and restitution threads are working, and every new carried-over buffer would have to remember it. Rejected for now: replay is exact by construction with no engine change, and the checkpoint can come later behind the same `undo()` with the replay as its test oracle.
- **A shadow engine one shot behind** (a second engine replaying each shot as it settles): undo becomes a swap, but it doubles physics cost during play. Rejected.
- **Undo marks the round custom** (no stars, no progress): rejected, as above; the line after an undo is a real line.

## Verification

- `game/test/undo-e2e.test.ts` (Rapier, headless Chromium): on L1 after three shots, the key U leaves exactly the state of a fresh headless session of the first two (`playShots`, not banked) and of the page's own `replay()`; playing on replays exactly; Ctrl+Z and U again go back to one shot; R is the level's start state exactly. A rapid-fire shot that cut the one before, undone while it runs, leaves the first played out; the result card's Undo shot closes the card and leaves the line but its last shot.
  On an emulated phone (390x844, touch), the HUD's Undo shot and Restart appear after the first shot, are at least 44 px tall, keep the HUD within the top `PORTRAIT_HUD_SHARE` of the screen, and when tapped give the same states; on a desktop they are in the HUD but hidden.
- `game/test/undo-gpu.test.ts`: the same on the GPU solver (pipelined driver) on L1: after two shots, undo equals the page's fresh replay of the first, step and hash; R equals the start.
