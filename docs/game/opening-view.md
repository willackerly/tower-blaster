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

   If no view passes, the one that shows the most objectives wins. The search is deterministic and pure.
   It is remembered per level hash, screen shape and insets, and the next level's search runs during the
   prefetch.
2. **How far and where** (`fitBox`). This is an exact fit of the structure's box into the screen's free area,
   which is the screen minus its *insets*: 10% of sky on a wide screen (PT14), the HUD band on an upright phone,
   plus any band that `play.ts` measures and passes. The area is shrunk by `fit` 1.05 about its middle.
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
  the viewer's Scene panel select. *Classic* keeps the base direction (par line's side, 12 degrees) and uses the new
  fit.
- A duel's turn view (`duel-view.ts`, owned by the Siege Table thread) frames exactly as before (`faceView`).
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

## Not done here

The outline-through-occluders option, the crown pulse from the HUD, and the rest of PT14 (out-of-reach warning,
reachable opener, impact marker) follow in their own steps of the same thread.
