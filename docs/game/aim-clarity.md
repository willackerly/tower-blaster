# The aim's clarity (PT14)

Agent playtest round 1 (`docs/game/agent-playtest-1.md`) listed five things under PT14:

1. A red "Out of reach" was showing before the player had moved.
2. The pre-aimed opener has to be reachable.
3. Only bombs got a ring. Every shot should mark where it will hit.
4. L5's domino row was seen end-on.
5. Cameras should fit the structure with a 10% top margin.

Items 4 and 5 are the opening view (`docs/game/opening-view.md`). This note covers the first three.

## Out of reach: the aim could not point down far enough

`aimAt` (keystone `shots.ts`) searches launch pitches from -45 to 80 degrees. Since the high launcher (#214), shots leave 2 h over the structure's top. From there, a point low on a tall structure's near face needs more than 45 degrees down at full power. So hovering over it said "Out of reach at this power", and only lowering the power reached it, which nothing on screen said.

- **The fix.** The game aims with `AIM_MIN_PITCH = -80` (`aim.ts`, passed to `aimAt` as `minPitch`). Bots, casts and recorded lines keep -45, so every recorded line replays as recorded. The search costs about 160 arcs instead of 125.
- **The check** (`aim-clarity.test.ts`). For every level, at its opening view, wide and upright, a 9x9 grid of rays is cast over the free area, plus one at the middle of each objective body on screen (up to 32), since a sparse lot like T-W1's three dominoes falls between the grid's rays. Every structure body they hit must be reachable at full power from the high launcher. Points past 95% of the ball's drag-free range are left out, because there "Out of reach" is the truth: the far side of the biggest trial lots (T-S3, T-X3, T-X3B) is more than 18 m from the ring.
  - With the old -45 floor, 21 levels fail this test, including B1, B2, B3, T-S1, T-S8 and T-I1.
  - With -80, none fail.
- **Before any input** there is no aim, so there is no warning. The phone case in the playtest was the harness aiming at the middle of the screen, as a hover would (the round's own note says so). The e2e (`aim-clarity-e2e.test.ts`) checks that a level with an opener shows no warning at load, on a desktop page and on a phone page.

## Where the shot will hit: the impact marker

`arcContact` (`aim.ts`) sweeps the previewed flight against the structure:

- Each step's segment is a ray against every body's box grown by the shot's radius. There is a reject on the structure's box first, then on each body's bounding sphere.
- It returns the first contact: the body (or the ground), the touched point on the box (the box's nearest point to the shot's centre, so face, edge or corner) and its normal.
- The beads stop there, instead of running on through the wall to the closest approach to the cursor.

`Renderer.impact(point, normal, radius)` draws a reticle on that face. It is the blast zone's shader (`reach.ts`) with the plane turned to the face's normal, the beads' coral, and no dome or ripple. Its radius is 1.6 times the shot's radius, and at least 0.4 h.

- It is drawn for every aimed shot except a pull. A pull lights its block instead.
- It is not drawn when the blast zone shows (one-blast weapons), since that zone already marks the spot.
- Like the zone, it shows faintly through what stands in front of it, so a shot that will hit a wall in front of the cursor shows the mark on that wall.
- Option: `keystone.impact=0` turns it off, as does the door's **Advanced settings > Impact marker** and the viewer's Scene panel (`options/impact.ts`).

## The opener's preview

Before the player aims (and while the cursor is off the canvas), a level with a pre-aimed opener shows that opener's flight: its beads, its impact marker and, for a bomb, its blast zone. That is what F, or the HUD's Fire button, will do. Nothing is aimed, so the HUD shows no reach state and `input.aimed` stays null. `GameHandle.impact` reports the contact, with `opener: true`.

The check: for every level whose solutions give it an opener (`ace[0]` or `par[0]`), `arcContact` at the home poses lands on a structure body, not on the ground and not past the lot.

## Alternatives considered

1. **Gate the warning on the player's first input** instead of fixing the reach. This would hide the symptom, but a player hovering the near face would still get "Out of reach" on a target that is in fact reachable.
2. **Raise the power automatically** for unreachable targets. The power is the player's (a click or a keypress). Changing it silently makes the next shot unpredictable.
3. **Fire the ball in a straight line** for low targets. That is a different weapon, and the replays depend on the ballistic model.
4. **Mark the cursor's point, not the arc's contact.** This would be cheaper, but it lies whenever a wall stands in front of the cursor. The contact is what the shot will actually meet, at its present pose. It is not a promise of what the solver will do, since nearby bodies move once the first one is struck.
5. **Ray-march the arc on the GPU** against the depth buffer, which would cost nothing per body. But the depth is 4x MSAA and never stored (see `reach.ts`), and the impact is wanted before the frame. The CPU sweep costs about a millisecond on B3's 10k bodies, and runs only when the aim changes.

# Round 2: the opening aim and the preview's legibility (PT29, PT36)

Agent playtest round 2 (`docs/game/agent-playtest-2.md`) read the aim at the middle of the screen as the level's own: the harness's "aim view" is a tap at `(0, -0.05)` in device coordinates, and a first visit's novice clicks there too. From the opening view (PT1, which frames the objectives, not a shot) that point is no promise:

- L3 opened on its centre heritage column.
- B2's blast zone opened over the cathedral.
- L4's anvil opened on the fulcrum (desktop) or on the ground (phone).
- On phones, 15 of 34 trials opened "Out of reach".
- In the D1 phone duel, the warning showed on an arc that knocked the king off.

The preview itself was hard to read. From behind the eye a flight is seen end on, as a stack of dots, and the dots nearest the camera drew as 30 px blobs over the crowns (L1, L3, D2). The blast zone also stayed on the result card (T-I3).

## Out of reach follows the drawn flight

`aim.ts reachesStructure`: the warning shows only when the drawn flight meets nothing of the structure. A flight that lands on a block short of the point aimed at does something, and its impact marker says where. Before, any miss of the point by more than `REACH` (0.15 m) warned, including an arc that struck the keep in front of it. The beads' grey "out" colour follows the same rule. The duel novice bot (`duel-bot.ts`) still skips clicks by the old rule; it belongs to the Siege Table thread's balance work, and they were told.

## The opening aim (`opening-aim.ts`, `keystone.openaim`)

Before the first shot, while the player has not aimed and the level has no pre-aimed opener, the aim rests on a point chosen for the view as framed. This makes it per viewport: the phone's view, framed around the docked HUD, gets its own. The game draws its dots, impact marker and blast zone. A tap or click at its point aims the same shot (the CPU test checks the shot is equal), so a first visit that taps the target it is shown fires a shot that does something. It is recomputed only when what it depends on changes: the level or a retry, the view, the item, power, launcher height or side.

The rules, all on the CPU at the bodies' poses after the pre-settle:

1. **Candidates.** Points on a 16x16 raster over the structure's box on screen, picked (`aim.ts pick`). Each must be a structure block that is not heritage, and at least `HERITAGE_CLEAR` (0.25 h) from every heritage block.
2. **Order.** Nearest a crown's middle; on a level without crowns, highest. The middle of the screen breaks ties.
3. **Acceptance.** Taken in that order, at most 24 flights each pass. A point is accepted when:
   - its flight reaches it (no warning);
   - it first touches that very block. In a dense city where no point does (T-B2C), a second pass accepts any structure block that is not heritage;
   - the touched point keeps `HERITAGE_CLEAR` from heritage;
   - for a blast weapon, the largest blast's radius plus half an h reaches no heritage;
   - no heritage stands in the way of what the shot moves (`heritageAhead`). That means no heritage block touching the struck block ahead along the flight's heading (a cosine over 0.3). It also means none within 1.5 times the struck block's height ahead (a 60-degree cone), as far as what it stands on could fall. For a blast weapon the fall counts in every direction, plus the blast's radius.
   - These rules came from the physics. On L3, with the launcher 25 degrees to the side, the crown shot drove the crown into the heritage block beside it (f64 reference). On B2, a bomb on the crowned tower's roof, fired toward the middle, felled the tower onto the cathedral 9 m on (Rapier: 1 and 21 heritage blocks cracked).
   - The cheap rules (reached, heritage in the way of the block aimed at) are applied before a flight is swept. The 24 tries are spent only on points that pass them.

GameHandle reports `openingAim` (its shot, the tap point, the block) and `impact.opening`. The agent playtest's aim view now shows the opening aim instead of a centre tap, and a first visit taps it (`playtest/src/agent/run.ts aimView`, `fireNovice`). The centre tap remains the fallback for later shots.

Tests:

- `opening-aim.test.ts` (CPU) runs every level aimed at a point (29) at 1280x800 and 390x844, with the launcher behind and to the side. An aim exists; it is not on heritage; it is reached; it lands on the structure; it is clear of heritage (zone and ahead included); a tap at its point aims the same shot.
- `opening-aim-physics.test.ts` covers each rated chamber level (L1-L5, on the f64 reference) at both viewports, and `opening-aim-physics-<id>.test.ts` covers each level over 200 bodies (B1-B3, W3 and W5) on Rapier, one file each (W5's 259 bodies take about 2 min a viewport on the reference; B levels are 1,000 to 10,000). On a PR one big level a family plays (B2, W5) and the e2e loads the chamber levels and the first level of each other family; the rest run under `PHYSICS_GPU_SLOW=1`, the nightly run (CI rule O5). The aim is chosen on the pre-settled bodies, with the default launcher, and fired untouched; the test asserts heritage stays intact and the collapse fraction is above 0.
- `opening-aim-e2e-{desktop,phone}.test.ts` (game page, Rapier) covers every aimed level at both viewports: no "Out of reach" at shot 0, the preview lands on non-heritage structure, dots are within the cap, and a tap at the point aims the same reachable shot with no warning.

## The preview's dots (`preview-dots.ts`)

The dots are world spheres (6 cm, the target 11 cm), sized by the frame's view:

- Within 3 m of the eye they are not drawn, and they grow in over the next 2 m.
- None is wider than 8 CSS px (`DOT_MAX_PX`; the verify asks for no more than 10).
- None but the last is drawn over a crown's or heritage block's screen box that it stands in front of. The flight shows a gap there, and the target dot and marker still say where it lands.

The dots, the blast zone and the marker are drawn only while a shot can be aimed (`aimable`), and never under the result card. GameHandle `view.dots` reports the drawn dots (centre and diameter, CSS px).

## The launcher's side (`keystone.fireside`, the Launcher setting)

The launcher has always stood behind the eye (`azFromYaw`), so the flight lies in a plane through the eye and is seen end on. `keystone.fireside=side` stands it `FIRE_SIDE_DEG` (25 degrees) round, so the flight comes in from the left as a curve (`aim.ts launchAz`). The eye does not move, so the opening view and Will's still-camera rule stand.

**Default: behind.** From the side every shot strikes at an angle. On L3 (Surgeon, a crown between two heritage blocks), the opening view's crown shot from the side cracked a heritage block on the f64 reference. Square on, the same crown comes off clean, and that is how L3's par line plays. The playtest's complaint was the blobs over the crowns, and the dots above answer it. A duel always fires from the view's own azimuth, since its arcs and refusals are the Siege Table's.

## Alternatives considered (round 2)

1. **An authored opening aim per rated level** (the judges' suggestion). It is exact and testable, but fixed in world space: the phone's view and launcher differ from the desktop's, and every new level would owe one. A computed aim covers the 29 aimed levels and the trials at any viewport. An authored override can still be added, game-side and not in the level def (which would change the level hash and the stars), if a level fails the physics test.
2. **Frame the opening view so its centre lands well.** Centring is PT1's job (show the objectives). On L3 the centre is the heritage the level asks you to spare.
3. **A Fire button for the opening aim on every level.** The HUD's Fire stays the pre-aimed opener's (PT13: a first-visit gift, not every level's). The opening aim is a target to tap.
4. **Choose by simulating candidates at load.** This would be exact, but it means seconds of physics per load on the big levels. The CPU rules are checked offline on the reference instead.
5. **Move the camera 25 degrees off the line of fire at load.** The launcher follows the eye, so the eye's yaw alone changes nothing. Moving the launcher is `fireside=side`, kept as an option for the reason above.
6. **Raise the camera's pitch.** An end-on flight is still a vertical line from any pitch.
7. **Rank by height instead of nearness to a crown**, so the aim helps less. Crowns are marked to be hit, and the aim teaches the arc. L1's opening aim clears L1, a tutorial level. It is not a level's best line: stars weigh strokes and leverage.
