# Chain reactions and dominoes: 25 game-mode ideas (lens CH)

Designer lens: chain reactions, domino runs, Rube Goldberg contraptions, triggers and timing, wave fronts. Written 2026-11-05 against the capability brief. Repo not modified.

## Engine facts this lens depends on (read first)

- **A domino is a thin box spawned at rest.** Suggested game proportion: h:w:t = 1 : 0.5 : 0.16, about 1 m tall at model scale. Spacing of 0.5-0.7 h chains reliably. Thin boxes are well inside "box any half-extents". There is no CCD, but domino speeds are a few m/s, far below the ~1 m/step limit.
- **Wave speed is about 1-1.5 x sqrt(g h)**, so roughly 3-5 m/s for 1 m dominoes. That fixes the pacing, and it matters. One straight line of 100k dominoes at 0.6 m spacing is 60 km long and takes hours. **100k only makes sense as a 2D field or as many branches.** A 300 x 300 field at 0.6 m spacing is about 180 m across, which a front crosses in roughly 45 s. A design note in the repo already says a domino level must finish inside settle v2's 30 s cap (about 15 slender columns at 1.7 s each). Every idea below either respects that cap or names a longer run window as a need.
- **Sleep is the enabler, and dominoes are its best case.** The awake set is only the wavefront: the falling dominoes plus a few just behind them. A straight run keeps under 10 bodies awake. A radial front in a 100k field at r = 90 m is about 940 cells on the ring x 3 deep, so roughly 3k awake. That fits 60 Hz on the M5 Max even though the field is 100k. Three sleep subtleties need checks: (a) **premature sleep of a slowly tipping domino**: a light push gives low velocity near the start of the tip, and a velocity-only sleep test can freeze a domino mid-lean, so it needs a quiet-for-N-steps timer or a tilt-aware test; (b) **spawn asleep**: a placed field should start asleep at step 0, not settle 100k bodies first; (c) fallen dominoes lean on each other in shallow stacks and must re-sleep in that state.
- **The push exists today without new forces.** Respawn domino 1 at a 6-10 degree lean (`remove` + `spawn` at rest), drop a marble, use the Keystone cue rod, or fire a tiny `blast` at its top. Sparse kicks (step 6) would only make it nicer.
- **Contraption parts must be loose boxes and spheres.** A seesaw is a plank resting on a cube fulcrum (it slides; it does not pivot). A ramp is a tilted slab, and it needs a **static / pinned body** flag unless it is heavy and wedged. Hinges, levers, pulleys and conveyors need joints (step 7) or kinematic bodies (not planned). I mark every idea that needs them.
- **WeaponSpec is a ready-made sensor and actuator.** A shell placed at rest with a `near body` trigger behaves like a pressure plate that fires a blast, splits or removes. Chains of dominoes delivering a "spark" to charges fit the engine today.
- **Observers already answer the questions chains ask.** Count fallen (predicate: centre height < h/3), front position (bbox of moving bodies), time-of-fall of up to 64 watched targets per step.
- **The camera rule bites this lens.** A wave runs out of frame. Never auto-follow by default. The answers are wide authored framings, a 2D **wave map** overlay (a picture, not camera motion), and an **opt-in** front-follow cam (the follow spring designed in keystone-design already frames the awake-body AABB).
- **Sound is half the pleasure.** The click rate is a tempo. At 1k it is a ticking snare, at 10k a drumroll, and at 100k rain on a roof (the planned granular crossfade). The modal synth already pitches by size and material, so domino height can be pitch.

---

### CH-1 Toppletrail
- **Pitch:** Draw a domino run with a limited budget from the push to a crown, past obstacles, then tip the first domino and watch.
- **Fun hook:** The draw-then-watch gap. You commit a curve, and for 10 seconds you are a spectator to your own plan, wincing at every tight corner. Is the corner too sharp, the gap too wide, the ramp too steep? The first 30 s is one stroke, one push and a satisfying ticking run, so it is instantly legible to anyone who has seen dominoes.
- **Borrowed from:** Line-drawing physics games (draw a path, then simulate), bridge-builder budgets (fewest pieces), the domino-rally toy genre (auto-spaced placement along a stroke).
- **Loop:** 30 s: draw a stroke (auto-spaced at 0.6 h, auto-rotated to the tangent), push, watch, see where it stopped (red marker), adjust. 5 min: 6-8 levels that introduce corners, stairs (dominoes stepping up blocks), bridges (planks over gaps), forks to 2 crowns, and budget stars.
- **Scale story:** 1k: a level is a single run with stunts. 10k: the field is pre-dressed with other people's runs (sleeping props), and your run must thread them without waking them, so heritage on chains. 100k: not the core. A finale where your run triggers a 100k-field reveal (see CH-2).
- **Uses today:** `spawn` at rest, crowns objective, heritage, the lean-respawn push, bot-cast stars (budget as ★★★), shot ink for the run, modal click sound.
- **Needs new:** stroke-to-dominoes placement tool (S, low); static/pinned body flag for ramps and walls (S, low; may already be trivial as infinite mass); compact stroke events so replays stay tiny (S, low); 2D wave-map overlay (S, low).
- **Level seeds:** (1) "Hairpin": crown 4 m away behind a wall, 30 dominoes, needs two 90-degree turns at tight radius. (2) "Stair Climb": crown on a 5-step stone stair; dominoes must step up with one per tread. (3) "Gap Year": a 1.2 m trench with planks lying around; lay a plank bridge and run the chain across it.
- **Risks:** Corner reliability is a classic domino pain point. Too-tight curves fail by friction and slip, which can feel arbitrary. The tool must show a radius warning, and the bot gate must confirm a basin. Watching time is dead time if runs are long, so keep the first levels under 8 s.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 5 / cost 5

