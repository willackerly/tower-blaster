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
- Game page (`play.ts` with `KeystoneEnv.duel`): owner ink tints each side's blocks (kings glow a little), the HUD shows whose turn it is and from which side, each keep's standing share (or points) and shots left, and the rack chips show only the current player's rack. A shot from the wrong side is refused with a banner, and the HUD says so while the player aims there. The camera never moves by itself (the 2026-11-02 camera rule): the player turns the view to their side.
- **Turn pace (C4's 8 s cap):** a turn runs at its own pace for `turnSeconds` (8 s), then fast-forwards the rest of its settle. The alternative, a hard settle cap, would freeze bodies mid-fall into the next player's world (the world is frozen between shots), so a long collapse would read as a bug.

## Tests

- `packages/keystone/test/duel.test.ts`: both tables pass `validateLevel` for either player first; malformed duels are refused; arcs wrap; turns, refusals, the king rules (other king, own king, both), the end-of-racks win and draw, lopsided racks, and Heraldry's per-shot attribution.
- `packages/game/test/modes-ui.test.ts`: the `?duel` key, the HUD block, the result card, and the door's section and switch.
- `packages/game/test/duel-e2e.test.ts` (headless Chromium, Rapier): refuses the wrong side and a missing item, eight alternating misses end in a draw on the result card with nothing recorded, and Rematch loads `D1-2` with Blue to fire.

## Not built yet (the roadmap's M4 list)

Sealed Orders (secret simultaneous shots behind a cover screen), Called Order, Undercut duel (needs C1 `pull`), and the draft phase. First-player advantage is handled by Rematch alternation; mirror tables already are mirrored. Playtest notes from G9 decide which comes next.
