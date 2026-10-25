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

The driver now pre-settles 90 steps after `init`. The settled pose, not the authored one, is the home for heritage checks and the first shot baseline. Tests assert the pre-settle drift is under 0.2 h with no tilt over 2°, and that nothing moves by 1 mm in the 120 steps after it.

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

## 5. Par lines from the solver bot

The bot aims at every cell of every block face every two courses, plus anvil drops over every top cell, at 60% and 100% power. It extends the best 3 partial attempts to par depth. The 5 best clean solutions are audited over the same nudge grid, and the most robust becomes the par line in `levels.ts`. Tests replay every par line.

| Level | Behaviour | Par | Solutions found | Par line robustness |
|---|---|---|---|---|
| L1 Open Fire | shear | 2 | 91 of 1,344 attempts | 100% |
| L2 Lintel | lintel tip | 1 | 41 clean of 600 | 77% (71% under 'average') |
| L3 Surgeon | pick-off | 2 | 36 clean of 600 | 97% |
| L4 Catapult | catapult | 1 | 23 of 211 | 80% |
| L5 Dominoes | dominoes | 1 | 149 of 400 | 100% |

The gold-leverage line (third star) is provisional at about 0.9 × the par line's leverage. The bot should set it from the audit grid later.

**Level-design problems the bot exposed.** Most par lines are brute force, not the behaviour each level was built around:
- **L5:** the bot's best line hits the crown column directly (from +x) and the chain runs backwards. The domino chain is optional.
- **L3:** a cannonball into course 4 followed by a marble beats two clean pick-offs on robustness.
- **L4:** the most robust anvil drop lands next to the crowns, not on the free end of the catapult.
- **L1 and L2:** brute cannonballs win (leverage 1 to 3).

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
