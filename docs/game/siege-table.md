# Siege Table (M4): hot-seat duels

Mode M4 of [modes-roadmap.md](modes-roadmap.md): two players share one device and one structure, and take turns. Will decided on 2026-11-05 that it ships in the G9 playtest build behind a switch, under its working names.

## Play it

- Game page: `?duel=D1` (Two Keeps) or `?duel=D2` (Heraldry). A ruleset name works too: `?duel=keeps`.
- Front door: the **Siege Table · two players** section lists every table under the levels. `?duels=0` hides the section. That is the playtest build's switch, and the section is on by default.
- A duel is marked custom (it has no stars), so nothing goes into progress.

## Rules

| | Two Keeps (D1) | Heraldry (D2) |
|---|---|---|
| Table | two 3 x 3 keeps, six courses each, 21 cells apart; a king cube on each; a low wall between | one 3 x 3 tower, twelve courses, alternating gold and blue (gold at the bottom) |
| Racks | 3 cannonballs and 1 grenade each | 2 cannonballs and 2 marbles each |
| A turn | one shot from your own half of the launcher ring (Gold west, Blue east) | the same |
| Win | topple the other king (all its king blocks dropped more than 0.5 h, or out of the lot) | after both racks: the higher score |
| Lose | topple your own king; if both kings fall on one shot, the shooter loses | |
| Racks spent | the keep with the larger share standing wins; equal shares are a draw | equal scores are a draw |
| Scoring | | each shot scores the rival blocks it brought down, less your own |

Turns alternate. A player with no shots left is skipped. The first player alternates by **Rematch** on the result card (key R): `duelLevel(def, 1)` is the same table with Blue first. **Same start** replays the current order.

## How it works

- `@tb/keystone` `duel.ts`: `Duel` is a pure referee beside the Session. `refuse(shot)` gives a reason (`not-yours`, `rack`, `arc`, `over`) or null; `fired(shot)` hands the shot to the player; `settled(snapshot)` scores the shot from tagged reductions (`groups.ts`, C6) and passes the turn. The duel level's rack is both racks interleaved in turn order. The level is scored on outcome, so it never ends by itself before the racks are spent, and the page banks it once the duel is decided. A duel replays as (level, shots), and who went first is part of the level.
- `duels.ts`: the tables, plus `DUEL_NAMES`, the one place every display name lives (the mode, the rulesets, the tables). Renaming is a one-line change.
- Game page (`play.ts` with `KeystoneEnv.duel`): owner ink tints each side's blocks (kings glow a little), the HUD shows whose turn it is and from which side, each keep's standing share (or points) and shots left, and the rack chips show only the current player's rack. A shot from the wrong side is refused with a banner that says which way to drag (see Whose side, below).
- **Turn pace (C4's 8 s cap):** a turn runs at its own pace for `turnSeconds` (8 s), then fast-forwards the rest of its settle. The alternative, a hard settle cap, would freeze bodies mid-fall into the next player's world (the world is frozen between shots), so a long collapse would read as a bug.

## Whose side: the turn view, the arc and the cue

Will, 2026-11-06: "it's hard to tell where you need to rotate to", and reset the view to the centre of the side whose turn it is. `packages/game/src/duel-view.ts` adds three aids. All of them are render-only, so nothing here reaches the physics or a recorded duel.

| Aid | What it does | Default | Off |
|---|---|---|---|
| Turn view | The duel opens on the middle of the first player's arc. Each time the turn passes, the camera swings over 1 s (eased, the short way round) to the middle of the next player's arc. It uses the level's opening framing seen from there, at `DUEL_PITCH` 26 deg. Any orbit, pan, zoom or shot by the player stops the swing where it is. | on | `keystone.turnview=0`, or **Duel turns: Leave it** under Advanced settings on the door |
| Arc | The player to fire's arc of the launcher ring is dotted on the ground in their ink between shots. Beads are about 1.25 cube edges apart, and the ends sit exactly on the arc's ends. | on | `keystone.arcs=0` |
| Cue | While the view is outside the arc, the HUD says which way to drag to reach it the shorter way ("Drag right ▸ to turn to Gold's side"; "Two fingers ..." on a touch screen). A shot refused for its side says the same on its banner. | always | |

The turn view is the one exception to the 2026-11-02 camera rule (the camera moves only on player input). Will asked for it, and it only runs in a duel at a turn change. The Duel turns setting and its URL key keep the old behaviour one click away.

Choices made:

- **Pitch 26 deg, not the level framing's 12.** Seen from the middle of a side, D1 lines up end on: your own keep and king stand in front of the other keep. A projection of the keeps' boxes shows how much of the far keep clears the near one: 33% at 12 deg, 77% at 18 deg, all of it from 24 deg. 26 keeps a margin. `duel-view.test.ts` pins it: all of the far keep shows from 26 deg, and less than half from 12 deg. Looking from off the middle of the arc would also clear the line, but it is not the middle Will asked for.
- **Swing, not cut.** A cut would leave the next player at the same table from the opposite side with no sense of where they now stand. The swing shows the table turning to them. It is short (1 s) and any input takes the camera back. A critically damped spring, as the follow camera uses, takes about 2.3 s to settle, which is too slow for half a turn of the table.
- **The arc on the ground, not at launcher height.** Beads floating 1 m up read as string lights (as the first blast-reach zone did, `render/src/reach.ts`). On the ground they read as a line marking your side. Only the side to fire is shown, so the table stays clean.
- **The cue in drag words.** "Drag right" maps exactly to the input (`orbitDrag`: dragging right raises the launcher's azimuth). Compass words ("from the west") stay in the turn line for orientation. The test drags from every azimuth off the arc and checks that the cue's way gets there no later than the other way.

## Tests

- `packages/keystone/test/duel.test.ts`: both tables pass `validateLevel` for either player first; malformed duels are refused; arcs wrap; turns, refusals, the king rules (other king, own king, both), the end-of-racks win and draw, lopsided racks, and Heraldry's per-shot attribution.
- `packages/game/test/modes-ui.test.ts`: the `?duel` key, the HUD block, the result card, and the door's section and switch.
- `packages/game/test/duel-view.test.ts`: each side's view looks from the middle of its arc at `DUEL_PITCH`, on a wide screen and on an upright phone (clear of the HUD). On D1 the far keep shows whole. The cue's drag reaches the arc from every azimuth, no later than the other way. The swing goes the short way round, lands exactly and lets go on a grab. Arc beads lie on the ring, end to end, in ink.
- `packages/game/test/duel-e2e.test.ts` (headless Chromium, Rapier): refuses the wrong side and a missing item, eight alternating misses end in a draw on the result card with nothing recorded, and Rematch loads `D1-2` with Blue to fire. Each turn comes to rest on the middle of its own side after a swing that drew frames in between, and the arc shows only between shots. With `keystone.turnview=0&keystone.arcs=0` the camera stays put across a turn and no arc is drawn. The HUD and a refused shot's banner name the way to drag.

## Not built yet (the roadmap's M4 list)

Sealed Orders (secret simultaneous shots behind a cover screen), Called Order, Undercut duel (needs C1 `pull`), and the draft phase. First-player advantage is handled by Rematch alternation; mirror tables already are mirrored. Playtest notes from G9 decide which comes next.
