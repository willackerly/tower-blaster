# Mode probes: results

The probes of [modes-roadmap.md](modes-roadmap.md) section 7, each a question about how the physics behaves at game settings that a family of modes depends on. A failed probe changes that mode's level grammar or parks it (section 8, stage 0). They gate Stages 2 and 3, not Stage 1.

**How they run.** `packages/mode-probes` (`@tb/mode-probes`): each probe is a set of cases (a scene built the way `compileLevel` builds a level: metres, 60 Hz, a plaster ground at friction 0.6 combined by `min`, Keystone's 40 iterations and 3e-5 m slop), a meter that reads the run as it goes, and a verdict over all cases against the roadmap's pass rule. The GPU engine runs them in a browser page.

```sh
pnpm probe:modes X1 --size full                    # Playwright's Chromium: SwiftShader on Linux
pnpm probe:modes X1 --size full --channel chrome   # the installed Chrome: Metal on the M5 Max
pnpm probe:modes X1 --size full --only "^line 200 nudge [0-3]"   # a subset (never decides the probe)
```

Each run writes `results/mode-probes/<id>-<size>-<time>.{json,md}`. `--size ci` is the cut-down set CI runs on SwiftShader (`packages/mode-probes/test`): it checks the harness and that the physics is sane, never the rule. SwiftShader results are valid physics (the same engine and WGSL; f32 arithmetic may differ from Metal's in the last bits, which chaos amplifies, so only distributions compare across devices); their timings are not performance results.

## Status

| Probe | Question | Gates | SwiftShader | Metal (M5 Max) |
|---|---|---|---|---|
| X1 | Domino propagation and sleep | M6, M16, C22 | CI size passes; full-size subset (line 200, curves, cocked; 4 nudges) passes | not run yet |
| X2 | Order matters in demolition | M5 | CI size: order matters on slab buildings | not run |
| X3 | Towers as dominoes | M6 Steer | CI size: cube and Kapla towers topple on, a bonded pier stops the front | not run |
| X4 | Cantilevers and hollows hold | M1 Hollow, M8 | CI size: stacks, span and brick arch behave | not run |
| X5 | Pinned anchors solid | C8 | CI size: pins exactly still, bodies on them match the ground | not run |
| X6 | Resonance under a gravity schedule; far-blast shove | M7 | CI size: no sign of resonance (rocking-block behaviour); far kick exact | not run |
| X7 | (optional) 1.5x domino amplifier | showcase | not planned | not run |
| X8 | Islands behave like solo worlds | C10 | CI size: outcomes match; a world tracks its f32 coordinates (mm) more than the shared solve (solo at origin cm apart) | not run |

## X1 Domino propagation and sleep

**Question.** Do domino runs propagate on AVBD at game settings, and does sleep leave them alone?

**Rule (roadmap).** Line and curves of radius 5 h or more reach the end in at least 98% of 32 nudges (so all 32: 31 is 96.9%); the field front reaches 95% of dominoes; no domino asleep mid-fall; a cocked (leaning, held) domino stays asleep for 60 s; the awake count at the front is logged.

**Setup.** Dominoes 1 m x 0.5 m x 0.15 m plaster (h = 1 m), 0.6 h apart along the path. A line of 200; curves of 8 straight, a half turn of radius 3, 5 or 8 h, 8 straight; a 100 x 100 brick-offset field (rows 0.6 h apart, columns 0.75 h, odd rows shifted half a column, so each domino lands on two of the next row). The world stands 90 steps (sleepers fall asleep), then a 0.1 m ball (2,000 kg/m^3) at about 1 m/s and 0.8 m up is spawned just behind the first domino (one per first-row domino for the field). Each of the 32 nudges jitters the push (speed +-10%, height +-5 cm, sideways +-3 cm) and every domino's placement (+-2 mm, +-0.5 deg of yaw) from its own seed. Every case runs with sleep off (the game today) and on (GPU sleep, the E2 rule).

**Meters.** A domino has fallen once it tilts past 15 deg. The run is over when everything has fallen or nothing new has for 3 s. Front speed: fall time against path position, fitted over the middle 60% of the run, also as a multiple of sqrt(g h). Awake counts every 5 steps: the most and the mean, and the most standing dominoes awake more than two pitches ahead of the front. **Frozen mid-fall:** the roadmap's "no domino asleep at a tilt between 5 and 80 degrees" would fail on every correct run, because a fallen domino resting on the next one legitimately sleeps at 20 to 60 degrees. The meter asks the question the rule stands for instead: 3 s after the run is over, a blast of no impulse wakes everything, and the dominoes that were asleep must not move on (largest tilt change over the next 2 s under 1 deg). A domino sleep had frozen mid-fall would fall on. **Cocked:** one domino leaning at 20 or 40 deg against a stone block, its tilt at step 120 (contacts loaded) the pose to hold; it must be asleep from early on to the end of 70 s, and drift less than 0.1 deg.

### Results

CI size on SwiftShader (`7357a4e` plus this probe; 2026-11-05): lines of 10 reach the end with sleep off and on at 0.90 sqrt(g h) (a short line, still accelerating); a 4 x 4 field falls entirely; with sleep, no standing domino ahead of the front is ever awake, every fallen domino sleeps, and waking them all moves none by more than 0.03 deg; the cocked domino falls asleep at 0.5 s and holds to 0.000 deg.

Full size on SwiftShader, a subset: line 200 and the three curves at nudges 0 to 3 with sleep off and on, and both cocked dominoes (36 of the 268 runs, 79 min, `7357a4e`; a subset never decides the probe):

| run | sleep | reached the end | front speed m/s (x sqrt(g h)) | awake max / mean | standing awake ahead of the front | unfreeze, max deg |
|---|---|---|---|---|---|---|
| line 200 | off | 4/4 | 2.82 (0.90) | 200 / 200 | 197 | - |
| curve r 3 h | off | 4/4 | 3.01 (0.96) | 30 / 30 | 27 | - |
| curve r 5 h | off | 4/4 | 2.96 (0.94) | 41 / 41 | 38 | - |
| curve r 8 h | off | 4/4 | 2.93 (0.94) | 56 / 56 | 53 | - |
| line 200 | on | 4/4 | 2.82 (0.90) | 16 / 12.2 | 0 | 0.066 |
| curve r 3 h | on | 4/4 | 3.01 (0.96) | 14 / 8.9 | 0 | 0.027 |
| curve r 5 h | on | 4/4 | 2.96 (0.94) | 14 / 9.7 | 0 | 0.027 |
| curve r 8 h | on | 4/4 | 2.93 (0.94) | 14 / 10.1 | 0 | 0.068 |

Every line and curve reached its end in every nudge, with sleep off and on, at the same front speed (0.90 sqrt(g h) on the line, 0.94 to 0.96 on the curves). Sleep changes nothing about the front and everything about the cost: at most 16 of 200 dominoes are awake at once (about 12 on average, the front and its tail), against all of them without sleep, and no standing domino ahead of the front is ever awake. Waking every sleeper afterwards moves none by more than 0.07 deg. The cocked dominoes at 20 and 40 deg fall asleep at 0.5 s and 0.7 s and hold, asleep, to 70 s with no measurable drift (0.000 deg); with sleep off they hold too, drifting 0.003 and 0.007 deg. Still pending: the remaining 28 nudges, the 100 x 100 field, and the Metal run.

## X2 Order matters in demolition

**Question.** Does the order in which charges fire change where a building ends up? If not, M5's timed charges are one verb with a delay nobody needs.

**Rule (roadmap).** The footprint metric differs between orders by at least 0.1 of its range on at least one design. The probe adds that the difference must exceed 3 standard errors of the nudge means, so nudge noise cannot pass it.

**Setup.** Two designs of 0.5 m plaster cells on the game's lattice (2% horizontal gap), 4 x 4 cells, 12 courses (6 at CI size). `cubes` is a solid block of cubes, as S14 builds a building. `slabs` is storeys of two courses of columns (the outer ring of cells and a 2 x 2 core) under a one-cell slab spanning the footprint. Four charges cut the whole ground storey between them: the core, the west wall, the east wall, and the north and south walls. A charge is a set of `remove` events (the C5 verb on today's events), so the only energy in the collapse is gravity's. Orders: all at once; the implosion (core, then walls 0.3 s later); a felling (everything but the east wall, then the east wall 0.3 s or 0.6 s later); and its control (east wall first, the rest 0.3 s later). The world pre-settles 300 steps; each of 32 nudges jitters every cell by up to 1 mm and 0.2 deg of yaw.

**Meters.** Spill, the fraction of the remaining mass whose centre ends outside the footprint grown by one cell on every side (range 0 to 1). Down, the fraction that ends more than 1 m below where it started. Lean, the remaining mass's mean x in cells (+ east). The rubble's height. A run ends when every body has been slower than 0.05 m/s for 1 s after the last charge, or 15 s after it.

**A finding from building it.** Partial charges under a cube lattice only drop columns straight down: with the 2% gap and no bond, a lattice of cubes is a bundle of independent columns, and nothing ties one column's fall to its neighbour's. That is why the charges cut whole storeys, and why the slab design exists: the slab is what makes a building a structure.

### Results

CI size on SwiftShader (4 x 4 x 6, one nudge, all at once vs the 0.3 s felling; 2026-11-05): the slab building felled west spills 0.39 of its mass outside the grown footprint and leans 1.87 cells west, against 0 and 0 when every charge fires at once. The cube block spills 0 under both orders (it drops in place). Both come down; no engine limit is hit. So at this size order matters for slab buildings and not for cube lattices, which says M5's levels need bonded or slabbed buildings for timing to be a decision.

Full size: pending (the Metal run: 2 designs x 5 orders x 32 nudges).

## X3 Towers as dominoes

**Question.** Does a falling tower knock the next one over, down a chain of slender towers? M6 Wavefront's Steer verb treats a skyline as a domino layout.

**Rule (roadmap).** At least one design propagates 12 towers in at least 80% of nudges, from chains of 6, 12 and 24. The probe runs chains of 24 and reads reach of at least 6, at least 12 and all 24 off each chain: until the twelfth tower falls, the first 12 of a chain of 24 move exactly as a chain of 12.

**Setup.** Towers about 4 m tall and 1 m square, 0.55 tower heights apart, in three designs:
- `cubes`: 2 x 2 columns of 0.5 m cubes on the game lattice, 8 courses. These are the game's own towers: four loose columns.
- `bricks`: a bonded pier of 1 x 0.5 x 0.5 m bricks, two a course, each course turned 90 deg.
- `kapla`: a crib of 1 x 0.3 x 0.1 m planks on edge, 14 layers, friction 0.45 as S15's planks.

After a 300-step pre-settle, a 0.4 m ball (2,000 kg/m^3) at 3 m/s hits the first tower at three quarters of its height. Each of 32 nudges jitters the push and every body's placement.

**Meters.** A tower has fallen once its centre of mass has moved 0.15 tower heights along the chain or dropped that far. 0.15 h is a pier tipped about 17 deg onto its neighbour, as a domino past X1's 15 deg. Reach is the unbroken run of fallen towers from the first. A run ends 4 s after the last new fall.

**Findings from building it.** A push of 1.5 m/s only rocks the bonded pier: on the f64 reference it tips 0.23 m at the top and recovers. Hence 3 m/s. A pier that tips onto its neighbour and leans there moves its centre only about 0.85 m, so a threshold of 0.25 h missed real falls.

### Results

SwiftShader, chains of 3, one nudge (`bfe47cc`, 2026-11-05; the CI test now runs chains of 2 with a shorter pre-settle, which took 300 s on a loaded CI shard):
- Cube towers: reach 3 of 3, about 0.75 s per tower. They crumble into the next one rather than tip as a unit.
- Kapla cribs: reach 3 of 3, about 1.9 s per tower.
- Bonded brick piers: reach 1. The first pier tips onto the second and leans on it, and the second holds it up.

So at this size the game's own loose towers and the Kapla cribs carry a wavefront and bonded piers stop it, which makes a bonded pier a Steer level's firebreak.

Full size: pending (the Metal run: 3 designs, chains of 24, 32 nudges).

## X4 Cantilevers and hollows hold

**Question.** Do cantilevers, corbelled spans and hollowed walls hold at rest at game settings, and fall when they should? M1 Undercut's Hollow levels and M8 Mason's Trial both ask the player to leave a structure standing on less than it started with.

**Rule (roadmap).** 95% harmonic stacks hold and 105% stacks fall; the corbelled 3 m span holds 60 s and carries a bowling ball in 80% of nudges; the arch holds. Each case runs at 20 and 40 iterations (Keystone plays 40) for 3,600 steps after a 300-step pre-settle.

**Setup.**
- Overhang: a harmonic stack of 8 blocks (1 x 0.25 x 0.5 m) over the edge of a 2 m pedestal. Block i from the top overhangs the one below by f L / (2 i), with f = 0.95 (every sub-stack's centre of mass inside its support, so it must hold) or 1.05 (every one outside, so it must fall). Four placement seeds each.
- Span: a corbelled 3 m span, seven courses of two bricks (1 x 0.5 x 0.5 m) a side, each course stepped 0.25 m inward, the top courses meeting 3.5 m up. It must hold 60 s, then carry the weapons' bowling ball rolled across its top at about 2 m/s, 32 nudges.
- Arch: a wall hollowed to an arch by removing the bodies whose centres lie in a half disc of radius R at its foot, after the pre-settle. Two walls: running-bond bricks with 1 cm joints (20 bricks x 25 courses, R 5 m) and the game's own lattice of 0.5 m cubes (40 x 25 = 1,000). The cube lattice is reported, not required: every column of it stands alone, so nothing over the hole has anything to rest on.

**Meters.** A body has dropped once it is 0.25 m below where it started; held means nothing dropped and no body moved 1 cm from its pose at the end of the pre-settle. Falls: the top block drops 0.2 m. **A hollowed wall holds** when only bricks over the hole come down (within R + 1 m of the centre line) and, from 300 steps after the removal on, no brick that stayed up moves 1 cm (no creep). The roadmap's "holds" had to be made precise this way: a running bond leaves a few bricks over the hole on a knife edge, and those fall in real masonry too.

**A finding from building it.** The first 105% run "held", because the stack fell during the pre-settle and the pose to hold was taken after it. Drops are now measured from the scene's own pose at step 0 and creep from the pre-settled one.

### Results

CI size on SwiftShader (40 iterations, one seed each; an 8 x 8 brick arch of R 1.6 m; 2026-11-05): the 95% stack holds (worst move 0.9 mm in 6 s); the 105% stack falls (its top drops 2.75 m); the span carries the ball across and moves 0.6 mm; the brick arch drops one brick, over the hole, and the rest creeps 0.2 mm. No engine limit is hit.

Full size: pending (the Metal run, at 20 and 40 iterations).

## X5 Pinned anchors solid

**Question.** Is a never-wake sleeper, C8's pinned body, as solid as the ground under impacts and a flood? M8 Mason's Trial and M10 Rube Lab both build on fixed anchors.

**Rule (roadmap).** No pinned body moves, and the bodies on it match a reference within tolerance.

**C8, emulated.** C8 is not built. Its mechanism is that a sleeper is an anchor (its pose fixed, its velocity 0, solved against as an infinite mass), and a pinned body is a sleeper that never wakes. The probe runs today's engine with sleep on, a rule under which nothing falls asleep (30 steps becomes 10^8) and no contact wakes anything (wake speed and depth 10^30), and writes the pinned bodies asleep right after init. No blast or removal runs, the only other wake.

**The reference.** Every case runs twice, as the same physics in two frames. In the pinned frame, the surface is the top face of a pinned box (normal Q y, through S) under gravity g. In the reference frame, the engine's ground plane y = 0 is the surface, under gravity Q^-1 g, with every other body moved to Q^-1 (p - S). The ground plane is the engine's one truly static body, so a pinned anchor is solid when bodies on it move as they move on the ground.

**Cases.**
- Slab: 50 x 1 x 10 m, its top 5 m up, struck at 45 m/s and 30 deg by the weapons' cannonball, which then slides along it.
- Wall: 6 x 1 x 6 m stood on edge, struck level at 45 m/s. Gravity runs along the face.
- Ramp: 20 x 1 x 6 m tilted 15 deg, under a flood of glass marbles (0.05 m, 2,500 kg/m^3): 1,000 at full size, 64 at CI size.

Four nudges each at full size.

**Pass tolerances.**
- A cannonball ends within 1 cm + 1% of its path of the reference.
- The flood is chaotic, so the two runs are two draws of it. Their end positions along and across the slope must be the same distribution (two-sample KS, p > 0.05), and the share still on the ramp must agree within 5%.
- Nothing sinks more than 1 mm deeper than on the ground (2 mm for the flood).
- A pinned body's pose, as the engine holds it, does not change at all.

### Results

CI size on SwiftShader (one nudge; 2026-11-05):
- Every pinned body moved and turned exactly 0 in f32, and nothing tunnelled.
- The cannonball on the slab slid 11.8 m and ended at the same place as on the ground to the last digit recorded (10 um).
- On the wall, the ball ended 1.7 cm from the reference, inside the 31 cm allowance. It bounced clear of the face by 4 to 6 cm in both frames.
- The 64-marble flood agreed: KS along the slope D 0.125, p 0.67; across, p 1.00; all marbles still on the ramp.
- The deepest sink was 0.1 mm in both frames.

Full size: pending (the Metal run).

## X6 Resonance under a gravity schedule; far-blast shove

**Question.** Do friction stacks resonate under a shaking gravity, and does a far blast give every body the same kick? M7 Aftershock is quakes. The roadmap's risk is that friction-held stacks slide instead of resonating, and claim 6 is that a far flat-core blast is a uniform world shove available today.

**Rule (roadmap).** The tall tower's failure frequency is lower than the short tower's, a monotone curve over 5, 10 and 20 cubes at 0.5 to 4 Hz. Every body in a far flat-core blast gets the capped dv within 1%.

**C7, emulated.** The gravity schedule is not built. Both engines read `SceneDesc.gravity` every step, and the probe's driver writes it before each step (`RunSpec.gravity`), which is what C7 would do. A horizontal gravity on a still ground is a shaking ground seen from the ground's frame. Sleep stays off under a schedule (the driver refuses it), because a change of gravity does not wake sleepers today.

**Shake setup.** Single columns of 5, 10 and 20 cubes (0.5 m plaster, aspect 1/n) stand 4 m apart. Each height appears 8 times in one scene (islands that cannot touch), and each scene shakes at one frequency:

g_x(t) = A(t) g sin(2 pi f t), with A(t) = 0.02 * 1.05^(f t)

So the envelope grows by 5% a cycle up to 1 g, after a 300-step pre-settle. The frequencies are 0.5, 0.75, 1, 1.5, 2, 3 and 4 Hz.

**Shake meters.**
- A column has failed once any cube is 0.25 m below where it stood.
- Its failure amplitude is the envelope when it was last nearly upright (top within 5 cm of over its base cube) before it failed, the start of the fatal excursion. Read at the fall, it would overstate the threshold by the growth during the fall, up to 20% at 4 Hz.
- A column whose base cube slides 0.1 m first is counted as sliding.
- The most destructive frequency for a height is the one with the least median failure amplitude.

**Two references.**
- Statics: a rigid column tips once a steady side load passes g/n (0.2, 0.1 and 0.05 g).
- The rocking block (Housner 1963): a block of half-diagonal R rocks at p = sqrt(3 g / 4 R), which is 0.38, 0.27 and 0.19 Hz here, below every shaking frequency. Above p, the amplitude that overturns it grows about as (1/n) sqrt(1 + (omega/p)^2). A rocking block is not an oscillator with a natural frequency, so this predicts no resonance: the lowest frequency is the most destructive at every height, and the rule as written fails.

**Shove setup.** Two worlds take a blast centred 1 km off along -x at their mid-height (100 m too at full size). The blast has radius 3 km, core 0.999, no falloff, and an impulse far above the 3 m/s maxDv cap:
- 1,000 cubes 1 m apart, floating in no gravity;
- a standing 6 x 6 x 8 cube building on the game lattice.

Expected: every body gets 3 m/s along (p - centre) / |p - centre|. The probe measures each body's velocity change over the blast's step, and 10 steps later the spread of the bodies' velocities along it. The rule's check is the kick itself, on the free cubes. On the standing building the same step also solves contacts. Coulomb's answer for a stack that moves as one is a uniform loss of mu g dt there (3.3% of 3 m/s), and that is reported against.

### Results

CI size on SwiftShader (one column of each height at 1 Hz with 15% growth a cycle; 2026-11-05). Two more runs shook at 2 and 3 Hz, where no column of any height fell below 1 g (the 20-cube column rocked from 0.56 g at 2 Hz, the 5-cube one from 0.29 g).

| | Fails at | Rocking estimate | Static threshold |
|---|---|---|---|
| 20 cubes | 0.25 g | 0.26 g | 0.05 g |
| 10 cubes | 0.61 g (slid first, at 0.57 g) | 0.38 g | 0.10 g |
| 5 cubes | 0.64 g | 0.56 g | 0.20 g |

- The 20-cube column first rocked off its base at 0.063 g. The rocking estimate is close for the slender columns, and the 10-cube column reached the friction limit (0.6 g) before it could overturn.
- So at this size the tallest column falls first at 1 Hz, nothing falls below 1 g at 2 or 3 Hz, and nothing suggests a resonance. The Metal run's frequency sweep decides the rule, and the rocking-block reference predicts that it fails.
- If it does, M7's level grammar should not rely on tuning a quake to a tower. Amplitude and duration are the levers, slender towers fall first, and low frequencies do the damage.

The shove:
- **The kick is exact.** All 1,000 free cubes got 3 m/s along their own direction to the centre, to 1e-7 of maxDv, with the centre 1 km away in f32.
- **On the standing building the blast's step does not keep the building together.** The bottom course keeps 0.85 of the kick, the courses above lose up to 12%, and the mean is 0.955, against Coulomb's uniform 0.967.
- Ten steps later the bodies' velocities along the blast spread by more than maxDv, with a mean of 0.73: the bottom drags on the ground and the upper courses run on.

So a far blast is a uniform shove of every body, as claimed, but a standing cube building does not take it as a rigid unit; its courses part within a sixth of a second. For M7 a shove is a jolt that breaks lattice buildings up, not a way to slide one, and its look wants a play-session check.

Full size: pending (the Metal run: seven frequencies, eight columns of each height; shoves at 100 m and 1 km).

## X8 Islands behave like solo worlds

**Question.** Do K copies of a small level, far apart in one solve, give the same outcome distribution as K solo runs of the same jittered shots? C10 (many worlds in one solve) is what M8's robustness judge, M9 Chorus and cheap casts of small levels build on.

**Rule (roadmap).** Outcome distributions match (two-sample KS test, p above 0.05); cost per body within 10% of a solo 9.6k scene.

**Setup.** The level is a 5 x 5 x 6 block of 0.5 m plaster cubes on the game lattice (150 bodies), struck at mid-height by the weapons' cannonball at 45 m/s. Shot k is jittered from its own seed (speed +-10%, aim +-0.4 m across and +-0.3 m up), and so is its block (+-1 mm, +-0.2 deg). The same 64 shots run three ways:
- `islands`: all 64 worlds in one scene, 40 m apart on an 8 x 8 grid centred on the origin. They share the solve, the colouring and the broadphase, never a contact.
- `solo`: each world alone at the origin, which is what a cast runs today.
- `solo-far`: each world alone at its island's position. These are the same f32 coordinates as in the islands run, without the other worlds.

`solo-far` separates "sharing the solve" from "far from the origin in f32". The timing half of the rule is read only off a Metal run. The full size adds a 9.6k-cube block (40 x 40 x 6) to time against.

**Meters.** Read 4 s after the shot (1.5 s at CI size):
- down: the share of cubes more than one cell below where they stood;
- moved: the share whose centre moved more than 0.1 m;
- the block's centroid, to compare each world with its island directly.

KS compares the islands' down and moved with the solo runs' (the rule) and with solo-far (a diagnostic).

### Results

CI size on SwiftShader (3 islands of a 3 x 3 x 4 block, 36 bodies, read 1.5 s after the shot; 2026-11-05; a 4-island run gave the same picture):

| Arm | Outcome as its island (down and moved) | Largest centroid shift from its island |
|---|---|---|
| solo-far | 3/3 | 8 mm |
| solo at the origin | 0/3 | 9 cm |

The KS tests pass, but three worlds cannot decide a distribution. The finding is in the comparison: islands are not bit-identical to solo runs, as the roadmap expected (colouring is global). The coordinates matter about ten times more than sharing the solve: a world run alone at its island's position lands within millimetres of its island, while the same world at the origin ends centimetres away, with a different down or moved count in most worlds. Each world is chaotic, so only distributions should depend on islands, and the full run tests exactly that.

Full size: pending (the Metal run: 64 islands, 64 solo and 64 solo-far runs, the 9.6k block for the cost ratio).