### CH-2 Wakefield
- **Pitch:** A 100k-domino field hides a mosaic on its faces; you get three pushes, and the falling waves reveal the picture.
- **Fun hook:** Choosing where to strike a sea of 100k pieces, where each push is a stone thrown into a pond. The picture blooms outward from your pushes, and you are racing to reveal the "gold" regions (the portrait's eyes) before fronts collide and die. The first 30 s is one click and a canvas flowering at 60 fps.
- **Borrowed from:** Domino-art TV record events (images revealed by falling fields), coverage/turf scoring (paint-the-map games), Picross/scratch-card reveal satisfaction.
- **Loop:** 30 s: pick a push point and direction, watch the wave fan and reveal, place push 2 where the front won't reach. 5 min: a gallery of 6 fields with increasing "dead zones" (gaps, walls of heavy dominoes that don't fall, ice patches) and stars on % revealed and on the gold regions.
- **Scale story:** 1k: a postcard, too coarse to read as a picture. 10k: a readable icon (100 x 100). 100k: a real image (316 x 316), and the front's shape (interference, shadows behind obstacles) becomes the drama. This is the lens's purest "scale changes the experience" mode.
- **Uses today:** spawn at rest, sleep (only the front is awake), count-fallen reduction, histograms per region, candy look.
- **Needs new:** per-face tint (top face vs faces revealed on fall; S-M, low; renderer only); spawn asleep plus persistent sleeper grid (M, med; already next on the E2 roadmap); wave-map overlay (S); fields with brick-offset patterns so fronts spread sideways (authoring, S); longer run window than 30 s for 180 m fields (S, low).
- **Level seeds:** (1) "Sunrise": 40k, one push, a sun revealed outward from the centre. Teaches radial spread. (2) "Two Rivers": 100k field split by a non-falling stone channel; you need one push per bank and must time the third to reach the delta. (3) "Portrait": 100k, gold eyes guarded by ice patches where dominoes slide instead of tip.
- **Risks:** The reveal must be readable from a fixed camera, so a top-down orbit is preset and the player moves it. Field propagation in AVBD must fan reliably; parallel rows only propagate forward, so the field needs offset patterns, and that should be tested early. Score depends on whether a single image is interesting twice; replay value relies on puzzles in the dead zones.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### CH-3 Firebreak
- **Pitch:** A domino wave is already rolling across a field toward a cathedral; physics does not pause, and you remove dominoes and drop blockers to cut it off.
- **Fun hook:** Real-time triage. The front is wide and you have 8 removals and 4 slabs. Do you cut a clean gap far ahead (safe, costs more field) or a surgical one right at the front (cheap, risky)? It breaks Keystone's freeze-while-aiming rhythm on purpose. The first 30 s is pure adrenaline with a clear readable threat.
- **Borrowed from:** Wildfire-containment and firebreak games (cut fuel ahead of the front), Lemmings (place blockers in a live sim), tower-defence pressure without the towers.
- **Loop:** 30 s: the wave starts, you click to remove a strip, one branch leaks around, you slam a slab into the gap, and the front dies 2 rows from the cathedral. 5 min: escalating fields (multiple fronts, splitter dominoes that branch, ice lanes that carry the wave faster), stars on dominoes saved.
- **Scale story:** 1k: a corridor duel. 10k: a meadow with 3 simultaneous fronts, so attention becomes the resource. 100k: a whole valley with villages (heritage clusters); you are triaging which village to lose. Sleep makes it cheap because only the fronts are awake.
- **Uses today:** `remove` and `spawn` events (replayable at quantised steps), heritage constraint, count-fallen, awake-adaptive slow-mo valve (bullet time when overloaded, which here is a feature).
- **Needs new:** live-play input mode where events land while physics runs (S, low; the event model already supports it); optional player-triggered slow-mo button with a meter (S, low); wave-map overlay (S, low).
- **Level seeds:** (1) "Chapel Lane": a 1k corridor, one front, 3 removals, a chapel at the end. (2) "Fork in the Field": 10k, the wave splits around a pond, 2 villages, 6 removals; one village will fall unless you find the choke point. (3) "Wildfire": 100k, 4 fronts from the corners, 20 removals, save the central cathedral and as many farms as possible.
- **Risks:** Click precision on a moving 3D field is hard, so removal should be strip-shaped (drag a line) with snapping. Same-device determinism keeps replays honest, but bot-cast stars for a real-time mode need a scripted bot (a placement policy rather than a shot search). It is cheap to build.
- **Scores (1-5):** fun 5 / novelty 4 / engine fit 5 / cost 4

### CH-4 Stopline
- **Pitch:** Make the chain stop as close as possible to a mark without crossing it, like curling with toppling dominoes.
- **Fun hook:** "Closest without going over" is a timeless tension. You tune the last metre: one wider gap, one shorter domino, a rubber one that absorbs the hit. Every run ends in a held breath on the final wobble.
- **Borrowed from:** Curling and shuffleboard (closest to the button), bid-closest-without-going-over game shows, golf putting (dial a distance).
- **Loop:** 30 s: a prebuilt run with an editable tail of 6 slots; set each slot (domino / tall / short / gap / rubber), push, and measure the distance to the line in centimetres. 5 min: tours of 5 holes with total centimetres as the score, plus hot-seat (alternate holes, closest wins).
- **Scale story:** 1k: one run. 10k: a hundred parallel lanes start together and you tune the tail of one; the rest are a crowd (spectacle). 100k: not meaningful. Honest: this is a small-scale mode.
- **Uses today:** spawn, watched bodies (track the last fallen), sizes and materials (rubber e 0.6), bot stars on distance bands.
- **Needs new:** stop-distance readout from a watched-body reduction (S, low); tail-slot editor UI (S, low).
- **Level seeds:** (1) "Edge of the Table": the line is a table edge; going over drops the domino into a bowl and you lose. (2) "Soft Landing": only rubber and gap pieces; learn the absorption. (3) "Ladder": 3 lines, closest to each in turn with the same tail (trade-offs).
- **Risks:** Domino propagation is thresholdy: it either continues or doesn't, so the distance is discrete in spacing units. That is fine if the mark sits between dominoes and partial falls (a domino leaning on the next) count. Low spectacle; it is a side mode.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 5

### CH-5 Gatework
- **Pitch:** Build domino logic gates (OR, AND, crossovers, delays) so a single push topples exactly the targets the puzzle asks for.
- **Fun hook:** The "domino computer" delight. A wave is a bit, and two waves colliding annihilate. You discover that a T junction is an OR, that two fronts cancelling is a building block, and that timing is everything. The first 30 s is a toy demo: push two inputs, watch the output fall or not.
- **Borrowed from:** Domino computers (famous public builds of adders), programming puzzle games (Zachtronics-style input/output test cases, histograms of solution cost), circuit-sandbox games.
- **Loop:** 30 s: a test bench with inputs A and B, a target lamp crown; place gate parts, run the 4 test cases (deterministic replays), see which pass. 5 min: chapters that build up to a half-adder that topples "3" from inputs "1+2", with leaderboards on piece count and wave time.
- **Scale story:** 1k: single gates. 10k: a 4-bit adder becomes a visible machine. 100k: a domino "calculator" that runs for a minute, the wild endgame. Each test case is a separate replay run.
- **Uses today:** spawn, determinism (each test case replays exactly per device), crowns as outputs, heritage as "must not fall" outputs.
- **Needs new:** multi-case runner (run the same layout under N input pushes; S-M, low); prefab gate pieces with authoring tests (M, med); a reliability check because gates must hold under ±small jitter (bot basin gate exists; S).
- **Level seeds:** (1) "Either": build an OR so either input topples the lamp. (2) "Cancel": two fronts must annihilate so the vault crown stays standing (an XOR-ish trick). (3) "Crossover": two runs must cross without triggering each other (needs a bridge plank or a timed gap).
- **Risks:** Real domino gates are notoriously finicky and AND gates rely on timing; physics noise can make a correct design fail 1 in 5, which feels unfair. That needs the chaos audit at 100% per test case. Niche audience. Might be a beloved chapter rather than a mode.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 3 / cost 3

