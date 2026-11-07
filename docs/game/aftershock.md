# Aftershock (M7): design the earthquake

Roadmap node M7 (docs/game/modes-roadmap.md). The player gets one quake and a site of towers. Each tower is
**condemned** (its top is a crown: bring it down) or **protected** (its top is heritage: it must still stand when
the dust settles). The player sets the quake's strength, frequency, duration and axis, watches the ground shake,
and is scored on what fell and what stood. Retrofitting (placing bracing before the quake, roadmap step e) waits for
the C9 placement tool and is not in this first cut.

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
  pose rule the gate's best quake on Short Sharp Shock breaks the tall tower it spares (`quake.test.ts`, same end
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
| A3 | Short Sharp Shock | col3 C, col8 P, col4 C, col7 P | duration | 0.50 g, 1 Hz, 1.5 s (209 J) | 4 of 325 |

C: condemned, P: protected. The axis sites (QC-2 Cross Grain, QC-5 Fault Line) are in mode-probes.md with their
gate results; they ship when they pass.

Order: A1 first because many quakes clear it (a gentle 1 Hz jolt, or a slow sway sized to the slender towers); A3
last because only a narrow band of the dial clears it. Each level's towers are its candidate site's exactly
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
  "met" depends on the engine.
- The ace (`solutions.ace`) is the cast's best quake.

## The quake designer

`packages/game/src/quake-panel.ts`, in the HUD's control tray in place of power and height while the Quake chip is
selected:

- Four dial rows with minus and plus buttons (touch sized on a phone) and keys: Strength Q/E (5% g), Frequency A/D
  and Duration Z/X (along fixed stops inside the level's range), Axis C/V (the level's axis step, wrapping at 180).
- A seismograph: the side load the towers will feel, read off the very field events the engine gets.
- A compass: the axis as the camera sees it (the axis azimuth plus the camera's yaw), so "across the walls" reads
  on screen.
- The energy meter against the level's budget (red and Start disabled over it), or without a budget against the
  dial's brute end.
- Start (Enter): the quake fires through the same `fire()` as every shot, refused by `quakeRefusal`.
- The dial starts at 0.3 g, 1 Hz, 3 s along x and is kept over Retry and Undo, so the player iterates.

**Camera.** The camera moves only on player input (Will, 2026-11-02). A quake moves no camera: the shaking is the
ground's, seen from the ground, so the view stays put and the towers rock in it. Screen shake stays opt-in.

## Alternatives considered

- **Resonance and frequency-only design** (the roadmap's first idea): rejected by X6. Friction stacks do not
  resonate; the lowest frequency is the most destructive at every height, so a frequency dial alone cannot spare
  the tall and fell the short.
- **Far-blast shove** (X6 claim 6: a far flat-core blast is a uniform kick, exact today): one jolt is one lever,
  duration and frequency are lost, and a kick reads as a blast, not a quake. Kept as `joltEvent` for other modes.
- **Preset quake library** (pick one of N named quakes): the fallback if the dial had proved unreadable. The dial
  passed the gate on three sites, and a library hides the levers the levels teach. The seismograph shows the dial
  as a quake, which is what a preset name would have bought.
- **Transient (pose) heritage rule**: breaks towers that rock and stand. Replaced by judging standing at the settle.
- **Cube walls for the axis lever**: not direction-sensitive. Bonded rod walls are.
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
- `game/test/quake-panel.test.ts`: the dial, the seismogram, the compass, the energy meter and budget, the HUD slot.

## Follow-ups

- Metal casts (M5 Max) of the shipped levels' aces and the gate's confirm stage, through the coordinator.
- The axis sites (QC-2, QC-5) once they pass.
- Retrofit (roadmap step e) after C9: placed bracing from a budget before the quake.
- The agent playtest (G9b) cannot yet dial a quake.
