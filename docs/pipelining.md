# Pipelining and frame interpolation audit

Roadmap node E7, 2026-11-01, main 00b44ad. Will asked for a sanity check that
we pipeline wherever we can: sound and even rendering may lag a frame or two
if that buys parallelism, and frame interpolation should be used if it is
cheap. This audits the code paths that run while a shot plays (game page,
`playKeystone` in `packages/game/src/play.ts`, which the viewer's
`rules=keystone` also runs) and the viewer's sandbox loop
(`packages/viewer/src/main.ts`, `loop=free`).

## Answer in brief

- **Most of it is already pipelined.** Physics runs in its own loop, apart
  from the frames. Frames interpolate between the two newest physics states,
  every frame. Readback is pipelined: step n+1 solves while step n's bodies
  come back. Sound is synthesised on the AudioWorklet thread behind a 30 ms
  jitter buffer. No frame waits on physics, on readback or on audio.
- **Frame interpolation is in place and costs nothing measurable.** The cull
  pass lerps position and nlerps rotation between the previous and the newest
  state (`render/src/cull.ts`). The blend weight ramps by when each state
  *arrived*, so 60 Hz physics draws smoothly at 120 Hz, and slow motion
  (the valve) stays smooth too. It shows the world up to one physics interval
  late (16.7 ms at real time). That is the price of interpolation.
  Extrapolation was rejected in `render-design.md` and is again here.
- **The real contention is the GPU, not the threads.** WebGPU has one queue.
  In a 10k collapse a physics step costs about 19 ms (40 iterations), so the
  sim falls to 0.64-0.82x real time, and every render frame (2-3 ms of GPU at
  10k) takes GPU time from physics. The evidence that they contend comes from
  the F2 baseline (fffd5a0, same build both ways). S14 10k at rest steps in
  4.82 ms on the bench, which draws nothing, and in 7.0-10.6 ms in the viewer,
  which draws 120 frames a second. How much of that a collapse would win back
  by drawing 60 frames a second is not measured; the estimate is 5-20% sim
  speed. Interpolation makes 60 drawn frames a second look smooth. So the cheapest
  new parallelism is to **draw fewer frames while physics is behind**. That is
  P1 below: it ships off by default, behind `keystone.frames`, for an A/B on
  the M5.
- **CPU work on the main thread is small at 10k and large at 100k.** It runs
  once per step: decoding the readback, the rules' observation, the sound tap
  and repacking for the renderer. On this container's 2.1 GHz Xeon that is
  about 1.9 ms per step at 10k and about 17 ms at 100k (the M5 should be
  faster; to be measured). At 10k the GPU binds first. At 100k (E6) the main
  thread binds, and the fix there is to keep body data on the GPU (P3, E3),
  not to add workers.

## The frame dependency graph (as built)

Three threads and one GPU queue:

```
 main thread                                   GPU queue (one, in order)        AudioWorklet thread
 ───────────                                   ─────────────────────────        ───────────────────
 rAF tick (play.ts tick / viewer frameLoop)
   camera, juice, HUD, aim ──────────────┐
   renderer.render(alpha) ──submit──────►│ frame k: cull(prev,cur,alpha), shadows, AO, shade, post
                                         │
 physics loop (physics-loop.ts runPhysics / viewer loop.ts runFree)
   Pacer.due? ── no ──► await rAF        │
   Driver.step():                        │
     engine.step() ──submit─────────────►│ step n+1: broadphase … solve   (pipelined: queued
     await snapshot(n) ◄──mapAsync────── │ copy bodies(n) → staging         behind step n)
     decode (Float64)                    │
     rules: CpuObserver.observe          │
     weapons: Arsenal.observe → push     │
   source.update(snapshot) ──writeBuffer►│ prev ← cur (GPU copy); cur ← packed bodies
   CollapseSound.frame → FrameTap ──postMessage (transfer)───────────────────►  push(frame) → jitter
   arrived(arrivals, now)  (feeds alpha)                                          buffer (+30 ms) →
   engine.finish() ─ (not awaited; times the step for the valve)                 128-sample blocks
```

Every synchronisation point, and whether it can stall a frame:

