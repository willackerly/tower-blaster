# Photoreal polish: steel ball, film grain, tone-map A/B (realism step 7)

Roadmap node R4, thread "Polish the photoreal look" (2026-11-06). The last
step of the photoreal plan (`docs/realism.md`, "Steps"): "Polish: steel ball,
grain, tone-map A/B". Will was away and had delegated the choices; the
defaults below come from an A/B of game screenshots and an Opus
second-perspective review, recorded at the end.

Every piece is an option of the real look (`RealOptions`, URL `real.<knob>`,
the viewer's Look panel, saved scene files), and with all of them off
(`REAL_POLISH_OFF`) the real look is the image it was before this step, bit
for bit: the golden gate (`render.test.ts`) pins that frame
(`real-polish-off:*` in `test/golden/looks.json`, hashed on main before the
step's first commit) next to candy and hazy.

## Tone map (`real.toneMap`)

The composite (`post.ts`) maps linear scene light to the display. Until now
that was AgX with its "punchy" look, for every look. It stays the default and
the stylized looks' only one. The real look can pick:

| `real.toneMap` | What | Character |
|---|---|---|
| `agx` | AgX, Wrensch's fit, punchy look (default before this step) | Darker mid tones, more saturation, smooth path to white |
| `agx-base` | The same without the look | Filmic and flat; reads washed out next to the others |
| `neutral` | Khronos PBR Neutral (2024) | Keeps base colours exact up to a shoulder at 0.76, then compresses and desaturates highlights |
| `aces` | Hill's fit of the ACES RRT + sRGB ODT | The "film" look most games shipped with; hue shifts in saturated highlights |

Considered and left out: Reinhard and its extended form (no shoulder
control, greys the whole image), Uchimura / Gran Turismo (a parametric curve
tuned for a racing game's HDR display path; nothing to gain over Neutral
here), Lottes (needs per-scene tuning), and a 3D LUT (a file asset and a
texture fetch for what four closed forms already cover).

**Fair A/B.** Curves differ most in where they put mid grey, so a raw A/B
mostly shows exposure. Each alternative goes through a gain (`TONE_GAIN`,
bisection on the grey curve at load) that puts linear 0.18 at AgX's display
value (0.3457 luma). Gains: agx-base 0.419, neutral 0.766, aces 0.951. What
remains is what the curves do with toes, shoulders and colour.

**Tests** (`tonemap.test.ts`): each operator's mid grey within 1e-6 of
AgX's; greys stay grey and rise monotonically (AgX's own polynomial toe
wobbles below 1e-3 under 8 stops down, as it always has, so its check starts
there); Neutral keeps a colour exactly below its shoulder and desaturates
above; WGSL against the CPU twins within 1e-4 on 4,096 random HDR colours;
the composite end to end within one 8-bit step of the twins plus dither.

## Film grain (`real.grain`, `real.grainSize`)

Grain is what a sensor or film adds and a renderer never does; a little of it
stops large flat areas (sky, the ground at distance) looking synthetic.

**Model: shot noise in linear light, before the tone map.** A pixel's light
is multiplied by `1 + s n`, n a unit-variance noise, s the relative strength:
`grain x GRAIN_MID` (10%) at mid grey, growing as `1 / sqrt(luminance)` below
it (photon shot noise: the standard deviation grows as the root of the
signal) and stopping at `GRAIN_FLOOR` (1/16 of mid grey, 4x mid grey's
strength) so blacks do not boil. Monochrome, so hues hold. The tone map then
compresses it in the highlights the way it compresses everything else.

Alternatives weighed:

- *Grain added in display space, weighted by a midtone bell* (the common
  post-effect). Cheap and controllable, but its strength is a made-up curve,
  and it adds grain on top of the dither in the darks. Rejected for the
  physical model at the same cost.
- *Per-channel (chroma) noise.* Reads as a cheap camera's colour speckle.
  Rejected.
- *A tiled grain texture.* Repeats visibly when it is static, and costs a
  texture; the hash is cheaper than the fetch.

**Noise:** hashed lattice values (pcg3d of the cell and the frame's seed, two
uniforms summed: triangular), every `grainSize` pixels, bilinear, divided by
the root of the summed squared weights, so every pixel has variance exactly 1
wherever it sits between lattice points (no grid shows in the grain's
strength). The seed is the renderer's frame count, so grain moves every
frame, as film's does; a fresh renderer starts at 0, which keeps test frames
deterministic.

**Tests:** unit variance and zero mean at sizes 1 to 3; coarser grain
correlates more between neighbours; two frames' grain is uncorrelated; the
shot-noise law (strength at mid grey, at 4x, at the floor, hue kept, never
negative, amount 0 a no-op); WGSL within 2e-3 of the twin (f32 lattice
position at 4,000 px); the composite pixel for pixel against the twin, and a
mid-grey field's spread shows the grain while amount 0 shows only the dither.

## Steel ball (`real.ballMetal`, `real.ballRough`)

The real look's ball was the stylized looks' ball recoloured: a grey
dielectric with a clear coat. A steel ball is bare metal: no diffuse light at
all, and a specular coloured by the metal.

- **Shading** (`shadeSteel`, real build only): the sun's GGX lobe and the
  environment's split sum (Karis's analytic fit, applied per channel as
  `F0 A + B`), both with Schlick's Fresnel from `STEEL_F0` = (0.56, 0.57,
  0.58), iron's specular colour (Real-Time Rendering 4th ed., table 9.2).
