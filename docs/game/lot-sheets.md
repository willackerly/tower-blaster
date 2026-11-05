# Lot Sheets (M3): side goals per level

Mode M3 of [modes-roadmap.md](modes-roadmap.md). Each level can carry a short list of side goals that sit beside its objective, such as "every crown with the first shot" or "three crowns with the marbles alone". Goals never feed the score or the stars. A sheet is data beside its level, so adding or changing a sheet leaves the level's hash and its cast stars alone.

## Play it

- The HUD lists the level's proven goals under **Lot sheet**. A goal is ticked while the round meets it so far. A goal met on an earlier play of the same level version is marked.
- The result card counts the goals met and marks first-time ones **new**. When the sheet has grade cuts, it also shows the grade (E to A).
- `?keystone.goals=shown` (default) shows proven goals, `all` also shows unproven ones (for authoring), and `off` hides the sheet.
- Progress keeps the ids of every goal met on a level, unioned over plays of the same level hash. A new hash starts the list again.

## How a goal is written

A goal is a JSON predicate (`goals.ts`, capability C3) over the round's facts:

| Term | Reads |
|---|---|
| `{ fact, op, value }` | a whole-round fact: `cleared`, `shots`, `rackLeft`, `collapse`, `crowns`, `crownsLeft`, `heritage`, `leverage`, `bestLeverage`, `comboMax`, `outOfLot`, `skyline`, `score`, `stars` |
| `{ shot, fact, op, value }` | a fact of the k-th shot fired: `crownsDown`, `leverage`, `heritageNew`, `displaced` (a shot not fired fails) |
| `{ used, op, value }` | how many shots fired this rack item (`any`: all shots) |
| `{ group, of, count?, op, value }` | a named group of the sheet (`groups.ts`, C6: by part, role, material or box) as a share of its bodies, or a count: `down`, `displaced`, `outOfLot`, `standing` |

`all`, `any` and `not` combine terms. `op` is one of `>= <= > < ==`. `checkLotSheet` refuses a malformed sheet and names the goal and field at fault. A sheet holds at most 8 goals.

The facts are judged at every settle (for the HUD, so far) and at the round's end (for the record). With rapid fire (#184), a shot cut by the next one still counts as a shot.

## How a sheet is made

