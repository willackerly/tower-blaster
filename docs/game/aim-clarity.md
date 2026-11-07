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
- Option: `keystone.impact=0` turns it off, as does the door's **Advanced settings > Impact marker** and the viewer's Scene panel.

## The opener's preview

Before the player aims (and while the cursor is off the canvas), a level with a pre-aimed opener shows that opener's flight: its beads, its impact marker and, for a bomb, its blast zone. That is what F, or the HUD's Fire button, will do. Nothing is aimed, so the HUD shows no reach state and `input.aimed` stays null. `GameHandle.impact` reports the contact, with `opener: true`.

The check: for every level whose solutions give it an opener (`ace[0]` or `par[0]`), `arcContact` at the home poses lands on a structure body, not on the ground and not past the lot.

## Alternatives considered

1. **Gate the warning on the player's first input** instead of fixing the reach. This would hide the symptom, but a player hovering the near face would still get "Out of reach" on a target that is in fact reachable.
2. **Raise the power automatically** for unreachable targets. The power is the player's (a click or a keypress). Changing it silently makes the next shot unpredictable.
3. **Fire the ball in a straight line** for low targets. That is a different weapon, and the replays depend on the ballistic model.
4. **Mark the cursor's point, not the arc's contact.** This would be cheaper, but it lies whenever a wall stands in front of the cursor. The contact is what the shot will actually meet, at its present pose. It is not a promise of what the solver will do, since nearby bodies move once the first one is struck.
5. **Ray-march the arc on the GPU** against the depth buffer, which would cost nothing per body. But the depth is 4x MSAA and never stored (see `reach.ts`), and the impact is wanted before the frame. The CPU sweep costs about a millisecond on B3's 10k bodies, and runs only when the aim changes.
