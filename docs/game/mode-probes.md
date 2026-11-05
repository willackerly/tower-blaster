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
| X2 | Order matters in demolition | M5 | not built | not run |
| X3 | Towers as dominoes | M6 Steer | not built | not run |
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
