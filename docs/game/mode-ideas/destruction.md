# Destruction and demolition lens: 24 game-mode ideas (prefix DE)

Lens: controlled demolition, siege and artillery, weapon crafting with `WeaponSpec`, spectacle and slow motion, structural engineering run backwards, kaiju and disaster set pieces, precision against brute force, rubble physics, destruction as score attack, and destruction under constraints.

What every idea assumes from the brief: there are only boxes and spheres, there are no joints and no kinematic bodies, the inputs are `spawn` / `blast` / `remove` events, weapons are `WeaponSpec` munitions, rules read observers (reductions and 64 watched bodies), and determinism holds per device only. "Today" means it can be built on what exists, with game-side code only.

Three engine observations that come up again and again below:

1. **A uniform kick of the whole world is possible today.** A blast centred very far away, with core 1 (flat), a large impulse and `maxDv = v`, gives every body in range exactly `v` in almost the same direction, because the cap binds for every shape. Kicking every body at once is the same as jerking the ground the opposite way. That is an earthquake, or a "tilt the world" shove, with no new engine work. The catch is that `TieredEngine` refuses blasts, so at 100k this needs step 8.
2. **`remove` is the precision tool, and it pairs badly with sleep.** Removing the block under a sleeping body is not an impact, so the body may not wake. A "remove wakes everything touching it" rule is a small but necessary engine ask for the remove-heavy modes (DE-11, DE-12, DE-14, DE-23).
3. **Pausing mid-collapse is cheap.** Stopping the stepper and pushing an event at the current step is replay-safe, since a session is just `(level, shots-with-step)`. What is missing is game rules, not engine work: quickdraw has no attribution or baseline rules yet.

---

### DE-1 Implode
- **Pitch:** A demolition contractor's sequencer: put cutting charges on the columns, set their timing on a timeline, press PLUNGER, and drop a 10k tower into its own lot without touching the neighbours.
- **Fun hook:** The real demolition craft is the *order*: cut the core first so the building folds inward, then the perimeter. Too fast and it topples sideways onto the church; too slow and it hangs up half-standing. The first 30 s go like this: you drag three charges onto a timeline, hit the plunger, and watch a building kneel. Every attempt is a hypothesis you test.
- **Borrowed from:** Real implosion practice (delay-sequenced charges); rhythm and sequencer toys (a timeline you scrub); the plan-then-run loop of *Poly Bridge* and *The Incredible Machine*.
- **Loop:** 30 s: place or retime 1 to 3 charges, fire, watch, read the footprint overlay. 5 min: iterate on one tower until the rubble pile is low, centred, and the neighbours are untouched. Then the next contract adds a cantilever, a lean, or a glass neighbour 1 m away.
- **Scale story:** 1k is a parking-garage slab, where sequencing barely matters. At 10k a tower has a real core and perimeter, and the fold direction is what you are playing for. At 100k a city block holds three towers and their neighbours, and sleep keeps the street cheap while only the blast zone is awake.
- **Uses today:** `remove` events as "cuts" (a removed column block is a severed column), small `blast`s as kicker charges, the `footprint` and `heritage` constraints (neighbours are heritage), the collapse fraction, the PE reduction, the bbox reduction for spread, and replays.
- **Needs new:** A timeline UI that places events at step offsets (M, low). Several events per "shot" in the Driver, so that one plunger fires many timed events (S, low). Remove wakes neighbours under sleep (S, med). A "rubble height" score from the heightmap/histogram reduction (S, low).
- **Level seeds:** (1) "Tight Lot": a 2k slab block with a heritage chapel 1.5 m to the east; four charges max. (2) "Lean": a pre-tilted 8k tower that wants to fall the wrong way, so you must fold it against its lean. (3) "Twin Cores": two 6k towers on one podium; both must drop, and the gap between them is a footbridge that must not fall on the street.
- **Risks:** Box-only structures held by friction may collapse "too easily", so precise sequencing would not matter. Levels need stiff, tall, heavy-cored designs where a bad order really does topple. The timeline UI could feel like work rather than play.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### DE-2 Rampart Duel
- **Pitch:** Hot-seat siege: each player has a castle with a king block; turns alternate one shot each from a shared armoury, the rubble persists, and the first king to hit the dirt loses.
- **Fun hook:** Every shot is attack *and* exposure. Knocking down their wall also builds a rubble ramp that your next cannonball can roll up, or a rubble berm that shields them. The first 30 s are the first volley and the "oh no" as your own tower wobbles from the aftershock.
- **Borrowed from:** *Worms*, *Scorched Earth* and *Gunbound* (angle, power, wind, turn-based artillery); *Castle Crashers*-style siege duels; the "sudden death" rising-water timer from *Worms*.
- **Loop:** 30 s: aim, fire, watch, pass the device. 5 min: a full match of 6 to 12 volleys, with weapon draft picks between rounds.
- **Scale story:** At 1k each castle is a wall and a keep, and the matches are fast and lucky. At 10k the castles have inner baileys and the duel becomes a breach-then-strike plan. At 100k there are two fortified hilltop towns, and a shot's collateral collapses persist for the whole match (sleep keeps it cheap).
- **Uses today:** Real projectiles, built-in weapons, the crown objective (the king is a crown, knocked off when below the line or outside the lot), freeze while aiming, and per-device determinism, which is fine because hot-seat is one device.
- **Needs new:** Two-player turn state, with a per-player rack and a wind value (S, low). Wind as a constant horizontal kick on the projectile, which needs step-6 sparse forces on the live munition, or a simple model where the launch velocity is pre-bent by the wind (S, low). A "sudden death" rule that, after N turns, drops an anvil on a random spot each turn (S, low).
- **Level seeds:** (1) "Ford": two keeps on either side of a ditch, plaster. (2) "Glass Houses": ice-block keeps (mu 0.05) that slide apart if you so much as sneeze. (3) "Kapla Joust": two 2k plank towers 30 m apart, where the king sits on the top plank.
- **Risks:** Turn-based play with long settles drags. You need the tail-skip fast-forward. First-player advantage needs mirrored or random-start balancing.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 5 / cost 5

