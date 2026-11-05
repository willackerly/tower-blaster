# Sandbox, creative and expressive modes (lens SB)

Designer lens: building tools, toys, music, director/replay, zen, sharing, procedural generators, time controls.
Written 2026-11-05 against the capability brief. Engine facts used throughout: boxes and spheres only, one ground plane, no joints, no kinematic bodies, no CCD, events = `spawn` / `blast` / `remove`, WeaponSpec trees, GPU reductions plus 64 watched bodies, bit-deterministic per device only, sleep (E2) partly built.

Two honesty notes that apply to many ideas:
- **Sharing.** The *initial state* of a creation (placements, generator params, a WeaponSpec, an image palette) is device-independent and can travel as a link or file. The *outcome* is not: the recipient's device re-simulates, and chaotic regions may differ. Every sharing idea below either accepts that ("your wreck of my fort"), re-validates on the recipient's device, or ships a video as the canonical artifact. There is no backend today, so "share" means URL hash (fine up to a few KB) or the existing scene file.
- **Pinned bodies.** Many builder ideas want a few blocks that never move (ramps, rails, walls, cliffs). The brief lists no static bodies besides the ground. I assume a zero-inverse-mass flag on a body is S/M in AVBD; where it is missing, the fallback is heavy iron plus sleep, which still wakes and drifts on impact.

---

### SB-1 Brickbrush
- **Pitch:** A frozen-time voxel editor with real brushes (line, box fill, extrude, mirror, stamp), and one big switch that turns gravity on.
- **Fun hook:** The tension is "will it stand?" You build with time stopped, so you can make anything, including things physics will not allow. Flipping to Play is the punchline every time. In the first 30 s you drag a box brush into a 20x20x20 cube block, extrude an overhang, hit Play and watch the overhang peel off.
- **Borrowed from:** MagicaVoxel (brush modes: attach/erase/paint with line/box/face-extrude shapes), Townscaper (instant, forgiving placement), Minecraft creative (stamp/fill commands), Poly Bridge's build/test toggle.
- **Loop:** 30 s: brush, Play, watch, Reset (the scene rebuilds exactly as built). 5 min: build a castle from stamps, place a few marked "keep" blocks, Play, then shoot it with the existing rack/weapons, save the scene file.
- **Scale story:** 1k: hand-placed, every block a decision. 10k: fill and extrude brushes; you think in volumes and the question becomes "where does the volume fail". 100k: stamps of whole scenarios (a city block S4, a wall S3) composed into a landscape; Play is only affordable because sleep keeps the resting bulk cheap, and you shoot one district at a time.
- **Uses today:** `spawn` at rest, scene JSON save/load, scenarios as stamps, materials, projectiles and weapons, both looks.
- **Needs new:** edit-mode world (no stepping; rebuild from scene on Play) S, low. Picking and face-snap placement on a CPU mirror of the scene M, low. Brush set + undo/redo M, low. Stamp library from scenario generators S, low. Sleep compaction for 100k Play (E2, already planned) L, med.
- **Level seeds:** (1) "Blank lot": 40x40 ground plate, no limit. (2) "Overhang gym": one tower stub, prompt "build the longest balcony that survives Play". (3) "Stamp city": empty plain with a palette of S3/S4/S14 stamps and a 50k body cap.
- **Risks:** A plain editor is a tool, not a game; without goals it competes with the viewer. Brush UX on a trackpad is fiddly. Play from a non-physical build can explode (interpenetrating stamps); needs an overlap check before Play.
- **Scores (1-5):** fun 3 / novelty 2 / engine fit 5 / cost 4

### SB-2 Plank Hall
- **Pitch:** Live-physics plank building in the photoreal hall: every plank you set down is immediately subject to gravity, and the finale is the topple.
- **Fun hook:** Unlike Brickbrush, time never stops. Each plank is a small bet, the tower sways and settles, and the question is how far you dare to push height or reach. The first 30 s: three planks become a little tower that creaks when the third one lands off-centre.
- **Borrowed from:** real-world plank-stacking toys (the Kapla play pattern of cross-layered planks), Jenga (live risk), Tricky Towers (placing under live physics), the "stack" genre's ghost preview.
- **Loop:** 30 s: aim a ghost plank, set it (spawned at rest 1 mm above the surface), watch it settle. 5 min: build a 2 m spiral, then cue-push the base and watch the Kapla fall Will loved; save the build as a starter for someone else.
- **Scale story:** 1k: a careful afternoon tower. 10k: a "repeat layer xN" tool lets you set a course pattern and grow a cathedral-scale build in minutes; the risk moves from single planks to accumulated lean. 100k: not interactive; the 100k plank hall is a showcase scene rendered offline (see SB-13).
- **Uses today:** S15 plank scenario and the hall look, `spawn` at rest, cue ammo, sound (wooden clacks via plank timbre), height reduction (bounding box).
- **Needs new:** placement tool with ghost, rotate and snap-to-top-face M, low. Layer repeat/pattern tool S, low. Optional "steady hand" assist (snap plank to integer plank grid) S, low. Sparse-force nudge (step 6) for a finger poke instead of a cue S once step 6 exists, low.
- **Level seeds:** (1) "Two metres": reach 2 m with 120 planks. (2) "Reach": longest horizontal cantilever off a fixed table edge. (3) "Spiral stair": template layer that rotates 15 degrees each course; how many courses before it goes.
- **Risks:** Tall resting plank towers may creep or jitter in AVBD over minutes, making a slow, honest collapse look like a solver bug. Placement must not inject energy (spawn interpenetration). Hand-placing 1k planks is a long session; needs the repeat tool early.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 4 / cost 4