### CH-6 Turf Fronts
- **Pitch:** Two players race fronts across a shared field; every domino takes the colour of the wave that toppled it, and colliding fronts stop dead, so you are carving territory.
- **Fun hook:** Fronts annihilate where they meet. The field is a race and a border war: push early into the open, or wall off a pocket the opponent's wave must go around? Clear readable colour, immediate drama when two fronts collide head on.
- **Borrowed from:** Light-cycle games (cut off the opponent), Go (territory and enclosure), turf-paint shooters (coverage % at the end).
- **Loop:** 30 s: each player places 2 push points and 3 blocker slabs in secret (hot-seat with the screen hidden), both pushes fire, colour floods the field. 5 min: best of 5 maps with different terrain (ice lanes, heavy lines, gaps) and a "last push" catch-up rule for the trailing player.
- **Scale story:** 1k: a skirmish on a tabletop. 10k: borders become interesting curves. 100k: a map with geography, and front shape dynamics (diffraction around gaps) become strategy.
- **Uses today:** spawn, remove, sleep, hot-seat on one device (determinism makes it fair to replay), histograms for coverage.
- **Needs new:** **contact-propagated tag**: when a body wakes from contact it inherits the toppler's tag (M, med); it is GPU work in the contact pass but cheap, and it also powers shot ink and diagnostics. Per-body tint by tag (S). Hidden-placement hot-seat UI (S).
- **Level seeds:** (1) "Duel Strip": a 20 x 200 strip, players at the ends, the meeting point is the score. (2) "Island": a field with a central lake; whoever encloses the far shore first wins it. (3) "Commons": 100k, 4 players, 6 pushes each over 3 rounds, with fallen dominoes acting as permanent walls.
- **Risks:** No online lockstep, so this is local or host-streamed only. Fronts on a uniform field are predictable, so terrain must make choices interesting. Simultaneous fronts at 100k mean many awake rings, so check the awake budget.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### CH-7 Outrun
- **Pitch:** You lay dominoes in front of a live, chasing chain; if the wave catches your pen you lose, and if you leave a bad gap it dies.
- **Fun hook:** You are the track-layer with a monster on your heels. Speed and accuracy pull in opposite directions: faster laying means wider, sloppier spacing; precise laying lets the front gain. It is an endless runner where the runner is your own creation. The first 30 s is frantic and funny.
- **Borrowed from:** Endless runners (escalating speed, distance score), snake games (your trail is the threat), train-track-ahead-of-the-train games (lay rail before the engine arrives).
- **Loop:** 30 s: drag to lay dominoes along the ground (auto-spaced to your stroke speed), the front gains on corners, you sprint a straight, it catches you at 340 m. 5 min: terrain biomes (ice, which speeds the chain; rubber, which bounces dominoes back; slopes, which change wave speed), pickups that slow the front, daily seed.
- **Scale story:** 1k: a short sprint. 10k: a long run whose fallen trail scribbles across the landscape (the trail is a souvenir picture). 100k: a session-long run; the whole map is your sleeping, fallen signature. Sleep makes the trail free.
- **Uses today:** spawn at rest (live), sleep, materials, determinism (daily seed replays), modal click as a pursuing drum that gets louder as it closes.
- **Needs new:** live input (S, low); stroke placement that adapts spacing to speed (S, low); the camera is an issue: the play area moves, so this mode needs a player-driven pan with an edge-push scroll, or an opt-in follow (S, low; must stay player-controlled to respect the camera rule); procedural terrain strips (M, low).
- **Level seeds:** (1) "Boardwalk": flat planks, no obstacles, learn the pace. (2) "Ice Rink": the front speeds up on ice, so you must lay a slower segment of heavy dominoes. (3) "Switchbacks": a hillside where uphill chains slow and downhill chains race.
- **Risks:** The camera rule plus a moving play area is the main design risk (edge-pan must feel good). Wave speed on slopes and ice needs tuning to be learnable. Input precision while drawing fast in 3D: maybe ground-plane-only drawing with forgiving snapping.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 4

### CH-8 Contraption Kit
- **Pitch:** A Rube Goldberg bench: dominoes, balls, planks, ramps and stacks from a parts bin, with a goal like "ring the bell" or "drop the anvil on the crown".
- **Fun hook:** Building a machine and watching it nearly work. The joy is in the 9th attempt, when the ball finally rolls off the seesaw plank into the stack. Parts-bin limits make it a puzzle; free mode makes it a toy.
- **Borrowed from:** Classic part-bin contraption puzzlers (fixed parts list, a goal and fixed scenery), contraption-sharing sandboxes (share a machine as a tiny file).
- **Loop:** 30 s: drag a ramp, a ball and 12 dominoes onto the bench, press go, the ball misses the plank by 5 cm, nudge, go. 5 min: a chapter of 10 contraptions, each introducing one part: seesaw (plank on cube fulcrum), ramp, stack that topples into a run, ball-in-a-trough, a grenade as a "spring" (proximity trigger blast).
- **Scale story:** 1k: the bench. 10k: one contraption feeds a 10k domino field finale (the payoff). 100k: not core. Scale is the encore, not the puzzle.
- **Uses today:** spheres and boxes of any size, materials (ice ramps, rubber bouncers), WeaponSpec near-body trigger as a sensor and spring, crowns, determinism for sharing (replays under 200 bytes plus compact placements).
- **Needs new:** static/pinned bodies for ramps, troughs and shelves (S, low); joints for true levers, hinges and pendulums (step 7, L, med); a pendulum would be the single most valuable joint part. Kinematic parts (motors, conveyors) are not planned, so leave them out (would be L, high). A placement editor with snapping (M, low).
- **Level seeds:** (1) "Bell Hop": ball on a ramp to a domino run to a bell crown on a shelf. (2) "Seesaw Lift": a plank on a cube, drop a cannonball on one end to flip a marble up onto a ledge. (3) "Anvil Day": a run topples a stack whose top slab (the anvil) must land on the crown.
- **Risks:** Without joints the vocabulary is thin: no pendulums, pulleys, hinged doors or levers that stay put. Loose seesaws slip, which may feel flaky. It is a genre with strong expectations; a weak part set reads as cheap. Best after step 7.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 3 / cost 3

