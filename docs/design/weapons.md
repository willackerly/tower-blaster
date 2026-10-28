# Weapons: blasts, triggers and scripted munitions

Status 2026-10-28. Full write-up with the reasoning and the alternatives: the "Grenades and Scripted Weapons" artifact linked from the PR that added this file. Weapons are built and tried in the viewer first (it is becoming a superset of the game); Keystone's par and leverage rules are not a constraint for now.

## What exists

**`BlastEvent`** (`packages/engine-api/src/blast.ts`): an input event that pushes every body whose centre lies within `radius` of `centre`, away from it, at the start of the step it is due:

```
|dv| = min(maxDv, impulse * w(d) * A / m)
w(d) = 1 inside core * radius, then ((radius - d) / (radius - core * radius))^falloff   (integer falloff)
A    = a quarter of the body's surface (its mean silhouette): 2 (hx hy + hy hz + hz hx) for a box, pi r^2 for a sphere
```

- `centre` is a point, or `{ body, offset? }`: that body's position when the blast is due, read from the engine's live state (a pipelined reader that sees the grenade one step late still blasts where it is). The body must exist when the blast is due; `checkBlastQueue` refuses the event at `init`/`push` otherwise.
- After each blast's kick a pushed body's speed is capped at `maxSpeed` (default 48, 0.8 of the sweep limit at 60 Hz; scaled with direction kept; `Infinity` turns it off), so stacked kicks cannot tunnel. Units are the engine's (cube units in a `scale`d world, where the sweep limit is larger still).
- Applied in event order with the spawns of the same step; a blast pushes only the bodies that exist when it is due.
- The kick is added to linVel and to the adaptive warm start's previous velocity (reference `prevLinVel`, GPU `SolverBody.prevVel`), so it is not read as an acceleration.
- Only +, -, *, / and one square root, so the f64 reference is the same on every machine.
- Implemented by the reference, the GPU engine (`packages/physics-gpu/src/blast.ts`: one dispatch on steps that have blasts, none otherwise) and Rapier. `TieredEngine` refuses blasts until it wakes dormant cells in the radius (`wakeSphere` exists).
- Tests: `@tb/testkit`'s `blast.ts` is one shared case (bodies in free flight around the centre, a spawn before and after the blast, an excluded id, and a second blast in the same step centred on a moving body with an offset and a speed cap); every engine must change exactly the velocities `blastKick` gives and leave every other body bit-identical (reference to 1e-12, Rapier and GPU to 1e-5 relative). The GPU also blasts a 6 x 4 x 6 block of cubes against the reference.

## Known limits of the v1 blast

| Limit | Consequence | Fix (planned step) |
|---|---|---|
| no body removal | the grenade stays as an inert ball (`exclude` keeps it out of its own blast) | `remove` event: tombstoned slots, skipped by every stage, `TIER.free` for the renderer |
| the speed cap can slow a body | a body already faster than `maxSpeed` inside the radius leaves slower than it came | intended (it guards the sweep); `maxSpeed: Infinity` for scenes that want none |
| pair pool is 16 per body | a blasted packed tower can need more pairs; overflow drops contacts silently | assert `pairsRequired <= pairsWritten` in blast tests; raise `pairsPerBody` for weapon scenes |
| no occlusion | a body behind another is pushed as hard | none planned |

## Plan (each step lands with its tests)

1. **Blast event** (done, #90).
2. **Grenade in the viewer**. 2a (done): body-centred blasts and the final-speed cap in all three engines. 2b: `proj=grenade` with timer and proximity fuses, blast centred on the grenade (`centre: { body }`), configurable from the Scene panel and URL. Proximity in free flight is predicted exactly at fire time (`freeFlight`); otherwise it is evaluated on the observed step k and stamped k + 1, which applies at the same engine step on serial and pipelined read-back.
3. **Remove event** (tombstones) in all engines and the renderer; the grenade is consumed.
4. **`@tb/weapons`**: a pure-data `WeaponSpec` (shell, rules of trigger -> actions, named child munitions as a tree of depth <= 3), a validator, a static body budget, and a deterministic runtime that turns observations into input events. Loaded from the viewer's scene file (`weapons` section, `projectile.weapon`).
5. **Relative spawn** (split, duplicate, emit, fireworks): children placed in the parent's frame from its live state, momentum-conserving spreads, batched buffer writes.
6. **Kick and sparse forces** (vibrate, thrust): a list of at most 64 forced bodies folded into the inertial target, one small dispatch per step.
7. **Joints** (weld): sticky shells, tubes as jointed chains, wobble as soft joints. Colouring must include joint edges.
8. **Tiered blasts**: `HostBatch.blasts`, waking dormant cells in the radius, for the 100k city.