### SB-3 Load Test  *(hybrid: puzzle)*
- **Pitch:** Span a gap with loose blocks only (no glue, no joints), then roll a bowling ball across to prove it.
- **Fun hook:** Without joints, every bridge must be a real masonry idea: corbelling, counterweighted cantilevers, arches, friction. The first 30 s: you lay a plank across a 1 m gap, roll the ball, the plank tips into the void, and you immediately see you need weight on the ends.
- **Borrowed from:** Poly Bridge / Bridge Constructor (budget, test run, stress view, pass/fail), the masonry corbel-arch, the harmonic block-stacking problem.
- **Loop:** 30 s: place, test, fail, adjust. 5 min: a level is a gap + budget (block count by type) + a load (ball mass, speed); three stars for budget left, as cast by the bot.
- **Scale story:** 1k: a short span; every block visible. 10k: a 30 m valley; the load is a train of 20 boulders, and the build is a corbelled viaduct where local failures matter less than overall arch thrust. 100k: not a play target; the 10k version is the ceiling.
- **Uses today:** spawn at rest, projectiles as loads, watched body (the load ball reaches the far side), load X-ray (designed), bot star casting, materials (iron as counterweight, ice as a trap).
- **Needs new:** builder tool (shares SB-1/SB-2) M, low. Pinned cliff blocks or heavy iron cliffs S/M, low-med. Bot robustness check: jitter ball speed ±quantum and placements by ±1 mm, require ≥80% passes M, low (it is the existing chaos audit).
- **Level seeds:** (1) "Ditch": 1 m gap, 12 planks, beach ball. (2) "Corbel": 3 m gap, cubes only (no planks long enough), bowling ball. (3) "Counterweight": a cliff on one side only; cantilever 2 m and carry a cannonball.
- **Risks:** Friction-only bridges may be too fragile to be satisfying, and the solution space may collapse to one trick (heavy counterweight + plank). A rolling ball on loose planks has chaotic contacts; the robustness gate may reject most player designs.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### SB-4 Tremor Table
- **Pitch:** Build on a shake table, dial in an earthquake, and learn why tall things resonate and why buildings sit on bearings.
- **Fun hook:** A frequency slider and a magnitude slider. The first 30 s: a slender column stays put at high frequency, then you sweep down and at one frequency it rocks wildly and falls. Then you try putting it on four rubber balls.
- **Borrowed from:** seismic engineering shake-table tests, Kerbal Space Program's "test it, learn it" loop, synth-patch tinkering (two knobs you sweep by ear).
- **Loop:** 30 s: build a little tower, shake, watch. 5 min: challenges: "keep the bell block on top through 10 s of magnitude 6", with a block budget; base isolation (spheres under a slab) and wide footprints are the discoveries.
- **Scale story:** 1k: one tower per table, very legible. 10k: a whole town on a 30 m plate; tall and short buildings fail at different frequencies, so a sweep makes them fall in a readable order. 100k: offline showcase only.
- **Uses today:** one big box body as the plate, materials (ice under the plate for low ground friction, rubber balls as bearings), sound, bounding-box and moving-count reductions for "still standing".
- **Needs new:** sparse forces (step 6, planned) to drive the single plate body S once step 6 exists, low. Open-loop force schedule (sinusoid) per step, generated as quantised input events so it replays S, low. Drift correction for the plate (a weak spring back to centre in the schedule) S, med. Heavy plate with hundreds of light contacts is a mass-ratio stress test for AVBD M, med.
- **Level seeds:** (1) "Pencil": one 20-cube column; find the frequency that kills it. (2) "Bearings": build a 2 m tower that survives magnitude 6 using at most 8 spheres. (3) "Old town": a pre-built S14 block on the plate; reinforce with 200 blocks so the church survives.
- **Risks:** A force-driven plate is not a kinematic floor; tracking a displacement waveform needs closed-loop control and readback is pipelined, so the quake will be approximate. The plate may tilt or walk. If step 6 slips, this mode slips with it.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 3 / cost 3

### SB-5 Mason's Notebook
- **Pitch:** A free-build sandbox that watches what you build and fills a notebook with the structural ideas you discover.
- **Fun hook:** You are not told what to build; the game recognises it. Stack four blocks into an overhang past the table edge and a card appears: "Harmonic overhang: 4 blocks, 1.04 block lengths past the edge. The best is not where you think." The first 30 s give you a discovery for almost anything you try.
- **Borrowed from:** discovery logs (Breath of the Wild's recipe journal, Little Alchemy's combination book), Zachtronics' histograms (your result against everyone's distribution, here the bot's), the block-stacking overhang problem, domino amplification (each domino toppling one 1.5x bigger).
- **Loop:** 30 s: build something, Play, maybe a card. 5 min: chase a half-filled card ("arches: you have spanned 3 blocks; can you span 6?"), compare against the bot's best.
- **Scale story:** 1k: the classic cards (arch, cantilever, leaning tower, domino amplifier). 10k: scale cards: the counterweighted "impossible overhang" (overhang that grows faster than harmonic stacking allows, using counterweights), a 30-step domino amplifier from a 2 cm domino to a 10 m slab. 100k: one late card, "the 100k domino field", that relies on sleep.
- **Uses today:** observers and reductions (bounding box, predicates on position, displacement), watched bodies, builder (from SB-1), materials, sound for card chimes.
- **Needs new:** a library of discovery detectors as observer predicates (overhang distance past a reference edge, span between supports, height/base ratio, stood-for-N-s) M, low. Card UI and local progress S, low. Bot-cast "best known" per card M, low.
- **Level seeds:** (1) "The table edge": a pinned table and 30 cubes. (2) "Two posts": two pillars 3 m apart and unlimited cubes; the arch cards. (3) "Dominoes of every size": a palette of 10 domino sizes, the amplifier card.
- **Risks:** Detectors that fire wrongly ("that's not an arch") feel patronising; the set of good cards may be small (~20). It teaches but may not thrill; depends on great copy and chimes.
- **Scores (1-5):** fun 3 / novelty 4 / engine fit 5 / cost 4

