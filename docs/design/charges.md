# Charges and timed shots (roadmap C5)

Status 2026-11-06. Capability node C5 of the game-modes roadmap (`docs/game/modes-roadmap.md`): what M5 Fuse & Fold (timed demolition, sympathetic charges) and M10 Rube Lab (charges as parts) build on. This note is the design and the alternatives weighed; `docs/design/weapons.md` is the weapons language it extends.

C5 asks for four things:

1. **A shot that carries a timeline**: one input that sets off several things at chosen times.
2. **Level-owned charges at rest**: explosives the level places on its structure before play, which do nothing (and cost nothing) until they go off.
3. **A WeaponSpec action that removes a named target** (`removeTarget`): the cutting charge of real demolition, which takes a column out rather than shoving it.
4. **A `moved` trigger**: fires when its munition (or the block a charge sits on) is displaced or moving faster than a threshold. Sympathetic charges ("dormant charges that fire when jolted") are a charge with this trigger.

Verify (`plan/dag/nodes.json`): a shot with a 3-event timeline replays bit-equal; level charges at rest do not wake sleepers; `removeTarget` and `moved` unit-tested on all engines.

## The design

### A charge is a munition with no body: it rides a host

A charge is a `WeaponSpec` (the same language, validator and runtime as the rack's `w-` weapons) attached to one structure body, its **host**, at a point in the host's frame. It has no engine body of its own. Its rules run on the host's observed state:

- `blast` is centred on the host (`centre: { body: host, offset }`, the engine-api body centre), with the charge's point turned into the world frame by the host's rotation in the state the event was decided from (one step before it is due). The host is not excluded: a charge on a column's face pushes the column away from that face.
- `removeTarget` removes the host (an engine-api `RemoveEvent`).
- `remove` spends the charge with no engine event (a disarm, e.g. a sympathetic charge that stands down after 5 s).
- Triggers: `after`, `moved`, `then`, `any`. `near` and `apex` are refused on a charge (its host is always touching its neighbours and at rest), and so is `split` (a charge spawns nothing; relative spawn is weapons plan step 5).

Because a charge has no body, a level with charges is, to the engine, the level without them until one goes off: the same bodies, contacts, presettle and sleep. "Charges at rest do not wake sleepers" holds by construction, and the tests check it by running a level with and without dormant charges and comparing every state bit for bit.

### Alternatives weighed for "a charge"

| Option | For | Against | Verdict |
|---|---|---|---|
| **A: a real body** (a small box placed in the structure, a WeaponSpec shell at rest) | physical: can be knocked off, `near` works literally, renders as itself | changes the structure's physics and presettle; adds contacts that can keep stacks awake (the exact thing the verify forbids); a box on a column's side cannot stay there without joints (V6), so charges could sit only on top faces | rejected |
| **B: a virtual munition riding a host** (chosen) | zero engine cost until it fires; sticks to any face; sleepers untouched by construction; reuses WeaponRuntime's triggers and the engines' body-centred blasts and removals | must be drawn by the renderer as a marker (M5's job); a charge goes with its host (if the host is pulled, shattered or cut first, the charge is a dud) | **chosen** |
| C: a world-fixed point (no host) | simplest | a charge on a falling column stays in the air; `moved` has nothing to watch; `removeTarget` names nothing | rejected |

### `removeTarget`: what "named" means

The target of a charge is its host, named by the level (`LevelDef.charges[i].host`, a structure body's id). A thrown munition has no named target, so `removeTarget` is refused on anything fired from the rack (`thrownProblems`, reported by the level validator as a `weapon` issue, and `WeaponRuntime.launch` throws). Alternative weighed: the nearest body to a thrown munition when its rule fires ("the block it hit"). That is a powerful verb (a grenade that deletes a block is a pull at range), it needs a reach rule and a tie-break, and no planned mode needs it; it can be added later as `removeNearest` without changing `removeTarget`.

Removing a body is charged as a pull is (`pullEnergy`, the nominal poke a removal stands in for), so leverage stays defined and a cutter is not free.

### `moved`

`{ moved: d, speed?: v }` holds at the first observed state where the munition's centre (a charge's: its host's) is at least `d` from where it was in the first state observed at or after its clock started, or (with `speed`) moving at least `v`. Squared distances against `d * d`, so it is the same on every machine. It cannot be predicted (it watches the world, not a free-flight path), so it is due at the step after the state that showed it, at the soonest, and a sparser reader sees it later. Inside `then`, its clock (and so its reference point) starts when the first trigger held: `{ then: [{ after: 1 }, { moved: 0.1 }] }` is a mine that settles for a second and then goes off when disturbed.

Alternatives weighed: an impulse/contact-force trigger (needs a new engine read-back; the observed velocity change is the same signal one step later); acceleration (the second difference of positions is noisy on f32 GPU snapshots); rotation (a toppling column moves its centre too, so displacement covers it).

### When a charge's events go in: just in time

A thrown weapon's timer events are pushed as soon as they are known (a timer grenade's blast goes in with its spawn). Charges instead release each event only when it is due at the next step: at the state observed one step before (stamped `snapshotStep + 1`), or at the plunger itself for a delay of 0 (stamped the fire step, as the shot's own event would be). Every step is observed (the Arsenal's lookahead is 1), so no event is late, and the two readers (serial and pipelined) push the same events at the same engine steps (keystone-lab driver-step.test.ts's rule).

Why: a charge's host can leave the world between the plunger and the charge's step (another charge cuts it, the player pulls it mid-shot, the structure carries it away and then something removes it). An event already in the engine's queue for a removed body is refused by `checkInputQueue` and throws. Released just in time, the Driver can drop a charge whose host is gone or going (a removal of it already pushed, due by then) and the run goes on: the charge is a dud, as a real charge on a felled column would be. The alternative, pushing early and pulling events back out of the engine's queue, needs an engine-api "cancel" that does not exist.

### The plunger: a shot with a timeline

A new rack item `plunger` (bare, like `pull`). Its shot names charges and their delays:

```
plunger.0.0.2.20.1.45     charge 0 at once, charge 2 twenty steps later, charge 1 at 45
```

`{ ammo: 'plunger', fuse: [[0, 0], [2, 20], [1, 45]] }`: up to `MAX_TIMELINE` (16) pairs of (charge index, delay in engine steps, 0 to `MAX_FUSE_DELAY`). Each named charge is armed at the fire step plus its delay: its clock starts there, so a cutter (`after: 0`) goes off at that step and a charge with its own `after: 0.5` half a second later. Steps, not seconds, because the rest of shot text is integers and rapid fire's `@after` is already in steps; a mode's UI quantises (M5's timeline in 0.05 s = 3 steps at 60 Hz).

- One plunger shot is one stroke: one rack slot, one settle. The shot holds its settle while any armed charge has a timer running (as a live fuse does now), and never past the settle rule's cap: the session refuses a delay at or past the cap.
- A charge goes off at most once: the session refuses a plunger that names a charge already armed, a charge armed at start, an index out of range, or the same charge twice.
- Order matters: two charges with the same delay go in in the order the shot lists them (their events' push order), which the shot text keeps.
- Energy: the press is free (ke 0); the shot's yield is the nominal yield of every blast its charges can set off plus a pull's energy per removal (the static worst case, as the rack charges weapons).
- Text: `plunger.c.d.c.d...`, an even number of fields after the name. Records: ammo code 6, then the pair count and the pairs as varints. Text and records from before read as they did.

Alternatives weighed for "a timeline":

| Option | Verdict |
|---|---|
| **A plunger shot listing (charge, delay)** (chosen) | one stroke, exact integers, fits shot text and records, composes with each charge's own rules |
| A volley: several launch shots in one shot at offsets | rapid fire (`@after`) already sequences launches; not what demolition needs |
| Delays inside the level's charge definitions (the level fixes the order, the player only presses) | no decision left for the player: M5's whole verb is choosing the order |
| Pull events on a timeline (removal without charges) | covered: a charge that only has `removeTarget` is a timed pull, and the level still decides where removals are allowed |

### Charges armed at start

`LevelDef.charges[i].arm: 'start'` arms a charge when play starts (after the presettle), its clock at that step; such a charge is not named by plungers. With a `moved` trigger it is the sympathetic charge. A charge watching with no timer running does not hold a settle (it could wait forever); one whose timer is running does. Its energy is the level's, not the player's: it is part of the puzzle, so no shot is charged for it.

## Built-in charges

`@tb/weapons` `BUILTIN_CHARGES`, in cube units (scaled to a level's commonest block as `w-` items are), named by `LevelDef.charges[i].weapon` unless the level's own `weapons` has that key. Built-ins a level names join its hash written out, as defaulted `w-` items do.

| Charge | Rules | Energy (grenades, blasts only) | Use |
|---|---|---|---|
| `cutter` | at arming: blast r 1.5, impulse 2 (3 m/s to a cube in its core), then `removeTarget` | 0.00012 + one pull's energy | the demolition cut: takes a column's base out |
| `kicker` | at arming: blast r 2, impulse 4 at its point, then spent | 0.0012 | shoves its host away from the face it sits on (a direction for the fold) |
| `relay` | `moved` 0.05 or speed 0.5: the cutter's blast and `removeTarget` | 0.00012 + one pull | sympathetic: arm at start; goes off when jolted |

The blasts are deliberately small: a cut's work is the removal (gravity does the rest), and a big blast would make the order of cuts matter less (probe X2's risk).

A quirk found on the way, not changed here: a level hash is FNV over the JSON of the level with defaults written in, and JSON keeps insertion order, so writing a built-in into `weapons` by hand can hash differently from naming it when the level also gains a written-out `physics` or `settle` key (an ice level, a v3 outcome level). Both are stable; it only means "written in" and "named" are not interchangeable for cast stars. Same for `w-` items since G3.

## What C5 does not do (M5's and M10's)

- No UI: the game cannot place charges or edit a timeline, and draws no charge markers. A level with charges plays from shot text (`keystone.shots`) and in the lab; M5 builds the timeline editor, the plunger button and the charge markers.
- No player-placed charges (M5's "place charges on a building" and M10's parts bin need C9, the placement tool).
- No domino fuses (C9's stroke brush).

## Where it lives

- `@tb/weapons` (`spec.ts`, `runtime.ts`): the `moved` trigger, the `removeTarget` action, `chargeProblems` / `thrownProblems`, `WeaponRuntime.attach` (a munition riding a host), its just-in-time release and `waiting`.
- `@tb/keystone`: `LevelDef.charges`, the `plunger` rack item and `PlungerShot` (`shots.ts`, `record.ts`), the Session's arming rules, the Arsenal's charges and the Driver's gone-host filter.
- Tests: weapons (reference engine, unit), keystone (text, records, validation, session rules), keystone-lab (reference and Rapier: a 3-event timeline replayed bit-equal, sleepers untouched, `moved` and `removeTarget` acting in the engine) and the GPU through the game's cast page (SwiftShader in CI).
