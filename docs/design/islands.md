# Many worlds in one solve (C10)

Status 2026-11-06. Code: `packages/engine-api/src/islands.ts` (layout, id map, events, reads) and `island-observer.ts` (per-island counts). Verify: `packages/mode-probes/src/c10-islands.ts` (`pnpm probe:modes C10`), plus unit tests in `engine-api/test/islands.test.ts` and the reference check in `physics-ref/test/islands.test.ts`. Probe X8 (`docs/game/mode-probes.md`) answered the question first with hand-placed worlds; this is the primitive the game builds on.

## What it is for

The ground plane is infinite, so K copies of a small level placed far apart run in one engine and one step. Three things build on that (`docs/game/modes-roadmap.md`, claim 11 and section 4):

- **M9 Chorus:** one shot fired into 64 jittered copies of a level; the score is how many clear.
- **M8's robustness judge:** a placed structure tested in 64 nudged worlds at once, so building modes need no placement bot.
- **C13 / M13 cheap casts:** a star cast plays a small level 210 times; 64 at a time is 10 to 40 times cheaper than one at a time.

Only statistics may depend on it. A world in an islands run is not bit for bit its solo run (below).

## The API

```ts
const isl = new Islands(worlds);            // K SceneDescs sharing gravity, dt, ground, sleep and combine rules
await engine.init(isl.scene);               // every world's bodies at its island's offset; no inputs
const obs = new IslandObserver(await engine.observe({ tagWords: 1 }), isl);
obs.query([downPred, movedPred]);           // plain predicates; counted per island
// each step:
isl.push(k, localEvents);                   // optional, any time: world k's events in its own ids and coordinates
engine.push(isl.due(engine.stepIndex));     // releases what is due, translated, spawns get their global ids
obs.sync();                                 // tags the bodies just released with their island
await engine.step();
const { counts } = await obs.result(step);  // counts[question][island]
```

- `pack()` releases every queued event into the scene's inputs at once, for runs whose events are known up front (casts, probes). It equals releasing them step by step (tested); a later push must be due after the packed events.
- `local(snapshot, k)` is world k's own snapshot (its ids, its coordinates), so any existing per-level reader (Keystone's outcome rules) works per island unchanged.
- `solo(k)` is world k alone at its island's offset with the events it got (X8's solo-far): the replay to watch one island ("show me world 17").
- `leaks(snapshot)` lists bodies outside their island's cell; a run with one may have let two worlds touch and should be discarded.
- `reduceIslands(islands, snapshot, preds)` is the same per-island count on a snapshot (CPU), for engines read by snapshot.

## Decisions and the alternatives

**1. Pack K worlds into one scene (chosen).**
- *K engines on one device.* Every engine runs its own chain of dispatches each step, and a step is dispatch-bound for small worlds (about 1 µs per dispatch on the M5, and a step is many dispatches: per colour, per iteration), so 64 small engines cost about 64 times one; packed, they cost about one 9.6k scene. X8 measured the packed cost on Metal at 0.93 of a single 9.6k block per body-step.
- *A world index in the GPU solver* (per-world broadphase grids and colourings). A real change to every kernel, and it buys nothing that distance does not: the broadphase never pairs bodies 30 m apart.
- *The GPU fork (C14).* Orthogonal: it copies one state many times. Forks could be laid out as islands later.

**2. Layout: island 0 at the origin, square rings around it (chosen), gap from the footprint.**
- *X8's centred 8 x 8 grid.* No island sits at the origin, so no island shares a solo run's coordinates. With rings, island 0 does: it differs from the solo run only by sharing the solve (the C10 probe reports that shift as a diagnostic).
- The farthest coordinate is what f32 precision depends on. 64 islands reach ring 4 (4 gaps) against 3.5 for the grid; at X8's 59 m gap both are in [128, 256) m (236 and 207 m), the same f32 exponent, so the precision is identical; that holds for any gap from 37 to 63 m. Ring order is integer arithmetic (distance squared, then z, then x), the same on every machine.
- *A fixed gap (X8: 40 m, then 60 m once its wrecking ball threw debris 21 m).* Too wide for small worlds and too narrow for large ones. The default is twice the worlds' largest reach from their origin (bodies, spawns and point blasts, `worldExtent`) plus 24 m of room for debris and a ball that flies on, rounded up to a whole metre (offsets are then exact in f32). X8's full level gives 59 m, a half-cell of 29.5 m around the 21 m X8 measured.

