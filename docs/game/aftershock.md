# Aftershock (M7): design the earthquake

Roadmap node M7 (docs/game/modes-roadmap.md). The player gets one quake and a site of towers. Each tower is
**condemned** (its top is a crown: bring it down) or **protected** (its top is heritage: it must still stand when
the dust settles). The player sets the quake's strength, frequency, duration and axis, watches the ground shake,
and is scored on what fell and what stood. Retrofitting (roadmap row M7b, "Retrofit" below) turns it around: the
quake is the level's, and the player braces the town before it comes, with C9's build tool and a block budget.

## The verb: a quake shot

A quake is a shot (keystone `shots.ts` `QuakeShot`) of four integers, so it rides the record, the text line, undo,
replay and the cast like every other shot:

| field | unit | range (QUAKE_RANGE) | game default dial (QUAKE_DEFAULTS) |
|---|---|---|---|
| `peak` | % g of side load | 1 to 100 | up to 80 |
| `hz` | 0.1 Hz | 2 to 40 | 3 to 30 (0.3 to 3 Hz) |
| `sec` | 0.1 s | 5 to 200 | 5 to 120 (0.5 to 12 s) |
| `axis` | degrees from +x toward +z | 0 to 179 | 15 degree steps |

Its text is `quake.<peak>.<hz>.<sec>.<axis>` (`quake.50.10.15.0`); its record code is 7. A level may narrow the
dial and set an energy budget (`LevelDef.quake`, `QuakeRules`; part of the level hash).

**Engine input.** The shot becomes C7 field events (engine-api `quakeEvents`): the ground's acceleration seen from
the ground's frame, so a horizontal gravity term `peak g env(t) sin(2 pi f t)` along the axis, with a linear rise
and fall of a quarter of the duration each, one key per step where the quantised value changes, and the level's
gravity restored exactly on the last step. A level with a quake in its rack compiles its gravity onto the field grid
(2^-12), so "restored exactly" is bit-exact. The Driver holds the shot open until the quake has ended, so a quake
never settles mid-shake.

**Exact trig.** `Math.sin` is not correctly rounded, and V8 in Node and the browsers' engines may differ in the last
bit. The quake keys use engine-api `exactSin`/`exactCos`: a two-part range reduction and a degree-19 odd polynomial
using only IEEE-exact operations (+, -, *, Math.round, Math.sqrt), so every machine computes the same keys. Tested
three ways: within 1e-15 of `Math.sin` for |x| < 2 and 5e-13 out to 1500 rad (`field.test.ts`); a pinned digest of
a quake's keys; and Chromium computing the very digest Node does (`keystone-lab/test/quake-gpu.test.ts`).

**Energy.** A quake is charged `E = M (A g)^2 T / (12 pi^2 f)` (keystone `quakeEnergy`), with M the moving
(non-pinned) structure mass: the work a sinusoidal ground motion of that acceleration does on a rigid mass, averaged
over the envelope. It is an input, not a measurement, so it reads the same on every engine. It feeds leverage as a
weapon's yield does, the stars (below) and the budget.

## What separates towers

Probe X6 found no resonance: a friction stack rocks as a Housner block, the overturning load rising with frequency
from the static `g/n` (docs/game/mode-probes.md, X6). So "resonance drops the tall towers" is out (see Alternatives).
The design search (`pnpm keystone:quake curves ...`, reference engine, nudged builds) found four levers that do
separate towers:

1. **Amplitude through slenderness, at low frequency.** At 0.5 Hz towers fall near their static threshold,
   slender ones first: a column of n cubes goes at about 1/n g.
