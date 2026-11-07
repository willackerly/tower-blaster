# The opening view (PT1, PT14 framing)

Agent playtest round 1 (`docs/game/agent-playtest-1.md`) ranked this first: **B2 opened on a field of white towers.**
None of the four crowns and none of the 32 heritage cubes were in sight, heritage costs 500 a cracked cube, and the
first visit scored **-15,361**. Its PT14 row added that L5's domino row was seen end-on (one domino visible) and
that T-S1's tower ran to the top edge of the screen.

## What changed

The opening camera (`packages/game/src/view.ts`) is now two separate choices.

1. **Which way to look** (`openingDirection`). Levels with no crowns or heritage keep the old view: the par
   line's side (or the 3/4 yaw of 36 degrees), at 12 degrees of pitch. Levels with objectives are searched.
   Pitches are tried from lowest to highest (12, 20, 28, 36, 45, 55), and at each pitch the yaws nearest the base
   come first (0, ±15, ±30, ±45, ±60, ±90, ±135, 180). The first view that passes both gates wins:
   - **Objectives.** At least 75% of the crowns are in sight, and at least a quarter of the heritage (one body at
     minimum).
   - **Spread.** The view's *exposure* (visible pixels over every body's unoccluded pixels) is at least 80% of
     the best yaw's at that pitch. A row seen end-on fails this gate.

   - **Confirmed at a finer raster** (PT3b, 2026-11-07). The search counts on a 160 px raster, where a small
     crown is a few pixels. A view that passes both gates there is drawn again at `CONFIRM_PX` (480) and taken
     only if its objectives pass there too. Found by the PT1 GPU gate once the docked phone HUD changed the
     insets: T-X3B upright opened at yaw 66, a crown at 0.39 of itself on the coarse raster and 0.20 in the
     page's own 390 x 844 frame. It changes 5 of 37 levels' views at the wide and classic upright shapes (A3,
     T-B4A, T-X3B wide; L2, L4 upright), each a coarse-only pass, and costs one more raster a pick (about 10 ms
     on B3). Raising the whole search to the finer raster was the alternative: about 9 times the pixels for every
     view scored, to fix a few picks.

   If no view passes, the one that shows the most objectives wins. The search is deterministic and pure.
   It is remembered per level hash, screen shape, insets and HUD shape, and the next level's search runs during
   the prefetch.
