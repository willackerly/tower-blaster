# Rube Lab (M10)

Roadmap item M10 (`docs/game/modes-roadmap.md`, `plan/dag/nodes.json`): build a contraption that carries a rolling ball to a bell, from a small bin of parts, with no joints. The level's only shot is the plunger that opens a trapdoor; everything after that is the build and the physics.

Verify (the brief): gate first, then pinned parts in the level grammar and the bin (a pinned ramp moves exactly 0 on the reference and the GPU), the bell goal read from the observer, three to five levels, the parts list round-trips through JSON, and the levels clear on the GPU in CI. Scoring: a binary clear plus parts used against par, no cast.

## The gate (passed)

Before any level shipped, three contraption puzzles were prototyped headless on the reference engine (`AvbdReferenceEngine` at Keystone's iterations and gap slop, through the game's own `Driver` and `Session`). Each had to have at least two distinct solutions that a search bot finds, and an obvious wrong build that fails, all without joints.

**The bot** (`packages/keystone-lab/src/rube-gate.ts`, `pnpm rube:gate [RL1 RL2 RL3] [--json FILE]`) builds the way a player does: every candidate is a program of build-tool steps (`BuildSession.ghost` from a face hit, snap on, then `place`; or a mouse stroke for the domino brush, then `lay`), so the tool's overlap check, budget and bin decide what can be built. Hits are generated only on faces that exist. Candidates that give the same level (same hash) play once. A clear **counts only if it is robust**: the same build, with every placed part's centre nudged up to 0.05 h in x and z (8 seeded nudges), must clear at least 6 times of 8. A knife-edge build is not a solution.

