# The phone HUD and the result card's place (PT3, PT4)

Status 2026-11-06. From the first agent playtest ([agent-playtest-1.md](agent-playtest-1.md), rows PT3 and PT4, both P1). Will was away and had delegated the calls; the choices below are the recommended ones, written down so they can be undone. Code: `@tb/game` hud.ts (`hudHtml`, `slotAction`, `touchActs`, `resultHtml`, `cardActions`, `tallyHtml`), ui.ts (`DOCK_CSS`, the docked card's CSS), layout.ts (the Layout setting and its URL keys), play.ts (`showResult`, the tallying banner), door.ts (`seriesForward`). Tests: `game/test/phone-hud.test.ts` (pure), `game/test/phone-hud-e2e.test.ts` (browser, 390 x 844 and 844 x 390).

## What the playtest found

- **PT3.** Upright, the HUD covered 45 to 51% of a 390 x 844 phone and grew after the first shot (Leverage, Undo and Restart, Bank appeared one by one). Sideways (844 x 390), the result card's buttons were below the fold (the card scrolled, but nothing said so), and the HUD sat under the touch hint line.
- **PT4.** The centred card arrived on the very frame the round ended, over the collapse it was scoring (L1's "All crowns down, tallying" card covered the falling tower from step 36). INCOMPLETE cards made Next the primary button; the last level of a series (L5, B3, U3, the last trial) had no way on.

## What changed

**The HUD in two groups.** `hudHtml` returns `.st` (status: title, shot and Down or par and stroke, the Down bar, objective, crowns, heritage, freezes, leverage, the lot sheet's count) and `.tray` (aim tray: the rack's chips, power and height, an `.above` holder for the out-of-reach warning and the touch hint, the action slot, Undo and Restart). On the desktop page both stack in the one panel at the top left as before, apart from leverage moving up beside the other status rows.

**The action slot.** One place for the one extra thing the player can do now (`slotAction`, by priority): Resume while frozen, Freeze while a running shot can be, Fire the first shot before shot 1, Bank while an outcome round can bank. These never apply at once (a shot running, before the first, between shots), so a single slot loses nothing, and the button the thumb looks for is always in the same place. The thread that adds a settle Skip (PT6) puts it in this slot too.

**One size all round.** Every row a round can show is in the markup from its first frame: leverage before the first shot is `lev pre` (hidden, holding its place, drawn as ×0.00 so it wraps the same), the slot is `slot empty` when there is nothing to offer, and Undo and Restart are icons (↶ ↻, 44 px, with their names as labels) that are disabled until a shot is in. The touch hint and the out-of-reach warning sit just outside the tray (`.above`, absolutely placed), so neither changes its size. The browser test checks the strip and tray boxes are equal, to the pixel, before and after shot 1.

**Docked on a phone** (`DOCK_CSS`, touch screens, the game page's HUD carrying `kg-dock`):

- *Upright* (portrait, at most 640 px wide): the status is a strip at the top, clear of the Menu button, its rows flowing as short pairs ("Shot 1 Down 17%" with the Down bar beside it, then the objective's text, crowns, heritage, freezes, leverage); the tray is at the bottom: chips, then power (− bar +) and height (− ↕ 13.5 m +) on one row, then the slot and the two icons. The page's own hint line hides; the tray's hint shows above it until the first shot.
- *Sideways* (landscape, at most 500 px tall): both down a rail on the left, `clamp(200px, 28vw, 250px)` wide, the status at its top (scrolling if a long sheet ever needs it) and the tray at its bottom; the hint sits to the tray's right.

Measured (browser test, Rapier, 1x): upright the strip and tray together are 26.4% (L1, L2) to 28.9% (B1 with Bullet Time, the tallest status) of the screen's height, from 45 to 51% before; sideways the rail ends at 27.0% of the width. The test's bound is 30%.

**The result card** (PT4, `showResult` in play.ts):

- When the round is known to be over, a small **tallying banner** shows at the top (the level, then "All crowns down" or "Round over", and once the settle has scored it, the stamp and stars) instead of the centred card. Upright it sits over the status strip (whose text hides meanwhile), so it covers nothing new.
- The **card** waits `Layout.cardDelay` (1.2 s) of wall time after the settle, then slides in **docked**: on the right below the Menu button on a wide screen, as a bottom sheet (at most 58% of the height) upright, and on a phone held sideways in **two columns** (`.c1` name, lines and total; `.c2` stamp, stars, badge, lot sheet and buttons) at the bottom right. Its buttons are a sticky footer, so they stay on screen and on top whatever the card's length; the test checks every button's box is inside the screen and the topmost element at its centre, at all three sizes, without scrolling.
- After a **failed round** (no star: INCOMPLETE, TOPPLED) the primary button is **Retry**, Next secondary. Save session sorts last on the docked card so the primary stays on the first row.
- At the **end of a series** the forward button leads on: Spectacle (B3) to "Next: Chamber" (L1), the last chamber level (L5) to "Next: Undercut" (U1); after Undercut and the trials, which are unrated, it is "Levels", which opens the front door.
- The duel's card keeps its own markup (the Siege Table thread's) and gets the same timing and placement.

## Options (every behaviour above can be put back)

- Advanced settings → **Layout**: Docked (default) or Classic (the one panel, the centred card at once). Stored with the other settings.
- URL keys, each winning over the setting for the visit, dropped when the setting changes: `keystone.hud=dock|panel`, `keystone.card=dock|center`, `keystone.carddelay=<seconds>` (0 to 10).
- The viewer, which hosts the same HUD and card in its own panel column, keeps the classic behaviour (it passes no layout).

## Alternatives considered

1. **A collapsible HUD** (a strip that opens on tap). More of the screen for the scene, but one more control to learn and the objective out of sight; the touch-controls thread rejected it for the same reasons. Docking keeps everything visible in under 30%.
2. **Two DOM elements** (strip and tray as separate page elements with their own `innerHTML`) instead of one HUD element with two groups. Cleaner CSS, but play.ts, the viewer and every test address `.kg-hud` as one element and re-render one string; two groups inside it change nothing for them, and the HUD element simply covers the screen without catching a touch (`pointer-events: none`, the groups `auto`).
3. **Measuring the tray in script** to place the hint above it. Rejected for `.above`, a holder inside the tray positioned against it in CSS: no layout reads, no resize observer, and it moves with the tray in either orientation.
4. **Hiding rows until they apply** (as before) and re-framing when the HUD grows. The camera moves only on player input (Will's rule, #169), so a HUD that grows after the camera was framed covers the scene; reserving the rows costs one hidden line at most.
5. **The card at once but small** (a toast) instead of a delay. The playtest's complaint was the card arriving on the payoff; anything that lands on that frame competes with the collapse. A 1.2 s banner in a corner costs the player nothing (the buttons were never needed in that second) and shows the stamp early.
6. **Delay measured in sim steps** instead of wall time. Sim time runs at fast-forward after the last crown, so a step count would vary with the device and the pace; the player's eye is on wall time.
7. **CSS columns** for the sideways card instead of the `.c1` / `.c2` grid: columns cannot keep the buttons with the stamp in the right column and split unpredictably with the lot sheet's length.

## Camera framing

The upright camera frames the structure below the top 40% of the screen (`view.ts` `PORTRAIT_HUD_SHARE`), sized for the old tall panel. With the docked HUD the free band is from about 12% (under the strip) to about 76% (above the tray and the hint) of the height, and sideways right of the rail. Framing into that band is the next step: the objectives thread (PT1/PT14) is generalising `viewOf` to take screen insets, and this page will pass the band it measures from the HUD's boxes. Until it lands, L1 upright opens with the bottom 2% of its base under the tray's top edge (every other rated level clears it; measured from `viewOf` at 390 x 844).

## Not done here

- The copy on the door and in the HUD (PT18) follows this layout; that thread was told when it landed.
- A real-phone check (WebGPU on a phone) belongs to the next human or agent playtest round.
