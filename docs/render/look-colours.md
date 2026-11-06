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

## 2. Crowns gold and heritage teal in every look: coats (`keystone.coats`)

**What the judges saw:** `L3-candy-desktop-00` and friends: the crowns read
salmon, the aim beads' own colour, and the heritage violet, in candy; gold and
celadon in hazy and real. One game, two colour languages.

**Cause.** Roles were drawn as a tint multiplying the look's palette colour
(scene.ts `TINT.crown`, `TINT.heritage`). Hazy and real paint every block a
near-neutral stone, so the tint is the colour; candy paints each course its
own rainbow hue, and gold times candy's top-course red is salmon, celadon
times its violet is violet.

**Fix.** A *coat* is a colour of its own that replaces the palette colour
(`@tb/render` coats.ts). It is two bits of a slot's fx record (word 1, bits
22-23, beside the mark's 20-21), set once at level load with
`Renderer.setCoats` and kept through every later `setFx` (flashes, hover,
regrow scale writes) until `clearFx`, as a mark is. The scene pass takes the
coat's linear colour as the block's base colour; the look's lighting, the
real look's stone detail, the carving, the tint and the glow then apply as to
any block. The game coats crowns gilt (#E3A62F, OKLCh hue 79, C 0.145; the
HUD's crown gold is hue 77) and heritage glaze (#2FA28A, hue 176; the HUD's
heritage is 166), and drops the role tint on a coated block
(`roleTint(c, i, coats)`). The beads (hue 35) stay 44 degrees from the gilt.
Options: `keystone.coats=0` (Advanced, the viewer's Scene panel, scene files
`rules.coats`) brings back the tint. Duels keep the tint (their ink colours
the side's blocks); ice keeps the tint (the ice pass draws its own colour).

**Measured** (L3, game page, mean OKLab over the role's own pixels from the
ID pass of the same frame; `coats-e2e.test.ts`):

| Look | Crown hue / chroma | Heritage hue / chroma |
|---|---|---|
| candy | 86.5 / 0.128 | 179.2 / 0.082 |
| hazy | 84.1 / 0.119 | 172.7 / 0.073 |
| real | 80.1 / 0.106 | 171.9 / 0.067 |
| candy, `keystone.coats=0` | 39.2 / 0.061 (salmon, 4 degrees from the beads) | 269.5 / 0.073 (violet) |

**Alternatives weighed:**

- *Per-look role tints* (a candy gold that, times candy's red, gives gold). The product depends on the course's palette colour, so every course would need its own; a new look or palette would break it again.
- *Taking the crowns out of the palette in candy only.* Fixes candy, leaves the next look to rediscover the problem; the coat is the same colour by construction in every look.
- *A surface (surface.ts) instead of fx bits.* Surfaces pick a pass (ice) and their words are reset per level; a coat is a colour, not a material, and must survive the game's frequent `setFx` (flash, hover, regrow). The mark's fx-bit pattern already does exactly that.
- *Changing the aim beads' colour instead.* The beads are coral in every look; the crowns were the ones changing colour. Moving the beads would not fix the violet heritage.

**Tests:** `render-marks.test.ts` (the coat's bits beside the mark and flags;
kept through `setFx` and a bulk scale write, cleared by `clearFx`; an
untinted gilt cube reads hue 60-100 and a glaze cube 150-200 in hazy, real
and candy, two slots of the same coat within 3 degrees though candy paints
them differently); `scene.test.ts` (coats per role, none on ice, the role
tint none with coats and the old gold and celadon without, plain blocks
unchanged); `coats-e2e.test.ts` (the table above, with the bounds:
crowns 60-100, chroma > 0.06, more than 25 degrees from the beads; heritage
150-200; each role within 20 degrees across the looks; coats off moves the
crowns at least 15 degrees toward the beads and the heritage 45 away from
teal); pacing and viewer rules round trips. The render goldens (no coats) keep
their hashes.

## 3. Gilded crowns in the real look (R8)

**Ask:** brass or gold-leaf crowns, readable at a glance on L1-L5.

**Before:** a crown in the real look was stone multiplied by the gold tint,
plus the crown's steady glow (scene.ts `CROWN_GLOW` 0.1 of the emissive
range): it read as a flat printed yellow plate, the same in light and shade.

**Now:** the gilt coat is finished as gold leaf over the stone: the scene pass
mixes in a bare metal of specular colour `GILT_F0` (1.0, 0.71, 0.29, gold's
F0 from Real-Time Rendering 4th ed., table 9.2), lit by the same sun lobe and
split-sum environment as the steel ball (`shadeMetal`, shared), at GGX
roughness `GILT_ROUGH` 0.26 (burnished: 0.2 showed the horizon as a hard line
across a face, 0.32 read muddy ochre on faces turned from the sun, 0.45 read
as paint again). The leaf covers `GILT_COVER` 0.9 of
a face and wears off where the stone wears (its edge band), showing the gilt
coat's stone-and-mordant colour beneath; the carved crosshair cuts through it.
A gilded crown keeps `GILT_GLOW` 0.3 of its steady glow (the leaf catches the
light itself; at 1 the face flattens back to a plate, at 0.15 a face in shade
reads muddy); a flash, as when a crown falls, glows in full.

**Alternatives weighed:**

- *A brighter or more saturated tint.* Still a plate: the problem was the glow and the absent specular, not the hue.
- *Polished gold (roughness ~0.1).* Mirrors the sky and floor: a face turned to the sky reads white-blue, not gold, and flickers as the light moves.
- *Brass F0 (0.91, 0.78, 0.42) instead of gold.* Greener and paler; next to the HUD's gold (hue 77) it drifts toward lemon. Gold leaf keeps the hue.
- *Gilt in the stylized looks too.* Their blocks are matte by design; the coat's colour already makes the crowns gold there (§2).

**Readability (blind review).** L1-L5 at their opening views, 1280x800, in
the real look with the gilt, in the real look with the old tint
(`keystone.coats=0`), and in candy with coats: 15 frames, given to an Opus
reader with no answer key, asked to box every crown. Against the ID pass of
the same frames it found every visible crown in every frame (L1 2, L2 3, L3
2, L4 9, L5 1; the level's other crowns are hidden from the opening view, a
PT1 matter) and rated the gilt 4-5 for reading at a glance, the old tint 3-4
(pale yellow close in value to the sand and the sky) and candy 3-4. Its
critique of the first gilt (roughness 0.32, glow 0.15: "dark ochre, slightly
muddy on L1 and L5") gave the tuned values above, checked side by side on L1,
L4 and L5. Its other finding: candy's rainbow for plain blocks has its own
yellow course (#FFD966) and cyan course (#6FD6E8), near the crown gold and
the heritage teal, so in candy the glyphs (stone marks), not the colour
alone, keep the roles apart. Left as is: the ramp is candy's identity and
Will likes the looks as they stand; a candy ramp that skips hues 60-100 and
150-200, or an edge line on coated blocks, is the follow-up if a playtest
says the glyphs are not enough.

**Tests:** the steel ball's tests (the shared `shadeMetal`, unchanged output);
the real-look crown hue and chroma in `coats-e2e.test.ts`.

## 4. The default look: hazy or real (pending a Metal review)

**Ask:** judge 3 of agent playtest 1 recommends making `real` the default over
`hazy` ("Hazy has the weakest figure-ground: grey blocks on a grey grid under a
grey sky"), once real's shadows cover the big levels (§1) and its ice stays
pale (`docs/render/ice.md`, a lighter shadow). The brief: decide only after an
Opus look review of a Metal capture; ship the code behind the option and leave
the default as it is.

**Call for now: the default stays hazy.** Every change in this note is in
both looks (coats, the sun only in real), and `?look=real` (the front door's
Look setting) picks real. The reasons to wait for the capture rather than
decide from SwiftShader frames:

- The real look's cost. It is the expensive look (atmosphere, stone and ground
  textures, PCSS, AO, grain); the M5 bench of real against real with polish off
  is queued (`docs/render/polish.md`, Cost), and the quality tiers (P1) pick per
  machine. A default that misses 120 fps on the target is the wrong default
  however it looks.
- What a player sees on a real GPU: SwiftShader has no anisotropic filtering
  and runs the grain and tone map at a different precision. The judges'
  frames were SwiftShader's.
- The big levels' readability in real (PT1: crowns hidden at B2's opening view)
  is a framing problem in either look.

**Alternatives:** *real now* (the judges' pick, but on frames from a software
GPU, before the cost is known); *candy* (the most legible figure-ground, but
night and toy-like, the look Will keeps as an option); *a hazy with candy's
height ramp as a value ramp* (judge 3's second idea: cheaper, keeps hazy's
cost; a follow-up if the review keeps hazy).

**The capture job** (Mac, idle, `main` after this PR; two runs of the same
recorded lines and trials, on the GPU solver, desktop viewport):

```
pnpm playtest:agent --only '^((L[1-5]|B[1-3])-line|T-I[1-3]-novice)-desktop$' --engine gpu --look hazy --out ~/dev/tb-looks/<sha>/hazy
pnpm playtest:agent --only '^((L[1-5]|B[1-3])-line|T-I[1-3]-novice)-desktop$' --engine gpu --look real --out ~/dev/tb-looks/<sha>/real
```

The review: an Opus reader gets the two sets' contact sheets side by side and
the rubric of agent playtest 1's looks row (figure-ground, crowns and heritage
found at a glance, shadows grounding the towers, ice, the collapse readable
mid-shot), plus the M5 frame times of each look from the polish bench. Real
becomes the default if the reader prefers it on at least 6 of the 11 levels,
finds no regression in crown finding, and the bench shows real holding the
High tier's frame budget on the M5; the switch is then one line
(`lookByName` default) plus the front door's Look setting, with the goldens
untouched (they pin each look by name).