2. **Size, at about 1 Hz.** A big tower of the same slenderness rides out what fells a small one (the rocking
   block's size effect: its rocking frequency falls as sqrt of its size). col4 falls at 0.45 g for 1.5 s at 1 Hz,
   an 8-storey slab of the same aspect holds to 1.0 g.
3. **Duration.** A short sharp 1 Hz quake (1 to 1.5 s) fells short columns (col3 at 0.50 g, col4 at 0.45 g) while
   tall ones (col8 holds to 0.70 g) ride it out; a long one fells the tall towers first.
4. **Axis, against a bonded wall's thin side.** Rod walls (one rod per storey, long along z) fall at 0.20 g shaken
   across, 0.30 g at 45 degrees, 0.65 g along their length (0.5 Hz, 6 s). Cube walls are not direction-sensitive:
   their cubes rock one by one.

At 2 Hz and above nothing topples on the dial; blocks slide instead. So the top-left of the dial (strongest,
slowest, longest) is brute force, and the levels are built so that brute force fails.

## Level grammar

- **Pinned parts** (`BlockPart.pinned`, `BoxPart.pinned`, C8): bedrock, plinths. A pinned body needs no support and
  no mass ratio, and is not shaken (not in the energy's M). A crown or heritage body may not be pinned.
- **The quake objective** (`objective: { kind: 'quake' }`): every crown down and no heritage broken. It needs at
  least one of each, outcome scoring, and no Bounce (the restitution pass refuses pins).
- **Heritage judged standing** (`heritage: 'standing'`): a protected tower is broken only if, at a settle, its top
  has dropped 0.3 h below home or tilts past 15 degrees (`heritageFallen`). The default pose rule breaks heritage
  the first step it moves 0.3 h, and a tower that rocks through a quake and stands moves more than that: under the
  pose rule the gate's best quake on Short Sharp Shock (A4) breaks the tall tower it spares (`quake.test.ts`, same end
  hash, different judgement).
- **Sites** (keystone `aftershock-towers.ts`, `aftershock-levels.ts`): towers named by id, `col<n>`, `slab<n>x<w>`,
  `wall<n>x<w>`, with `-<material>` and `-anchor` (bottom storey pinned). `aftershockLevel` builds the LevelDef: the
  lot is the towers' box grown by the tallest height plus 2 cells, so a felled crown thrown off the lot is down and
  no protected tower is judged by the lot; the crown line is half the lowest condemned crown's height.

## The design search and the choice-matters gate

`pnpm keystone:quake levels QC-1,...` (keystone-lab `quake-search.ts`), on the reference engine:

1. **Screen**: the naive quake and a grid (peaks 0.15 to 0.75 g by 0.05; 0.3, 0.5, 0.8, 1, 1.5 Hz; 1, 1.5, 3, 6,
   12 s; axes 0 or 0/45/90) on one nudged build.
2. **Confirm**: the naive quake and the best 4 (met most often, then tower score, then least energy) on 8 nudged
   builds. A nudge moves every body up to 1 mm and turns it up to 0.2 degrees (probe X2's), pinned bodies untouched.
3. **Gate** (`quakeGate`): the best quake meets the objective on at least 80% of the builds; its tower score (share
   of towers judged right) beats the naive quake's by at least 0.1 and by more than 3 standard errors (SE floor
   1e-3); and the naive quake (strongest, lowest frequency, longest, along +x: `naiveQuake`) meets it on at most
   20%. A level ships only if it passes.

Results are in docs/game/mode-probes.md, X6 "On levels".

## Levels

| id | name | site | lever | best quake (3 stars) | grid quakes that clear it |
|---|---|---|---|---|---|
| A1 | Slow Sway | col8 C, col4 P, col7 C, col3 P | amplitude | 0.25 g, 1 Hz, 1 s (35 J) | 36 of 325 |
| A2 | Big Brother | col4 C, slab8x2 P, col4 C | size | 0.40 g, 1 Hz, 1 s (163 J) | 56 of 325 |
| A3 | Cross Grain | rod walls: C laid along x, P along z | axis | 0.25 g, 1 Hz, 1 s at 90 degrees (114 J) | 179 of 975: all at 90 degrees |
| A4 | Short Sharp Shock | col3 C, col8 P, col4 C, col7 P | duration | 0.50 g, 1 Hz, 1.5 s (209 J) | 4 of 325 |
| A5 | Fault Line | rod wall C, slab8x2 P, col4 C, rod wall P | axis and a short jolt | 0.40 g, 1 Hz, 1 s along x (284 J) | 38 of 975: 37 along x, 1 at 45 |

C: condemned, P: protected. Cross Grain's first search passed with its answer along x, the dial's starting axis
(182 of 325 grid quakes met it at 0 degrees, 1 at 45, none at 90): the axis lever is real, but a player who never
touched it was right by default. Its row now runs along x, so the answer is 90 degrees (179 of 325 there, none at 0
or 45). Fault Line's answer stays along x: by then the player has met the axis, and its new lever is the jolt. The
dial's starting quake (0.3 g, 1 Hz, 3 s along x) clears no level.

Order: A1 first because many quakes clear it (a gentle 1 Hz jolt, or a slow sway sized to the slender towers); A4
late because only a narrow band of the dial clears it; A5 last because it needs two levers at once. Each level's towers are its candidate site's exactly
(`quake.test.ts` compares the compiled scenes), so the physics the gate judged is the physics played.

## Scoring and stars

Agreed with the scores thread (PT9/PT16, docs/game/scoring.md):

- **Tally** (`outcomeTally`, quake branch): Objective (1,000 when met), Condemned (500 per crown down), Heritage
  (-500 per protected tower broken). No Collapse or Leverage line: both pay for the protected towers falling too.
- **Stars on energy** (`metric: 'energy'`, lower is better, `lowerIsBetter`): one for meeting the objective, two at
  or under T2 joules, three at or under T3 with no heritage broken; beat the bot under the cast's best.
  `OutcomeFacts.energy` is `energyFired`, the very sum leverage divides by.
- **The cast** (`quakeStars`, cheap: the search's own plays): T3 is the cheapest confirmed quake's energy times 1.1;
  T2 the median energy of the grid quakes that met the objective on the screen; both rounded up to two figures.
  The budget is 4 times T2: room to explore, none for the dial's brute end. Since the energy is the shot's, only
  "met" depends on the engine, and every shipped level's ace clears it on the GPU solver
  (`quake-aces.ts`, SwiftShader), so the stars are marked for the game's engine (`engine: 'gpu'`; the
  game marks stars cast for another engine custom).
- The ace (`solutions.ace`) is the cast's best quake.

## The quake designer

`packages/game/src/quake-panel.ts`, in the HUD's control tray in place of power and height while the Quake chip is
selected:

- Four dial rows with minus and plus buttons (44 px on an upright phone, where the docked tray shows them as two
  columns with the seismograph, meter and Start on one line, and the lone Quake chip hidden) and keys: Strength Q/E (5% g), Frequency A/D
  and Duration Z/X (along fixed stops inside the level's range), Axis C/V (the level's axis step, wrapping at 180).
- A seismograph: the side load the towers will feel, read off the very field events the engine gets.
- A compass: the axis as the camera sees it (the axis azimuth plus the camera's yaw), so "across the walls" reads
  on screen.
- The energy meter against the level's budget (red and Start disabled over it), or without a budget against the
  dial's brute end.
- Start (Enter): the quake fires through the same `fire()` as every shot, refused by `quakeRefusal`.
- The dial starts at the level's seed (below; else 0.3 g, 1 Hz, 3 s along x) and is kept over Retry and Undo, so
  the player iterates.

**Camera.** The camera moves only on player input (Will, 2026-11-02). A quake moves no camera: the ground moves
under the towers (below), and the view stays where the player put it. Screen shake stays opt-in.

## Seeing the quake (PT25)

Agent playtest round 2 (docs/game/agent-playtest-2.md, PT25) found the quake invisible: ground, grid and camera
stood still, the dial gave way to Power and Height while it ran, every level opened on the same dial, which on Big
Brother (A2) does nothing for 7 s and scores 0, and the phone dial lost its labels and took 35.1% of the screen.

**The ground moves** (`game/src/quake-ground.ts`, option `keystone.quakeground`, on by default). The engine shakes
nothing: a quake is a side gravity on a still ground, the ground's own frame. A watcher off the site sees the ground
move instead, by the side load integrated twice and turned around (a ground accelerating at +a pushes what stands on
it toward -a). The double integral ends with some velocity left, which would carry the ground away, so the straight
line from its first point to its last is taken off: it starts and ends at rest at home. The game draws the site (the
ground, its grid and every body) displaced by that motion: the frame's view-projection times a translation, between
snapshots by the same alpha as the bodies. The camera's own state never changes, so the camera rule holds and the eye
reads the shaking against the frame of the screen. True scale: 0.3 g at 1 Hz moves the ground about 7 cm (a seventh
of a cube), A1's ace 5.4 cm, A4's 21.7 cm, the retrofits' 6.5 cm.

**Dust at the towers' feet** (`dustBeats`, `Renderer.dust`): each swing's strongest push (the side load's peaks,
twice a cycle, above 0.05 g) puffs dust in a ring round the foot of every condemned and protected tower, harder for a
stronger swing, capped at the chips' threshold so a swing throws no stone. It is the real look's dust (its debris
mode); the stylised looks draw impacts as sparks, and sparks at a tower's foot would read as a hit, so they have none.

**The panel stays up** while the quake runs (`quakeRunHtml`): the four values without buttons, the compass, the
seismograph with a playhead at the drawn step, and "N s left" then "settling".

**Each tower's marks on the dial** (`game/src/quake-ticks.ts`). The row asked for each structure's natural frequency
on Frequency, but X6 found that friction stacks do not resonate (they rock as Housner blocks), so a resonance tick
would teach the wrong thing. Two numbers from the same model do tell towers apart, from the geometry alone:
- **Strength: where it starts to rock.** A joint lifts only when the side load passes g times its contact half-width
  over the height of the centre of mass above it (statics; a column of n cubes at g/n, corner-on at sqrt 2 / n).
  Below a tower's mark the quake cannot rock it at all; near it, at low frequency, it falls (the search's finding).
- **Frequency: its rocking frequency** p = sqrt(3 g / 4 R), R the half-diagonal of the tower as one block (0.30 Hz
  for a col8 or a slab8x2, 0.43 for a col4). Near or below p a quake tips the tower like a slow tilt; above it the
  load to fell it climbs about as sqrt(1 + (omega / p)^2), sooner for a big tower: the size lever.
Condemned towers' marks are gold, protected ones' blue, the dial's value a caret. The marks follow the axis.

**The dial's starting quake** (`QuakeRules.start`, keystone-lab `quake-seed.ts`, `pnpm keystone:quake-seed`). A
level's seed is the quake its dial opens on: one that does part of the job (a condemned tower down, fewer protected
ones broken, so the round scores above 0) and does not clear the level, so Start teaches something and the levers
are still the player's. The search runs on the reference engine: candidates on the dial's own stops (0.15 to 0.6 g,
0.3 to 2 Hz, 1 to 4 s, axes 0, 45, 90, 135) inside the level's budget, nearest the old start first in dial steps
(5% g, a stop, 15 degrees); the nearest 400 screened on one nudged build, those that pass confirmed in batches on 8,
where a seed must do part of the job on at least 7 and clear the level on at most 1. The seed is the nearest such:
the dial opens as near as it can to where it always did. `start` is not part of the level's hash (it changes no
outcome), so the levels keep their stars.

