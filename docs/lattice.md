# Dormant tower tier (`@tb/lattice`)

Intact towers cost nothing until something hits them. `TieredEngine` keeps
every cube in one of three tiers over a `PhysicsHost` (`@tb/engine-api`
`host.ts`) and moves cubes between them by the rules below. All numbers are
structural (counts, distances) from the VM unless marked M5; VM timings are
never performance results.

| Tier | Host mode | What it is |
|---|---|---|
| Lattice (dormant) | off, or a native lattice cell | Cubes in their built cells; the host sees one voxel collider per lattice (Rapier) or per-cell contacts (GPU). |
| Active | dynamic | The solver's set. |
| Rubble | static, at its pose | Woken cubes that came to rest off the lattice, frozen where they lie. |

Renderer flags for these tiers live in `@tb/schema` `TIER`.

## Support (W1)

Loose towers use the exact loose-column rule: a dormant cell is supported
iff the cell under it is dormant (or it is on the ground). Waking a cell
wakes its support closure (everything above it in its column), so the
lattice is always legal (`checkSupport`). Glued towers plug in as another
`SupportModel`.

## Wake rules

**W2, impacts (predictive).** A body faster than `vWake` about to touch
dormant cells wakes a plug: for each axis it moves along, the struck cells
and the layers behind them, as deep as the shared speed `u = P / (mb + M)`
stays above `vWake`, plus the columns under the plug (`plugColumns`: a
dormant floor would anchor it with unlimited friction). The plug wakes
only if it would visibly move: it stops after `u² (mb + M) / (2H)`, with
`H` the friction under its lowest row (sideways) or its weight (upwards),
and that must reach `slideMin` (5 cm). Otherwise the body meets a wall.

**W3, forces.** A pushed cell slides together with every dormant cell ahead
of it in its line. The line is integrated as one friction block (speed
grows by `(push - hold) dt / M`, friction brings it back to 0) and the cell
wakes once the block has slid `slideMin`, with the block's speed as its
velocity. After a settle, the push is the smaller of the total force and
its change since the post-settle reference (the both rule: total alone
wakes neighbour-held cells, change alone wakes held loads that reverse). A
lift over the column's weight wakes at once.

**Unwedge.** No woken cell is left with dormant cells on both sides along a
row of the tower: the thinner side wakes, out to the surface. Rapier boxes
in a zero-clearance static well climb out of it.

## Settle and rubble

**Settle.** Quiet cubes within `settlePos` of an empty supported cell snap
back into the lattice, bottom-up, never pushing into a moving neighbour by
more than `settlePush`. A cube must stay active `minActiveSteps · 2^settles`
steps between settles, so it changes tier at most `2⌊log2(T/60 + 1)⌋ + 1`
times in `T` steps (7 in 600). Settling is on only for hosts whose cell
changes are local (`HostCaps.localCellChanges`): Rapier's `setVoxel` jolts
every contact on the collider.

**Rubble.** Quiet woken cubes freeze in place, bottom-up, recording what
they rest on. Quiet means moving less than `restDrift` (2%) of their radius
within a sliding `restSteps` (30) window, not a speed test (Rapier piles
creep a few mm/s). Thaws:

- T1, support: anything resting on a body that moves thaws, transitively.
- T2, impact: a body closing at a shared speed of at least `vWake` along the
  centre line, ignoring straight-down motion.
- T3, force: the both rule for `rubbleForceSteps` (3) steps running,
  against a capacity that counts the rubble resting on the body, and not
  when the push goes into a touching body at rest.

There is no backoff on freezing, only `minActiveSteps`, so a body changes
tier at most `2T/minActiveSteps + 1` times.

## Measuring fidelity

The reference is the same scene with every cube dynamic in Rapier.
Collapses are chaotic, so every comparison runs 4 to 8 copies with the ball
speed scaled by 1.00 to 1.07 and compares the spreads.

Use **broken bonds** (`compareBonds`), not displacement. A bond is a
face-adjacent pair; it breaks when the offset seen from one cube's frame
moves by more than 0.25 edge, or the relative rotation by more than 15°.
On the S5 default (a 10 kg ball at 20 m/s into an 8 × 8 × 25 tower) the
ball bounces off. Rapier's soft stack then sways about 0.5 m at the top for
seconds. Over 900 steps the count of cubes displaced by more than 0.5 m
went 0, 1,076, 0, 110, and island sleep froze it mid-sway at 682. Broken
bonds ignore the sway.

