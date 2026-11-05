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
| X1 | Domino propagation and sleep | M6, M16, C22 | CI size passes; full subset below | not run yet |
| X2 | Order matters in demolition | M5 | CI size: order matters on slab buildings | not run |
| X3 | Towers as dominoes | M6 Steer | CI size: cube and Kapla towers topple on, bonded piers stop | not run |
| X4 | Cantilevers and hollows hold | M1 Hollow, M8 | not built | not run |
| X5 | Pinned anchors solid | C8 | not built | not run |
| X6 | Resonance under a gravity schedule; far-blast shove | M7 | not built | not run |
| X7 | (optional) 1.5x domino amplifier | showcase | not planned | not run |
| X8 | Islands behave like solo worlds | C10 | not built | not run |

## X1 Domino propagation and sleep

**Question.** Do domino runs propagate on AVBD at game settings, and does sleep leave them alone?

**Rule (roadmap).** Line and curves of radius 5 h or more reach the end in at least 98% of 32 nudges (so all 32: 31 is 96.9%); the field front reaches 95% of dominoes; no domino asleep mid-fall; a cocked (leaning, held) domino stays asleep for 60 s; the awake count at the front is logged.

**Setup.** Dominoes 1 m x 0.5 m x 0.15 m plaster (h = 1 m), 0.6 h apart along the path. A line of 200; curves of 8 straight, a half turn of radius 3, 5 or 8 h, 8 straight; a 100 x 100 brick-offset field (rows 0.6 h apart, columns 0.75 h, odd rows shifted half a column, so each domino lands on two of the next row). The world stands 90 steps (sleepers fall asleep), then a 0.1 m ball (2,000 kg/m^3) at about 1 m/s and 0.8 m up is spawned just behind the first domino (one per first-row domino for the field). Each of the 32 nudges jitters the push (speed +-10%, height +-5 cm, sideways +-3 cm) and every domino's placement (+-2 mm, +-0.5 deg of yaw) from its own seed. Every case runs with sleep off (the game today) and on (GPU sleep, the E2 rule).

**Meters.** A domino has fallen once it tilts past 15 deg. The run is over when everything has fallen or nothing new has for 3 s. Front speed: fall time against path position, fitted over the middle 60% of the run, also as a multiple of sqrt(g h). Awake counts every 5 steps: the most and the mean, and the most standing dominoes awake more than two pitches ahead of the front. **Frozen mid-fall:** the roadmap's "no domino asleep at a tilt between 5 and 80 degrees" would fail on every correct run, because a fallen domino resting on the next one legitimately sleeps at 20 to 60 degrees. The meter asks the question the rule stands for instead: 3 s after the run is over, a blast of no impulse wakes everything, and the dominoes that were asleep must not move on (largest tilt change over the next 2 s under 1 deg). A domino sleep had frozen mid-fall would fall on. **Cocked:** one domino leaning at 20 or 40 deg against a stone block, its tilt at step 120 (contacts loaded) the pose to hold; it must be asleep from early on to the end of 70 s, and drift less than 0.1 deg.

### Results

CI size on SwiftShader (`7357a4e` plus this probe; 2026-11-05): lines of 10 reach the end with sleep off and on at 0.90 sqrt(g h) (a short line, still accelerating); a 4 x 4 field falls entirely; with sleep, no standing domino ahead of the front is ever awake, every fallen domino sleeps, and waking them all moves none by more than 0.03 deg; the cocked domino falls asleep at 0.5 s and holds to 0.000 deg.

Full size: pending (SwiftShader subset and the Metal run).

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

CI size on SwiftShader (chains of 3, one nudge; 2026-11-05):
- Cube towers: reach 3 of 3, about 0.6 s per tower. They crumble into the next one rather than tip as a unit.
- Kapla cribs: reach 3 of 3, about 1.8 s per tower.
- Bonded brick piers: reach 0. The first pier tips onto the second and leans on it, and the second holds it up.

So at this size the game's own loose towers and the Kapla cribs carry a wavefront and bonded piers stop it, which makes a bonded pier a Steer level's firebreak.

Full size: pending (the Metal run: 3 designs, chains of 24, 32 nudges).
