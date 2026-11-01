# Weapons: blasts, triggers and scripted munitions

Status 2026-11-01. Full write-up with the reasoning and the alternatives: the "Grenades and Scripted Weapons" artifact linked from the PR that added this file. Weapons are built and tried in the viewer first (it is becoming a superset of the game); Keystone's par and leverage rules are not a constraint for now.

## What exists

**`BlastEvent`** (`packages/engine-api/src/blast.ts`): an input event that pushes every body whose centre lies within `radius` of `centre`, away from it, at the start of the step it is due:

```
|dv| = min(maxDv, impulse * w(d) * A / m)
w(d) = 1 inside core * radius, then ((radius - d) / (radius - core * radius))^falloff   (integer falloff)
A    = a quarter of the body's surface (its mean silhouette): 2 (hx hy + hy hz + hz hx) for a box, pi r^2 for a sphere
```

- `centre` is a point, or `{ body, offset? }`: that body's position when the blast is due, read from the engine's live state (a pipelined reader that sees the grenade one step late still blasts where it is). The body must exist, and not be removed, when the blast is due; `checkInputQueue` refuses the event at `init`/`push` otherwise.
- After each blast's kick a pushed body's speed is capped at `maxSpeed` (default 48, 0.8 of the sweep limit at 60 Hz; scaled with direction kept; `Infinity` turns it off), so stacked kicks cannot tunnel. Units are the engine's (cube units in a `scale`d world, where the sweep limit is larger still).
- Applied in event order with the spawns of the same step; a blast pushes only the bodies that exist when it is due.
- The kick is added to linVel and to the adaptive warm start's previous velocity (reference `prevLinVel`, GPU `SolverBody.prevVel`), so it is not read as an acceleration.
- Only +, -, *, / and one square root, so the f64 reference is the same on every machine.
- Implemented by the reference, the GPU engine (`packages/physics-gpu/src/blast.ts`: one dispatch on steps that have blasts, none otherwise) and Rapier. `TieredEngine` refuses blasts until it wakes dormant cells in the radius (`wakeSphere` exists).
- Tests: `@tb/testkit`'s `blast.ts` is one shared case (bodies in free flight around the centre, a spawn before and after the blast, an excluded id, and a second blast in the same step centred on a moving body with an offset and a speed cap); every engine must change exactly the velocities `blastKick` gives and leave every other body bit-identical (reference to 1e-12, Rapier and GPU to 1e-5 relative). The GPU also blasts a 6 x 4 x 6 block of cubes against the reference.

**`RemoveEvent`** (`packages/engine-api/src/remove.ts`): `{ step, kind: 'remove', id }` takes a body out of the world at the start of the step it is due, in event order with that step's spawns and blasts (so a grenade's blast and then its removal, at the same step, push the bodies around it and then take it away).

- The slot is a tombstone: ids are stable and never reused (the next spawn gets the next id; a GPU engine's capacity counts removed bodies). The body has no pairs and no ground contact, feels no gravity, blast or solve, and stays exactly where it was removed with zero velocity. Snapshots report it with `tier` `TIER_FREE` (255, the renderer's `TIER.free`, which every pass skips) and `awake` 0; `Snapshot.tier` is present once any body has been removed.
- Refused at `init`/`push` (`checkInputQueue`, before anything changes): a removal of a body that does not exist when due or is already removed, and a blast centred on a removed body. A blast never pushes a removed body.
- Reference (`BodyState.removed`): the broadphase runs over live bodies only, the ground manifold and the inertial target skip it. GPU: the host zeroes its velocities and sets its flags to `TIER.free << 8`; every kernel guards on that tier (prepare writes a negative bounding radius, which the broadphase skips; narrowphase writes an empty ground manifold; initBodies freezes it; the blast kernel skips it). Rapier: velocities zeroed, then `setEnabled(false)`. `TieredEngine` refuses removals, as it refuses blasts.
- Tests: `@tb/testkit`'s `remove.ts`. A free-flight case (a spawn, a blast, then two removals at one step, including the body spawned that step; a later removal, then a blast centred on a live body that reaches two removed ones): removed bodies are frozen where they were removed (reference 1e-15, GPU and Rapier 1e-6, quaternion renormalisation), at zero speed, tier free from the next snapshot on; every other body bit-identical to the run without removals on all three engines. A stack case: the cube under another is removed, and the top one falls to the ground while the one beside it does not move.

**Grenades** (`packages/weapons/src/grenade.ts`, `@tb/weapons`): pure logic over snapshots. The caller fires the grenade's spawn, tells `Grenades.launch` about it and feeds `Grenades.observe` the states it reads; both return the events to push: the blast (centred on the grenade, excluding it), then the grenade's removal at the same step (`detonation`). The grenade is spent: it vanishes when it goes off.