| level | seed | dial steps from the old start | reference: part of the job / cleared (8 builds) | GPU solver (SwiftShader) |
|---|---|---|---|---|
| A1 Slow Sway | 0.30 g, 0.6 Hz, 3 s along x | 2 | 8 / 0 | 2 condemned down, 1 protected broken: 500 |
| A2 Big Brother | 0.35 g, 0.8 Hz, 2 s along x | 3 | 7 / 1 | 2 down, 1 broken: 500 |
| A3 Cross Grain | none: the old start (0.3 g, 1 Hz, 3 s along x) | 0 | 0 / 0 (nothing moves) | |
| A4 Short Sharp Shock | 0.40 g, 1.2 Hz, 1.5 s along x | 5 | 8 / 0 | 1 down: 500 |
| A5 Fault Line | 0.25 g, 0.8 Hz, 3 s along x | 2 | 8 / 0 | 1 down: 500 |

Big Brother's novice run (the agent playtest's, which scored 0) now opens on a quake that fells both columns and
breaks the slab tower on the GPU: 500 points, and the slab tower's blue mark sits at the same Strength as the
columns' but far left on Frequency, so the player can see what to try (faster, shorter). Cross Grain has no seed:
every quake that does part of its job was turned off the starting axis (the search's nearest, at 45 and 135 degrees,
did part of it on 1 of 8 builds), and its lesson is the axis. On the old start nothing there moves, and the marks
say why: along x the condemned walls' gold marks sit at 0.5 g, the protected walls' blue ones at 0.17; turned to 90
degrees they swap. The search's numbers and wall times (60 to 370 s a level on 4 cores) are in
results/quake-seed/ (not committed).

