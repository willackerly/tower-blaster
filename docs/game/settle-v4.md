# Settle v4 as the outcome default (agent playtest PT6, PT6b)

**Status.** Outcome levels settle by v4 since PT6b. Par levels keep v1. The levels with cast stars pin v3 until a v4 recast:
- B1 to B3 (`settle: 'v3'` in `big-levels.ts`), cast on Metal;
- F1 to F5 (`fuse-levels.ts shipped`) stay on v3 for good: a frame can drop a storey, stand past v4's 2 s window and then topple (fuse-and-fold.md, "Settle rule", from a v4 recast of all five);
- A1 to A5 (`aftershock-levels.ts shipped`), energy stars cast on the reference.

## The rule

v4 is v3, or a steady collapse. The collapse D must stay within `STEADY_D` (0.005) of where a run began, for `STEADY_STEPS` (120 steps, 2 s of sim), however many bodies still move (`rules.ts settleUpdate`).

v3 ends a shot only when nothing live moves faster than 0.5 m/s and D and the displaced count hold still to 1e-4 for 60 steps. On a big level, debris rolling across the lot keeps one or two bodies above that speed for many seconds after the collapse has stopped changing. The shot then runs to the 30 s cap with a Down% that reads the same the whole time (PT6, agent playtest round 1).

Like every rule, v4 also holds while the ammo is still in flight (PT10, `ammoInFlight`), so a steady D before the first impact never ends a shot.