### SB-6 Clear-Check Forge
- **Pitch:** A level editor for the main game: build a structure, mark crowns and heritage, choose a rack, and you may share it only after you beat it and the bot says it isn't a lottery.
- **Fun hook:** Authoring as play: you design a trap ("hit the low lintel and the crowns fold inward, everything else is a miss") and the bot's basin meter tells you whether your intended solution is a real solution. The first 30 s: stamp a tower, mark two crowns, fire, win, see "lottery 70%" and want to fix it.
- **Borrowed from:** Super Mario Maker's clear-check rule (you must clear your own level to upload), Trackmania's author medal, puzzle-editor communities (Baba Is You level packs).
- **Loop:** 30 s: tweak, author-run, see basin. 5 min: iterate to a robust level, quick-cast stars, share a link; the friend plays it on their own device, which recasts on load.
- **Scale story:** 1k: the sweet spot for player levels: a local quick cast (16 bot plays + 16 nudges) is a few minutes on a fast Mac. 10k: possible, but casting is ~1 h on an M5 Max, so 10k player levels ship "uncast" (objective-only star) and the author's run is the only proof. 100k: not offered.
- **Uses today:** the whole Keystone level grammar (crowns, skyline, collapse, heritage, footprint, rack), bot star casting, scene JSON, replay <200 bytes for the author run.
- **Needs new:** editor (SB-1 core) M, low. Objective/constraint markup UI S, low. Quick-cast budget mode for the bot M, low. Link encoding of placements + objectives (generator params where possible, else RLE grid) S/M, low. Recast-on-load for the recipient M, med (the author's 3-star line may not be 3 stars on another device; show "stars recast for your device").
- **Level seeds:** (1) "Your first trap": a 200-cube arch with one crown on top and one marble in the rack. (2) "Heritage sandwich": two celadon towers with a crown tower between. (3) "Footprint lot": a 1k S14 building that must fall inside a painted lot.
- **Risks:** Most players do not author; creation communities need discovery and a feed, which needs a backend we do not have. Cross-device divergence can make a shared level unbeatable on the recipient's device for the author's line (recast fixes the stars, not the expectation).
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 3

### SB-7 Rube Lab
- **Pitch:** Contraption building with only boxes and spheres: ramps, rails, see-saws by friction, domino lines, proximity grenades as fuses; ring the bell at the end.
- **Fun hook:** You are designing a cause-and-effect chain whose links are all real physics, so each link can fail in its own way. The first 30 s: tilt a plank, drop a marble, it rolls into three dominoes, the last one misses the bell by a cube; move the bell, try again.
- **Borrowed from:** The Incredible Machine / Contraption Maker (parts bin + goal), marble-run toys (GraviTrax-style tracks), Wintergatan's marble machine, Mario Maker clear check (bot robustness before sharing).
- **Loop:** 30 s: place a part, run, see where the chain breaks (the last link that fired lights up). 5 min: a puzzle with a fixed parts bin, or free-form where the score is chain length and robustness (bot: ≥80% success over 50 jitters).
- **Scale story:** 1k: classic chains. 10k: "marble rush": a funnel releases 1,000 marbles into a 9k-block track; the contraption is now about flow and jams, not single events. Sleep matters because most of the track is idle. 100k: an offline "chain of chains" showcase.
- **Uses today:** spawn at rest, spheres, planks, dominoes, WeaponSpec proximity trigger (a grenade that fires when a body comes near is a ready-made fuse part), blast, watched bodies (the bell's displacement is the goal), replay.
- **Needs new:** pinned bodies for ramps and rails S/M, low-med (essential; loose ramps get kicked away). Builder with rotation snapping M, low. "Last link fired" tracer (watch up to 64 parts, highlight the first one that never moved) S, low. Bot robustness gate M, low. Link sharing S, low.
- **Level seeds:** (1) "Three links": marble, ramp, bell; place one plank. (2) "See-saw": a plank balanced on a cube pivot must launch a ball onto a shelf. (3) "Fuse": route a marble past a proximity grenade so its blast topples a far tower onto the bell.
- **Risks:** No CCD: fast marbles through thin planks can tunnel (fine under ~60 m/s, which is plenty). Without joints, see-saws and levers slide off their pivots; part design must lean on friction and notches (cube stops). Chaotic chains may fail the robustness gate often; tune to tolerance.
- **Scores (1-5):** fun 5 / novelty 3 / engine fit 4 / cost 3

### SB-8 Clatterhymn
- **Pitch:** A step sequencer whose notes are falling marbles: each cell drops a ball onto a tuned plank, so your instrument plays itself and slowly shakes itself apart.
- **Fun hook:** It starts as clean music and degrades into emergent rhythm as planks shift, balls bounce into neighbours and the pile grows. You decide when to "repair" (Regrow) and when to let it go wild. The first 30 s: tap four cells, hear a loop, watch a stray ball knock a plank and add a ghost note.
- **Borrowed from:** step sequencers / grooveboxes (16-step grid), Electroplankton and Sound Shapes (level geometry is the score), Animusic and Wintergatan (mechanical music), modal synthesis (size sets pitch).
- **Loop:** 30 s: program a loop, listen. 5 min: build an "instrument" (planks of different lengths on two rails = a xylophone; stone slabs = a gong; ice cubes = hi-hats), program a 4-bar pattern, record a take, share the pattern link.
- **Scale story:** 1k: one instrument, clean. 10k: a "rubble orchestra": each of 16 tracks is its own tuned structure and the rubble on the floor becomes a granular texture you can hear. 100k: not real time; an offline render of a slow-collapsing 100k "drone piece" is a curiosity.
- **Uses today:** modal impact synth (8 loud voices + resonator bank, per-material timbre), scheduled `spawn` events at quantised steps (a sequencer is literally an input-event list), determinism (fall time from a known height is fixed, so the sequencer pre-compensates to land on the beat), Regrow-style reset.
- **Needs new:** impact event log (step, bodies, impulse) for a visual "what made that sound" and for beat-alignment feedback M, low-med. Size-dependent pitch in the synth (plank length -> fundamental) S, low. Sequencer UI M, low. Tempo/step mapping: 60 Hz steps quantise 120 BPM sixteenths to 7.5 steps, so tempos must be chosen from step-friendly values or swing is unavoidable S, low.
- **Level seeds:** (1) "Glockenspiel": 8 planks on rails, pre-tuned to a pentatonic scale. (2) "Kit": stone slab kick, ice-cube hats, rubber-ball snare. (3) "Decay": a beautiful 1k glass-like (ice) arch that plays a melody while it falls apart over 2 minutes.
- **Risks:** Impact sound with rich physical timbre may still sound like clatter, not music; timing jitter from contact chaos may feel sloppy. Musicians want precision; the hook is the opposite. Niche.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 3

### SB-9 Fallline  *(hybrid: dominoes + rhythm)*
- **Pitch:** Compose a song by painting domino lines whose falling front strikes tuned bars on the beat; then play it as a rhythm game by filling the gaps just before the wave arrives.
- **Fun hook:** Two halves. Compose: domino spacing sets wave speed, so tempo is geometry; branching lines make chords. Play: the shared song arrives with gaps, and you must drop the missing domino (spawn at rest) in the window before the wave reaches it; miss and that voice dies. The first 30 s of play: a wave runs toward a gap, you tap, it carries on and rings a bar.
- **Borrowed from:** domino-toppling showcases (branching lines, staircases, field fills), rhythm games' note highway (here the highway is the wave front), Line Rider's "draw the track, the physics plays it" loop.
- **Loop:** 30 s: one phrase. 5 min (compose): draw lines with a path brush that lays dominoes at a chosen spacing, place bars at line ends, preview (the bot pre-simulates and shows when each strike lands on a timeline), nudge spacing until it grooves. 5 min (play): a 2-minute song with 30 gaps, scored on accuracy (how early before the wave you filled) and survival.
- **Scale story:** 1k: one voice, roughly 5-8 falls per second per line. 10k: a full arrangement of parallel voices; sleep keeps the idle 90% free, so cost is the wave fronts. 100k: a multi-minute piece across a landscape, playable only after sleep compaction; the camera is the player's to drive (or a director track from SB-13).
- **Uses today:** domino boxes, `spawn` at rest, sleep and wake on impact, impact sound, observers (watched bars detect strikes), replay.
- **Needs new:** path brush that lays dominoes along a curve at spacing S/M, low. Strike timeline preview via headless pre-sim on the same device M, low. Gap-fill input with timing windows S, low. Sleep compaction for 100k L, med (planned). Impact event log (shared with SB-8) M, low-med.
- **Level seeds:** (1) "Metronome": one straight line, four bars, a gap every bar. (2) "Fork": a line that splits into a triad at the chorus. (3) "Staircase": rising domino sizes so the wave accelerates through a crescendo.
- **Risks:** Domino wave speed varies with tiny placement errors, so composed timing may drift; the preview fixes it per device but a shared song may land off-beat elsewhere (re-preview on load). Rhythm windows tied to physics may feel mushy compared with a chart.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 3

### SB-10 Flipfield
- **Pitch:** A 100k-domino field is a picture seen from above; topple it and the fallen faces reveal a second picture.
- **Fun hook:** Two images, one trigger, and a wave that redraws the world in front of you. In the creative mode you design both images and the routing of the wave (which way each region falls determines what reveals, and in what order). The first 30 s: a 2k field of a sunflower; tap one domino; a moon wipes across it.
- **Borrowed from:** real-world domino-art "image reveal" fields (standing tops show one picture, the flipped faces another), flip-dot displays, card-stunt crowds in stadiums.
- **Loop:** 30 s: load, tap, watch the reveal. 5 min: import or paint two 64x64 images, choose the wave routing (sweep, spiral, centre-out), preview, fix stalls (regions where the wave dies), share.
- **Scale story:** This idea only works because of scale. 1k: a 32x32 icon, cute. 10k: a 100x100 picture with real detail and a reveal that takes ~20 s. 100k: a 316x316 mural the size of a town square; with sleep, only the wave front (a few thousand bodies) is awake, so the cost of 100k is the cost of a few thousand. This is the brief's "sleep is the enabler" case in its purest form.
- **Uses today:** domino boxes, sleep and wake, per-body tint (shot ink shows per-body colour exists), observers (count fallen = progress bar), sound (a rushing granular wash).
- **Needs new:** per-face colour on a body (top face vs broad face) S, low (shader by local normal). Image-to-field compiler (palette quantise, lay rows, insert feeder lines so every row gets triggered) M, med. Sleep compaction + persistent sleeper grid (E2 next steps) L, med. Stall detector (a region whose dominoes never moved) S, low.
- **Level seeds:** (1) "Day/Night": 32x32 sun to moon, centre-out. (2) "Flag": a sweep from left to right through 10k dominoes. (3) "Portrait": the player's own photo (SB-12's importer) at 100x100, spiral routing.
- **Risks:** Domino fields stall at row ends and corners; real builders use careful feeder lines and so must the compiler. Resting 100k thin dominoes must not jitter awake. The reveal is a one-shot spectacle; replay value comes from making your own.
- **Scores (1-5):** fun 4 / novelty 5 / engine fit 4 / cost 2

### SB-11 Hidden Figure
- **Pitch:** A marble block of 10k-100k plaster cubes hides an iron sculpture; carve it free with shots and blasts, and score how much is exposed and how little is scarred.
- **Fun hook:** Every shot is a sculptor's cut with uncertain depth. Big blasts reveal fast but knock the figure's arm off; a marble chips one cube. The first 30 s: a cannonball takes the corner off the block and you see the glint of iron underneath.
- **Borrowed from:** reveal-by-removal puzzles (Picross 3D chipping away a block to find the object), archaeology dig games (brush vs pick trade-off), the sculptor's "free the figure from the stone".
- **Loop:** 30 s: shot, rubble falls, a "sweep" clears settled rubble outside the block (a `remove` of loose cubes on the floor). 5 min: a full carve with a limited rack per tool (pick = blast M, chisel = marble, brush = sweep); a final photo of the figure.
- **Scale story:** 1k: a 10x10x10 block with a simple shape (an arch inside). 10k: a recognisable figure (a horse, a bust). 100k: a 46-cube cube with fine detail; most of the block sleeps until carved, so cost follows your cutting edge.
- **Uses today:** blast with falloff and maxDv (cut depth control), projectiles, `remove` (sweep), materials (iron figure is denser; plaster around it), heritage-style constraint (iron cubes must not move), observers.
- **Needs new:** exposure metric (count iron cubes with a free face: a GPU neighbour-grid reduction) M, med. Sweep tool (remove bodies that are settled and below a height or outside the block footprint) S, low. Voxel model import for figures S, low. Sleep compaction for 100k L, med.
- **Level seeds:** (1) "Keyhole": an iron arch inside a 1k block. (2) "Bust": a 10k block with an iron head. (3) "Two figures": a 30k block with an iron and a stone figure; stone is fragile (low friction), carve it last.
- **Risks:** Loose-cube carving is coarse; the figure may need to be pinned or very heavy or it falls over when exposed (a feature if it's a constraint, a frustration if not). The exposure metric is the hard part. Players may just blast and accept 1 star.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### SB-12 Shatterprint
- **Pitch:** Drop in any image; it becomes a wall of coloured cubes; wreck it.
- **Fun hook:** It is your cat, your boss's slide, your friend's face, as 5,000 cubes, and you have a cannonball. Instant personal stakes; the first 30 s are pure joy. Light goals: paint heritage regions on the image ("keep the eyes, lose everything else").
- **Borrowed from:** photo-mosaic toys, LEGO mosaic kits (palette quantisation), Angry Birds-style personal targets (mechanic: a target you care about).
- **Loop:** 30 s: import, shoot, laugh. 5 min: build a series (a wall, then the same image as a pyramid or a city skyline via SB-17 generator), set a "keep" mask, try to erase everything except the mask, export a clip.
- **Scale story:** 1k: a 40x25 emoji-scale image. 10k: 128x80, faces are clearly faces and the rubble pile is an abstract remix of their palette. 100k: a 400x250 poster wall; a single big shot leaves a recognisable hole, and the image becomes a structural X-ray of where force went.
- **Uses today:** wall scenario S3, per-body colour (ink path), projectiles, heritage constraint (painted mask), director/export later.
- **Needs new:** image import and palette quantise (client-side, image never leaves the device) S, low. Per-body base colour in the scene file S, low. Mask paint tool S, low. Share: a palette RLE fits a link at 1k-10k (a few KB), 100k needs a file M, low.
- **Level seeds:** (1) "Selfie wall": 64x48 from the webcam or a file. (2) "Keep the eyes": mask a region; collapse everything else. (3) "Two-sided": front image and back image, shoot through.
- **Risks:** Novelty wears off in minutes; it is a hook and a share moment, not a mode by itself. Potential misuse (targets of real people) is mostly harmless locally but argues against a public gallery.
- **Scores (1-5):** fun 4 / novelty 2 / engine fit 5 / cost 5

### SB-13 Cutting Room
- **Pitch:** A replay director: scrub any wreck, lay camera keyframes, ramp slow motion, switch looks, and export a film, including 100k collapses rendered offline.
- **Fun hook:** You already made something spectacular; now you make it look spectacular. Finding the angle where the wrecking ball enters through a window is a creative act. The first 30 s: scrub to the impact, drop a keyframe low by the base, another high and wide, press play, gasp.
- **Borrowed from:** racing-game replay editors (Trackmania's track-and-keyframe editor), theater/replay modes in shooters (free camera on a recorded match), photo modes, nonlinear video editors (timeline, speed ramps).
- **Loop:** 30 s: scrub, frame, watch. 5 min: a three-shot film with speed ramps and a look change at the impact; export WebM; share the replay link plus camera track (a few hundred bytes).
- **Scale story:** 1k-10k: interactive scrubbing at real time. 100k: the killer feature. 100k is not real time (21-37 ms/step), but the director does not need real time: render-offline steps the sim as slowly as needed and writes every frame. This is how anyone sees 100k at 60 fps before the engine gets there.
- **Uses today:** determinism and <200-byte replays, pacing scheduler (slow-mo, fast-forward), both looks, displacement heatmap and ink overlays, sound (re-rendered from replay), snapshots.
- **Needs new:** checkpoints for scrubbing: GPU buffer copies every N steps (10k bodies x ~64 B ~ 640 KB each, keep a ring) and restore M, med (restore must include solver warm-start and sleep state, or re-sim from the nearest full checkpoint, which is always exact). Camera keyframe track with splines and a timeline UI M, low. Canvas capture to WebM via MediaRecorder S, low. Offline fixed-step render mode (no pacing, frame per step) S/M, low. Audio render for export M, med.
- **Level seeds:** (1) Will's test drive: size-5 ball, 80 m/s, Bounce, 1,000-cube wall; pre-placed keyframes as a tutorial. (2) "Kapla fall" in the hall look with a slow orbit the player sets. (3) "Ten thousand", the B3 city, filmed from street level.
- **Risks:** Shared camera tracks replay on a different device whose chaotic outcome may differ, so a framed hero shot may miss; the exported video is the canonical artifact. Editor UX is a lot of UI. Audio export from a Web Audio graph is fiddly.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 3

### SB-14 Forking Paths
- **Pitch:** Hold to rewind any collapse, fire a different shot from any moment, and grow a tree of alternate outcomes you can compare.
- **Fun hook:** Mid-collapse you see the crown wobbling and not falling. Rewind 1.5 s, drop a marble on it while the tower is still falling. Shots into a moving structure are a new verb, and the tree lets you see every "what if". The first 30 s: rewind is instant and the branches appear as a little tree.
- **Borrowed from:** Braid and Prince of Persia: The Sands of Time (rewind as a core verb), Outer Wilds' loop knowledge, version-control branching (git graph UI), chess analysis boards (variation trees).
- **Loop:** 30 s: shot, rewind, alternate shot, compare. 5 min: in a Keystone level, a "find three distinct solutions" goal (branches with different crown sets), or in sandbox, a tree of a dozen wrecks with thumbnails.
- **Scale story:** 1k: rewind is cheap; branch freely. 10k: checkpoints every 30 steps (~640 KB each) keep rewind instant within the last 10 s; deeper rewinds re-sim forward (3-5 ms per step, ~2 s for 10 s of sim). 100k: rewind costs seconds, so only bookmarked branches.
- **Uses today:** bit-determinism per device (a branch is level + shots + the step it diverged; tiny), replay, observers for branch thumbnails (collapse %, crowns down), freeze-while-aiming.
- **Needs new:** state checkpoint/restore (shared with SB-13) M, med. Mid-sim shot input (shots while bodies move; today physics freezes while aiming, so this is a rule change) S, low. Branch tree UI M, low. Rewind playback (render recorded frames backward while restoring the nearest checkpoint) S, low.
- **Level seeds:** (1) "Three ways down": a tower where crowns can fall left, right or straight. (2) "Catch it": a crown that always survives the first shot; you must intervene mid-fall. (3) "Butterfly": a sandbox demo of chaos: the same shot one quantum apart, two branches, very different piles.
- **Risks:** Rewind trivialises Keystone's one-shot tension; it belongs in a sandbox or as a limited resource. Restore bugs break determinism silently; needs a test that restore + re-sim equals uninterrupted sim bit-for-bit.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 4 / cost 3

### SB-15 Shutter Collapse  *(hybrid: progression)*
- **Pitch:** A photo safari inside a collapse: freeze time at the decisive instant and take one of three exposures, scored on what is in frame.
- **Fun hook:** The collapse is the subject and timing is everything; too early and nothing is airborne, too late and it is a pile. Freeze, orbit (camera is yours), shoot. The first 30 s: fire, hit pause as the top storey peels away, frame it, score "412 cubes airborne, crown in frame, heritage behind it".
- **Borrowed from:** Pokémon Snap's photo scoring (subject size, centring, pose, extras in frame), sports-photography timing, photo-mode culture.
- **Loop:** 30 s: one collapse, three exposures. 5 min: a "commission" board: "a crown mid-fall above an unbroken heritage block", "more than 1,000 cubes airborne", "the wrecking ball inside the wall"; album pages fill in.
- **Scale story:** 1k: compositions about single blocks. 10k: compositions about masses and clouds; "airborne count" becomes the headline. 100k: offline-rendered commissions from SB-13 (freeze is free at any scale, since a frozen frame is just a frame).
- **Uses today:** freeze, player camera, both looks, reductions (counts of moving bodies with predicates on position and velocity), watched bodies for subjects (crowns, heritage, ammo), PCSS shadows and dust for beauty.
- **Needs new:** frustum predicate in a reduction (count bodies inside the camera view and above the floor with speed > v) S/M, low. Photo scoring rules and commission data S, low. Album with local storage S, low. Depth-of-field and motion-blur render options M, low.
- **Level seeds:** (1) "First flight": catch 100 cubes in the air. (2) "Heir and spare": crown falling, heritage standing, both in frame. (3) "Through": the cannonball inside the wall, with exit debris visible.
- **Risks:** Score rules may reward cheesy framing (max zoom-out for counts); needs a subject-size term. Reductions are pipelined, so the score appears a frame or two late (fine, the world is frozen).
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### SB-16 Hourglass Garden
- **Pitch:** A zen accretion toy: a slow rain of cubes pours from a spout you aim, onto deflector slabs you place, and over an hour grows into a 100k-cube landscape.
- **Fun hook:** No goal and no failure; the decision is where to steer the flow and what material to pour (ice slides into long dunes, rubber bounces into scatter, stone piles steeply). The first 30 s: the pour starts, the sound is gravel and rain, you tilt a slab and a fan of cubes slides off it.
- **Borrowed from:** sand-art bottles and kinetic sand, falling-sand games (The Powder Toy, Noita's sand), Viridi and other slow "come back later" toys, the angle-of-repose science demo.
- **Loop:** 30 s: aim, pour, listen. 5 min: build a valley with slabs, switch materials to layer strata, take a long-exposure photo (motion trails), save; come back tomorrow and keep pouring onto the same pile.
- **Scale story:** Scale is the whole progression. 1k: a cone. 10k: strata, terraces, avalanches when a slab slips. 100k: a terrain. Cost tracks the awake surface of the pile, never its size, which is exactly what sleep promises; this mode is a good soak test for sleep.
- **Uses today:** scheduled `spawn` (a spout is an input-event stream), materials, granular sound with crossfade (Rubble Garden graft), sleep, save/load.
- **Needs new:** spout emitter tool (rate, spread, material) S, low. Pinned deflector slabs S/M, low-med. Sleep compaction + persistent sleeper grid L, med. Long-exposure render (accumulate frames) S, low. Save a 100k scene (quantised poses, ~1.2 MB file) S, low.
- **Level seeds:** (1) "First pour": empty plain, one slab. (2) "Terraces": a pre-built stepped wall to fill. (3) "Strata": pour five materials in sequence into a glass-sided box (pinned walls) and cut it open with a blast.
- **Risks:** Zen modes test well and retain poorly (the Rubble Garden verdict: no tension). Sleep is not finished; a 100k pile that wakes in an avalanche can spike the step to 30 ms (but the awake-adaptive valve turns that into slow motion, which suits the mode).
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 4 / cost 3

### SB-17 Seedworks
- **Pitch:** Procedural architecture with knobs: tune a generator (storeys, bond pattern, window ratio, lean, decay, material mix), watch a city regrow, wreck it, share the seed in 40 characters.
- **Fun hook:** The structure is no longer given; you are designing the difficulty and the beauty at once. Slide "decay" up and watch the same tower become a ruin that falls at a touch. The first 30 s: drag the "storeys" slider and a 10k building grows taller in real time (re-spawn at rest).
- **Borrowed from:** Townscaper (procedural detail from simple input), Minecraft and No Man's Sky seeds (shareable worlds as short strings), Spore's slider-based editors, daily-seed challenges in roguelikes.
- **Loop:** 30 s: slide, see, shoot. 5 min: build a seed you like, run a Keystone objective on it, post the seed; a "seed of the day" gives everyone the same structure and the same rack.
- **Scale story:** 1k: knobs read as shape. 10k: knobs read as character (a Flemish-bond warehouse vs a decayed stretcher-bond ruin). 100k: generators make 100k honest, since nobody hand-builds 100k; the knob that matters at 100k is "district layout", and you pick which district to shoot.
- **Uses today:** scenario generators already parameterised (S3 wall, S4 city, S14 buildings, S15 Kapla, pyramid), spawn, all objectives, link-sized level definitions.
- **Needs new:** expose generator params as UI with live regeneration S/M, low. Seed string codec S, low. New knobs (bond pattern, decay, lean, material mix) per generator M, low. Daily seed with local streak S, low.
- **Level seeds:** (1) "Ruin slider": an S14 building with decay 0-60%. (2) "Bond school": one wall, four bond patterns, same shot. (3) "Seed of the day": an S4 city with a fixed rack of three.
- **Risks:** Too many knobs and nothing feels authored; needs good defaults and a few knobs with strong effects. Live regeneration of 10k bodies is a re-spawn of the world; must be fast (it is a buffer upload, so likely fine).
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 4

### SB-18 Siegeworks  *(hybrid: competitive)*
- **Pitch:** Build-then-wreck: you get 90 seconds and 600 blocks to fortify a king block; your friend gets three shots to drop it; swap.
- **Fun hook:** Building with an opponent in mind turns structure reading inside out: you design for the shot you fear. The first 30 s: you wall the king, they lob a grenade over the wall, you learn about roofs.
- **Borrowed from:** fort-building vs siege games (Worms forts, Fortress-style build/battle phases), Angry Birds' fortresses (as the target model), Bridge Constructor's budget, Tower defense build phase timers.
- **Loop:** 30 s: one phase. 5 min: a best-of-three match, hot-seat on one device; or async: send your fort as a link, your friend wrecks it on their device and sends back the replay link (their result on their device; the king's survival is theirs to claim).
- **Scale story:** 1k: a fort and three shots. 10k: a castle siege with a budget of 5,000 blocks per side and a rack of weapons, with a placement tool that lays walls by the course. 100k: no; build time becomes the problem.
- **Uses today:** spawn at rest, the full rack (marble, cannonball, cue, drop, projectiles, weapons), skyline/heritage-style objectives (king block above line), replay links, hot-seat (deterministic on one device).
- **Needs new:** builder with budget and timer (SB-1 core) M, low. Fort "stand check" (must stand 5 s untouched before handoff; re-checked on load) S, low. Match flow UI S, low. Link encoding for 600 placements (~3-4 KB) S, low.
- **Level seeds:** (1) "King's hill": a mound, 300 cubes, rack of two cannonballs. (2) "Moat": a ditch around the build area where cue shots don't reach. (3) "Plank fort": planks only; the attacker gets drops (anvils).
- **Risks:** Turtle meta (a solid cube around the king) may dominate; needs budgets and materials that make solid walls costly or rubble footprint rules. Hot-seat needs two people at one machine; async through links lacks a feed.
- **Scores (1-5):** fun 4 / novelty 3 / engine fit 5 / cost 3

### SB-19 Daily Seventeen
- **Pitch:** Every day, one constraint and seventeen blocks: build the tallest, the farthest overhang or the longest span, and the score is multiplied by how robust your build is.
- **Fun hook:** Tiny constraint, deep space. Seventeen blocks is quick to place, so you iterate dozens of times, and the robustness multiplier punishes knife-edge builds. The first 30 s: a 17-block column, Play, it stands, robustness 0.4 because the bot's jittered copies fell. Start again, wider.
- **Borrowed from:** Wordle's daily cadence and shareable result string, haiku-style constraint creativity, Zachtronics' cost/size histograms, Kapla challenge cards.
- **Loop:** 30 s: one build and test. 5 min: a daily session: 10-20 iterations, submit, share a link that encodes all 17 poses (about 140 bytes, the same order as a replay).
- **Scale story:** Deliberately tiny on the build side. The scale is in the judge: 64 jittered copies of your 17 blocks (±1 mm, ±0.2 degrees) placed far apart in one world, 1,088 bodies, simulated for 10 s; the fraction left standing is the multiplier. A 10k "weekly" variant (Seventeen Hundred) uses the same judge with 6 copies.
- **Uses today:** spawn at rest, bounding-box and predicate reductions (height, overhang, still standing), bot jitter machinery from star casting, the scene/replay link format.
- **Needs new:** multi-copy judge (copies spatially separated in one solve) S/M, low. Daily prompt list and local streak S, low. Placement tool (SB-2's) M, low. Share string S, low.
- **Level seeds:** (1) "Tall": 17 planks, height. (2) "Reach": 17 cubes, overhang past a pinned edge (the harmonic stacking problem). (3) "Span": 17 dominoes and two posts 1.5 m apart.
- **Risks:** Without a server there is no leaderboard, only shared links and self-comparison. Robustness is per device; a friend's device may judge your build differently (state the device score as the score).
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 5

### SB-20 Salvage Yard  *(hybrid: progression)*
- **Pitch:** Rubble you knock down in levels becomes material in your own yard, where you build a monument that grows across sessions and can be exported as a level.
- **Fun hook:** Demolition earns building, building gives demolition meaning. Iron is rare (you only get it from iron levels), so your monument tells the story of your play. The first 30 s after a level: "+412 plaster, +18 stone" and your yard's half-built arch waits.
- **Borrowed from:** Minecraft survival (mine to build), Animal Crossing's island (a persistent personal space you return to), salvage/crafting loops in survival games, Dorfromantik's calm persistent board.
- **Loop:** 30 s: collect after a level. 5 min: build in the yard with the material you have; occasionally wreck a part of your own monument for fun (it refunds half).
- **Scale story:** 1k: early yard, a hut. 10k: after a week of play, a palace; the yard is now a structure worth wrecking and worth sharing as a Clear-Check level (SB-6). 100k: long-term goal: a city-scale monument, viable once sleep compaction makes a resting 100k cheap.
- **Uses today:** Keystone levels and scoring (displacement counts by material), progress in browser, scene JSON, builder (SB-1/SB-2).
- **Needs new:** material inventory economy S, low. Persistent yard scene (local storage or file, ~1 MB at 100k) S, low. Builder M, low. Balance (how much rubble per block) S, med.
- **Level seeds:** (1) "The plinth": a starter foundation that needs 200 stone. (2) "The arch": a blueprint ghost that fills as you place, needing 1,000 plaster. (3) "The tower of iron": a late blueprint requiring rare iron from W-iron levels.
- **Risks:** Economy loops can make building feel like a chore; keep a free creative toggle. Browser storage can be wiped; an export file is the safety net.
- **Scores (1-5):** fun 3 / novelty 3 / engine fit 5 / cost 4

### SB-21 Implosion Score  *(hybrid: destruction)*
- **Pitch:** Choreograph a controlled demolition: place charges on columns, set their delays on a timeline, and drop a building into its own footprint without touching the neighbours.
- **Fun hook:** Real demolition is a sequencing problem: cut the core first, then the outside walls a beat later, and the building folds inward. Get the order wrong and it topples onto the cathedral. The first 30 s: three charges, all at t=0; the building falls sideways; set the middle one 200 ms earlier and it folds.
- **Borrowed from:** real building-implosion delay sequencing, fireworks-show editors (timeline cues synced to music), music trackers (rows as time), Blast Corps-style "clear the path" goals.
- **Loop:** 30 s: place, sequence, fire, see footprint score. 5 min: a 10k building with 20-40 charges; the creative layer is also aesthetic: sync the cues to a music track and export the film (SB-13).
- **Scale story:** 1k: a tower and four charges; delays are the puzzle. 10k: a city block with neighbours of different heights; sequencing decides which way debris goes. 100k: a skyline, needs tiered blasts (step 8) and offline render.
- **Uses today:** blast centred on a body with falloff and maxDv, scheduled input events at quantised steps (a delay is just a step index), footprint and heritage constraints, collapse objective, S14 buildings, director/replay.
- **Needs new:** charge placement + timeline UI M, low. Charge-on-body that follows the body if it moves before firing (blast "centred on a body" already supports this) S, low. Music-sync markers (optional) S, low. Tiered blasts for 100k (step 8) L, med.
- **Level seeds:** (1) "Fold": a 600-cube tower, four charges, footprint lot. (2) "Neighbours": a 5k block between two heritage houses. (3) "Show": a firework weapon finale over the falling building, cues on beats.
- **Risks:** Loose-cube buildings may not need cutting to fall; they may fall too easily, making sequencing irrelevant. Buildings without joints have no "columns carrying slabs" unless the generator makes them, so levels must be designed to need ordering. The bot must verify that order matters.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### SB-22 Munitions Workshop
- **Pitch:** A visual editor for WeaponSpec trees: compose triggers, splits and blasts into your own munitions, test them on a range, and share a weapon as a 100-byte string.
- **Fun hook:** The weapon is the creation. A shell that splits at apex into six that split on proximity into blasts is a recipe; tweaking one rule changes the whole spectacle. The first 30 s: take the built-in cluster, change "after 1.0 s" to "at apex", fire, see a rain of bomblets instead of a spray.
- **Borrowed from:** Noita's wand building (ordered modifiers and triggers composing into emergent spells), firework-design sims (shell, break, stars), Factorio's blueprint strings (share a design as text), Besiege's "build the machine, then test".
- **Loop:** 30 s: edit a rule, fire on the range. 5 min: "contracts" with light goals ("clear exactly the top half of this tower", "land a star on each of 12 crowns"), plus free experimentation; save to a personal rack usable in sandbox levels.
- **Scale story:** 1k: weapons read individually. 10k: crowd effects, a firework whose 12 stars each wake a district. 100k: weapons become tools for shaping huge worlds; needs tiered blasts (step 8).
- **Uses today:** WeaponSpec (shell + rules + actions + split to depth 3; grenade, firework, cluster built-ins; S/M/L/XL), blast, remove, replay.
- **Needs new:** node/rule editor UI M, low. Spec budget caps (max children, max total blasts, max dv) so shared weapons cannot DoS a device S, low. Range scene with dummy targets S, low. Relative spawn (step 5) and thrust (step 6) unlock rockets and shaped charges S each once built, low.
- **Level seeds:** (1) "Range": three dummy towers at 10/30/60 m. (2) "Half and half": take off the top half of a tower and leave the bottom. (3) "Twelve stars": twelve crowns in a ring; one firework.
- **Risks:** An editor for event rules is abstract; must be visual and immediate. Depth ≤3 limits expressiveness, but that limit also keeps it legible. Creative weapons may break Keystone's balance; keep them in sandbox unless cast.
- **Scores (1-5):** fun 4 / novelty 4 / engine fit 5 / cost 4

### SB-23 Rubble Breeder  *(wild)*
- **Pitch:** Aesthetic evolution of collapses: the game shows nine mutated structure-plus-shot variants side by side, you pick the most beautiful, and it breeds the next nine.
- **Fun hook:** You do not design; you select. After ten generations you have bred a species of collapse nobody would have built (a tower that unzips in a spiral, a wall that pours like water). The first 30 s: nine small towers fall at once in a grid, one of them does something lovely, click it.
- **Borrowed from:** Picbreeder and Electric Sheep (interactive evolution by human selection), Spore's creature lineage, Endless Forms (evolved 3D shapes).
- **Loop:** 30 s: one generation (all nine variants simulate in parallel). 5 min: 10 generations, then "export genome" to a seed string, load it in Seedworks (SB-17) at full scale.
- **Scale story:** 1k per variant x 9 = 9k bodies in one solve, placed 100 m apart on the same ground plane, so a generation costs the same as one 10k level. 10k per variant is a slow generation (offline). The breeding happens small; the payoff is rendering the champion at 10k-100k.
- **Uses today:** scenario generators as a genome (their params), shot params (spawn pose/velocity, weapon choice) as genes, one solver with spatially separated worlds, determinism (a genome is a reproducible creature on this device).
- **Needs new:** genome encoding over generator + shot params S, low. Mutation and crossover S, low. 3x3 grid camera/viewport (or one camera over the grid) S, low. Optional automatic "interestingness" hints from reductions (energy release, spread, airtime) S, med.
- **Level seeds:** (1) "Primordial": nine Kapla towers, one marble each. (2) "Walls": nine S3 walls with mutated bond and shot angle. (3) "Fireworks": nine firework WeaponSpecs fired into identical towers (breeding the weapon, links to SB-22).
- **Risks:** Most mutations look similar; the genome must have knobs with visible effects. Selection fatigue after a few generations. Spatially separated worlds might still interact via shared solver iteration budgets (fine for AVBD, but confirm no cross-talk).
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 5 / cost 4

### SB-24 Tilt Table  *(wild)*
- **Pitch:** You control gravity's direction: tilt the world up to 30 degrees and pour a 10k-cube city like sand into the shape you want.
- **Fun hook:** A single, physical, total input. Tilt slowly and towers lean, ice slides first, rubber rolls, plaster holds; tilt hard and everything avalanches. Goals are sculptural: "fill the bin", "leave only the tower on the hill standing". The first 30 s: tilt a little, watch a city creak; tilt more, watch it pour.
- **Borrowed from:** tilt-maze toys (wooden labyrinth boards), Super Monkey Ball's "tilt the world, not the ball", sand-table toys, falling-sand games.
- **Loop:** 30 s: tilt and pour. 5 min: a sculpting challenge with tolerance bands (fraction of bodies inside a target region), or free pouring with save.
- **Scale story:** 1k: you tilt individual towers. 10k: a city becomes granular flow and you sculpt dunes and deltas (builds on SPILLWAY's rubble-as-flow, but the player's verb is gravity itself). 100k: a mountain landslide, offline-render territory.
- **Uses today:** materials with very different friction (ice mu 0.05 vs stone), sleep, reductions (counts in region), sound granular crossfade.
- **Needs new:** runtime-changeable gravity vector S/M, med (likely a uniform; must wake every sleeper on change). Pinned walls/bins (the ground plane is infinite, so a tilted world sends everything away forever without them) S/M, low-med. Visual cue for tilt (rotate the rendered world instead of the gravity, which reads more naturally; camera stays player-controlled) S, low.
- **Level seeds:** (1) "Pour": a 2k pile into a bin across the plain. (2) "Hold fast": tilt to 25 degrees and keep the marked tower standing while everything else slides off. (3) "Delta": pour 10k ice cubes down a pinned channel and shape a fan.
- **Risks:** A tilted world with a flat ground plane is a strange mental model unless rendered as a tilting tray. Gravity changes wake all bodies, so a 10k tilt is a full-cost step every time. May feel like spectacle without decisions.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 3 / cost 4

### SB-25 Rubble Telephone  *(wild)*
- **Pitch:** A creative chain letter: each player builds something out of the previous player's settled rubble, wrecks it, and passes the pile on.
- **Fun hook:** You never start from nothing and never know what the pile will become. Constraint is the muse: "I got 3,000 cubes of someone's ruined castle; I'll make it a whale". The first 30 s: open the file, see the pile, see the history strip (castle, then bridge, then pile), start building.
- **Borrowed from:** Exquisite Corpse and Gartic Phone (each step transforms the last; reveal the chain at the end), chain-letter art projects, "remix" cultures.
- **Loop:** 30 s: inspect the pile and its history thumbnails. 5 min: build with only the bodies in the pile (a pick-up-and-place tool: `remove` from the pile, `spawn` in your build), wreck it with one shot, export the new pile.
- **Scale story:** 1k: playful; you rebuild it all. 10k: you rebuild a part and keep the rest as terrain; the chain accumulates landforms. 100k: the pile is a world; each player stamps a district on it.
- **Uses today:** scene save/load (the baton is the scene file), `remove` and `spawn` (moving a body = remove + spawn), all tools and weapons, snapshots (to export the settled state).
- **Needs new:** settled-state export with quantised poses (12 bytes/body; 10k = 120 KB file, too big for a URL, fine as a file) S, low. Pick-up-and-place tool constrained to the pile's bodies M, low. History strip (thumbnails carried in the file) S, low. A hosted baton (backend) L, med, only if it should travel without files.
- **Level seeds:** (1) "Seed pile": the rubble of Will's 1,000-cube wall after the 80 m/s ball. (2) "Kapla heap": a fallen plank tower; build a ship. (3) "City debris": the B3 rubble field; plant a monument.
- **Risks:** Needs groups of friends; file passing is friction. Cross-device: the pile is shipped as state, so it is exact, but each player's wreck is device-local (that is fine here). Fun depends on community, which has no home without a backend.
- **Scores (1-5):** fun 3 / novelty 5 / engine fit 4 / cost 4

---

## Capability primitives this lens keeps needing

| Primitive | Effort / risk | Needed by |
|---|---|---|
| **Edit-mode world**: place and remove with time stopped; rebuild exactly from the scene on Play; reset to built state | S-M / low | SB-1, 3, 5, 6, 7, 18, 20, 25 (and SB-2's live variant) |
| **Placement tool**: CPU pick against bodies, face-snap, ghost preview, rotate, undo, layer repeat | M / low | SB-1, 2, 3, 5, 6, 7, 9, 18, 19, 20, 25 |
| **Pinned (zero inverse mass) bodies** for ramps, rails, cliffs, bins, table edges | S-M / low-med | SB-3, 5, 7, 16, 19, 24 |
| **Compact share codec** (generator params, placements RLE, WeaponSpec, palette) in URL hash; file for big states | S-M / low | SB-6, 7, 9, 10, 12, 17, 18, 19, 22, 23, 25 |
| **Bot robustness judge**: N jittered copies spatially separated in one solve, fraction that pass | S-M / low | SB-3, 6, 7, 18, 19, 21 |
| **Multi-world in one solve** (variants placed far apart; one camera or a grid view) | S / low | SB-19, 23, 14 (side-by-side branches) |
| **State checkpoint + restore** (incl. warm-start and sleep state; test: restore+re-sim == uninterrupted, bit for bit) | M / med | SB-13, 14, 15 |
| **Offline fixed-step render + video export** (MediaRecorder; audio render) | S-M / low-med | SB-13, 10, 21, 2 (100k showcases), 15 |
| **Impact event log** (step, bodies, impulse) beyond the synth's top 8 | M / low-med | SB-8, 9, 15 (subject detection), 7 (chain tracer) |
| **Scheduled spawn emitters** (spout, sequencer) as quantised event streams | S / low | SB-8, 16, 9 |
| **Per-body and per-face colour** in scene data and shader | S / low | SB-10, 12, 11, 20 |
| **Sleep compaction + persistent sleeper grid** (E2 next steps) | L / med | SB-10, 11, 16, 9, 1 (100k), 20 (100k) |
| **New observer predicates**: overhang past edge, span between supports, frustum count, exposure (free faces), stall regions | S-M / low-med | SB-5, 11, 15, 10, 3 |
| **Timeline UI** (keyframes, cue delays, strike preview) | M / low | SB-13, 21, 9, 8 |
| **Sparse forces (step 6)** | planned | SB-4 (shake plate), 2 (finger poke), 22 (thrust) |
| **Runtime gravity vector** (wake all on change) | S-M / med | SB-24 |
| **WeaponSpec editor + spec budget caps** | M / low | SB-22, 21, 23 |

The single highest-leverage investment for this lens is the **edit-mode world + placement tool** (one build, eleven ideas). The second is **checkpoint/restore** (unlocks the director, rewind and photo modes, and doubles as a determinism test). The third is **pinned bodies**, which every contraption, bridge and pouring idea assumes.

## My top 5 and why

1. **SB-13 Cutting Room.** It turns the project's strongest asset (deterministic, tiny replays of spectacular collapses) into something people make and share, it obeys Will's camera rule by construction (the player is the camera operator), and offline rendering is the only way anyone sees a 100k collapse at 60 fps this year. Mostly UI plus checkpointing; checkpointing pays for itself in tests.
2. **SB-7 Rube Lab.** The contraption genre has proven retention, every part is a box or a sphere, WeaponSpec proximity triggers are already a fuse part, the existing bot becomes a clear-check gate, and the 10k "marble rush" gives scale a real role (flow and jams). Needs pinned bodies.
3. **SB-10 Flipfield.** The purest expression of "sleep makes 100k matter": a 100k-domino mural whose cost is its wave front. A spectacle Will would film, and a creative tool (design both images and the routing). Waits on E2 compaction, cheap otherwise.
4. **SB-2 Plank Hall.** Live-physics plank building in the hall look is the Kapla experience Will already loved, with the topple as the payoff. Small new surface (placement tool, layer repeat), and it is the first customer for the shared builder.
5. **SB-21 Implosion Score.** Fits today's engine almost completely (blasts on bodies, scheduled steps, footprint and heritage constraints, S14 buildings), adds a genuinely new decision (ordering in time), and its output feeds Cutting Room. Risk to verify first: loose-block buildings must be designed so that ordering matters.

Honourable mention: **SB-19 Daily Seventeen**, the cheapest idea here with a built-in daily habit and 140-byte share links; build it if a quick retention experiment is wanted.