- **What it mirrors:** the sky view LUT above the horizon and the ground's
  radiance below (the real look's `env`), blurred toward the mean sky by
  roughness. Where the AO volume says the sky is hidden, it mirrors the blocks
  around it instead (`realBounce`, as the real look's ambient does), and
  contact and occlusion dim it as they dim the coat.
- **Which balls:** the look's own ball only (steel by default since this step). Painted balls (the game's
  crimson cannonball and blue marble, `keystone.balls=painted`, the default
  since Will's 2026-11-06 playtest) stay paint, and matte ones (a weapon's
  shell, the bombs) stay satin iron: the steel option never makes a ball look
  like a bomb. In the game the steel ball shows with `keystone.balls=plain`.
- `ballMetal` between 0 and 1 mixes the two shadings (at 0 the steel code is
  skipped and the frame is the old one bit for bit; at 1 the coat's shading
  is skipped).

Alternatives weighed: *screen-space reflections* (the ball would mirror the
towers next to it; a full SSR pass for one or two small spheres is not worth
its cost, and the AO-based switch to the blocks' radiance gets the dominant
effect, dark where the towers are); *a per-ball cube map* (six renders a
frame per ball; same answer); *anisotropic brushed steel* (reads as a
machined part, not a projectile).

**Tests** (`render-real-steel.test.ts`): the sun's glint lands where the
specular geometry puts it (the point whose normal halves sun and eye, by
fixed point; within 1 px); the steel's upper half takes the sky's blue and
its lower half the ground's brown (blue / red 1.20 and 0.79, against 0.96 and
0.91 for the coat); rougher steel narrows that split; the polished glint
saturates; painted and matte balls are unchanged by the option.

## Cost

All three are per-pixel ALU, no new passes or textures. The grain is about
20 ALU ops and 4 hashes per pixel in the composite; the tone maps are
switched on a uniform; the steel ball adds a function to the sphere shader
only. Bench variant `real-polish-off` (`pnpm bench:render`) pairs against
`real` for the step's total; the M5 Max frame caps (3 ms at 10k, 4 ms at
100k) are measured from the bench queue once the Mac is out of Low Power
Mode.

## Defaults and the review

Screenshots: the game (Rapier, SwiftShader, 1280x800) on B2's cathedral and
L1 through each tone map and grain level, and the render page's golden scene
with the old ball and steel at roughness 0.12, 0.2 and 0.35. They are in the
project files under `photoreal-polish/`. An Opus reviewer saw the images with
the options labelled A to D and no recommendation.

| Option | Default | Why |
|---|---|---|
| `toneMap` | `agx` (unchanged) | Ranked first: stone keeps its sand colour, shadows stay dense, crowns stay saturated without clipping. Neutral second ("more punch, but sunlit faces go peach; graded CG"), ACES third (bleaches highlights to chalk, cool and washed out), AgX base last (a grey veil, an ungraded log image). The others stay as options. |
| `grain` | 0.2 | 0.3 pleasant in a still, 0.6 reads as noise in the sky. At 120 Hz the grain changes every frame and the eye averages it, so 0.2 gives texture without being seen as grain. |
| `grainSize` | 1.5 px at 1080 lines | Right at 1280 wide. The reviewer's point that a fixed pixel size vanishes on high-DPI screens is taken: the size is now pixels of a 1080-line frame, scaled with the frame's height (`grainPixels`). |
| `ballMetal`, `ballRough` | 1, 0.2 | 0.12 shows a razor horizon line ("a chrome HDRI probe"); 0.35 reads as satin aluminium. |

Review points not acted on here:

- *The steel ball mirrors only the distant environment, not the towers
  next to it, and its lower half is a flat brown band.* Mirroring nearby
  blocks is the SSR / cube-map option weighed above; not worth its cost for
  one ball. The band is the ground's radiance times steel's 0.56: darker
  than the ground itself, as real steel is.
- *A darker rim so the ball keeps its outline against the sky.* Not
  physical, and in the game balls are painted by default; steel shows with
  `keystone.balls=plain`.
- Wider issues of the real look, added to the roadmap as follow-ups (not
  step 7): the per-block tint variation reads as a mosaic rather than
  masonry; gold crown blocks read as a printed decal (gilded brass would
  stay readable and look physical). The reviewer also asked for ambient
  occlusion, soft shadows and haze, which the real look has (steps 3 to 6);
  SwiftShader's small frames show less of them.

Not reviewed on a real GPU yet: how the animated grain feels at 120 Hz on
the M5 Max. It goes on the next play-session checklist
(`plan/play-session-checks.md`).