| # | Point | Who waits on whom | Stalls a frame? | Notes |
|---|---|---|---|---|
| S1 | `Pacer.due` false → `await rAF` | physics loop on the frame clock | no | Physics wakes at most once a frame when it is ahead. While aiming, physics idles on rAF, so a shot's first step waits for the next rAF: 0-8.3 ms at 120 Hz (P4). |
| S2 | `Driver.step` awaits `snapshot(n)` while step n+1 runs | physics loop on GPU step n + readback | no | This is the pipelining (Driver `pipelined`, game GPU default). At most two steps are queued. The rules see step n while the engine is at n+1, which is documented and replay-safe. |
| S3 | `engine.finish()` → step cost | nothing waits | no | It only times steps for the valve (`stepCost`: a step's own GPU time even when queued). |
| S4 | `source.update` (writeBuffer + GPU prev copy) | queue order | no | It runs after the readback landed, so it never waits on a running step. CPU cost: packing (P3). |
| S5 | `renderer.render` | none (it only submits) | no | It awaits only for a capture. In the game, the frame never awaits physics. |
| S6 | Viewer `frameLoop`: `await onSubmittedWorkDone()` of the frame before | frames on the whole queue (physics included) | in theory | It keeps at most two frames queued. Because it is queue-wide, a frame can wait on physics submitted before it. On the M5 the fps held 120 with 20 ms steps (m5-ae8c948-pipeline.md), because Metal overlaps the command buffers. The game page has no such throttle (presentation backpressures instead). No action. |
| S7 | Sound: `postMessage` with transferred buffers | the worklet drains at its own block rate | no | Each frame is scheduled `latency` (30 ms) after arrival, back to back by its dt (`audio/src/engine.ts push`). That is a jitter buffer, so step bunching does not bunch the clatter. |
| S8 | Shared GPU queue | physics steps and frames share execution | **yes, indirectly** | Frames don't wait, but they take GPU time that physics needs once physics is behind. This is where P1 helps. |

## Latency budgets (estimates from the code paths, to confirm on the M5)

**Click to first visible motion** (game, 120 Hz, aiming, 10k):

| stage | ms |
|---|---|
| physics loop notices the shot (S1: waits for the next rAF) | 0-8.3 (avg 4) |
| step 1 on the GPU (10k at rest, 40 it: about 5 on the bench; more with frames interleaved) | 5-10 |
| readback map, decode, observe, upload | about 1 |
| next frame (the projectile has no previous state, so it is drawn at its new pose with no interpolation lag) | 0-8.3 |
| frame GPU time + compositor present | about 3 + 8 |
| **total** | **about 20-40** |

That is good for an aimed shot. Under 50 ms is generally not felt for a
throw. No input arrives while physics is behind: weapons detonate from
observations, not from clicks. So the frame governor's extra frame of latency
never lands on an input.

**Impact to sound vs impact to picture.** Both start when the snapshot
arrives (time A).

- Picture: A + 0 to 16.7 ms (the alpha ramp) + about 11 ms (GPU + present).
- Sound: A + 30 ms (jitter buffer) + the context's output latency (about
  10-25 ms on macOS; `AudioContext.outputLatency`, to log on the M5).

So sound trails the picture by about 15-35 ms. That is the forgiving
direction: audio late is tolerated to about 125 ms, audio early only to about
45 ms (ITU-R BT.1359 detectability). Cutting the 30 ms buffer would bring
back step-bunching artefacts for no felt gain. No action.

## What is already in place (do not rebuild)

| Mechanism | Where | Since |
|---|---|---|
| Physics apart from frames, valve (declared slow motion, never a held frame) | `game/src/physics-loop.ts`, `pacing.ts` | G4.2 #137 |
| Viewer's free loop, pipelined, steps timed by their own GPU time | `viewer/src/loop.ts runFree` | #44 (+9.7% steps/s at 10k, compute busy 85.9% → 94.6%) |
| Pipelined readback in the rules driver | `keystone/src/driver.ts` (`pipelined`) | G4 |
| Staging buffer pool, concurrent reads | `gpu/src/readback.ts` | — |
| Interpolation by arrival time, validity rule (shape, tier, jump) | `game/src/arrivals.ts`, `render/src/cull.ts` | R1 |
| Ball lights and trails from the interpolated records | `render/src/lights.ts` | R4 |
| Sound on the AudioWorklet thread, 30 ms jitter buffer, transferable frames | `audio/src/engine.ts`, `game/src/collapse-sound.ts` | #118 |

## Measured CPU per step on the main thread

Node 22, Intel Xeon 2.1 GHz container, median of 200. These are not M5 numbers;
they are for sizing only.

| work | 10k | 100k |
|---|---|---|
| decode the readback into a Snapshot (5 x readField, before P2) | 0.45-0.68 ms | 4.5-6.6 ms |
| the same, one pass (P2, this PR) | 0.28-0.30 ms | 2.3-2.7 ms |
| copy out of the mapped range (`slice`) | 0.08 ms | 0.8 ms |
| `packBodies` for the renderer | 0.42 ms | 2.6 ms |
| rules: `CpuObserver.observe` | 0.67 ms | about 6.7 (scaled) |
| sound: `FrameTap.frame` | 0.06 ms | 0.4 ms |