| Puzzle | Builds played (refused by the tool) | Clears | Robust families, cheapest cost | Wrong builds (all fail) |
|---|---|---|---|---|
| RL1 Mind the Gap | 237 (51) | 27, all 8/8 | **span** (a slab laid over the gap from either shelf) 2; **fill** (a pier of three standing in the gap) 3 | nothing; a plank across (its 1/3 h step stops the ball); a cube in the bottom of the gap |
| RL2 Round the Corner | 222 (0) | 39, 32 robust | **turn** (a fixed bumper at -30 to -60 degrees) 3, (a free beam) 3, (a free 4 x 2 wall, 2 of 7 robust) 8; **relay** (a domino run curving off the ball's line to the bell) 6 | nothing; a straight run along the ball's line (it runs into the backstop) |
| RL3 Top Shelf | 70 (21) | 20, 18 robust | **ramp** (a fixed ramp up onto the shelf) 3; **topple** (a domino run into a plank on end, which falls onto the bell) 6 | nothing; a stair of cubes (the ball cannot climb a step) |
| RL4 Up and Over (M10b) | 131 (13) | 28, all robust | **climb + turn** (a ramp up onto the shelf, then a turner on it at -30 to -60 degrees): with a fixed bumper (12 of 12 robust) 6, with a free beam (16 of 16) 6 | nothing; a ramp alone (the ball runs past the bell); a bumper on the ground (it turns the ball along the shelf face) |
| RL5 Step and Turn (M10b) | 336 (42) | 83, 76 robust | **fill + turn** (a cube in the gap, then a turner on the far platform): bumper 4 (32 of 32), beam 4 (35 of 35); **span + turn** (a slab from the far platform back over the gap, then a turner): bumper 5 (4 of 7), beam 5 (5 of 9) | nothing; a cube in the gap alone (the ball rolls past the pocket); a bumper alone (the ball drops into the gap first) |

One build per family is recorded in `packages/keystone-lab/src/rube-solutions.ts` (the first of each level's list is its cheapest, the parts par), with the wrong builds; `test/rube.test.ts` replays them on the reference and `test/rube-gpu-RL*.test.ts` on the GPU.

What the gate taught (each changed a level before it shipped):

- **RL1's first gap (2.06 h) was not spannable.** Snap puts a slab's centre on the half-cell grid off the hit shelf's centre, so no slab reached both shelves, and a beam laid over the edge fell into the gap during presettle and wedged there (a fill, not a span). At 1.02 h the opposite failed: the bare level cleared, because the runner (0.4 h, about 2.6 m/s off the ramp) hops a one-cell gap. **1.5 h** is the window: too wide to hop (the bare level and a cube in the gap fail), narrow enough that a 3 h slab from the edge bridges it, and a 1 h pier fills it leaving two half-cell cracks the ball rolls over.
- **RL2's walls were knife-edge.** A free wall at an angle turned the ball on 1 to 3 of 8 nudges; a pinned bumper is what makes the turn family robust (17 of 18 clears). The first bell, a slab gong, slid only 0.05 h when hit, under the 0.25 h it takes to ring; a light plaster ball (1.6 h across) rings from a glancing hit.
- **RL3's first bells (a cube, then a flat domino) never rang from a falling plank.** A domino standing on the shelf facing the ball rings when anything tall falls on it; the bot then found the run-into-a-plank family (robust from the plank at x 8 h on; at 7.5 h it is 0 of 8, so it is not counted).

RL4 and RL5 (M10b) chain two of those families each, and the gate (the same bot, `pnpm rube:gate RL4 RL5`) taught three more things:

- **A bumper turns the ball by its own angle, not twice it.** With no restitution (the default, `Bounce` off) the ball slides along the face it hits and leaves along it, losing the speed across it; a -45 degree bumper sends the ball off at 45 degrees, not 90. Turners are aimed at the bell along their own face.
- **The settle clock is the time limit.** A level ends 600 steps (about 10 s) after the release when nothing has rung, so a contraption that works but is slow fails: on RL5's first, shallower start ramp a slab's 0.25 h edge took most of the runner's speed and the crawling ball was cut off before the pocket. RL5's start ramp is 30 degrees for that reason, and its slab builds still ring at steps 480 to 550 of 600, which is why that family is the narrower one.
- **A fast ball hops a gap a slow one cannot.** At 30 degrees the runner cleared RL5's first 1.5 h gap with no help and a bumper alone rang the bell; the gap is 2 h.

RL4 has one family. Its candidate second family, RL3's domino run curving into a plank on end in front of the shelf, never rang (0 of 36: the plank leans on the shelf edge, short of a bell 4 h in, and moving the bell nearer the edge broke the climb + turn without helping the plank), and turning first on the ground then climbing a yawed ramp leaves the ball too slow to climb (0 of 16). The test asks RL4 for one family in two recorded builds (`RUBE_MIN_FAMILIES`); every other level for two families.

If the gate had failed, M10 would have parked until V6 (joints) and the DAG runner been told; it did not.

## The design

**A level.** `rubeLevel(spec)` (`packages/keystone/src/rube-levels.ts`): part 0 is a pinned 1.2 x 0.2 x 1.2 h stone trapdoor, part 1 the runner (a 0.4 h stone ball) on it, then the level's scenery (pinned shelves, walls, ramps) and the bell. The level's one charge is a built-in **release** (`packages/weapons/src/builtins.ts`, `removeTarget` with no blast) on the trapdoor, and its rack is one `plunger`: the plunger shot `{ammo: 'plunger', fuse: [[0, 0]]}` (`RUBE_GO`) takes the trapdoor out and the ball drops onto the first ramp. Scoring is par-style (`scoring: par`, par 1), so the session ends at the clear or when everything settles.

**Level grammar.** Three additions, each optional and absent from every older level's hash:

| Addition | Field | Compiles to |
|---|---|---|
| Pinned piece | `piece.pinned: true` | `BodyDesc.pinned` (C8): never moves, never wakes |
| Tilted piece | `piece.tilt` (degrees about local +z, before the yaw) | `pieceQuat(yaw, tilt)` |
| Ball part | `{kind: 'ball', at, radius, material, role?, pinned?, placed?}` | a sphere body |
| Bell objective | `{kind: 'bell', region?: {min, max}, moved?}` | every crown must ring |
| Rube marker | `rube: true` | its plunger is the Go button (release the ball) |
| Parts par | `build.par` (any build level) | scored on the parts (`partsStars`); hashed (a retuned par is a new level for progress) |

`validateLevel` lets pinned bodies overlap each other (a ramp may sink into a shelf), skips the mass-ratio, support and flat-PE checks for pins, and flags a free body inside a pin, a bell level without a bell, a region with min not below max, and a region bell that starts inside its region (already rung). The viewer's level file reads and writes all of it (`packages/viewer/src/level-file.ts`; `level-file.test.ts` round-trips every Rube level and a built RL1).

**The bell.** A crown (`role: 'crown'`) on a bell level is a bell. It rings (`bellRung`, `packages/keystone/src/rules.ts`) when it is inside the objective's region, or, with no region, when it has moved `moved` h (default 0.25 h) from where the level put it. Once rung it stays rung (the session keeps it sticky), so a bell knocked back out of its region still counts. It is read from the observer like every crown: no new reduction.

**The bin.** Three items join the build catalogue (`packages/keystone/src/build.ts`), offered only on levels that name them in `build.pieces` (other build levels keep C9's original eight, `DEFAULT_PIECES`):

- **ramp**: a pinned plank 6 h x 1 h x 1/3 h rising 15 degrees; the ghost sits its low end flush with the face it is placed on. Cost 3.
- **bumper**: a pinned 4 h x 1 h x 0.3 h wall, turned with Q and E. Cost 3.
- **ball**: a free 0.4 h stone ball, placed as its bounding cube. Cost 1.

A pinned part ignores the ground and other pinned bodies in the overlap check, and is refused into a free body. Cost (`placedCost`) matches a placed part to its catalogue item by its sorted half-extents, so a file's parts list prices the same as the tool's.

**Scoring.** `levelScore` scores a level whose build block names a par (`build.par`) on its parts (docs/game/scoring.md, Parts par; M10b moved the par there from a `rube` block so Wavefront's Lay levels share it): `partsStars(cleared, spent, par)` gives 0 uncleared, 3 at or under the parts par (the cheapest robust build the gate found), 2 within half again (`ceil(1.5 par)`), 1 for any clear, less one for broken heritage; the stamp is PARTS PAR or +N PARTS, there is no gold, and the card reads "parts N / par P". The parts par is hashed, so a retuned par is a new progress record. Parts pars: RL1 2, RL2 3, RL3 3, RL4 6, RL5 4.

**In the game.** Rube Lab is a series on the door, after Undercut. A level opens in the build phase (C9's edit mode with the level's bin and budget); the slot's button reads **Go: release the ball** (F), which fires the plunger and runs the contraption.

**Hash note.** Authored geometry that uses trig (a ramp's centre from its foot, slope and length) is rounded to 1e-4 h once, in `rampTo` (`r4`): V8 in Node and Chromium can differ in the last bit of `sin` and `cos`, and the level hash must not.

## The goal, drawn (PT26)

Agent playtest round 2 (docs/game/agent-playtest-2.md, PT26): nothing said "ring the bell"; the bell was a grey sphere like the ball (RL2, RL4), RL3's domino bell was grey during the build, RL1's target (a region) was invisible, and a ring was a puff of sparks. Two root causes: the sphere shader ignored coats (coats were boxes only), so a crown sphere drew the look's stone; and the build phase's `EditView.show` set tints and marks but never coats.

- **The bell is gilt, in the build as in play.** Spheres now take coats (`fsSphere`: the coat's albedo, the real look's gilt metal, gilt's steady glow), so a bell sphere is the crowns' gold (COAT_GILT #E3A62F); `EditView.show` sets `structureCoats` too, so RL3's domino bell is gold before Go. `keystone.coats=0` turns both off, as for crowns.
- **The objective, said.** On a bell level the HUD's first row is **Objective: ring the bell** (the level's objective text), ticked once every bell has rung; the crowns row reads **Bells rung N / M**.
- **The ball's start and the goal zone.** Overlay beads (`rube-view.ts`, joined to the game's others): a ring of ten beads and a short column round the runner in the Go button's orange (#D8693F) until the release has gone (no inputs yet); a region bell's zone (RL1, RL5) as a dotted gilt outline on the region's floor.
- **The parts you built.** A placed part (`placed: true`) with no role is painted the builder's blue (scene.ts `BUILT_SRGB` #4A86E8, COAT_PAINT, so the same in every look), so the machine you made reads apart from the level's own pieces.
- **The ring.** On the bell's crownDown: a flash in the bell's gilt (`BELL_FLASH`: full glow fading over 1.6 s), two ring waves from it (`Renderer.ring`: `RING_BLASTS`, the blast shell alone, no fireball or smoke, to 3 h, the echo 0.35 s later to 4.5 h), a chime (audio.ts `BELL_PARTIALS`: five sine partials at a bell's ratios 0.5, 1, 1.2, 1.5, 2 on scale degree 10, decaying 2.6 s to 0.9 s) in place of the crown's thud, and the banner **The bell rang!**. After the flash the bell stops glowing, as a felled crown does: the steady glow means "still to do".
- **Other bell levels.** Wavefront's Lay levels (W1, W2, W6) are bell levels with a build too, so they get the same objective row, gilt bells, ring and painted built dominoes; the start marker is Rube Lab's only (it marks the runner).
- **The swing.** The bell moves because what hit it moved it (the physics); it is not hung, so it does not swing on a pivot. A hung bell waits for joints (V6).

Alternatives considered: for the zone, a translucent box (no transparent pass for bodies; it would hide the ball inside it) and a ground decal (a new pass for one level kind); beads are what Fuse & Fold's lot already draws (`lotBeads`) and read in every look. For the ring, a drawn swing (a pose offset in the renderer) was rejected because what is drawn would then differ from the physics the session judges; a particle burst alone is what the playtest found too small. For built parts, an outline or a per-look tint; a coat is one colour language across looks (look-colours.md) and costs nothing new.

## Tests

| Test | What it proves |
|---|---|
| `packages/keystone/test/rube.test.ts` | `pieceQuat`; tilt and pin compile and hash, order-independent; validation of pins and bells; the gate levels validate clean on gpu and rapier settings; `bellRung`; the session keeps a bell sticky and clears; the bin (ramp foot flush within 2e-6 h, refused into a free body, ball, bumper, cost, JSON hash); `partsStars` |
| `packages/keystone-lab/test/rube.test.ts` | On the reference: two or more families per puzzle clear, every wrong build is buildable and fails, pinned bodies move exactly 0, the parts par is the cheapest recorded clear |
| `packages/keystone-lab/test/rube-gpu-RL*.test.ts` (one file per level, rube-gpu.ts) | On the GPU (SwiftShader in CI, Metal with `TB_CHANNEL=chrome`), through the game's cast page: the bare level fails, the recorded solutions clear, pinned bodies end exactly where authored as f32 |
| `packages/render/test/render-sphere-coats.test.ts` | Spheres take coats: gilt gold, glaze teal, painted blue in every look; a bell's flash lights the gilt sphere at its start, is gone at its end, keeps the gold (fixed renderer times) |
| `packages/game/test/rube-e2e.test.ts` | RL2 on the game page (Rapier): in the build the bell's pixels are gold and the built bumper blue, the HUD says ring the bell; 10 steps after the ring the bell has moved, carries the flash over its gilt, the ring waves are out, the objective is ticked |
| `packages/game/test/rube-view.test.ts`, `scene.test.ts`, `hud.test.ts`, `audio.test.ts`, `render-blasts.test.ts` | The zone and start beads; crowns gilt and built parts painted; the objective row; the bell's partials; the ring waves' params and echo |
| `packages/viewer/test/level-file.test.ts` | Every Rube level and a built RL1 round-trip through the level file with the same hash; malformed pins, radii, regions and charge arms are refused, saying where |

## Alternatives considered

1. **Wait for joints (V6).** Hinges, ropes and pulleys are what most people picture in a Rube Goldberg machine, and V6 would allow levers, swings and see-saws. Rejected as a precondition: the gate shows that balls, fixed ramps and bumpers, dominoes and toppling planks already give puzzles with more than one real solution, so waiting would delay a working mode for richer parts. Joints become new bin items later (a lever, a swing), with no change to the level grammar beyond a part kind.
2. **Charges-only contraptions inside Fuse & Fold (M5).** Timed charges (cutter, kicker, relay) can already chain events, so contraptions could be a Fuse & Fold level style. Rejected as the main form: Fuse & Fold is about demolition order and timing, and its player edits a timeline, not a machine. The rolling ball carried by things you build is a different verb. The two share charges (the release is one), and a Fuse level can use pinned parts.
3. **A sandbox with no goal, as a viewer mode only.** The cheapest option: pins and the bin in the viewer's author mode, no levels. Rejected as the whole of M10, kept as a by-product: the viewer's author mode offers every catalogue item including ramp, bumper and ball, so the sandbox exists, but a goal and a par are what make it a game mode.

Smaller calls:

- **A bell as a region or a count reduction.** A region test on a crown's position (plus a moved distance for a hit) reuses the observer the session already reads. A tagged count reduction (C6) would also work, but adds a reduction to every bell level for no gain at this size.
- **Crowns reused as bells, not a new role.** A bell is a crown on a bell level, so the watched-crown machinery, the HUD's crown markers and the stars plumbing work unchanged. A new `bell` role would duplicate all of it.
- **Par scoring, not outcome scoring.** A contraption either rings the bell or it does not, and runs once; a points or collapse score would reward smashing things. Par scoring with the parts par is a clear target and fits the binary clear.
- **A release charge, not a timed unpin.** Removing the trapdoor is a charge C5 could nearly do already (`removeTarget`); unpinning a body mid-run would need a new engine event on every engine.

## Known limits and follow-ups

- The ghost does not check support: a part can be placed hanging in the air if it fits, and presettle drops it. The bot's builds all come from real faces, so the gate is not affected.
- A yawed piece that is part of a `run` would hash through trig; no Rube level has one.
- The domino brush lays on the ground only, so no level can ask for a relay on a shelf top (RL2's relay after RL3's ramp would be RL4's natural second family). Laying on the face a stroke starts on is a build-tool change.
