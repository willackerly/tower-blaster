# Stacking, balance and extraction: 25 mode ideas (lens ST)

Designer lens: Jenga-style pulls, steady-hand removal, building against gravity, counterweights, cantilevers, balance under wind and quakes, stacking races, odd shapes, load reading.

Three engine facts shape this lens:

1. **There are three ways to "pull" a block, and they feel different.**
   - `remove` (exists): the block vanishes. It is clean, instant, replayable and cheap. Neighbours lose support but feel no sideways tug, so it suits "which block is load-bearing" play, not "can I slide it out" play.
   - The **cue** rod (exists): an impulsive push out of a face. It is a strike, not a steady push. It stays behind as rubble, and at 94 kg it is far too heavy for Kapla-scale planks, so a toy-scale cue is needed there.
   - **Sparse force, step 6** (planned): a held, capped force on up to 64 bodies. This is the only one that gives the real Jenga feel, where friction drags the neighbours and you choose to keep pulling or let go. It needs physics running while you act, not frozen.
2. **Placing blocks is already possible.** `spawn` at a pose with zero velocity, done while physics is frozen, places a block. The cue's face-pick already gives a surface to snap to. Placing does not need joints or kinematic bodies.
3. **Earthquakes and rolling decks are nearly free.** In the ground's frame, a shaking ground is exactly the same as a gravity vector that changes over time: g(t) = (-a_x(t), -9.81 - a_y(t), -a_z(t)). The ground plane is infinite and static, so a scheduled gravity vector gives exact quakes with no kinematic bodies. The catch is that a gravity change must wake every sleeping body.

Tags: **[Hybrid: X]** marks a cross-lens idea and **[Wild]** marks a deliberately strange one.

---

### ST-1 Hollow Tower
- **Pitch:** The classic extract-and-restack on a plank tower, with a held finger pull that drags neighbours by friction and lets you feel a block "grab".
- **Fun hook:** Every pull is a bet on which block is loose. You hold, watch the neighbours creep (displacement ink lights them), hear the wood creak, and choose whether to keep pulling or let go. A block you release stays half-out, so you are committed. In the first 30 s, three easy pulls give way to a fourth that grabs and sets the top swaying.
- **Borrowed from:** Jenga (turn structure, last pull loses); Operation-style steady-hand fail-on-touch; Getting Over It (input you cannot undo).
- **Loop:** 30 s: tap-probe two blocks, pull one (a 2-6 s hold), then place it on top while physics is frozen. 5 min: 15-25 pulls as the tower gets taller and hollower. Solo score = pulls x height; hot-seat for 2-4 players, last pull loses.
- **Scale story:** Honest answer: the classic 54 blocks is the sweet spot, and making the tower taller adds little. Scale pays when the tower gets wider. A 9x9 "slab Jenga" of 1k planks gives hundreds of choices and visible load bands. At 10k planks (a Kapla spire, around 3k in real time per B5) the question becomes height: low pulls carry more load and more risk, and a collapse is a 10k-plank spectacle. 100k is not interactive.
- **Uses today:** Kapla S15 planks; face pick (cue placement); `spawn` at rest for the restack; PE and nMoving reductions plus a crown line for "tower fell"; the pulled block and 63 neighbours as watched bodies; the modal synth; the `look=real` Kapla hall.
- **Needs new:** sparse force step 6 with a force cap, which is "finger strength" (M, med); a GPU-side spring-to-cursor target so a 1-2 frame readback lag cannot make the grip oscillate (S on top of step 6, med); physics running while pulling, a shell mode switch (S, low); a friction-slip "creak" voice driven by contact sliding speed (M, low); a restack ghost with an overlap check (S, low).
- **Level seeds:** "Classic 54" (18x3 maple planks); "Ice Core" (every third course is ice, mu 0.05, so blocks fly out and overshoot); "Pisa Pull" (a tower built with a 2 degree lean, where pulls on the high side are the safe ones).
- **Risks:** Jenga is a game of touch and a mouse has none, so sound and ink have to carry it. AVBD at 40 iterations has to hold true static friction under a partial pull: if stacks creep, the skill becomes noise, and sleep could hide or worsen this. Bot stars need a pull policy.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 3 / cost 3

