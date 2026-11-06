# Look colours and the real look's materials (PT15, R8, R7)

Roadmap rows PT15 (agent playtest 1, rank 15: "the looks' contrast and colour
language"), R8 (gilded crowns) and R7 (masonry tint), thread "Fix look colours
and photoreal materials" (2026-11-06). Will was away and had delegated the
calls; each is written down here with the alternatives weighed. Evidence
frames are in the project files (`playtest/agent-1/frames.tar`), named as in
`docs/game/agent-playtest-1.md`.

## 1. The real look's sun from the opening view (`keystone.sun`)

**What the judges saw:** `B2-real-desktop-00`, "no tower shadows".

**Cause.** Not the shadow frustum. The map is fitted to the camera frustum
and the play area (`shadowfit.ts`), and B2 with the sun moved
(`real.sunAzimuth=320`) shows every tower's shadow on the floor. The real
look's sun is fixed in the world (elevation 35, azimuth 140 degrees clockwise
from -z), and the levels' opening views face every which way. Measured from
the eye (`light.ts eyeAzimuth`, the sun's azimuth minus the eye's):

| Levels | Eye azimuth | Sun from the eye |
|---|---|---|
| L2, L3 | 0 | 140 (over the right shoulder, past the structure) |
| L1 | 270 | 230 |
| L5 | 90 | 50 |
| L4, B1-B3, U1-U3 | 144 | 356: straight behind the eye |

With the sun behind the eye, every face the player sees is fully lit, so the
blocks read flat, and every shadow falls behind its tower, out of sight.

**Fix.** In mode `view` (the default; `keystone.sun=look` turns it off) the
real look's sun azimuth counts from the level's opening view instead of from
-z (`sunForView`): every level is lit as L3 is, the frame the judges held up
(`L3-real-desktop-00`: a lit face and a shaded face on each block, long
shadows toward the left foreground). L2 and L3 have the eye at azimuth 0, so
they draw exactly as before (tested pixel for pixel). The sun is set when a
level loads and a retry keeps it: the light never follows the camera, as the
camera never moves but by the player's hand. The look's own sun azimuth knob
(`real.sunAzimuth`, the viewer's Look panel) keeps its meaning, now measured
from the opening view. The viewer's keystone mode does the same (its Scene
panel has the switch, scene files carry it as `rules.sun`).

**Alternatives weighed:**

- *A bigger shadow map or frustum.* The frustum already covered B2; nothing to fix there.
- *A sun azimuth per level in the level data.* Every level, and every one still to come, would need a hand-picked angle; a rule gets the same result for all of them.
- *A sun that follows the camera as the player orbits.* The light in the world would swing and the shadows crawl with every drag. Rejected.
- *Turning the opening camera toward a good light.* The opening view is framed for aiming (the par shot's azimuth); moving it for the light costs the aim.
- *The stylized looks too.* Their key light already gives shadows on every level (`B2-hazy` reads), so they keep their own; it would be a one-line change in `sunForView` if wanted.

**Tests:** `light.test.ts` (the azimuth convention against `eyeOf`, L3 and
B2's eye azimuths, the turned sun 140 degrees from every eye with its
elevation kept, L3's sun bit for bit, stylized looks untouched, the per-frame
cache); `light-e2e.test.ts` on the game page: B2 real, floor in front of the
structure in shadow 15.8% turned against 0.07% with the look's sun; L3 the
same frame either way; `pacing.test.ts` and the viewer's `rules.test.ts` for
the URL key and the scene file.
