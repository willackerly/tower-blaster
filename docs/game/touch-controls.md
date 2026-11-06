# Touch controls (roadmap U4)

The game page plays by touch on a phone or tablet. Code: `packages/game/src/touch.ts` (the gesture state machine, pure) and its wiring in `play.ts`; tests `packages/game/test/touch.test.ts` (unit) and `touch-e2e.test.ts` (an emulated phone in headless Chromium, real multi-touch through CDP `Input.dispatchTouchEvent`).

## Gesture map

| Gesture | Does | Desktop equivalent |
|---|---|---|
| One finger down | Aims where it is: the arc preview and the lit block appear | Hover |
| Drag that finger | The aim follows it | Move the mouse |
| Lift it | Fires the aimed shot, where it lifted (a tap is a short drag) | Click without dragging |
| Second finger down while aiming | Calls the shot off; the two fingers now move the camera | (none) |
| Two fingers move together | Orbit: the midpoint's travel turns and tilts the view at the mouse drag's rate (0.005 rad per px) | Drag |
| Two fingers spread or pinch | Zoom: the camera distance is multiplied by old spread / new spread, within 3 to 200 m (`ZOOM_RANGE`), shared with the wheel (`zoomBy`) | Wheel |
| Tap a rack chip | Selects that ammo | Keys 1 to 4 |
| Tap − or + by the power bar | Power down or up by 10 (`POWER_STEP`) | Q, E |

After a two-finger gesture nothing aims or fires until every finger is up (state `spent`), so lifting the fingers one at a time never fires. A third finger is ignored. `pointercancel` (the browser taking the touch) drops the aim and never fires. The camera moves only on these gestures (the camera rule, #169): one finger never moves it, and nothing moves it between gestures; the e2e checks both, through a whole shot.

Mouse and pen keep the desktop controls unchanged; the gestures are chosen per event by `pointerType`, so a laptop with a touch screen takes both.

## The touch face

`?touch=auto|1|0` (default auto). Auto shows the touch face when the primary pointer is coarse (`(pointer: coarse)`: a phone or tablet), then follows the pointer last put down (or hovering, for a mouse or pen). The face is `body.kg-touch` (`GameHandle.input.touch`), and only CSS reads it (`GAME_CSS`): key hints (`kbd`) hide, the chips and result buttons grow, the power buttons show (`.kg-tch`), the help line becomes `TOUCH_HELP`, the door's first how-to line and the opener's hint read for touch (`.kg-desk` / `.kg-tch` pairs). The help line stays visible on a narrow touch screen (it is hidden on a narrow desktop window), since a phone has no other place to learn the gestures in play.

Every touch button is at least 44 px (Apple's 44 pt guideline), lighter than the panel with an outline so it reads as a button. On a phone (narrower than 640 px, or under 500 px tall) the HUD's type and padding compact, and the lot sheet (M3) shows only its count line in play; its goals are listed on the result card. Upright, the HUD still spans about a third of the screen's height (`PORTRAIT_HUD_SHARE`, 0.4), so the opening camera frames the structure below it (next paragraph): before that, L1's crowns opened hidden behind the HUD.

**Opening camera on a portrait screen.** `frame()` (`@tb/render/camera`) fitted the structure with the vertical field of view in both directions, which is right for any screen at least as wide as tall. On a phone held upright the view is narrower than tall, so B1's Long Wall opened as a slice of wall. `frame()` and `viewOf()` take the screen's aspect: under 1 the width counts 1/aspect times, and `viewOf` frames a box taller than the structure (from `1 / (1 - PORTRAIT_HUD_SHARE)` times its height, 5% more at a time) until every corner of the structure's box projects below the HUD's band and within the sides (`clearOfHud`, which also covers the launcher-facing yaw `viewOf` sets after the fit); at 1 or more nothing changes, bit for bit. Tested over every level: every block corner on screen and below the HUD band, and the width test fails without the fix on L2, L4, B1, B2 and B3. The aspect is read once at load from the canvas's CSS box; turning the phone later does not move the camera (the camera rule).

Other page fixes for phones: the canvas is `100dvh` tall (`100vh` on iOS Safari runs under the address bar), with no text selection or long-press callout. Audio starts on a touch's lift, not its press: for touch, `pointerdown` is not a user activation in the HTML spec, `pointerup` is, so the AudioContext could not resume on the press alone.

The no-WebGPU card stays for phones without WebGPU; its copy now names what works on a phone (recent Chrome on Android, Safari on iOS and iPadOS 26 and later) instead of saying phones mostly cannot.

## Review

Screenshots (composited from offscreen renders: this container's SwiftShader cannot present a WebGPU canvas) in the project files under `touch/`. An independent Opus look found nothing broken and the desktop unchanged, and raised two blockers, both fixed: the HUD hid L1's crowns on an upright phone, and touch targets were under 44 pt. Its follow-up (help line contrast and the cancel wording, "add a finger mid-aim: cancel") is done too. Real-device checks (a phone with WebGPU) are for the playtest round.

## Alternatives weighed

1. **Desktop mapping as is: one-finger drag orbits, tap fires.** This is what the page did before U4 (pointer events already arrive for touch). Rejected as the default: a touch screen has no hover, so every shot was fired blind, with no arc preview and no lit block before it went. Orbit is the less frequent action, so it takes the two-finger gesture.
2. **Aim, then confirm: tap sets the aim, a Fire button fires.** The most precise and the hardest to misfire, but every shot costs two taps in two places, and rapid fire (on by default) wants one motion per shot. Kept in reserve as an option if playtesters misfire; the second-finger cancel covers most of the same need.
3. **Aim point lifted above the finger** (the finger hides what it touches). The arc comes from the launcher behind the camera, so most of it shows below and beside the finger, and the HUD says when the target is out of reach. Not built: a lifted point makes a tap fire somewhere other than where it landed, which is worse for first-time players. A candidate option (`touch.lift` in px) if the playtest says the finger hides too much.
4. **Two-finger pan in place of orbit, or three-finger pan.** Not built; desktop pan (right drag, shift drag) has no touch equivalent yet. Orbit and zoom were the brief, and the follow-up is cheap if wanted.
5. **A portrait HUD that collapses to a strip** (tap to expand) instead of framing the structure below it. More screen for the scene, but one more control to learn and the objective out of sight; framing below the HUD needs nothing from the player.
6. **Touch events (`touchstart` and friends) instead of pointer events.** Pointer events give one code path for mouse, pen and touch with pointer capture, and Chromium, Safari and Firefox all deliver them for touch. Touch events would need a second path for no gain.

## Not done here

- Hold-to-fast-forward (Space) has no touch control yet; rapid fire makes it less needed.
- Mid-round retry (R) on touch is the Menu button and a level card today; one-key restart and undo are U6.
- Bank keeps its HUD button (it was always a button).
- Device tiers for phones (P1) decide what a phone's GPU can carry; this page only makes the controls work.