**v4 also counts no run while a weapon is still to go off** (`rules.ts settleHeld`). Session.observe's `hold` covers a live fuse, a charge or blast due later, and a quake still shaking. Every rule refuses to settle during a hold, short of the cap. But under v4 the steady-D run kept counting through the hold. A frame standing still before its charges had a full 120-step run by the time the last charge fired, so the shot settled on that step, before the charge did anything. This showed up in Fuse & Fold's v4 recast (#275): 5 to 8 plays a level on F2 to F5. One case is F3's line `plunger.2.0.1.54.5.60.0.114.4.114.8.114.3.120.6.120.7.120` (nudge 1): v4 ended at step 421 with D 0.002, v3 at 492 with 0.289.

The fix makes v4 treat a hold like a flight: every run starts over and only the cap settles, so the runs start when the hold ends. With it, that line ends at step 492 with 0.289, the same as v3 (`keystone-lab/test/settle-hold.test.ts`; `session.test` checks the mechanism on any hold).

| Option | Effect | Verdict |
| --- | --- | --- |
| v4 resets its runs during a hold (chosen) | v1 to v3 stay byte-identical, so every cast stands. No v4 level has cast stars, and the hash is unchanged (the rule's name is) | the bug is v4's: its steady run is the one that fills during a still pre-charge wait |
| Every rule resets during a hold | v3's frozen run and the v2+ quiet run have the same shape | moves F1 to F5 and A1 to A5 (fuses and quakes, cast under v3) and breaks their stars; v3 needs the stricter frozen test, which held F3 |
| A new v5 | keeps v4 for anyone who cast with it | nothing was cast under v4, so a new rule name would only add a hash |

The case that remains, for every rule: a structure with nothing awake settles at once (from `SETTLE_MIN`). On the first step after a hold, that state already shows the event, because `arsenal.pending` holds until the state after the event's step. A prox bomb mostly goes off in flight, where the flight already holds every run. On B1's ace line (reference, v4), 1 of its 74 held steps had the ammo out of flight, and the line settles at the same steps (717, 1116, 1421) with the same D (0.947) with or without this fix. So B1 to B3's v4 casts (#272, bombs and rams; a ram has no fuse) are not expected to move. B2 and B3 were not replayed (too slow on the reference here). Game TailSkip (pacing only) still reads D's steady run as before.

## Why the flip changes hashes, and what that touches

The settle rule is part of the level hash, because it decides the step at which the next shot fires. So changing the default moves the hash of every outcome level that does not name its rule:

- **Moved:** every `T-*` trial and U1 to U3 (34 levels). None of them has cast stars or a hash-pinned record, so nothing visible is lost.
- **Kept:** the par levels (L1 to L5, the Rube Lab), B1 to B3, F1 to F5 and A1 to A5. The B, F and A levels now name `settle: 'v3'`, so their casts (stars.json), showcase lines and the B1 opener all stand unchanged.

A1 to A5 were cast on the f64 reference, so their v4 recast can run in the cloud. F1 to F5 were recast under v4 and stay on v3 (above). Moving B1 to B3 to v4 means dropping their pin and recasting them on Metal under v4, with the same procedure as their level docs (about 55 min for B1, about 3.5 h for B2, and two seeds plus the extension for B3). That is a Mac job, roadmap row PT6b.

**A level cast before this flip and merged after it** fails its stars-hash test (`stars-file.test`, or its family's own) the moment it meets main. Pin it to `settle: 'v3'` the same way, or recast it under v4.

## Alternatives considered

| Option | What it costs | Verdict |
|---|---|---|
| Flip the default for every outcome level, B1 to B3 included, now | B1 to B3 show no stars until a 7 to 8 h Metal recast lands | Rejected: PT7 wants stars on every rated level, and the Mac was offline |
| Flip with B1 to B3 pinned to v3 | The biggest levels keep v3 until their recast. On the players' engine, Skip (K) and the tail fast-forward already cut their waits (PT6, #243) | **Chosen**: no star is lost, and the flip is one atomic step |
| Re-stamp the v3 stars with the v4 hashes | Nothing to run | Rejected: a cast holds only against the hash it was played on (the stars contract in `level.ts`). Replays here end on the same D in most lines but not all, and later shots fire on a different world |
| Keep v4 opt-in | Nothing | Rejected: the replay evidence below passes the row's rule |

## Evidence: paired replays on the f64 reference

`pnpm keystone:settle-study playtest/agent-1/report.json --engine ref --rule v3|v4 --max-bodies 2000` replays every recorded line of agent playtest round 1 under each rule. The B1 lines are the only big level under 2,000 bodies; B2 and B3 do not finish inside the cloud's 2 h job limit and go to the Mac. Par lines (L1 to L5) are left out, since the flip does not touch them.

Pass rule (roadmap PT6 and PT6b):
- median big-level fire-to-settle at most 8 s;
- no shot at the cap;
- every final D within 1% of v3's.

"Within 1%" is read as 0.01 of D (one point of Down%), since many trial lines end near D 0, where a relative rule means nothing.

Paired outcome lines: 19 (3 on B1). Shots: 55.
- Shots at the 30 s cap: v3 3, v4 0.
- Fire-to-settle, every shot: median v3 2.2 s, v4 2.2 s; mean v3 4.4 s, v4 2.7 s.
- B1 (the one big level under 2,000 bodies): median v3 7.6 s, v4 6.7 s; longest v3 30.0 s, v4 8.0 s.
- Final D: largest change 0.0031; 16 of 19 lines end on the same D (to 5e-5).

| Level | Line | v3 waits (s) | v4 waits (s) | v3 final D | v4 final D | change |
|---|---|---|---|---|---|---|
| B1 | B1-line | 30.0 / 7.6 / 5.4 | 7.0 / 6.7 / 5.1 | 0.9471 | 0.9471 | +0.0001 |
| B1 | B1-novice | 8.2 / 7.4 | 7.1 / 5.3 | 0.5661 | 0.5692 | +0.0031 |
| B1 | B1-novice | 2.3 / 8.0 | 2.3 / 8.0 | 0.6453 | 0.6453 | +0.0000 |
| T-S1 | T-S1-novice | 2.2 / 3.1 / 3.2 | 2.2 / 3.1 / 3.2 | 0.0000 | 0.0000 | +0.0000 |
| T-S12 | T-S12-novice | 2.1 / 2.0 / 1.6 | 2.1 / 2.0 / 1.6 | 0.0000 | 0.0000 | +0.0000 |
| T-S2 | T-S2-novice | 6.2 / 4.5 / 30.0 | 3.1 / 3.1 / 3.0 | 0.0066 | 0.0052 | -0.0014 |
| T-S3 | T-S3-novice | 10.2 / 4.3 / 2.6 | 5.7 / 4.5 / 2.6 | 0.0964 | 0.0964 | -0.0000 |
| T-S3R | T-S3R-novice | 30.0 / 2.8 / 2.4 | 4.4 / 2.8 / 2.4 | 0.0060 | 0.0060 | -0.0000 |
| T-S8 | T-S8-novice | 2.8 / 2.8 / 3.1 | 2.8 / 2.8 / 2.2 | 0.0000 | 0.0000 | +0.0000 |
| T-X1 | T-X1-novice | 5.4 / 1.5 / 0.8 | 5.4 / 1.5 / 0.8 | 0.3939 | 0.3939 | +0.0000 |
| T-X2 | T-X2-novice | 0.5 / 0.5 / 0.8 | 0.5 / 0.5 / 0.8 | 0.0841 | 0.0841 | +0.0000 |
| T-X3 | T-X3-novice | 4.8 / 4.2 / 1.9 | 4.8 / 4.2 / 1.9 | 0.0817 | 0.0817 | -0.0000 |
| T-X3B | T-X3B-novice | 8.8 / 2.1 / 1.7 | 8.5 / 2.1 / 1.7 | 0.0697 | 0.0697 | -0.0000 |
| T-X4 | T-X4-novice | 11.0 / 2.1 / 3.3 | 7.7 / 2.2 / 2.6 | 0.4412 | 0.4412 | +0.0000 |
| U1 | U1-novice | 0.5 / 1.7 | 0.5 / 1.7 | 0.8104 | 0.8104 | +0.0000 |
| U1 | U1-novice | 1.1 / 0.5 | 1.1 / 0.5 | 0.4522 | 0.4522 | +0.0000 |
| U2 | U2-novice | 1.1 / 0.5 / 0.5 | 1.1 / 0.5 / 0.5 | 0.4248 | 0.4248 | +0.0000 |
| U3 | U3-novice | 0.5 / 0.5 / 0.5 / 0.8 | 0.5 / 0.5 / 0.5 / 0.8 | 0.0120 | 0.0120 | +0.0000 |
| U3 | U3-novice | 0.5 / 0.5 / 0.5 / 0.5 | 0.5 / 0.5 / 0.5 / 0.5 | 0.0000 | 0.0000 | +0.0000 |

Seven more trial lines (the heaviest, under v3 or v4) did not finish in the cloud before its jobs were stopped. The Mac's replay (`--only B1,B2,B3,T`, roadmap PT6b) runs them along with B2 and B3, and its numbers land here with the B1 to B3 unpin and recast.

## A level's own end (agent playtest PT32)

Round 2 of the agent playtest (docs/game/agent-playtest-2.md, rank 14) found solved Rube Lab runs sitting to the 10 s cap after the bell had rung, and Aftershock's A4 line taking 12.7 s.

**Rube Lab: `LevelDef.end = { on: 'rung', after: 1.5 }`** (`rules.ts LevelEnd`, `checkEnd`). A run settles 1.5 s after every bell of the bell objective has rung, whatever is still rolling. The end is one more way the settle rule settles: `settleUpdate`'s `done` keeps a run of steps on which the condition holds, next to the quiet, frozen and steady runs. Like them, it never settles before `SETTLE_MIN`, and a flight or a hold restarts it (`Session.observe` passes `met` false while a weapon is still to go off). The cap still ends a run that never rings, so a slow contraption still fails at 10 s. A bell stays rung, so the outcome is decided at the ring.

On the reference, every recorded build of RL1 to RL5 (10 builds) still clears, and each now ends exactly 90 steps after its ring. Before, 8 of the 10 ran to the 600-step cap, and the other two ended 140 and 254 steps after the ring. The end is in the hash, so Rube Lab levels hash anew. They carry no cast stars (their stars are the parts par), so the only loss is the playtest's per-hash progress. The row's verify asked that RL1's build settle in 5 s or less, but RL1's par build (the span) rings at step 480 (8 s), so its run is now 9.5 s, and the fill build's 5.4 s.

| Option | Verdict |
| --- | --- |
| A per-level end inside the settle rule (chosen) | one settle path; replays, casts, undo checkpoints and the HUD all see the same step |
| The game ends the round on the ring | a second settle path: the cast tools and replays would end elsewhere |
| A shorter cap on Rube Lab levels | a slow contraption that rings at 9 s (RL5's slab builds ring at steps 480 to 550) would fail |
| End every bell level at its ring, with no field | changes behaviour without a hash change, and is not per level |
| End any level once its objective is met | only a bell is latched: a crown can be judged down and a heritage block can still break before the settle |

**Aftershock: no end condition.** The mode's job is done when the quake is over and the scene is at rest, and that is what the settle rule decides. Aftershock already holds the shot open through the quake. A1 to A5 are pinned to v3 for their cast stars, and on the reference their aces settle 195 to 423 steps after the quake, except A4 at 619. The towers are still falling and rocking for most of that, and heritage is judged standing at the settle, so ending earlier would judge a rocking tower. A4's 619 is v3's frozen run waiting on rolling debris. Under v4 A4 settles 206 steps after the quake (D 0.1521 against 0.1552), and the other four settle at the same step or within 14 steps of v3. So Aftershock's part of PT32 is the A levels' v4 unpin and recast, the same as the B levels' (PT6b).