### CH-9 Fuse Line
- **Pitch:** Controlled demolition where dominoes are the fuse: route chains to charges at a building's columns, and chain length sets the detonation delay that steers how the building falls.
- **Fun hook:** Real demolition is about sequencing: blow the left columns first, then the right, and the tower folds left into the lot. Here the fuse is visible and physical, a ticking run you lay. The decision is which columns, in what order, how many metres of delay. The payoff is a skyscraper folding exactly into its footprint.
- **Borrowed from:** Demolition-sim games (charge placement, sequencing, collateral scoring), real controlled-demolition delay sequencing, fuse-burning puzzle games (lit fuse as a timer).
- **Loop:** 30 s: drag 3 runs from the plunger to 3 charge sockets, each run's length readout shows its delay (0.6 s, 1.2 s, 2.1 s), push, a ticking line, crump crump crump, collapse. 5 min: 8 buildings with neighbours that are heritage, wind (a constant offset), and multi-tower sites where one tower must fall into the other.
- **Scale story:** 1k: a 5-storey block. 10k: a city tower from S14 with the street around it (footprint rubble matters). 100k: a block of towers sequenced by one branching fuse network; collapse cost scales with awake rubble, so this is where tiered blasts and sleep matter.
- **Uses today:** **WeaponSpec with a near-body trigger** (a shell at rest triggers when a domino lands near it, then blasts), footprint and heritage constraints, collapse objective, stone grit sound, look=real dust. Nearly everything exists.
- **Needs new:** charge "socket" prefab (a WeaponSpec preset placed at rest; S, low); fuse delay readout (domino count x wave speed estimate; S, low); maybe shaped (directional) blasts for column cutting (M, med) but radial works for v1.
- **Level seeds:** (1) "First Fold": a 6-storey slab block, two charges, fold it left into the lot. (2) "Neighbour's Church": a tower between a heritage church and a park; it must fall into the park, so the church-side columns must go last. (3) "Twin Drop": two towers, one fuse network; the second must fall exactly into the rubble of the first (footprint is one lot).
- **Risks:** Directional collapse of loose-cube towers may be less controllable than real reinforced concrete; it needs the mechanics probe. Proximity trigger near a domino needs a reliable "a domino arrived" test (fallen domino centre within r). It is close to Keystone's current shell, which is a strength.
- **Scores (1-5):** fun 5 / novelty 4 / engine fit 5 / cost 4

### CH-10 Hair Trigger
- **Pitch:** A pick-up-sticks duel on a standing domino sculpture: take turns removing one domino; whoever triggers the biggest chain loses the round.
- **Fun hook:** Jenga tension in reverse: the structure is not about to fall, it is about to *run*. Every domino you pull might be the one holding a 2,000-piece cascade in check. Reading which dominoes are load-bearing in a run (a leaning piece held up by a neighbour) is a spatial puzzle at every turn.
- **Borrowed from:** Jenga and pick-up sticks (alternate removals, loser is who makes it fall), marble-drop tension toys (pull a stick and hope).
- **Loop:** 30 s: inspect a domino wall with tension features (pre-leaned "cocked" dominoes held by a keystone piece), pick one, remove, physics runs 3 s, nothing or a small cascade; tally fallen. 5 min: a 6-turn hot-seat match over 3 sculptures; the cumulative fallen count is a penalty score.
- **Scale story:** 1k: a tabletop sculpture. 10k: a "domino cathedral" where cascades can be huge; the gamble grows. 100k: an exhibition field with thousands of cocked branches; a match lasts a while and a single blunder is spectacular.
- **Uses today:** `remove` (exactly the Jenga pull), heritage, count-fallen, hot-seat, shot ink per player, load X-ray (designed) as a hint power-up.
- **Needs new:** authoring of "cocked" tension structures (dominoes leaning on a holder; built by spawn at rest at a lean, S, low); turn manager (S). Sleep must keep cocked leaners asleep and stable (they are statically held; med risk if sleep jitter wakes them).
- **Level seeds:** (1) "The Fan": a semicircle of leaning dominoes held by 5 keepers; 4 safe pulls in 20. (2) "Domino Pyramid": stacked dominoes on edge in a pyramid (a classic domino structure). (3) "The Gallery": 10k sculpture with 3 hidden fuses that run into a crown display; trigger one and lose.
- **Risks:** If the cascade logic is too readable it is solved; if too hidden it is luck. The X-ray helps. Leaning dominoes on AVBD must be truly static (no creep), otherwise a resting sculpture slowly self-triggers; that needs a creep test.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 5

### CH-11 Temper
- **Pitch:** A fixed domino layout; you can only change materials (stone, ice, rubber, iron) of chosen segments to route the wave to the right target.
- **Fun hook:** Each material changes what a domino does when hit: ice slides and shoves the next one along instead of tipping, rubber rebounds and can stall a front or even push it back, iron is too heavy for a light domino to topple, so it acts as a wall unless a heavy one hits it. You "paint" behaviour onto the run, like assigning skills to marching creatures.
- **Borrowed from:** Lemmings (assign skills to change behaviour), paint-on-surface puzzle games (gels that change bounce and speed), electrical routing with switches.
- **Loop:** 30 s: a branching run with 3 forks, a palette of 4 paints with limited litres; paint iron on the left fork to block it, ice the right to speed it, push. 5 min: 10 puzzles that combine materials; stars on paint used.
- **Scale story:** 1k: puzzles. 10k: a paint-the-field mode where you redirect a big front with few litres. 100k: a material river: ice lanes carry fronts across a field faster than stone; it becomes a "race the clock" variant.
- **Uses today:** materials (ice mu 0.05, rubber e 0.6, iron, stone densities), per-body friction and restitution, crowns, heritage.
- **Needs new:** a "set material" event on a body at rest (S, low; possibly remove + spawn with a new material today); paint brush UI (S).
- **Level seeds:** (1) "Wrong Way": two forks, the default sends the wave left, make it go right. (2) "Slow Burn": paint rubber to delay one branch so two crowns fall in order. (3) "Iron Gate": a heavy iron domino only falls if hit by a tall iron run, so the light run must be upgraded.
- **Risks:** Unclear that ice and rubber dominoes behave distinctly and readably in AVBD (ice dominoes may just tip with slip; rubber restitution at low impact speeds may barely matter). A material probe is needed before committing. Could feel like a rules puzzle more than physics.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 3 / cost 4

### CH-12 Ripple Tap
- **Pitch:** One tap per round; domino islands fall and each island ends in a small charge that may set off the next island; clear the board in a cascade.
- **Fun hook:** The single-input chain reaction: one choice, then helplessness and hope. Islands near the edge are safe bets, but the board-clearing play is a risky centre tap. A slow-mo zoom-free "last target" moment with a rising chime makes the final island explode like a victory.
- **Borrowed from:** One-tap chain-reaction games (expanding circles triggering others), single-shot peg games (combo score climbing, slow-mo plus fanfare on the last target, free-ball bucket for a bonus), pachinko.
- **Loop:** 30 s: look at 40 islands, tap one, watch 18 go, score climbs with a pentatonic arpeggio per island. 5 min: 15 boards, a few gold islands must fall, bonus taps earned by combos.
- **Scale story:** 1k: 20 islands of 50. 10k: 200 islands; cascades get long and branching. 100k: a "night sky" of 2,000 islands where cascades read like fireworks across a field (with firework WeaponSpecs on the gold ones).
- **Uses today:** WeaponSpec (grenade with proximity trigger as the island-end charge; firework for gold), spawn at rest, count-fallen, crown-down pentatonic arpeggio, sleep.
- **Needs new:** island prefabs (ring, spiral, line, each ending at a charge; S, low); player-triggered slow-mo on the last gold island (S, low; time scale, not camera).
- **Level seeds:** (1) "Constellation": 30 spiral islands, one tap, clear 80%. (2) "Bridges": islands linked by rubber balls that roll from one island's charge into the next. (3) "Grand Finale": 100k field of 2,000 islands, each gold island a firework that seeds 12 neighbours.
- **Risks:** One-tap chain games can be luck-heavy; bot-cast stars help show skill (★★★ via the nudge test). Blast range must be predictable or the board feels random.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 4

