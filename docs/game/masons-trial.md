# Mason's Trial (M8)

Roadmap item M8 (`docs/game/modes-roadmap.md`, `plan/dag/nodes.json`): build, then test. Time stops and the player places pieces from a budget (C9's build phase). Then the level's test runs: a ball rolls over the bridge, a collapse falls on the shelter, boulders roll at the berm, or a weight drops onto the reach. The build is judged in 64 jittered worlds at once (C10 islands), and the score counts how many of them pass.

Verify (the brief): Play rebuilds exactly from the placed parts; the judge's pass fraction agrees with 64 solo runs; the score is the pass fraction times the budget left, with the 2 and 3 star lines from author solutions; three to five levels that keep 40 iterations whatever the quality tier; placement ergonomics on the docked phone HUD.

## The design

### The test (keystone `mason.ts`)

A Mason level is a level with a `mason` block (`MasonDef`) and a `build` block with a budget. It has no rack: the test takes the shots' place, and its objective is `trial` (the judge decides, not `outcomeCleared`).

- **Timeline** (`masonTimeline`): the level's pre-settle (300 steps), then `hold` steps with the build standing alone (default 60, 1 s), then the test: the probes spawn and any quake starts. The judge reads the worlds `run` steps later.
- **Probes**: the bodies the test throws (`MasonProbe`): a ball or a box, in h, with a velocity in h/s and a material.
- **Pass rule**: a list of clauses (`MasonCheck`), each a count over `heritage` (what the build protects: the level's heritage pieces) or `probe`, of bodies that `moved` more than d h, `dropped` more than d h below where they started, or `advanced` more than d h along x or z. The count is compared with `atMost` and/or `atLeast`. Heritage is measured from the world as built (before the pre-settle), probes from one step after they spawn.
- **Quake**: optional, as C7's `quakeEvents` (peak g, Hz, seconds, axis). Field events are world-wide, so the judge pushes them once for every island (`Islands.pushField`, added for M8; see below). No shipped level uses one yet.
- **Iterations**: every Mason level plays at `MASON_ITERATIONS` = 40, whatever its physics block, a URL override (`?keystone.iterations`) or a quality tier asks (`physicsOf`). X4 (`docs/game/mode-probes.md`) measured why: at 20 iterations a 95% harmonic overhang falls and an arch wall creeps, and at 40 both hold. `validateLevel` refuses a Mason level whose block names any other count, `game/test/mason-engine.test.ts` checks the level engine and the judge engine under every override, and that no quality tier holds a physics knob.

Two rules from the probes are in the grammar:
- **No pass threshold on a resting height.** A cube that drops one layer rests within micrometres of 1 h, where f64 and the observer's fixed point can split it (`docs/design/islands.md`). `masonIssues` refuses a `dropped` d within 0.05 h of a whole number. The shipped drop thresholds are 2.25 h.
- **Judge drops, not creep.** X4 saw bricks over an opening slide slowly for a minute. Every clause is a gross event (a drop of over 2 h, a move of a quarter h, an advance of 14 h), not a millimetre-scale drift.

### The worlds and the judge (`mason.ts`, `mason-judge.ts`)

World 0 is the build exactly as placed: the world the player watches. Worlds 1 to 63 are jittered copies, from a seeded integer generator (mulberry32), so every machine draws the same worlds:
- every placed, unpinned piece is shifted across the ground by up to 0.02 h in x and z (`masonBodies`). A shift that would push a piece into a neighbour more deeply than the build already had it is not made, so jitter never creates an overlap the build tool would have refused;
- every probe is moved up to 0.1 h across the ground (MT1: 0.04 h, so the ball stays on the approach), and its speed is varied by up to 10%.

`MasonRun` packs the worlds as islands (`Islands`, C10), with the quake pushed once for all. It steps one engine, takes the reference positions at init and one step after the probes spawn, and at the end counts the clauses per island with `reduceIslands` (tag word 0 the island, word 1 the body's class: heritage, probe or other). It reads three snapshots in all, so a GPU engine runs pipelined with no read-back per step. `judgeMason` runs it to the end, and `soloMason(c, k)` runs world k alone at the origin, judged by the same rule.

The game's GPU judge engine (`game/src/engines.ts makeMasonEngine`) has room for every world's structure and probes, the probes' reach, and the pair room of one world, because islands never touch.

### Scoring (keystone `rules.ts`, agreed with the scoring thread)

Two lines, which sum to the total (`masonLines`):
- **Robust c/K**: round(500 c / K);
- **Budget left l/B**: round(500 (c / K) (l / B)).

So a build that passes everywhere and spends the whole budget scores 500, and a free one would score 1000. A build is **cleared** when at least half its worlds pass (`MASON_CLEAR`). An uncleared build gets no stars whatever its points: 31 of 64 with most of the budget left can reach the 2-star line, and is still 0 stars. Cleared builds take 1, 2 or 3 stars on the total against the level's `stars` (`masonStars`). The stamp is ROBUST (every world), STANDS (cleared) or WOBBLY. `LevelScore.worlds` holds c of K and the counts that 1, 2 and 3 stars need at this build's budget (`masonThresholds`; K + 1 when out of reach), so the card shows "c of 64" once; `LevelScore.mason` holds the budget. There is no leverage, no gold and no heritage star loss (the heritage is in the pass rule).

**Star lines from author solutions, not a bot or a cast.** Each level records two author builds as programs of build-tool steps (`keystone-lab mason-solutions.ts`; each step is a face hit through the real `BuildSession`, so overlap, snap and budget apply). The 3-star author is the cheap clever build, the 2-star author a plainer, dearer one. Each tier's line is `MASON_STAR_SHARE` (0.9) of that author's points in the reference judge's 64 worlds, floored to 10 (`masonStarsFrom`): slack for the GPU against the reference, and for a player who builds the same idea a cell off. `test/mason-ref-MT*.test.ts` checks the levels say exactly what their authors give.

## The levels (`keystone/src/mason-levels.ts`)

All four have pinned scenery (M10's `pinned` pieces from #262: cliffs, a table) or plaster heritage, and use the C9 catalogue. Measured on the f64 reference in all 64 worlds (`pnpm mason:judge MT1 --knife --wrong --solo`):

| Level | Test | Budget | 3-star author (points) | 2-star author (points) | Stars | Knife-edge build | Wrong builds (fail) |
|---|---|---|---|---|---|---|---|
| MT1 Corbel Bridge | a stone ball rolls off a 3.25 h approach and must cross a 4 h gap to the lower exit, and not fall | 12 | a pier of three in the gap under two slabs: 64/64, 7 spent (708) | corbels: a slab cantilevered off each ledge, four cubes on each back end: 60/64, 12 spent (469) | 420 / 630 | corbels weighted 4 and 3: 44/64 | nothing; slabs with no weights; a bare pier |
| MT2 Shelter | five stone blocks fall from 8 to 13 h onto a tall plaster urn; it must not move a quarter h | 12 | two piers of three and a plank roof: 64/64, 8 spent (667) | two piers and a beam roof: 63/64, 9 spent (615) | 550 / 600 | a lean-to: one pier and a slab: 32/64 | nothing (19/64 pass: the debris sometimes misses); a slab laid on the urn |
| MT3 Berm | five stone boulders (1.4 h across) roll at two plaster huts at 10 h/s | 16 | a course of four two cells out in front of each hut: 64/64, 8 spent (750) | a wall of four by two in front of each hut: 64/64, 16 spent (500) | 450 / 670 | the courses close in front of the huts (a boulder can shove one into a hut): 38/64 | nothing; a cube in front of each hut |
| MT4 Overhang Reach | a plaster weight drops 1.6 h onto the spot 2.5 h past a table's edge; it must not fall to the floor | 10 | a plank out over the edge, three cubes on its back end: 64/64, 5 spent (750) | the same with four cubes: 64/64, 6 spent (700) | 630 / 670 | a plank further out, two cubes: 46/64 | nothing; a bare plank; a plank with one cube |

What tuning taught (each changed a level before it shipped):
- **A rolled ball does not climb a step at this speed.** It bounced back off a slab's or a plank's leading edge. MT1's approach is flush with a slab laid on the left ledge, and every step on the ball's way is down, to the exit at 2.5 h.
- **Snap centres a piece at the hit**, so no single piece is laid across MT1's gap from a ledge. That is what makes it a corbel puzzle: slabs cantilevered off each ledge tip unless weighted at the back, or a pier stands in the gap.
- **MT1's weights first sat in the ball's lane.** They are on the slabs' back ends at z = plus and minus 1, and the ball's radius is 0.45 h so it rolls between them.
- **MT4's weight**: a ball rolled off the plank, and a stone box catapulted it. A plaster box dropped from 4.6 h is what a counterweighted plank catches.
- **MT2's urn** survived square hits from a cube. A tall vase (0.6 by 1.6 h) and debris staggered in x and z topple it when nothing covers it.
- **MT3's first 3-star build** (a course close in front of each hut) passed 8 of 8 early on, and 38 of 64 in the full judge: a boulder shoves a course of four (four loose cubes) into the hut behind it. Two cells further out, the shoved cubes stop before the hut, 64 of 64. The close build became the level's knife-edge build. This is the judge doing its job: the 8-world view hid a 40% failure.

## The verify: islands against solo runs

Islands are not bit for bit their solo runs once bodies touch (C10, `docs/design/islands.md` decision 6: the colouring's priorities are global), so the judge's per-world verdicts are not expected to equal the solo runs'. What must agree is the pass count: the same build in 64 islands and in 64 solo runs of the same worlds. The outcomes are pass/fail, so the brief's KS test is degenerate (two steps); the test is **Fisher's exact test, two-sided, on the 2 x 2 table of passes** (`keystone-lab mason-stats.ts`, with a Wilson interval per arm). A build that passes everywhere or nowhere says nothing about agreement, which is why every level has a knife-edge build.

On the reference, 64 worlds (`pnpm mason:judge --solo`):

| Build | Islands | Solo | Same verdict | Fisher p |
|---|---|---|---|---|
| MT1 pier | 64 | 64 | 64 | 1.000 |
| MT1 corbels | 60 | 60 | 64 | 1.000 |
| MT2 plank roof | 64 | 64 | 64 | 1.000 |
| MT2 beam roof | 63 | 62 | 61 | 1.000 |
| MT2 nothing | 19 | 15 | 52 | 0.549 |
| MT2 lean-to (knife) | 32 | 27 | 43 | 0.478 |
| MT3 two cells out | 64 | 64 | 64 | 1.000 |
| MT3 close courses (knife) | 38 | 38 | 62 | 1.000 |
| MT4 plank, 3 cubes | 64 | 64 | 64 | 1.000 |
| MT4 plank, 4 cubes | 64 | 64 | 64 | 1.000 |
| MT4 further out, 2 cubes (knife) | 46 | 46 | 64 | 1.000 |

The chaotic cases show the C10 caveat plainly: in MT2 (five blocks tumbling onto a vase) the lean-to gives the same verdict in only 43 of 64 worlds and the bare level in 52, yet 32 against 27 passes and 19 against 15 are well inside noise (p 0.48 and 0.55). Per-world verdicts are never shown as exact; only the count is scored.

CI runs a smaller verify on every level: the knife-edge build in 16 islands against the same 16 worlds alone (`test/mason-ref-MT*.test.ts`), plus the authors passing and the wrong builds failing in the first 8 worlds. With `PHYSICS_GPU_SLOW=1` the same files re-run every recorded build's 64-world judge (the reference is deterministic, so the passes must equal the record) and the full 64 against 64 verify. On the GPU (`test/mason-gpu-MT*.test.ts`, the game's cast page and judge engine) the authors pass in 64 islands at least 0.9 of their reference count, the bare level fails, no island leaks and the engine hits no limit; the GPU verify (16 against 16) is behind `PHYSICS_GPU_SLOW=1`, since a solo run costs as many steps as 64 islands on SwiftShader.

## In the game (`keystone/src/mason-trial.ts`, `game/src/play.ts`)

- **Build, then test.** A Mason level opens in its build phase (no rack: nothing fires). The panel's Play compiles the level as built and loads it (the same hash Node's build tool gives: `mason-e2e.test.ts`), and its test starts as soon as the level is in and has grown back. Retry keeps the build and waits for **Test the build** (the HUD's slot, key F), which runs the same test again; B (before a test) builds on it again.
- **What runs.** `MasonTrial` pushes the test's field events and world 0's probes into the page's own driver, which steps and draws world 0 as a shot is (the player watches world 1 of 64). The judge plays all 64 worlds as islands on an engine of its own (`makeMasonEngine`, the GPU's room for every world), in batches of 8 steps a frame, paced by `requestAnimationFrame`, so the page keeps drawing. World 0's verdict is read from the driver's own snapshots; the card's score is the judge's count only (islands are not bit-exact, decision above). A load (Retry, Next, Play, Cancel) stops a test under way.
- **The HUD and card.** The status row reads "build, then test it in 64 worlds", "testing: you watch world 1 of 64", "judging the other 63 worlds…", then "stood here · stood in c of 64" (or failed here). The card's line is "stood in c of 64 worlds · spent s of B" in place of strokes and par, the Robust and Budget lines, the stamp, and under the stars the worlds the next star needs at this build's cost (or that it needs a cheaper build). No leverage, no gold.
- **The door.** Mason's Trial is a series of its own (MT1 to MT4) before the unrated trials.
- **Slide** ([placement.md](placement.md)). Writing the game test showed the recorded MT1 and MT4 builds were programs no player could click: they named a point on a ledge's top face past its edge, so the plank or slab was centred out over the gap. The build tool centres a piece on the pointer, so nothing could overhang more than half its length. The tool now slides the held piece along its length ([ / ], or the panel's Slide buttons), and the recorded steps are clicks (MT4's plank: half a cell in from the table's edge, slid out two). The rewritten programs give byte-identical levels (all 22 recorded builds checked), so every measurement above stands; `masonUnreachable` checks in CI that every recorded step is the face a ray straight down onto it picks. Alternatives: re-author the levels so the authors' pieces sit centred on a face (MT4's best reachable plank is then the knife-edge build, 46 of 64, so the level would have to move and be re-measured, and corbel bridges would stay capped at half a piece of overhang); let a ghost follow the pointer past a face's edge (a click off the table would then place on the table, which reads as a bug); an anchor key that puts the piece's end, not its centre, under the pointer (one fixed overhang, where the slide gives every half-cell).
- **The phone.** On a docked phone the Build panel (PT18) shows Slide back / Slide out with the plank held (a tap slides it); after a test the card and, on Retry, the Test button sit inside the screen, on top, and clear of the status strip (or rail), Menu and the Build button, upright (390 x 844) and sideways (844 x 390): `mason-e2e.test.ts`. Measured: Test is 254 x 44 px at (16, 787) upright and 100 x 44 px at (16, 333) sideways.

## Tests

- `keystone/test/mason.test.ts`: the levels validate, pin 40 iterations under any override, and hash their test; validation refusals (a drop threshold on a resting height, heritage clauses with no heritage, malformed stars, runs, quakes, budgets, a rack); the timeline; world 0 unjittered, other worlds seeded and bounded and only placed pieces moving; the jitter's overlap guard (even at half a cell); probe jitter; the pass rule counted per island in fixed point on either side of a threshold; the two lines, stars, stamps and thresholds.
- `engine-api/test/islands.test.ts` and `physics-ref/test/islands.test.ts`: world-wide field events (`pushField`): release order, solo order, packing, refusals; two identical islands under a tilt and a kick match each other and their solo run.
- `keystone-lab/test/mason-stats.test.ts`: Fisher and Wilson against textbook values.
- `keystone-lab/test/mason-ref-MT*.test.ts` and `mason-gpu-MT*.test.ts`: as above.
- `game/test/mason-engine.test.ts`: iterations under every override and tier, the judge engine's room.
- `keystone-lab/test/mason-trial.test.ts`: `MasonTrial` on serial and pipelined drivers: world 0's counts equal its solo run, the verdict equals `judgeMason` on the same worlds, and a driver not at its start is refused.
- `keystone/test/build.test.ts` and `game/test/edit.test.ts`: the slide (half-cells along the piece's own x, turned with it, clamped to keep the point under it, a plank reaching past a ledge), its keys, status and panel buttons.
- `game/test/hud.test.ts`: the status row, the Test slot, the card's line and next-star hint.
- `game/test/mason-e2e.test.ts` (headless Chromium, Rapier): MT4 built by rays and keys (the slide included) is exactly Node's build, Play runs the test (64 of 64 on Rapier, three stars), Retry keeps the build and Test runs again; the phone layout above.

## Alternatives considered

- **A solo-run judge** (each world alone, one after another). Exact per world and simple, and 64 times the steps: on SwiftShader one MT4 judge is about 70 s as 64 islands, and would be over an hour as 64 solo runs. On the M5 the islands' 64 worlds of about 20 bodies are a fraction of one 1k level's frame. The solo runs stay as the verify, not the judge.
- **16 worlds.** A quarter of the bodies, and the noise of the pass share at p = 0.7 goes from about plus or minus 0.06 to 0.11 (one standard error), so a star line moves by a world or two between near-identical builds. MT3 showed the other cost: 8 worlds called a 38-of-64 build robust. 64 stays the default; `MasonDef.worlds` lets a level ask for fewer (validated 1 to 256).
- **A placement bot to set stars** (as Rube Lab's gate bot). R3 rejects it for this mode: the build space is open-ended (any piece on any face), a bot's best is a search artifact, not a design, and the judge already measures robustness, which is what a bot's nudges stood for in M10. Author solutions as programs through the real build tool are cheap, reviewable and re-checked in CI.
- **Joints first (V6).** Mortar or glue would allow real arches and true bridges, and would change every level's balance. The four levels here are designed for jointless masonry (corbels, counterweights, piers, berms), which is what X4 showed AVBD holds at 40 iterations. Joints become a later level pack, not a prerequisite.
- **Score the per-world verdicts directly against the player's world 0.** Rejected: islands are not bit-exact, so "you passed in the world you watched" and the judge can differ in a chaotic build. The card shows the count, and the world the player watches is world 0 alone, as the game plays it.
- **KS on pass/fail.** Degenerate on a two-valued outcome (it reduces to the difference of the two shares with a poor null distribution); Fisher's exact test is the exact test for a 2 x 2 table.

## Known limits and follow-ups

- **Quake tests** work in the judge (`pushField`) but no level uses one yet: a quake level needs its own tuning (X6 found no resonance, so a quake test is a strength test, not a timing puzzle).
- **Metal numbers**: the GPU judge's cost and agreement on the M5 are on the Mac queue.
