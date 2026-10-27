# Keystone on Rapier: what running it taught us

Status as of 2026-10-25. The design is [keystone-design.md](keystone-design.md) and the planned steps are [keystone-prototype-spec.md](keystone-prototype-spec.md); both came from the concept panel. This page records what changed once the rules ran against a real engine. Where they disagree, this page wins.

Reproduce everything here with:

```
pnpm keystone:probe            # mechanics probe, about 20 s
pnpm keystone:bot L1 L2 ...    # solver bot and par audit, minutes per level
```

## 1. Solid densities make hits feel dead

At real densities a plaster cube at h = 0.5 m is 125 kg. A 33 kg steel marble at 15 m/s barely shoves one, and a cannonball into the top course of a 6×6×10 tower moved the whole row about 10 cm before friction stopped it (Rapier, measured). Nothing displaced more than half a cube. Physically right, and no fun.

Structure materials are now model-scale (plaster 250 kg/m³, a 31 kg block); the ratios between structure materials are unchanged. Ammo stays solid steel. The cannonball was iron, which had been scaled with the structure. That made every hit result identical to the solid-density run: the outcome depends only on the ammo-to-structure mass ratio.

## 2. Rapier compresses loaded stacks

Every level sinks 2 to 4 mm per loaded contact in its first half second: 26 mm at the top of a 10-course tower, 73 mm at the crown end of a lever. Solver iterations (4, 8, 16) make no difference, so this is contact compliance, not convergence.

The driver now pre-settles after `init`. The settled pose, not the authored one, is the home for heritage checks and the first shot baseline. Tests assert, on Rapier and on the AVBD reference, the pre-settle drift is under 0.2 h with no tilt over 2°, and that nothing moves by 1 mm in the 120 steps after it.

The pre-settle was 90 steps, and is 300 since AVBD (2026-10-26). New AVBD contacts hold nothing for their first few steps, so stacks drop up to 41 mm and spring back with a time constant of about 45 steps; after 90 steps L1 and L2 were still rising 3.7 and 6.8 mm. Rapier is asleep by step 48, and its state at step 300 is bit-identical to step 90, so the Rapier par lines and probe grids are unchanged.

## 3. Loose lattice columns are independent

With 1 cm gaps between cells, columns never touch until something moves. Only slabs couple them. Two behaviours the panel's levels relied on don't exist in this grammar:

- **"The block above the ice course slides off as a unit."** The hit column's cubes leave one by one; the neighbouring columns stay put.
- **"Undercut one side and the block above tips."** There is no block, only independent columns.

