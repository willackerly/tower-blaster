# Siege Table (M4): hot-seat duels

Mode M4 of [modes-roadmap.md](modes-roadmap.md): two players share one device and one structure, and take turns. Will decided on 2026-11-05 that it ships in the G9 playtest build behind a switch, under its working names.

## Play it

- Game page: `?duel=D1` (Two Keeps) or `?duel=D2` (Heraldry). A ruleset name works too: `?duel=keeps`.
- Front door: the **Siege Table · two players** section lists every table under the levels. `?duels=0` hides the section. That is the playtest build's switch, and the section is on by default.
- A duel is marked custom (it has no stars), so nothing goes into progress.

## Rules

| | Two Keeps (D1) | Heraldry (D2) |
|---|---|---|
| Table | two 3 x 3 stone keeps, 21 cells apart, with a two-course battlement round each top and a two-cube king in its middle, flush with it; a low plaster wall between (heights: "Balance" below) | one 3 x 4 stone tower, twelve courses: each side's colour makes the face the other side fires at (Blue the west face, Gold the east), and the core between is mixed, half and half, swapping course by course |
| Racks | 3 cannonballs and 1 grenade each | 2 cannonballs and 2 marbles each |
| A turn | one shot from your own half of the launcher ring (Gold west, Blue east) | the same |
| Win | topple the other king: both its cubes out of the battlement (each dropped more than 0.5 h below its place, so off the keep, or out of the lot), decided at the end of the round | after both racks, or once no more than 15% of the tower stands at the end of a round (`endShare`): the higher score |
| Lose | topple your own king; if both kings fall on one shot, the shooter loses; if they fall on two shots of one round, a draw | |
| Racks spent | the keep with the larger share standing wins; equal shares are a draw | equal scores: the side that brought down more of the other's blocks wins; else a draw |
| Scoring | | each shot scores the rival blocks it brought down, less your own (the HUD says "Knock down blue +1 · your gold −1"); the points show on the hand-over card, or float where the shot landed without it |

Turns alternate. A player with no shots left is skipped. **Rounds** (PT5, 2026-11-06): the duel is decided only at the end of a round. While a side that has fired fewer shots still has shots, it answers first, so a keep that falls to the first shot of a round is not the end: the other player gets their answer ("Blue's answer" on the hand-over card), and if it brings the first player's king down too, the round, and the duel, is a draw. Only when both keeps are already down is nothing left to answer. The first player alternates by **Rematch** on the result card (key R): `duelLevel(def, 1)` is the same table with Blue first. **Same start** replays the current order.

## How it works

