# Spectacle mode: game mode spec and vertical slice plan

Status 2026-11-01. Roadmap node G1 (`/mnt/project-files/plan/roadmap-dag.md`). Nothing here is built yet. This spec sits on top of [keystone-design.md](keystone-design.md) and [findings.md](findings.md); where they disagree about outcome-scored levels, this page wins. Par-scored levels (L1 to L5) keep their rules unchanged.

**Inherited decisions (Will, 2026-11-01, all roadmap defaults accepted):**

- Q1: the game is the **spectacle hybrid**: Keystone's shell (levels, rack, rules, replays, bot) with 1k to 10k block structures, scored on what happens, with stars cast from the bot's perturbed outcomes.
- Q2: Bounce is on in big levels at e 0.3 to 0.5 once restitution hardening (E4) lands, and off in small precise levels.
- Q4: physics in real time at 60 Hz up to 10k bodies on the M5 Max; 30 fps is the hard floor everywhere.
- The advanced weapons language (`WeaponSpec`, V3) comes soon, so the rack is designed for scripted weapons from the start, alongside the grenade and the six real projectiles.
- Standing rules: every choice is a switchable option (URL key, Scene panel, scene file); the viewer stays a superset of the game; Claude merges PRs once checks pass.

## 1. The mode in one paragraph

A level is a big structure (1k to 10k blocks), an objective, and a small rack of 2 to 6 things to throw or detonate. You read the structure, fire, and watch it come down; rubble stays between shots and physics freezes while you aim. After any settled shot you may **bank** (end the level and keep the unused rack as points) or fire again. The level ends when you bank or the rack is empty. Stars measure one legible outcome (by default, **how much of the structure came down**) against thresholds the bot cast from many perturbed plays of the level on the M5. The score tally adds efficiency (energy released per energy fired), crowns, unused rack, and the heritage and footprint penalties, for personal bests and replays. Par and golf stamps stay on the five small levels only.

**Why this shape.** Par lines cannot be pinned at 10k: the outcome of one shot is chaotic, and the GPU solver is deterministic per device, not across devices, so a par line that clears on the M5 can fail on another GPU (findings section 5: SwiftShader and Metal step counts differ by up to 12% on 40-body levels). A threshold that is a quantile of an outcome distribution survives both: a different device draws from nearly the same distribution, and a shot near a good shot lands in the same band. Stars on one named metric ("bring 72% down") keep the goal legible before the first shot.

## 2. What stays and what changes

| Piece | Par levels (L1 to L5) | Outcome levels (new) |
|---|---|---|
| Driver, presettle, freeze between shots, replays from `(level, shots)` | unchanged | unchanged |
| Session observations (reductions + watched bodies) | unchanged | adds `nMoving` and `movingBox` reductions (section 9) |
| Objective kinds | crowns, skyline | crowns, skyline, and a new `collapse` |
| Level ends | at clear, or rack empty | at bank, or rack empty (`keystone.autobank=1` restores end-at-clear) |
| Stars | par + lGold | one star metric with cast thresholds T2, T3 |
| Score tally | strokes, leverage, combo, ace, heritage, footprint | objective, collapse, leverage, combo, rack left, heritage, footprint |
| Rack | marble, cannonball, cue, drop | those plus real projectiles, the grenade, `WeaponSpec` weapons |
| Settle rule | v1 (every awake body quiet) | v2 (all but a few bodies quiet; section 9) |
| Physics | 40 it, gapSlop 3e-5, no Bounce | per level, pinned in the level hash (section 8) |

A `LevelDef` gets one new field, `scoring: 'par' | 'outcome'` (default `par`, so every existing level and test is unchanged).

## 3. Objectives and constraints

Exactly one objective per level; meeting it is the first star.

| Objective | Met when, at the end of the level | Exists today |
|---|---|---|
| `crowns` | every crown is down: centre below `crownLine` or outside the lot | yes |
| `skyline` `{ maxH, footprintMax? }` | settled skyline height at most `maxH` h | yes |
| `collapse` `{ min }` | collapse fraction D (section 4) at least `min` | new |

Constraints (optional, any level): **heritage** (sticky break at 0.3 h or 15 degrees, as today; any break caps the level at one star) and **footprint** (fraction of structure bodies outside the lot grown by 0.5 h at most `footprintMax`; the excess costs points, not stars).

**Crown budget.** At most 64 crowns plus heritage bodies per level, because they are read as watched bodies every step and the 100k path reads at most 64 (design section 7). Big structures are judged by reductions (collapse, skyline, footprint), not by watching thousands of bodies. Validator issue `watched`.

## 4. Measures

All are pure functions of observed state and step indices, never frames or wall time. Integer fields are exact so a GPU reduction can match them bit for bit later (engine ask 3, E3).

- **Potential energy** PE: as today, `sum of round(m g y * 1000)` mJ over structure bodies.
- **Floor energy** PE_floor: the energy of every structure body lying flat on the ground on its largest face: `sum of peOf_mJ(m_i, min half-extent_i)`. Static per level.
- **Collapse fraction** `D = clamp((PE(B0) - PE(end)) / (PE(B0) - PE_floor), 0, 1)`, B0 the level baseline after presettle. Scale-free: the same number means the same thing at 1k and 10k. Validator issue `flat` when `PE(B0) - PE_floor` is under one plain block falling one h (nothing to bring down).
- **Energy fired** E_fired, summed over shots:
  - a launched thing: `1/2 m v^2` at spawn (today's `ammoKE`); a drop: `m g y_spawn`;
  - a blast: its **nominal yield** Y, a static function of the blast's parameters: the kinetic energy it would give a solid fill of the level's most common structure block (material and size) at rest, filling its sphere, with `maxDv` and `maxSpeed` applied: `Y = integral over the ball of 1/2 rho_fill min(maxDv, maxSpeed, I w(d) A/m)^2 dV`, with rho_fill = block mass / pitch volume and A/m that block's (blast.ts's A). Computed by fixed 1,024-shell midpoint quadrature with integer falloff (repeated multiply, no `Math.pow`), so it is the same on every machine;
  - a `WeaponSpec` weapon: launch KE plus the static yield of every action its spec can take, from the V3 validator's budget (ask to V3, section 7).
- **Leverage** `L = max(0, PE(B0) - PE(end)) / E_fired`, J per J, as today but with blasts counted.
- **Skyline, footprint, crowns, heritage**: as today (`rules.ts`).

Why nominal yield and not the energy a blast actually injects (which the rules could compute from the observed state with `blastKick`): measured injection grows with the number of bodies inside the radius, so a grenade placed in the dense base, the clever shot, would cost more energy and score lower leverage than one wasted in the air. Nominal yield makes placement the skill, and it is static (validator, budget, no runtime cost, device-independent).

## 5. Level end and banking

