# Fuse & Fold (M5): timed demolition

Status 2026-11-06. Stage 2 mode M5 of the game-modes roadmap ([modes-roadmap.md](modes-roadmap.md), section M5), built on C5's charges and plunger ([../design/charges.md](../design/charges.md)) and C11's footprint reductions ([../design/grid.md](../design/grid.md)). Will delegated the calls while away (2026-11-06 17:46Z); each one is written down here with the alternatives weighed.

## What it is

A building stands in its lot between heritage neighbours. Charges sit on its ground-storey columns. The player sets each charge's delay on a timeline (0 to 2 s, in 0.1 s steps) and presses the plunger. The level is cleared when the building comes down (its collapse at least the level's minimum), folds into its own lot (at most a few percent of its mass outside it), and touches no neighbour.

The decision is **when** each charge goes, not which: a fold level's plunger fires every charge (below, "Every charge fires").

## The physics it rests on (probe X2, extended)

X2 found order matters on slab-and-column buildings and not on solid cube blocks, and only for a felling with a long enough delay. The design search here (`pnpm keystone:fuse`, keystone-lab `fuse-search.ts`) took that further on frame buildings: columns (one rod per column per storey) under one slab per storey.

- **All at once, a frame drops one storey and stands.** Cutting every ground column together drops the building onto the ground a storey lower; it does not crumble. Collapse 0.17 to 0.29 across 2x2 to 4x3 frames of 5 to 9 storeys, rubble within the footprint.
- **A sweep fells it.** Fire the row furthest one way first and the rest after a delay: the building tips onto its far columns and falls that way. Collapse 0.8 to 0.9, the rubble reaching about 1.5 times the building's height from it.
- **The delay has a threshold that grows with height.** Below it the building settles back and drops in place; above it, it falls. 3x3 frames: 0.6 s at 6 storeys (15 cells tall), 0.8 s at 9 storeys (22.5 cells). The building has to have tipped past its far columns before they go.
- **Wide buildings have a window.** A 4x3 frame of 5 storeys swept west at 0.2 s leans and drops (reach 6.5 cells); at 0.4 s it falls 16 cells; at 0.6 s or more, with the east row last, 18 to 22. So a yard of about 17 cells makes the delay a two-sided decision: too short and it stands, too long and it overshoots.
- **Nudged builds land the same way.** Over 8 builds jittered by 1 mm and 0.2 deg per body (X2's nudge), a felled frame's fold varies in the third decimal: these outcomes are robust, not lucky.
- Leaving the last row uncut is a hinge: the building falls as surely as with a long delay. That is why a fold plunger fires every charge.

## Scoring (agreed with the scores thread, PT9/PT16)

- **Spill** is C11's spill with the lot as the target mask: the share of the building's mass (structure bodies that are not heritage and not removed) whose centre lies outside the lot grown by 0.5 h. It is carried in the rules' reductions as integer grams (`Reductions.mass_g`, `spill_g`; `spillOf`), so every engine and summation order gives the same number, and a test checks it equals engine-api `maskScore`'s spill over the lot's cells.
- **Collapse** on a fold level counts the building alone: heritage neighbours stand outside it, and stone houses beside a plaster frame otherwise held a felled tower's collapse to 0.45 (`outcome.ts buildingOnly`, `Reductions.peHeritage_mJ`).
- **Objective** `{ kind: 'fold', min, spillMax }`: collapse at least `min`, spill at most `spillMax`, no heritage broken. Hitting a neighbour fails the level: in demolition that is the one unforgivable outcome. No cast is needed for it.
- **Star metric** `fold` = collapse x (1 - spill), 0 to 1 ("72% folded"). Stars 2 and 3 come from a cast like every outcome level's.
- **Tally**: the outcome tally as the scores module has it, plus one line, **Spill** = -3000 x spill (the Footprint line's weight), on fold levels only.

## The gate: only levels where timing matters ship

A fold level ships only if, over 8 nudged builds on the reference engine, the best line's mean fold beats firing everything at once by at least 0.1 (a tenth of the metric's range) and by more than 3 standard errors, and that best line meets the objective on at least 80% of the builds. The search screens every sweep (8 compass directions x spacings 0.1 to 1.0 s, delays capped at 2 s) on one build, then confirms the naive line and the best four on 8. A zero-spread pair gets a standard-error floor of 0.001, so identical outcomes do not divide by zero. Results per level are in [mode-probes.md](mode-probes.md) under X2.

## The timeline (UI)

- A panel beside the HUD on any level whose rack holds a plunger: one row per charge, labelled by grid position (A1 is the north-west column; letters run west to east, numbers north to south; an upper storey adds "s2"). Each row has a 0 to 2 s track (click or drag) and - / + buttons for touch.
- **Sweep**: eight compass buttons and a spacing (0.1 to 1.0 s) fill every delay as a sweep falling that way; "All at 0" resets. The player tunes rows from there.
- Markers on the charges' columns, coloured by delay (yellow at 0 s through orange to red at 2 s), so the sweep reads in the scene. The selected row's marker is larger.
- **Plunger** (button, key Enter) fires every charge at its delay. The camera does not move (Will's rule: only on player input).

## Every charge fires

A fold level's plunger must name every plunger charge (`Session.plungerRefusal`). Alternatives weighed:

| Option | Verdict |
|---|---|
| **Every charge fires; the player sets delays** (chosen) | the decision is timing, which is what the gate measures; it matches real demolition (no charge is left live in the building) |
| Any subset, as C5 allows | leaving a row uncut is a hinge that fells the frame with no timing at all (the search found "west and middle rows only" equal to the best sweep), so the order would stop mattering |
| A budget of charges the player places | needs C9's placement tool; a later level type (below) |

## Levels

Five levels ship, each a candidate that passed the gate (`packages/keystone/src/fuse-levels.ts`; numbers in [mode-probes.md](mode-probes.md), X2 "On levels"). All five are plaster frames of rod columns under one-cell slabs. Each has cutters on every ground column and the same objective: fold at least 60%, spill at most 5%, no neighbour broken. Everything at once drops each one a storey (fold 0.19 to 0.29) on every build.

| level | site | the decision | best line (reference, 8 builds) |
|---|---|---|---|
| F1 Timber | 2 x 2 tower, 6 storeys; a 22-cell yard west, houses on the other three sides | sweep west with enough delay (0.6 s or more) | W 1.0 s, fold 0.894, met 8/8 |
| F2 Wrong Way | 3 x 3 tower, 6 storeys; the yard north, houses west, east and south | the direction: only a north sweep folds it | N 1.0 s, 0.859, 8/8 |
| F3 Corner Lot | 3 x 3, 5 storeys; 12-cell yards west and north, houses east and south | three right answers (W, N, NW), two wrong ones that hit the houses' side | W 1.0 s, 0.818, 8/8 |
| F4 Short Yard | 4 x 3, 5 storeys; a 14-cell yard west to a heritage wall | a window: 0.4 to 0.8 s folds it, 0.3 s or 1.0 s spills | W 0.6 s, 0.744, 8/8 |
| F5 Sympathy | 3 x 3, 8 storeys (20 cells tall), relays on storey 5; a 14-cell yard west | the relays fold it in two as it falls, if the sweep is 0.7 s: shorter stands, longer throws the top past the yard | W 0.7 s, 0.696, 7/8 |

Not shipped:
- FC-3b, a tighter Short Yard (11 cells, min 0.5). It passed, but it is F4 again.
- FC-5, Sympathy with a 10-cell yard. It failed fairness (3 of 8).
- FC-5c, F5 without its relays. This is the control (below).

## Stars: the cast on a plunger level

Stars come from the outcome levels' cast (keystone-lab `cast.ts`, spectacle-mode.md section 6), with a line model for timelines (`plungerModel`):

- **Competent lines** are sweeps: one of 8 directions, a spacing of 0.1 to 1.0 s, and each charge a snap early, on time or late.
- **The hill climb** moves one charge one snap.
- **The noise is the build's.** A timeline is exact engine steps, so hand noise does nothing to it. Every competent, climb and cloud play runs on its own nudged build (1 mm, 0.2 deg per body; the play's nudge seed is recorded, so `--replay` plays the same builds).
- **T2** is the median of the competent ends. **T3** is the lower quartile of the best line's cloud of 50 nudged builds.

Most competent sweeps fail: they go the wrong way, or too fast to fell the building. So T2 sits at the all-at-once value, and **any clear earns two stars**. Three stars ask for the bot's best line, give or take a quartile of build noise. This is the spec's rule applied as written, not a special case. On these levels the hard part is finding a line that folds the building at all.

Casts on the reference engine (Node, f64; seed 1; short recipe, 210 plays each). Every gate passed (fair, skill, stable, limits, complete). Each best line was then checked on the GPU solver (SwiftShader, f32) with 8 nudged builds, using the cross-device gate (`--cloud-of`):

| level | T2 | T3 | best | best line | cloud P25 / P50 | SwiftShader T3 (8 builds) |
|---|---|---|---|---|---|---|
| F1 | 0.24 | 0.89 | 0.913 | `plunger.1.0.0.6.3.54.2.72` | 0.895 / 0.895 | 0.894, inside |
| F2 | 0.24 | 0.85 | 0.875 | `plunger.0.0.6.0.3.6.7.42.4.48.1.54.5.96.2.102.8.102` | 0.858 / 0.859 | 0.858, inside |
| F3 | 0.29 | 0.81 | 0.838 | `plunger.0.0.3.6.6.6.7.42.1.54.4.54.5.96.8.96.2.102` | 0.815 / 0.821 | 0.814, inside |
| F4 | 0.28 | **0.69** (reference 0.72) | 0.805 | `plunger.0.6.1.6.2.6.3.54.4.54.5.54.8.114.6.120.7.120.9.120.10.120.11.120` | 0.721 / 0.740 | 0.696 over 32 builds, harder by 0.011 |
| F5 | 0.33 | 0.74 | 0.794 | `plunger.0.0.1.0.2.6.4.36.3.48.5.48.8.78.6.90.7.90` | 0.743 / 0.750 | 0.726 over 16 builds, inside [0.703, 0.748] |

On F1 to F3 the GPU lands on the reference's T3 to the third decimal.

**The game records these stars on the GPU (PT20).** The stars were cast on the reference, and the game plays on the GPU solver. So until agent playtest round 2, `onEngine` marked every F level custom ("Custom settings, so no stars are recorded"), and no player could earn a star. Each entry in stars.json now lists `"agrees": ["gpu"]`: the GPU's cloud of the best line passed the cross-device gate above, and the game records stars on an engine the cast was made on or checked on (keystone `starsHoldOn`). Write `agrees` only after a passing `--cloud-of` on that engine, with its numbers in this table. A game test runs over every rated level in the series: none opens custom on the default engine. Alternatives:
- Hide the star rows until a GPU cast exists (PT7's rule for uncast levels). Rejected: the GPU check already holds the stars to the GPU, and F4's T3 already comes from the GPU's cloud. Hiding them would take away stars that the evidence supports.
- Recast on SwiftShader in CI. Rejected: about 3 h a level, and CI test files must stay under 300 s.
- Relabel the casts `engine: gpu`. Rejected: the file would no longer say where the cast ran.

The Metal recast queued for the Mac will replace these entries with GPU casts.

F5 needs two notes.
- **Its T2 is above all at once** (0.33 against 0.26). Half its competent sweeps end at 0.34 or more, above the all-at-once 0.26: a sweep that misses the yard often still brings part of the tower down. On F1 to F4 the median competent sweep ends at the all-at-once value. Two stars still need a clear: stars require the objective.
- **Its cast took 88 min here, over the 60 min budget gate.** The gate is judged on the M5 Max. Here the reference engine ran on this container's CPU at 36.7 ms a step over 144k steps. Every star gate passed (fair 0.84, skill 0.40, stable 0.017, no limits, complete), so the stars went into the file as cast. The alternative was recasting with `--budget-min 90`. That gives the same stars, because a cast is deterministic for its seed, and costs another 88 min. The budget is a property of the machine, and the Metal recast will measure it on the M5.

On the GPU, F5's best line has a lower quartile of 0.726 over 16 builds. That is inside the reference's interval, so T3 stays at the reference's 0.74, unlike F4. F5 is the noisiest level (cloud P10 0.703), so it is first in line for the Metal recast.

F4 is the exception. It is the wide frame with a two-sided window, and the noisiest level (cloud sd 0.03). On SwiftShader its best line's lower quartile is 0.696 over 32 builds, against the reference's 0.721; 29 of 32 still meet the objective. The game plays on the GPU, so F4's T3 is set from the GPU cloud (0.69, rounded toward easier, the easier of the two devices). The stars file records this in `castOn`. Alternatives weighed:
- Keep the reference's 0.72. Rejected: on the GPU about a third of the bot's own best-line plays would miss three stars.
- Pool both clouds (P25 0.719). Rejected: still the reference's number in practice.
- Cast F4 on SwiftShader end to end (about 3 h here). Not needed: the GPU cloud of the best line is what T3 measures, and T2 does not move (it is the all-at-once value on every device). The cast's best lines are sweeps that the climb nudged a snap here and there: F1's best goes A2, A1, B2 and B1 at 0, 0.1, 0.9 and 1.2 s. A Metal recast of each level is queued for the Mac.


## Settle rule: v3, not v4

Outcome levels settle by v4 since PT6b ([settle-v4.md](settle-v4.md)). F1 to F5 stay on v3, by decision, not as a pin waiting for a recast. v4 is v3, or a steady collapse: the shot ends once D has held within 0.005 for 2 s, however much still moves. A frame building can drop a storey, stand for longer than that, and then topple. v4 scores it standing.

The evidence is a full v4 recast of all five on the reference engine (2026-11-07, seed 1, 210 plays each, the v3 casts' recipe):

| level | v4 T2 / T3 (v3's) | plays compared | ends moved by more than 0.01 | of them: stand, then fall | charges cut short |
|---|---|---|---|---|---|
| F1 | 0.24 / 0.89 (same) | 210 | 0 | 0 | 0 |
| F2 | 0.24 / 0.85 (same) | 136 | 8 | 2 | 6 |
| F3 | 0.28 / 0.81 (0.29 / 0.81) | 210 | 8 | 2 | 6 |
| F4 | 0.28 / 0.72 (same reference T3; the GPU's 0.69 stands) | 210 | 8 | 0 | 8 |
| F5 | 0.33 / 0.74 (same) | 210 | 6 | 1 | 5 |

A play is compared when both casts played the same line on the same build; F2's climb took another path after 136 plays.

The order gate under v4 picks the same best lines with the same folds to the third decimal. The stars barely move because the moved plays are competent misses, not best lines. They come in two kinds:
- **The frame stands, then falls.** F3's competent line 16 drops the frame a storey; v4 ends it 212 steps after its last charge at 0.291, and v3 waits for the fall at 0.717. F3 line 25 (0.290 against 0.678), F2 line 37 (0.222 against 0.388) and F5 line 45 (0.262 against 0.294) are the same. A player who timed a slow sweep would be scored on a building that falls seconds later, in front of them. This is the case that keeps v3 (fuse-levels.test reproduces line 16 on its build).
- **Charges cut short.** Five to eight plays on each of F2 to F5 end on the step their last charge fires: the early charges drop nothing, so D holds, and v4's window keeps counting while the shot is held for the charges still to come. This is a v4 bug, not a property of the mode, and it can hit any outcome level whose shot is held for a charge or fuse still to go off (`Session.observe`'s `hold`). It is reported to the settle thread, with a fix: restart v4's windows when a hold ends.

Alternatives:
- Recast under v4 and drop the pin, as planned. Rejected: the stand-then-fall case scores a fall as a stand.
- Lengthen v4's window on fold levels (`STEADY_STEPS` per level). Rejected: a new knob for one mode, and the stand can last longer than any fixed window that still helps the big levels.
- Keep v3. **Chosen**: the casts, the gate and the stars all came from v3, so nothing moves, and Skip (K) already shortens a long wait.



F5 puts relays on the fifth storey of an 8-storey 3 x 3 tower. A relay is C5's `relay`: armed at start, it cuts its host once jolted past 0.05 m or 0.5 m/s. A west sweep tips the tower, the jolt fires the relays, and the tower folds in two, landing shorter than its 20-cell height. The panel lists the relays under the timeline ("9 relays on storey 5: they go off when jolted") and the scene marks them in blue. The player cannot set them: they are part of the building.

Do the relays matter? The same tower and yard without them (FC-5c), over 8 builds:

| line | with relays (F5): fold, met | without (FC-5c): fold, met |
|---|---|---|
| all at once | 0.262, 0/8 | 0.192, 0/8 |
| W 0.7 s | 0.696 (sd 0.061), 7/8 | 0.713 (0.001), 0/8 |
| W 0.8 s | 0.723 (0.031), 4/8 | 0.713 (0.001), 0/8 |
| W 1.0 s | 0.726 (0.029), 1/8 | 0.713 (0.001), 0/8 |

Without relays the felled tower always lands whole, with about 19% of its mass beyond the yard. With them it folds short enough on most builds of the right line. The cost is spread: F5's sd is 0.03 to 0.06, against 0.001 to 0.02 on F1 to F4. The relays fire on a jolt, and a jolt's timing varies with the build. F5 passes the gate with the least room of any level (7 of 8 against 80%; 20 SE), so it is the last level and the first to recheck on Metal. With a 10-cell yard (FC-5) the same design met on 3 of 8 and failed.

## Alternatives considered for the mode

| Option | For | Against | Verdict |
|---|---|---|---|
| **Removal charges (cutters) on frame buildings** (chosen) | the only energy is gravity's, so the outcome is the order's; frame buildings fell, cube blocks do not | needs slabbed buildings | chosen |
| Blasts only, no removal | simpler; existing grenades | cruder: a blast's push swamps the order (X2's risk), and every hit is a launch | rejected |
| Sparse cutting forces (V5) | a "cut" that bends rather than vanishes | waits for V5, buys little over removal at this scale | rejected for now |
| Free-time delays (any step) instead of 0.1 s snaps | finer control | harder to cast (a continuum of lines), unreadable on a timeline; replays are exact either way | rejected |
| Solid cube buildings anyway | the look of S14's town | X2: they drop in place whatever the order, so timing is no decision | rejected |
| Felling into a yard vs implosion into the footprint | implosion is demolition's iconic shot | on frames, everything-at-once already drops in place; an implosion level needs multi-storey cuts that fold (more charges than the 16-event timeline holds on a 3x3 frame); felling makes the delay the decision now | felling first; implosion with upper-storey cuts is follow-up work |

## Seams left for later

- **Domino fuses** (C9's stroke brush, PR #231): a fuse is dominoes from a kicker charge (the plunger tips the first domino) to a relay charge on a column (C5's `moved` trigger, armed at start), so its length is the delay. Nothing in M5 needs to change for it: the timeline lists plunger charges only, and a fuse's relay is armed at start. M5 builds no brush of its own.
- **More sympathetic designs**: F5 is one. The variables are relays on more than one storey, and a threshold that waits for a larger jolt (C5's `moved` trigger takes both). A threshold that tightens F5's spread would make a fairer level.
- **Neighbour contact**: heritage is judged by displacement, and a stone house of one slab per course barely moves when a plaster frame lands on it. A rule that fails a level when building mass touches a neighbour would match the objective's wording better. Today spill catches those lines first (5 of 648 screened lines broke a house).
- **Player-placed charges**: with C9's placement tool, a budget of cutters the player places on columns of their choice.