### CH-13 Record Attempt
- **Pitch:** A sandbox for building a 100k-domino exhibition (lines, fills, spirals, walls, stairs, bridges), then one push and a cinematic.
- **Fun hook:** The builder's investment then the release. Ten minutes of building, a held breath, one push. The fact that a botched gap can kill the run at 40% is exactly the TV-record tension. You're also sharing a tiny replay file of your exhibition.
- **Borrowed from:** Domino-record TV events (build long, fall once, "safety gaps" that you remove at the end), block sandboxes (creative-mode tools: fill, line, copy), contraption-sharing sites.
- **Loop:** 30 s: draw a spiral, a field fill and a staircase with tools; push; watch. 5 min: build an exhibit, use **safety gaps** (removable placeholder pieces that stop accidental runs while building: pull them all before the push), record and share.
- **Scale story:** 1k: a garage build. 10k: a living-room exhibition. 100k: the record-hall build; sleep and spawn-asleep are what make it run in real time, and the awake set is only fronts.
- **Uses today:** spawn at rest, remove (safety gaps), sleep, determinism (replay = strokes + push), candy look, modal sound with granular crossfade.
- **Needs new:** build tools (line, curve, fill, spiral, stair, wall, copy; M, low); compact stroke serialisation (S, low); spawn asleep (S, low); opt-in front-follow cam and authored cinematic paths for the replay (M, low; opt-in per the camera rule); a longer run window (S).
- **Level seeds:** (1) "Garage": 1k budget, 3 tool unlocks. (2) "Hall of Fame": 100k budget, a hall look (Kapla hall), a target of 95% fallen. (3) "Accident": a challenge build where random "drafts" (a ball rolls in) test whether your safety gaps hold.
- **Risks:** Sandboxes need tools to be excellent, which is the most expensive part. A 100k build by hand takes a long time without strong tools. Without a goal, it is Rubble Garden's weakness again; Record % and safety gaps give it a goal.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 2

### CH-14 Click Track
- **Pitch:** The domino run is a music sequencer: spacing sets the rhythm, domino size and material set the pitch, and you lay a run that plays a given melody.
- **Fun hook:** Physics as an instrument. A run that sounds right is a run that is physically right. Hearing the third note land early tells you the gap is too tight. The first 30 s is "draw, push, it plays a tune", which is delightful and new.
- **Borrowed from:** Rhythm games (timing windows, perfect/good/miss), music-toy creative apps (draw to compose), marble-music machines (physical sequencers).
- **Loop:** 30 s: hear a 4-bar phrase, place 16 dominoes in slots (spacing knob, size knob), push, get a timing graph (early/late per note). 5 min: a song book of levels, from metronome to syncopation; branch runs give chords (two fronts in parallel).
- **Scale story:** 1k: one phrase. 10k: a full song with chords from parallel branches. 100k: a field fill as a cymbal swell or rain; the "mix" is about density. Scale becomes timbre.
- **Uses today:** modal impact synth (per-size and per-material pitch already), determinism (timings exact per device), watched bodies (up to 64 note heads per step).
- **Needs new:** impact-event timestamps exposed to rules (S-M, low; the sound pipeline already finds the loudest impacts); tuning table so domino height maps to a scale (S, low); timing-graph UI (S).
- **Level seeds:** (1) "Metronome": 8 evenly spaced clicks at 120 bpm. (2) "Ice Skip": an ice segment slides and speeds the beat, producing a written accelerando. (3) "Round": two branches must play the same phrase 1 bar apart.
- **Risks:** Wave speed sets a narrow tempo range; very slow or fast notes are physically hard, so songs must be written for the instrument. The sound engine voices only 8 loud impacts, so chords might clip. It's a niche delight, not a core mode.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

### CH-15 Tripwire
- **Pitch:** Asymmetric hot-seat: the defender rings their keep with domino tripwires that run to counter-charges; the attacker must topple the crowns without tripping a wire.
- **Fun hook:** A bluffing build phase and a surgical attack phase. The defender's chains are both alarm and weapon: a stray marble trips a wire that runs 20 m into a charge, and the blast topples the attacker's own siege tower. Attack and defence each ask a different skill.
- **Borrowed from:** Artillery duels with a build phase (fort building before turns of fire), tower-defence placement, minesweeper-style hidden hazards.
- **Loop:** 30 s: the defender places 60 dominoes and 2 charges in secret around a castle; the attacker gets the rack and picks a lane. 5 min: swap roles, best of 2, scored by crowns down minus your own losses.
- **Scale story:** 1k: a castle of 800 cubes plus 200 dominoes. 10k: a walled town where tripwires snake through streets. 100k: not core; maybe a "minefield" field where every lane is wired.
- **Uses today:** Keystone rack and ammo, crowns, WeaponSpec near-body triggers as counter-charges, hot-seat on one device, shot ink per player.
- **Needs new:** secret-placement hot-seat UI (S, low); a "fog" view that hides dominoes from the attacker until they move (S, low; render filter); a defender budget system (S).
- **Level seeds:** (1) "Gatehouse": 40 dominoes, 1 charge, a narrow approach. (2) "Moat": defenders can use ice dominoes on a ramp (they slide fast). (3) "Old Town": streets of a 10k S4 city with 3 charges.
- **Risks:** Hidden information on a shared screen needs a pass-the-device ritual; it's clunky. Balance requires bot playtesting of both roles. A defender who just walls up may make it dull; budgets must favour wires.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### CH-16 Cityfall
- **Pitch:** The buildings are the dominoes: a skyline of loose-cube towers; push one and the city falls building into building, and you bridge the gaps with girders.
- **Fun hook:** Dominoes at the scale of skyscrapers. Slow, heavy, disastrous. Each tower is an unreliable domino (it may crumble instead of tipping), so you are picking the push point on the first tower and placing a few girders (long slabs) to carry the fall across wide streets. Spectacle with a puzzle spine.
- **Borrowed from:** Destruction-physics toys (crush a city), domino stunts with big pieces, bridge-builder budgets for the girders.
- **Loop:** 30 s: spin around the city, place 3 girders, push the first tower with a wrecking ball, watch 9 towers fold one into the next, see where the chain broke. 5 min: city levels where crowns sit on the last tower, heritage on parks and churches between towers.
- **Scale story:** 1k: 5 small towers. 10k: a Domino Boulevard (already designed: 36 slender towers in a spiral). 100k: a downtown grid of 120 towers in 6 avenues where the fall must turn corners; sleep keeps unreached blocks free.
- **Uses today:** city and building scenarios (S4, S14), slender towers (B4 Domino Boulevard draft), crowns, heritage, footprint, wrecking ball and bowling ball, look=real dust and stone.
- **Needs new:** girder placement (spawn slab at rest; S, low); settle window longer than 30 s for long boulevards (S, low; the B4 note shows a 30-column chain overran settle v1); possibly welds (step 7) to make towers tip as units rather than crumble (L, med; optional).
- **Level seeds:** (1) "Five Sisters": 5 towers in a line, 2 girders, push the first. (2) "Corner Shop": the line turns 90 degrees at a church (heritage); the fall must use a girder to turn. (3) "Downtown": 100k, 120 towers, crowns on the far tower, 6 girders.
- **Risks:** Loose-cube towers crumble more than they topple, so the chain may break often. The Rapier probe on B4a showed 6-15 column chains work but long ones stall, and the M5 Max runs must confirm. A real domino-like tip needs slender, well-bonded towers (bond patterns) or welds.
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 4 / cost 4