## Results

One 1,600-cube tower (S5 N=1600), 8 perturbed shots, 900 steps, sleep off,
hull spheres unless noted:

| Rules | Broken cubes | Most awake | Active body-steps |
|---|---|---|---|
| All-dynamic reference | 8 to 29 | 1,600 | 1.44M |
| Before slides (`slideMin: 0, unwedge: false`) | 2 to 143, median 40 | 1,601 | 1.2M |
| Slides, no unwedge | 0 to 167, median 44 | 1,339 | 3k to 780k |
| Slides and unwedge (default) | 0 to 97, median 0 | 201 | 6k to 33k |
| Slides and whole-line W3 wakes, no unwedge (true spheres) | 14 to 789, median 168 | 1,341 | 19k to 719k |

Small towers that do collapse (S5 N=1024 F=4 H=16, ball radius 1),
4 shots: reference 180 to 184 broken cubes, before slides 174 to 212,
default 190 to 254 (over by about 30% in 2 of 4).

S5 at 1,024 cubes with sleep off (before slides): in 8 of 8 perturbed runs
only the ball was still active by step 900. Moved 108 ± 5 against the
reference's 111 ± 4, spread 7.30 against 7.09.

M5 Max at ae1ff72 (before slides): S4 10k idle step 0.0031 ms against
Rapier's 0.829 ms median (−99.6%), 100k idle 0.0066 ms. S5 10k p99 12.0 ms
against 61.9 ms, but the median was 8.4 ms against 5.7 ms because the
struck tower stayed awake. That is what the slide rules fix.

## Alternatives tried

- **Separate static boxes per dormant cell:** seams catch sliding cubes. A
  frictionless slider dropped from 3 m/s to 0.2 m/s; native voxels keep
  3 m/s. Lattices are native.
- **W2 cells-ahead filter:** waking only the cells within the body's
  cross-section made the differential test worse (spread error 0.21 against
  under 0.1). The cells it left dormant act as infinite walls.
- **Settling woken towers back into Rapier voxels:** the `setVoxel` jolt kept
  piles awake, and creeping towers never settled, which left about 1,000
  active. Rubble replaced it on Rapier.
- **Speed-based quiet test, freeze backoff, one-step T3:** each failed on a
  measured case. Speed-quiet missed creep. Backoff stalled 220-body chains.
  97% of one-step force thaws were false.
- **Whole-line W3 wakes:** see the results table. They left wedged slabs.
- **Wake everything a hit could affect (the old W2/W3):** faithful, but the
  cost scales with the tower, not with the damage.

## Host notes

- Rapier reports no per-point impulses on voxel colliders. Cell forces come
  from contact-force events, split over the cells the body touches (signed
  depth within tolerance).
- Rapier 0.21 panics (wasm `unreachable`) when a ball presses on a voxel
  edge. `RapierHost` builds spheres as icosphere hulls of the same mass, and
  `adapter-rapier/test/voxel-panic.test.ts` pins the upstream bug.
- Rubble freezes at the pose the tiers recorded, sent with the static
  change, so a host whose state lags (`stateLag > 0`) puts it where the
  snapshot says it is. In Rapier, turning a sleeping body static wakes its
  sleeping neighbours whatever the wake flags say (`host.test.ts` pins it),
  so each freeze keeps its pile awake for one sleep timeout. `RapierHost`
  skips a pose write that changes nothing: `setRotation` renormalises
  (17% of quaternions moved by an f32 ulp), and one S5 collapse froze 310
  cubes instead of 740 from that alone.
- The GPU host keys contact warm starts per cell, so a cell change disturbs
  only its neighbours. It can set `localCellChanges` and use settling.

## Open

- Lazy support closure. Most of the cells still woken by a bounce-off are
  columns above a dent that barely moves. Leaving them dormant while their
  supporter stays within tolerance would change the support invariant, so
  it needs measuring first.
- Small-tower overshoot: in 2 of 4 shots, about 30% more broken cubes than
  the reference. It comes from the W2 gate. With the gate off and the W3
  slide and unwedge on, the same 4 shots break 173 to 191, against the
  reference's 180 to 184. But the gate is what keeps a bounce-off from
  waking the whole big tower. The likely gap is secondary hits: debris at a
  few m/s into a packed line moves the far end of the line (Newton's
  cradle), while the plug model moves the line as one block.
- The debris particle tier: at the S5 peak there were no free-flying
  bodies, so it is deferred until the M5 numbers show a need.
