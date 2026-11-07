# Trials: every structure built so far, playable unrated

Status 2026-11-06. Will (04:22Z): "there are only 5 levels, want to wire up all the scenarios / permutations we've built out? would be very great to trial those too."

Two things were behind "only 5 levels". The door listed only the series of the level the page opened on (a bare URL showed B1 to B3; `?level=L1` showed L1 to L5), so most of the 11 rated levels were never on screen. And every other structure the project has built (the engine scenarios, the G5 drafts, the mode probes' builds) was reachable only in the viewer or a CLI. Now the door lists every series (front-door.md), and a fourth series, the **trials**, makes those structures levels.

Code: `packages/keystone/src/trial-levels.ts` (`TRIAL_LEVELS`, `TRIAL_NOTES`), the drafts moved to `packages/keystone/src/drafts.ts` (keystone-lab re-exports them for `pnpm keystone:cast --draft`).

## What a trial is

- An **outcome level with no cast stars**: one star for its objective, the tally (heritage, unused rack) as on any outcome level; the door shows the objective's row alone. Progress is recorded as on any level (by id and hash).
- Id `T-<source>` (`T-S4`, `T-B2C`, `T-X3B`): never a rated level's, a scenario's or a draft's id, so `?level=T-S4` and the viewer's `?scenario=S4` stay apart. Lookup is case-blind.
- **Rack**: up to a few thousand blocks, a cannonball, two marbles and two grenades (`TRIAL_RACK_SMALL`); light bodies (S8's rods, dominoes, Kapla planks), three marbles and a grenade (`TRIAL_RACK_LIGHT`: a cannonball is 27 to 68 times one, over the ammo ratio); 5k blocks and up, the big levels' three bombs and two rams (`TRIAL_RACK_BIG`). The drafts keep their own racks.
- Everything else (launcher ring, lot, physics) is what `scenarioLevel` or `outcomeLevel` gives, so a change there (the launch point, for one) reaches the trials too.

## The 20 trials (pruned 2026-11-06, PT11)

The agent playtest (round 1, `docs/game/agent-playtest-1.md`, judge 3's promotion table in project files `playtest/agent-1/judges/findings-breadth.md`) played every trial. The list now holds judge 3's keeps, reworks and promotions; its drops are gone, each with its reason in `TRIAL_DROPS` (trial-levels.ts). T-S8 moved from judge 3's drop list to rework: its heap at load is Rapier's (the playtest ran on Rapier), and the GPU solver, the game's engine, leaves it standing (`gpu-check/T-S8-novice-desktop-00-aim-view`).

| Id | Name | From | Blocks | Verdict | Next |
|---|---|---|---|---|---|
| T-S3 | Stack-Bond Wall | scenario S3 | 1,000 | rework | a "bond types" lesson; the marble only cuts a slot (7%) |
| T-S4 | City of Towers | scenario S4 | 10,000 | promote | after PT2 (sparks) |
| T-S8 | Slab and Rod Tower | scenario S8 | 750 | rework | stands on the GPU solver; heaps at load on Rapier (mass-ratio 80): Rapier players see rubble |
| T-S14 | Buildings | scenario S14 | 1,728 | promote | best cause and effect in the set |
| T-S14T | Town | S14 towers=25 H=16 vary=0.4 | 5,232 | promote | a warm-up before B2; after PT2 |
| T-X1 | Domino Run | mode probe X1 (line) | 30 | rework | an opener or hint at the far end |
| T-X2 | Slab Block | mode probe X2 (slabs) | 245 | rework | needs a recorded line proving 50% |
| T-X3B | Brick Pier Chain | mode probe X3 (bricks) | 192 | promote | its crowns made visible (PT1) |
| T-X4 | Gateway | mode probe X4, rebuilt | 461 | rework done | the half-disc arch broke in the pre-settle on every engine; now a doorway 6 m x 4 m under a lintel (`gateWall`) that stands |
| T-B1B | Long Wall (B1b) | draft B1b | 1,000 | rework | fold its wrecking-ball rack into B1 (PT13) |
| T-B2C | Spare the Cathedral (B2c) | draft B2c | 5,184 | rework | a "surgical" variant once heritage shows (PT1) |
| T-B3B | Ten Thousand (B3b) | draft B3b | 10,000 | rework | keep this one variant; cast stars |
| T-B4A | Domino Boulevard (B4a) | draft B4a | 1,680 | rework | the chain never propagated (3%) |
| T-B5A, T-B5B, T-B5C | Kapla Spire | drafts B5a (one spire), B5b (five towers), B5c (B5a without GPU sleep) | 2,884; 3,106; 2,884 | new (G5, after the playtest) | planks 1.5 x 0.3 x 0.1 m; launcher 27 m up; judged in the next agent round |
| T-I1 | Ice Tower | ice | 90 | rework done (PT38) | was a 2 x 2 column one cannonball cleared; now 3 x 3, 10 high, nine crowns, marbles first |
| T-I2 | Ice Wall | ice | 96 | rework done (PT38) | was one wythe, 85-100% down from one cannonball against a 30% objective; now two deep, 65% to clear, marbles first |
| T-I3 | Frozen Keep | ice | 72 | promote | the ice intro, par 1 |
| T-W1 | Domino Workshop | workshop (placement.md): three crown dominoes a quarter circle apart, one marble, a 30-domino build brush | 3 + what you lay | new (C9, after the playtest) | crown line 0.6 h; played in the next agent round |

Promotions (`TRIAL_PROMOTE`) wait for PT1 (objectives visible) and PT2 (sparks follow the damage), as the playtest asks; each then gets a player-facing name, a cast and a recorded line.

Dropped (`TRIAL_DROPS`): T-S1, T-S2, T-S3R, T-S12, T-X3, T-X3K, T-B1A, T-B2A, T-B2B, T-B2D, T-B2E, T-B3A, T-B3C, T-B3E. Their structures stay where they were built, and the viewer still opens them (`?scenario=S1`, `pnpm keystone:cast --draft B2a`).

Left out, and why:

- **S5** (S4 with the scenario's own ball): the player is the ball; T-S4 is the same city.
- **S6, S7, S11**: loose cubes dropped into a heap or rain, no structure to bring down.
- **S9**: its point is the heavy top, and a scenario part is one material, so it would be an 11-cube column.
- **S10**: S1 moved 5 km from the origin; the launcher ring is centred on the origin.
- **S13**: 20 cubes, already overlapping as built (0.002 h).
- **S15** (Kapla tower): its units are plank widths, so at h = 0.5 m a plank is 2.5 m long and a 2,000-plank tower 150 m tall (10k: 290 m). At Kapla's real scale (23 mm) it needs the viewer's substeps (`?scenario=S15`). The game's Kapla trial is X3's crib chain, planks 1 x 0.3 x 0.1 m.
- **Drafts B1c and B3d**: B1 and B3 as rated, but for the objective (0.2 against 0.4).
- **Mode probes X5, X6, X8**: X5 (pinned anchors) and X6 (shake) test mechanics the game does not have; X8 runs many small worlds at once.

## Verification

- `keystone/test/trial-levels.test.ts`: ids, sources and coverage (which scenarios, drafts and probes are in); each trial an uncast outcome level within the GPU's 10,000 bodies whose validator issue codes are exactly its note's (a note never outlives its issue, and no trial gains one silently); the probe structures' counts (30 dominoes; 5 storeys of 2 x 24 cells and a slab; 12 towers of 32 cubes, 16 bricks or 28 planks; the arch's wall less its half disc).
- `keystone-lab/test/trial-reach.test.ts`: from the launcher ring, every launch item in a trial's rack can be aimed onto some face a competent player picks (16 lines), and 60% of all their shots can. The drafts' bar is 80%; the tall trials (S1 15 m, S2 20 m) keep faces above what a shot from 1 m up reaches. The launch-point change (thread "Raise launch point and fix ball look") should raise these; the floor only holds them.
- `game/test/door.test.ts`: every series under its title in the game's order (`GAME_SERIES` covers keystone's `SERIES` exactly), the trials folded and uncompiled until opened, a card's `data-arg` is its index in the page's whole list, Play never a trial.
- `game/test/door-e2e.test.ts` (Rapier, headless Chromium): the door lists all 11 rated levels; the Trials toggle lists every trial; a pick loads in place (a marker on `window` survives); N and P walk the trials and stop at their ends; L5's N does not run into Undercut; `?level=t-x3b` opens the trial with the toggle open.
- Not run in CI: every trial on the GPU engine. Validation checks each against the GPU budget, but a 10k trial pre-settles in about 25 min on SwiftShader. They play on the Mac at the next playtest deploy.

## Alternatives considered

- **Trials as the viewer's automatic levels only** (`?scenario=S4&rules=keystone`, as before). Rejected: Will asked for them in the game, and the viewer is a tool, not the playtest build.
- **Scenario ids as level ids** (`?level=S4`). Rejected: one id would mean a level in the game and a scenario in the viewer, and several trials come from one scenario (S3 and S3R, S14 and S14T).
- **Casting stars for the trials.** Not now: a cast is hours of Mac time per level (B3 about 3 h). Trials are for finding which structures are fun; a trial that is becomes a rated level and gets its cast then.
- **Listing the trials open on the door.** Rejected: 25 more cards would bury the rated levels, and opening them compiles every trial (10k-block ones take 20 to 30 ms each).
