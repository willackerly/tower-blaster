# PUZZLE lens: 24 game-mode ideas (prefix PZ)

What every idea here assumes: collapse is chaotic and the GPU is deterministic per device only. Each idea says where it lives on the robustness axis:
- **Small-scale exact.** Under about 500 bodies, using behaviours the probe measured as robust (shear B2, pick-off B3, lintel B4, lever B5, dominoes B6). Not column drop B1, which is 0% robust.
- **Wide-basin.** The goal is a coarse predicate, such as "crowns below the line", that a whole family of shots satisfies.
- **Distribution-scored.** The goal is a statistic over hundreds or thousands of bodies (histograms, fractions, overlap with a target). It stays stable even when individual bodies are chaotic, so it is the natural fit at 10k and above.
- **Same-device exact.** The puzzle is generated and checked on the player's own device, so per-device determinism is enough.

"Bot-cast" means the ★★/★★★ thresholds come from the existing bot pipeline on outcome distributions.

---

### PZ-1 Sounding Line
- **Pitch:** A 10k-block structure hides 1-3 true keystones among hundreds of decoys; you have 5 X-ray "soundings" to find them before your single shot.
- **Fun hook:** Each sounding reveals load threads only inside a sphere about 3 m across. Do you spend them sweeping the base, or chase a hunch up a buttress? Within 30 s you have dropped two soundings, seen a load thread bend toward something interesting, and you feel like a detective, not a gambler.
- **Borrowed from:** Minesweeper and Battleship (spend probes to shrink a hidden space), the sonar pings in submarine games, and the hidden load path of real structural surveying.
- **Loop:** 30 s: orbit, place a sounding, read the amber threads, place another. 5 min: 3-4 attempts on a level, learning the architect's "tells" (keystones sit where threads converge under a slab). The par is the soundings used plus shots.
- **Scale story:** At 1k a sounding covers a quarter of the structure, so it is a warm-up. At 10k this is the point: about 300 load-bearing elements, of which only 2 matter, and the X-ray becomes the economy. At 100k you move to district-sized soundings (coarser and cheaper) and a second tier of fine ones, a two-resolution search.
- **Uses today:** The designed load X-ray tint, crowns and skyline objectives, rubble that persists, the bot (to verify that the keystone shot clears and a decoy shot doesn't), sleep (a wrong shot wakes little).
- **Needs new:** Per-body carried load (contact-force accumulation read back sparsely, or estimated from the static graph at level load): M, med. Sphere-masked X-ray rendering: S, low. Level generator that plants keystones and decoys: M, med.
- **Level seeds:** (1) "Twin Halls": two identical-looking halls, and only one roof bears on a central plank. (2) "Cathedral Undercroft": a 10k nave, with the keystone a single slab under the crossing that is invisible from outside. (3) "False Buttress": 6 flying buttresses, 5 of them decorative (zero load), 1 carrying the vault.
- **Risks:** This is wide-basin. Keystone shots must be robust (a shear or pick-off), which the bot verifies. Loose-lattice columns are independent (findings §3), so "keystones" exist only where slabs or planks couple columns, and the level grammar must lean on slabs. The load estimate may look noisy because AVBD contact forces jitter, so display smoothed values.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### PZ-2 Assay
- **Pitch:** A mixed-material heap (ice, rubber, iron, plaster) must be separated into marked bins using only shots, with materials sorting themselves by friction and bounce.
- **Fun hook:** The same blast throws rubber far, slides ice farther still, and barely moves iron. You are designing a sieve out of impulses. The first shot sends ice skating into the left bin and you get it at once: materials are the tool.
- **Borrowed from:** Ball-sort and colour-sort puzzles (the goal state), mining ore separation (froth flotation, jigging), and the Lemmings-style "steer a population, not an individual".
- **Loop:** 30 s: one blast, watch the coloured streams fan out, check the bin purity bars. 5 min: a 4-shot rack, with each shot cleaning up what the last left behind; chase purity × recovery.
- **Scale story:** At 1k there are visible streams and you can follow individuals. At 10k the heap is a granular medium and the result is a statistic (82% of ice in bin A), so scoring is stable despite chaos. At 100k you get a "tailings" level where sleeping mounds wake only near the action.
- **Uses today:** Materials (ice mu 0.05, rubber e 0.6, iron, plaster), blast, the weapons, region-predicate histograms, footprint-style zones, bot-cast stars.
- **Needs new:** Bin zones drawn on the ground plus per-material, per-zone count reductions: S, low (histogram keyed by material × zone). Low walls for the bins (heavy iron slabs work today; a static flag is better): S, low.
- **Level seeds:** (1) "Skate Park": an ice/plaster mix and one bin far downrange; only ice should reach it. (2) "Bounce House": rubber goes to a raised tray behind a low wall, everything else stays. (3) "Three-Way": ice, rubber and iron go to three bins, with only cannonballs and one grenade.
- **Risks:** Distribution-scored, so it is robust by design. Material contrast must be large enough to read: if mu-min friction makes ice-on-plaster dominate, rubber vs plaster may look the same. The "puzzle" could collapse into "aim the biggest blast at the centre", so rack limits and bin geometry must punish that.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### PZ-3 Shadowfall
- **Pitch:** A low sun casts the structure's shadow on a screen wall; shoot until the rubble's shadow matches a target silhouette (a cat, a key, a letter).
- **Fun hook:** Destruction becomes sculpture with an instant readable score: a live overlap meter as the shadow shifts. The first shot knocks off a "tail" and the cat appears.
- **Borrowed from:** Shadow-projection puzzle games (rotate an object until its shadow forms a picture) and Tetris-style "hole in the wall" target outlines.
- **Loop:** 30 s: read the shadow, find the excess, fire, and watch the overlap meter tick. 5 min: a rack of 3-5, where the last shot is a delicate marble trim; three stars for overlap above the bot-cast thresholds.
- **Scale story:** At 1k the silhouettes are chunky pixel art. At 10k the projection is fine-grained, rubble heaps form soft curves, and gradient silhouettes (dunes, a skyline) become possible. At 100k a city's shadow becomes a portrait, with daily themes.
- **Uses today:** Histogram reductions (a 2D occupancy grid of the projected positions), PCSS shadows in look=real, ink tint, bot-cast stars.
- **Needs new:** A projection-occupancy reduction (bin bodies by projected position, compare to a target bitmap with IoU): S-M, low. Target authoring: get the silhouette by simulating a "designer shot" so it is reachable: S, low. A screen-wall prop (heavy slab or static): S.
- **Level seeds:** (1) "Keyhole": a solid wall whose shadow must become a keyhole (punch the centre, keep the shoulders). (2) "Sunset Skyline": a 10k city whose shadow must match a skyline with exactly two towers. (3) "Rabbit": a Kapla tower where the ears must survive.
- **Risks:** Distribution-scored and robust. Projection loses depth, so players may feel the scoring is unfair when a hidden block counts; show the occupancy grid on hover. The shapes are limited to what rubble can reach, which the designer-shot authoring solves.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### PZ-4 Aftermath
- **Pitch:** A reverse puzzle: you are shown the rubble (and the heatmap) left by a hidden shot; recreate the shot.
- **Fun hook:** It is forensics. A spray of blue ink fanning left at course 4 says "low, from the right, heavy". You read evidence, form a hypothesis, test it, and the overlap score tells you how close you are.
- **Borrowed from:** Deduction from aftermath in detective games (reconstruct what happened from the scene), golf "read the green", and the ballistics reconstruction in crime procedurals.
- **Loop:** 30 s: study the scene, ghost silhouette and displacement heatmap; fire a guess; compare (an overlay shows hits, misses and extras). 5 min: converge in 3-6 guesses. A perfect match is possible because the target was simulated on your own device.
- **Scale story:** At 100-500 bodies the shot space is quantised and finite, and an exact match is achievable. At 1k-10k score on heatmap correlation, because many shots give similar fields. At 100k this becomes "which of these 3 charges went off first?" (order deduction in an implosion).
- **Uses today:** Same-device determinism (the hidden shot simulated at load), quantised shots, the displacement heatmap, ink, replay. Reductions for comparison.
- **Needs new:** Generating the hidden shot on device from a seed, plus a distance metric (per-body displacement field, or binned for scale): S-M, low. A "how warm" feedback UI: S.
- **Level seeds:** (1) "Cue Ball": one marble into a 3×3×6 tower; find yaw and course. (2) "Two Shooters": two shots, with the order and ammo to identify. (3) "Cold Case City": a 10k block district; a grenade went off somewhere; locate it within 1 m.
- **Risks:** Same-device exact, which is the cleanest fit in the lens. Many-to-one: different shots give near-identical rubble, so score by field similarity, not by matching shot parameters. Fun depends on the feedback curve being smooth, and chaos may make it jagged; the bot measures the smoothness of the score landscape per level.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 5 / cost 4

### PZ-5 Hollowing (stacking/Jenga hybrid)
- **Pitch:** Remove as many blocks as you can from a tower while the gold capstone stays above the line, and every removal is permanent.
- **Fun hook:** It is Jenga in reverse with total information: each removal is a bet on the load path, and greed is the enemy. "One more" is the whole game.
- **Borrowed from:** Jenga (incremental extraction under risk), push-your-luck dice games (bank or bust), and the cut-the-rope style "remove supports" puzzles.
- **Loop:** 30 s: X-ray, pick a block, remove (it vanishes), and the physics settles for 2 s. Survive and the counter climbs. 5 min: a full run to collapse or bank, then retry with the learned order.
- **Scale story:** At 500 it is a precise puzzle with a known max, which the bot finds. At 10k you remove regions (paint 50 cubes and remove them in one event), and arches emerge by themselves. At 100k it is a city where you hollow buildings and score total mass removed, with sleep keeping it cheap.
- **Uses today:** The `remove` event, crowns/skyline, the X-ray, bank, heritage-like "capstone must not move".
- **Needs new:** Multi-select removal (brush) as one event: S, low. A settle-and-verify window between removals: S. Optional "finger" push variant from sparse forces (step 6): M (already planned).
- **Level seeds:** (1) "Kapla Spire": a plank tower where you remove planks, not cubes, and interlocking layers make it deep. (2) "Arch Maker": a solid 20×10 wall; the best score leaves a perfect arch. (3) "Skeleton": a 10k office block where you keep the roof garden up with as little mass as possible.
- **Risks:** Small-scale exact at low N, distribution-scored (mass removed) at high N. Loose-lattice cubes rest on the cube below, so removal drops the column (B1 fails: the column topples), and most removals simply fell something. Levels need slabs, planks and lintels to make arches possible. Interlocked plank towers (Kapla) are the sweet spot.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### PZ-6 Bulwark
- **Pitch:** A scripted wrecking shot will fire in 10 seconds; place 3 blocks (sandbags, a wedge, an iron slab) so the blue heritage house survives.
- **Fun hook:** You can see the shot's arc and the doomed house. Do you block the ball, deflect it, or sacrifice the tower next door so its rubble shields the house? Defence, not offence, with a crisp pass/fail.
- **Borrowed from:** Place-parts-then-run contraption puzzles (place pieces, press play) and tower-defence pre-wave placement.
- **Loop:** 30 s: preview the scripted shot (ghost replay of the unprotected outcome), place 2 blocks, run; the house loses a wall. Move one block and rerun. 5 min: a 3-block budget, with stars for fewer blocks or lighter materials.
- **Scale story:** At 1k it is a single shot and a single house. At 10k a scripted cluster bomb hits a city and you protect 3 heritage buildings with 6 blocks; the rubble of what you don't protect matters. At 100k there are scripted multi-stage collapses (a tower falling across a district) and you choose where the fall line goes.
- **Uses today:** Spawn-at-rest (placing blocks), scripted weapons (WeaponSpec), heritage, replay ghost.
- **Needs new:** Placement UI with snapping, overlap rejection and a pre-settle check: M, low. A scripted-shot runner (the shot is level data): S.
- **Level seeds:** (1) "Shelter": a cannonball at a cottage; a single iron slab placed right saves it. (2) "Deflector": a wedge, an ice ramp that sends the ball up and over. (3) "Firebreak": a 5k district; a tower falls, and you place 4 blocks to shape the debris away from the chapel.
- **Risks:** Wide-basin when the blocks intercept the ball directly. Fragile when they rely on rubble shielding, so the bot must measure the basin over the placement nudge grid. It risks feeling static unless the scripted shot is spectacular.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 3

### PZ-7 Fallgate (domino hybrid)
- **Pitch:** Logic circuits built from toppling dominoes and planks; place the missing pieces so pushing input A or B (but not both) topples the bell tower.
- **Fun hook:** Physical logic is magical: an OR gate is a fork, an AND gate is two chains that must arrive together to tip a heavy slab. The first time your XOR fires correctly you feel like an engineer.
- **Borrowed from:** Domino computers (gates from domino geometry), Zachtronics-style circuit puzzles (fixed spec, open design), and the logic gates of mechanical marble computers.
- **Loop:** 30 s: read the spec (truth table), place 3 dominoes, press "test all inputs". 5 min: the level runs its truth table (all input combinations simulated) and every row must pass. Score on pieces used.
- **Scale story:** At 1k: gates and half-adders. At 10k: a 4-bit adder field where you fix bugs (spot the miswired gate) instead of building from scratch. At 100k: a city-sized domino computer that runs a calculation as spectacle, cheap only thanks to sleep.
- **Uses today:** Dominoes (B6 robust 100%), spawn-at-rest placement, the cue verb (push the input), observers (watched bodies as outputs), sleep.
- **Needs new:** Placement UI: M, low (shared with PZ-6). Truth-table runner: multiple simulations per level, possibly side-by-side copies (PZ-17): S-M, low. A gate-piece library (pivot slabs for AND): M, med, since AND gates need a heavy slab that one chain can't tip, and that threshold is chaotic.
- **Level seeds:** (1) "Fork": make both bells ring from one push. (2) "Both Keys": an AND gate, where the vault door falls only if both chains arrive. (3) "Bit Flip": a 10k adder with one wrong gate; find it from the outputs.
- **Risks:** OR, fan-out and delay are robust because dominoes are reliable (B6). AND and NOT gates are the risky parts: they need thresholds and inhibitors, and with no joints or static bodies, inhibitor gates (one chain blocking another) are fragile. NOT may be impossible without kinematics.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### PZ-8 Six Stones (daily)
- **Pitch:** A daily structure with 8 marked stones and a hidden target set of 3; you get 6 shots (with reset), and after each the stones light green (fell, and in the set), amber (fell, not in the set) or grey (stood).
- **Fun hook:** Word-guessing deduction meets physics. You must design shots that test hypotheses ("if I shear the left half, I learn about stones 1-4"), not just smash. The shareable grid is the hook.
- **Borrowed from:** Daily word-guess games (6 tries, coloured feedback, a share grid) and Mastermind (design informative probes).
- **Loop:** 30 s: fire a probe and read the colours. 5 min: the full daily, 6 shots, then a shareable emoji grid (results, not replays, so no cross-device issue).
- **Scale story:** At 500 the stones are individually targetable. At 10k "stones" become districts (8 coloured zones) and the probe is a weapon whose effect spans zones. At 100k the scale is spectacle only; keep the daily at 1-10k so it loads fast.
- **Uses today:** Crowns objective (per-stone fell or stood), retry/reset, rubble reset, weapons.
- **Needs new:** Daily seed plus server-free generation (date seed, on-device validation): S-M, low. Feedback UI and share grid: S, low. The final shot must fell exactly the set, which the on-device bot validates: M, med (casting cost on a phone).
- **Level seeds:** (1) "Ring of Eight": stones around a pagoda. (2) "Stacked Deck": stones in a column, with order deduction. (3) "Bridge Day": stones on a lintel bridge, where some fall only with their neighbours.
- **Risks:** Wide-basin per stone (fell or stood is coarse). The challenge is the final "exactly these 3" shot: it must exist and be robust, otherwise deduction is useless, so the daily must be bot-verified. Can't be identical across devices, so a share grid compares deduction, not physics.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### PZ-9 False Weight
- **Pitch:** Twelve identical-looking blocks, one secretly iron; find it with a seesaw (a slab on a pier) in three weighings.
- **Fun hook:** The classic counterfeit-coin puzzle, made physical: you load blocks on the slab ends and watch it tip. Then it scales into structures where hidden densities change the load path: "which pillar is lead?"
- **Borrowed from:** The 12-coin balance puzzle, Mastermind, and the "weigh to deduce" scales in point-and-click adventures.
- **Loop:** 30 s: pick up 4 blocks, place them on each end, watch the tip (or balance). 5 min: three weighings, then accuse; later levels add "the fake is lighter or heavier" and multiple fakes.
- **Scale story:** At small scale it is pure logic. At 1k a structure with hidden-density blocks becomes a demolition puzzle: the heavy block is the keystone, so find it by tapping (light shots barely move it) and use it. 10k+ adds little; keep it at 50-1k.
- **Uses today:** Lever behaviour (B5/B6 robust), materials (iron vs plaster), spawn-at-rest, remove.
- **Needs new:** "Pick up / place" verb (remove + respawn with hidden material): S, low. Hidden-material rendering (all blocks rendered as plaster): S, low. A pivot that holds (a static pier, or a heavy pier, which works today): S.
- **Level seeds:** (1) "The Coiner": 9 blocks, 2 weighings. (2) "Lead Pillar": 6 pillars hold a roof, one is iron; fell the roof with one marble (only works if you hit a plaster pillar). (3) "Balance of Power": two fakes, one heavy and one light.
- **Risks:** Small-scale exact: tipping a slab under a 4-vs-4 load with one iron block (density about 3× plaster) is robust. Equal loads must balance, but a seesaw at exact balance is chaotic, so design the puzzle so balance never needs to be read (the 3-way balance becomes left, right or "rests on stops"). It is niche and cerebral, a world rather than a mode.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 4

### PZ-10 Hollow Ring (wild)
- **Pitch:** Find the void or the keystone by sound: tap the structure with tiny marbles; the modal synth rings differently over a hollow or a heavily loaded block.
- **Fun hook:** You play blind and listen, like knocking on a wall to find a stud. A dull thunk versus a bright ring, then the "aha" when the hollow one collapses.
- **Borrowed from:** Echolocation games (navigate by sound), the tap-to-find-studs DIY reflex, and audio-only puzzle games.
- **Loop:** 30 s: tap 4 spots, hear the timbres, mark candidates on the map. 5 min: 10 taps and one real shot; scoring on taps used. Accessibility variant: visual-free mode.
- **Scale story:** At 500 every block has a voice. At 10k the taps return a reverberant cluster (the resonator bank as a neighbourhood response) that tells you about the load nearby. At 100k: listen for rumbling in a waking city to know where the collapse front is.
- **Uses today:** Modal impact synth with per-material timbre and resonator bank, the marble, crowns.
- **Needs new:** Mapping per-body load or contact count to synth parameters (stiffness to pitch, damping): M, med. Load estimate (shared with PZ-1): M, med. A fog/blind render mode: S.
- **Level seeds:** (1) "Hidden Room": a solid wall with one void; find it in 5 taps. (2) "Iron in the Wall": the heavy block rings low. (3) "Stressed": the block bearing the most load rings tightest.
- **Risks:** Taps at low energy are gentle and repeatable, so small-scale exact. Audio deduction may be too subtle for most players and hard to tune across speakers and headphones; pair it with a visible waveform. It works as a world mechanic more than a mode.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 3 / cost 3

### PZ-11 Quincunx
- **Pitch:** Drop 2,000 beads through a peg field; remove up to 6 pegs so the beads' landing histogram matches a target shape (bimodal, skewed, flat).
- **Fun hook:** Chaos is the material: no single bead is predictable but the distribution is. You shape probability. Removing one peg makes a visible notch in the bell curve.
- **Borrowed from:** Galton boards and pachinko (the peg cascade), Peggle (peg removal as the reward), and histogram-matching "make the shape" puzzles.
- **Loop:** 30 s: pull a peg, release the beads, and the histogram fills live while a KL meter ticks. 5 min: iterate on pegs (rewind is instant, same-device deterministic) to hit three stars.
- **Scale story:** At 1k beads the histogram is noisy and luck shows. At 10k the curve is smooth and scoring is fair, which is the point. At 100k beads it is a sand-art spectacle that needs sleep (beads settle into bins and sleep).
- **Uses today:** Sphere spawn in bulk, histogram reductions, sleep, materials (rubber beads for bounce), bot-cast thresholds.
- **Needs new:** Static/anchored bodies for pegs and bin walls (the planned static flag): M, low. Target-histogram compare: S. Batch-spawn emitter (spawn N per step): S.
- **Level seeds:** (1) "Two Hills": make a bimodal distribution with 2 pegs. (2) "Lean Left": skew 70/30 with ice pegs that change the bounce. (3) "Flatline": a uniform distribution, which needs 6 pegs.
- **Risks:** Distribution-scored and robust by construction. Without a static flag, pegs must be very heavy and will still drift, so this mode waits on that flag. Bead-bead granular jams at 10k could make outcomes depend on clumping. More toy than puzzle unless targets are hard.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 3 / cost 3

### PZ-12 Plumbline (gravity nonogram)
- **Pitch:** A 10×10×10 block with row and column clues tells you how many cubes belong to a hidden sculpture; remove the rest, but gravity acts, so removal order matters.
- **Fun hook:** Nonogram logic plus a physical consequence: remove a cube under one you need and it falls. You solve the logic, then plan the excavation order. Both halves click.
- **Borrowed from:** 3D nonograms (chip cubes using numeric row clues) and Mahjong solitaire (only free pieces can be taken).
- **Loop:** 30 s: read clues, mark cubes "keep" or "remove", remove a safe one. 5 min: finish a 1,000-cube puzzle; stars for no mistakes and no fallen keepers.
- **Scale story:** 1k is the natural size (10³). 10k (22³) is too big for hand logic but works with "chunk" clues. 100k doesn't fit the mode.
- **Uses today:** `remove` event, cube lattices, crowns/heritage (keepers must not move).
- **Needs new:** Clue generation and validity (unique solution + physically removable order): M, med. Clue overlay UI on the lattice: M, low. Tolerance: a keeper with nothing underneath falls, so the sculpture must be self-supporting; the generator must check this.
- **Level seeds:** (1) "Chair": an overhang-free shape, pure logic. (2) "Arch": the keystone must go last or everything above falls. (3) "Bird": an overhang, where you must leave scaffolding and then shoot it out at the end.
- **Risks:** Mostly logic; physics only bites on unsupported keepers, which fall (robustly bad). Small-scale exact as long as removals don't jostle neighbours (removal is instantaneous, so it is fine). The risk: the physics is barely necessary. Mitigate with the final "shoot out the scaffold" shot.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 3

### PZ-13 Half Measures
- **Pitch:** Release exactly 40% of the tower's potential energy, ±3%. Not more.
- **Fun hook:** Restraint is harder than destruction. The live PE gauge climbs during the collapse and you pray it stops in the band; a second, gentler shot tops it up. Goldilocks demolition.
- **Borrowed from:** Golf putting (distance control), "closest to the pin" target games, and the push-your-luck band of the blackjack bust rule.
- **Loop:** 30 s: fire, watch the gauge, land at 34%, top up with a marble. 5 min: 3-5 levels with shrinking bands; the bot sets band width from its outcome spread so the band is fair per level.
- **Scale story:** At 1k the PE jumps in chunks (one column = 3%), so it is a puzzle of granularity. At 10k the PE is near-continuous and reads as a smooth dial, with the bands tight. At 100k, "take exactly the top 10 floors off the skyscraper".
- **Uses today:** Collapse objective (PE fraction), PE reduction, rack, bank, bot-cast stars.
- **Needs new:** Upper-bound objective (band, not threshold): S, low. Gauge UI with the band marked: S.
- **Level seeds:** (1) "Haircut": take 20% off a 1k wall, which only a high shear achieves. (2) "Two Thirds": 66% of a Kapla tower. (3) "Exactly Half a City": 50% of 10k across 4 buildings.
- **Risks:** Distribution-scored, so robust with bot-cast bands. It risks feeling like a slot machine if the bands are narrower than the outcome spread of the best line; the bot gate must enforce that the best line hits the band in ≥80% of nudges. It is cheap and adds a reusable objective type.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 5

### PZ-14 Gold Run
- **Pitch:** A golden marble rests on the top of a structure; collapse the structure so the marble rides the rubble into a goal ring.
- **Fun hook:** You don't hit the payload, you move the ground under it. Watching the gold marble surf a landslide into the ring is a cheer moment.
- **Borrowed from:** Cut-the-Rope style "deliver the payload" puzzles and marble-run games.
- **Loop:** 30 s: plan the fall direction, shoot the leeward base, watch the ride. 5 min: 3-4 attempts; stars for ring precision, fewer shots and leverage.
- **Scale story:** At 1k it rides a short tumble. At 10k it rides a city-block slump into a plaza, a 6-8 s ride with the camera on player input only (offer opt-in follow). At 100k there is a 25 s multi-stage ride across a district: a set-piece.
- **Uses today:** Watched bodies (the gold marble), zones, spawn, bot-cast ring size, sleep.
- **Needs new:** Goal ring zone predicate on a watched body: S, low. An opt-in follow camera for the payload: S, low.
- **Level seeds:** (1) "Leaning Column": the marble on top of the leaning column, ring 5 m out. (2) "Kapla Slide": a plank tower, so the planks act as a chute. (3) "Downtown Express": 10k, the marble on a roof, ring in the park.
- **Risks:** Wide-basin only if the ring is large: the marble path is chaotic (it bounces off rubble). The bot must cast ring radius from the outcome distribution, which may make rings big and the goal feel loose. Rubber marble = more chaos; use steel.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 4

### PZ-15 Fortify (competitive hybrid)
- **Pitch:** Hot-seat: player A builds a structure with a 60-block budget around their crown; player B gets 2 shots to fell it; swap roles; the best margin wins.
- **Fun hook:** Every building choice is a prediction of the opponent's shot. The builder's smug face at a perfect wedge deflection is the hook, and the rematch is immediate.
- **Borrowed from:** Hot-seat artillery games (alternating turns on one device), and the build-then-defend of physics bridge builders and castle-defence sandbox games.
- **Loop:** 30 s: snap a few slabs and an iron counterweight. 5 min: two rounds (build 2 min, attack 1 min each), and the scoreboard shows crowns remaining.
- **Scale story:** At 60-500 blocks it is a duel. At 10k "budget" becomes a palette of prefabs (walls, towers, keeps) placed on a city lot; a cluster bomb against a citadel. 100k is not needed.
- **Uses today:** Same-device determinism (hot-seat is fair because it's one device), spawn-at-rest, crowns, rack, replay.
- **Needs new:** Placement and build UI with a budget: M, low (shared). The at-rest validity test on the built structure (it must stand before the shot; it exists as a design for levels): S. Optional prefabs: M.
- **Level seeds:** (1) "Pillbox": 30 blocks, one marble shot. (2) "Ice Moat": the builder gets 10 ice blocks to make the attacker's balls skate. (3) "Citadel": 2k-block prefab castle against a cluster bomb.
- **Risks:** Small-scale exact on one device, so it is fair. Builders may find degenerate fortresses (bury the crown in a solid cube) unless the budget and a "visibility" rule (the crown must be visible from the launcher ring) limit them. Needs two players on one screen, which limits reach.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 3

### PZ-16 Fusecraft
- **Pitch:** Program the munition: assemble a WeaponSpec from trigger and action tiles to reach crowns behind a heritage wall that no plain shot can touch.
- **Fun hook:** "Fly over the wall, split at apex into 3, each detonates on proximity to a red block" is a little program, and watching it run is delight. You're judged on a cost histogram, like an optimisation puzzle.
- **Borrowed from:** Zachtronics open-solution optimisation (cost, cycles and area histograms against everyone else's solutions) and programmable-weapon tile systems from games where you assemble spells or wand modifiers.
- **Loop:** 30 s: drag "after 1.2 s" → "split ×3" → "near body" → "blast S", fire, and see one bomblet miss. 5 min: iterate until clean, then optimise for fewer tiles or less energy. Your score lands on your own histogram of past solutions.
- **Scale story:** At 1k it is a precise surgical munition. At 10k one well-programmed shell (a depth-3 split) is a precision demolition of a district, versus brute XL. At 100k it is the tiered blasts (planned step 8) with a big payoff.
- **Uses today:** WeaponSpec is pure data, with its triggers (time, near body, apex, then, any), actions (blast, remove, split, depth ≤ 3) and sizes. The rack, heritage and leverage all exist. This is the best engine fit in the lens.
- **Needs new:** A visual tile editor for WeaponSpec with live arc preview of the shell and its children: M, low. Cost metric (tiles + blast energy): S. Optional relative spawn (step 5) for more tiles: planned.
- **Level seeds:** (1) "Over the Top": crowns behind a heritage wall; split at apex. (2) "Pick the Lock": a single red block inside a blue shell, using "near body (red)" + "remove". (3) "Clean Sweep": 6 crowns scattered across a 10k city, one shell, depth 3.
- **Risks:** Wide-basin: rule-based munitions trigger on predicates (near body), which are forgiving. The danger is UI complexity that turns players away; start with 2-tile programs and grow. Children of splits fly chaotically, which is fine because the predicates retarget.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 5 / cost 4

### PZ-17 Chorus (wild)
- **Pitch:** Your one shot is fired into 64 copies of the level at once, each jittered by a hair. Your score is how many of the 64 you solve.
- **Fun hook:** It turns the engine's biggest weakness, chaos, into the puzzle. You see a grid of 64 tiny worlds (or one world with 63 translucent ghosts) and the moment one shot clears 61/64 you understand what "robust" means. Players hunt for the wide basin, as the bot does.
- **Borrowed from:** Many-worlds puzzle games that show parallel outcomes, "spot the robust strategy" of tournament poker, and the split-screen spectacle of racing replays.
- **Loop:** 30 s: aim, fire, and watch 64 worlds collapse in parallel; the tally reads 23/64. Nudge the shot and fire again. 5 min: climb from 23 to 58 by learning which shots are robust (low, central, heavy) and which are lucky.
- **Scale story:** At 100 blocks × 64 = 6.4k bodies it runs in real time today. At 1k × 64 = 64k it is slower than real time, so use a playback after compute. At 10k it only works with 8 worlds. The scale is the copies, not the structure.
- **Uses today:** GPU throughput (10k bodies real time), spawn (64 shot events per shot are just data), histogram reductions (keyed by world, with world identified by x offset), sleep (failed worlds settle and sleep), the bot's exact concept of a nudge grid.
- **Needs new:** Level instancing on a grid with world offsets and per-world jitter: S, low. Per-world segmented reductions: S-M, low. A 64-thumbnail render or ghost overlay: M, med (draw cost of 64 × 100 instances is trivial, layout is the work).
- **Level seeds:** (1) "Lucky Shot": a level where the obvious shot is 20/64 and the robust one is 64/64. (2) "Butterfly": a leaning column so twitchy that 32/64 is three stars. (3) "Choir": crowns that ring a chime each time a world clears, so 64 worlds play a chord.
- **Risks:** Distribution-scored, so robust by definition. Thumbnails at 64 may be unreadable; use 16 for play and 64 for the score. Some players may find "your shot is a probability" alienating. As a dev tool, it is also a player-facing chaos audit for free.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 5 / cost 4

### PZ-18 Invisible Ink
- **Pitch:** The structure is invisible. Only bodies your shots touch, displace or come near become visible (ink-tinted). Find and fell the crowns.
- **Fun hook:** Paintball reveal. A shot spray outlines a wall you didn't know was there, and the second shot is a calculated punch through it. The fog creates tension that a visible tower cannot.
- **Borrowed from:** Battleship (hits reveal), the paint reveal of ink-territory shooters, and echolocation reveals in stealth games.
- **Loop:** 30 s: fire a "flare" (firework shell; its stars reveal what they touch). Read the outline and fire the real shot. 5 min: balance reveal shots against the real ones; par counts both.
- **Scale story:** At 1k the outline is a puzzle. At 10k the reveal spreads (every displaced cube lights up, so a big collapse paints itself), and a single cluster can map a district. At 100k: night-city levels where only the collapse front glows.
- **Uses today:** Per-shot ink tint of displaced cubes, firework weapon (12 stars), the displacement predicate, crowns.
- **Needs new:** Per-body visibility mask (revealed if displaced, or within radius of an impact): S, low. A ghost-hint render for the ground shadow (a small clue): S.
- **Level seeds:** (1) "Dark Hall": a hidden lintel temple with crowns on the lintel. (2) "Decoy": an invisible heritage wall in front of the crowns; a blind shot breaks it. (3) "Night City": 10k, three flares and one cannonball.
- **Risks:** Wide-basin: the shots themselves are standard. Players may feel the hidden information is unfair if reveals are too local; tune the reveal radius generously. The shadow on the ground is a free hint (fine, or toggle it).
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 5

### PZ-19 Echo Volley (wild)
- **Pitch:** Each retry replays all your previous shots in time; add one new shot per loop, layering a choreographed volley that no single shot could do.
- **Fun hook:** You collaborate with your past selves: loop 1 fires the cannonball, loop 2 you throw a marble timed 0.8 s later into the gap it opens, loop 3 you catch a falling crown with a grenade. Timing becomes a puzzle.
- **Borrowed from:** Recorded-past-self puzzle games (a cursor or character that replays your previous loop) and the replay-cloning of time-loop shooters.
- **Loop:** 30 s: watch your previous loops replay, scrub to the moment, fire. 5 min: build a 4-shot volley to clear an "impossible" level; the final replay is a choreographed piece.
- **Scale story:** At 1k the timing windows are tight and readable. At 10k cascades last 4-8 s, giving Quickdraw windows for mid-collapse shots. At 100k: a 25 s collapse, so you conduct it with 5 shots.
- **Uses today:** Same-device determinism (exact replay), quantised step-stamped spawn events, replay scrub, rubble.
- **Needs new:** Step-scheduled shots (fire at step t during physics, not only while frozen): S-M, low. A timeline scrubber that resumes into a live aim at frame t: M, med (needs snapshot restore at t, or re-simulation, which exists as scrub-by-re-sim).
- **Level seeds:** (1) "Gap": a heritage wall falls slowly; slip a marble through the gap at the right moment. (2) "Juggle": keep a crown in the air for 3 s using 3 timed shots. (3) "Symphony": 10k, four shots that must each land while the previous is still falling.
- **Risks:** Same-device exact, which makes it great on this engine. Re-simulation cost at 10k when scrubbing is a few seconds, a UX hitch. Timing windows can be tiny, so loosen with forgiving objectives.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 3

### PZ-20 Implosion Order (destruction hybrid)
- **Pitch:** Place timed charges in a 10k building so it falls into its own footprint, sparing the heritage buildings on either side.
- **Fun hook:** Real demolition engineering: core first, then shell, 200 ms apart, and the building folds inward. Get the order wrong and it topples onto the church. Planning tension, then a 10 s payoff.
- **Borrowed from:** Controlled-demolition sims (charge placement, delays), heist planning phases (prepare, then execute in one go), and the countdown of destruction-puzzle games.
- **Loop:** 30 s: place 3 charges on core columns with delays, press detonate, and watch the fold. 5 min: iterate placements and delays to keep rubble within the footprint; stars on footprint spread and charges used.
- **Scale story:** At 1k it is a toy (too few elements to fold). At 10k this is the sweet spot: buildings with cores and shells, rubble volume matters. At 100k: a whole block with three buildings, sequenced across 30 s.
- **Uses today:** Blast event, WeaponSpec grenades with timers (place at rest = spawn with timer trigger), footprint and heritage objectives, sleep.
- **Needs new:** Charge-placement UI with delay dial (spawn grenade at rest, timer as data): S-M, low. Footprint spread metric (fraction outside the lot is there, add a radial histogram): S. Building scenarios with cores (S14 exists).
- **Level seeds:** (1) "Water Tower": four legs, fell it straight down. (2) "Tight Lot": a 10-storey block between two chapels. (3) "Lean Into It": fold a building deliberately onto an empty lot to the north.
- **Risks:** Distribution-scored (footprint spread), so robust at 10k. Loose-lattice buildings may not "fold" convincingly; they may crumble like sand (findings §3: columns are independent). It needs slabs and planks for floors so the shell pulls inward.
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 4 / cost 3

### PZ-21 Overhang (stacking hybrid)
- **Pitch:** Stack N planks off the edge of a table to push a gold cube as far past the edge as possible: the harmonic block-stacking problem as a game.
- **Fun hook:** A beautiful maths puzzle you can feel. Intuition says stack straight, the optimum is a counterbalanced fan, and the plank tower creaks as you push it 1 cm further.
- **Borrowed from:** The harmonic overhang problem, tower-stacking puzzle games, and the "one more cm" greed of balancing toys.
- **Loop:** 30 s: place a plank, slide it to the edge, release, and it holds; the measure reads 0.92 m. 5 min: 10 planks, try to beat the theoretical counterweight bound; stars cast from bot best.
- **Scale story:** Mainly small scale. At 1k planks, open-ended "Kapla bridge" building (overhang from both sides to meet in the middle). 10k+ not needed.
- **Uses today:** Planks (box any half-extents), spawn at rest, the Kapla scenario, sleep (finished stacks rest), deterministic replay.
- **Needs new:** A "table" (static block, or a massive slab, which works today), plus "nothing may touch the ground beyond the edge": S. Placement UI with fine nudge: M, low (shared). Settle-and-hold test (stand for 5 s): S.
- **Level seeds:** (1) "Five Planks": the textbook harmonic stack. (2) "Counterweight": you get one iron block, so where does it go? (3) "Bridge": 40 planks, two tables 3 m apart, meet in the middle.
- **Risks:** Small-scale exact on one device, but near-tipping configurations are chaotic: the same stack may hold on Mac and fall on a phone. Fine for same-device scoring, but casting must be per device (cheap here: a few bodies). Solver softness (AVBD) may let stacks creep, so measure creep first.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 4

### PZ-22 Free Stones
- **Pitch:** A wall of red and blue cubes: push out every red cube with the cue, but only "free" ones (nothing blue above them), and every move changes what is free.
- **Fun hook:** Mahjong-solitaire logic with a Jenga push. You scan for exposed reds, plan the order, and the board is solvable only one way. The push itself is satisfying and reliable.
- **Borrowed from:** Mahjong solitaire (only free tiles move), Jenga (the push), and sliding-block puzzles (order matters).
- **Loop:** 30 s: find a free red, cue it out, and it slides off; the next red is exposed. 5 min: clear a 200-cube wall; par = cues used, stars for no blue moved.
- **Scale story:** 200-1k is the right range. At 10k it becomes pattern search (find the free reds in a city facade). The engine scale does not add much.
- **Uses today:** Cue verb (Jenga push), pick-off (B3, 100% robust), heritage (blue must not move), crowns.
- **Needs new:** A "free" highlight (no body resting on it: contact graph or a geometric check on the lattice): S, low. Generator with a unique removal order: M, low.
- **Level seeds:** (1) "Checker": a checkerboard 6×6 wall, where most reds are not free yet. (2) "Pyramid": a stepped pyramid where reds hide under blue steps. (3) "Bookend": the final red is under a blue lintel, so you must cue it sideways.
- **Risks:** Small-scale exact if the cue only pushes cubes with nothing above (pushing a loaded cube drags its neighbour, findings B1). It may be too deterministic and logic-only to show off the engine; it is a gentle pacing world between spectacle levels.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 4

### PZ-23 Snowglobe (wild)
- **Pitch:** You can't shoot. You tilt the whole world (rotate gravity up to 30°) to guide 5,000 blocks of rubble into a target arrangement inside a walled box.
- **Fun hook:** Every block moves at once, and the puzzle is the order of tilts: left lets the ice slide out from under the rubber, forward avalanches the heap, and you sculpt with gravity.
- **Borrowed from:** Tilt-maze toys (marble mazes), gravity-rotation puzzle platformers, and the shake-the-globe sand toys.
- **Loop:** 30 s: tilt left, watch the heap slide, tilt back. 5 min: get the gold cube into the corner and keep the heritage tower standing (it tips above about 25°, a constraint you feel).
- **Scale story:** At 1k it is a marble maze. At 10k it is granular flow, avalanches and jams (the "Sluice" world made playable). At 100k it is a sand-garden toy, slower than real time.
- **Uses today:** Materials (ice slides first), histograms and zones for the target, sleep (but tilting wakes everything, so this is expensive).
- **Needs new:** A runtime gravity vector (the solver takes g; animating it per step): S-M, med. Static walls for the box (static flag): M, low. Sleep thresholds that respond to a gravity change (wake all on tilt): S, med.
- **Level seeds:** (1) "Corner Pocket": get one gold cube into a corner past 20 decoys. (2) "Separator": tilt so ice leaves and plaster stays (an Assay crossover). (3) "Don't Spill": tilt the heap into a pit while keeping a tower up.
- **Risks:** Distribution-scored (zone fractions), so robust. The infinite ground plane means the box needs walls, which needs the static flag. Tilting wakes every body, so 10k awake at 40 iterations means 5-10 ms: fine. At 100k it doesn't run in real time. The camera rule: the world should tilt, not the camera.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### PZ-24 Long Demolition (progression hybrid)
- **Pitch:** One persistent 100k city across a 20-puzzle campaign: each puzzle's rubble is the next puzzle's terrain, and the objectives are cast on the fly from your actual city state.
- **Fun hook:** Consequence across sessions. The rubble from puzzle 3 is now the ramp you need in puzzle 4 (or the jam that blocks it). Your city is yours; no two players have the same campaign.
- **Borrowed from:** Persistent-damage tactics roguelikes (the board carries over, damage matters later), sandbox city builders (the place you shape), and legacy board games (permanent changes across plays).
- **Loop:** 30 s: an objective arrives ("bring the clock tower below 20 m without touching the river"), read the current rubble, fire. 5 min: two or three puzzles in a block; the city persists in local save.
- **Scale story:** At 10k it is one district, a short campaign. At 100k this is the point: a world big enough to have 20 separate puzzle sites that interact through rubble. It needs sleep and compaction.
- **Uses today:** Rubble persistence, objectives (crowns, skyline, footprint, heritage), same-device determinism (the save is level + shots, <200 bytes per shot), sleep.
- **Needs new:** On-device fast casting of objectives from the current state (a cheap bot pass: 8 nudges, not 64 plays): L, high (casting costs ~1 h per 10k level today). Persistent city save + resume (replay is cheap, but replaying 20 shots of 100k is slow; snapshot save instead): M, med. Puzzle-site generator: L, med.
- **Level seeds:** (1) "Old Quarter": 4 sites, where the rubble of site 1 dams the canal for site 3. (2) "Clock Tower Arc": the tower is the objective three times, from different sides. (3) "Rebuild Day": a stacking puzzle on top of your own rubble.
- **Risks:** Wide-basin only if each generated objective is cast from the real state, and that casting is the expensive, risky part. Without it, objectives could be impossible on your particular rubble. It is the biggest build in the lens and depends on sleep and compaction being done.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 2 / cost 1

---

## Capability primitives this lens keeps needing

- **Placement UI** (spawn-at-rest with snap, overlap rejection, pre-settle check, fine nudge): PZ-6, PZ-7, PZ-9, PZ-15, PZ-20, PZ-21. One shared M build unlocks six modes.
- **Zone and target comparison reductions** (per-zone, per-material counts; a 2D projected occupancy grid vs a target bitmap; target-histogram distance; band objectives): PZ-2, PZ-3, PZ-4, PZ-11, PZ-13, PZ-14, PZ-20, PZ-23. Mostly S on top of the existing histograms.
- **Static or anchored body flag** (pegs, bin walls, tables, box walls, pivots): PZ-2, PZ-9, PZ-11, PZ-21, PZ-23. Already an engine ask; it blocks PZ-11 and PZ-23.
- **Per-body visibility and hidden properties** (fog, reveal on touch, hidden material, masked X-ray): PZ-1, PZ-9, PZ-10, PZ-18.
- **Per-body carried load / contact-force readback** (for the X-ray as a resource, audio timbre, "free" highlight): PZ-1, PZ-10, PZ-22 (geometric fallback), PZ-5 (hint).
- **Multi-world instancing with per-world segmented reductions** (side-by-side jittered copies): PZ-17, PZ-7 (truth table), PZ-4 (candidate preview), PZ-15 (stress-test preview). It also makes bot casting cheaper.
- **Step-scheduled shots and a timeline** (fire at step t during physics, scrub-to-aim): PZ-19, PZ-20 (delays are data already), PZ-7 (synchronised inputs).
- **On-device generation and validation** (date or seed, a cheap bot pass on the player's device): PZ-4, PZ-8, PZ-12, PZ-22, PZ-24.
- **WeaponSpec visual editor** (tiles, live preview of the children): PZ-16, PZ-20.
- **Pick-up / move verb** (remove + respawn preserving material): PZ-9, PZ-5 (variant).
- **Runtime gravity vector:** PZ-23.
- **Sound parameter hooks from physics state:** PZ-10.

## My top 5 and why

1. **PZ-17 Chorus.** It turns the project's hardest fact (chaos, per-device determinism) into the mechanic, runs today at 100 × 64 bodies, and teaches players exactly what the bot's robustness gate measures. It is novel and cheap, and it doubles as a player-facing chaos audit.
2. **PZ-16 Fusecraft.** WeaponSpec is already pure data with triggers and splits, so this is mostly a UI build. Optimisation scoring on cost histograms gives replayability without par pinning, and the predicates make solutions forgiving.
3. **PZ-4 Aftermath.** A true reverse puzzle that per-device determinism makes exact (the hidden shot is simulated on your machine). It reuses the heatmap and ink, needs only a distance metric, and would make a good daily.
4. **PZ-2 Assay.** Distribution-scored, so it is robust at 10k. Material contrast (ice, rubber, iron) becomes the verb, scale changes the feel from streams to a granular medium, and it is nearly all existing reductions.
5. **PZ-1 Sounding Line.** It is the clearest case of scale making a puzzle: 10k blocks with 2 keystones is a search problem, and the X-ray as a scarce resource turns reading into decisions. It reuses the designed X-ray; the risk is the load estimate.

Honourable mentions: PZ-20 Implosion Order (the most fun at 10k, but it depends on buildings that fold, not crumble) and PZ-18 Invisible Ink (the cheapest new tension in the lens).