1. **Explore.** `pnpm keystone:goals L2 --explore 24 [--seed S] [--items marble,marble]` plays competent lines (the cast bot's intents) on the f64 reference and prints one JSON line of facts per play. `--items` fires only those items in that order, which gives the plays a goal about the marbles needs.
2. **Write goals from what the plays reach.** Look for a fact that some plays reach and most don't. Each goal records a **proof**: the shot line of one explored play that meets it.
3. **Prove.** `pnpm keystone:goals L2` (or `--sheet draft.json`) replays each proof line plus 8 nudged copies (the cast's hand noise). A goal ships only when its line meets it and at least 6 of the 8 nudges do (`marginOk`). The command exits 1 when a goal falls below the margin.
4. **CI** (`packages/keystone-lab/test/lot-sheets.test.ts`) replays each proof line on the sheet's engine and fails if one stops meeting its goal. That happens after a physics change; re-explore and re-prove the sheet.

Sheets for the 10k-block levels (B1 to B3) need proofs on the GPU solver (`engine: 'gpu'`), which run on the Mac or behind `PHYSICS_GPU_SLOW`.

## The sheets

All proofs are on the reference engine, and the nudge counts are from `pnpm keystone:goals`.

### L1 Open Fire

From 64 explored plays. A cannonball aces the level about one time in three. The marbles alone never clear it, but they reach three crowns about one time in three, and a well-placed marble moves up to 5x its own energy.

| Goal | Predicate | Nudges met |
|---|---|---|
| Every crown with the first shot | shot 1 crownsDown ≥ 4 | 7/8 |
| Clear it with most of the tower still up | cleared, collapse ≤ 0.4 | 6/8 |
| Clear it with no more than 1 block in 8 off the lot | cleared, outOfLot ≤ 0.125 | 7/8 |
| One shot that brings down 3x its own energy | bestLeverage ≥ 3 | 8/8 |
| Three crowns with the marbles alone | used cannonball = 0, crowns ≥ 3 | 6/8 |

### L2 Lintel

From 64 explored plays. A cannonball clears it in one shot nearly every time, often without touching the pavilion. The marbles alone rarely bring down more than two crowns.

| Goal | Predicate | Nudges met |
|---|---|---|
| Clear it and leave the pavilion untouched | cleared, heritage = 0 | 8/8 |
| Clear it with half of it up and the pavilion untouched | cleared, heritage = 0, collapse ≤ 0.5 | 6/8 |
| One shot that brings down 2.5x its energy, pavilion untouched | heritage = 0, bestLeverage ≥ 2.5 | 8/8 |
| Clear it with no more than 1 block in 12 off the lot | cleared, outOfLot ≤ 0.08 | 7/8 |
| Two crowns with the marbles alone | used cannonball = 0, crowns ≥ 2 | 6/8 |

### L3 Surgeon

From 64 explored plays. A heritage cube breaks in most of them. The marbles can clear it alone, and a cannonball can in one shot, though rarely cleanly.

| Goal | Predicate | Nudges met |
|---|---|---|
| Clear it without touching the heritage cubes | cleared, heritage = 0 | 6/8 |
| Clear it with the marbles alone | cleared, used cannonball = 0 | 8/8 |
| Clear it with a single shot | cleared, shots = 1 | 8/8 |
| Clear it with no more than 1 block in 20 off the lot | cleared, outOfLot ≤ 0.05 | 8/8 |

### L4 Catapult

From 64 explored plays. This is the hardest of the five for the bot, which cleared it only 3 times. A good anvil drop brings down 6 to 8 of the 9 crowns. Clearing it without the anvil never held up to nudges (0/8 and 5/8), so it is not a goal.

| Goal | Predicate | Nudges met |
|---|---|---|
| Six crowns with the first shot | shot 1 crownsDown ≥ 6 | 8/8 |
| Clear it and leave both pillars standing | cleared, heritage = 0 | 7/8 |

### L5 Dominoes

From 80 explored plays. Almost any shot takes the crown; the skill is in how much of the run comes down with it. A 4x lever (1/8 and 2/8) and toppling the whole run with the cannonball (3/8) fell below the margin.

| Goal | Predicate | Nudges met |
|---|---|---|
| Every domino down with one shot | cleared, shots = 1, collapse ≥ 0.7 | 7/8 |
| Take the crown and leave the rest standing | cleared, collapse ≤ 0.1 | 7/8 |
| One shot that brings down 3x its own energy | bestLeverage ≥ 3 | 6/8 |
| Take the crown with the cannonball | cleared, used marble = 0 | 8/8 |

In all, 29 of the 53 candidate pairs (a goal with one proof line) met the margin, and 20 goals ship. The shortfalls named above give the nudge counts of each line tried.

## Tests

- `packages/keystone/test/goals.test.ts`: predicates, facts, grades and `checkLotSheet`.
- `packages/keystone-lab/test/lot-sheets.test.ts` (L1, L3 to L5) and `lot-sheets-L2.test.ts` (L2's plays are the slow ones; about 200 s): every sheet is well formed, every goal is proven, and every proof line meets its goal on the reference. Together they cover every sheet.
- `packages/keystone-lab/test/goal-lab.test.ts`: `proveSheet` plays a proof line shared by two goals once, gives each goal its own nudges, skips unproven goals, and `marginOk` is 6 of 8.
- `packages/game/test/modes-ui.test.ts`: the HUD block, the result card, `keystone.goals`, and progress goals.
- `packages/game/test/lot-e2e.test.ts` (headless Chromium, Rapier): L1's goals show in the HUD; the page judges them exactly as headless facts of the same line on the same engine; the result card shows the count; the met ids are recorded.

## Not built yet

Grade cuts per level (B1's cast cloud has them: P10 .462, P25 .593, P50 .708, P75 .848, P90 .912; L1 to L5 need cast clouds first), sheets for B1 to B3 with GPU proofs, and a goal-authoring view in the viewer.