2. **How far and where** (`fitBox`). This is an exact fit of the structure's box into the screen's free area,
   which is the screen minus its *insets*: 10% of sky on a wide screen (PT14), the HUD band on an upright phone
   (the 40% guess, or docked the band `play.ts` measures from the HUD's boxes, PT3b: docs/game/phone-hud.md),
   plus a level's own panels (`openingInsets`). The area is shrunk by `fit` 1.05 about its middle.
   - For a fixed view direction, keeping each corner inside each edge of the area is linear in the eye's
     position. So the least back-off, and the sideways shift that achieves it, come in closed form: a max over
     corner pairs, per axis.
   - The old code computed the fit at yaw 36 and then turned to the par line's yaw. This fit uses the actual
     direction, which fixes the cut-off tops.
   - A wide screen counts its width as a square's, so every wide window opens on the same view.

"In sight" is measured by an ID raster: body index per pixel, nearest wins. `sightlines.ts` is a small CPU
rasterizer of the level's boxes at their home poses: back faces are culled, there is a depth test, and each body's
outline area comes from its front faces, which tile a convex box's silhouette. A body is in sight when it shows at
least a quarter of its outline (`SEEN_SHARE`) and at least 2 pixels, outside the HUD's panels. The search counts
more strictly (`SEARCH_SEEN_SHARE` 0.35 at 160 px) than the gate does. Its raster is coarse and uses home poses,
while the gate reads the page's own frame, so a view the search only just passes could fail the gate otherwise.
The first run without this margin did fail: L2 showed 4 of 6 crowns on the GPU against 5 of 6 on the CPU.

### Measured (CPU search; GPU gate at 1280x800 and 390x844 under the real HUD)

| Level | Old view: crowns, heritage in sight | New view | GPU gate, desktop |
|---|---|---|---|
| B2 | 0/4, 0/32 | yaw +180, pitch 36 | 4/4, 21/32 |
| T-B2A (16 roof crowns) | 1/16, 0/32 | yaw +180, pitch 36 | 16/16, 21/32 |
| L1 | 2/4 (the back crowns hide behind the front ones) | yaw +45, pitch 12 | 3/4 |
| L2 | 3/6, 14/36 | yaw 0, pitch 45 | 6/6, 18/36 |
| L4 | 5/9, 11/12 | yaw +15, pitch 36 | 9/9, 10/12 |
| L5 | 1/1, exposure 32% (row end-on) | yaw +30, pitch 12, exposure 90% | 1/1 |
| T-I3 | 5/9 | yaw 0, pitch 45 | 9/9 |
| L3, U1-U3, T-X1, T-I1 | already passed | unchanged (base view) | pass |

The B2 search takes about 0.2 s on this cloud box. The chamber levels take a few milliseconds.

## Options

- `keystone.view=goals|classic`, the door's **Advanced settings > Opening view** (*Show the goals* / *Classic*), and
  the viewer's Scene panel select (scene key `openview`), declared in `options/openview.ts`. *Classic* keeps the base
  direction (par line's side, 12 degrees) and uses the new fit.
- A duel's turn view (`duel-view.ts`, owned by the Siege Table thread) frames exactly as before (`faceView`, with its
  `focus` and `only`).
- A level with charges (Fuse & Fold) shows its fuse panel at the bottom of an upright phone, up to
  `FUSE_PANEL_SHARE` (45%) of the height. `openingInsets` adds that band to the defaults, so the lot opens above
  the panel; the panel's CSS reads the same constant. Without it, F1's 14 heritage blocks sat under the panel
  (0/14 in the GPU gate). A wide screen frames as before, since the panel sits to the right of the square's view.
- The gate opens each level with `keystone.build=0`, so a workshop (T-W1) is checked on the view its shots are aimed
  from, and masks a docked phone HUD by its strip, tray and hints rather than the full-screen container.
  `DUEL_PITCH` was chosen at that distance: the tighter fit stands closer, and perspective then lifts your own keep
  into the view, so `duel-view.test.ts` would drop from a 100% to a 95% view of the other keep. Passing `insets`
  with a `face` opts into `fitBox`.

## Tests

- `sightlines.test.ts`: a lone box covers its outline, which proves the culling keeps the right faces. A box behind
  another is hidden. A turned box is about 1.4 times as wide. HUD rectangles are left out. The outline-only measure
  equals the drawn one.
- `view.test.ts`:
  - `fitBox` puts every corner inside the free area and fills 1/1.05 of it on one axis. This is checked over five
    inset shapes, including a sideways phone with a left rail and an upright phone with a strip and a tray, and
    three directions.
  - Every level with objectives passes the gates, wide and upright.
  - B2's old view shows nothing and the new one passes.
  - L5 opens 30 degrees or more off the row, with exposure going from under 40% to over 80%.
  - Search order, determinism, *classic* and the cache are each checked.
- `sightlines-gpu.test.ts` (chamber levels) and `sightlines-city-gpu.test.ts` (B2, T-B2A, T-B4A) are **the gate**.
  The game page reads the renderer's own ID pass (`handle.sightlines`), with the page's real HUD panels measured from
  the DOM, at desktop 1280x800 and phone 390x844. Each asserts the PT1 verify: at least 75% of the crowns and at
  least one heritage body in sight. A last case opens B2 with `keystone.view=classic` and asserts that the gate sees
  no heritage and fewer than three crowns, so the gate does catch the view the playtest met.

## Alternatives considered

1. **Hand-placed cameras per level** (a `view` field in `LevelDef`, outside the hash). This would be exact and free
   at load, but every new level, trial, editor build (C9) and future HUD shape would need a person to place a
   camera, and nothing would check it. Rejected in favour of a search that the tests hold to the same gate. A
   per-level override can still be added later if a designer wants a signature shot.
2. **Fit to the objective bodies only** (zoom on the crowns and cathedral). This was the playtest's literal
   suggestion. It enlarges the objectives, but it does not remove what stands in front of them (B2's cathedral
   is in the middle of the town), and it crops the town you shoot across. A raised view does both jobs: B2 shows
   4/4 crowns and 21/32 heritage. Zooming stays the player's (wheel, pinch).
3. **Precompute the search offline** and ship the directions as data, with a staleness test like the codegen
   one. This would cost nothing at load, but it adds a generated file per level and screen shape. With the
   cache and the prefetch, the 0.2 s on B2 is spent while the player aims at the level before. This option is
   kept in reserve if a slower phone shows the cost.
4. **Score with the GPU's ID pass** instead of a CPU raster. It would be exact, but it needs the device and
   renderer before the level's first frame and an async readback per candidate (42 on B2), and it would put GPU
   work on the load path that #213 just cleared. The CPU raster is the same measure at 160 px. The GPU gate in the
   tests keeps the two honest.
5. **Lexicographic order (pitch first) vs a weighted cost** (yaw degrees against pitch degrees). Pitch first keeps
   Will's low 12-degree look wherever a turn alone does the job (L1, L5, T-X*), and climbs only when it has to
   (B2, L2, L4, T-I3). A weighted cost would trade a small climb for a big turn, but it needs a weight nobody can
   check.

## Hidden goals: crowns and heritage through what hides them (an option, off by default)

On B2's city lot even the best opening view leaves some crowns behind towers. `Renderer.setXray(slot0, kinds)` flags
the objective bodies (fx word 1, bits 24-25: `XRAY_SHIFT`, `XRAY_MASK`), and `fsXray` (`shaders.ts`) draws their
boxes once more after the sky, with the depth test reversed (`greater`, no depth write, alpha blend). So only the parts
behind something show, as a faint fill in the mark's colour (gold for a crown, teal for heritage) with a brighter edge.
Its gain follows the sun's luma, so it reads the same in every look.

- **Option:** `keystone.xray=auto|on|off`, the door's **Advanced settings > Hidden goals** (Never, Cities, Always) and
  the viewer's Scene panel, declared in `options/xray.ts`. The kind lives in fx word 1 bits 24-25 (bits 22-23 are the
  coats'); a crown to hold (kind 3) draws as heritage, since both are to keep. `auto` draws it on levels with at least `CITY_BODIES` (1000) bodies that have marks
  (`scene.ts xrayOn`): today, B2 and B3 only.
- **Default: off.** The brief made `auto` the default only if an independent look review agreed. The review (Opus, on
  B2, B3 and L1 captures, wide and upright) said no to the current look:
  1. An objective block hidden behind another objective block is drawn too, so visible crown tops read as wire cages.
  2. Per-cube edges make a crowd of small squares. One merged outline per group with a 15-25% fill would read better.
  3. The colours should match the materials: celadon, and a slightly brighter crown gold, not an electric cyan.
  4. It should show fully for about 3 s at the start and while orbiting, then fade to 30%.
  Those four are the follow-up (roadmap row PT1b). The default is revisited with a new review after them.
- **Tests:** `render-marks.test.ts` (3 looks): a crown and a heritage block behind a wall show in their colours,
  brighter at the edge. A hidden plain cube, a crown in plain sight and every pixel outside them are unchanged, and
  the kinds survive a flash and a scale write. `scene.test.ts` covers `xrayOn` over every level.
  `door.test.ts`, `pacing.test.ts` and `aim-clarity-e2e.test.ts` check the option and its default.

Alternatives considered:

1. **Outline only, through a stencil.** This draws a clean silhouette, but WebGPU's stencil needs its own pass setup.
   The `greater` depth test gets the same occlusion from the depth buffer the frame already has.
2. **A screen-space pass on the ID buffer** (an edge detect on hidden objective IDs). This gives a merged silhouette,
   which is item 2 above, but the ID pass is only drawn on demand (tests, `sightlines`), and drawing it every frame
   costs a full extra geometry pass. It is the likely route for PT1b if merged outlines are wanted.
3. **Pulse the crowns from the HUD** (a line from the HUD counter to each crown). This tells the player where the
   goals are, but not their shape, and it covers the scene with lines on a lot with 32 heritage blocks.

## Not done here

The crown pulse from the HUD, and PT1b, the x-ray look above, are not in this change.
