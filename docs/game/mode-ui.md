# Each mode's own HUD and result card (PT23, PT27)

Agent playtest round 2 (`docs/game/agent-playtest-2.md`) found that **the new modes run on the projectile HUD**:
- Power and Height rows show during runs. "click: fire" and "drag: aim · lift: fire" help shows too, and Plunger and Quake rack chips (even in Rube Lab).
- Aftershock offers "Fire the first shot (F)" beside its own Start, and that opener plays the level's three-star quake.
- Rube Lab needs two start buttons: Play in the Build panel, then Go in the HUD.
- The cards use demolition rows. Rube Lab shows "Strokes 3,000" and "leverage ×0.43 (Brute)", and its HUD says Par 1 while the card says par 2.
- Aftershock stamps three-star clears "9% DOWN".
- No failed card says why, and a lost heritage is stamped only INCOMPLETE.

## The mechanism

`packages/game/src/mode-ui.ts` is one file. Each mode thread changes its own mode's content there.

- **`playMode(def)`** is read from the definition. `rube` is Rube Lab, objective `quake` is Aftershock, objective `fold` is Fuse & Fold, and everything else is `shot`.
- **`hudProfile(def)`** says which HUD rows the mode shows and names its one start verb. `hud.ts hudHtml` reads it as `HudState.profile`. When the profile is absent, the HUD is the projectile HUD.

  | Mode | Power, Height | Rack chips | "fire" help | Leverage row | Opener | Start verb |
  |---|---|---|---|---|---|---|
  | shot | yes | yes | yes | yes | yes | (the shot) |
  | fuse | no | no | no | yes | no | the Timeline's **Plunger** (Enter) |
  | fuse, domino fuses (F6 on) | no | no | no | yes | yes | the HUD's **Light the fuses** (key F): no Timeline, the dominoes are the delays |
  | quake | no | no | no | no | no | the designer's **Start the quake** (Enter) |
  | rube | no | no | no | no | as Run | **Run** |

  - The aim rows follow the mode, not the selected rack item. On a spent rack nothing is selected, and that is how Power and Height came back mid-run.
  - The help line's fire words sit in `.h-fire` spans, which `body.kg-nofire` hides. The touch help has a second wording for these modes (`TOUCH_LOOK`).
  - Rube Lab's head row is **Parts par N**, which is the par the card reads, and it has a **Bell** row in place of Crowns.
- **One Run in Rube Lab.**
  - While building, the Build panel's button is **Run** (Enter). It plays the build and releases the ball: `play.ts` sets `runPending`, and the frame loop fires the opener once the level as built has loaded and grown in.
  - The HUD's Run is hidden while building.
  - When not building (after Retry, or with `keystone.build=0`), the HUD's **Run: release the ball** (F) is the one start.
- **No opener plays the answer.**
  - `door.ts openerFor` no longer falls back to the first shot of a one-shot ace. That shot is the whole ace, and Aftershock's aces are one quake each.
  - A mode whose profile has no opener refuses key F as well.
- **`cardModel(def, score, facts, base)`** is what the card says. `hud.ts resultHtml` and `tallyHtml` draw it, and `play.ts cardFacts()` gives the facts from the session at the end.
  - **Every failed round gets a reason line** (`failReason`), in the objective's own measure. Examples: "24% folded, 60% needed", "1 of 2 condemned towers still standing", "2 of 3 crowns still standing", "The bell did not ring".
  - **HERITAGE LOST, in red,** replaces the stamp when a broken heritage failed the objective. Today that is quake and fold (`heritageFails`, from `objectiveMet`). Elsewhere heritage costs stars, as before ("Heritage cracked: 1 star lost").
  - `MODE_CARDS[mode]` then changes the sub line, rows, stamp, points and gold, and can add a `tip` after the reason:
    - **Rube Lab:** the sub line is "parts 2 / par 2". Rows are Bell (rung / not rung) and Parts (used / par). There are no points lines or total (a contraption's one plunger is no stroke) and no gold badge. A failed run is stamped NOT RUNG, with the tip "change the build and Run again".
    - **Aftershock:** the sub line is "1 quake · energy 151 J". A cleared round is stamped "2/2 CONDEMNED · HERITAGE SAFE". The points lines were already Condemned and Heritage. The tip is "try a stronger or longer quake, or another axis".
    - **Fuse & Fold:** the sub line reads "folded" and adds the spill. The fold reasons come from the shared `failReason`; on a domino-fuse level a misfire comes first ("2 columns never cut: a fuse did not reach its socket").
  - The words are a first draft from the playtest notes. The Fuse & Fold, Aftershock and Rube Lab threads own them.

## Option

`keystone.modeui=0`, the viewer's Scene panel (`modeui`), declared in `options/modeui.ts`. It draws the projectile HUD and card for every mode, as before. It is on by default. It has no door row, because PT37 is cutting Advanced settings down to about six.

## Tests

- `mode-ui.test.ts` (unit):
  - Every series level's mode.
  - In Fuse & Fold, Aftershock and Rube Lab, no Power, Height, chip or fire hint before or after the shot. Under `modeui=0` the spent quake rack showed Power, as the playtest saw.
  - Aftershock's slot has no opener.
  - No level's opener equals its one-shot ace (every series level, preaim 1).
  - Rube Lab's HUD says Run and Parts par N. Every RL level's HUD and card name the same par.
  - Rube Lab cards have no Leverage, Brute, Strokes, Combo, Total or Gold. Aftershock's stamp and sub line, and HERITAGE LOST in red.
  - The fold reasons.
  - A reason line on a failed card for every series level.
  - HERITAGE LOST only on quake and fold.
  - With `modeui=0` the card is identical to before.
- `mode-ui-e2e.test.ts` (page, Rapier):
  - A1, F1 and RL1 show no projectile rows, chips or fire help, before and after the start. `modeui=0` brings F1's chip and fire help back.
  - A1's aim view has one start, and F does nothing.
  - RL1 has exactly one Run at a time. The Build panel's Run releases the ball with no second press, and after Retry the HUD's Run is the one start.

## Alternatives considered

1. **A HUD per mode, as separate templates.** This gives full freedom, but the strip, tray, slot and reserved rows of the docked phone HUD (PT3) would then be built three more times and drift apart. A profile of row switches keeps one layout, which `phone-hud-e2e` already holds to its size budget.
2. **Hide the projectile rows by the selected rack item (as before), and fix the spent-rack case only.** This is the smallest change, but it is the rule that failed: whatever is selected, a mode with no projectile has nothing to aim.
3. **Keystone-side mode stamps and lines** (`outcomeScore` returning "CONDEMNED"). The stamp is also what progress, the door and the agent harness read. Changing it there changes saved records and stars audits, so the words stay in the card's model on the page and the score keeps its stable stamp. The tally banner reads the same model, so the two agree.
4. **Rube Lab's Run as a key only (Enter in the HUD) and keeping both buttons.** This keeps two visible start verbs, which is the confusion the judges named. With one button at a time, its place moves with the phase: the Build panel while building, the HUD otherwise.