**3. Events are released when due (chosen), not written into the scene up front.**
- An engine gives a spawned body the next id when the spawn is applied, in queue order (by step, then push order). If ids were assigned when events are queued, a later push due earlier than a pending spawn would take that spawn's id, and every removal or body-centred blast aimed at it would hit the wrong body. Releasing at the step it is due makes the id exact: everything before it has been applied.
- *Per-island id namespaces in the engine.* An engine change on three engines for no gain.
- Within one step, islands release in order, each in its own queue order, so each world sees its events in exactly the order a solo engine would (a grenade's blast before its removal).

**4. Per-island reads: one histogram per question (chosen).**
- Each body carries its island index in an observer tag word; `hist by tag, where P` gives every island's count of bodies satisfying P in one output. Sixteen questions for up to 256 islands, within the observer's caps, and a native GPU observer (E3) will run it unchanged.
- *K outputs per question (`where P and tag == k`).* Over the 16-output cap at K = 17.
- *Snapshot and CPU loops.* What `local()` gives, and what runs today on the GPU (whose observer is still the snapshot one); the probe checks that both agree.
- Sums per island (centroids, energy) are not one histogram; they come from `local()` until a sum-by-tag output exists. Nothing on the roadmap needs them on the GPU yet.

**5. Isolation is checked, not enforced (chosen).**
- A point blast that could reach past its island's cell is refused at `push`; a blast centred on a body must have a radius inside the reach. `leaks()` finds anything that left its cell; the probe requires none at every sample.
- *A fence that removes escaped bodies.* Changes the physics against a solo run only if the body would have come back, and keeps runs valid with a narrower gap. Deferred until a consumer needs a narrower gap.
- *Per-island collision masks in the engine.* An engine change; distance already does it.
- Caveat: leaks are sampled. A body could in principle leave and return between samples; at the 48 m/s blast speed cap and 30-step samples that needs a 24 m excursion into the neighbour's cell and back, which the default reach makes implausible.

**6. Not bit for bit (accepted).**
- On the f64 reference, a world whose bodies never touch matches its solo run bit for bit in an islands run (tested: spawn, body-centred blast with exclusion, removal, a push during play). With contacts it does not. The colouring's priority is a hash of the global body index (`physics-ref/src/coloring.ts`), so the order in which touching bodies are swept depends on where the world sits in the body list. Measured on X8's struck block: island 0 matched its solo run exactly; islands 1 to 3 ended 1 to 35 cm apart after 150 steps.
- On the GPU, X8 found the coordinates matter about ten times more than sharing the solve: a world alone at its island's position lands within millimetres of its island (63 of 64 the same outcome on Metal), while the same world at the origin ends centimetres away.
- *Key the colouring priority on an island-local index* (an engine option on the reference and the GPU). It would make the reference exact and remove one of the GPU's differences, but the GPU also orders pairs and sums in f32 globally. Deferred: every consumer depends only on distributions (Chorus scores counts, the judge and casts take quantiles).

## Limits

- At most 256 islands (the observer's bins). Every world shares gravity, dt, the ground, sleep and the combine rules (the constructor refuses otherwise), and the field schedule (C7, `docs/design/gravity-and-pins.md`): field events are pushed once for every island with `pushField()` (`push(k)` refuses them), released unchanged ahead of every island's same-step events, so a quake shakes every island alike and a body spawned at a kick's step is never kicked, in any island. `solo(k)` carries them in the same order. Mason's Trial's quake test uses it (`docs/game/masons-trial.md`).
- Capacity is the engine's: K times a world's bodies plus every spawn.

## Measured

CI size on SwiftShader (6 worlds of a 3 x 3 x 4 block struck by X8's wrecking ball, 1 s after the shot; `c10-islands.test.ts`; 6 rather than 8 to keep the file well under 300 s on a loaded CI runner): the shot moved every block (moved 0.88 on average, down 0.29 to 0.30); KS p = 1.0 on down and moved; 0 leaks at a 58 m gap; per-island observer counts equal each world's snapshot counts in 6 of 6 worlds; island 0 ended 3 cm from solo world 0 (down 0.31 vs 0.33, moved equal). An earlier 8-world run 1.5 s after the shot gave KS p 1.0 and 0.93.

Full size on SwiftShader (64 worlds of a 5 x 5 x 6 block, 150 cubes each, 300 pre-settle steps, read 4 s after the shot; 9,600 bodies plus 64 balls; commit f9957f1, 4,435 s for 65 runs):

| check | result |
|---|---|
| KS, islands vs solo, down | D 0.125, p 0.670 (64 vs 64): **pass** |
| KS, islands vs solo, moved | D 0.141, p 0.520 (64 vs 64): **pass** |
| power: the shot moves the block | 64 of 64 islands, moved takes 32 distinct values: **pass** |
| leaks | 0 body-samples outside their cell, at a 59 m gap with the farthest island 236 m out: **pass** |
| per-island histogram vs each world's own counts | 0 of 64 worlds differ (re-run of the islands arm, below): **pass** |
| means | islands down 0.566, moved 0.857; solo 0.560, 0.855 |
| island 0 vs solo world 0 (diagnostic) | centroid 0.19 m apart; down equal (0.547), moved 0.767 vs 0.780 |

The cost half of the verify (per body within 10% of the 9.6k block) is read only on Metal. X8 measured the same packing on Metal at 0.93 and then 0.66 of the block's cost per body (`docs/game/mode-probes.md`); C10's own Metal run is queued behind Low Power Mode and confirms rather than gates.

**The cross-check bug the full run found.** The first full run failed the observer cross-check in 60 of 64 worlds. The probe compared the histogram, which counts in the observer's fixed point (displacements quantised at 2^-16 m for down, 2^-15 m for moved), with the f64 rule's counts. The two differ only for a cube within a quantum of a threshold, and the down threshold is exactly where a cube rests after it drops one layer (one cell, 0.5 m): such a cube ends 0.5 m ± a few micrometres below its start, and f64 and fixed point split it. The CPU reference reproduced it (64 islands of the CI level: 1 world differs, by one cube at dy = -0.5000002 m, quantised to exactly -32768). The probe now compares the histogram with `fixedCounts`, the same predicates asked of each world's own bodies in the observer's arithmetic, and reports the split cubes as a diagnostic. The islands arm re-run at full size (commit f9957f1 plus the fix, 1,047 s) gave 0 of 64 worlds differing, 211 of 9,600 cubes split, and the same means as the first run.

- *Alternative: move the down threshold off the resting height* (for example 0.75 cell), which makes the f64 and fixed-point rules agree almost everywhere and makes down less sensitive to micrometres. Not taken here: it changes the outcome X8 and C10 report, and the KS comparison is fair either way, since both arms count the same way. A consumer that scores "down" (Chorus) should pick a threshold off a resting height.