Allocation per step at 10k: a fresh Snapshot (1.05 MB), the staging copy
(0.64 MB) and the observer's `prevVel` (0.24 MB). That is about 1.9 MB, or
about 115 MB/s at 60 steps a second (1.1 GB/s at 100k). Typed-array backing
stores sit outside the JS heap and are freed concurrently, but external-memory
pressure triggers GCs. Whether those show as frame hitches is P5: measure
first.

## Plan, by priority

Each item says its gain, cost, risk to feel or latency, and how it is
measured. "M5" means the bench thread on Will's Mac (idle-gated), relayed
through the coordinator.

### P1. Draw fewer frames while physics is behind (`keystone.frames`), in this PR, default off

- **What.** `FrameGovernor` (`game/src/frame-rate.ts`) decides per display
  frame whether to draw. `all` draws every frame (the default, unchanged).
  `half` decimates by the largest whole factor that keeps at least 55 drawn
  frames a second: 120 Hz → 60, 144 → 72, 240 → 60, and 60-100 Hz never.
  `auto` decimates only while the sim runs under 0.95x real time without
  being asked to (not slow-motion juice, not fast-forward). It returns to
  every frame at once when the shot ends (aiming wants every frame), or after
  1 s of headroom (median step cost under 60% of a step's real time).
  Captures always draw. The logic, HUD and camera still run every frame; only
  the GPU work is skipped. It is set by URL `keystone.frames`, the scene file
  `rules.frames`, and the viewer's Rules panel ("frames drawn").
- **Expected gain.** In GPU-bound collapses, sim speed should rise by up to
  the GPU share the skipped frames held. That is about 60 x 2-3 ms, or
  12-18% of the GPU, if render and compute serialise, and less if Metal
  overlaps them. The estimate is 5-20%; the A/B decides. Shots end sooner
  in wall time. Frames stay smooth because of interpolation.
- **Cost.** About 100 lines. The per-frame overhead is negligible.
- **Risk.** 60 drawn frames a second instead of 120 during the collapse
  only. That adds about 4 ms average display latency then, and no input
  happens then. A flip between rates could be visible if `auto` oscillates:
  the hold and the headroom threshold are there to stop that, and the A/B
  checks it.
- **Alternatives considered.**
  - Always 60 on fast displays (`half`): simplest, but it gives up 120 Hz
    while aiming and orbiting, where the GPU has room.
  - Dynamic resolution (render-design step 21): cuts only fill-bound passes,
    and needs a controller. It is better for weak GPUs (P1 device tiers) than
    for the M5.
  - Lower look quality during collapses: changes the look mid-shot. Rejected.
  - Give frames a fixed GPU budget and let the valve see it: that is what
    happens now implicitly. It does not free anything.
- **Measure (M5, 120 Hz, headed).** The G4 probe now has four A/B cases. It
  must run headed (`TB_HEADED=1`), because headless Chrome runs rAF at 60 Hz,
  which is never decimated:
  `TB_CHANNEL=chrome TB_HEADED=1 TB_PROBE_CASES='cluster-40-rendered' TB_PROBE_OUT=$HOME/tb-e7-frames-<sha> pnpm vitest run packages/viewer/test/e2e-pacing-probe.test.ts --no-file-parallelism`.
  That runs blocks and city, each with all, half and auto (plus the
  budget-variant blocks cases). Compare `pace.speedMedian`, `wallMs` (shot
  length), `frameMs` p95/p99 (drawn-frame pacing) and `draws`.
  - **Adopt `auto` as the default** if wall time drops at least 5% on both
    scenes and drawn-frame p99 stays under 20 ms.
  - **Drop it** if the sim speed gain is under 3%: the GPU then overlaps
    render and compute well enough already.

### P2. Decode the readback in one pass, in this PR

- **What.** `decodeBodies` (`physics-gpu/src/snapshot.ts`) replaces five
  `readField` passes in `GpuAvbdEngine.snapshot()`. The output is
  value-for-value identical: `snapshot-decode.test.ts` checks it against
  readField on random bytes, with and without tiers.
- **Gain.** 0.2-0.4 ms per step at 10k and about 2 ms at 100k on the
  container (1.6-2x faster). It is main-thread time back for frames.
- **Risk.** None to feel. Replays are bit-identical: the same values, the
  same order.
- **Measure.** The viewer HUD's `snapMs` (snapshot + upload) at S4 10k and
  100k, before and after, from the M5 pacing or HUD runs.

### P3. Render from a GPU-side ring of states, not a CPU round trip (render-design R7 step 22, revised)

- **Now.** For GPU engines, each step's bodies go GPU → CPU (Float64) → CPU
  (packed f32, the same Body layout they came in) → GPU. `GpuBodySource`
  (zero-copy, drawing the engine's live buffer) exists but is unused.
- **Why not plain zero-copy.** If frames read the engine's live `bodies`
  buffer while a pipelined step writes it, Metal's hazard tracking orders the
  frame behind that step. A 19 ms step would then hold a frame, which is
  exactly the stall pipelining avoids. The current CPU round trip
  accidentally avoids it, because the renderer's buffers are only written
  after the step has finished.
- **Proposal.** After each step submit, enqueue `copyBufferToBuffer(engine
  bodies → ring[s mod 4])`: about 640 KB at 10k, microseconds of GPU. When the
  step's `finish()` resolves, publish slot s as current and s-1 as previous,
  with three or four prebuilt bind groups. Frames then read only slots whose
  writers have completed, so there is no hazard and no CPU touch for drawing.
  New slots (spawns) need a prev count uniform in place of the zeroed
  quaternions.
  - The game still reads back for its rules until E3 replaces that.
  - The viewer sandbox with no CPU consumer (no sound, no weapons, no hooks)
    can skip readback entirely.
- **Gain.** At 10k, about 0.5 ms of main thread and 640 KB of upload per
  step, and each state reaches the screen about 1 ms sooner (it no longer
  waits for map + decode). At 100k, about 3-5 ms per step plus 6.4 MB of
  upload: one of the two 100k blockers.
- **Cost.** Medium. It touches `render/src/source.ts`, the renderer's bind
  groups, and the game and viewer loops. Tests: the existing source-parity
  test idea (the same ID images through `SnapshotSource` and the ring), an
  upload spy (≤ 1 KB per frame in steady state), and a hazard probe (a frame
  submitted during a long step completes before it, on Metal).
- **When.** Before E6 (100k showcase); not needed for the 10k game.

### P4. Wake the physics loop on fire

- **What.** While aiming, the physics loop idles on rAF (S1). `fire()` could
  resolve that wait at once. Today the first step waits for the next frame.
- **Gain.** 0-8.3 ms (avg about 4 ms) off click-to-motion at 120 Hz, and
  twice that at 60 Hz.
- **Cost.** Small. `PhysicsHooks.idle()` races a kick promise. A unit test
  with the fake clock checks that a step is submitted without a frame
  passing.
- **Risk.** None to replays: it changes when, not which, steps run.
- **Next.** A small follow-up PR.

### P5. Allocation churn: measure, then pool

- **What.** About 115 MB/s of short-lived typed arrays at 10k (see above).
- **Measure first (M5).** Run a Chrome performance trace through a 10k
  cluster shot and count GC events and their main-thread time against frame
  intervals over 20 ms.
- **If it shows.** Add `snapshot(into?)` to `PhysicsEngine` (optional, so it
  is backward compatible) and rotate three Snapshots in the Driver. The
  Session and observer must copy what they keep, because the Session holds
  the home pose.
- **Risk.** Aliasing bugs: a kept reference silently changes. Tests must pin
  that baselines don't move.

### P6. GPU reductions for the rules (E3), not workers, for 100k

- **What.** The rules need reductions (nMoving, movingBox, collapse D,
  maxSpeed, watched bodies), not 100k bodies on the CPU. `PhysicsEngine.observe`
  already defines exact reductions and sparse reads. Readback then shrinks
  to a few hundred bytes per step.
- **Why not a worker.** A GPUDevice can't be shared across threads.
  - Physics in a worker means two devices and a CPU copy of every state to
    the renderer: more copies, not fewer.
  - Moving decode and observe to a worker saves about 1.5 ms per step of
    main thread at 10k, where the GPU binds anyway, and complicates
    ownership.
  - The whole page in a worker (OffscreenCanvas) isolates it from DOM jank
    but adds no parallelism.
  - Revisit a worker only if, after E3 and P3, the main thread still binds
    at 100k.

### Considered and rejected

- **Extrapolating instead of interpolating** (draw the newest state pushed
  forward by its velocity). It saves up to one interval of display lag, but
  stacks penetrate and snap back at every new contact, which is the worst
  case for a block game. It was already rejected in render-design.
- **Generated in-between frames (reprojection or frame generation).** It is
  not cheap in WebGPU, adds latency of its own, and leaves artefacts at the
  thin seams that define stacked blocks. Not needed: at 10k the render is
  capped at 3 ms. For weak devices, dynamic resolution is the better lever.
- **Projectile drawn on its exact ballistic arc at the current time** (free
  flight is exactly predictable, `freeFlight`). It would remove the lag for
  the ammo only, but the ammo would then run ahead of the structure it is
  about to hit, and visibly touch early.
- **Shorter audio buffer.** See the latency budget above: audio already
  trails the picture inside tolerance.
- **Dust and chips spawned at the interpolated position.** The detector
  spawns them at the newest state, up to one step ahead of the drawn cube
  (about 8 cm for a 5 m/s fall at 60 Hz, 16 ms early). That is below what
  can be seen in a puff. No action.