- After a shot settles with rack left, the phase is `aiming`. The player may fire, or bank (key B, a button on the result chip). Banking is refused while a shot is running.
- The level ends at a bank or when the last shot settles. The objective is judged at the end, and shown live as a check mark for feedback.
- Nothing new is recorded: a session is still `(level, shots)`. The end is after the last shot; the unused rack is `rack - shots`. Replays need no bank record.
- `keystone.autobank=1` ends the level at the first settle where the objective is met (Keystone's behaviour), for levels or players that want it.
- Quickdraw (firing while a shot is still running) stays off: per-shot attribution and the settle baseline need settled shots. It is an option (`keystone.quickdraw=1`) for a later playtest, unofficial until its rules are specified.

## 6. Score tally and stars

### Tally (outcome levels)

```
Objective   +1000 if met
Collapse    floor(3000 x D)
Leverage    floor(300 x log2(1 + L))
Combo       50 x T(min(C_max, 12)),  T(n) = n(n+1)/2   (C_max = most crowns down in one shot; levels with crowns)
Rack left   +400 x unused items                        (only if the objective is met)
Heritage    -500 x broken
Footprint   -floor(3000 x max(0, f_out - footprintMax)) (levels with a footprint limit)
```

The weights make collapse the dominant line on big levels, keep leverage as the "clever beats strong" line from the design, and make banking early worth about one more 13%-collapse shot. They are constants in one table (`OUTCOME_WEIGHTS`) and re-fit after the playtest, not per level.

### Stars

- **Star metric.** Each outcome level names one: `collapse` (D, default), `crowns` (crowns down), `skyline` (end height over start height, lower is better) or `score` (the tally total). `keystone.stars=<metric>` overrides it; thresholds that were not cast for that metric show as "uncast".
- One star: the objective met. Two stars: metric at least T2. Three stars: metric at least T3, and no heritage broken.
- **Beat the bot** (a badge, the successor of the Ace): metric above the best value any bot play reached when the level was cast.
- **Official runs.** Stars and personal bests are kept only when the level, its physics block and the engine kind are the ones the thresholds were cast with (the level hash, section 8). Any override of physics, rack or star metric plays fine and is labelled "custom: stars not recorded".

### Casting thresholds (the bot)

`pnpm keystone:cast <level> --engine gpu` (browser runner, Metal on the Mac; the reference engine for chamber levels):

1. **Competent plays.** N_r = 64 lines. Each shot picks a rack item in order and aims with `aimAt` at a structure surface point drawn from a seeded stratified sample (azimuth, height third, face), power 60 to 100%. Every line fires the whole rack. Record the metric after every settle, so banking at each point is also a sample.
2. **Best line.** Hill-climb the 3 best competent lines by one-quantum moves (16 moves each), keeping the line whose 8-nudge mini-cloud has the highest lower quartile.
3. **Nudge cloud.** 50 perturbations of the best line, each shot jittered within the design's hand noise (yaw plus or minus 0.6 degrees, power plus or minus 3%), seeded.
4. **Thresholds.** T2 = median of the competent plays' end metrics (a typical attempt). T3 = lower quartile of the nudge cloud (three in four near-best plays earn it, as lGold today). Both rounded toward easier to 2 significant figures. Beat-the-bot = maximum seen.
5. **Write back.** `stars: { metric, t2, t3, best, castOn: <adapter>, engine, hash, n, seed }` into the level, plus the cloud summary (P10, P25, P50, P75, P90 of both clouds) in `docs/game/levels/<id>.md`.

**Gates.** A level ships only if all hold; otherwise it is redesigned:

| Gate | Rule | Why |
|---|---|---|
| Fair | the best line meets the objective in at least 80% of its nudge cloud | the old par-robustness bar, applied to the objective |
| Skill matters | T3 - T2 at least 10% of the metric's range (0.1 for D) | if aiming does not beat a typical attempt, stars are noise |
| Stable | casting again with another seed moves T3 by less than its bootstrap 90% interval half-width, and that half-width is under 0.05 D | thresholds are a property of the level, not of the draw |
| Cross-device | on one 1k level, T3 cast on SwiftShader (smaller N) lies inside Metal's bootstrap 90% interval | statistical fairness across devices, the reason for casting |
| Budget | a cast takes at most 60 min on the M5 at 10k | casts run on idle Mac time (overnight batches) |

Cast cost: about 64 + 3 x 16 x 8 + 50 = 500 line plays, each from the start, since nothing can be forked on the GPU yet. At 10k, a 3-shot line is about 3 x 600 steps; at the estimated 10 ms a step (40 it; F2 will measure) that is 18 s a line, so the full recipe is about 2.5 h, over budget. Two levers, in order: cut the hill-climb to 2 lines x 8 moves x 4 nudges (N about 180, about 55 min), and the GPU fork engine ask below. The budget gate decides which recipe a level uses; the recipe is recorded with the thresholds.

**Engine ask (new, optional): GPU fork.** `GpuAvbdEngine.fork()`: a device-side copy of every state buffer into a second engine of the same capacity, so a bot can branch shared prefixes (as `SessionCache` does on the reference) bit-identically. It would cut cast time 2 to 3x. Proof: fork at step k, run both copies and an unforked run 300 steps, all three hashes equal on SwiftShader and Metal. Not needed for the slice.

## 7. The rack

| Item | Shot text name | Body | Energy fired | Status |
|---|---|---|---|---|
| Keystone ammo: marble, cannonball, cue, drop | `marble` etc. (unchanged) | as today | launch KE / `m g y` | exists |
| Real projectiles: beach ball, basketball, bowling ball, cannonball, wrecking ball, boulder | `p-<preset>`, e.g. `p-wreckingball` | `PROJECTILE_PRESETS`: real diameter and restitution; density converted at the level's model scale (625 = real stone 2400, so x 0.26) | launch KE | presets exist; rack entry is G3 |
| Grenade | `w-grenade` | the grenade shell; fuse and blast from the level's `weapons.grenade` (else `DEFAULT_GRENADE`); consumed after F4 | launch KE + nominal yield | logic exists; rack entry is G3 |
| Scripted weapon | `w-<name>` | the level's `weapons[name]` `WeaponSpec` (viewer cube units, scaled to the level's commonest block: arsenal.ts `cubeScale`); `w-firework`, `w-cluster` built in | launch KE + static yield budget | G3.4 |

- **Shots.** Every launched item uses `LaunchShot`'s quantised fields (azimuth, height, yaw, pitch, power); only the name changes, so shot text stays a few bytes (`p-wreckingball.60.8.0.20.95_w-grenade.120.4.0.35.80`). Bare names keep parsing as today. Power maps to 50 to 100% of a preset's own speed, capped by `launchSpeedCap`; the grenade's shell speed range is part of its spec.
- **Rack size.** `MAX_RACK` goes from 6 to 8 for outcome levels; keys 1 to 8 pick.
- **Validator rules per item** (`validateLevel`):
  - `tunnelling`: today's rule with the item's real top speed and size.
  - `mass-ratio`: item mass over the lightest structure body at most `limits.ammoRatio` (default 20, as the design). A level may raise it to 100 only with a passing heavy-ball probe (the item at top speed into one block on the ground: the block sinks under 0.1 h and nothing goes NaN), the E4 weakness in test form.
  - `dud` (warning): the most energy one head-on hit can pass, `KE x 4 mu / (1 + mu)^2` with mu the mass ratio, is under the energy to tip one plain block on its edge (`0.207 m g h`). A dud is legal (a beach ball can be a joke item) but the panel says so.
  - `capacity`: engine capacity = structure bodies + the sum of each item's body budget (1 for a thrown thing; a `WeaponSpec`'s static budget).