Ice used to need ice on both faces of the slip plane: Rapier averages friction coefficients by default, so ice (0.05) on plaster (0.6) behaved like 0.325. Levels now set `SceneDesc.frictionCombine: 'min'` (engine contract since #13), so one ice face makes a slip plane. A test shoves an ice cube across the plaster ground and checks it slides v0²/(2μg) for μ = 0.05 (4.07 m from 2 m/s, against 0.62 m under 'average').

Switching the rule alone moved every steel-on-plaster contact from 0.55 to 0.5. That was enough to break L2's par line and to drop the bot's best L1 line from 100% to 37% robust (only 8 solutions from 1,344 attempts). Steel's friction is now 0.55, which restores 0.55 on plaster and the ground. L1, L3, L4 and L5 replay their par lines to the bit-identical final state. Only stone on plaster still changes (0.65 to 0.6), and only L2 has stone.

## 4. Mechanics probe (the kill gate)

Each behaviour is a tiny level, a nominal shot, and a success test. The shot is replayed over a 7 × 5 grid of nudges, ±0.6° of yaw by ±3% of power: what a player's hand can't control. A behaviour is robust if at least 80% of the grid succeeds. The gate needed 3 of 6. Raw results are in [probe-rapier.json](probe-rapier.json).

| Behaviour | Grid success | Verdict |
|---|---|---|
| B1 Column drop: knock a cube out, the column above drops one course | 9% | Not usable. The knocked cube drags the one above; the column tilts and topples. |
| B2 Shear: a low cannonball brings a slender tower down | 100% | Robust |
| B3 Pick-off: a marble takes a crown from between two heritage cubes | 100% | Robust |
| B4 Lintel tip: fell one column, the lintel sheds its load | 91% | Robust since the 'min' friction rule (69% under 'average') |
| B5 Catapult: an anvil on the free end throws the crowns | 100% | Robust |
| B6 Dominoes: a toppling column knocks the next over | 100% | Robust |

**5 of 6 robust: the gate passes.** (4 of 6 under 'average' friction; the lintel became robust with 'min'.) Levels L1 to L5 were rebuilt around B2 to B6 (one each), replacing the panel's L1 to L5.

**On the f64 AVBD reference at Keystone's settings** (40 iterations, 3e-5 m gap slop; 2026-10-27, `pnpm keystone:probe`) the gate still passes 5 of 6: B2 to B6 at 100%, B1 at 0%. At 40 iterations the dropped column lands on the cube below and topples forward, as on Rapier; at 20 iterations it was soft enough to stay upright in 26% of the grid. Raw results: `/mnt/project-files/game/probe-ref-40it-gapslop.json`.

## 5. Par lines from the solver bot

The bot aims at every cell of every block face every two courses, plus anvil drops over every top cell, at 60% and 100% power. It extends the best 3 partial attempts to par depth. The 5 best clean solutions are audited over the same nudge grid, and the most robust becomes the par line in `levels.ts`. Tests replay every par line (`packages/keystone-lab/test/par.test.ts`).

**Par lines are pinned on the f64 AVBD reference** at AVBD_ITERATIONS and AVBD_GAP_SLOP since 2026-10-27, the settings the GPU game plays at. Of the Rapier par lines only L5's still cleared there. The reference is deterministic across machines: the M5 Max (arm64, 18 jobs) and the cloud VM (x64, 4 jobs) found the same L3 to L5 lines with the same grids. Each runner thread starts attempts from cached copies of the settled level and of shared first shots (`SessionCache`, #69), so the whole bot run takes 28 minutes on the M5 Max. Logs: `/mnt/project-files/game/keystone-bot-ref-40it-m5*.txt`.

| Level | Behaviour | Par | Solutions found (reference) | Par line | Robustness | Gold line |
|---|---|---|---|---|---|---|
| L1 Open Fire | shear | 1 | the probe's B2 shot (see below) | one cannonball low on the tower, at the seam between its columns | 100% | 0.71 |
| L2 Lintel | lintel tip | 1 | 41 clean of 600 | a cannonball through the crowns on the lintel | 100% | 1.5 |
| L3 Surgeon | pick-off | 2 | 68 clean of 840 | two marble pick-offs | 91% | 1.3 |
| L4 Catapult | catapult | 1 | 7 of 211 | the anvil on the free end | 100% | 0.18 |
| L5 Dominoes | dominoes | 1 | 162 of 400 | a marble into the crown column from +x | 100% | 5 |

Under Rapier the lines were 100%, 77%, 97%, 80% and 100% robust.

**The gold-leverage line** (third star) is the lower quartile of the leverage the par line's clean neighbours on the nudge grid reach, rounded down to two significant figures (`goldLine`, `pnpm keystone:par`). About three in four near-par shots earn it.

**What the reference changed for level design:**
- **L3 and L4 now play as designed.** Two clean marble pick-offs beat a cannonball on L3, and on L4 the anvil on the catapult's free end is the robust move (on Rapier it only cleared by landing next to the crowns).
- **L2:** felling a column, the level's idea, is fragile: the 5 highest-leverage lines (all column hits at 60% power, leverage 2.9 to 4.8) are 11 to 46% robust. A 100% cannonball through the crowns is robust at leverage about 2.5. All 41 clean solutions were audited for this.
- **L1** (a 3 × 3 × 12 tower, par 2) was much harder: 3 clearing lines of 1,344 attempts, all brute cannonballs, the best 83% robust, and that one failed on the GPU solver. As the first level it should be the easy one, so version 3 is the probe's B2 tower (2 × 2 × 10, four crowns) at par 1. B2's shot hits the seam between two columns at course 3, which the bot's candidates (cell centres, every two courses) never try; it is 100% robust on the reference and clears on Rapier too, so the game page's Rapier test plays it.
- **L5:** the domino chain is still optional. The robust lines hit the crown column directly from +x.

**On the GPU solver** (f32, SwiftShader in CI; `packages/game/test/par-gpu-L*.test.ts`) every par line clears with no heritage broken, played live in the game page. Each level takes one to three minutes there at 40 iterations, so each has its own test file for CI's shards.

On Metal (M5 Max, Chrome, `TB_CHANNEL=chrome`; 2026-10-27, main 0739eae) all five clear too, in 5 to 8 s a level with the five files running at once. Step counts differ from SwiftShader's by up to 12% (565 against 526 on L1): the GPU solver is deterministic per device, not across devices, so par tests check the outcome, not the trajectory. The game's default engine is the GPU solver since then; `?engine=rapier` keeps Rapier. Each test logs the load time and the median and p95 ms per live step (physics only, the page draws no frames offscreen).

Run one page at a time on the M5 Max (#76 head 31f94d4, `--no-file-parallelism`; `/mnt/project-files/par-gpu-metal-timing.txt`):

| Level | Load (300-step pre-settle) | Live step median | p95 | max |
|---|---|---|---|---|
| L1 | 1.2 s | 9.75 ms | 11.43 ms | 12.40 ms |
| L2 | 1.8 s | 11.78 ms | 14.20 ms | 158.94 ms |
| L3 | 1.0 s | 11.56 ms | 14.83 ms | 19.00 ms |
| L4 | 1.2 s | 9.32 ms | 11.19 ms | 166.81 ms |
| L5 | 0.7 s | 7.72 ms | 13.08 ms | 15.47 ms |

A live step fits a 60 Hz frame, with little room for drawing. The pre-settle steps cost at most 2.3 to 6 ms each, and that time includes building the engine: the driver submits all 300 steps and reads the bodies back once. A live step instead waits for its own snapshot read-back before the next step is submitted, so most of a live step is likely the read-back round trip, not the solve. The lever is to pipeline the game's read-back, as the viewer does (#44). L2 and L4 each had one step of about 160 ms; the cause is not known yet.

These are first-pass levels. They need playtesting and level-design passes, not more tuning in the dark. The bot makes each pass cheap: change the level, rerun the bot, and the par-line test tells you if the old solution broke.

## 6. Smaller engine facts the game depends on

- **Integrator.** Rapier takes one substep per solver iteration (4 by default). Predicting the arc with a single semi-implicit step is off by about 6 cm after one second. `predictArc` and `aimAt` take a substep count; the test pins Rapier's free flight to 0.2 mm over 60 steps.
- **WASM memory.** Rapier worlds must be `dispose()`d. The bot crashed (`RuntimeError: unreachable`) after about 1,300 undisposed worlds.
- **Settle time.** Shots settle 30 to 300 steps after the spawn, so a par audit (35 sessions) of a 100-body level takes 2 to 8 s.

## 7. Asks for the engine contract (`@tb/engine-api`)

None of these block the prototype. They matter once the GPU solver replaces Rapier:

1. **Friction combine rule.** Done (#13): `SceneDesc.frictionCombine`, honoured by Rapier, physics-ref and GPU AVBD. Keystone uses 'min'. The tower tier's host does not carry it yet, so levels on `TieredEngine` still average.
2. **Integrator substeps in `EngineInfo`.** Done (#13): Rapier 4, AVBD 1. Tests pin the game's and the lab's substep constants to what Rapier reports.
3. **`reduce()` and sparse `readBodies()`** with fixed-point integer sums, matching `reduceCpu` in `@tb/keystone/src/rules.ts` bit for bit. At 100k bodies the game cannot read a full snapshot every step.
4. Later: a static-body flag (plinths, anchors) and a deterministic GPU mode for shared replays.
