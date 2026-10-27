# World scale (`scale`, `substeps`)

Will (2026-10-27) asked for smaller cubes, about 0.25 m edge to edge, seen
from lower down, so that things move faster, and offered "tweak scales and
gravity coefficient" as an alternative to resizing everything.

## The choice: keep unit cubes, change gravity

For rigid bodies with friction and no restitution, the only dimensionless
number that involves time is g dt^2 / L (Froude similarity). A world of
cubes L metres across under gravity g behaves exactly like a world of unit
cubes under gravity g / L, with lengths in cube units. So "quarter-metre
cubes" is gravity 4 g in cube units, nothing else resized.

- Considered: resizing every scenario's geometry by 0.25. Every length
  constant in the solver (margin, slop, restDepth, matchDistance,
  stickThreshold, maxSweep), every scenario, the camera rig and the
  renderer's geometric pieces (bevel, AO radii, shadow fit) would have to
  move with it, and the solver's tuning was all done at unit cubes. The
  gravity route moves none of them.
- The viewer knob `scale` (metres per cube edge, 0.01 to 10, default 1 or
  a scenario's `ScenarioDef.scale`) does three things (`worldScene`):
  gravity / scale, starting and spawned speeds x 1 / sqrt(scale)
  (`froudeSpeed`: a scenario's throw keeps its arc in cube units), and the
  fired projectile's speed x the same.
- It is exact only if the solver's stiffness-like parameters move too.
  `froudeParams(p, k)` (physics-ref) scales beta, penaltyMin and penaltyMax
  by k = 1 / scale and maxAngularSpeed by sqrt(k); `worldEngineSpec` applies
  it to the AVBD engines (avbd-gpu, avbd-ref), from the spec's own values or
  the defaults. Everything else in AvbdParams is a length, a ratio or a
  count, and the load cap's pairLoad and the stiffness floor
  sqrt(m_a m_b) / dt^2 scale on their own. Tests: on the CPU (f64), 4 g at
  dt with froudeParams(4) is the unit world at 2 dt, twice as fast, to the
  bit (both are powers of two; measured without froudeParams: 1.07 m apart).
  On the GPU (f32, whose divisions and square roots need not round alike)
  the same comparison holds to 25 um on a non-chaotic scene, 1.9 mm without
  froudeParams.
- The cost: a world at scale s stepped at 1/60 s is the unit world stepped
  at 1/(60 sqrt(s)) s, so quarter-metre cubes at 60 Hz are 1 m cubes at
  30 Hz. That matters. Measured once on the GPU (SwiftShader, 2026-10-27;
  a one-off run, not a test: engine-scale.test.ts checks the similarity on
  a small scene), a 3x3x16 S14 tower knocked by the default ball:

  | run | farthest cube from the axis (cube edges), every 1 s of 1 m-world time (0.5 s at 4 g) |
  |---|---|
  | 1 g at 1/30 s | 1.41, 1.41, 14.6, 37.3, 52.9, 62.5 |
  | 4 g at 1/60 s with froudeParams | the same to 2 decimals |
  | 1 g at 1/60 s | 1.41, 1.41, 6.22, 16.0, 20.9, 21.4 |
  | 4 g at 1/120 s with froudeParams | the same to 2 decimals |

  The similarity holds even through a chaotic collapse, and the coarser
  step throws the tower three times as far (Opus review saw the other
  side of it on light knocks, damped 13 to 80%). So `substeps` (1 to 8)
  defaults to `autoSubsteps(scale)`, the fewest that keep each step no
  coarser than the unit world's 1/60 s: 2 at 0.25 and 0.5 m, 1 from 1 m
  up. That doubles the physics cost at quarter-metre cubes. Scenario
  input steps, `autofire` and loop=frame's `maxSteps` are counted in
  1/60 s and multiplied by it. `substeps=1` (or any other) in the URL or
  the panel overrides it.

## Rendering at real size

`FrameParams.metres` (the viewer passes `scale`) tells the renderer how big
a world unit is. Metric things are drawn at their real size, which is
1 / metres as large in world units (`lookUniforms(look, metres)`): the
stone and ground texture tiles, the stone's fade-out footprint, the
ground's relief and the hills' distance; the air's extinction is per unit
(x metres) and the eye's height for the sky is in kilometres (x metres).
What belongs to the blocks keeps their units: bevel, AO, shadow offsets,
and dust puffs and chips (which scale with what threw them). Particles run
1 / sqrt(metres) as fast (dt x froude), as the bodies do, and the impact
detector reads speed changes times sqrt(metres) (`Sparks.encode` dvScale),
so a knock raises the dust it would in the unit world.

- Test: an empty arena seen from (0, 5, 22) at metres 1 and from 1 / metres
  as far at metres 0.25, 0.5 and 2 draws the same frame (ground, relief,
  patches, haze, sky, hills) to 1 of 255 on 1.2 to 4.6% of channels;
  dropping the haze conversion moves channels by 27.
- Opus review: at 25 cm cubes the 4x finer ground and 4x thinner haze
  (relative to the cubes) are most of the fix for "blurred low-res ground
  at height"; a lower orbit (pitch about 0.3 rad, 2.5 to 3x the arena
  radius, FOV 45) reads as a tabletop.

## Knobs

- URL: `scale=0.25` (substeps follow: 2), `substeps=n` to override.
  Scene panel: "cube edge (m)", "physics substeps" (set to the size's own
  when the size changes), under the seed; the line under them says what
  they do ("4 g in cube units, 2x as fast, 2x physics cost"). The saved JSON keeps
  them in `scene.scale` and `loop.substeps`.
- `ScenarioDef.scale`: a scenario's default (none sets one yet).

## Camera framing (`view.*`)

Will also asked to be "generally lower to the ground". A scene without a
start camera (`cam`) is framed by `frame(min, max, view)` (viewer
camera.ts). Its knobs live in the URL (`view.pitch`, `view.fit` and
`view.fov`), in the panel's Camera section (applied live: the camera jumps
to the new framing) and in saved files (`view`).

- The default is pitch 12 degrees, field of view 45 degrees, fit 1.05.
  Before, it was 21.8 degrees and 50 degrees, at 1.35 times the distance
  where the box's bounding sphere filled the view.
- Fit now measures the box rather than its sphere. 1 is the closest
  distance at which all eight corners of the box are inside a square view.
  The sphere was loose for wide, flat scenes like the city and tight for
  tall towers: at 12 degrees and fit 0.9, S1's tower ran off the top. A
  property test checks that fit 1 puts the furthest corner exactly on the
  edge, for any box, pitch and field of view.
- The values were picked from renders of S4 and S14 at 22, 17, 12 and 8
  degrees. 12 puts the eye about half as high above the target as before
  and still shows the back rows. 8 hides them.
- A test frames every scenario's defaults and checks that all bodies are
  on screen at 16:9 and 4:3.
- The framing is in cube units, so at `scale=0.25` the eye is also 4x lower
  in metres.