- Fuses: `timer` (due `delay` s after the spawn, known at launch, no observation needed), `prox` (the first step whose state has the grenade within `prox` of another body's surface or the ground, after `arm` s), `proxTimer` (`delay` s after that).
- Proximity is decided from observed state k and is due at k + 1 at the soonest, so a pipelined reader lands it at the same engine step as a serial one. `observe` looks `lookahead` steps ahead along the grenade's exact free-flight path (`freeFlight`), with the other bodies where state k has them, and a trigger predicted for step j is due at j. So a reader observing every step with lookahead 1 and one observing every 4 steps with lookahead >= 4 detonate at the same step, bit for bit, while nothing near the path moves much (`packages/weapons/test/grenade.test.ts`, on the reference engine).
- Distance is exact to spheres and oriented boxes, with the grenade taken as its bounding sphere. A coarse cull against the bounding sphere of the predicted path keeps the cost at one distance per body for the far ones.
- `DEFAULT_GRENADE` is deliberately strong: radius 5, impulse 40 per m^2, flat core of 0.2 radius, so a 1 kg scene cube within 3 m gets the full 25 m/s.

**Real things to throw** (`packages/weapons/src/projectiles.ts`, `PROJECTILE_PRESETS`): a beach ball, a basketball, a bowling ball, a cannonball, a wrecking ball and the Raiders of the Lost Ark boulder, each at its real diameter, density, restitution, friction and a launch speed that suits it, with a natural colour and a candy skin. The viewer fires one with `proj=<name>` (the panel's "throw" picker, which fills in the thing's own fields; any can be overridden with the usual `proj.*` keys, and a saved scene's `projectile.preset`).

- Units: a real thing stays real whatever the cube size. Its radius and speed are divided by `scale` (m per cube), so under real gravity (9.81/scale cube units/s^2) it flies as it would. Its density is set against `blockDensity`, the real density a scene block of density 1 stands for: stone (2400 kg/m^3) by default, pine (450) for the Kapla tower, and a Keystone level's stone (density 625) for real stone. Mass over a block cube's mass (blockDensity x scale^3) is what the solver sees, and the panel shows it ("0.249 kg, 1/9,650 of a 1 m cube of block (2.40 t)"). `proj.blockDensity` (the panel's "blocks are" field, with stone, brick, oak, pine, cardboard and foam suggested) says otherwise: lighter blocks let lighter things move them. Plain `ball` and `cube` keep their cube-unit, froudeSpeed semantics.
- A real thing's launch speed is capped at `launchSpeedCap`: a physics step's travel stays under 0.8 of what the AVBD broadphase looks ahead (`maxSweep`, 1 unit per 1/(60 substeps) s) plus half the thing's radius, so it is at most half its radius into a block it was not seen to reach and its centre never passes a face. It binds only in small worlds: of the six, only the cannonball in the Kapla tower (2.34 cm units, 7 substeps), at 19.6 m/s instead of 45. The panel says when it binds. Ball and cube leave as set, as they always did (the default scene's 80 m/s ball included).
- Bounce: a thing's own restitution needs the engine's restitution switch (Bounce); with Bounce on, it keeps its own e instead of the scene's (the engines average the two).
- Candy is a skin, not physics: the renderer's per-body fx gains a `paint` bit (`FX_PAINT`), so the thing is drawn its own colour (its candy skin in the candy and hazy looks, its natural colour in the real look) rather than the look's ball colour.
- Checked on the reference engine (`packages/viewer/test/projectiles.test.ts`): a beach ball, 1/9,650 of a stone cube, comes off a 2 x 2 x 3 tower without moving a block or a NaN; a wrecking ball moves more than a third of it and the boulder all of it.

## Known limits of the v1 blast

| Limit | Consequence | Fix (planned step) |
|---|---|---|
| the speed cap can slow a body | a body already faster than `maxSpeed` inside the radius leaves slower than it came | intended (it guards the sweep); `maxSpeed: Infinity` for scenes that want none |
| pair pool is 16 per body | a blasted packed tower can need more pairs; overflow drops contacts silently | assert `pairsRequired <= pairsWritten` in blast tests; raise `pairsPerBody` for weapon scenes |
| no occlusion | a body behind another is pushed as hard | none planned |

## Plan (each step lands with its tests)

1. **Blast event** (done, #90).
2. **Grenade in the viewer**. 2a (done): body-centred blasts and the final-speed cap in all three engines. 2b-i (done): fuses as pure logic in `@tb/weapons`. 2b-ii (done): `proj.weapon=grenade` in the viewer's sandbox, with timer and proximity fuses, blast centred on the grenade (`centre: { body }`), configurable from the Scene panel, the URL (`grenade.*`) and the scene file (`weapons.grenade`). The page reads the state about once a frame and the fuse predicts 4 steps of 1/60 s ahead (times substeps). Under Keystone's rules a level's rack names its items (`packages/keystone/src/rack.ts`, roadmap G3): Keystone's ammo bare, a preset as `p-<preset>` (real size and bounce, density at the model scale, x 625/2400), a weapon as `w-<key>` (the level's `weapons[key]`, lengths in h; `w-grenade` defaults to `KEYSTONE_GRENADE`, since `DEFAULT_GRENADE` gives a 31 kg plaster cube only 0.48 m/s). The grenade fires through the hook (`PlayOptions.perStep`) in G3.3.
3. **Remove event** (done): tombstones in all three engines and the renderer; the grenade is consumed.
4. **`@tb/weapons`**: a pure-data `WeaponSpec` (shell, rules of trigger -> actions, named child munitions as a tree of depth <= 3), a validator, a static body budget, and a deterministic runtime that turns observations into input events. Loaded from the viewer's scene file (`weapons` section, `projectile.weapon`).
5. **Relative spawn** (split, duplicate, emit, fireworks): children placed in the parent's frame from its live state, momentum-conserving spreads, batched buffer writes.
6. **Kick and sparse forces** (vibrate, thrust): a list of at most 64 forced bodies folded into the inertial target, one small dispatch per step.
7. **Joints** (weld): sticky shells, tubes as jointed chains, wobble as soft joints. Colouring must include joint edges.
8. **Tiered blasts**: `HostBatch.blasts`, waking dormant cells in the radius, for the 100k city.