- `@tb/keystone` `duel.ts`: `Duel` is a pure referee beside the Session. `refuse(shot)` gives a reason (`not-yours`, `rack`, `arc`, `over`) or null; `fired(shot)` hands the shot to the player; `settled(snapshot)` scores the shot from tagged reductions (`groups.ts`, C6) and passes the turn. The duel level's rack is both racks interleaved in turn order. The level is scored on outcome, so it never ends by itself before the racks are spent, and the page banks it once the duel is decided. A duel replays as (level, shots), and who went first is part of the level.
- `duels.ts`: the tables, plus `DUEL_NAMES`, the one place every display name lives (the mode, the rulesets, the tables). Renaming is a one-line change.
- Game page (`play.ts` with `KeystoneEnv.duel`): owner ink tints each side's blocks (kings glow a little), the HUD shows whose turn it is and from which side, each keep's standing share (or points) and shots left, and the rack chips show only the current player's rack. A shot from the wrong side is refused with a banner that says which way to drag (see Whose side, below).
- **Turn pace (C4's 8 s cap):** a turn runs at its own pace for `turnSeconds` (8 s), then fast-forwards the rest of its settle. The alternative, a hard settle cap, would freeze bodies mid-fall into the next player's world (the world is frozen between shots), so a long collapse would read as a bug.

## The agent playtest's fixes (PT5, 2026-11-06)

The first agent playtest ([agent-playtest-1.md](agent-playtest-1.md), row PT5) found four faults. The novice bot, clicking near the middle of the turn view, hit its own king (the view looked from the middle of the arc, straight down the line through your own keep), so the D1 duel ended on turn 2 with "Blue toppled its own keep". On the phone one shot ended the duel before Blue fired. Heraldry ran on at 95% down with nothing left to hit. And an empty dark bar showed over the Heraldry result.

| Fault | Fix | Where | Test |
|---|---|---|---|
| Middle click on your own king | The turn view looks over your shoulder: 30 deg round from the middle of your arc (`DUEL_YAW_OFFSET`), at the rival's blocks (`duelFocus`), framing everything but your own blocks; your keep shows at the lower left. On an upright phone the rival sits in the middle of the screen below the HUD (`PLAY_CENTRE_PORTRAIT`). | `duel-view.ts` `duelView`, `view.ts` `viewOf(…, focus, only)` | `duel-view.test.ts`: the middle click lands on the rival (D1) or the tower (D2) for both sides on a wide screen, an upright phone and a sideways one; of 400 jittered novice clicks none lands on your own keep and none on your half; the shot's arc clears your keep; your keep hides no part of the rival's |
| Your king wore the target's crosshair | The king of the player to fire is carved with the shield, the rival's with the crosshair; they swap with the turn | `duel-view.ts` `duelMarks` | `duel-view.test.ts` |
| No warning on your own keep | The HUD says "That's Gold's own keep" while the aim is on it (the shot is still allowed) | `duel-hud.ts` | `modes-ui.test.ts` |
| One shot could end it | Rounds (above) | `duel.ts` `answering`, `judge` | `duel.test.ts`; `duel-bot.test.ts`: 20 seeded novice duels on each table last at least 2 turns |
| No "pass the device" moment; a red "turn the view" line while the camera still turned | The hand-over card: a band low on the screen in the next player's ink ("Blue's turn", or "Blue's answer" and why) with what the last shot did ("Gold's shot: 21 blue blocks down · Blue's king stands"), over the turn view's swing, until a tap, a click, Enter or Space; a tap never fires. No aim preview, refusal, cue or warning while the swing runs or the card shows | `play.ts` `showHandoff`, `duel-hud.ts` `handoffHtml` | `duel-e2e.test.ts` |
| Heraldry scored silently, and ran on at 95% down | Each shot's points ("+8 blue −10 gold = −2") on the hand-over card, or floated where it landed without the card; the duel ends at the end of the round the tower is down to 15% | `duel-hud.ts` `scoreFloatHtml`, `duel.ts` `endShare` | `duel.test.ts`, `modes-ui.test.ts`, `duel-e2e.test.ts` |
| Empty bar over the result | A bank mid-duel (the harness's) showed the duel card with nothing in it. A duel cannot be banked before it is decided, and the card never shows empty | `play.ts` `bank`, `showResult` | `duel-e2e.test.ts`: no visible banner, card, hand-over or float with empty text, and `bank()` refused mid-duel |
| Copy | "1 pt"; the mode line does not repeat the table's name when it is the ruleset's ("Siege Table · two players") | `duel-hud.ts` | `modes-ui.test.ts` |

| Setting | Default | Off |
|---|---|---|
| Hand-over card | on | `keystone.handoff=0`, or **Hand-over: Skip** under Advanced settings on the door (a banner says whose turn instead) |

### Balance: the novice bot

`packages/game/src/duel-bot.ts` plays a duel headless the way the agent playtest's novice played the page: from each turn view it clicks about the middle of what shows (±0.18 of the screen, seeded), aims there as the page does (`pick`, `shotFor`), and fires the first item left in its rack at full power from the high launcher. Its counts decided the tables (`pnpm duel:bot D1,D2 40 1.6 5000` reproduces a row). Rapier in node, first player alternating, 40 seeds a row unless noted; the GPU engine's collapses differ, so treat these as a guide, and the next agent round's captures as the check.

| Table | Win (Gold / Blue) | First / second | Draws | Turns a duel | Note |
|---|---|---|---|---|---|
| D1 as it was (plaster keeps, king on top) | | 15 / 14 | 11 | 2.6 | almost any first cannonball took the king off |
| D1 with a one-cube king sunk level with the battlement | 17 / 17 | 16 / 18 | 6 | 5.1 | upright phone: 15 / 15, 10 draws, 3.5 turns |
| D1 stone, two-cube king in the battlement (PT5) | 18 / 14 | 18 / 14 | 8 | 4.7 | upright phone: 11 / 17, 12 draws, 3.4 turns |
| D2 as it was (whole courses, gold at the bottom) | 29 / 1 | | 0 | 3.4 | 30 seeds; same with the courses reordered to equal mean height (29 / 1); stone made it 21 / 5 |
| D2 quartered stone (PT5) | 42 / 38 | 32 / 48 | 0 | 7.7 | 80 seeds; upright phone 37 / 23 of 60 (first / second 29 / 31), 7.6 turns |
| D1 now (PT22: mirrored order, four-course keeps, two-course battlement, flush king) | 17 / 19 | 19 / 17 | 4 | 5.3 (median 6) | upright phone: 11 / 19, 10 draws, median 4 turns (six courses: median 2) |
| D2 now (PT22: faces by colour, mixed core, interleaved order, 1 cannonball + 3 marbles, 20 deg lead) | 19 / 21 | 17 / 23 | 0 | 8.0 | median margin 7 points; upright phone 14 / 25, 1 draw, margin 6.5 |

- **Why D1 changed.** With rounds, a plaster keep that loses its king to the first cannonball makes most duels a one-round draw (the answer does the same). Stone keeps (2.5 times plaster's density) with the king in the middle of a battlement take two or three good shots; the grenade is the keep-breaker. The king is two cubes tall, and both must drop: a one-cube king level with the battlement played as well but could not be seen from the turn view (the Opus look review: "you can't tell what to hit"), and the top cube that clears the battlement shows its ink and its crosshair.
- **Why D2 changed.** The bottom course never counts as down and the top always does, so whoever owned the bottom course won: Gold, 29 of 30. Reordering whole courses so both colours have the same mean height did not help (29 of 30), because the courses that survive are the bottom ones. Quartering each course north and south makes the tower the same to both sides with the colours swapped (a half turn maps one side's view onto the other's), so neither owns the bottom. Stone keeps it standing for all eight shots.
- **What the bot cannot say.** A novice's Heraldry shot scores about 0 on average (11 rival blocks down, 11 own), so between novices it is close to a coin flip; aiming at the rival's half of a course is the skill, and only people (or a smarter bot) show whether it is enough. D1 shows no edge for either seat; Heraldry leans to the second player (56% over 140 duels, who fires the round's last shot). Rematch alternates who starts, so a pair of duels evens it out.

A second perspective (an Opus look review of before and after captures, 2026-11-06) found the line of fire and the hand-over better, and asked for the rival king to be visible (done: the two-cube king), the card off the middle (done: low on the screen, with a Two Keeps summary), and no aim preview under the card (done). Left to their owners: the wall's blue-grey reads as Blue's (looks), aim beads swell near the lens (PT14's thread), spent balls and sparks at the hand-over (PT19's), and the HUD covers the top left of a 640 x 400 screen (PT3's).

Alternatives considered: for the view, the arc's middle with a higher pitch (the first cut: the far keep shows, but the line of fire and the middle of the screen still run through your own king), and a snap that moves the aim off your own keep (it would fight a player who means to fire over their keep); for one-shot endings, seating the king lower without rounds (the bot still ended 1-turn duels on a lucky first shot); for Heraldry's end, rebuilding a new tier (more to build and explain than ending on points).

## Agent playtest round 2: PT22 and PT34 (2026-11-07)

Round 2 ([agent-playtest-2.md](agent-playtest-2.md)) measured the tables on the GPU solver for the first time: Gold won 29 of 38 decided novice duels (D1 85%, D2 67%, p ≈ 0.002) though the seat was fair, D1 still ended in one round on a phone, and in D2 most shots netted about zero. PT34 listed what the match did not say or show.

### Why Gold won on the GPU (PT22)

The tables are the same to both sides under a half turn about the vertical axis, so a side bias has to come from something that is not. Three suspects, checked in order:

1. **The bot's views.** `duel-mirror.test.ts`: the same screen click from each side's turn view lands on half-turn image points (to 1e-6) and aims the same shot turned 180 deg (equal yaw, pitch, power and height), on both tables, wide and upright. Not the view.
2. **The solver.** A paired probe (`pnpm duel:bot D1 12 1.6 5000 --probe [--engine gpu]`): for each seed, Gold's first shot and Blue's, each on a fresh table, aimed from the same click at a rival block. Any difference is the engine's. On Rapier D1's pairs were level. On the GPU, under the turn view as it was before PT34's desktop back-off, the first pair differed (Gold 28 down and the king, Blue 24).
3. **The body order (a suspect, not shown to be the cause).** The GPU's colouring priority is a hash of the body index, and a contact's first body is the lower index, so the body order can matter. The tables did not list the two sides in mirrored order: a 3 x 6 x 3 keep expands into cubes west to east, so Gold's struck face (east) came last in its keep and Blue's (west) first.

**The order change.** D1 is Gold's half as unit cubes (`unitCubes`) followed by the same list turned half way round (`halfTurn`), body for body. D2's tower is shared, so its cubes interleave: each gold cube is followed by its blue image, so a gold-blue contact and its image have mirrored first bodies. Tests check both orders. On the GPU (SwiftShader) the settled D1 is off its mirror by 0.001 mm, and 12 paired first shots come out 11 level and one a block apart (Gold 21.1, Blue 21.2 rival blocks down a shot; kings 2 and 2).

**What that does not show.** A controlled contrast on the GPU (one geometry, round 2's six-course D1, in its old part order and in the image order; the current turn view; seeds 5000 to 5005) came out the same for both orders: every pair level, the settled table within 0.001 mm of its mirror either way. So the old order did not unsettle the mirror, and the one uneven pair above came under the old view. The image order stays (it makes the untouched table symmetric by construction, at no cost), but it is not the measured cause. Two things the first-shot probe cannot see remain:

- Once blocks leave the lattice, the GPU colours them by a hash of the index. No order makes that symmetric (hash(i) and hash(i + 72) differ), so from the second impact on the two sides' solves differ in rounding, and a chaotic pile turns rounding into outcomes. That gives each duel noise, not a side, unless something correlates it.
- Round 2 also played the old turn view and old tables (six courses; D2's two cannonballs), all of which this change replaced.

So PT22's answer is the full-duel measure, not the probe: `pnpm duel:bot D1,D2 40 1.6 5000 --engine gpu` with the pass line of each side 40 to 60% of decided duels. Results go in "Balance: the novice bot" above as they come (SwiftShader in the cloud; Metal on the Mac).

The `--swap` probe (`swappedOrder`: the sides' parts trade places in the list) trades whole parts and leaves the west-to-east order inside each, so it cannot test the order on its own; the controlled contrast above is that test.

Alternatives considered: give the GPU a mirror-aware priority (the engine would need to know the table's symmetry; every other level pays for it); re-mirror the snapshot after the presettle (the asymmetry comes back with the first impact); shuffle the body order per duel (each duel would still lean one way, and a duel would no longer replay from its level). If the full-duel measure still leans, the next suspect is the off-lattice hash priority above.

### D1: a lower keep

On the phone's upright view the novice's first cannonball hit the six-course keep low and felled it, king and all (paired probe at 0.462: 40 of 72 blocks and the king in 8 of 10 seeds), so 30 of 40 Rapier phone duels ended in round one. A deeper king (sunk a course into the keep) did not help (median 2 turns), and neither did a 5 x 5 plinth (median 2). Four courses did: median 4 turns upright. The battlement is two courses and the king is flush with it, so a lob onto the king pushes it down and a shot has to break the battlement first. The king rule already was the playtest's ask: both its cubes must drop half a course below their places, which only happens off the keep.

### D2: faces, one cannonball, and a lead

- **Colours by face.** Each side's colour makes the face the other side fires at (Blue the west face, Gold the east), and the core between them is mixed, half and half, swapping course by course. A shot at the face you see scores; one that brings the tower down costs your colour behind it.
- **One cannonball, three marbles.** With two cannonballs the second brought down about as much of your own colour as the rival's: median final margin 4.5 points over 40 Rapier duels (four cannonballs: 2; four marbles bring nothing down). One cannonball opens the face and the marbles pick at it: median margin 7.
- **The launcher's lead.** The tower stands at the centre of the launcher ring, so with the launcher behind the camera every shot ran straight away from the eye: the aim preview was a vertical stack of dots, 4% of the screen's width. `DuelDef.lead` puts D2's launcher 20 deg round the ring to the right of the view; the preview now crosses about 45% of the width (`duel-view.test.ts`). D1's keeps stand off the centre, so it needs none.

### PT34: what the match says and shows

| Fault | Fix | Where | Test |
|---|---|---|---|
| The goal was never stated; "west" and "east" mean nothing on a plain field | A goal line under the mode line: "Topple Blue's ⌖ king · protect your ⛨ king" (the stones' own marks) or "Knock down blue +1 · your gold −1"; the turn line says "from behind the gold keep" or "at the blue face" | `duel-hud.ts` `goalHtml`, `fromWhere` | `modes-ui.test.ts`; `duel-e2e.test.ts` (in the first frames) |
| D2's arc was a stack of dots | The launcher's lead (above) | `duel-view.ts` `launcherAz`, `play.ts` `aimAz`, `duel-bot.ts` | `duel-view.test.ts`: at least 25% of the width at 16:10, 16:9 and upright, under 10% without the lead |
| The phone hand-over card let the rack show through | On a touch screen the band is opaque and the table dimmed more | `duel-hud.ts` `DUEL_CSS` | `duel-e2e.test.ts` |
| Shots that dropped nothing, and the last shot, had no summary | Every settled shot has a line (`shotSummaryHtml`): "nothing down = 0" in Heraldry; the result card carries the last shot's | `duel-hud.ts` | `modes-ui.test.ts`; `duel-e2e.test.ts`: every hand-over and the result |
| The ending framed the winner's keep and said "keeps fell" | The turn view's last move swings to the whole table (`duelEndView`); the referee says "king" when the sides have kings ("both kings fell in one round") | `duel-view.ts`, `play.ts`, `duel.ts` `judge` | `duel-view.test.ts` (every block of both sides in frame), `duel-e2e.test.ts`, `duel.test.ts` |
| U undo and R restart offered in a hot-seat match; R also meant Rematch | The duel's hint line and key list have neither; R does nothing until the duel is decided, then it is Rematch (undo was already refused) | `ui.ts` `DUEL_HELP`, `DUEL_KEYS`; `play.ts` | `modes-ui.test.ts`; `duel-e2e.test.ts` (R mid-duel changes nothing) |
| Your own keep was cut by the desktop hint bar | On a desktop-shaped screen (aspect up to 2) the turn view backs off, 5% a step, until your own blocks are inside the screen and above the hint line (`OWN_IN_VIEW`); the rival stays in the middle, about a quarter smaller. Docked phones frame in the HUD band instead (next row) | `duel-view.ts` `duelView`, `ownInView` | `duel-view.test.ts` |
| PT30's duel part: on a docked phone the turn view framed under the old 40% guess, both keeps in the bottom fifth and your own under the tray (upright) or the rail (sideways) | The duel measures its HUD's band as single-player openings do (`play.ts` `dockedHud`, [phone-hud.md](phone-hud.md)); each turn view keeps its direction and is fitted into the screen less that band, the rival and both kings in it (`fitBox`); the end view likewise. The rail's side rows keep to one line sideways. The novice bot measures no band, so its phone numbers are on the old framing | `duel-view.ts` `bandView`, `duelEndView`; `play.ts`; `duel-hud.ts` CSS | `duel-view.test.ts` (both tables, both sides, 390 x 844 and 844 x 390; D1's own king outside the band without it); `duel-phone-e2e.test.ts` (the page measures the band, and Gold's and Blue's views keep both kings in it) |

| Setting | Default | Off |
|---|---|---|
| Duel aim (the launcher's lead) | on | `keystone.lead=0`, or **Duel aim: From behind** under Advanced settings on the door |

## Whose side: the turn view, the arc and the cue

Will, 2026-11-06: "it's hard to tell where you need to rotate to", and reset the view to the centre of the side whose turn it is. `packages/game/src/duel-view.ts` adds three aids. All of them are render-only, so nothing here reaches the physics or a recorded duel.

| Aid | What it does | Default | Off |
|---|---|---|---|
| Turn view | The duel opens over the first player's shoulder: 30 deg round from the middle of their arc, looking at the rival (since PT5, above). Each time the turn passes, the camera swings over 1 s (eased, the short way round) to the next player's. It is seen from `DUEL_PITCH` 26 deg. Any orbit, pan, zoom or shot by the player stops the swing where it is. | on | `keystone.turnview=0`, or **Duel turns: Leave it** under Advanced settings on the door |
| Arc | The player to fire's arc of the launcher ring is dotted on the ground in their ink between shots. Beads are about 1.25 cube edges apart, and the ends sit exactly on the arc's ends. | on | `keystone.arcs=0` |
| Cue | While the view is outside the arc, the HUD says which way to drag to reach it the shorter way ("Drag right ▸ to turn to Gold's side"; "Two fingers ..." on a touch screen). A shot refused for its side says the same on its banner. | always | |

The turn view is the one exception to the 2026-11-02 camera rule (the camera moves only on player input). Will asked for it, and it only runs in a duel at a turn change. The Duel turns setting and its URL key keep the old behaviour one click away.

Choices made:

- **Pitch 26 deg, not the level framing's 12.** Seen from the middle of a side, D1 lines up end on: your own keep and king stand in front of the other keep (33% of the far keep shows at 12 deg, all of it from 24). The first cut raised the pitch and kept the middle. It was not enough: the middle of the screen still ran through your own king, and the agent playtest's novice toppled it (PT5). The view now also looks from 30 deg round, at the rival.
- **Swing, not cut.** A cut would leave the next player at the same table from the opposite side with no sense of where they now stand. The swing shows the table turning to them. It is short (1 s) and any input takes the camera back. A critically damped spring, as the follow camera uses, takes about 2.3 s to settle, which is too slow for half a turn of the table.
- **The arc on the ground, not at launcher height.** Beads floating 1 m up read as string lights (as the first blast-reach zone did, `render/src/reach.ts`). On the ground they read as a line marking your side. Only the side to fire is shown, so the table stays clean.
- **The cue in drag words.** "Drag right" maps exactly to the input (`orbitDrag`: dragging right raises the launcher's azimuth). The turn line names where you fire from by the table, not the compass ("from behind the gold keep", "at the blue face"; PT34). The test drags from every azimuth off the arc and checks that the cue's way gets there no later than the other way.

## Tests

- `packages/keystone/test/duel.test.ts`: both tables pass `validateLevel` for either player first; malformed duels are refused; arcs wrap; turns, refusals, the king rules (other king, own king, both), the end-of-racks win and draw, lopsided racks, and Heraldry's per-shot attribution.
- `packages/game/test/modes-ui.test.ts`: the `?duel` key, the HUD block, the result card, and the door's section and switch.
- `packages/game/test/duel-view.test.ts`: each side's view looks from 30 deg off the middle of its arc at `DUEL_PITCH`, the rival in the middle of what shows, on a wide screen and on phones held either way; the middle click lands on the rival; the shot clears your keep; the kings' marks. The cue's drag reaches the arc from every azimuth, no later than the other way. The swing goes the short way round, lands exactly and lets go on a grab. Arc beads lie on the ring, end to end, in ink.
- `packages/keystone/test/duel.test.ts` (PT22): on both tables a half turn maps each side's blocks onto the other's and king onto king; D1 lists Blue's bodies as Gold's turned, in the same order, and D2 follows each gold body with its blue image; D2's faces are each one colour and its core half and half.
- `packages/game/test/duel-mirror.test.ts` (PT22): the same click from each side's turn view aims the half-turn image shot.
- `packages/game/test/duel-view.test.ts` (PT34): your own blocks clear the hint line on a desktop; D2's launcher lead, inside the arc, and its preview arc across at least a quarter of the width; the end view frames both sides. (PT30) On a docked phone, with the measured band, the rival and both kings inside it at both shapes, and the end view.
- `packages/game/test/duel-phone-e2e.test.ts` (PT30, headless Chromium, Rapier): at 390 x 844 and 844 x 390 the duel measures its band, and Gold's view and Blue's (after a miss and the swing) keep both kings inside it.
- `packages/game/test/duel-bot.test.ts` (node, Rapier): 20 seeded novice duels on each table last at least two turns and end decided; on D1 no novice click lands on its own keep.
- `packages/game/test/duel-e2e.test.ts` (headless Chromium, Rapier): refuses the wrong side and a missing item, eight alternating misses end in a draw on the result card with nothing recorded, and Rematch loads `D1-2` with Blue to fire. Each turn comes to rest over its own side's shoulder after a swing that drew frames in between, under the hand-over card (a tap dismisses it without firing), and the arc shows only between shots. Heraldry: a middle click hits the tower and its points float; a bank mid-duel is refused; nothing shows empty. With `keystone.turnview=0&keystone.arcs=0` the camera stays put across a turn and no arc is drawn. The HUD and a refused shot's banner name the way to drag.

## Not built yet (the roadmap's M4 list)

Sealed Orders (secret simultaneous shots behind a cover screen), Called Order, Undercut duel (needs C1 `pull`), and the draft phase. First-player advantage is handled by Rematch alternation; mirror tables already are mirrored. Playtest notes from G9 decide which comes next.