### DE-3 Forge & Fire
- **Pitch:** Build one weapon in a node-graph forge with a fixed budget of grenades of yield, then carry that one weapon through a five-level gauntlet with no swapping.
- **Fun hook:** You are designing a tool for problems you have only glimpsed: the gauntlet's levels are shown as thumbnails. A cone of 12 shaped charges is great against walls and useless against a pyramid. The first 30 s are when your first homemade firework pops off *just* as you hoped, or hilariously wrong.
- **Borrowed from:** *Noita* (wand building: modifiers, triggers, multicast), *Besiege* (build then test), *Kerbal Space Program* (staged rockets as staged munitions), and roguelike loadout commits.
- **Loop:** 30 s: tweak one rule (a split count, a trigger delay), test-fire it in the proving range, and read the yield bill. 5 min: lock the weapon and play the gauntlet, where each level scores collapse per grenade of yield.
- **Scale story:** At 1k, cheap single-blast designs win. At 10k, splitting and spreading matter because one blast cannot reach far enough. At 100k (with tiered blasts, step 8) the weapon needs depth-3 trees and carpet patterns, and the 256-body budget becomes the real constraint.
- **Uses today:** The whole `WeaponSpec` (triggers `after`/`near`/`apex`/`then`/`any`; actions `blast`/`remove`/`split` with patterns), `validateWeapon`, `weaponBudget`, `weaponYield`/`grenadeEnergies` as the price tag, and the viewer's Download weapon.
- **Needs new:** A forge UI, as a node graph or card stack over the spec, with live validation (M-L, med: it is the whole product). A proving-range level (S, low). Gauntlet sequencing (S, low). Later, the `contact` trigger and relative spawn (step 5) make designs reliable at any reader cadence (M, med).
- **Level seeds:** (1) "Mixed Bag": a wall, a pyramid, a Kapla tower, a city block, and a heritage-flanked tower, in that order. (2) "Air Defence": every target sits on a tall plinth, so apex-split designs shine. (3) "Ice Week": every level is ice blocks, so low-impulse, wide-spread weapons win.
- **Risks:** Spec authoring is fiddly. Most players want presets plus 3 or 4 sliders, not a graph. The yield price must be legible ("1.7 grenades"). Balance: one dominant design would kill the mode.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 2

### DE-4 Rubble Writ
- **Pitch:** Destruction that builds: knock a structure down so that its rubble lands in a target silhouette marked on the ground, such as a letter, an arrow, or a dam across a channel.
- **Fun hook:** Every shot is aimed at where the debris *ends up*, not at the building. The first 30 s go like this: the ground shows a ghost "L", you topple a tower along the long stroke, it lands 70% inside the outline, and you need a second, sideways shot for the foot.
- **Borrowed from:** *Picross* and silhouette puzzles (match a target shape); sand painting; *Tetris* line-fill satisfaction; *Bad Piggies* "build out of what you have".
- **Loop:** 30 s: one shot, then the target grid lights up cells as filled or missed. 5 min: a page of 5 glyph levels, where the stars go to fill fraction minus spill outside the outline.
- **Scale story:** At 1k the outlines are chunky glyphs. At 10k a shape spans a whole plaza, and rubble flow (granular spreading) is the medium. At 100k you write a *word*: several buildings each become one letter, and the writing reads from the camera.
- **Uses today:** The histogram reduction over ground cells (bodies per xz cell), the footprint machinery (a lot is a shape), collapse, the rack, and banking.
- **Needs new:** A 2D occupancy-grid reduction with a target mask: fill and spill counts as integers (S-M, low). A ground-decal renderer for the outline (S, low). A level format for target masks (S, low).
- **Level seeds:** (1) "Arrow": a 1k colonnade that must fall into an arrow pointing at the next level button. (2) "Dam": topple a 5k tower across a marked channel; the score is fill of the channel cells only. (3) "Signature": three 3k towers, and the letters T, B, and ! below them.
- **Risks:** Chaos may make precise shapes impossible, so the outlines should be generous and the stars cast by the bot. "Where does the rubble go" is hard to read before the shot.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