**The phone dial** keeps its four labels, each over its value inside its 44 px row (`.qv::before`, the label in
`data-label`, so the value's text stays the value), and upright the panel's foot (seismograph, energy, Start) shares
its line with Undo and Restart while the action slot is idle (one flex wrap through `display: contents`). The
docked HUD covers 29.4% of a 390x844 screen on A2 (from 35.1%), as a launcher's does. Sideways keeps its rail.

## Retrofit (M7b)

A retrofit is an Aftershock level turned around. The quake is the level's own and is coming; the player braces
the town first, with C9's build phase and a block budget, and is scored on what stands and on what was spent.

### Grammar

- **The level's own quake** (`quake: { fixed: { peak, hz, sec, axis } }`, keystone `quake.ts`): the dial is locked
  to it. `quakeRulesOf` collapses the ranges onto it, `quakeRefusal` refuses any other quake ("this level's quake is
  fixed: 30% g, 1 Hz, 1 s at 0 degrees"), and `naiveQuake` is it. `checkQuakeRules` takes whole dial numbers only and
  no `peakMax`, `hz`, `sec` or `axisStep` beside it (a budget may stand beside it: the energy is still shown).
- **The objective** (`objective: { kind: 'quake' }` with a `build` block): no crown is needed, only heritage. Met at
  the settle with every protected tower standing (`heritage: 'standing'`). Without a build block a quake level still
  needs a crown.
- **Sites** (`RETROFIT_SITES`, `aftershockLevel` with `build`): protected columns among the rest of the town, role
  `city` (sturdy halls, `slab<n>x3`, which this quake does not move). A retrofit site must have `quake.fixed`.
- **The bin** (`RETROFIT_BUILD`): cube, pier of three, course of four, wall 4x2, plank, beam and slab; no domino
  brush. Pinned parts (C8, M10) are allowed in a retrofit's authored geometry, and the viewer's level file now
  reads `pinned`, `quake`, `heritage` and quake solutions.
- **Settle v3**: every Aftershock level names `settle: 'v3'` (every cast and gate ran under it), in the level file's
  place for it, so the hashes hold whichever outcome default main has (PT6b, docs/game/settle-v4.md).

### The game

The level opens in the build phase (C9): the status line shows "N of budget left" and every placement spends from
it. Play loads the level as built. The quake panel is the fixed panel (`fixedPanelHtml`): the quake's four values
without buttons or keys, the compass and seismograph, "spent / budget braced", Start (Enter) and the note "the
level's quake: it is coming, brace for it". Retry keeps the build; B rebuilds before the quake.

### Scoring and stars

- **Tally**: Objective (1,000 when met), then **Budget left**, 10 a block unspent (only when met), and Heritage
  (-500 a protected tower broken) as in Aftershock. A retrofit has no condemned towers, so no Condemned line.
- **Stars on what was built** (`metric: 'built'`, lower is better): `OutcomeFacts.built.spent` is `placedCost` of
  the level as played. One star for the objective, two at or under T2 blocks, three at or under T3. T3 (and the
  best) is the cheapest robust bracing the search found; T2 the other family's cheapest. So either way of bracing
  earns two stars and the cheaper three.
- **Stars and progress belong to the level as authored** (`CompiledLevel.baseHash`): a build changes the level's
  hash (its placed parts are geometry), but the stars and the game's progress (best, record) are keyed on the hash
  of the level with its placed parts taken out. Without this, every build would be a new level with no stars and a
  fresh record (Rube Lab's progress reset on every build until now; it is keyed the same way).
- **The budget**: half as much again as the dearer family's starting bracing, rounded up to ten, at most 200 (the
  roadmap's bound): room for either family and a clumsy build, not for bracing everything twice.

### The search and the gate

`pnpm keystone:retrofit RC-1,...` (keystone-lab `retrofit-search.ts`), on the reference engine. Every brace is a
program of build-tool steps (`BuildSession`: a face hit, snap, overlap and budget checks), as a player places it:

- **buttress**: a pier beside the tower on each side along the quake's axis, k cubes high (k = 3 is one pier stamp);
- **tie**: a plank (or a beam, or a slab) from the tower's top onto a hall of its height one cell away along the axis.

A bracing is **robust** if every protected tower stands on at least 7 of 8 nudged builds (the M7 nudges, placed
bodies too). Each family starts from every tower braced (a tie family buttresses the towers with no hall to tie to)
and is made cheaper one brace at a time (a lower pier, a cheaper tie, or none) while it stays robust. A site ships if:

1. the bare site meets the objective on at most 1 of 8 builds, and **every protected tower falls** on all but at
   most 1 of 8 (no tower is decoration: each brace is needed);
2. at least two families have a robust bracing within the budget;
3. the obvious wrong build (every tower buttressed across the quake) fails as the bare site does.

The quake: 0.3 g, 1 Hz, 1 s. The probes found it fells a lone column of 5 or 6 cubes on every build, and a pier
half the column's height either side along the axis, or a plank tie to a hall, saves it on every build; it does not
move a 3-cell-square hall even at 0.35 g. What does not save a column: a pier on one side only, full-height piers,
filling the cell between the column and its hall, or capping a pair of columns with a slab, plank or beam.

**Where the halls stand.** A column with a hall one cell away on the axis's minus side leans on it at under 10
degrees and stands unbraced (the quake's first swing throws it that way, on the evidence of the bare runs: every
column with its hall on the plus side fell on 8 of 8), and a column between two halls always does. The first RC-2 and RC-3 each had such a column (8 and 3 of 8 bare builds stood); the per-tower bare
check found them, and their halls moved to the plus side.

### Levels

| id | name | site | quake | bare | three stars (T3) | two stars (T2) | budget |
|---|---|---|---|---|---|---|---|
| A6 | Lean on Me | 3 col6, each with a hall on its + side along x | 0.3 g, 1 Hz, 1 s along x | 0 of 8 builds; every column falls on 8 | 6 blocks: a plank from each column onto its hall (8/8) | 14: piers 2, 2 and 3 high (7/8) | 30 |
| A7 | Cross Ties | col6, col5, col6, col5; halls along z for two, along x only for two | along z | 0 of 8; every column falls on 8 | 12: ties for the two with a hall along the quake, piers 2 high for the others (8/8) | 16: piers 2 high everywhere (8/8) | 40 |
| A8 | Old Town | six columns of 5 and 6 in two rows, four with halls along x | along x | 0 of 8; every column falls on 8 | 16: four ties, two piers 2 high (8/8) | 28: piers 3 high by two col6, 2 elsewhere (7/8) | 60 |

Order: one lever per level. Lean on Me teaches that a tie is cheaper than a pier (both work). Cross Ties turns the
quake across half the halls, so a tie across the quake is no tie and those columns must be buttressed. Old Town is a
town of both. In every level the wrong build (piers of three across the quake beside every column) fails on 8 of 8.
The search's wall times on 4 cores: 330 s, 1,296 s and 1,131 s (results/retrofit/, not committed).

### Verification

- `keystone/test/retrofit.test.ts`: the fixed quake (locks the dial, refuses others, the naive quake is it,
  validation), the objective with and without a build block, the tally's Budget left line, stars on `built` (lower
  is better, the default metric when a quake level has a build), a session's built facts, `baseHash` (a build keeps
  it, a level without a build block keeps base = hash) and cast stars kept across a build, the candidate sites, and
  the shipped retrofits (the sites' scenes exactly, valid, settle v3, stars on `built` against `baseHash`, budget at
  most 200).
- `keystone-lab/test/retrofit-ref-A*.test.ts` (reference, 8 nudged builds each, one file per level): the bare level
  fails, both recorded bracings (`retrofit-solutions.ts`, through the build tool) are robust and inside the budget,
  the wrong build fails, and the stars are the bracings' costs.
- `keystone-lab/test/retrofit-gpu-A*.test.ts` (GPU solver through the game's cast page, SwiftShader in CI): the bare
  level and the wrong build lose a protected tower, both bracings keep every one standing.
- On a PR both run A6 only, the family's representative (CI rule O5); A7 and A8 run with PHYSICS_GPU_SLOW=1
  (nightly) and, on the GPU, with TB_CHANNEL set. All three passed both gates when they shipped (reference and SwiftShader runs).
- `game/test/retrofit-e2e.test.ts` (game page, Rapier): A6 opens building with the budget shown; three planks placed
  through the page equal the build tool's; Play loads the build; the quake panel is fixed (keys do nothing, no dial
  buttons, "6 / 30 braced"); Enter starts the level's quake; the page ends where `runSession` does; the card shows
  Budget left.
- `game/test/quake-panel.test.ts`: the fixed dial and panel. `viewer/test/level-file.test.ts`: every Aftershock
  level and a braced retrofit round-trip through the level file to the same hash and base hash.

### Alternatives considered (retrofit)

- **A dialled quake as well as a build** (brace, then design the quake): two puzzles at once, and the stars would
  have to price joules against blocks. The fixed quake makes the build the whole puzzle; the grammar still allows a
  dialled retrofit later.
- **Stars on energy or on Budget left points**: energy is fixed here. Points and blocks order the same, but blocks
  read directly ("braced with 6 blocks or fewer") and match the build panel's count.
- **T2 at 1.5 times T3** (the energy casts' habit): on Lean on Me it gives 9, which ranks the piers (14) with no
  bracing at all. The other family's cost says "a real bracing earns two stars, the clever one three".
- **Stars and progress per build hash**: every build would be a new level. The base hash keeps them on the level the
  designer authored; the build is the play.
- **Judging in many worlds at once** (M8's `Islands.pushField`): the nudged reference runs are the M7 gate's judge
  already, independent and bit-reproducible; islands would cut wall time, not change the verdict. A later retrofit
  with many candidate builds might want them.
- **Recording builds as part lists**: programs through the build tool also check the bin, snap and budget on replay
  (as Rube Lab's do).
- **Caps, fills, one-sided and full piers** as families: all fail on the probes (above).
- **Hashing with `settle` moved last** (to make the key order irrelevant): it would move every hash with an explicit
  settle rule (B1 to B3's Metal-cast stars). Named in the level file's place instead.

## Alternatives considered

- **Resonance and frequency-only design** (the roadmap's first idea): rejected by X6. Friction stacks do not
  resonate; the lowest frequency is the most destructive at every height, so a frequency dial alone cannot spare
  the tall and fell the short.
- **Far-blast shove** (X6 claim 6: a far flat-core blast is a uniform kick, exact today): one jolt is one lever,
  duration and frequency are lost, and a kick reads as a blast, not a quake. Kept as `joltEvent` for other modes.
- **Preset quake library** (pick one of N named quakes): the fallback if the dial had proved unreadable. The dial
  passed the gate on five sites, and a library hides the levers the levels teach. The seismograph shows the dial
  as a quake, which is what a preset name would have bought.
- **Transient (pose) heritage rule**: breaks towers that rock and stand. Replaced by judging standing at the settle.
- **Cube walls for the axis lever**: not direction-sensitive. Bonded rod walls are.
- **Shaking the camera instead of the ground** (PT25): the simplest picture of a quake, and against the camera rule
  (the camera moves only on player input); it also shakes the HUD's frame of reference with it. Drawing the site
  displaced keeps the eye still, so the motion reads against the screen. Kept: shake stays an opt-in.
- **An exaggerated ground motion** (2 to 5 times true scale, to read at a distance): considered, not taken. True
  scale reads on every level at the default view (5 to 22 cm; the test sees the open ground change), and an
  exaggerated ground would slide under towers that do not slide with it.
- **Natural-frequency ticks** (the row as written): no such frequency (X6). The uplift and rocking-frequency marks
  are the Housner model's own numbers.
- **A seed at the level's ace, or the ace's axis on Cross Grain**: a seed is a start, not the answer; and Cross
  Grain's lesson is the axis (its row was turned so the dial's starting axis is wrong).
- **`Math.sin` for the keys**: not correctly rounded, so not one input on every machine. Exact trig instead.
- **A score-metric cast on the GPU** (as B1 to B3): the engine-independent energy metric makes the cast cheap and
  portable; Metal runs confirm the "met" side.

## Verification

- `keystone/test/quake.test.ts`: text, records, dial and budget refusal, energy formula, the field events, level
  grammar and validation, the objective, heritageFallen, the tally, energy stars, the shipped levels (sites
  exactly, valid, stars against their hash, budget refuses the brute end, aces inside the budget).
- `keystone-lab/test/quake.test.ts` (reference engine): the quake through Driver and Session, bit-for-bit replay,
  a deep copy mid-quake playing on to the same end, standing vs pose judgement, the gate's claim on Short Sharp
  Shock (best clears it, the naive and a long quake fail), nudged builds.
- `keystone-lab/test/quake-gpu.test.ts` (GPU solver, SwiftShader in CI): replay bit for bit, the window quake
  clears Short Sharp Shock, and Chromium computes Node's quake keys.
- `keystone-lab/test/quake-aces.ts` (GPU solver, two test files): each shipped level's ace clears it as shipped, heritage
  whole, inside the third star.
- `game/test/quake-e2e.test.ts` (game page, Rapier): keys and buttons set the dial, a click aims nothing, Enter
  starts the quake, the camera does not move, the page ends where `runSession` does and replays bit for bit; on
  phones every dial button and Start is on screen.
- `game/test/quake-panel.test.ts`: the dial, the seismogram, the compass, the energy meter and budget, the HUD slot.
- PT25: `game/test/quake-ground.test.ts` (the ground's motion: home at both ends, along the axis only, against the
  load, about A g / (2 pi f)^2; the dust beats), `game/test/quake-ticks.test.ts` (uplift 1/n and sqrt 2 / n,
  Housner's p, the size and axis levers on A2 and A3, the strips), `game/test/quake-e2e.test.ts` (two mid-quake
  frames 12 steps apart draw the ground apart and the open ground's pixels differ, none with the option off, the
  view unmoved; the running panel with its playhead; dust at every foot in the real look; on an upright phone the
  four labels and at most 30%), `keystone/test/quake.test.ts` (`start` checked against the dial, out of the hash),
  `keystone-lab/test/quake-seed.test.ts` (each seed on 8 nudged reference builds) and
  `keystone-lab/test/quake-seed-gpu.test.ts` (each seed on the GPU solver scores above 0 and does not clear). On a
  PR both seed tests run A2 only, the family's representative; every seeded level runs with PHYSICS_GPU_SLOW=1
  (nightly) or, on the GPU, with TB_CHANNEL set.

## Follow-ups

- Metal casts (M5 Max) of the shipped levels' aces and the gate's confirm stage, through the coordinator.
- Retrofit: Metal runs of the retrofit tests (TB_CHANNEL=chrome) through the coordinator; a v4 recast of A1 to A8 to
  drop the settle v3 pin (low priority); a retrofit with a dialled quake as well as a build (the grammar allows it);
  and build moves for the agent playtest.
- The agent playtest (G9b) cannot yet dial a quake.
- PT25: dust in the stylised looks (hazy, candy), which draw impacts as sparks: a dust style of their own is the
  effects thread's call. A seed for Cross Grain if a later layout gives one that keeps the axis lesson. Metal runs of
  `quake-seed-gpu.test.ts` (TB_CHANNEL=chrome) through the coordinator.
