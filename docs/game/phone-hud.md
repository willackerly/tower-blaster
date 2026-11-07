# The phone HUD and the result card's place (PT3, PT4)

Status 2026-11-06. From the first agent playtest ([agent-playtest-1.md](agent-playtest-1.md), rows PT3 and PT4, both P1). Will was away and had delegated the calls; the choices below are the recommended ones, written down so they can be undone. Code: `@tb/game` hud.ts (`hudHtml`, `slotAction`, `touchActs`, `resultHtml`, `cardActions`, `tallyHtml`), ui.ts (`DOCK_CSS`, the docked card's CSS), layout.ts (the Layout setting and its URL keys), play.ts (`showResult`, the tallying banner), door.ts (`seriesForward`). Tests: `game/test/phone-hud.test.ts` (pure), `game/test/phone-hud-e2e.test.ts` (browser, 390 x 844 and 844 x 390).

## What the playtest found

- **PT3.** Upright, the HUD covered 45 to 51% of a 390 x 844 phone and grew after the first shot (Leverage, Undo and Restart, Bank appeared one by one). Sideways (844 x 390), the result card's buttons were below the fold (the card scrolled, but nothing said so), and the HUD sat under the touch hint line.
- **PT4.** The centred card arrived on the very frame the round ended, over the collapse it was scoring (L1's "All crowns down, tallying" card covered the falling tower from step 36). INCOMPLETE cards made Next the primary button; the last level of a series (L5, B3, U3, the last trial) had no way on.

## What changed

**The HUD in two groups.** `hudHtml` returns `.st` (status: title, shot and Down or par and stroke, the Down bar, objective, crowns, heritage, freezes, leverage, the lot sheet's count) and `.tray` (aim tray: the rack's chips, power and height, an `.above` holder for the out-of-reach warning and the touch hint, the action slot, Undo and Restart). On the desktop page both stack in the one panel at the top left as before, apart from leverage moving up beside the other status rows.

**The action slot.** One place for the extra thing the player can do now (`slotAction`, by priority): Resume while frozen, Freeze while a running shot can be, Skip while a running shot can be skipped to its settle (PT6, #243; then "skipping to the settle…" in the slot itself, since the docked HUD hides the notes), Fire the first shot before shot 1, Bank while an outcome round can bank. These apply at different moments (a shot running, before the first, between shots), so the button the thumb looks for is always in the same place. The one overlap is a running shot on a Bullet Time level, which offers Freeze and Skip together: the slot then holds both (`slotHtml`), Freeze first, splitting the slot's width (docked) so neither wraps; the browser test checks the HUD's boxes are unchanged while both show and while it skips. Choosing one by priority would have hidden Skip from a touch player on every Bullet Time level (K is a keyboard key), and a second slot would hold an empty place on every other level.

**One size all round.** Every row a round can show is in the markup from its first frame: leverage before the first shot is `lev pre` (hidden, holding its place, drawn as ×0.00 so it wraps the same), and its "this shot" figure (`leverageRow`, shown from the second shot, from the leverage thread's #242) is `shot held` until then, the slot is `slot empty` when there is nothing to offer, and Undo and Restart are icons (↶ ↻, 44 px, with their names as labels) that are disabled until a shot is in. The touch hint and the out-of-reach warning sit just outside the tray (`.above`, absolutely placed), so neither changes its size. The browser test checks the strip and tray boxes are equal, to the pixel, before and after shot 1.

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

## Camera framing (PT3b)

Docked, the opening view keeps clear of the HUD **as measured**, not the old guess. `view.ts` `PORTRAIT_HUD_SHARE` (the top 40% of an upright phone, sized for the old tall panel) still applies to the panel and to Layout classic.

- **What is measured** (`play.ts` `dockedHud`, only while the dock CSS applies: a touch screen, the HUD carrying `kg-dock`, `DOCK_PORTRAIT` or `DOCK_SIDEWAYS`):
  - Upright: the strip, the tray, and the tray's `.above` holder (the touch and pull hints, the tray's width), each a band (`layout.ts` `hudInsets`). At 390 x 844 that is the top 10.5 to 12% and the bottom 24%.
  - Sideways: the rail's two groups (the left 27%), and the hints' box as a top band.
  - Boxes are picked by orientation, so `hudInsets` never reads a narrow hint as a rail (measuring every box, the test's first draft read the sideways hint as a right rail of 72%).
- **When:** at load, after the new level's HUD is drawn (its lot sheet and rows set: the block that makes the opening view now runs after them), and in the prefetch with the current HUD's band. The prefetch's band can differ from the next level's by a row; then the load searches again (B2's search is about 0.2 s). Measuring the next level's HUD in a hidden copy would make the two agree, at the cost of building its HUD state outside a load; not worth it for a cache miss.
- **How it frames** (`viewOf` `opts.hud`, `defaultInsets(aspect, hud)`): the measured band over the wide screen's 10% sky margin, in place of the guess; then joined with the level's own panels (`openingInsets`, the fuse panel). Wide, `fitBox` frames the screen's middle square, so `fitShares` turns the rail's share of the width into the part of that square it covers (844 x 390, a rail to 0.27: 0.002).
- **The search's mask** (`hudRects`, shape `'docked'`): nothing. The fit keeps every corner of the structure's box inside the screen less the measured band, so no body is under the HUD; the floating panel's top-left box (`WIDE_HUD`) stays for the desktop. The search's cache key carries the shape.
- **Sideways hints moved to the top**, right of the rail: they sat at the bottom beside the tray, over the structure's base (B1's wall, L1's tower). Counting them as a bottom inset would have shrunk every sideways opening by 12% for a hint that goes at the first shot; at the top they sit in the sky the fit keeps free anyway (they add about 2% to the top inset).
- **Result** (screenshots, 390 x 844): L1's tower stands whole between the strip and the tray, larger than before (it had its base under the hint and tray); B1's wall base is clear of the hint. Duels keep their framing (the Siege Table thread's).

Tests: `view.test.ts` (every series level, upright and sideways with the measured bands: every corner of the structure on screen clear of them, and the objectives in sight; L1's base under the tray on the guess and clear of it docked; `fitShares`, `defaultInsets`, `hudRects`), `phone-hud-e2e.test.ts` (L1, L2, B1 on the page at both shapes: the band the view used matches the HUD's boxes measured in the test, and the structure clears them; Layout classic measures nothing), and the PT1 gate (`sightlines-gpu.test.ts`, the docked HUD at 390 x 844).

## The Build panel (C9) on a docked phone (PT18, 2026-11-07)

A level with a build phase (trial T-W1 Domino Workshop, [placement.md](placement.md)) shows C9's Build panel. Docked (`ui.ts` DOCK_CSS, the panel being the HUD's sibling `.kg-build`):

- **Building:** the aim tray is put away (`body.kg-building`: nothing fires until Play, so its chips, power and slot would only promise what cannot happen) and the panel takes its place: upright a bottom sheet the tray's width, at most 46% of the height; sideways on the right below the Menu button, `min(340px, 42vw)` wide, at most the height under Menu; either scrolls if its rows need more. The status strip or rail stays, so the objective and the crowns stay in view.
- **Before and after building** (the level loaded as built, before its first shot, when B builds again): only the panel's Build button, under the Menu button in the column the upright strip leaves free (its 76 px margin) or at the top right sideways. The tray is back.

Measured (browser test, 1x): upright the building panel is 374 x 255 px at the bottom (30% of the height), clear of the strip (top 65 px) and Menu; sideways 340 x 318 px at the right, clear of the 220 px rail. The Build button is 61 x 56 px at (321, 64) upright and (775, 64) sideways, clear of the strip, rail, tray and Menu. `game/test/phone-door-build-e2e.test.ts` checks every box inside the screen and apart, Play and Cancel on top, a tap in the free band still placing a piece, and Play bringing the tray back, at 390 x 844 and 844 x 390. Layout Classic (`keystone.hud=panel`) keeps C9's own placement (top right, or docked at the bottom under 640 px wide).

Mason's Trial (M8, [masons-trial.md](masons-trial.md)) adds two buttons to the panel's turn row only when the held piece slides (Slide back / Slide out, with a plank or slab held) and puts its Test button in the tray's slot; `game/test/mason-e2e.test.ts` checks both on the docked phone, upright and sideways.

Alternatives: the panel above the tray (both visible) left about a third of an upright screen to build on, for a tray that does nothing while building; a collapsible panel (a Build chip that opens a sheet) hid Play and the tools behind a tap on every placement; the panel inside the HUD element (a third group) would put the editor's markup into the HUD's per-frame string, which the viewer and every HUD test read.

## The rack on a phone held upright (PT37, 2026-11-07)

On a 390 px wide screen the docked tray's rack scrolls sideways, and the second playtest's novice never found the cut-off chips ("Big grenade" sat past the edge on T-S3).

- `play.ts markRackOverflow` sets `.more` on the chips when they overflow and are not scrolled to the end. CSS cannot detect overflow, which is why this is done in script.
- While `.more` is set, the chips fade at their right edge (a mask) and a "›" cue shows at the tray's edge.
- Scrolling to the end clears it. It is re-measured on every HUD draw, on scroll and on resize.
- The power and height rows show their labels ("power", "height") as small capitals above their −/+ buttons, so the bare −/+ say what they change. The label is the row's existing first span, so the tray grows by one 10 px line.
- `phone-door-build-e2e.test.ts` (upright on T-S3) checks that every chip is whole or the cue shows, that scrolling to the end clears the cue, and that the row labels read power and height.

Alternatives considered:

- **Wrapping the rack onto two rows.** Every chip would be visible, but the tray would grow by a row and cover the structure that view.ts frames below it.
- **Smaller chips.** These fall under the 44 px touch target.
- **A "+N more" chip.** This works, but it adds a control. The fade and cue say the same thing without one.

## Not done here

- The copy on the door and in the HUD (PT18) followed this layout: [front-door.md](front-door.md), "Player-facing copy".
- A real-phone check (WebGPU on a phone) belongs to the next human or agent playtest round.