### ST-2 Strain Reader
- **Pitch:** A 10k-block monolith, a load X-ray and a clock: remove as many blocks as you can before it gives.
- **Fun hook:** The X-ray shows force flowing like rivers. Each removal visibly reroutes them (a before/after flash), so you are reading a living map, not guessing. The first 30 s are a quick-fire clear of obviously unloaded blocks. Then arches start to form by themselves and every choice gets interesting.
- **Borrowed from:** Minesweeper (deduce from visible information); Into the Breach (perfect-information telegraph); bridge-builder stress colours.
- **Loop:** 30 s: about ten removes, each waiting for "settled" (nMoving = 0). 5 min: a quota run (remove 40% without the crown line dropping) or a timed run; the score is the fraction removed.
- **Scale story:** At 1k you reason block by block. At 10k the material reads like a field: load paths form natural arches, much like a sand pile, and you carve galleries. At 100k it is a mostly sleeping mesa where you remove with a brush (many `remove` events per step, which are tiny). That is plausible once sleep compaction lands.
- **Uses today:** `remove`; nMoving and PE reductions; the designed load X-ray; displacement heatmap; sleep, so only the disturbed region costs.
- **Needs new:** per-body load from AVBD contact multipliers (lambda), summed per body and smoothed (M, med: lambda is noisy at rest); an X-ray refresh after each settle (S, low); a remove brush (S, low); sleep compaction for the 100k version (L, med, already planned).
- **Level seeds:** "Grain Silo" (a 20x20x25 cube block); "Cathedral Core" (B2's 5k cathedral with heritage glass: remove 30% of the masonry); "Mesa" (100k, stretch).
- **Risks:** With perfect information it is easy to solve, so it needs a clock or a hidden component (see ST-14). If X-ray values flicker at rest, trust in the map collapses.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 3 / cost 3

### ST-3 Outreach
- **Pitch:** With N blocks, stack the longest possible overhang off a cliff edge.
- **Fun hook:** Your intuition says it is impossible, and then a harmonic stack leans a full block length past the edge. With counterweights allowed, the parabolic stacks of the overhang problem go much further. Every block you add moves the balance point, and you watch the tip tremble.
- **Borrowed from:** the block-stacking overhang problem (harmonic stacks, Paterson-Zwick loaded stacks); the build-then-test phase of bridge builders; Kapla free build.
- **Loop:** 30 s: place 5 blocks while frozen, press Test, watch it settle or fail. 5 min: a 20-60 block budget chasing a par overhang, with a ghost of the known optimum unlocked after three tries.
- **Scale story:** The overhang grows like log n for a plain harmonic stack and like n^(1/3) with counterweights. 1k blocks reach roughly 6 lengths and 10k roughly 13. At that size the build becomes a fan-shaped wing like a cathedral flying buttress. Placing 10k blocks one at a time is impossible, so large levels use course stamps. 100k does not add anything.
- **Uses today:** `spawn` at rest; a plinth made of blocks (there is no static geometry besides the ground, so the "cliff" is a solid wall of the same blocks); bbox reduction for the overhang; a settle gate.
- **Needs new:** a placement ghost with surface snap and overlap check (S, low); course/row stamps (S, low); a "Test" run to rest with a timeout (S, low).
- **Level seeds:** "Twenty" (20 plaster cubes, par 1.5 lengths); "Counterweight Allowed" (60 blocks with 6 iron blocks); "Ice Shelf" (an ice-friction plinth, so friction can't hold you and it is pure balance).
- **Risks:** The best answer is known, so it is a skill test for a few minutes, not a long hook. Solver creep on long stacks could fail stacks that should stand, which needs a sleep/stiction check.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 4

### ST-4 Aftershock Architect
- **Pitch:** Build, or retrofit, a structure, then survive a scripted earthquake.
- **Fun hook:** You place your last buttress, press Quake, and everything sways in slow motion while you wait to see whether your crown stays up. The twist at scale: you do not build the city, you get 200 blocks to brace a 10k city that already stands.
- **Borrowed from:** school shake-table contests (balsa towers); the test phase of bridge builders; Tricky Towers (stability under pressure).
- **Loop:** 30 s: place 12 blocks from a budget, then a 6 s quake. 5 min: a magnitude ladder of levels, with stars for blocks used and crowns kept.
- **Scale story:** 1k: you build the whole tower. 10k: a retrofit puzzle on S4/S14 cities, where the X-ray shows soft storeys and you shore them. 100k: a quake wakes every body (sleep gains are gone), about 30 ms per step, so it plays as a planned slow-motion cinematic, not live.
- **Uses today:** `spawn` at rest; crowns and heritage; collapse and skyline objectives; city scenarios; the modal synth (a city-wide rumble).
- **Needs new:** a time-varying gravity vector from a quantised schedule in the level file (S, low); wake-all when gravity changes (S, low); waveform authoring (presets for P-wave jolt, S-wave sway, long-period roll) (S, low); slow motion by stepping at a fraction of real time (S, low). The alternative, a shake-table slab driven by step 6, is worse: it is friction-limited and costs more.
- **Level seeds:** "Two-Storey Test" (a 30-block tower, magnitude 3); "Soft Storey" (an S14 building with an open ground floor: brace it with 40 blocks); "Old Town" (a 10k S4 city, 200 blocks, spare the three heritage towers).
- **Risks:** Gravity-tilt quakes are physically exact, but the ground does not move on screen. The fix is to shake the sky, dust and horizon only, and never the camera (Will's camera rule). Building first and testing later can feel slow, so test runs must stay short.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 4

### ST-5 Crosswind
- **Pitch:** Stack a cairn on a ridge while gusts arrive on a telegraphed rhythm, and use your own blocks as windbreaks.
- **Fun hook:** A flag snaps and dust streaks start two seconds before a gust. Do you place one more block now, or brace the windward face? Exposed blocks get shoved and sheltered ones stay put, so the shape of the tower is the strategy.
- **Borrowed from:** Worms/golf wind indicators; rhythm-game telegraphs; sailing games (reading gusts).
- **Loop:** 30 s: three placements between two gusts. 5 min: reach a height H before the storm peaks (gusts grow).
- **Scale story:** At 1k it is a single cairn. At 10k with an exposure model, wind erodes a field of stacked cairns: windward faces strip, leeward sides shelter, and dune-like shapes appear by themselves. You place 50 blocks to save one shrine. 100k erosion is an offline timelapse.
- **Uses today:** a cheap gust is possible today as a `blast` centred about 200 m away with a maxDv cap. It is a uniform impulse, so heavy blocks resist, but it also hits shielded blocks, which is wrong. Also `spawn` and crown height.
- **Needs new:** a wind field that knows exposure, computed by a GPU pass that rasterises bodies onto a plane facing the wind and pushes only first-hit faces, with force proportional to area (M-L, med); gust telegraph visuals (S, low); a wind-noise voice tied to gust strength (S, low).
- **Level seeds:** "Ridge Cairn" (40 stone blocks, gusts every 8 s); "Shelter the Flame" (keep a marked sphere on a plinth with a windbreak); "Dune Field" (10k cairns, an erosion survival).
- **Risks:** Without exposure, wind is just tilted gravity and the windbreak idea fails. The exposure pass is real engine work, and it touches the solver's force path (step 6 is limited to 64 bodies, which is not enough).
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 2 / cost 2

### ST-6 Heavy Weather Hold
- **Pitch:** Load cargo crates onto a rolling deck in real time; time each drop to the level point of the roll.
- **Fun hook:** The deck rolls on about an 8 s period. Drop on the swing and the crate skates. Drop at the level point and it holds. Heavy crates low, light ones high, crates interlocked: it is a packing puzzle with a metronome.
- **Borrowed from:** the Tetris piece queue; Overcooked's rocking-ship hazard; real cargo-lashing practice (centre of gravity low).
- **Loop:** 30 s: six crates on two rolls. 5 min: a voyage that loads X tonnes per port, the sea gets rougher, and lost cargo counts against you.
- **Scale story:** Mostly small: 50-500 crates. At 10k it becomes a container-port finale, where a slow roll of a pre-stacked 10k yard shows which stacks fail. Honestly, scale is not the hook here.
- **Uses today:** `spawn` with a small downward velocity; materials as crate weights; count-in-zone predicates for "overboard".
- **Needs new:** the gravity-vector schedule from ST-4 (S, low; a pure tilt ignores centrifugal terms, which is fine at slow rolls); real-time placement without freezing (S, low); a rocking horizon and sea render while the deck stays fixed on screen, which is correct in the deck's frame and respects the camera rule (S-M, low).
- **Level seeds:** "Calm Harbour" (2 degree roll, 20 crates); "Iron Ballast" (place 4 iron crates first or nothing holds); "Squall" (irregular roll plus heave from a vertical g term).
- **Risks:** It shares a primitive with ST-4 and could feel like a variant of it. A tilting world on a fixed-view deck could confuse until the sea sells it.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 4 / cost 4

### ST-7 Mason and Mole
- **Pitch:** Asymmetric hot-seat: one player removes blocks from a tower, the other must keep it standing by adding blocks.
- **Fun hook:** The Mole's question is "what single removal hurts most?" The Mason's is "where will they strike next?" Both see the same load X-ray, so it is a bluff-free duel of reading. A turn takes 15 s and every move is legible.
- **Borrowed from:** asymmetric board games (Fury of Dracula, Scotland Yard); Jenga; tower defence (shoring as defence).
- **Loop:** 30 s: two turns each. 5 min: a 10-12 turn match where the Mole wins if any crown falls below the line. Swap roles and compare.
- **Scale story:** At 1k it is a tight duel on a 300-block tower. At 10k on a city the Mole becomes a termite with 3 removes per turn and the Mason places 2 per turn, and the battlefield is which building to defend. At 100k the Mole digs (see ST-18).
- **Uses today:** `remove`, `spawn` at rest, crowns, heritage (the Mole cannot touch heritage), the settle gate, same-device determinism (a perfect replay of the match).
- **Needs new:** a hot-seat turn manager (S, low); placement ghost and snap (S, low); load X-ray (M, med; optional but the heart of it); a bot that can play either side for solo (M, med).
- **Level seeds:** "Bell Tower" (300 blocks, one crown bell); "Twin Keeps" (two towers and one crown each: the Mole can split attention); "Market Square" (a 10k S4 city, 3 crowns).
- **Risks:** Balance between the sides is hard to tune, and one side may dominate. Turns that wait for settling can drag on a city, so cap them with a timeout.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### ST-8 Sapper
- **Pitch:** Keystone with no ammo except pulls: undermine a structure so it falls the way you want.
- **Fun hook:** Removing a block on the south face tips the tower south. Remove two, a beat apart, and it twists. The first 30 s are a slow, creaking lean, then the rush onto the crowns. You aim a collapse, not a cannonball.
- **Borrowed from:** siege sapping and mining (Stronghold-style undermining); Angry Birds (objectives and stars); Jenga run in reverse.
- **Loop:** 30 s: pick a block, it vanishes, then lean, rush, hit-stop on the first crown. 5 min: 3-6 pulls across a level, banking as Keystone does today.
- **Scale story:** At 1k, a wall: choose its topple direction. At 10k, a city where pulls start building-to-building dominoes and the choice is which building falls first. At 100k there is not much more, except as the finale of ST-16.
- **Uses today:** almost all of it: the Keystone shell, `remove`, crowns/skyline/collapse objectives, heritage and footprint, rubble persisting, bank, hit-stop, displacement ink, bot star casting (it fits the existing shot model).
- **Needs new:** a `pull` rack item = remove the clicked body (S, low); a leverage-score fix, since removes fire 0 J and leverage divides by zero, so charge each pull a nominal energy such as the removed block's m g h (S, low); an optional cue-at-low-speed "nudge" item tuned per material (S, low).
- **Level seeds:** "Fell Left" (a 1k leaning column; crowns on a hut to the west); "Spare the Chapel" (a 5k tower that must miss the heritage chapel next to it); "Domino Row" (8 S14 buildings: topple them in sequence with 3 pulls).
- **Risks:** `remove` alone may feel like magic, not craft, so it needs a satisfying vanish (puff, chip particles, a short creak before the drop). Pull-only levels may have one solution; mix with marbles.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### ST-9 Self-Quarry
- **Pitch:** [Hybrid: competitive] A hot-seat fort duel where your only ammo is blocks you pull out of your own fort.
- **Fun hook:** More ammo means a weaker castle. Every shot is two decisions: which of your blocks can you spare, and where on their fort to send it? Big blocks hit hard but leave big holes.
- **Borrowed from:** Worms / Scorched Earth (turn duels with an aim arc); Rampart (castle duels); Tetris garbage lines (the "Tithe" variant).
- **Loop:** 30 s: quarry a block, aim, launch, watch their wall chip. 5 min: a best-of-3 match. In the Tithe variant both players race to a height and each pulled block drops onto the rival's top.
- **Scale story:** At 1k a fort per player and every block matters. At 10k ammo is effectively unlimited, so the game shifts to which zone you quarry without opening a load path. Late in a match, both forts are shells with X-ray rivers.
- **Uses today:** `remove` plus `spawn` with velocity (the launch); the projectile aim UI; crowns; same-device replay of the whole match.
- **Needs new:** body transfer, i.e. remove and respawn the same dims and material as a launched body (S, low); a duel turn manager (S, low); a CPU opponent from the bot caster's shot search (M, med).
- **Level seeds:** "Twin Keeps" (500 plaster each, 3 crowns); "Glass Cannon" (a stone fort against an ice fort: ice blocks slide out easily but crumble); "Tithe Spire" (a 40 m height race, Tithe rules).
- **Risks:** Launching plaster blocks may hit weakly against plaster (the mass-ratio notes in spectacle-mode). It needs denser forts or a small speed boost. Hot-seat only, no online.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### ST-10 Lopsided
- **Pitch:** Turn-based stacking of odd shapes (any box size, plus cursed spheres) from a preview queue, aiming for a target height.
- **Fun hook:** The next piece is a sphere, so you need a cradle in two moves. The queue gives just enough foresight to plan and not enough to feel safe.
- **Borrowed from:** Tetris (preview and hold); Tricky Towers (odd pieces, height goal); Boom Blox build mode.
- **Loop:** 30 s: 4 pieces placed while frozen, each settles before the next. 5 min: a height target with a piece budget; stars for spare pieces.
- **Scale story:** The twist is building on rubble. The level starts on the 10k debris pile left by a Keystone level you finished (rubble persists), so the base is a chaotic, real scree slope. At 1k it is a tidy tower. 100k is not relevant.
- **Uses today:** boxes of any half-extents and spheres; `spawn` at rest; the settle gate; bbox max for height; persistent rubble.
- **Needs new:** a seeded piece-queue generator with a hold slot (S, low); placement ghost, snap and rotate (S, low); "rubble import", i.e. a level that starts from another level's final snapshot (S-M, low on the same device).
- **Level seeds:** "Pebble Tower" (10 m, 30% spheres); "Planks and Pucks" (long thin planks and flat discs made from short wide boxes); "On the Ruins" (build 8 m on the B3 aftermath).
- **Risks:** Turn-based stacking can feel sedate. Spheres may just roll off and frustrate, so the queue needs fairness rules.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 4

### ST-11 Topple Sprint
- **Pitch:** A real-time stacking race: blocks drop from a hover cursor with gravity running, against your own ghost.
- **Fun hook:** Speed against stability. Dropping fast keeps you ahead of the ghost, and one bad drop costs you the top three courses. It is frantic from second one.
- **Borrowed from:** Tricky Towers (real-time drop and rotate); Tetris Sprint 40L; Trackmania ghost racing.
- **Loop:** 30 s: one sprint to 5 m. 5 min: 8 sprints chasing the ghost, with medals.
- **Scale story:** Honest: this is a mode at a 50-500 block scale. Scale is not its hook. Its value is pace in a lens that is otherwise slow.
- **Uses today:** `spawn` with a small velocity; bbox height; same-device replay (the ghost is a replay).
- **Needs new:** real-time spawn and rotate without freezing (S, low); a ghost rendered from recorded transforms, translucent and not simulated, so it costs no physics (S-M, low); rotate controls (S, low).
- **Level seeds:** "5 Metre Dash"; "Ice Blocks Only"; "Narrow Base" (a 1-block-wide plinth).
- **Risks:** The genre already exists, so novelty is low. The ghost works only on the same device.
- **Scores (1-5):** fun 3 / novelty 1 / engine fit 4 / cost 4

### ST-12 Grain Vault
- **Pitch:** [Hybrid: sandbox/granular, after SPILLWAY] Pull wall blocks from a silo of 5-10k marbles and steer the pour into goal bins.
- **Fun hook:** Pulling a block from a pressure vessel. Real granular physics surprises you: silo pressure saturates with depth (the Janssen effect), so a low pull is not much worse than a mid one. The pour can also jam into an arch at the hole, which you then have to poke.
- **Borrowed from:** pinball/pachinko routing; hourglass toys; SPILLWAY from the existing concept panel; Jenga extraction.
- **Loop:** 30 s: pull one block, watch marbles stream out and fill a bin. 5 min: fill 3 bins to their lines with N pulls without the silo wall collapsing.
- **Scale story:** At 1k marbles it is a trickle. At 10k it is real granular flow: jamming arches, avalanches, a heap that grows at the angle of repose. 100k sand is offline only.
- **Uses today:** spheres (marbles); `remove` or cue for pulls; count-in-box predicates; marbles as rack ammo to un-jam; the modal synth (marble rattle is a gift).
- **Needs new:** a sparse-force pull for partial openings (M, med; `remove` works for full openings today); a granular rattle voice so 10k contacts sound like a pour, not 8 clicks (M, low); a bin-fill objective (S, low).
- **Level seeds:** "Hourglass" (one wall, one bin); "Two Spouts" (left and right bins with different quotas); "Jammed" (a narrow opening where you must break the arch with a marble).
- **Risks:** 10k spheres all moving is a full-awake cost (about 10 ms), which is acceptable. The sphere stacking stability of AVBD under a load of 10k is untested.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### ST-13 Fuse Pull
- **Pitch:** [Hybrid: dominoes/chain reaction] One pull topples a tower into a domino field, and the chain must run 200 m to the target.
- **Fun hook:** You choose which block to pull, which sets fall direction and timing, and place 5 bridging dominoes. Then you watch a chain you started cross the whole map. The tension rises with every gap it has to jump.
- **Borrowed from:** domino-rally events; The Incredible Machine and Rube Goldberg setups; Jenga as a trigger.
- **Loop:** 30 s: pull, watch the tower fall onto domino 1. 5 min: a 2-minute chain watched from player-driven overhead framing, with stars for crowns hit.
- **Scale story:** This is the first mode where 100k may be real time, because only the wave front is awake. At 10k the chain spans a valley. At 100k it is a fully sleeping domino continent with a front of a few hundred bodies. The cost scales with the front, not the field.
- **Uses today:** domino-shaped boxes; `remove`; sleep and wake on impact; crowns; the long-fuse shot tag.
- **Needs new:** sleep compaction and the persistent sleeper grid (L, med, planned E2); placement for the bridging dominoes (S, low); a chain-front tracker (movingBox exists, plus a minimap) (S, low).
- **Level seeds:** "First Fall" (a 200-block tower and 1k dominoes in a line); "Fork" (two branches, the tower must fall at 45 degrees); "Continent" (100k, stretch).
- **Risks:** Once the pull is made, play is passive, which is what CHAINFALL worried about, so keep turns short. The overlap with a dominoes lens is high: the stacking angle is the trigger.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 3

### ST-14 Skeleton Key
- **Pitch:** [Hybrid: puzzle] Minesweeper Jenga: probe blocks for load numbers and remove everything that is not load-bearing.
- **Fun hook:** Tap a block and it shows a number, such as how many of its contacts carry load, or a load band. Deduce which blocks are safe and pull them. Pulling a bearing block is a mine: the structure groans or falls. The goal is the minimal skeleton.
- **Borrowed from:** Minesweeper (number hints, deduction); Picross; Jenga.
- **Loop:** 30 s: three probes, two safe removes, one creak. 5 min: a 200-block puzzle; three stars means a minimal skeleton with no creaks.
- **Scale story:** 1k is the most it can be and still read as a puzzle; 200-500 is the sweet spot. 10k only as "expert boards" that unlock in chunks. Scale is not the point here, and that is fine for a puzzle mode.
- **Uses today:** `remove`; displacement predicates (a creak is any body moving more than 1 cm); the settle gate; deterministic replay, so the puzzle is identical every time on the device.
- **Needs new:** per-body load from AVBD lambda (M, med); a probe UI with number glyphs (S, low); three-state outcomes (safe / creak penalty / collapse) (S, low); a per-level solve by bot simulation (try each candidate, settle, check), about 1k short sims (M, low compute at 1k).
- **Level seeds:** "Arch Stone" (a 60-block corbelled arch); "Redundant Wall" (a 300-block wall where 60% is removable but only in the right order); "Order Matters" (two halves that support each other: remove the left first or lose the right).
- **Risks:** Redundant support means many blocks are partly bearing, so "safe" is fuzzy. Numbers must be computed after each settle, not precomputed. The puzzle must be fair under the physics' own noise.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 3 / cost 3

### ST-15 Borrowed Height
- **Pitch:** [Hybrid: progression/roguelike] Each floor of a run, build a tower to a marker height using only blocks you pull from a donor ruin.
- **Fun hook:** Every block you take weakens the donor. Let the donor collapse and the rubble is still quarryable but scattered and slower, which costs turns. Between floors you pick relics that bend the rules.
- **Borrowed from:** Slay the Spire (map and relics); Balatro (escalating targets, modifiers); BREAKLINE from the concept panel (run structure) turned toward building.
- **Loop:** 30 s: two transfers (remove from donor, place on your tower). 5 min: a 6-floor run where targets climb and donors grow from 50 to 5k blocks. Example relics: Grip (a stronger pull), Iron Heart (one iron block), Level Bubble (shows tilt), Mortar (one weld, after joints step 7).
- **Scale story:** Scale is the progression. Early floors are 50-block ruins, late floors are 5-10k cities you strip-mine while keeping your own spire up.
- **Uses today:** `remove` plus `spawn` at rest (transfer); the settle gate; bbox height; crowns as optional bonuses; progress stored in the browser.
- **Needs new:** run and meta layer with relic choice (M, low); body transfer (S, low); relics as option toggles (S each; Mortar needs joints, L, med); a floor generator from scenarios (S-M, low).
- **Level seeds:** "Floor 1: Hut to Pillar" (50 blocks, 3 m); "Floor 4: Ruined Wall" (1k, 12 m); "Boss: Cathedral" (5k, 30 m, heritage glass must not move).
- **Risks:** Each transfer is slow to place, and over a long run that can feel like chores, so add stamps or multi-block transfers. Balancing a roguelike is a lot of work.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 2

### ST-16 Clean Drop
- **Pitch:** [Hybrid: destruction] Plan a controlled implosion: place timed charges that remove columns so a 10k building falls into its own footprint.
- **Fun hook:** It is the real demolition engineer's problem. Remove the core first, then the perimeter 0.3 s later, so the building folds inward. Get it wrong and it falls onto the heritage church next door. You plan in silence, then the countdown, the boom, and slow motion.
- **Borrowed from:** controlled demolition; Teardown (plan-and-execute heists); Angry Birds (stars); the existing footprint and heritage rules.
- **Loop:** 30 s: place 3 charges, set delays on a timeline, detonate. 5 min: iterate (deterministic replay makes every retry exact), until three stars: footprint clean, heritage untouched, fewest charges.
- **Scale story:** The key fact: plan-then-watch modes tolerate a simulation that is slower than real time. At 100k and about 30 ms per step, the drop just plays at half speed, which reads as deliberate slow motion. At 10k it plays live, and at 1k it is a quick tower.
- **Uses today:** WeaponSpec (timer triggers; remove and blast actions); footprint and heritage constraints; the collapse objective; dust and chips in `look=real`; deterministic replay.
- **Needs new:** a charge shell that rests on a body and, on a timer, removes a named target body, not itself (S, low); a delay timeline UI (S-M, low); step-paced slow-motion playback for 100k (S, low); tiered blasts for 100k (step 8, M, med).
- **Level seeds:** "Chimney" (a 1k brick stack, fall it into a slot); "Office Block" (S14 at 10k between two heritage neighbours); "Stadium Ring" (a 30k ring, plan-then-watch).
- **Risks:** Few interesting solutions on simple buildings. The building needs internal structure (cores, floors) for the plan to matter, which means new scenario builders.
- **Scores (1-5):** fun 5 / novelty 4 / engine fit 4 / cost 3

### ST-17 Atlas Ball
- **Pitch:** [Wild] Keep a tall block tower balanced on top of a giant ball by pushing the ball under it.
- **Fun hook:** It is an inverted pendulum. Taller towers react more slowly (the time constant grows as the square root of height), so stacking more is easier to balance but sheds more blocks when you slip. In the first 30 s you will lose a few blocks and then get the feel.
- **Borrowed from:** stick balancing on a palm; Super Monkey Ball / Ballance (ball control); circus plate spinning.
- **Loop:** 30 s: survive while blocks auto-drop onto the top every 3 s. 5 min: endurance, scored as time x blocks above the line.
- **Scale story:** At 1k the tower is about 10 m tall and relatively slow to control. At 10k it is a comedic whole city on a planet-sized ball. 100k: no.
- **Uses today:** spheres and boxes; `spawn`; watched bodies for tilt; a crown line.
- **Needs new:** sparse force on one body (the ball) from mouse drag (step 6, M, med); real-time physics (S, low); a tilt readout and bubble (S, low).
- **Level seeds:** "Plate on a Ball" (one plank and 10 cubes); "Totem" (a 40-block column on a rubber ball); "City on a Marble" (10k S4 on a 30 m sphere, novelty finale).
- **Risks:** Controllability with 1-2 frames of readback lag and mouse input is unproven. It could be impossible or trivial. The point contact of a sphere under a plank may jitter in AVBD.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 3 / cost 3

### ST-18 Deep Seam
- **Pitch:** [Wild, 100k] Tunnel into a 100k-block sleeping mesa to reach a gem, and prop up the roof before it caves in.
- **Fun hook:** Each remove is a dig. A cave-in is a spike in awake blocks that you see, hear (a stone rumble) and feel in the frame rate. You prop the roof with spawned pillars, and the deeper you go the heavier the roof.
- **Borrowed from:** Mr. Driller and Dig Dug (digging through falling blocks); Boulder Dash; Minecraft mining; Deep Rock Galactic (cave dread).
- **Loop:** 30 s: dig 6 blocks, place 1 prop. 5 min: reach one of 3 gems; stars for props left and rubble kept small.
- **Scale story:** This is the 100k mode by design. The mesa is mostly asleep and costs nothing, and only disturbed rock is awake. At 10k it is a hill (the training levels). At 1k there is no point.
- **Uses today:** `remove`; `spawn` for props; sleep and wake on impact; nMoving for cave-ins; stone material and grit sound.
- **Needs new:** sleep compaction and a persistent sleeper grid (L, med-high, planned E2); a cutaway or section render so the camera can see inside a block mass (M, med); a dig brush (S, low); a gem as a watched body with a reach predicate (S, low).
- **Level seeds:** "Hillside" (10k, one gem near the surface); "The Seam" (100k, a gem 20 blocks deep under a slab layer); "Ice Vein" (an ice layer, mu 0.05, slides into your tunnel).
- **Risks:** It depends on unfinished sleep work. A cascading cave-in could wake tens of thousands of blocks and drop to about 30 ms per step, so strong rock with high friction and a cap on cave-ins are needed. Cutaway rendering is new art work.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 2 / cost 2

### ST-19 Fulcrum Court
- **Pitch:** [Wild] Two 5k-block cities ride a 40 m seesaw. Players alternately remove blocks, and whoever ends a turn with the tilt past the limit loses.
- **Fun hook:** It is torque Nim. A block near the fulcrum barely matters (short lever arm), so it is a safe "pass" move, but those run out. Blocks near the ends swing the beam. Blocks that slide off on the low side shift the balance again.
- **Borrowed from:** Nim and other take-away games; pan-balance puzzles; Jenga (shared structure, alternate turns).
- **Loop:** 30 s: two turns, each with a remove, a settle and a tilt check. 5 min: a match of about 15 turns.
- **Scale story:** At 1k it is a small beam and an arithmetic duel. At 10k the cities make torque legible as a heatmap along the beam, and slides of whole blocks of houses become the drama. 100k: no.
- **Uses today:** `remove`; a watched plank for tilt; the settle gate; heritage (protected zones neither player may touch).
- **Needs new:** a hot-seat turn manager (S, low); a torque and tilt HUD (S, low); a robust long-beam-on-box fulcrum (no joints) (S-M, med-high: a 40 m plank carrying 10k bodies tests mass ratio and solver stiffness).
- **Level seeds:** "Village Scales" (2 x 500 blocks); "Uneven Twins" (one stone city, one plaster city with the fulcrum offset to match); "Grand Court" (2 x 5k).
- **Risks:** Solver stability of a long, heavily loaded plank on a box fulcrum is the big unknown. Strategy may collapse to "always pick the fulcrum block".
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 2 / cost 3

### ST-20 Resonance Pull
- **Pitch:** [Wild] The tower is an instrument. Tap and pull blocks to play the melody it calls, and keep it standing until the final crescendo.
- **Fun hook:** Each block's size and material sets its pitch. Call and response: the tower plays a phrase and you repeat it by tapping. Notes you get wrong cost blocks. The finale is a deliberate collapse that becomes a cymbal-crash crescendo.
- **Borrowed from:** Simon (call and response); Rhythm Heaven (timing); a marimba or xylophone; Jenga.
- **Loop:** 30 s: one four-note phrase, two taps and one pull. 5 min: a song of 8 phrases and a crescendo.
- **Scale story:** At 1k it is a marimba wall with a full scale. At 10k the collapse is texture, since only 8 voices plus the resonator bank are real voices. A 10k crescendo is gorgeous but not playable note by note.
- **Uses today:** the modal impact synth with per-material timbre; `blast` centred on a body with a tiny maxDv as a "tap" (exists); `remove`; quantised step timing (replayable).
- **Needs new:** pitch mapping by body dimensions so the tower is tuned to a scale (S, low); a beat clock tied to step indices (S, low); a phrase and judging UI (S-M, low).
- **Level seeds:** "Pentatonic Wall" (25 planks); "Iron Chimes" (a steel-and-stone tower with low drones); "Last Bar" (the tower must survive 7 phrases, then you pull the keystone on the downbeat).
- **Risks:** Audio latency in the browser plus physics step quantisation could ruin timing. It may be a toy, not a mode.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

### ST-21 Single Thread
- **Pitch:** A daily challenge: one 10k structure, one removal, scored on how much of it falls.
- **Fun hook:** Find the true keystone. Ten thousand candidates, one pull, a share card. The opposite daily, "Feather Thread", asks you to remove the heaviest block you dare without anything falling.
- **Borrowed from:** Wordle (one daily puzzle, a share card); hole-in-one challenges; Keystone's own leverage score.
- **Loop:** 30 s: study the X-ray, pick, watch. 5 min: no retry (it is daily), but a practice board unlocks after.
- **Scale story:** Scale is the search space. At 1k you can reason it out, and at 10k you need instinct plus the X-ray. At 100k (with sleep) the daily could be a mesa.
- **Uses today:** `remove`; the collapse (PE) reduction; scenario structures; deterministic replay on the device.
- **Needs new:** a daily seed generator (S, low); a share card (S, low); par scoring by an overnight bot search over the top roughly 200 X-ray candidates (M, low: brute force over all 10k is about 4 h of Mac GPU time).
- **Level seeds:** "Monday: Long Wall" (1k); "Wednesday: Leaning Column"; "Friday: B3 city".
- **Risks:** No cross-device determinism, so scores are not comparable across devices. Share the outcome as a screenshot or clip; a leaderboard is not trustworthy. A level could have one obvious answer.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 5

### ST-22 Corbel
- **Pitch:** Build a bridge with no joints across a gap, corbelling out from both banks with counterweights, then roll a bowling ball over it.
- **Fun hook:** It is the ancient arch problem. Each course reaches a little further and needs weight behind it. The halves meet in the middle on your final placement, then the test load rolls and you hold your breath.
- **Borrowed from:** bridge builders (build, then test run); Mycenaean corbelled arches; Kapla bridge-building.
- **Loop:** 30 s: place 6 blocks per side. 5 min: bridge a 4 m gap within a block budget and survive the test ball; stars for fewer blocks and a heavier test load.
- **Scale story:** At 1k it is a footbridge. At 10k it is a viaduct across a valley, placed by course stamps, monumental and photographic in `look=real`. 100k does not add anything.
- **Uses today:** `spawn` at rest; a gap as a kill zone (a predicate on position: anything that touches the ground in the gap fails); real projectiles (bowling ball, cannonball) as test loads; counterweight materials (iron).
- **Needs new:** a placement ghost with snap and overlap check (S, low); course stamps (S, low); a test-run sequence (S, low).
- **Level seeds:** "Brook" (a 2 m gap, 40 blocks, basketball test); "Gorge" (a 6 m gap, iron counterweights, bowling ball); "Viaduct" (a 30 m valley at 10k, cannonball convoy).
- **Risks:** Long cantilevers test solver stiffness and static friction. If AVBD creeps, bridges sag over time. The best design may be formulaic once found.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### ST-23 Libra Stack
- **Pitch:** A plank on a fulcrum: place blocks of different weights from a queue onto either side and keep it within tilt limits.
- **Fun hook:** Iron is 3x plaster and the next piece is iron. Put it near the fulcrum, or far out on the light side? It is a mental torque calculation with physics as the referee. Later levels stack a second beam on the first, like a Calder mobile.
- **Borrowed from:** pan-balance puzzles; Calder mobiles; balance-stacking casual games.
- **Loop:** 30 s: 5 placements. 5 min: a 30-piece queue; score is pieces placed, with a two-tier mobile in late levels.
- **Scale story:** Honest: a small mode (20-200 bodies). Scale shows up only in the finale, a raft-tower of 1k pieces.
- **Uses today:** `spawn` at rest; materials as weights; a watched plank for tilt; the settle gate.
- **Needs new:** a piece queue (S, low); a placement ghost (S, low); a tilt readout (S, low).
- **Level seeds:** "Plaster and Iron" (two weights); "Offset Pivot" (an off-centre fulcrum); "Mobile" (a plank on a plank on a fulcrum).
- **Risks:** It could feel like a casual phone game, with low spectacle. It shares a primitive with ST-19.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### ST-24 Plank Atelier
- **Pitch:** [Hybrid: sandbox] Free build with unlimited planks, pattern stamps and test buttons (quake, gust, marble, cannonball). Your build is a level file.
- **Fun hook:** Kapla without picking up 2,000 sticks. Stamp a spiral, a dome course or an arch, test it with a quake, and undo exactly, because deterministic replay makes undo exact: re-run the history minus the last event.
- **Borrowed from:** Kapla (the physical toy); Townscaper (effortless placement); Minecraft creative; Besiege (sandbox test harness).
- **Loop:** 30 s: stamp 5 courses, quake it. 5 min: a cathedral and a cinematic collapse captured as a replay.
- **Scale story:** Scale is the dream: 10k planks become cathedrals. Stamps are what make it possible to build at that size. With the sleep work, resting builds cost almost nothing.
- **Uses today:** Kapla planks; `spawn`; the scenario part system; every test weapon; replay; the viewer's switchable options.
- **Needs new:** a placement UX with stamps library and snap (M, med: ergonomics is the whole game); exact undo by replay truncation (S, low); save build as level (S, low); the gravity-vector quake (S, low).
- **Level seeds:** "Spiral Stair"; "Dome of 3,000"; "Kapla Hall Challenge" (match a silhouette).
- **Risks:** A sandbox without goals can drift. Placement UX in a browser at 10k scale is hard design work.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 4 / cost 2

### ST-25 Whisk
- **Pitch:** [Wild] The tablecloth trick: yank a slab out from under a stacked setup and see what stays standing.
- **Fun hook:** One flick, one bet. Too slow and friction drags everything off. Fast enough and the tower barely shivers. With slow motion and hit-stop on the start of the yank, it is pure spectacle and pure physics. You learn in three tries that speed beats friction.
- **Borrowed from:** the magician's tablecloth trick; flick-gesture games; "how much survives" scoring from Keystone's heritage idea.
- **Loop:** 30 s: one setup, one flick, a slow-motion replay. 5 min: a ladder of setups (a tower, marbles in cups, a 1k Kapla tower on a rug) with stars for blocks undisturbed.
- **Scale story:** At 1k it is a Kapla tower on a rug. At 10k it is a banquet: a whole city on a sheet, which shudders, sways and maybe holds, and is spectacular. 100k: slow-motion only.
- **Uses today:** possible today without step 6: `remove` the resting slab and `spawn` an identical slab at the same pose with a high velocity. That gives an instant yank from existing events, though the warm-start contact cache is lost on that frame. At 10 m/s the slab moves about 0.17 m per step at 60 Hz, well under the roughly 1 m/step limit on finding contacts. Also ice and rubber materials (easy and hard modes), the displacement ink and hit-stop.
- **Needs new:** a flick-gesture-to-velocity input (S, low); a body-transfer helper with a velocity (S, low); sparse force step 6 for a realistic accelerating pull, optional (M, med); a "cloth" look on a thin box (S, low).
- **Level seeds:** "Dinner for One" (5 cups as hollow box towers, 5 marbles); "Kapla on a Rug" (a 1k spire); "Banquet" (a 10k city on a 60 m sheet).
- **Risks:** Thin slabs with fast sliding contacts could jitter, and the solver's static-friction behaviour decides whether the trick is learnable. It is a few minutes of fun, not hours.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 5

---

## Capability primitives this lens keeps needing

| Primitive | Effort / risk | Needed by |
|---|---|---|
| **Placement**: a ghost from a face pick, surface snap, rotate, overlap check, `spawn` at rest | S-M / low | ST-1, 3, 4, 6, 7, 10, 11, 15, 18, 19, 22, 23, 24 |
| **`pull` rack item** (`remove` on click) plus a leverage fix for 0 J actions | S / low | ST-2, 7, 8, 9, 12, 13, 14, 15, 18, 19, 21 |
| **Settle gate** (nMoving = 0 or timeout) as a turn boundary | S / low (mostly exists) | every turn-based idea |
| **Hot-seat turn manager** | S / low | ST-1, 7, 9, 19 |
| **Body transfer** (remove, then respawn the same dims and material elsewhere or with velocity) | S / low | ST-9, 15, 25 |
| **Course / pattern stamps** (place a row or course in one action) | S-M / low | ST-3, 10, 15, 22, 24 |
| **Time-varying gravity vector** from a quantised schedule, plus wake-all | S / low | ST-4, 6, 24 (and a cheap ST-5 fallback) |
| **Real-time play** (physics runs while acting; a shell mode switch) | S / low | ST-1, 6, 11, 17, 25 |
| **Per-body load from AVBD contact lambda** (load X-ray, histogram, probe numbers) | M / med | ST-2, 7, 14, 19, 21 (soft for 4) |
| **Sparse force step 6** with a force cap, plus a **GPU-side spring-to-target** grab | M (+S) / med | ST-1, 12, 17 (optional 25, 24) |
| **Sleep compaction and persistent sleeper grid** (planned E2) | L / med-high | ST-2 (100k), 13, 18, 21 (100k) |
| **Plan-then-watch slow motion** (step-paced playback, so sims slower than real time read as intended) | S / low | ST-16, 4 (100k), 21 |
| **WeaponSpec action that removes a named target body** (an attached charge) | S / low | ST-16 |
| **Friction-slip and granular audio voices** (creak by sliding speed; rattle texture beyond 8 voices) | M / low | ST-1, 12, 25 |
| **Exposure-aware wind field** | M-L / med | ST-5 |
| **Cutaway / section render** | M / med | ST-18 (and helps ST-2) |
| **Bot policies for place and remove** (star casting for building modes) | M-L / med | ST-1, 3, 7, 9, 14, 22 |

Cross-cutting insight: **plan-then-watch modes (ST-16, ST-4 retrofit, ST-21) are where 100k becomes playable before 100k runs in real time**, because slow motion is the intended presentation.

## My top 5 and why

1. **ST-8 Sapper.** It is the cheapest mode in the lens: one rack item and a leverage fix inside the existing Keystone shell, star casting and objectives. It turns "pulling is the weapon" into aimed collapses, which is exactly the spectacle Will responds to.
2. **ST-16 Clean Drop.** It makes destruction a craft (timing, footprint, heritage). It mostly reuses WeaponSpec. Plan-then-watch makes 10k live and 100k a legitimate slow-motion finale.
3. **ST-22 Corbel.** It is pure stacking with no joints, which turns the engine's lack of joints into the theme. It has a test-run payoff with the real projectiles and monumental 10k viaducts in `look=real`. The engine fit is excellent.
4. **ST-4 Aftershock Architect.** The gravity-vector trick gives exact earthquakes for an S-sized change. The 10k twist, retrofitting an existing city with 200 blocks, makes scale meaningful.
5. **ST-1 Hollow Tower.** The heart of the lens and the reason to build sparse force step 6. The held pull with a friction drag is the one mechanic nothing else gives, and it doubles as hot-seat party play.

Wildcard pick: **ST-25 Whisk.** It is buildable today with remove plus respawn, it is a cheap one-flick slow-motion spectacle, and "a 10k city on a tablecloth" is a strong screenshot.
