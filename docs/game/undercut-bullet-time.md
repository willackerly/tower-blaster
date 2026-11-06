# Undercut and Bullet Time: capabilities C1 and C2, modes M1 and M2

Status 2026-11-05. Stage 1 of [modes-roadmap.md](modes-roadmap.md) (Will chose "Probes, then Stage 1 verbs", 20:48Z). This note fixes the rules the roadmap left open and lists what each step lands with. The modes reuse the Keystone shell ([spectacle-mode.md](spectacle-mode.md)); nothing here touches the solver.

## C1: the `pull` rack item

**What it is.** `pull` is a rack item like `marble`: one entry per pull. Its shot is `{ ammo: 'pull', body }`, the engine id of a structure body; shot text `pull.<body>`, record code 5. Firing it pushes one engine `remove` event for that body at the fire step (`@tb/engine-api` remove.ts), and nothing is spawned, so later ammo is numbered as if the pull were not there.

**What may be pulled.** Any structure body that is still in the world, except crowns and heritage (the objective's pieces are never taken, and pulling a crown off would be a free clear). Refused bodies throw in `Session.fire`, the same place an empty rack throws, and the game never offers them.

**Physics.** Nothing new. Every engine already removes bodies (spent grenades); the GPU engine wakes what the removed body touched with a zero-impulse blast (engine.ts, sleep.ts header), Rapier wakes contacts on removal, and the reference engine has no sleep. A removed body is a tombstone: it stays where it was, with zero velocity, and the renderer skips it (tier `TIER_FREE`).

**Scoring.** A pulled block counts in every reduction at the pose it had when pulled, frozen there. So the pull itself releases no energy (no collapse is earned by deleting blocks high up), the collapse fraction only counts what falls because of it, and the observers need no tier check. The cost: D can never quite reach 1 on a level where many blocks were pulled high up, which is under 1% for any Stage 1 level.

**Nominal energy.** Leverage divides by energy fired, and a pull fires none (roadmap finding 12). A pull is charged the launch energy of the gentlest shot in the shell, a marble at power 0 at the level's unit (409 J at h = 0.5 m): the shot a pull stands in for, since the marble is the scalpel that knocks one cube out. Alternatives considered: the weight of the block lifted one h (153 J for plaster; ties the cost to the block, but a 10 kg plank then costs a tenth of a cube and every leverage tier collapses to Keystone); the friction work to slide it out under its load (the real Jenga cost, but the load per body is C19, not built). The marble rule keeps pulls and pokes on one scale and is one constant to re-fit after the playtest.

**Feedback.** `fired` carries `ammo: 'pull'` and `body`; the game shows a dust puff at the block and a soft scrape cue.

## M1 Undercut

Two level kinds, both outcome-scored (the slice's shell):

- **Aim.** A rack of 1 to 4 pulls (maybe one marble): pull blocks so the structure falls the way the objective wants (crowns down, heritage spared). Objective `crowns` or `collapse`, stars on the usual metrics.
- **Hollow.** Push your luck: take as many blocks as you dare while the capstone (a crown) stays up; bank before it goes. New objective kind `hold` (every crown above the crown line at the end) and star metric `pulled` (share of the structure's mass pulled, from 0 to 1). A crown that falls ends the level at that settle as failed. Stars are uncast until a cast runs (only the objective's star), as the roadmap allows (personal best).

Levels need slabs, planks and interlocks, because a pull under a loose-lattice column only drops that column one cube (roadmap section 4, risk; probe X4). The three Stage 1 levels are a series of their own, reachable at `?level=U1` and in the viewer's level list:

- **U1 Table Manners** (aim, 3 pulls, par 2): a fixed slab on four rod legs carrying four crowns. One pull leaves it on three legs; two diagonal pulls leave it balanced on the other diagonal; only two adjacent pulls tip it, so a diagonal guess clears a pull late (two stars).
- **U2 Counterweight** (aim, 4 pulls, par 2): a fixed beam on a heritage pier 2 h wide, four crowns at its +x end, and four counterweights at the other: a two-cube rod at the far end, a four-cube rod beside it, two loose cubes by the pier. The beam stays level while its centre of mass is over the pier; only the two far rods together move it past the edge (+1.36 h against the edge at 1 h). Any other pair leaves it at +0.63 h or less, and the heavy rod with both near cubes at +0.82 h, so one wrong pull is two stars and two wrong pulls one. The lesson is the lever arm: the near cubes weigh as much as half the far rod and do almost nothing.
- **U3 Hollow** (hold, 16 pulls): a ten-course tower of planks, three to a course, crossing, with a capstone crown. Jenga's rule holds in the physics: both edges of a course may go, a middle and an edge may not.

**Revised 2026-11-06 (the agent playtest's PT7).** U1 and U2 are par puzzles now, and their top and beam are `fixed` (a slab or rod part a pull cannot take; `BoxPart.fixed`, refused like crowns and heritage). Before, pulling the top out cleared either in one pull: on U2 that shortcut (42% down, 4,072 points) beat the intended solve (18 to 19% down, 2,500 points) on every metric, so no cast could have starred the puzzle. Fixed, the clears of both are binary, and a collapse cast would only have measured noise (U2's clears all fall 18 to 19%); par measures what the puzzle asks, the fewest pulls. Alternatives considered: making the beam heritage (tipping it is the solve, so three stars would be impossible), raising a catch under the crowns (it also stops the tip), and casting U2 on points (every clear banks the same). U3 stays outcome-scored on `pulled`: how much you dare take is a real spread, and its stars come from a cast like any outcome level's, the cast now aiming pulls (keystone-lab `cast.ts` `pullTarget`: the pullable body nearest the face point an intent names, none taken twice).

Each was checked on the f64 reference and on Rapier (keystone-lab `undercut-levels.test.ts`, every ordered pair of pulls of U1 and U2), and U1 and U2 on the GPU solver (game `par-gpu-U1.test.ts`, `par-gpu-U2.test.ts`: a wrong pair holds, the par pair clears). An attempt to make U1 a heritage lesson (tip it away from a pavilion) failed: the crowns slide toward the pulled side and stop short, and the kicked-out legs only lean on the pavilion, breaking it on Rapier but not on the reference. A lesson that depends on a marginal contact is one engine's lesson, so it was cut.

## C2: input into a running world

**Revised 2026-11-05 (21:20Z).** The rapid-fire thread (PR #184) makes firing into a running shot the default for every level: a new fire cuts the shot in flight (its outcome is recorded with `cut: true`, feedback `{ t: 'cut' }`), and a shot line records `@n`, the engine steps since the previous shot went in, for a shot that cut one. Bullet Time builds on that instead of adding a second mid-run rule. The first draft here had "volleys" (a mid-run shot joins the live one and they settle once) and its own `@at` absolute stamp; both are dropped so the engine has one rule, one stamp and one replay path.

**Freeze.** A level (`freeze: N`, or `keystone.freeze=N`, which marks it custom) gives the player N freezes. In the rules a freeze is a shot that goes in while another runs: at most N may (Session `freezesLeft`; a shot fired while aiming spends nothing, and `freeze: 0` allows none, the rules' own "rapid fire off"). The game adds the pause: a freeze key stops the physics loop mid-shot, the world as it stands is aimed at and drawn (the camera is the player's), and a shot fired while frozen goes in through the rapid-fire path at the frozen step, so it cuts the running shot and is recorded `@n`. Resuming without firing costs nothing. A level with no `freeze` keeps rapid fire unlimited, as #184 has it. A timed shot (`@n`) whose level has no freeze left waits for the settle and goes in from aiming, recorded without `@n`, as a timed shot that outlasts the shot before already does (`rapidDue`), so a line that asks for too many cuts plays the same headless and on the page.

**Replay, settled (2026-11-05, PR 4).** The first draft drained the pipelined read-back before a frozen shot. It needs none: the world drawn and aimed at is `Driver.snapshot`, which is exactly the state the cut is taken on, and the spawn goes in at the engine's step as every rapid shot's does. A freeze only stops the clock, so a frozen line is a rapid-fire line and replays through the one path. keystone-lab `freeze.test.ts` plays the page's loop headless (step, freeze for 120 frames reading the world, fire, play on) and replays its text bit for bit on a serial and a pipelined driver; the frozen shot lands at the same engine step on both. Alternatives considered: drain before the frozen shot (the cut then sees one step newer on a pipelined driver, but a replay would have to drain at the same point, which the line does not record: a second replay path), and a budget of pauses rather than of shots (free pauses are harmless, and a pause that fires nothing changes nothing to replay).

## M2 Bullet Time

Freeze as an option on any level (`keystone.freeze=3`), plus Stage 1 levels scored on what the volley achieves.

**In the game (PR 5).** On a level with a budget, key T (or the HUD's Freeze button) freezes a running shot while a freeze is left. The physics loop holds (`active` is false, so the pacer owes nothing on resume), the collision sound pauses, the HUD shows FROZEN in place of the slow-motion tag and a Resume button, and aiming works while frozen even with rapid fire off (`keystone.rapid=0`). A shot fired while frozen goes in through the rapid-fire path and the world resumes. T again resumes free. The HUD counts freezes left of the level's. The viewer's Keystone panel has a freezes box (empty: the level's own) that sets `keystone.freeze`. The camera is untouched: freezing never moves it. Echo (each retry re-fires the earlier volley at its steps) reuses the `@n` replay and follows once freeze is in play. Live chain is later.

## Steps

| # | PR | Lands with |
|---|---|---|
| 1 | C1 core: `pull` item, shot text, record code, remove event, nominal energy, refusals | keystone tests: a pull drops the structure above it on the reference engine; replay of a pull line is exact; crowns, heritage and pulled bodies refused; record and text round trip |
| 2 | C1 in the game: pick and pull, outline the block under the cursor, puff and cue | game unit tests for the pick rule; e2e pull on Rapier |
| 3 | M1 levels U1 to U3, `hold` objective and `pulled` metric | level validation; each level's puzzle checked on the reference and Rapier; hold tally, stamp and metric unit tests |
| 4 | C2 freeze on top of rapid fire (#184): `freeze` in the level and `keystone.freeze`, the budget in the rules, a timed shot past it waits for the settle | keystone tests: a frozen line replays bit for bit serial and pipelined; the budget is spent only by a shot that cuts one; freeze is hashed, validated and marks the level custom; level and scene files carry it |
| 5 | M2 in the game: freeze key, HUD budget, viewer box | e2e freeze, fire, resume on Rapier |