### CH-17 Synchrony
- **Pitch:** Chain length is a clock: lay several runs from one push so that their crowns all fall within a 0.2 s window, or in a specified order.
- **Fun hook:** A timing puzzle you can hear. Matching lengths around obstacles (a long detour versus a short ice segment) is a measurement game, and a perfect sync ends with all the bells ringing at once (a chord). Near misses are audibly "flammed", which is a great failure signal.
- **Borrowed from:** Synchronised-firework shows (a choreographed finale), timing-based puzzle games (route lengths as delays), relay races.
- **Loop:** 30 s: a hub with a push and 3 crown bells at different distances, draw 3 runs, push, read the sync graph (bell times). 5 min: levels with "order" (ring C before A before B), "simultaneous AND gate" (a heavy slab only falls if hit by two fronts at once), and stars on window size.
- **Scale story:** 1k: three bells. 10k: twelve bells in a ring around a pyramid; the finale chord topples the pyramid. 100k: a field where hundreds of branches must arrive at a wall at once for a "curtain drop" reveal.
- **Uses today:** watched bodies (time of fall of up to 64 targets), determinism, crown chimes (crown-down notes as a chord), stroke placement (from CH-1).
- **Needs new:** time-of-fall readout per watched target (S, low); predicted delay readout while drawing (S, low; an estimate from length).
- **Level seeds:** (1) "Three Bells": equal lengths around a lopsided obstacle. (2) "Countdown": bells must ring in order 5-4-3-2-1 at 0.5 s spacing. (3) "Double Hit": a heavy slab only topples when hit by two runs within 0.1 s.
- **Risks:** Wave speed variance (corners slow fronts) makes timing a little noisy, but determinism makes it repeatable, so it's learnable. Pure timing may feel spreadsheet-like without good audio feedback.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 5

