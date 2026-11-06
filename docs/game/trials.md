# Trials: every structure built so far, playable unrated

Status 2026-11-06. Will (04:22Z): "there are only 5 levels, want to wire up all the scenarios / permutations we've built out? would be very great to trial those too."

Two things were behind "only 5 levels". The door listed only the series of the level the page opened on (a bare URL showed B1 to B3; `?level=L1` showed L1 to L5), so most of the 11 rated levels were never on screen. And every other structure the project has built (the engine scenarios, the G5 drafts, the mode probes' builds) was reachable only in the viewer or a CLI. Now the door lists every series (front-door.md), and a fourth series, the **trials**, makes those structures levels.

Code: `packages/keystone/src/trial-levels.ts` (`TRIAL_LEVELS`, `TRIAL_NOTES`), the drafts moved to `packages/keystone/src/drafts.ts` (keystone-lab re-exports them for `pnpm keystone:cast --draft`).

## What a trial is

- An **outcome level with no cast stars**: one star for its objective, the tally (heritage, unused rack) as on any outcome level, and "targets coming soon" for two and three stars. Progress is recorded as on any level (by id and hash).
- Id `T-<source>` (`T-S4`, `T-B2D`, `T-X3K`): never a rated level's, a scenario's or a draft's id, so `?level=T-S4` and the viewer's `?scenario=S4` stay apart. Lookup is case-blind.
- **Rack**: up to a few thousand blocks, a cannonball, two marbles and two grenades (`TRIAL_RACK_SMALL`); light bodies (S8's rods, dominoes, Kapla planks), three marbles and a grenade (`TRIAL_RACK_LIGHT`: a cannonball is 27 to 68 times one, over the ammo ratio); 5k blocks and up, the big levels' three bombs and two rams (`TRIAL_RACK_BIG`). The drafts keep their own racks.
- Everything else (launcher ring, lot, physics) is what `scenarioLevel` or `outcomeLevel` gives, so a change there (the launch point, for one) reaches the trials too.

## The trials

| Id | Name | From | Blocks | Validator notes |
|---|---|---|---|---|
| T-S1 | Tall Tower | scenario S1 | 1,920 | |
| T-S2 | Stepped Pyramid | scenario S2 | 820 | |
| T-S3 | Stack-Bond Wall | scenario S3 | 1,000 | |
| T-S3R | Running-Bond Wall | S3 running=true | 1,000 | unsupported: end cubes overhang half and tip in the pre-settle |
| T-S4 | City of Towers | scenario S4 | 10,000 | |
| T-S8 | Slab and Rod Tower | scenario S8 | 750 | mass-ratio (slabs 80 x the rods), ammo-ratio (a marble is 26 x a rod) |
| T-S12 | Wall with a Hole | S12 running=true | 265 | unsupported: end and hole-side cubes |
| T-S14 | Buildings | scenario S14 | 1,728 | |
| T-S14T | Town | S14 towers=25 H=16 vary=0.4 | 5,232 | |
| T-X1 | Domino Run | mode probe X1 (line) | 30 | crown line 0.6 h (a felled domino lies 0.15 h up) |
| T-X2 | Slab Block | mode probe X2 (slabs) | 245 | mass-ratio (slab 37 x a cell); 16 pulls + 2 cannonballs: implode it |
| T-X3 | Tower Chain | mode probe X3 (cubes) | 384 | |
| T-X3B | Brick Pier Chain | mode probe X3 (bricks) | 192 | |
| T-X3K | Kapla Crib Chain | mode probe X3 (kapla) | 336 | |
| T-X4 | Arch | mode probe X4 (brick arch, R 5 m) | 433 | unsupported: bricks at the arch's edge (X4: one drops, the rest holds) |
| T-B1A, T-B1B | Long Wall | drafts B1a, B1b | 1,000 | |
| T-B2A to T-B2E | Spare the Cathedral | drafts B2a to B2e | 5,184 | |
| T-B3A, T-B3B, T-B3C, T-B3E | Ten Thousand | drafts B3a, B3b, B3c, B3e | 10,000 | |
| T-B4A | Domino Boulevard | draft B4a | 1,680 | |
| T-I1 | Ice Tower | ice: L1's 2 x 2 column, all ice, crowned | 40 | |
| T-I2 | Ice Wall | ice: a third-bond wall 8 x 6 | 48 | |
| T-I3 | Frozen Keep | ice: a 3 x 3 stone keep, its top four courses ice | 72 | |
| T-W1 to T-W5 | (L1 to L5's name): New Arms | weapons: L1 to L5's structure and launcher, the lot grown to the ring less 3 cells, rack `w-scatter`, `w-rocket`, `marble` (weapon-trials.md) | as L1 to L5 | |

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
