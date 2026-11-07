# Siege Table (M4): hot-seat duels

Mode M4 of [modes-roadmap.md](modes-roadmap.md): two players share one device and one structure, and take turns. Will decided on 2026-11-05 that it ships in the G9 playtest build behind a switch, under its working names.

## Play it

- Game page: `?duel=D1` (Two Keeps) or `?duel=D2` (Heraldry). A ruleset name works too: `?duel=keeps`.
- Front door: the **Siege Table · two players** section lists every table under the levels. `?duels=0` hides the section. That is the playtest build's switch, and the section is on by default.
- A duel is marked custom (it has no stars), so nothing goes into progress.

## Rules

| | Two Keeps (D1) | Heraldry (D2) |
|---|---|---|
| Table | two 3 x 3 stone keeps, six courses each, 21 cells apart; a battlement round each top with a two-cube king standing in its middle, its top cube clear of it; a low plaster wall between | one 3 x 4 stone tower, twelve courses, quartered: each course half gold, half blue (north and south), swapping course by course |
| Racks | 3 cannonballs and 1 grenade each | 2 cannonballs and 2 marbles each |
| A turn | one shot from your own half of the launcher ring (Gold west, Blue east) | the same |
| Win | topple the other king (all its king blocks dropped more than 0.5 h, or out of the lot), decided at the end of the round | after both racks, or once no more than 15% of the tower stands at the end of a round (`endShare`): the higher score |
| Lose | topple your own king; if both kings fall on one shot, the shooter loses; if they fall on two shots of one round, a draw | |
| Racks spent | the keep with the larger share standing wins; equal shares are a draw | equal scores: the side that brought down more of the other's blocks wins; else a draw |
| Scoring | | each shot scores the rival blocks it brought down, less your own; the points show on the hand-over card, or float where the shot landed without it |

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
| D1 now (stone, two-cube king in the battlement) | 18 / 14 | 18 / 14 | 8 | 4.7 | upright phone: 11 / 17, 12 draws, 3.4 turns |
| D2 as it was (whole courses, gold at the bottom) | 29 / 1 | | 0 | 3.4 | 30 seeds; same with the courses reordered to equal mean height (29 / 1); stone made it 21 / 5 |
| D2 now (quartered stone) | 42 / 38 | 32 / 48 | 0 | 7.7 | 80 seeds; upright phone 37 / 23 of 60 (first / second 29 / 31), 7.6 turns |

- **Why D1 changed.** With rounds, a plaster keep that loses its king to the first cannonball makes most duels a one-round draw (the answer does the same). Stone keeps (2.5 times plaster's density) with the king in the middle of a battlement take two or three good shots; the grenade is the keep-breaker. The king is two cubes tall, and both must drop: a one-cube king level with the battlement played as well but could not be seen from the turn view (the Opus look review: "you can't tell what to hit"), and the top cube that clears the battlement shows its ink and its crosshair.
- **Why D2 changed.** The bottom course never counts as down and the top always does, so whoever owned the bottom course won: Gold, 29 of 30. Reordering whole courses so both colours have the same mean height did not help (29 of 30), because the courses that survive are the bottom ones. Quartering each course north and south makes the tower the same to both sides with the colours swapped (a half turn maps one side's view onto the other's), so neither owns the bottom. Stone keeps it standing for all eight shots.
- **What the bot cannot say.** A novice's Heraldry shot scores about 0 on average (11 rival blocks down, 11 own), so between novices it is close to a coin flip; aiming at the rival's half of a course is the skill, and only people (or a smarter bot) show whether it is enough. D1 shows no edge for either seat; Heraldry leans to the second player (56% over 140 duels, who fires the round's last shot). Rematch alternates who starts, so a pair of duels evens it out.

A second perspective (an Opus look review of before and after captures, 2026-11-06) found the line of fire and the hand-over better, and asked for the rival king to be visible (done: the two-cube king), the card off the middle (done: low on the screen, with a Two Keeps summary), and no aim preview under the card (done). Left to their owners: the wall's blue-grey reads as Blue's (looks), aim beads swell near the lens (PT14's thread), spent balls and sparks at the hand-over (PT19's), and the HUD covers the top left of a 640 x 400 screen (PT3's).

Alternatives considered: for the view, the arc's middle with a higher pitch (the first cut: the far keep shows, but the line of fire and the middle of the screen still run through your own king), and a snap that moves the aim off your own keep (it would fight a player who means to fire over their keep); for one-shot endings, seating the king lower without rounds (the bot still ended 1-turn duels on a lucky first shot); for Heraldry's end, rebuilding a new tier (more to build and explain than ending on points).

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
- **The cue in drag words.** "Drag right" maps exactly to the input (`orbitDrag`: dragging right raises the launcher's azimuth). Compass words ("from the west") stay in the turn line for orientation. The test drags from every azimuth off the arc and checks that the cue's way gets there no later than the other way.

## Tests

- `packages/keystone/test/duel.test.ts`: both tables pass `validateLevel` for either player first; malformed duels are refused; arcs wrap; turns, refusals, the king rules (other king, own king, both), the end-of-racks win and draw, lopsided racks, and Heraldry's per-shot attribution.
- `packages/game/test/modes-ui.test.ts`: the `?duel` key, the HUD block, the result card, and the door's section and switch.
- `packages/game/test/duel-view.test.ts`: each side's view looks from 30 deg off the middle of its arc at `DUEL_PITCH`, the rival in the middle of what shows, on a wide screen and on phones held either way; the middle click lands on the rival; the shot clears your keep; the kings' marks. The cue's drag reaches the arc from every azimuth, no later than the other way. The swing goes the short way round, lands exactly and lets go on a grab. Arc beads lie on the ring, end to end, in ink.
- `packages/game/test/duel-bot.test.ts` (node, Rapier): 20 seeded novice duels on each table last at least two turns and end decided; on D1 no novice click lands on its own keep.
- `packages/game/test/duel-e2e.test.ts` (headless Chromium, Rapier): refuses the wrong side and a missing item, eight alternating misses end in a draw on the result card with nothing recorded, and Rematch loads `D1-2` with Blue to fire. Each turn comes to rest over its own side's shoulder after a swing that drew frames in between, under the hand-over card (a tap dismisses it without firing), and the arc shows only between shots. Heraldry: a middle click hits the tower and its points float; a bank mid-duel is refused; nothing shows empty. With `keystone.turnview=0&keystone.arcs=0` the camera stays put across a turn and no arc is drawn. The HUD and a refused shot's banner name the way to drag.

## Not built yet (the roadmap's M4 list)

Sealed Orders (secret simultaneous shots behind a cover screen), Called Order, Undercut duel (needs C1 `pull`), and the draft phase. First-player advantage is handled by Rematch alternation; mirror tables already are mirrored. Playtest notes from G9 decide which comes next.