### CH-18 Long Fall
- **Pitch:** A roguelike run where one continuous chain must survive floor after floor; you draft special dominoes between floors, and if the chain ever stops the run ends.
- **Fun hook:** A deck of domino types becomes your build: splitter dominoes (wide, fork the wave), boosters (a little grenade that kicks the next segment), tall dominoes that leap gaps, heavy ones that knock over iron walls. Chips x mult scoring: chain length times multipliers from special pieces. Each floor is a gap you must solve with the cards you have.
- **Borrowed from:** Deck-building roguelikes (draft between fights, synergies, runs), poker-hand-scoring roguelites (chips x mult), and the house BREAKLINE concept.
- **Loop:** 30 s: a floor with a gap, a ramp and a wall; place 3 drafted pieces plus filler, push, survive. 5 min: an 8-floor run with a boss floor (a 10k field reveal where coverage x mult is the score), shop between floors, meta unlocks.
- **Scale story:** 1k: early floors. 10k: boss floors. 100k: the final floor, a field spectacle where your multiplier pieces seed fireworks across it.
- **Uses today:** WeaponSpec (booster and firework pieces), materials and sizes (heavy, ice, rubber, tall), spawn, count-fallen, bot for difficulty checks, slammed tally from BREAKLINE.
- **Needs new:** run framework (draft, shop, meta; M, low); piece catalogue as data (S, low); a "chain continues" state carry across floors (each floor is a new scene seeded by the last domino's motion; M, med).
- **Level seeds:** (1) Floor "The Gap": a 1.5 m gap; a tall domino card or a plank card solves it. (2) Floor "The Fork": two exits with different rewards; a splitter takes both. (3) Boss "The Garden": 10k field, score coverage x mult.
- **Risks:** Roguelikes need lots of content and balancing. Draft choices must be meaningful physically, not just numbers. Probably a second mode after the core is proven.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 2

### CH-19 Amplifier (wild)
- **Pitch:** Each domino is 1.5 times the size of the last; a fingertip flick on a 1 cm tile ends 25 pieces later with a 300 m slab crashing onto a city.
- **Fun hook:** Geometric growth is visceral. It is a known physics fact that a domino can topple one about 1.5x its size. The first pieces are tiny ticks, the middle ones thud, and the last ones are falling buildings with dust and thunder. Puzzle: you choose the growth ratio per step (greedy ratios fail) and where the final slab lands.
- **Borrowed from:** Physics-demo domino amplification (doubling chains), "zoom out" scale-shift games (the powers-of-ten feeling), golf (aim the final landing).
- **Loop:** 30 s: set 8 ratios (1.2-1.7) on a short ramp of sizes, flick, hear the pitch drop through octaves, see if it reaches the end. 5 min: levels where the final slab must flatten a target block in a city, avoid heritage, and use the fewest pieces (higher ratios).
- **Scale story:** Scale is the domino size, not the count. 1k / 10k / 100k is the city the last slab lands on: at 100k the final slab is a meteor into a sleeping metropolis.
- **Uses today:** box any half-extents (one body per domino, so cheap), modal synth (pitch by size gives a falling glissando), look=real dust, the city scenarios, determinism.
- **Needs new:** a stability check across a mass ratio of about 10^6-10^9 between first and last body (AVBD is better than most at mass ratio, but untested; M, high). Adaptive time step or substeps because tiny dominoes fall fast and big ones slow (M, med). Camera framing across five orders of magnitude without auto-motion: player zoom with a preset "zoom ladder" (S, low).
- **Level seeds:** (1) "Pocket to Porch": 1 cm to 2 m in 12 pieces. (2) "Tower Tumble": 25 pieces, the last 120 m slab must land on a crown tower. (3) "Meteor": 30 pieces, final slab into a 100k city with a heritage cathedral that must survive.
- **Risks:** Very high mass and size ratios might break the solver or contact detection (thin small pieces against huge ones). Time-scale mismatch: tiny pieces need tiny steps. It's spectacle-first; the puzzle is thin. But it's the single most "wow" clip this lens offers.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 2 / cost 3

### CH-20 Refractory (wild)
- **Pitch:** A living domino field where every fallen domino stands back up after a few seconds, so waves circulate forever as spirals and pulses you can sculpt.
- **Fun hook:** It turns the field into an excitable medium (like heart tissue or a forest-fire automaton). A wave can only pass where dominoes have regrown, so you get spiral waves, target patterns and wave collisions, all from physics. You tap, cut and nudge to grow a self-sustaining spiral: hypnotic, and new for a physics game.
- **Borrowed from:** Cellular-automaton forest-fire and excitable-media toys (refractory periods, spiral waves), zen sandboxes (the house Rubble Garden concept: wake glow, regrow), music toys (patterns as performance).
- **Loop:** 30 s: tap a point, a ring expands, cut it with a drag, its broken end curls into a spiral that keeps turning. 5 min: challenges like "keep a spiral alive for 60 s", "make two spirals collide", "paint a target pattern"; or pure zen with ambience.
- **Scale story:** 1k: pulses on a tabletop. 10k: one stable spiral. 100k: multiple spirals with interacting cores; at this scale it truly looks like a living tissue. Awake set = the wave bands plus regrowing pieces, still a fraction of the field.
- **Uses today:** remove + spawn at rest (regrow can be done today as events), sleep, Regrow animation design (fly-home), wake glow, the pentatonic audio.
- **Needs new:** a bulk "regrow" engine op (reset a body to its home pose after a refractory timer, GPU-side, without an event per body; M, med); per-body timer state (S-M, low); replay is still determinism-safe if regrow is a pure rule.
- **Level seeds:** (1) "Heartbeat": keep a pulse source alive at 1 Hz. (2) "Spiral": grow one spiral from a broken ring. (3) "Storm": 100k, two spirals must annihilate, then leave the field calm.
- **Risks:** It is close to a cellular automaton, so physics may add little except look and sound; need to prove physics-specific behaviour (fronts curving around heavy pieces) matters. Teleporting regrow is "unreal" but can be dressed as dominoes springing back. Needs a playtest to see if it is a toy or a game.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 3 / cost 3

### CH-21 Gapfill
- **Pitch:** Bite-size puzzles: a prebuilt run with exactly K gaps and a tray of exactly K pieces; place each piece in a gap so one push hits every target.
- **Fun hook:** A tight, solvable puzzle with physics deciding the answer. "The ball goes in gap 3, the tall domino goes in gap 1" is a crisp deduction, and running it is a quick, satisfying check. Perfect first-minute onboarding to the chain lens.
- **Borrowed from:** Part-bin puzzle mode (missing parts only), logic grid puzzles (each piece in one slot), mobile physics puzzles (one-screen, under a minute).
- **Loop:** 30 s: a 1-screen run with 3 gaps, a tray with a plank, a ball and a tall domino, place, push. 5 min: 12 puzzles a chapter, then a daily.
- **Scale story:** 1k: the whole mode. 10k / 100k: chapter finales where the tiny solved run triggers a field. Honest: small-scale mode.
- **Uses today:** spawn, spheres and boxes, materials, crowns, bot verification (solution uniqueness and robustness via the basin gate).
- **Needs new:** slot snapping UI (S, low); a uniqueness checker for authored puzzles (bot enumeration of K! placements; S, low).
- **Level seeds:** (1) "Hop": a gap needs the tall domino to bridge it. (2) "Roll": a ball must roll off the run onto a slab ramp to a second run. (3) "Wedge": a cube must go under a plank to form a seesaw that launches a marble.
- **Risks:** Small and predictable; low spectacle. Content-hungry. Good as tutorial chapter for CH-1 and CH-8.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 5

### CH-22 Oracle
- **Pitch:** A party mode: everyone bets on which of 5 bells rings first, where the wave dies, or how many fall, then the run plays.
- **Fun hook:** Spectator sport tension. Shouting at a wave front is fun, and physics chaos is the entertainment. Each player can spend tokens on one "nudge" (add or remove a domino) before the run, so it is part betting, part sabotage.
- **Borrowed from:** Marble-race spectator channels (pick your marble, cheer), horse-racing betting, plinko and pachinko boards.
- **Loop:** 30 s: see the board, place bets, spend one nudge, run, payout. 5 min: a 6-race evening with a leaderboard and comeback multipliers.
- **Scale story:** 1k: a racetrack. 10k: 8 fronts racing through a field maze. 100k: a grand race map, with multiple fronts and a picture reveal finale.
- **Uses today:** determinism (the outcome is fixed once nudges are in; perfect for fair betting on one device), hot-seat, sleep, crowns as finish bells, watched bodies for times.
- **Needs new:** betting UI and token economy (S, low); race track prefabs (S-M, low).
- **Level seeds:** (1) "Five Lanes": five runs with different materials, which bell rings first? (2) "Over/Under": guess the number fallen in a 10k field to the nearest 500. (3) "Saboteur": each player has one removal to kill another's lane.
- **Risks:** It needs a group and a big screen; solo play is thin. Without cross-device lockstep it's local only.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 5

### CH-23 Heist
- **Pitch:** Use a quiet domino run to nudge a gem off a pedestal deep inside a vault full of alarm blocks that must not move.
- **Fun hook:** Precision and restraint, the opposite of Keystone's smash. The chain is the only tool that can turn corners and go through a vent, and every piece that strays touches an alarm block. Watching the last domino gently tip the gem is a delicious, quiet win.
- **Borrowed from:** Stealth puzzle games (avoid detection zones), the operation board game (don't touch the edges), heist planning (route a delivery).
- **Loop:** 30 s: plan a route through a vent slot (gap between heritage blocks), lay 20 dominoes, push, alarm or gem. 5 min: 8 vaults with tighter vents, ice floors (dominoes slide when they fall), and lasers (watched volumes where any motion fails).
- **Scale story:** 1k: a vault. 10k: a museum with many vaults where the alarm blocks are the exhibits. 100k: a city block with sleeping buildings as "alarms"; your run must cross without waking any.
- **Uses today:** heritage constraint (alarm blocks), predicates on displacement (laser volume = bbox predicate), crowns (the gem), spawn, stroke placement.
- **Needs new:** "volume alarm" observer (any awake body inside a box fails; S, low, it's a predicate); stroke placement from CH-1 (S).
- **Level seeds:** (1) "Vent": the gem sits behind a 1.2 m slot; a run must go through it. (2) "Glass Floor": an ice floor where fallen dominoes slide into alarms unless the run is short. (3) "Gallery": a 10k museum with 6 alarm statues; the run must snake between them.
- **Risks:** Low spectacle, which Will values; a quiet mode. Thin-wall collisions near heritage might wake them through tiny contacts (sleep false wakes); needs care with thresholds.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 5

### CH-24 Breakwater
- **Pitch:** Stack a seawall from a block budget, then a tsunami of 10k falling heavy slabs rolls in; whatever village is left standing is your score.
- **Fun hook:** Build-then-test, like sandcastles before a wave. Domino fronts of heavy slabs are a relentless mass; you decide where to stack (a tall wall that may topple onto your village or a low wide one), and the test is gorgeous and violent.
- **Borrowed from:** Bridge-builder stress tests (build then load), sandcastle-vs-tide play, tower-defence build phases, and Jenga stacking feel during the build.
- **Loop:** 30 s: stack 40 blocks with live physics (so stacks can fall while building), lock, release the wave, watch. 5 min: waves grow (heavier slabs, faster ice fronts, multiple angles), and the village asks for different walls.
- **Scale story:** 1k: a garden wall. 10k: a coastal town with a 10k-slab wave. 100k: a long coast, many villages, and you choose which to defend with a fixed budget.
- **Uses today:** spawn at rest (stacking), Kapla planks (the plank tower feel Will loved), heritage (the village), materials (iron for heavy slabs), sleep, collapse readouts.
- **Needs new:** live stacking UI with snapping and a stability preview (M, low); wave prefabs of slabs (S, low); "lock then release" phase manager (S, low).
- **Level seeds:** (1) "Garden Wall": a 40-block budget, a single front. (2) "Two Fronts": waves from two angles; a corner wall is needed. (3) "Coastline": 100k, three villages, budget for two walls.
- **Risks:** Stacking in a browser with a mouse is fiddly; snapping and a grid help. A tsunami of slabs might just bulldoze every wall (tuning). It might be more fun as a destruction spectacle than as a puzzle.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 3

### CH-25 Weekline
- **Pitch:** A persistent daily build: add 500 dominoes a day to one ever-growing world line; on Sunday you push it and watch the whole week fall.
- **Fun hook:** Investment and appointment play. Each day's build is a small creative puzzle (today's theme: "a bridge", "a spiral", "a stair"), and the Sunday push is a weekly event. Did Wednesday's sloppy corner kill the week? That tension builds all week.
- **Borrowed from:** Daily-cadence games (one puzzle a day, a shared seed), life-sim daily progression (come back tomorrow), the TV-record build-for-weeks structure.
- **Loop:** 30 s: today's segment shows a theme and a budget; draw it on the end of the line, test-run only your segment. 5 min: build your segment carefully; on Sunday, the push and a replay of the full week.
- **Scale story:** 1k: day one. 10k: week three. 100k: month-scale lines that cross the whole map, mostly asleep; the Sunday push is a multi-minute event (watched with an opt-in follow cam and a wave map).
- **Uses today:** spawn at rest, sleep, determinism (the week's replay from compact strokes), in-browser progress storage (it is per-viewer, which is fine for a solo mode).
- **Needs new:** persistent world save (browser storage; S, low, but fragile: storage can be cleared, so export a file too); segment test-run in isolation (S, low); long-run window (S); compact stroke format (S).
- **Level seeds:** (1) Week theme "Bridges": every day includes a plank bridge. (2) Week theme "Materials": Monday ice, Tuesday rubber, and so on. (3) "Month line": 30 days, 100k dominoes, the finale crosses a 10k city and topples its tower.
- **Risks:** Retention mechanics only work once the core is fun. Browser storage loss would destroy weeks of work (export saves). The Sunday run might be long; fronts take minutes for a long line.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 4 / cost 4

---

## Capability primitives this lens keeps needing

| Primitive | Effort / risk | Needed by |
|---|---|---|
| **Stroke placement** (draw a path; auto-spaced, tangent-aligned dominoes) | S / low | CH-1, 7, 9, 13, 17, 21, 23, 25 |
| **Compact stroke events** (a run is one event, so replays stay ~200 bytes) | S / low | CH-1, 2, 7, 13, 25 |
| **Spawn asleep** plus persistent sleeper grid (100k field starts at zero cost) | S-M / med (E2 roadmap) | CH-2, 3, 6, 7, 12, 13, 16, 20, 25 |
| **Sleep that does not freeze a slow tip** (quiet-for-N-steps or tilt-aware test) and stable sleeping leaners | S / med | every domino idea; critical for CH-10, 2, 13 |
| **Longer run window** than settle v2's 30 s for large fields and long lines | S / low | CH-2, 13, 16, 25 |
| **Static / pinned bodies** (ramps, shelves, troughs, walls) | S / low | CH-1, 8, 21, 23 |
| **2D wave-map overlay** (front and fallen map; a picture, not camera motion) | S / low | CH-1, 2, 3, 6, 7, 13, 25 |
| **Opt-in front-follow camera** (off by default, per Will's rule) | S / low | CH-7, 13, 16, 25 |
| **Live-play input** (events land while physics runs; no freeze) | S / low | CH-3, 7, 24 |
| **Contact-propagated tag** (a woken body inherits its toppler's tag) | M / med | CH-6; also improves shot ink and debugging for CH-2, 5, 17 |
| **Per-face tint** (picture revealed on fall) | S-M / low | CH-2, 13 |
| **Time-of-fall / impact timestamps** for watched bodies | S / low | CH-4, 14, 17, 22 |
| **WeaponSpec charge socket preset** (near-body trigger at rest) | S / low | CH-9, 12, 15, 18 |
| **Set-material event** on a resting body | S / low | CH-11, 18 |
| **Bulk regrow** (reset to home pose by rule, GPU-side) | M / med | CH-20, also Rubble Garden-style retry |
| **Joints** (step 7: pendulums, hinges, levers, welded towers) | L / med | CH-8 (core), CH-16 (optional) |
| **Large mass/size ratio stability + adaptive steps** | M / high | CH-19 |

## My top 5 and why

1. **CH-9 Fuse Line**: the best engine fit and Keystone fit. Dominoes become the timing fuse for real demolition sequencing; WeaponSpec near-body triggers, footprint, heritage and collapse already exist. It gives the spectacle Will loves (a tower folding into its lot) a puzzle spine about order and delay.
2. **CH-3 Firebreak**: the most immediate fun. Live, readable pressure, and cheap: remove plus spawn while physics runs. It scales well, because a 100k valley has only fronts awake, and the triage choices grow with the map.
3. **CH-2 Wakefield**: the purest "scale changes the experience" idea. At 100k the field becomes a picture, and sleep makes it real-time because only the front is awake. It needs per-face tint and spawn-asleep, which are both on the path anyway.
4. **CH-16 Cityfall**: builds directly on the already-designed Domino Boulevard and the city scenarios. Skyscraper dominoes are top-tier spectacle; the girder budget makes it a puzzle. The B4 probe already shows the chain length limits to design around.
5. **CH-7 Outrun**: the most novel loop. You are laying track with your own chain chasing you. It's a cheap prototype (live input plus stroke placement) and its trail turns sleep into a souvenir. The camera rule is the design risk to solve with edge-pan, not auto-follow.

Wild card to prototype if there's a spare day: **CH-19 Amplifier**. It is one short scene file and would show at once whether AVBD survives extreme mass ratios, which is worth knowing for every mode.