- **What the physics says about real projectiles at Keystone scale.** Against a 0.5 m plaster block (31 kg model): beach ball 0.002x its mass, basketball 0.005x, bowling ball 0.06x, real cannonball 0.09x, Keystone cannonball 16x, wrecking ball 25x (10x stone), boulder 3,500x. So the beach ball, basketball and bowling ball are duds against plaster (the bowling ball can pass at most 29 J of its 136 J; tipping a block takes 32 J) and only matter in toy-scale levels (Kapla, cardboard); the real cannonball is not a dud (about 800 J passed at 45 m/s); the wrecking ball fits stone levels; and the boulder fails `mass-ratio` everywhere unless a probe passes: it is a finale item, not a slice item. Level material and rack are chosen together.
- **Ask to V3 (`WeaponSpec`).** The validator must give, statically, each spec's body budget (for capacity) and nominal energy (launch KE plus yield of every reachable action, children included) so the rack can score it. A spec'd grenade must replay bit-equal to the built-in grenade on the reference (V3's own proof), so `w-grenade` can move onto the language without breaking replays.

## 8. Structure sizes and physics settings

### Tiers

| Tier | Bodies | Levels | Scoring | Engine |
|---|---|---|---|---|
| Chamber | 40 to 400 | L1 to L5 | par (unchanged) | GPU, Rapier, reference |
| Hall | 1k to 3k | slice level B1 (onboarding spectacle) | outcome | GPU (Rapier for comparison) |
| City | 5k to 10k | slice levels B2, B3 | outcome | GPU |
| Mega | 30k to 100k | after E2, E3, E6 | outcome | GPU with sleep |

`MAX_BODIES` becomes per engine (`ENGINE_MAX_BODIES`): Rapier 2,500 (unchanged), GPU 10,000 for the slice (raised by E2). Validator issue `count` names the engine.

### Per-level physics block

```
physics?: {
  iterations?: number        // default 40 (Keystone's AVBD_ITERATIONS)
  gapSlop?: number           // default 3e-5
  bounce?: number | null     // restitution e for structure bodies with the engine's restitution on; null = off (default)
  pairsPerBody?: number      // GPU pair buffer; default from F1's sizing rule
  presettle?: number         // default 300 steps
  settle?: 'v1' | 'v2' | 'v3'  // default v1 for par levels, v3 for outcome levels (v2 before settle v3)
}
```

The block is part of the level hash, so stars cast at one setting are never shown against another (section 6, official runs). Substeps stay 1: Keystone levels are in metres at h = 0.5 m and every pinned line was made that way. Unit h stays 0.5 m for continuity (a 1 m cube variant is the same cost at one substep and is a per-level choice).

**Choosing a big level's settings** (recorded in `docs/game/levels/<id>.md` with the numbers):

1. Iterations: the lower of 20 and 40 at which the structure passes F3's rest test (3,600 idle steps, no body drifts 0.05 h) and the best line's objective rate at 20 is inside the 40-iteration rate's 90% interval. Otherwise 40.
2. Bounce: off until E4 lands. Then e in [0.3, 0.5] (Q2), the value whose nudge cloud has the widest skill gap (T3 - T2), recast.
3. Budget on the M5 (G4's bench): live step p95 at most 11 ms at the chosen settings (16.7 ms at 60 Hz minus the photoreal frame cap of 3 ms minus headroom). Over budget: drop to 20 iterations if rule 1 allows, else shrink the structure, else declare the level's slow motion (the valve, section 9) and say so in its notes.
4. No limit hit: `health()` reports no pair, contact or colour overflow in any cast play (F1).

| Level type | iterations | gapSlop | bounce | Notes |
|---|---|---|---|---|
| Chamber (L1 to L5) | 40 | 3e-5 | off | unchanged; par lines pinned here |
| Hall, City (before E4) | 20 or 40 by rule 1 | 3e-5 | off | most likely 40 at 10k (estimate about 10 ms/step) |
| Hall, City (after E4) | as above | 3e-5 | 0.3 to 0.5 | +5 to 9% step cost on the M5 (measured for Bounce) |

## 9. Pacing at scale

- **Settle v2.** Settled at the first step at least 20 after the spawn with 30 consecutive steps where the count of awake structure bodies moving faster than `QUIET_SPEED` or spinning faster than `QUIET_SPIN` (`nMoving`, a new integer reduction) is at most `max(2, floor(n / 1000))`, or at the cap: 600 steps (Chamber), 1,800 (Hall and City, 30 s). v1 is today's rule; chamber levels keep it, so every par line settles on the same step as before.
- **Valve.** Today's awake-adaptive valve (`Pacer`, `budgetMs` 10, `stepMs` median of 60) stays; G4 feeds it the GPU's pipelined step time and adds a HUD tag ("x0.6") while it slows time, so overload reads as intended slow motion, never stutter. Hit-stop and the crown slow motion stay off by default (`keystone.hitstop=1`, `keystone.slowmo=1`).
- **Tail skip.** Once `nMoving` is under 1% of the structure and collapse has gained under 0.1% over 60 steps, the pacer runs at the fast-forward rate until settle (`keystone.tailskip=0` turns it off). It changes when steps run, never which steps run, so replays are unchanged.
- **Camera.** Follows the collapse front: a new reduction `movingBox` (the AABB of moving structure bodies, every 4 steps), framed by the existing critically damped spring with 20% padding; grabbing orbit always takes over.
- **Sound.** The impacts histogram already feeds juice; G6 swaps the synth for `@tb/audio`'s collapse engine (8 loudest voices plus the resonator bank), whose cost does not grow with N.

## 10. Options (URL key, Scene panel, scene file)

Every rule above is switchable. The viewer under `rules=keystone` reads them through `@tb/game` `params.ts` (one parser for both pages).

| Key | Values (default first) | Effect |
|---|---|---|
| `keystone.scoring` | level's own, `par`, `outcome` | scorer; overriding marks the run custom |
| `keystone.stars` | level's own, `collapse`, `crowns`, `skyline`, `score` | star metric |
| `keystone.autobank` | `0`, `1` | end at first clear |
| `keystone.quickdraw` | `0`, `1` | fire while running (custom) |
| `keystone.tailskip` | `1`, `0` | fast-forward the tail |
| `keystone.settle` | level's own, `v1`, `v2` | settle rule (custom) |
| `keystone.rack` | level's own, comma list of item names | rack override (custom) |
| `keystone.iterations`, `keystone.gapSlop`, `bounce` | level's own | physics override (custom) |
| `scenario=<S>&rules=keystone` | | any scenario as a level: no roles, objective `collapse` 0.3, stars uncast, rack from `keystone.rack` (default `cannonball,cannonball,w-grenade`) |
| scene file | `keystone: { scoring, stars, autobank, ... }`, `scene.levelDef` with scenario parts | the same, saved |

## 11. Vertical slice plan

Each row is one PR with its tests, `pnpm check` green, merged on green CI. Proofs name the test files they add.

### G2: rules on any scene (needs G1)

| Step | Content | Proof |
|---|---|---|
| G2.1 | Outcome measures in `@tb/keystone`: PE_floor, D, `nMoving`, `movingBox`, `outcomeScore`, star evaluation; `scoring` field (default `par`) | `keystone/test/outcome.test.ts`: D is 0 for the settled level and 1 for a synthetic all-flat snapshot, monotone in each body's height, equal under any body order; tally lines on a table of cases; mutants of each weight and threshold comparison fail a case. Every par test unchanged. |
| G2.2 | Banking and end of level for outcome levels (`Session`), `autobank`; game HUD: tally v2, Bank button, objective check | `keystone/test/session.test.ts` new cases: bank refused while running, bank after a settle ends with the right rack-left line, rack empty ends, autobank ends at first clear; `game/test/e2e.test.ts` case on Rapier: one shot, bank, tally shown. |
| G2.3 | Scenario parts: `{ kind: 'scenario', id, params, seed, at, material, roles: RoleRule[] }` compiled to bodies at the level's pitch; role selectors by box, course, top of column and scenario tag | `keystone/test/scenario-part.test.ts`: S3, S4, S14 bodies equal the scenario's positions times the pitch, in order; each selector picks the expected ids; the level hash changes with params and seed. |
| G2.4 | `validateLevel` at scale: the O(n^2) support pass becomes a spatial hash; `count` per engine; `watched`, `flat` issues | `keystone/test/level-scale.test.ts`: the old and new validator give the same issues on L1 to L5 and 200 random small levels (property test); a 10k S4 level validates in under 2 s. |
| G2.5 | Physics block in `LevelDef` (hash), engines built from it (`gpuOptions`, restitution, pairsPerBody); custom-run label | `game/test/engines.test.ts`: each field reaches the engine options; the hash changes with each field; an override marks the session custom and records no stars. |
| G2.6 | Viewer: `scenario=...&rules=keystone` auto level, roles and objective in the panel | `viewer/test/rules.test.ts` cases; e2e (GPU, SwiftShader): a 10k S4 auto level loads under `rules=keystone`, a cannonball scores D > 0, no limit hit. |
| G2.7 | Cast tool v0 on the reference for chamber levels: `pnpm keystone:cast L1`, outcome stars for L1 to L5 as a dry run of the machinery | `keystone-lab/test/cast.test.ts`: quantiles exact on known samples, rounding toward easier, T2 <= T3 enforced, same seed same thresholds. |

**As built (G2.1 to G2.6, 2026-11-01).** Where the code differs from the plan above, or settled something the plan left open:

- **Outcome measures (G2.1, `keystone/src/outcome.ts`).** PE_floor puts each body flat on its largest face (centre height = its smallest half-extent); D = clamp((PE0 - PEend) / (PE0 - PEfloor), 0, 1) in integer mJ, PE0 taken after the pre-settle. `skylineRatio` falls back to 1 when the start skyline is 0 (tiny levels).
- **Banking (G2.2).** `Session.canBank()` / `bank(step)` and `Driver.bank()`; a par level refuses with "a par level ends at its clear". `playShots` and `PlayOptions.bank` bank when the shots run out on an outcome level, so a recorded session is still (level, shots). Game: Bank button and key B.
- **Scenario parts (G2.3, `keystone/src/scenario-part.ts`).** Positions are the scenario's times h, horizontal ones times the pitch (1 + gap); `gap: 0` keeps a Kapla tower's exact layout. The scenario's own inputs (S15's topple ball) are dropped. The level hash adds an FNV-1a digest of every body's pose and size, so a change to a scenario's builder is a new level; params at the scenario's defaults, seed 1 and key order hash as absent (`scenarioKey`).
- **Validator at scale (G2.4).** A uniform grid (cell = median body extent, bodies in every cell they touch, a pair reported once from the cell holding its intersection's low corner) replaces the x sweep and the all-pairs support pass. Measured in this container: 10k S4 270 ms (old 1,777 ms). `count` checks `ENGINE_MAX_BODIES` (Rapier 2,500, GPU 10,000; `defaultEngineOf`: outcome levels the GPU, par levels Rapier). G3's `capacity` (structure plus what the rack can add) applies to Rapier only: the GPU engine sizes its buffers per level (`gpuOptions`), so its budget is the structure's solver bar. `MAX_BODIES` is gone. New issues `watched` (crowns plus heritage over 64) and `flat` (the structure holds less than one common block falling 1 h above lying flat). Every automatic scenario level within budget validates clean except the stress scenes (S6 and S7 at 20k, S8's 80x mass ratios, S11 to S13's deliberate overlaps and overhangs); default S15 is 10,004 planks, 4 over the GPU budget (`param.planks=9996` fits).
- **Physics block (G2.5).** `PHYSICS_DEFAULTS` = 40 iterations, gapSlop 3e-5, Bounce off, presettle 300; fields at their defaults hash as absent. `settle` is not in the block yet (G4 adds settle v2). Bounce sets restitution on structure bodies and the ground and turns the GPU engine's restitution on; `pairsPerBody` reaches `GpuEngineOptions`; the driver pre-settles for the level's own count. Stars carry an optional `hash` and `engine`: cast stars apply only when the run is not custom and the hash matches (`castStars`); stars cast on another engine mark the run custom (`onEngine`).
- **Viewer (G2.6).** `?scenario=<S>&rules=keystone` plays `scenarioLevel(S, params, seed)`: one scenario part, no roles, objective collapse 0.3, par and rack = two cannonballs and the built-in grenade, lot = footprint grown by 2 cells, launcher ring 4 cells outside the footprint's half-diagonal, plaster. Scale 1 and presettle 300 are the defaults under the rules (the scenario's own scale is a sandbox setting). The URL and scene-file overrides are `keystone.scoring`, `keystone.autobank`, `keystone.iterations`, `keystone.gapSlop`, `keystone.bounce` (`off` = null) on both pages; any of them marks the run custom ("custom: stars not recorded"). `keystone.rack` is G3's (game page; the viewer does not read it yet). `keystone.stars`, `quickdraw`, `tailskip`, `settle` are not built. Roles on a scenario come from a level file's scenario part (`roles` selectors), not the panel. Under the rules the viewer reads the game engine's `health()` at each load and settled shot and every 500 ms; `keystone.presettle` is a URL override too.
- **The 10k proof (G2.6) is split by what SwiftShader can run.** A step of the 10k S4 city costs about 4.7 s on SwiftShader at 40 iterations (1.9 s at 10, 1.3 s at 4; measured in a cloud container), so a default-settings session (300 pre-settle steps, then a settle) takes about an hour there. CI runs: the 10k automatic level validates clean and the aim reaches it (`e2e-keystone-10k.test.ts`, node); the 10k level loads on the GPU solver with `keystone.presettle=0`, a cannonball flies into it, no limit hit (smoke); and a 50-cube S3 wall at the game's full settings, shot, settled, banked and scored on the outcome, replayed bit for bit (`e2e-keystone-scenario.test.ts`). The full-settings 10k case (settle, bank, score, step times logged) runs with `TB_CHANNEL=chrome` on a real GPU (Metal on a Mac) or `PHYSICS_GPU_SLOW=1`. Lowering the iterations would not make a CI scoring case honest: at 4 iterations the unsettled city sags by itself (D 0.036 after 20 steps with or without a hit).
- **G2.7 (cast tool) is not built here:** star casting is bot work and was kept out of this slice; outcome levels play uncast until it lands.

### G3: weapons in the rack (needs G1; F4 soft; G3.4 needs V3)

| Step | Content | Proof |
|---|---|---|
| G3.1 | `RackItem` names (`p-`, `w-`), shot text, model-scale density conversion, validator rules `mass-ratio`, `dud`, `tunnelling`, `capacity` per item; `MAX_RACK` 8 | `keystone/test/shots.test.ts`: round trips for every item, old lines parse unchanged; `keystone/test/level.test.ts`: each issue fires on a crafted level and not on its fixed twin. |
| G3.2 | Real projectiles fire from the rack | `game/test/rack-presets.test.ts` (Rapier and GPU): each preset spawns at its converted mass and capped speed; a line with presets replays to the same hash with `driverOptions(kind)` on the same device. |
| G3.3 | Grenade in the rack through `PlayOptions.perStep`; nominal yield in E_fired | `weapons/test/yield.test.ts`: Y within 3% of a discrete sum over a resting lattice of cubes for radius at least 4 h, Y scales as radius cubed where `maxDv` binds everywhere, zero impulse gives zero; `game/test/rack-grenade.test.ts`: a grenade line replays bit-equal on GPU (same device) and on the reference; leverage uses Y. |
| G3.4 | `WeaponSpec` items from the level's `weapons` (after V3) | the spec'd grenade line equals the `w-grenade` line bit for bit on the reference; budget and energy come from V3's validator. |

### G4: pacing at scale (needs F2)

| Step | Content | Proof |
|---|---|---|
| G4.1 | Settle v2 and the per-tier cap | `keystone/test/rules.test.ts`: synthetic reductions settle with k stragglers at the allowance and not at allowance + 1; v1 unchanged; par tests settle on the same steps. |
| G4.2 | Valve on GPU step time, HUD tag, tail skip | `game/test/pacing.test.ts`: time scale equals budget / step time clamped to [0.25, 1]; tail skip never changes the steps a session runs (same hash with and without). |
| G4.3 | Collapse-front camera from `movingBox` | `game/test/camera.test.ts`: the frame contains every moving body and eases back at settle; renders reviewed. |
| G4.4 | Metal pacing bench at 10k (Mac idle) | a bench file in project files: frame p95 at most 33 ms, physics at least 0.95x real time at 60 Hz at each slice level's settings, or the level's declared slow motion. |

**As built (G4.1, 2026-11-01).** Where the code differs from the plan above:

- **Where the rule lives.** `settle` is a top-level `LevelDef` field beside `scoring` and `autobank`, not in the physics block: it is a rule (when a shot ends), not an engine setting, and its default depends on the scoring. `settleOf(def)`: the level's own, else v1 for par scoring and v2 for outcome scoring. The scoring's own rule hashes as absent, so every level hashes as before; the other rule is a different level (custom from the URL: `keystone.settle`, scene file `rules.settle`, level file `settle`).
- **v2 also waits for live spawned bodies** (`Reductions.ammoSpeed`, the fastest awake spawned body that `ammoLive` keeps, under `QUIET_SPEED`). Without it a long shot still in flight at `SETTLE_MIN + SETTLE_QUIET` steps would settle with the ball in the air: a ball moves no structure body until it lands. Spin is not counted for spawned bodies, as in v1.
- **Caps.** v1 `SETTLE_CAP` 600 as before; v2 `SETTLE_CAP_V2` 1,800, which also bounds a pending weapon's hold. The cap is per rule, not per size tier: chamber levels play v1 and hall and city levels v2, so the two coincide; a level wanting the other cap picks the other rule.
- **Tests.** `keystone/test/rules.test.ts` (allowance table; k stragglers at the allowance settle and k + 1 never do, at 50, 2,500 and 10,000 bodies; a step over the allowance restarts the quiet run; live ammo holds v2; caps; v1 and v2 disagree on crafted states in both directions; each of five mutants of the rule fails a case) and `session.test.ts` (defaults by scoring; a lone creeping block holds v1 to 600 while v2 lets it go after the quiet run; a pending weapon holds v2 to 1,800; hashes). Par tests are unchanged: they play v1.
- **Probe.** `viewer/test/e2e-pacing-probe.test.ts` (real GPU only, `TB_CHANNEL=chrome`; `TB_PROBE_SMALL=1` checks it on tiny scenes on SwiftShader) traces `nMoving`, step and frame times after a cannonball into the 10k S4 city and a grenade into the 10k S14 blocks, at 40 and 20 iterations, so v2's allowance is checked against Metal before big levels rely on it. The game handle now records `timing.moving` (nMoving per live step) and `timing.frameMs` (frame intervals while a shot runs).

**As built (G4.2, 2026-11-01).**

- **Physics runs apart from the frames** (`game/src/physics-loop.ts` `runPhysics`). Before, each frame ran its steps and awaited them before drawing, so a frame was never shorter than its steps: at 10k a grenade's 18 ms GPU steps made frames alternate between about 25 and 8 ms on a 120 Hz display, and the valve could only trade that for fewer steps. Now physics steps whenever the `Pacer` says one is due and the frames draw on their own, interpolating between the two newest snapshots by when they arrived (`arrivals.ts`, moved from the viewer's `loop.ts`, where loop=free has paced this way since #44). A CPU engine (Rapier) still steps on the main thread, with a task boundary after each step. Alternatives: keeping one step per frame (even frames, but the GPU idles while the CPU waits, about 0.67x real time at 18 ms steps); a worker with its own device (the snapshot already comes back through the CPU, but the two devices share one GPU, and the render loop would need the state twice). Measured on SwiftShader (`game/test/pacing-gpu.test.ts`): with L1's steps at 94 ms, frames came every 16.7 ms (median), where each frame used to wait for its step.
- **The valve reads the true step cost.** `Pacer` is time-based (`due(now)`, `stepped()`), with time scale = `valve(budget, cost)` = budget / cost clamped to [0.25, 1] (up to 4 at fast-forward). For the GPU the cost is from when a step could start (the later of its submit and the step before's done) to its `finish()` (`stepCost`, as the viewer times steps): timing `driver.step()` alone reads about 0.2 ms once the valve has spaced the steps out, and the valve would open and shut every few steps. Default budget `DEFAULT_BUDGET_MS` 14 ms per 1/60 s (16.7 less about 3 ms for the frames drawn meanwhile, the photoreal cap at 10k); G4.4 compares 14, 16.7 and off on Metal. The old frame loop's budgets (10, and 14 once the round was over) are gone.
- **Declared slow motion.** `SpeedMeter` measures sim time per real time from the steps as they complete (0.5 s exponential window); below 0.95 the HUD title shows the speed (`slowTag`, "×0.78"), except at fast-forward, the round-over tally and the tail skip. `GameHandle.pace` exposes time scale, speed, tag, tail skip and the median cost; `timing.costMs` every cost.
- **A step in flight is not done.** A step that settles a shot leaves the session aiming while the pipelined driver still awaits its last read; the frames, which no longer wait for steps, could show the game ready there and let a shot or a bank in one read early (`e2e-keystone-scenario.test.ts` caught it: the live and replayed poses differed at the same step). While a step runs the handle reads `running`, not ready, and `fire` and `bank` refuse.
- **Tail skip** (`TailSkip`): once under 1% of the structure moves and D gained under 0.001 over the last 60 steps, the rest of the shot runs at fast-forward, until the next shot. It applies to par levels too (pacing only).
- **Switches.** `keystone.budget` (ms, 0 = no valve), `keystone.tailskip` (1, 0), with hit-stop and slow motion in `PaceFeel` (`paceFeel` / `writePaceFeel`), on both pages, in the viewer's scene file (`rules.budget`, `rules.tailskip`) and its Scene panel. None is part of a level: they change when steps run, never which.
- **Tests.** `game/test/physics-loop.test.ts` runs `runPhysics` on a fake clock for 10 s per case: a GPU-like engine at 3 to 100 ms a step reaches min(valve(14, cost), dt / cost) within 3%; its cost reads 18 ms whether queued or spaced; a ±30% spread of costs settles on the median's scale; 60 and 144 Hz displays; a CPU engine padded by `@tb/bench` `SlowedEngine` follows the same rule; fast-forward reaches budget / cost; nothing is owed after an idle second. `pacing.test.ts` covers the valve, the clock (hit-stop, slow motion, catch-up and lag), the meter, the tag, the tail skip and the URL keys. The par line still replays bit-equal through the viewer (`e2e-keystone.test.ts`).

**As built (G4.3, 2026-11-01).**

- **The follow camera** (`game/src/follow.ts` `FollowCam`). At fire it remembers the orbit's target and distance; each frame while the shot runs and at least 8 structure bodies move (`FOLLOW_MIN_MOVING`), it heads for a frame of `Reductions.movingBox` grown 20% each side (at least 8 cube edges across), framed as the viewer frames a scene (render `camera.ts` `frame`, fit 1) at the player's own yaw, pitch and field of view, which it never changes. The distance stays within 0.6 to 1.6 times the distance fired from. The moving box is cut to the play area first (the lot plus 4 edges, up to 1.5 times the structure's height), so a few bodies flung far off do not drag the frame after them. Once the shot is over it eases back and lands exactly on the view fired from, so the next aim starts where the player left it.
- **The spring** is a critically damped spring at rate 3/s in its exact closed form (`spring`), so it is the same at 30, 60 or 144 Hz and never overshoots: within 1% of a jump 2.3 s later. The spec planned to reuse an existing spring; there was none in the repo (the camera shake in `juice.ts` decays, it does not track a goal).
- **The box every step, not every 4.** `movingBox` comes from the same reduction pass as `nMoving` (G4.1), already computed each step on the CPU snapshot, so there was nothing to save by sampling it.
- **The player wins.** A drag of 5 px or more (orbit or pan) or a wheel turn during the shot hands the camera to the player for the rest of that shot: no follow and no ease back. A load or retry resets it.
- **Switch.** `keystone.follow` (1, 0; on by default), in `PaceFeel` with the other pace switches, on both pages, in the viewer's scene file (`rules.follow`) and its Scene panel. Render only: it changes no step.
- **Alternatives.** Moving yaw or pitch too (rejected: the player aims with them, and a turning camera under the cursor moves the aim); following the centroid of the moving bodies instead of their box (rejected: a collapse that spreads one way keeps its leading edge out of frame); cutting the box to a percentile of the moving bodies (better against strays, but needs a sort per step; the play-area cut does the job at no cost).
- **Tests.** `game/test/camera.test.ts`: the spring (no overshoot, 1% by 2.3 s at 30, 60 and 144 Hz, exact over any dt), the goal holds every corner of the padded box in view, the cut to the play area, follow then ease back exactly home, too little moving stays home, a grab ends it, no NaN from a bad box. `game/test/follow-e2e.test.ts` on the page (Rapier, L1): the camera moves during the par shot, never more than 10% of its distance in a frame, and lands back exactly; a wheel turn during the shot leaves the camera zoomed in; with `keystone.follow=0` it never moves. Each of three mutants of the wiring (follow ignoring the switch, no grab on the wheel, following after the shot) fails one of these. Renders were reviewed from the G4.4 Metal run's screenshots (see G4.4).

**As built (G4.4, 2026-11-01): Metal pacing bench.** `viewer/test/e2e-pacing-probe.test.ts` on the M5 Max (installed Chrome, Metal, Mac idle), before G4.2 at 74b57c2 and after G4.3 at 6d4b40f. Files `g4-probe-74b57c2.*` and `g4-probe-6d4b40f.*` (log, tar of JSONs, `-summary.txt`, screenshots) in project files. Headless Chrome draws at 60 Hz, so a 120 Hz display is not covered.

| Case (10k, 40 iterations) | Step cost, median / p95 | Frames, median / p95 / p99 / max (ms) | Sim speed, median | Within G4.4 |
|---|---|---|---|---|
| grenade on 25 block towers, before G4.2 | not measured | 16.7 / 19.7 / 30.0 / 44.5 | not measured | yes, but frames uneven |
| the same, after | 16.1 / 17.4 | 16.6 / 18.3 / 18.6 / 20.9 | 0.86, tagged | yes |
| cluster on the towers, budget 14 ms | 20.1 / 22.4 | 16.7 / 18.3 / 18.7 / 28.2 | 0.70, tagged | yes (declared slow motion) |
| the same, budget 16.7 ms | 19.1 / 22.6 | 16.7 / 18.1 / 18.6 / 27.4 | 0.82, tagged | yes (declared) |
| the same, no valve | 19.2 / 22.8 | 16.7 / 18.2 / 18.6 / 25.7 | 0.81, tagged | yes (declared) |
| cluster on the city (S4), budget 14 ms | 21.7 / 24.5 | 16.8 / 18.4 / 18.7 / 30.4 | 0.64, tagged | yes (declared) |

- **Frames.** Every rendered case holds 60 Hz: p99 under 19 ms, at most 2 frames in about 1,700 over 25 ms. The worst frame before G4.2 was 44.5 ms. The physics cost at 10k under a heavy blast (19 to 22 ms a step, so at most 0.8x real time on its own) does not reach the frames.
- **Budget default now 16.7 ms** (`DEFAULT_BUDGET_MS`, was 14). Holding 3 ms back for the frames bought nothing: frames were the same at 14 ms, 16.7 ms and off, while 14 ms slowed the sim to 0.70x against 0.82x. At a whole step the valve slows time only as far as the GPU must, and the HUD declares it. The probe's budget cases are now 16.7 (the default), 14 and off.
- **Physics at least 0.95x real time** is not met at 10k under a heavy blast on M5 (0.64 to 0.86x). So the G4.4 row passes on its other branch, declared slow motion: the HUD carried the tag in 84 to 96% of the samples while the cluster shots ran (the rest: the first moments, before the speed meter falls under 0.95, and the tail skip's fast-forward). Reaching real time takes fewer steps' worth of work, which is the sleep and dormancy work (E1 to E4), not pacing.
- **Lowering iterations while most bodies are awake: not adopted.** At 20 iterations a 10k step costs 9.7 ms against 18.1 ms. But the 10k city falls apart at rest: after one cannonball it hits the 1,800-step cap, still with 734 bodies moving, and collapse 0.027 against 0.015 at 40 iterations. That fails the rest gate (F3), and the Kapla study found the same (10 iterations collapses). Nothing switches iterations during a shot.
- **The camera, reviewed from the screenshot case.** It frames the spreading collapse well, and the "×0.64" tag reads clearly in the title. The tail showed one fault: with only the last few stragglers moving, the frame shrank onto them and the camera dived in on a corner of rubble. The frame now holds every moving box seen since fire together, so it grows with the collapse and never shrinks during a shot (`camera.test.ts`: "does not dive in on the last stragglers", which fails without the change).

**As built (settle v3, 2026-11-01).** G5's first Metal explore runs (at 74b57c2) hit v2's 1,800-step cap on most B1 shots, a 1,000-block plaster wall, even with bombs only. A step-by-step trace of B1a's first competent line on SwiftShader (shot 1: a ram) showed the cause. The ram was not it: it left the lot plus 4 cells 150 steps after launch and stopped counting. (It rolls on at a constant 2.85 m/s: the engines have no rolling resistance.) The wall was: from step 360 to the cap, 50 to 230 blocks high in the standing wall (median 17 to 20 cells up) moved at 0.1 to 0.3 m/s, mostly sideways. Yet their median displacement stayed 0.1 cell, and D held at 0.0694 from step 360 to 1,800, ending at 0.0696. The wall rings: blocks sway a few centimetres while nothing changes. The count of such bodies says nothing about whether the shot is over.

- **v3, outcome levels' new default** (`rules.ts`): settled as v2 (stragglers within the allowance for 30 steps), or once the structure is frozen. Frozen means: for `FROZEN_STEPS` 60 steps, no live body, ammo included, faster than `FROZEN_SPEED` 0.5 m/s, and D within `FROZEN_D` 1e-4 and the displaced count unchanged since the run began. Any fall passes 0.5 m/s within 0.05 s, so a collapse still under way never counts as frozen. v3 settles no later than v2 anywhere, and the cap stays 1,800. Replayed under v3 on SwiftShader, that line's three shots (ram, ram, bomb) settle in 429, 447 and 507 steps, where v2 took 1,801, 1,801 and 1,800 steps. The first shot settles with D at 0.0694, the value D held until v2's cap.
- **The hash.** Par levels' v1 and outcome levels' v2 still hash as absent, so every existing level and every explicit v2 level keeps its hash (pinned in `session.test.ts`). An outcome level under v3, now the default, hashes apart from its v2 self, so stars cast under v2 never show under v3. `keystone.settle=v1|v2|v3` picks a rule, as before.
- **Ammo in the frozen branch.** v2 holds a shot while any live spawned body exceeds `QUIET_SPEED`, and a ball with no rolling resistance can roll on inside the lot. In the same trace, shot 2's ram rolled at 9 cm/s for 15 s after D stopped changing. In v3's frozen branch, ammo is just another body: under 0.5 m/s with nothing changing, the shot is over. A ball still in flight, or rolling fast enough to matter, is over 0.5 m/s and holds the shot. Rolling resistance in the engines would be the physical fix; that is engine work and not part of this.
- **Alternatives.** Displacement over a window instead of speed: it needs a position history per body, and a slow real slide moves as far in 1 s as a sway does. A higher QUIET_SPEED: 0.3 m/s is a visible slide, and the wall rang at up to 0.3. Scaling the allowance up: 230 of 1,000 is not a few stragglers. D frozen is what the score reads, so a shot whose score can no longer change is over.
- **Tests.** `rules.test.ts` "settle v3":
  - A ringing wall settles after 60 frozen steps, where v2 holds it to the cap.
  - A fall restarts the run.
  - A slump (D gaining 1.2e-4 over a run, or falling back) or a slide (displaced growing) never counts as frozen; 9e-5 over a run does.
  - Ammo in flight holds it; a ram rolling at 9 cm/s with nothing changing does not (v2 holds it to the cap).
  - Where v2 settles, v3 settles the same.
  - Each of five mutants of the rule fails a case.

### G5: three to five big levels (needs G2, G3, G4, F1, F3; E4 soft)

| Step | Content | Proof |
|---|---|---|
| G5.1 | GPU cast runner: a browser page that plays lines offscreen and writes the cloud as JSON; Metal on the Mac, SwiftShader in CI | the same line twice gives the same hash on one device; a 1k cast on SwiftShader with N 16 completes in CI under 300 s. |
| G5.2 | Level B1 "Long Wall" (Hall) authored, settings chosen (section 8), cast, gates | `game/test/level-B1.test.ts` (SwiftShader): loads, rests 600 steps with no body moving 0.05 h, the recorded showcase line meets the objective, no limit hit; the cross-device gate runs on this level; `docs/game/levels/B1.md` holds the cloud. |
| G5.3 | Level B2 "Spare the Cathedral" (City, about 5k) | same shape of test and notes |
| G5.4 | Level B3 "Ten Thousand" (City, 10k) | same, plus the M5 budget row from G4.4 |
| G5.5 | Optional B4, B5 (below); the game page's default becomes the slice (B1 to B3), chamber levels stay at `level=L1` to `L5` | `game/test/params.test.ts`: bare URL opens B1; `level=L2` still opens L2 with par scoring. |

**As built (G5.1, cast tool, 2026-11-01).** `pnpm keystone:cast <level> [--engine gpu|ref|rapier] [--channel chrome] [--seed N] [--metric m] [--recipe short|full|C,L,M,K,N] [--out cast.json] [--md cast.md] [--compare other.json]`; `--scenario S3 --param W=50` casts an automatic level, `--level-file` a LevelDef JSON.

- **Where it plays.** `castPlay` (`@tb/keystone` cast-play.ts) plays one line from the level's start and samples every settle as if banked there (each star metric and whether the objective is met), plus the engine's limit report. The GPU player is the game's own cast page (`packages/game/cast.html`): each line on a fresh engine built by the game's `makeEngine` and `driverOptions`, so a cast plays what the game plays on that device. `ref` and `rapier` play in Node (for chamber levels and tests: the f64 reference takes about 1.06 s a step on the 1k wall at 40 iterations in a cloud container, SwiftShader 0.35 s).
- **Competent plays.** Each shot slot is stratified over 8 azimuth sectors x 3 height thirds (24 strata dealt in seeded shuffled rounds); the target is the frontmost body at that height nearest a uniform lateral line, on its face toward the launcher, aimed with `aimAt`; power uniform 60 to 100%. The bot aims at authored poses, before seeing the world.
- **Climb moves** re-aim one shot by one step of azimuth (5 deg), height (5% of the structure), lateral point (5%) or power (5%), and a line is judged by the player-worse quartile of its mini-cloud; one quantum of yaw was too small to matter at 1k-10k. **Nudges** are the design's hand noise: yaw within 0.6 deg, power within 3%, drops within a quarter cell, every shot of the line.
- **Thresholds and gates** as specified; T3 is clamped to be at least as hard as T2 (the skill gate fails instead). Range for the skill and stable gates: 1 for collapse and skyline, the crown count for crowns, the observed spread for score. Gates also report plays that hit an engine limit and plays that ran out of steps. The CLI exits 4 on a limit hit, 2 on any failed gate.
- **Proofs.** `keystone-lab/test/cast.test.ts` (synthetic player: the thresholds are the quantiles of what was played, seeded repeatability, climb acceptance, skyline as lower-is-better; a tiny cast on Rapier). `keystone-lab/test/cast-gpu.test.ts` (SwiftShader: the same line twice bit-equal, a 7-play cast end to end on a 6-cube level in about 110 s). A 1k cast does not fit CI: a 3-shot line there is about 12 min on SwiftShader, so 1k and larger casts run on Metal.

**Findings before authoring the big levels (G5, 2026-11-01).**

- **Shots from far launcher azimuths settled before they landed.** The rules count ammo as live only within 4 h of the lot (`rules.ts` `ammoLive`), and the automatic scenario level's lot was the footprint grown by 2 cells while its launcher ring sits 4 cells outside the half-diagonal. A shot fired at a long wall from its broad side flew uncounted, the quiet structure settled the shot after 50 steps, and the ball landed after the result. Fix: `validateLevel` has a `launcher` issue for outcome levels (a launcher azimuth over 4 h outside the lot); `scenarioLevel`'s lot reaches 3 cells inside the launcher ring. Par levels keep their launchers (L1's ring is outside its lot; its par line settles where it does).
- **Reach.** A big level's launcher ring is 12 to 15 m out. The cannonball (12 m/s; 14.7 m at best on flat ground) and the Keystone grenade's shell (5 to 15 m/s) cannot reach half of the targets from there, so big racks use faster things: a ram (`WeaponSpec`, a 2-cube sphere at a quarter of the block's density, 15 to 30 cubes/s), a bomb (the viewer's grenade as a `WeaponSpec` in a 15 to 50 cubes/s shell, scaled to the level's block), the wrecking ball (15 m/s) and the drop.
- **Competent aim.** Aiming at "the frontmost body along a lateral line" from a random azimuth gave grazing shots along a wall. The competent bot now picks an exposed side face (strata: 8 face sectors shared among the four directions by exposed area, so a wall's broad faces get them all, x 3 height thirds), fires from the ring point facing it (skew up to 25 deg off the normal), and fires harder (5% steps) when the drawn power cannot reach.
- **Exploration.** `pnpm keystone:cast --draft <name> --explore 16` plays 16 competent lines of a draft (keystone-lab `drafts.ts`: B1a-c wall racks, B2a-b cathedral city, B3a-c 10k cities, B4a dominoes) and reports collapse, crowns and heritage after each shot. The drafts are explored on Metal before the levels are authored; in this container a 1k play takes about 12 min on SwiftShader. On Rapier (a fast proxy, not the game's solver), a bomb at B1's 1,000-cube wall brings 27 to 43% of it down and a ram 1 to 6%.

**As built (G5.2 so far, big-level series, 2026-11-01).** `@tb/keystone` `big-levels.ts` holds the big levels (`BIG_LEVELS`) and their building blocks (`outcomeLevel`, `thirdBondWall`, `BOMB`, `RAM`, shared with the drafts so a winning draft becomes a level unchanged). `SERIES` is `[LEVELS, BIG_LEVELS]`; `levelById`, `findLevel` and `seriesOf` cover both, so `?level=B1` opens B1 on the game page and in the viewer (scene picker group "Big levels"), and a level plays on into the rest of its own series. **B1 is provisional** (1,000-cube third-bond plaster wall, three bombs, collapse 0.4): the Metal exploration decides its rack and objective before its stars are cast.

- **Proof that fits CI.** `keystone-lab/test/big-levels-gpu.test.ts` loads each big level on the cast page (the game's engine build), runs its pre-settle and then 100 steps with nothing fired (600 with `TB_CHANNEL=chrome`): no structure body moves 0.05 h, the top does not sink 0.05 h, no limit hit. B1 on SwiftShader: max move 0.0055 h, top +0.0045 h, 198 s for 300 + 150 steps. Levels over 1,000 bodies run only on a real GPU or with `PHYSICS_GPU_SLOW=1`: SwiftShader's pre-settle alone would take about 10 min at 5k and 23 min at 10k (4.7 s a step), so "clears in CI" for B2 and B3 means compile, validate and budget in CI, and rest plus the showcase line on Metal. The showcase lines replay once stars are cast (after G4's settle v2, which enters the level hash).
- **Exploration report.** A play that ran out of steps no longer carries its last settle into later shots' rows: each row counts the plays that got there (`shotSummary`). The SwiftShader smoke on B1a showed it (one play, 1,500-step cap, settled shot 1 only).
- **Rapier proxy, 8 competent plays each** (not the game's solver; Metal decides): B1b (two wrecking balls, a bomb) 1.3% then 4.6% then 35% median, so the wrecking ball is close to a dud at this wall and the bomb does the work; B1c (three bombs) 17%, 40%, 54% median, objective 0.2 met by 38%, 100%, 100%. B2a (5,184 cubes): the bomb takes 17% of the city at once and breaks heritage; the 16 crowns never all came down (best 15 of 16), so the crowns objective needs fewer crowns (the roof's middle 4) and a surgical rack. B4a: columns of loose cubes rammed along a straight row chain end to end (6 columns at spacing 4 to 6), but B4a's first domino sits at the spiral's centre behind the others (rammed along its tangent it took 9 to 20%), and a 30-column chain run inward from the edge was still falling when settle v1's 600-step cap ended the shot (6 to 8%): a domino level needs settle v2's 30 s cap and a chain that finishes inside it (about 15 columns at 1.7 s each).

**Metal exploration (G5, 2026-11-01, M5 Max, main 74b57c2 with settle v2, 16 competent plays a draft, no limit hit, none out of steps; files `g5-explore-*` in project files).** Collapse median (P10 to P90) after the last shot, and the step cost:

| Draft | Bodies | Rack | Collapse after last shot | Objective met | ms a step | Shots at the 1,800 cap |
|---|---|---|---|---|---|---|
| B1a | 1,000 | ram, ram, bomb | 0.42 (0.26 to 0.75) | 94% | 5.1 | 11, 14, 14 of 16 |
| B1b | 1,000 | wrecking ball x2, bomb | 0.58 (0.29 to 0.78) | 100% | 5.0 | 11, 15, 13 |
| B1c | 1,000 | bomb x3 | 0.70 (0.50 to 0.89) | 100% (81% after one) | 5.1 | 6, 5, 5 |
| B2a | 5,184 | bomb, ram, ram, drop | 0.30; heritage broken median 25 of 32 | 6% (16 crowns) | 13.6 | 0 |
| B2b | 5,184 | bomb x2, wrecking ball, drop | 0.36; heritage 25.5 of 32 | 0% | 13.2 | 0 |
| B3a | 10,000 | bomb x2, wrecking ball (stone, fat) | 0.42 (0.30 to 0.63) | 100% | 20.1 | 0 to 2 |
| B3b | 10,000 | same (stone, slim) | 0.47 (0.36 to 0.59) | 94% | 19.7 | 0 to 2 |
| B3c | 10,000 | bomb x2, ram (plaster, slim) | 0.57 (0.35 to 0.66) | 100% | 20.6 | 0 to 1 |

- **B1 is B1c** (three bombs, collapse 0.4). On the open wall lot, shots that leave a ball on the ground run to settle v2's 1,800-step cap in most plays (a rolling ball stays live above `QUIET_SPEED`), which also makes B1a and B1b plays 30 s a shot; reported to G4.
- **B2:** a bomb in the 5k city takes about 20% of it and breaks the cathedral, and the 16 roof crowns rarely all fall (max 16, objective met 0 to 6%). B2c (the roof's middle 4 as crowns, three rams and a drop) is next on Metal; on Rapier no competent play brought them down but three rams aimed at the tower's top did (4 of 4 after the first, heritage 0 to 2).
- **B3:** the third item (wrecking ball or ram) added nothing after two bombs. The skyline stayed 1.0 in every play (some tower always stands at full height), so the spec's skyline objective is out: B3 is judged on collapse. A 10k play costs about 52 s at 40 iterations, so the short recipe (186 plays) would take about 2.7 h against the 60 min budget; B3d and B3e (three bombs, stone, 40 and 20 iterations) measure what 20 iterations buys.

### Slice levels (proposals; the cast and the gates decide)

Ids B1 to B5 (B for big) so they never clash with scenario ids S1 to S15.


| Id | Name | Structure | Objective, stars | Rack (draft) |
|---|---|---|---|---|
| B1 | Long Wall | S3 wall 50 x 20, running bond, plaster (1,000) | collapse at least 0.4; stars on collapse | cannonball, cannonball, p-wreckingball |
| B2 | Spare the Cathedral | S14 buildings (9 towers of 4 x 4 x 12 plus taller ones, about 5k); one tower is heritage, 16 crowns on the tallest roof | crowns; stars on collapse; footprint limit | w-grenade, cannonball, cannonball, drop |
| B3 | Ten Thousand | S4 city, 10k, stone | skyline at most 40% of start; stars on collapse | w-grenade, w-grenade, p-wreckingball |
| B4 | Domino Boulevard | slender towers in a spiral (design section 6), 3k to 10k | crowns on the last tower; stars on collapse | marble, cannonball |
| B5 | Kapla Spire | S15 at a size E5 says runs in real time (likely about 3k planks) | collapse; stars on collapse | p-bowlingball, p-basketball, p-beachball (toy scale, where they are not duds) |

Level 1's job is the first-minute promise (G7 measures it): a collapse within 20 s of loading, so its first shot is pre-aimed.

## 12. Alternatives considered

- **Pinned par lines at 10k.** Rejected: per-device determinism and chaos make a pinned line unverifiable on other GPUs, and the bot cannot afford the par-robustness search at 10k. Kept for chamber levels.
- **Stars on the composite score.** Simpler, one number, and it rewards banking. Rejected as the default because "3,412 points" is not a goal a player can aim at before the first shot, while "72% down" is; `score` remains a star metric option for the playtest to compare.
- **Several per-metric thresholds per star** (collapse and leverage for three stars). More expressive, but each extra metric multiplies the cast and makes the target harder to read. Leverage lives in the tally instead.
- **Measured blast energy instead of nominal yield.** Rejected (section 4): it penalises good placement.
- **Unlimited ammo, score-attack** (Rubble Garden). The design panel scored it lowest for fun (no failure, no tension), and the rack is what makes the hybrid a game rather than the sandbox, which the viewer already is.
- **A run mode** (shuffled levels, rack as a pouch, BREAKLINE). Good second mode if the playtest shows content starvation; out of the slice.
- **Quickdraw on by default.** Rejected for v1: firing into a running collapse blurs which shot did what and has no settle baseline; it is an option for the playtest.
- **New authored part kinds for big structures instead of importing scenarios.** Rejected: scenarios already have parameters, seeds, viewer controls and Will's saved scenes; a scenario part reuses all of it, and authored blocks and slabs still work beside it.
- **Settle v2 everywhere.** Rejected: it would move the settle step of every pinned par line. Chamber levels keep v1.

## 13. Risks

| Risk | Watch | Response |
|---|---|---|
| Collapses at 10k are so chaotic that aiming does not matter | the "skill matters" gate (T3 - T2) | redesign the level around a load path (lintels, cores) the X-ray can show; fewer, heavier rack items |
| Cast too slow on the M5 | the budget gate | shorter recipe; the GPU fork ask |
| 10k at 40 iterations over the 11 ms step budget | F2, G4.4 | 20 iterations where the rest test allows; smaller City levels; declared slow motion |
| Big levels hit pair or colour limits | `health()` in every cast play | F1 sizing; `pairsPerBody` in the physics block |
| Bounce at game mass ratios drives blocks into the ground | E4's probes | Bounce stays off until E4; per-item `mass-ratio` probe |
| The thresholds feel arbitrary to players | playtest question (j) | show the bot's distribution on the result card ("better than 64% of bot plays") |

Playtest additions to the design's list (G9): **(i)** does anyone bank early, and does the rack-left line change behaviour; **(j)** can players say what the star target was after the level; **(k)** spectacle rating of B3 against B1 ("is 10k better than 1k?").

## 14. Defaults this spec proceeds on

Will said to proceed on recommended defaults; these are the new ones, each one option away from the alternative: stars on collapse fraction (not the composite score); banking on; Quickdraw off; the game page's bare URL switches to the slice once G5.5 lands, with par levels kept at `level=L1` to `L5`; real light balls only in toy-scale levels; the boulder stays out of the slice.
