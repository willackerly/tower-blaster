# Pinned bodies and gravity schedules (C8, C7)

Status 2026-11-06: C8 built; C7 designed here and built in the follow-up change. Roadmap nodes C8 (pinned bodies) and C7 (gravity schedule with optional field kick). They unlock M7 Aftershock (quakes), M8 Mason's Trial and M10 Rube Lab (fixed anchors, bins, walls). Both sit in `@tb/engine-api`, the one contract, and every engine implements them: the f64 reference, the GPU engine and Rapier. The probes that gated them are X5 (pinned anchors solid) and X6 (resonance under a gravity schedule) in `docs/game/mode-probes.md`.

## C8: pinned bodies

### What it is

`BodyDesc.pinned: true` bolts a body to the world (`packages/engine-api/src/pinned.ts`):

- It never moves. Its pose stays bit for bit as given, its velocities are 0 (the description's are ignored), and it feels no gravity, blast, field kick or contact.
- To every body that touches it, it is an infinite mass: they solve against its fixed pose, exactly as against the ground plane.
- Contacts between two pinned bodies, or between a pinned body and the ground, do nothing.
- A snapshot reports it with `awake` 0. It never wakes, and it joins no sleep group: two stacks resting on one pinned shelf sleep and wake independently, as two stacks on the ground do.
- It may be removed (`RemoveEvent`) like any body; whatever rested on it then falls.
- Refused, before anything changes: by `TieredEngine` (bench only), and by the AVBD engines with `AvbdParams.restitution` on, whose bounce pass does not treat anchors as infinite masses yet. Rapier has no such limit.

### Alternatives considered

| Option | For | Against | Verdict |
|---|---|---|---|
| A. A never-wake sleeper: an awake bit that stays clear, on the existing anchor path | The anchor path exists and is measured: X5 found it as solid as the ground (pins moved exactly 0 in f32, a cannonball sliding 11.8 m ended where it ends on the ground to 10 um). No primal work, no colour spent, no new kernel in the solver. | Needs the anchor path compiled in without sleep (the solver's `sleepOn`), and a colouring seed without the sleep pass. | **Chosen.** |
| B. An infinite-mass flag (`invMass` 0) solved like any body | One flag, no special colouring | AVBD's primal of a body with M to infinity still needs special-casing (its inertial target falls under gravity), it would spend a colour and a primal thread on a body that cannot move, and a huge finite mass is f32 trouble. | Rejected. |
| C. Static colliders in their own set, as the ground plane is | The cheapest for huge static scenery: no per-body state, a static broadphase built once | A second broadphase and narrowphase path on the GPU, in the reference and in the snapshot layout; pins are expected to number tens to hundreds (bins, walls, anchors), where A's per-step cost is a few hundred broadphase entries | Deferred. Revisit if a mode wants thousands of pinned bodies. |
| D. Kinematic bodies (scripted motion) | Moving platforms, elevators | A different feature: velocities that the solver honours but contacts cannot change | Out of scope. Bit 2 of `Body.flags` is free for it. |

### How each engine does it

- **GPU** (`packages/physics-gpu/src/pins.ts`): `Body.flags` bit 1 (`PINNED`), awake bit clear. The anchor path is compiled in when the engine sleeps, or when the scene holds or spawns a pinned body (`scenePins`), or with `GpuEngineOptions.pins` (room to push one later; `push()` refuses a pinned spawn otherwise). Without sleep, `PinSeed` writes the colouring's seed each step (one dispatch: `SLEEPER_COLOR` for an anchored body). With sleep, the sleep pass writes it, and its rules skip pins: `wakeApply` never wakes one, `member()` never joins sleepers through one, and the neighbour veto does not read a sleeper's quiet counter (a sleeper's is always at least T, so this changes no float of an existing scene). The blast kernel never pushes or wakes a pinned body, which also covers the zero-impulse wake of a removal.
- **Reference** (`BodyState.pinned`): no inertial target or guess (its dx stays 0, which is what touching bodies solve against), left out of the colouring graph and every colour group, pose never rewritten (not even renormalised), contacts with another pin or the ground not made, never pushed by a blast.
- **Rapier**: a fixed rigid body.

### Tests

`@tb/testkit`'s `pinned.ts` is one shared case for all three engines:
- **Solid:** a pinned slab tilted 10 degrees, floating 3 m up and given a velocity it must ignore; a cube dropped onto it; a ball fired at it; a blast at its edge; a second pinned box holding a cube, removed at step 60. Pins must not move at all (reference and GPU: exactly 0; Rapier: under 1e-6, its f32 pose), stay at rest and not awake; the dropped cube must rest on the slab; the cube on the removed pin must fall 2.5 m to the ground.
- **Frame:** a cube sliding on a pinned slab whose top is at 2 m against the same cube on the ground plane moved to 2 m (X5's rule: within 1 cm + 1% of its path). Measured on the reference: 3 mm over a 1.62 m slide.
- **GPU only:** the same with sleep on; two 3-cube stacks on one pinned shelf fall asleep, and a blast that wakes one leaves the other asleep; a pinned spawn pushed after init is refused without anchors and held with `GpuEngineOptions.pins`; and the knock scene with `pins` on gives the same floats as without.
- **Probe X5** now runs `BodyDesc.pinned` with sleep off instead of the emulation.

## C7: gravity schedules and field kicks

### What it is

A new input event, `FieldEvent` (`packages/engine-api/src/field.ts`):

```ts
{ step, kind: 'field', gravity?: Vec3, kick?: Vec3 }
```

- `gravity` is the world's gravity from that step on, until the next field event that sets it. `SceneDesc.gravity` is the gravity before the first one. So g(step) is piecewise constant, keyed by steps: a schedule.
- `kick` is a velocity change added to every body that moves (not pinned, not removed) at the start of that step. In the ground's frame it is a jolt of the ground by -kick: a Galilean change of frame, exact for a body in flight and for one resting on the ground alike, since the ground and the pins are the frame and do not move.
- Applied at the start of its step, in event order with that step's spawns, blasts and removals (as `BlastEvent` is): a body spawned after the kick in the same step is not kicked.
- **Wake-all:** with sleep, a field event that changes gravity (any component differs from the current value) or carries a non-zero kick wakes every sleeper but the pins. A sleeper holds its pose under the loads it fell asleep with; a new gravity changes every load, and a tower a hair from its tipping point must feel a slight tilt. An event that sets gravity to its current value wakes nothing.
- **Quantised:** every component of `gravity` and `kick` must be a multiple of 2^-12 (m/s^2 or m/s) and at most 2^10 in magnitude (`FIELD_QUANTUM`, `checkInputQueue` refuses others; `quantiseField()` rounds). Such a number has at most 22 significant bits, so it is exact in f32 as in f64: the GPU's uniform holds the very value the reference uses, a level file's JSON round trip is exact, and "changed" is an exact comparison.

The kick is added to the adaptive warm start's previous velocity too (reference `prevLinVel`, GPU `SolverBody.prevVel`), as a blast's is, so a kicked body at rest is not first guessed to be in free fall.

### Alternatives considered

| Option | For | Against | Verdict |
|---|---|---|---|
| A. The host rewrites `SceneDesc.gravity` before each step (X6's emulation) | No API change | Not an input: undo checkpoints, recorded replays and saved levels lose it; nothing wakes sleepers, so X6 had to run without sleep | Rejected (X6 now uses C7). |
| B. A separate `SceneDesc.gravitySchedule` of keys | Compact level data | A second event channel beside `inputs`: `push()`, `checkpoint()`, the queue checks and save/load would each need a parallel path, and M7's "you design the earthquake" pushes a schedule interactively | Rejected. |
| C. A parametric schedule (sum of sinusoids with an envelope) evaluated by each engine | Tiny level data | ECMAScript leaves `Math.sin`'s accuracy open and WGSL's `sin` is looser still, so engines would diverge from step 1; replays would depend on the machine | Rejected: generators run once on the CPU and emit quantised keys instead. |
| D. **An input event of kind `field`, piecewise constant, quantised** | One stream: `push()`, checkpoint/undo, replay by recording, save/load and the queue checks all work as for blasts; exact across engines | A quake is one key per step (600 events for 10 s at 60 Hz), a few kB of JSON | **Chosen.** |
| Kick as a far flat-core blast (X6's claim 6) | Exists today | Radial, not uniform (within 1e-7 at 1 km, but only far away), capped by `maxDv`, and it needs a centre and radius that mean nothing for a jolt | Rejected for the kick; still fine for a gust from one side. |
| Wake only when the change exceeds a threshold | Fewer wakes for tiny tilts | A tower at its limit falls to a tiny tilt; a threshold is a tuning knob with no physical meaning | Rejected: every change wakes. A quake that changes g every step keeps everything awake, which is what a quake does. |

### Quakes: what X6 taught

X6 found no resonance: a rocking block has no natural frequency, the amplitude that overturns it grows with frequency, and at CI size the slender column fell first at low frequency. So quakes are designed around **amplitude, duration and timing**, not tuned frequencies:

- `tiltEvents(step, degrees, azimuth?)`: one key that turns gravity by an angle (a steady side load: a column of n cubes tips once the side load passes g/n).
- `quakeEvents({ step, seconds, dt, peak, hz, azimuth, rise, fall })`: one key per step, g_side(t) = peak * envelope(t) * sin(2 pi hz t) along the azimuth, with a linear rise and fall. `peak` is a fraction of g; `hz` defaults to 1 (the low end does the damage). Every key is quantised; the last restores the base gravity.
- `joltEvents(step, dv)`: a field kick.
- `fieldGravity(scene, step)`: the gravity in force at a step, for the game's arc preview.

### How each engine does it

- **Reference** and **Rapier**: hold the current gravity (Rapier's `world.gravity`) and apply events in order; the kick adds to each moving body's velocity (Rapier: `setLinvel(v + dv, true)`); a change wakes every body (Rapier: `wakeUp()`; the reference does not sleep).
- **GPU**: the engine holds the current gravity on the CPU (part of its checkpoint) and writes it into the step's uniforms. The kick and the wake-all are records in the blast pass's buffer, in event order with the blasts: a kick adds dv to every body below its count that is neither removed nor pinned and wakes it; a wake record wakes the same bodies without pushing them. Woken bodies go through the sleep pass's existing "woken by a blast" path, so their groups and quiet windows reset as after a blast. A field event also counts as an input for the sleep skip.

### Tests

- `@tb/engine-api`: queue checks (quantised, finite, bounded, at least one of gravity and kick), the quantiser, the generators (exact keys, quantised, base gravity restored), `fieldGravity`.
- `@tb/testkit`'s `field.ts`, shared by the three engines:
  - **Free flight:** bodies in flight under a schedule match `freeFlight` piecewise to rounding; a kick changes exactly the velocities it should (removed and pinned bodies untouched, a body spawned after it in the same step untouched).
  - **Tilt** (the node's verify): a cube on the ground under gravity turned by 20 degrees (tan 20 = 0.36 < mu 0.6) stays put; turned by 40 degrees (tan 40 = 0.84 > 0.6) it slides with acceleration g (sin 40 - 0.6 cos 40) within 5%. Reference, GPU and Rapier agree with the analytic answer and with each other.
- **GPU with sleep:** a settled stack falls asleep; a field event that changes gravity wakes every body but the pin; one that repeats the current gravity wakes none; a skipped quiet step resumes at the event.
- **Probe X6** now drives its shake with field events (sleep may stay off: it measures failures, not sleep).