### DE-5 Scree Course
- **Pitch:** Two phases: demolish to *make* terrain, then roll a ball through it. You blast a cliff of blocks into a rubble ramp, then launch one marble that must ride your scree to a flag past a wall.
- **Fun hook:** You are a terrain sculptor with explosives, and the second phase grades the first. A beautiful collapse that leaves a 2 m step is a dead end. The first 30 s: blast, look at the slope, release the marble, and watch it hop the last lip.
- **Borrowed from:** Golf course design and putting; *Lemmings* (change the terrain to route the walker); *Marble Madness*; *Trials* (terrain readability).
- **Loop:** 30 s: one shaping shot or one ball run. 5 min: up to 3 shaping shots and 3 ball attempts. Stars for the fewest shaping shots and the most rack left.
- **Scale story:** At 1k a ramp is coarse and the ball bounces off cube edges. At 10k the rubble is gravel-like and smooth enough to roll on, which is the sweet spot. At 100k (with sleep) you shape a valley, and the ball's run is a long ride.
- **Uses today:** Spawn (the ball at rest or with a launch velocity), blasts, rack weapons, and a crown-style goal on a watched body (the ball's position within the flag zone). Bounce off is better for rolling.
- **Needs new:** A two-phase level rule: shaping shots, then a "run" item that is scored differently (S, low). A goal-zone predicate on a watched body, which mostly exists via crowns (S, low).
- **Level seeds:** (1) "Over the Wall": a 2 m wall with a heap of blocks in front; blast the heap into a ramp. (2) "Gorge": two plateaus of blocks with a gap between; drop one into the gap to make a bridge of rubble. (3) "Switchback": a tall stack that must be felled in two directions to make a zigzag.
- **Risks:** Rolling a sphere over cube rubble is jittery: the ball could stall on an edge. Stars need the bot to model two phases, which doubles casting time.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 4

### DE-6 Safe Room
- **Pitch:** Destruction in reverse: you get 40 blocks and 60 s to build a shelter around a fragile egg (a watched sphere), and then *your own* rack of grenades brings a 5k tower down on top of it.
- **Fun hook:** You are both the engineer and the wrecker. Stacking a lean-to that survives tonnes of plaster is a different instinct from Jenga: you want a roof that sheds. The first 30 s: three slabs as a tent, plunger, debris rains, and the egg survives or cracks.
- **Borrowed from:** The egg-drop school competition; *Bridge Constructor* stress tests; *Fort Boyard*-style "survive the trap"; the build phase of tower defence.
- **Loop:** 30 s: place 3 to 5 blocks, then test. 5 min: a 40-block budget with three escalating collapses (a tower, a city block, a Kapla avalanche).
- **Scale story:** At 1k a few blocks fall and any roof works. At 10k the load is real, and only arches of slabs angled into each other survive. At 100k a whole street falls, and the shelter must also not get buried (the egg must stay "reachable", that is, close to the surface).
- **Uses today:** Spawn at rest (placing blocks, which Keystone already does), watched bodies (the egg), and blasts and the rack.
- **Needs new:** A placement UI with snapping and a block budget (M, low; shared with the stacking lens). An egg damage model: peak deceleration or contact impulse on the watched egg, from per-step velocity deltas on watched bodies (S, med; noisy with AVBD). Better would be a peak contact impulse readout for watched bodies (M, med).
- **Level seeds:** (1) "Porch": the egg at the foot of a 1k chimney that you then fell. (2) "Basement": the egg on the ground floor *inside* a 5k building. (3) "Plank Rain": the egg under a 3k Kapla tower. Planks spear down, so slabs must deflect them.
- **Risks:** The egg-damage threshold must feel fair: AVBD contact noise could "crack" eggs resting under static loads. Building UIs are slow. Stars need the bot to build, which is costly to cast.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### DE-7 Stomp Path
- **Pitch:** You are the kaiju: plot a path of giant footsteps through a 100k city under a stamina budget, flattening the target districts while sparing the hospital and the stadium.
- **Fun hook:** Each step is a huge box foot (a 20 t slab) dropped from height. Where you put your feet decides what falls, and the shockwave of a step topples the towers beside your path. A tail swipe (a wide blast) costs triple stamina. The first 30 s are the first stomp into a city at rest: dust, chimes, a tower kneeling two streets away.
- **Borrowed from:** *Rampage* and kaiju games (city as a toy); *Katamari Damacy* (escalating scale); *Into the Breach* (plan steps on a grid, see the telegraphs).
- **Loop:** 30 s: place 2 or 3 footsteps on the map, then commit; they land in sequence. 5 min: cross the city from the bay to the reactor; the score is target districts levelled minus spared ones hit.
- **Scale story:** At 1k it is a toy village, a gimmick. At 10k a single district works. 100k is the point: a skyline to wade through, with sleep making the 95% you have not reached free, and the awake set travelling with the monster.
- **Uses today:** `spawn` (a huge box foot with a downward velocity), `remove` (lift the foot after it settles), `blast` (the step's shockwave, the tail swipe), the skyline objective per district, heritage (the hospital), and the rack as stamina.
- **Needs new:** Per-district skyline/collapse via region-masked reductions (S, low). The full sleep work plus compaction for 100k real-time (L, med; already planned). Tiered blasts at 100k (step 8; M, med). A footstep planner UI on a top-down map (S-M, low). The camera stays player-driven, per Will's rule.
- **Level seeds:** (1) "Harbour Front": 20k, a straight wade. (2) "Downtown Detour": 60k, where the hospital sits on the direct line, so you must route around it while toppling the bank. (3) "Night Shift": 100k; the reactor dome (spheres in a box) is the final target.
- **Risks:** Real time at 100k depends on the sleep path landing. A foot made of a box has no animation: it could look like a falling crate, not a monster (art direction, such as a footprint decal and dust, carries it). It might feel sandboxy without strong targets.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 3 / cost 3

### DE-8 Never Settle
- **Pitch:** A spectacle score attack where the combo lives as long as the world is moving: chain shots into the running collapse to keep the multiplier alive, and bank when you dare.
- **Fun hook:** A *Tony Hawk* combo transplanted to collapse. `nMoving` above a floor keeps the chain alive, every shot fired while the chain is alive adds +1 multiplier, and if the world settles before you fire, the combo cashes out. Fire too early and you waste the energy; too late and you lose the chain. The first 30 s: fire, watch the meter tick down, and fire again *just* before it dies.
- **Borrowed from:** *Tony Hawk's Pro Skater* (combo kept alive by manuals; bail loses all); *Burnout* (crash-mode multipliers); *Peggle* (fever finish).
- **Loop:** 30 s: one combo chain of 3 to 6 shots. 5 min: a 90 s timed run over a city with a rack of 12. The score is sum(points x mult), with points = PE released per shot.
- **Scale story:** At 1k the world settles fast, so combos are short and twitchy. At 10k collapses run for seconds and the chains get long and luxurious. At 100k the chain can wander across a city: aim at the edge of the awake region to wake new ground.
- **Uses today:** The `nMoving` reduction (planned for settle v2, being built), PE, the rack, weapons, and the `keystone.quickdraw` option (an unspecified rule set).
- **Needs new:** Quickdraw rules: per-shot attribution by the energy released between shots, and a "chain alive" predicate (S-M, low). A HUD combo meter (S, low). The valve's slow-motion tag fits naturally as "hype". The bot cast: stars from a quickdraw bot policy (M, med: the bot must decide timing).
- **Level seeds:** (1) "Avenue": a 6k row of towers that topple into each other if you keep it going. (2) "Quarry": 10k loose scree that never quite stops. (3) "Ice Hotel": ice blocks slide forever, an easy chain but low PE per shot.
- **Risks:** Chaos plus timing makes casting noisy. "Keep it moving" could reward spam, so it needs a minimum PE per shot to count. With quickdraw, the shot attribution debates get re-opened.
- **Scores (1-5):** fun 5 / novelty 4 / engine fit 4 / cost 4

### DE-9 Stopframe
- **Pitch:** Bullet-time demolition: at any instant of a running collapse you can freeze the world, orbit the frozen debris, and place one more shot into the air.
- **Fun hook:** A frozen collapse is a puzzle you could never read in real time. A tower is mid-fall, so a blast *now* under its top third flings it over the heritage chapel instead of onto it. The first 30 s: freeze a cannonball impact at the moment of contact, look at the cloud, and drop a grenade into the debris crown.
- **Borrowed from:** *SUPERHOT* (time as a resource), *Max Payne* bullet time, *Burnout*'s Crashbreaker (detonate mid-crash), and the *Worms* "freeze to aim".
- **Loop:** 30 s: shot, freeze, look around, add a shot, release. 5 min: a level with 2 freezes and a rack of 4, aimed at an airborne objective (land the crown *on* a target roof).
- **Scale story:** At 1k a frozen cloud of 200 pieces is readable. At 10k the frozen cloud is a sculpture: the spectacle peak and the screenshot moment. At 100k freezing costs nothing, so frozen time is where 100k becomes interactive, since you browse it at 120 fps with physics stopped.
- **Uses today:** Freeze-while-aiming already exists. Replays store event steps. Physics in its own loop with interpolation. The camera is player-only, which suits it.
- **Needs new:** Mid-shot freeze and resume in the Driver, with events stamped at the frozen step (S, low). A freeze budget and rules (S, low). An "airborne" reduction: the count of bodies above a height with a speed above v (S, low: a predicate reduction). Bot casting with freeze choices (M, med).
- **Level seeds:** (1) "Juggle": the score is the max simultaneous airborne count. (2) "Redirect": a falling 4k chimney must be deflected off its natural line onto a target pad. (3) "Catch": the crown must end on top of a neighbouring roof, which needs a mid-air shove.
- **Risks:** Freezing makes chaotic outcomes *more* controllable, which is good for fun but hurts reproducibility (a freeze at step 412 vs 413). Pacing: players may over-deliberate.
- **Scores (1-5):** fun 5 / novelty 4 / engine fit 5 / cost 5

### DE-10 Sympathetic
- **Pitch:** The city is sown with dormant charges (marked blocks). One spark sets off the first, and any charge that gets jolted detonates, so your goal is a chain reaction that reaches the far target. Hybrid: destruction + chain reactions.
- **Fun hook:** You fire one shot and get ten seconds of cascading booms. The decision is where to place your 3 extra charges (a small rack) as relays across the gaps. The first 30 s: one shot, pop, pop-pop, POP, and the cascade dies one street short. You know exactly where the relay goes.
- **Borrowed from:** *Boomshine* and *Chain Reaction* (expanding circles), *Boom Blox* (TNT blocks), *Peggle* (spatial chains), and *Bomberman* chained bombs.
- **Loop:** 30 s: place relays, fire the spark, watch the chain. 5 min: a 5-level page where the targets get further and the gaps get wider; stars for the fewest relays.
- **Scale story:** At 1k the gaps are short and chains are certain. At 10k the chain has branches, and collapse waves carry it as much as blasts do. At 100k a chain crosses a sleeping city, and each detonation wakes a neighbourhood, so the awake set follows the wavefront.
- **Uses today:** `WeaponSpec` munitions spawned at rest as charges with blast actions, blasts and removes, watched bodies (64 charges max), and the collapse and crown objectives.
- **Needs new:** A `moved` / `contact`-speed trigger: fire when displacement > d or |v| > s (S-M, low; `contact` is already planned). Charges placed at rest by the level, not launched, so the runtime must accept level-owned munitions (S, low). More than 64 charges needs a GPU-side predicate reduction per charge set (M, med).
- **Level seeds:** (1) "Fuse Street": 8 charges in a row with one gap. (2) "Two Towers": charges up a 5k tower; the chain must climb to topple its top onto a second tower. (3) "Minefield": 64 charges in a 20k district; only 40% of the district may fall (spare the neighbours).
- **Risks:** Proximity at rest is meaningless (charges are always "near" something), so it needs the movement trigger. Chains may be binary (works or does not), so the stars need graded reach.
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 4 / cost 4

### DE-11 Keyhole
- **Pitch:** Precision demolition: you get exactly one `remove` (sometimes two). Pick the single block whose loss topples a 5k tower onto a target ring. Hybrid: Jenga + puzzle.
- **Fun hook:** It is the opposite of brute force: you study the structure (load X-ray, heatmap) for the keystone that makes it fall *that* way. A wrong pick does nothing, or drops it on the heritage hut. The first 30 s are hovering blocks with the X-ray on, and the delicious lurch when it goes.
- **Borrowed from:** *Jenga* (remove one block), *Picross* (deduce from structure), *Cut the Rope* (one cut, causal puzzle), and *Angry Birds*' weak-point hunting.
- **Loop:** 30 s: inspect and pull, then the result. 5 min: 8 puzzle towers with rising lean and redundancy; stars for the topple landing distance from the ring centre.
- **Scale story:** At 1k a handful of candidates, which reads as a crisp puzzle. At 10k it is a real structural read where the load path matters, and the load X-ray becomes essential. At 100k it is an overwhelming search, unless you get a "suspect list" from scanning: tier it as an expert puzzle.
- **Uses today:** `remove`, collapse, footprint and heritage, watched crowns, the planned load X-ray and displacement heatmap, and the bot (casting stars is cheap: enumerate candidate removes).
- **Needs new:** Remove wakes neighbours under sleep (S, med). A landing-target scoring zone (S, low). A load X-ray render (designed, M).
- **Level seeds:** (1) "Leaning Column": a 1k column with a 2 degree lean; pull it the other way. (2) "Twin Legs": a 5k arch-legged tower where only one corner block topples it north. (3) "Redundant": a 10k braced frame; two pulls are needed, and order matters.
- **Risks:** Structures may be too redundant (nothing happens) or too fragile (anything topples). If the friction-held stacks behave too uniformly, the "keystone" never feels special.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 5

### DE-12 Undermine
- **Pitch:** Dig a tunnel by removing blocks one click at a time into a 100k-block mountain to reach a buried gem. Every removal shifts the load; dig carelessly and the cave-in buries the gem deeper.
- **Fun hook:** Digging as a slow-burn stress game: you hear grit (the stone sound) as the roof settles, see the displacement heatmap creep, and decide to shore up (place a block) or push on. The first 30 s are ten quick clicks, then a crackle, then the pause before you dare the eleventh.
- **Borrowed from:** *Dig Dug* and *Mr. Driller* (drill, falling blocks), *SteamWorld Dig*, *Minesweeper* (risky reveals), and real mining roof support.
- **Loop:** 30 s: 5 to 10 removes, each shown with a short settle. 5 min: reach the gem with N clicks and M props; the score is clicks left and gem exposure.
- **Scale story:** At 1k it is a tiny cave that collapses all at once. At 10k a hillside where local collapses happen. At 100k a whole mountain, where sleep is essential: only the cave walls are awake, so a 100k world plays at 1k cost. This is the cleanest "sleep makes the mode possible" idea.
- **Uses today:** `remove`, `spawn` at rest (props), watched bodies (the gem), the displacement heatmap, stone grit sound, and the moving-count reduction.
- **Needs new:** Remove wakes neighbours (S, med; critical). A persistent sleeper grid and compaction (planned, L). The gem "reachable" test: a line of sight or ray from the tunnel mouth, which can be approximated by the gem's height below the rubble surface from a heightmap reduction (S-M, low). A click-to-remove picking UI (S, low).
- **Level seeds:** (1) "Shallow Seam": a 5k hill, gem 6 blocks in. (2) "Overhang": the gem lies under a cantilevered ledge that wants to drop. (3) "The Deep": 100k mountain, gem at the core, 120 clicks, 10 props.
- **Risks:** Cube-stacked mountains are too stable (any tunnel holds) or too unstable (pyramid-like slumping), so they need mixed sizes and materials for "arching". Slow pacing may bore the spectacle crowd.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 4

### DE-13 Fall Line
- **Pitch:** One push and the city falls like dominoes: towers topple into towers. Pick the first tower and the one or two "relay" demolitions that steer the wave to the cathedral square. Hybrid: destruction + dominoes.
- **Fun hook:** Seeing a skyline as a domino layout: tower heights versus street gaps decide whether the wave jumps the avenue. The first 30 s: you topple one tower and watch four more go in sequence, then the wave stalls at a wide boulevard, so a relay grenade is needed there.
- **Borrowed from:** Domino toppling shows, *Burnout* crash junctions, *Lemmings* (one action steers a flow), and *Boom Blox*.
- **Loop:** 30 s: one shot and the wave. 5 min: a city level with a rack of 3; stars for the share of the marked route fallen, and heritage intact off the route.
- **Scale story:** At 1k it is 5 towers in a toy row. At 10k a 30-tower district with forks. At 100k a whole city, and sleep makes it real time because only the wavefront is awake. This is the single best use of the sleep work.
- **Uses today:** City scenario S4/S14, collapse per region, heritage, the rack, and sleep (partly built).
- **Needs new:** Per-region collapse reductions, for "route" vs "off-route" districts (S, low). Persistent sleeper grid and compaction for 100k (planned, L). Optional: a wavefront camera assist, which must be opt-in.
- **Level seeds:** (1) "Main Street": 8 towers, one gap you must bridge with a grenade. (2) "Fork": the wave can turn left (the market, which you want) or right (the hospital, heritage). (3) "Hundred Thousand": 100k, a 2 km chain that ends at the stadium.
- **Risks:** Box towers held by friction may crumble rather than fall as a unit, so the wave degrades into rubble. Towers need tall, stiff designs (Kapla-like interlocks) to fall like planks. Overlaps with the domino lens.
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 4 / cost 4

### DE-14 Chisel
- **Pitch:** Sculpt by demolition: a 10k-block marble cube hides a statue (a target voxel set). Remove and micro-blast everything that is not the statue, without the statue toppling or losing a piece.
- **Fun hook:** The *Picross 3D* deduction mechanic with physics stakes: numbers on the cube's faces tell how many statue blocks lie in each row, so you deduce and then chip. A careless blast shears the statue's arm, and overhangs crash once you remove their support. The first 30 s: chip the obvious empty rows, and the first glimpse of a shape emerges.
- **Borrowed from:** *Picross 3D* (row-count clues, break or mark), sculpting toys, and the Michelangelo idea of "free the figure from the stone".
- **Loop:** 30 s: a dozen chips and one small blast to clear a corner. 5 min: one sculpture; the score is excess removed, minus statue blocks lost, minus clicks.
- **Scale story:** At 1k a 10x10x10 puzzle, crisp and logic-first. At 10k a bust-sized figure, where blasts are the necessary bulk tool. At 100k a monument, where the strategy is brute blasts outside and precision near the figure.
- **Uses today:** `remove`, small blasts (S grenade), watched/heritage bodies (up to 64 statue blocks as key blocks), and the predicate reductions (count of statue-tagged bodies displaced > d).
- **Needs new:** Body tags with tag-filtered displacement counts beyond 64, as a GPU reduction over a tag mask (S-M, low). Remove wakes neighbours (S, med). A clue overlay renderer (S, low). Statue shapes need supports (overhangs fall), so level authoring must check them.
- **Level seeds:** (1) "Pawn": a 1k chess pawn. (2) "Arch": a 5k arch statue; the keystone must survive while you hollow beneath it. (3) "Horse": 20k, with four thin legs that a careless blast snaps.
- **Risks:** Picross clues plus physics may be two games bolted together. Players may want pure logic or pure smashing. Removing thousands of blocks one at a time is tedious without bulk tools (brush removal = many removes per click, which is fine).
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

### DE-15 Richter (wild)
- **Pitch:** You design the earthquake: pick amplitude, frequency, and duration within an energy budget so the quake drops the condemned blocks while the quake-proof towers stand.
- **Fun hook:** Resonance. Tall towers fall to slow sway, squat ones to sharp jolts. Tune the quake to the building you want gone. The first 30 s: slide frequency, hit SHAKE, and watch the skyline sway in waves while one tower whips and falls.
- **Borrowed from:** Structural shake tables; *SimCity* disasters; the oscillator tuning of synth toys; *Kerbal*'s "tune and pray".
- **Loop:** 30 s: one quake design and the run. 5 min: three quakes on a skyline with mixed heights; stars for "condemned down, protected standing".
- **Scale story:** At 1k a few towers, where the resonance idea is obvious. At 10k a city where heights vary and the quake differentiates. At 100k a metropolis-wide quake wakes *everything*, which is the worst case for sleep and so needs the 100k awake path. Cap it at 30k until then.
- **Uses today:** Uniform world kicks via a distant flat-core blast with `maxDv` = the desired dv (every body gets exactly dv; see note 1 at the top). A sequence of alternating blasts = an oscillating ground. Heritage = the protected towers, plus the skyline objective.
- **Needs new:** A quake "instrument" UI that writes the blast train (S, low). A proper `fieldKick` event (uniform dv to bodies in an AABB, optionally only below height h, which is a truer ground shake) (S, low). Tiered blasts for 100k (step 8, M, med).
- **Level seeds:** (1) "Tuning Fork": two towers, one tall and one short; drop only the tall one. (2) "Old Town": ten Kapla-plank houses among stone ones; drop the planks. (3) "Retrofit": the protected tower is the tallest, so you must avoid its resonance band.
- **Risks:** Friction-held stacks may not show resonance at all (they slide or don't), so towers need to be pinned tall and narrow. Uniform kicks of every body also slide everything on the ground, which looks odd unless the amplitudes are small.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 4

### DE-16 Recurrence (wild)
- **Pitch:** A time-loop demolition: each loop you fire one shot, and on the next loop all your earlier shots re-fire at their recorded moments alongside your new one. Five loops build one choreographed, five-shot collapse.
- **Fun hook:** You are composing with your past selves. Loop 1's cannonball now hits a different building because loop 2's grenade went off first. The first 30 s: fire, the loop resets, your ghost-cannon fires on cue, and you time a grenade to land just as it hits.
- **Borrowed from:** *Braid* and *The Swapper* (time mechanics); *Super Time Force* and *Quantum League* (past selves acting together); *Cursed to Golf*-style replays.
- **Loop:** 30 s: one loop (reset, replay ghosts, add one shot). 5 min: 5 loops for one finale, with the option to rewrite any earlier loop (which changes everything after it).
- **Scale story:** At 1k loops are fast but the interplay is thin. At 10k the interplay is rich, and 5 overlapping shots make a set piece no human could fire live. At 100k the replay cost matters (each loop re-simulates from the start), so the GPU replays at max speed, and sleep helps.
- **Uses today:** Bit-deterministic replay per device (a level + shots < 200 bytes), shots carry steps, all of `WeaponSpec`, and the rack.
- **Needs new:** Shots at arbitrary steps in one run (quickdraw-like timing, without attribution needs) (S, low). A loop UI with a ghost timeline (S-M, low). Fast-forward replay to the new shot's step (exists as the tail skip; S). Stars cast on the final loop only (S).
- **Level seeds:** (1) "Duet": 2 loops, two towers that must fall into each other at the same instant. (2) "Rondo": 5 loops; the crown ends on a far plinth via a relay of hits. (3) "Edit": the level gives you 4 recorded ghost shots that fail; change one and fix the finale.
- **Risks:** Re-simulating every loop is slow at 10k (a 10 s shot = 600 steps x 5 ms = 3 s, which is OK). Chaos means editing an early shot scrambles everything, which can be frustrating. The fix is "edit only the last loop".
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 5 / cost 4

### DE-17 Span Cut (wild)
- **Pitch:** A convoy of ice-sled boxes glides across a rubble-held bridge. Blow the bridge so that exactly the cargo wagons drop into the gorge, while the locomotive and the caboose make it.
- **Fun hook:** It is a timing heist. The sleds slide on ice (mu 0.05) at a steady speed, the bridge takes 0.8 s to sag, and you must fire before they reach it. The first 30 s: watch the convoy, slam the plunger, and the third wagon teeters on the edge.
- **Borrowed from:** Train-robbery set pieces; *Burnout* timing; *Hitman* "accident" kills (environmental timing); *Frogger* in reverse.
- **Loop:** 30 s: one convoy pass with one detonation. 5 min: escalating convoys (faster, longer, mixed cargo) with a rack of 3; stars for exactly the right wagons dropped.
- **Scale story:** At 1k a short bridge with a 6-car convoy. At 10k a viaduct of arches where the collapse propagates along the span. At 100k a gorge with multiple bridges and convoys, which is spectacle, not puzzle.
- **Uses today:** `spawn` with velocity (each sled is a box launched along the deck), the ice material, blasts and removes, watched bodies (cars are crowns, at most 64), timing via shots fired during motion.
- **Needs new:** Firing while the convoy runs (quickdraw-lite: the run is the shot, and the player triggers a pre-placed charge) (S, low). Pre-placed level charges (shared with DE-10) (S, low). Note the absence of kinematic bodies: the convoy coasts, so it decelerates slightly; tune the deck with ice.
- **Level seeds:** (1) "One Car": drop only the middle wagon of three. (2) "Gold Run": the gold wagon is iron (heavy), and the bridge sags earlier under it. (3) "Two Bridges": two spans and two convoys passing in opposite directions.
- **Risks:** Coasting boxes on a rubble deck jitter and derail, so the deck must be slab planks. Convoy cars are not coupled (no joints until step 7), so they drift apart. Gimmicky after 10 levels.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 3 / cost 4

### DE-18 Carom
- **Pitch:** Trick-shot demolition: with Bounce on, rubber walls (e 0.6) ring the arena, and your one ball must bank off them to hit a target hidden behind heritage buildings you cannot touch.
- **Fun hook:** It is billiards geometry plus Will's favourite bouncing ball. The obvious line is blocked by the cathedral, so you need two cushions to come in from behind. The first 30 s: a ghost-line aim preview for the first bounce only, a fire, and an absurd triple-bank that lands.
- **Borrowed from:** Billiards and snooker (banks, angles); *Peggle* (bounce-based targeting); *Golf With Your Friends* trick holes; *Angry Birds*' blue-bird bounce.
- **Loop:** 30 s: aim and fire, a ricochet show. 5 min: a 6-level trick page; stars for collapse of the target and zero heritage touches, plus a "no preview" bonus.
- **Scale story:** At 1k a small arena with precise banks. At 10k the target is a 5k tower and the ricochet carries real energy into its base. At 100k a city with rubber "retaining walls" where the ball pinballs through streets: wild, but low value.
- **Uses today:** The Bounce option, rubber material, real projectiles (the beach ball and basketball bounce), heritage, and the crown objective.
- **Needs new:** Fixed walls. With no kinematic or static bodies besides ground, a "wall" must be a very heavy, wide box that stays put under ball hits (S, low; but it may slide). Better is a static-body flag, effectively infinite mass (M, med: engine-wide). An aim preview of the first bounce via free-flight and plane reflection (S, low).
- **Level seeds:** (1) "Corner Pocket": one cushion bank around a heritage hut. (2) "Cloister": the target sits in a courtyard enclosed by a heritage cloister, so you go over and down. (3) "Breaker": a rubber-walled box arena with 3k blocks inside, where the ball keeps bouncing and the score is collapse.
- **Risks:** Without static bodies, walls move and banks drift. AVBD restitution hardening (E4) must land. Bounces at speed in a busy arena could tunnel (no CCD).
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 3 / cost 3

### DE-19 Wrecking Ledger
- **Pitch:** A demolition-company career: bid on contracts, buy charges and projectiles, and get paid for clean jobs. There is salvage money for intact material swept into bins, and fines for scatter and dented neighbours. Hybrid: destruction + progression economy.
- **Fun hook:** Every grenade costs cash, and every block flung into the street costs a fine. So you learn surgical demolition because brute force is unprofitable. The first 30 s: a tight bid, a cheap first job (two charges), a fat cheque, and an upgrade unlocked.
- **Borrowed from:** Tycoon contract loops (*Two Point*-style); *PowerWash Simulator* (job-based progression, satisfying completion); *Hardspace: Shipbreaker* (salvage sorting into bins, the penalties for wrecking valuables); *Balatro*'s run economy (not chips x mult, which BREAKLINE took).
- **Loop:** 30 s: one shot in a job, with the money ticker live. 5 min: 2 or 3 contracts, a shop visit, and a new tool unlocked (a bigger grenade, a "cutter" remove charge, the wrecking ball).
- **Scale story:** At 1k sheds and garages, small jobs. At 10k office towers, where salvage sorting matters (the iron frame into the iron bin). At 100k the late-career job: a whole condemned block with neighbours worth millions.
- **Uses today:** Yield as price (grenades of yield), footprint and heritage, AABB zone counts (bins = predicate zones), materials (iron, stone, plaster), and progress in the browser.
- **Needs new:** Zone-by-material counts (bodies of material m in an AABB), as a predicate reduction with a material filter (S, low). Shop and contract meta-layer with saved progress (M, low). An economy tuning pass (M, med).
- **Level seeds:** (1) "Garden Shed": plaster with a glass greenhouse next door. (2) "Scrapyard": an iron-framed warehouse; blasted iron in the iron skip pays triple. (3) "Downtown Permit": a 10k tower with a fixed number of charges allowed by the permit and three neighbouring heritage buildings.
- **Risks:** Meta-progression is scope creep. The economy could reward one optimal tool. Bins catch rubble only by luck unless you get "push" tools (sparse forces, step 6).
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 2

### DE-20 Deflection
- **Pitch:** The disaster is coming: a scripted wave of 2,000 boulders rolls down a valley toward a village in 20 s. Spend your rack blasting the hillside and the old quarry tower to build a rubble berm that diverts the flood. Hybrid: destruction + tower defence.
- **Fun hook:** Destruction as defence. You wreck your own terrain to make walls, under a clock and with the threat telegraphed. The first 30 s: the wave appears at the ridge, you topple the quarry tower across the channel, and the boulders split around it, mostly.
- **Borrowed from:** Tower defence (build phase then wave); *Lemmings* (redirect a flow); *From Dust* (sculpt terrain against a flood); *Into the Breach* (telegraphed threat).
- **Loop:** 30 s: two or three demolition shots, then the wave. 5 min: three waves of rising size over one valley, with your berms persisting between waves.
- **Scale story:** At 1k a trickle of boulders with toy stakes. At 10k a real flood (5k spheres plus 5k structure), granular and dramatic. At 100k a landslide, but the whole flood is awake, so it needs the 100k awake path.
- **Uses today:** `spawn` (the wave as a scripted spawn sequence, perhaps from a hopper structure blasted open), spheres, the stone and ice materials, heritage (the village houses), and the footprint inverse (count of wave bodies in the village zone).
- **Needs new:** Scripted level events, a timed spawn train that is not player shots (S, low). Zone counts of a body class (S, low). A build phase vs wave phase rule (S, low).
- **Level seeds:** (1) "Mill Pond": a 1k wave, one tower to topple across the stream. (2) "Twin Valleys": divert the wave from village A into the empty valley B by collapsing the ridge between them. (3) "Hold": three waves; your berm must survive all three.
- **Risks:** Overlaps with SPILLWAY's granular-flow idea; the difference is that the flood is the threat and demolition is the tool. Sphere floods are costly (all awake). Diversion may be too binary.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 4

### DE-21 Meltdown (wild)
- **Pitch:** It is spring in the ice palace: every block's friction falls a little each second as it thaws. Demolish the condemned wing *before* the palace creeps apart on its own, or brace the heritage hall to survive the thaw.
- **Fun hook:** The world is a timer you can see: blocks glisten, then start creeping. Brute force now is cheap but dirty. Waiting makes the structure weaker, so a smaller charge works, but the heritage hall also starts to slide. The first 30 s: the palace sags under its own weight as you scramble for the timing.
- **Borrowed from:** Countdown puzzles (*Lara Croft GO* crumbling tiles); *Frostpunk* (environmental pressure); the "perfect moment" decision in *Peggle* free-ball timing; real ice-hotel melt.
- **Loop:** 30 s: watch the creep, then fire. 5 min: a level with 3 shots across the thaw, with the score weighted by how early you finished.
- **Scale story:** At 1k a gimmick. At 10k the creep is visible as a slow-motion glacier, which looks beautiful in `look=real`. At 100k the whole palace oozes, which is mostly awake, so it is costly.
- **Uses today:** The ice material (mu 0.05), per-body friction, heritage, and collapse.
- **Needs new:** A material-change event: set the friction of a body set at step k, as a level-scripted event (S-M, low; the solver reads per-body friction already, so this is a buffer write). A sleep interplay: thawing bodies must wake (S, med).
- **Level seeds:** (1) "Igloo": a 1k dome that slumps by second 30. (2) "Wing and Hall": demolish the east wing, while the hall's friction drops too. (3) "Glacier Gate": an ice arch over a heritage statue.
- **Risks:** Creep under low friction may look like a bug (sliding stacks). It is a rare mode with niche appeal.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

### DE-22 Bracket
- **Pitch:** Indirect artillery: the target fortress is behind a ridge you cannot see over. A forward observer reports where each shell lands ("over 40, left 15"). Walk your fire onto the target before the fortress's gun (a timer) finds you.
- **Fun hook:** Deduction and correction (bracketing): over, under, then split the difference. The reveal at the end is a fly-over of what your blind shells did. The first 30 s: the first shot lands long, the second short, and the third lands right on target, with a satisfying crump heard over the ridge.
- **Borrowed from:** *Battleship* (blind grid feedback); *Arma*-style artillery calls; *Scorched Earth* (angle/power); *Return of the Obra Dinn*-like reveal.
- **Loop:** 30 s: one shell and its report. 5 min: a fire mission of 8 shells against three targets of different hardness.
- **Scale story:** At 1k one bunker with a fast mission. At 10k a fortress where you must pick weak points from intel photos. At 100k an entire fortified town, where intel and reports are the only interface. The cost is invisible, because you never watch the collapse live, so it can simulate faster than real time or even with fewer FPS.
- **Uses today:** Long-range spawns with velocity, weapons, observers (the landing point of a watched shell; collapse per region), and the camera is player-only, so the ridge blocks the view naturally.
- **Needs new:** An observer report UI (S, low). Fog or an occluding ridge, which is just a big structure, or render-masking the target area (S, low). A shell-landing readout (watched-body first ground or near contact) (S, low).
- **Level seeds:** (1) "First Mission": one bunker and wind. (2) "Moving Spotter": the reports come with a 1-step delay. (3) "Last Stand": a 30k fortress town where you need its gate *and* its tower down within 8 shells.
- **Risks:** Not seeing destruction removes the spectacle that makes the game. The end reveal and replay must carry it. It might feel like spreadsheet play.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 5 / cost 5

### DE-23 Skeleton Crew
- **Pitch:** Reverse engineering: an inspector strips a 10k building, removing as many blocks as possible, one or a few at a time, while it still stands (the potential energy must not drop). You score on the hollowness of the skeleton that remains. Hybrid: demolition + Jenga stacking.
- **Fun hook:** You discover load paths by deleting everything that is not one, so the result is an emergent lattice sculpture. Every removal is a bet. The first 30 s: obvious decorative blocks go, then the first risky interior pull, and a heart-stopping creak.
- **Borrowed from:** *Jenga* (remove while standing); topology optimisation (structural engineering); *Bridge Constructor* stress testing; *Townscaper*-like beauty of the result.
- **Loop:** 30 s: 5 to 10 pulls. 5 min: one building to the point of collapse. The score is blocks removed before the collapse (the PE drop past 2% ends the level) plus a "skeleton photo" share.
- **Scale story:** At 1k it is Jenga with 1,000 blocks. At 10k the skeleton becomes a lattice, beautiful and surprisingly strong. At 100k a cathedral's flying-buttress skeleton, with bulk removal tools needed.
- **Uses today:** `remove`, PE reduction (the end trigger), the moving-count reduction, the load X-ray (designed), and the "ink" displacement tint.
- **Needs new:** Remove wakes neighbours (S, med; critical). Brush and bulk remove UI (S, low). A long-term stability check: a settled structure must stay settled for N seconds after a pull, and AVBD rest drift must not fail it unfairly (S, med; rest-gate F3 territory).
- **Level seeds:** (1) "Shed": 1k, a simple frame. (2) "Office": a 10k floor-plate building with a core. (3) "Kapla Spire": a 3k plank tower, where planks give long spans.
- **Risks:** AVBD drift or creep at rest could collapse a "stable" skeleton over time. That is an engine-fidelity exposure, which is an honest risk. The game is slow and contemplative.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 4 / cost 5

### DE-24 Aftermath (wild)
- **Pitch:** Forensic demolition: you are shown the rubble of a collapse and must reconstruct the shot that caused it (projectile, point, angle, speed). The score is how closely your rerun's rubble matches.
- **Fun hook:** Reading rubble like a detective. Spray direction says the shot came from the south; the crater depth says it was heavy and slow. Each guess reruns, and the overlay shows where your debris differs. The first 30 s: the first guess and a 40% match, then "it came from higher".
- **Borrowed from:** *Return of the Obra Dinn* (deduce events from aftermath); forensic shows; *GeoGuessr* (scored guess against truth); *Wordle* (feedback per guess).
- **Loop:** 30 s: one guess and rerun. 5 min: a case solved in up to 6 guesses, with a daily case puzzle.
- **Scale story:** At 1k rubble is ambiguous (few clues). At 10k the debris field has rich structure, with a clear spray cone and crater, which is ideal. At 100k the pattern is gorgeous but slow to rerun.
- **Uses today:** Same-device determinism (the target is generated on the player's device by a hidden shot, so the matching is exact for the right answer), the histogram and displacement reductions for similarity, the displacement heatmap, and replays.
- **Needs new:** Rubble similarity as a grid-histogram distance (S, low; shared with DE-4). A guess UI with a projectile and launch-vector picker (S, low). The daily case is a seed list (S). Chaos means near-right answers score with a wide spread; the bot can cast a "match-band" for stars (M, med).
- **Level seeds:** (1) "Wall Job": a 1k wall hit by one cannonball. (2) "Inside Job": a grenade *inside* a 5k building (where it happened is the clue). (3) "Two Shooters": two shots, two directions.
- **Risks:** Chaos makes the gradient between guesses noisy, so it can feel random. It needs guesses that score smoothly. This is an analysis game in a spectacle game's clothes.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 5 / cost 4

---

## Capability primitives this lens keeps needing

| Primitive | Effort / risk | Ideas |
|---|---|---|
| **Remove wakes its neighbours** under GPU sleep (a removed support must wake what it touched) | S / med | DE-1, DE-11, DE-12, DE-14, DE-23 (and anything at 100k with removes) |
| **Mid-shot events**: freeze, fire, or trigger while bodies move, with replay stamps at step k (quickdraw rules, attribution) | S-M / low | DE-8, DE-9, DE-16, DE-17, DE-1 (timed multi-event shot) |
| **Level-owned charges and scripted events**: munitions or spawns placed by the level, timed spawn trains | S / low | DE-10, DE-17, DE-20, DE-1 |
| **Movement / contact trigger** in `WeaponSpec` (displacement > d or speed > s; `contact` is already planned) | S-M / low | DE-10, DE-17, DE-1 |
| **Region- or tag-masked reductions** (collapse, skyline, and counts per region, material, or body tag; more than 64 key bodies) | S-M / low | DE-4, DE-7, DE-13, DE-14, DE-19, DE-20 |
| **Occupancy-grid / heightmap reduction with target mask** (fill, spill, rubble height, similarity) | S-M / low | DE-1, DE-4, DE-12, DE-24 |
| **Persistent sleeper grid + compaction (100k mostly idle)** | L / med (planned E2) | DE-7, DE-12, DE-13, DE-2 (100k), DE-23 |
| **Tiered blasts at 100k** (step 8) | M / med | DE-3, DE-7, DE-15 |
| **Uniform field kick** (`fieldKick`: dv to bodies in an AABB, optional height band). Approximable today by a distant flat-core blast with `maxDv` binding | S / low | DE-15, DE-2 (wind), shake effects elsewhere |
| **Material-change event** (set friction or restitution for a body set at step k) | S-M / low | DE-21, also "wet/dry" variants |
| **Watched-body damage readout** (peak decel / contact impulse) | M / med | DE-6, plus egg-style fragile crowns anywhere |
| **Static (infinite-mass) bodies** for cushions and walls that do not move | M / med | DE-18, DE-17 (deck), DE-20 (fixed banks) |
| **Placement / build UI** with block budget (shared with stacking lens) | M / low | DE-6, DE-12 (props), DE-2 (build phase) |
| **Sparse forces / thrust, step 6** (wind on a shell, pushing rubble into bins) | M / med | DE-2, DE-19 |
| **Bot casting for multi-phase or timing policies** (freeze, quickdraw, build-then-break) | M / med | DE-5, DE-6, DE-8, DE-9, DE-16 |

## My top 5 and why

1. **DE-9 Stopframe.** It is the cheapest big leap: freezing mid-collapse is almost free in the engine, it is replay-safe, it turns 10k chaos into something you can read and then direct, and it produces the screenshot moment. It also respects the camera rule, because the player orbits the frozen cloud.
2. **DE-8 Never Settle.** A *Tony Hawk* combo keyed to `nMoving` is a genuinely new score-attack loop for a collapse game. It rewards spectacle (Will's signal), and it scales: longer collapses at 10k mean longer chains. It needs only quickdraw rules and a meter.
3. **DE-13 Fall Line.** It is the single best showcase of sleep: a 100k city where only the toppling wavefront is awake. The decision (pick the first tower and the relays) is legible in one look, and the payoff is enormous.
4. **DE-1 Implode.** It is real demolition craft (sequencing) that the current game does not touch. It uses removes, blasts, footprint, and heritage, all of which exist today. "Drop it in its own footprint" is a clear, cast-able goal with a deep skill ceiling.
5. **DE-16 Recurrence.** Per-device determinism is a limitation for multiplayer, but it is a *superpower* for time loops: your past shots re-fire bit for bit. It is new for the genre, cheap to build, and it creates set pieces no single shot can.

Honourable mentions: DE-10 Sympathetic (a near-certain hit once the movement trigger lands), DE-12 Undermine (the cleanest "100k only works because of sleep" puzzle), and DE-15 Richter (wild and buildable today with the distant-blast trick).
