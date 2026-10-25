<!-- Written by the concept panel (6 designers, 3 judges, 1 synthesis), 2026-10-25. Where it conflicts with findings.md, the findings win: they come from running it. -->

# KEYSTONE: design (v0.1, prototype target)

## 1. Pitch
A golf-par demolition puzzle on an architect's table. Each structure has a weak point. One steel marble in the right place lets the tower's own weight do the work: the gold crowns fall, the celadon heritage pieces next to them stay standing, and a live **leverage** counter (collapse energy released ÷ energy you fired) climbs to x40.

The fun is reading the structure first. You orbit it and see how load flows through columns and lintels, choose one shot, then watch a deterministic cascade you set up. You can replay it, improve it and share it.

The core moment has to work with one ball and one 400-cube structure. Scale is the payoff, not the premise.

## 2. Units and physics conventions
- **Cube edge h = 0.5 m** by default (`LevelDef.unit`). Gravity is 9.81 m/s². dt = 1/60 s, which is the engine contract.
  - Why 0.5 m: a 12-course column (6 m) falls in about 1.1 s, which reads as weighty. Rapier is also more stable at this scale than at 0.25 m. The playtest A/Bs h = 0.25 m against 0.5 m.
- **Densities are real (kg/m³).** One plaster cube is 125 kg and is the "cube mass" unit.

| Material | Density | Friction | Restitution | Mass vs plaster cube | Look |
|---|---|---|---|---|---|
| Plaster | 1000 | 0.6 | 0.05 | 1.0 | Matte white (default) |
| Stone | 2500 | 0.7 | 0.02 | 2.5 | Grey |
| Iron | 7800 | 0.5 | 0.0 | 6.2 | Near-black counterweight |
| Ice | 900 | 0.05 | 0.05 | 0.9 | Frosted |
| Rubber | 1100 | 0.9 | 0.6 | 0.9 | Muted coral |
| Steel | 7800 | 0.5 | 0.1 | — | Rods and ammo |

- **Mass-ratio rule** (S9 limit, enforced by the level validator):
  - Any two structure bodies within 0.1 h of touching: mass ratio ≤ 10:1.
  - Static load on any cube: ≤ 12 cube masses above it in its support chain (a heuristic from the X-ray load map).
  - Ammo against the lightest structure body: ≤ 20:1 (transient contact only).
- **Tunnelling rule** (the contract has no CCD): for each ammo type, v_max · dt ≤ 0.8 · (2r + t_min), where t_min is the thinnest structure body in the level. The validator checks this.
- **No static bodies yet.** There is no raised plinth. The lot is a rectangle painted on the ground plane, and the "crown line" is a glowing height ring. This keeps the prototype free of contract changes.

## 3. Verbs
All ammo is a plain `spawn` InputEvent. Shots are quantised integers so they replay exactly.

| Ammo | Body | Mass | Launch | Role |
|---|---|---|---|---|
| **Marble** | Steel sphere r = 0.1 m | 32.7 kg (0.26 cube) | 6–18 m/s, KE up to 5.3 kJ | The scalpel. Knocks out or shoves one cube; hero verb for keystone shots. |
| **Cannonball** | Iron sphere r = 0.25 m | 510 kg (4 cubes) | 5–12 m/s, KE up to 36.7 kJ | Brute force. Same stroke cost, about 7x the energy, so it tanks leverage. The honest fallback. |
| **Cue** | Steel rod, half-extents 0.05 × 0.05 × 0.6 m | 94 kg | 1.5–5 m/s along its axis, KE up to 1.2 kJ | The Jenga push. Placed by clicking a cube face; spawns 0.05 m off the face along the outward normal and is fired inward. Huge leverage when it works. |
| **Drop** | Steel anvil cube, edge 0.4 m | 500 kg | Spawned at rest at a level-fixed height above a grid point snapped to ¼ h. KE_ammo = m g (y_spawn − 0). | Vertical crush and lever loading. |

- **Launcher:** a point on a ring of radius R_launch around the lot centre. Its azimuth follows the camera, snapped to 0.5°. Its height is snapped to ¼ h within [minY, maxY]. Aim is yaw and pitch offsets at 0.1° plus power at 1%.
  - Mouse: click a target point. An inverse-ballistics solver picks the quantised shot whose arc passes closest to it.
  - Keyboard: arrows nudge yaw and pitch one quantum (Shift = ×10); W/S nudge power ±1%.
  - The camera never affects the shot except by choosing the launcher azimuth, and that choice is quantised and recorded.
- **Arc preview:** drawn up to the first body it would hit, computed by sweeping the predicted arc against the current snapshot's oriented boxes. The hit body gets an outline.
- **Read (free, never costs a stroke):**
  - Snap views 1–4 (front, side, back, top).
  - Load X-ray (hold Tab; unlocked at L3): tints each cube by carried load, graphite at zero to amber at maximum. Load threads run down each column, and red arrows mark slab contact patches.
- **Retry:** R, instant.
- **Replay:** V. Arrow keys scrub by re-simulation; H toggles the heatmap.
- **Skip settle:** Space runs 4 steps per frame.
- Plank, Charges and Quickdraw are later worlds (see Progression).

## 4. Core loop
**30 seconds.** Orbit the structure. Tab for X-ray. Pick ammo (1–4) and click a target; the arc shows the first-hit cube. Fire. Hit-stop, then slow-mo as the first crown tips while the leverage counter ticks up. Watch the rubble: displaced cubes take the shot's ink colour. The settle bowl rings and the result chip appears: "Crowns 5/8 · x23 · 0 heritage". Take the next shot from the rack, or press R and the cubes Regrow back into the tower in 0.6 s. Input is live immediately.

**5 minutes.** A level is one structure, a par of 1–4 strokes and a fixed rack of ≤ 6 ammo.
- It clears when the objective is met, and fails when the rack is empty. Retry is free.
- Typical arc: attempt 1 is brute force and clears over par. Attempts 2–4 come from reading the structure and reach the par line (the "aha"). Some players then chase 3-star leverage, or the hidden Ace (a 1-stroke solution, shown as a silhouette badge).
- After a clear: the tally slams in line by line, a golf stamp lands ("BIRDIE −1"), stars fill, and a cinematic auto-replay plays.

**Session.** Worlds of 8–10 levels with star gates; each world adds one mechanic. Aces and 3-star leverage give a completionist layer. Shots are replays of under 200 bytes, so ghosts and links can be shared (post-prototype). Later: a bot-verified Keystone of the Day and a level editor gated by the same solvability bot.

## 5. Objectives and level grammar
**Objectives:**
- **Fell the Crowns:** every crown's centre is below `crownLine`, or its xz is outside the lot.
- **Skyline:** settled height below H_target.
- **Footprint:** at most F_max of structure bodies end up outside the lot grown by 0.5 h.
- **Extraction** (later): crowns down with ≥ 90% of other bodies undisplaced.

**Constraint: Heritage** (celadon). Broken if it moves more than 0.3 h from its level-start pose, or rotates more than 15°.

**Grammar.** Loose lattice: a cube is supported only by the cube beneath it, so architecture is post-and-lintel, levers and counterweights. That keeps load paths readable.

The loose-stack behaviours a level can rely on are measured by the mechanics probe (prototype step 4), not assumed:
- **(B1) sub-column drop:** removing a cube drops the 1×1 sub-column above it by one course.
- **(B2) course shear:** a side hit shears the stack at the impact course.
- **(B3) low-friction slip:** an ice course lets the block above slide off as a unit.
- **(B4) undercut tip:** removing more than half of a course's footprint on one side tips the block above toward that side.
- **(B5) slab slide:** a tilted slab sheds its load above the friction angle; at μ = 0.6 that is about 31°.
- **(B6) lever throw:** a slab on a pier catapults the load on its far end.

Each level ships with three things: a recorded par solution; at least one red herring (the obvious target, which is wrong); and an Ace, if the bot finds one.

## 6. Five starter levels
All within 2,500 bodies; most are far below. Dimensions are in h unless marked. The mechanic claims are hypotheses: the bot either confirms them or forces a redesign (see Risks).

**L1 "Open Fire"** (W1-1, onboarding, 360 bodies)
- Structure: a 6×6×10 plaster tower; the 4 corner cubes of the top course are Crowns.
- Lot 14×14, centred. Crown line 2 h. Rack: 3 cannonballs, 2 marbles. Par 2.
- No X-ray, no heritage. The launcher starts pre-aimed at the base of the south face with one tip: "Click to fire".
- Mechanic: B2/B4. A low cannonball blows out the base on one face, the tower kneels, and 1–3 crowns fall; shot 2 cleans up.
- Goal of the level: time to first collapse under 10 s, and teaching that a low hit topples while a high hit only chips. The Ace exists only if the bot finds a corner shot that drops all four.

**L2 "Lintel"** (W1-4, 151 bodies)
- Two 2×2×12 plaster columns at x ∈ [−4,−2] and [2,4], z ∈ [−1,1].
- A stone lintel slab of 8 × 0.25 × 2 h rests on them. Six Crowns (3×2×1) sit on its centre.
- A heritage pavilion (4×4×3, celadon, 48 cubes) stands at x ∈ [−5,−1], z ∈ [−8,−4], i.e. 3 h behind the left column.
- Lot x ∈ [−8,8], z ∈ [−9,5]. Crown line 2 h. Rack: 2 marbles, 1 cannonball. Par 1.
- Red herring: shooting the crowns knocks 1–2 off.
- Par line: bring down the RIGHT column. The lintel's right end drops, the slab passes 31°, and all 6 crowns slide off (B5).
- The second trap: bringing down the left column from the front throws rubble into the pavilion and cracks heritage. The read is "both columns carry the same load, but only one can fall safely".
- 3-star line (if the bot confirms it): the marble at the right column's base course from +x. Estimated leverage is about x48 with the marble (≈255 kJ released ÷ 5.3 kJ) versus about x7 with the cannonball. The level teaches that clever beats strong.

**L3 "Shear Line"** (W2-2, Ice and X-ray introduced, 172 bodies)
- A 3×3×16 tower. Course 4 is Ice (9 cubes), course 15 is 9 Crowns, the rest is plaster.
- Seven heritage pillars (1×1×4) stand on a radius-4 ring at 45° spacing. The east position is empty: that is the gap.
- Lot 12×12, centred. Crown line 3 h. Rack: 1 marble, 2 cannonballs. Par 1.
- Red herrings:
  - Hitting the crowns scatters them onto the pillars.
  - Hitting the ice course squirts it out, the upper block drops 1 h, and the crowns stay up.
- Par line (B3): a cannonball from the west at course 12–13. The upper 11 courses slide east on the ice layer as a unit, topple through the gap, and land the crowns outside the lot.
- The X-ray shows the ice course as the only low-friction band. Its first appearance is gated here.

**L4 "Seesaw"** (W3-2, lever, iron, drop and cue introduced, 42 bodies)
- A plaster slab 12 × 0.25 × 3 h (1,125 kg), with its top at 4.25 h.
- A 1(x)×3(z)×4 plaster pier sits under it at 4 h from the left end. A 1×1×4 plaster prop sits under the left end.
- Left end: 2×2×1 Iron (4 × 975 kg). The prop carries ≈ 650 kg, which passes the mass-ratio rule.
- Right end: 3×3×1 Crowns.
- Two heritage pillars (1×1×6) flank the crown end at z = ±3.
- Lot x ∈ [−2,14], z ∈ [−5,5]. Crown line 2 h. Rack: 1 cue, 1 drop, 2 marbles. Par 2. Ace 1.
- Red herring: a cannonball at the crowns breaks heritage.
- Par line: the cue pushes out the prop's top cube, the iron end drops, and the crown end lifts and sheds most crowns (B6). A marble mops up.
- Ace candidate: the drop onto the iron end, which adds momentum so the slab throws all 9 crowns clear of the lot.

**L5 "Six Storeys"** (W5-1, implosion, 1,218 bodies)
- Footprint 12×12 h (6×6 m). Each storey is:
  - 16 steel rods (half-extents 0.06 × 0.75 × 0.06 m, 168 kg each, 3 h tall) on a 4×4 grid inset 1 h from the edge;
  - 9 plaster floor slabs (4 × 0.25 × 4 h, 500 kg each);
  - a 1-cube-thick, 3-course perimeter infill wall (132 cubes; the ground floor has a 4-cell lobby gap on the south face, so 120);
  - 12 ballast cubes.
- Two heritage towers (3×3×12) stand outside the lot east and west, at x ∈ ±[9,12].
- Objectives: Skyline < 4 h, Footprint ≤ 4% outside the lot (footprint grown by 2 h), heritage intact.
- Rack: 3 marbles, 2 cannonballs, 2 cues. Par 3.
- Red herring: cannonballing the facade pushes the building outward onto the heritage.
- Par line:
  1. Thread a marble through the lobby gap into an interior ground-floor rod. The core floors drop first.
  2. A cue pulls the west corner rod so the shell sags inward.
  3. A marble takes the last standing corner.
- Cascade 4–8 s. This is the prototype's spectacle check (rods and slabs flutter like the reference clip).

**Prototype twist levels** (authored after the mechanics probe, about 300–2,200 bodies): L1b "Twin Stacks" (two towers, one shot, domino), L2b "Long Lintel" (three columns, the middle one is the trap), L5b "Eight Storeys" (2,300 bodies, the A/B partner for L5 on whether bigger is better).

**Scale-up designs** (GPU tier):
- 10k **"Domino Boulevard":** 36 slender towers up to 60 courses in a spiral, crowns only on the last tower, par 1.
- 30k **"Sluice":** grafted from SPILLWAY. A silo of crowns behind a slab gate inside a building; rubble flows as a granular medium and you must jam or unjam it.
- 100k **"Arcology":** 12 load-bearing cores, Skyline < 10% of start, par 4.

## 7. Scoring
All rules are evaluated on step indices and never on frames, using reductions over Snapshot plus sparse reads of at most 64 watched bodies.

**Definitions**
- S = structure bodies (all except ammo).
- Level baseline B0 is the pose at step 0. Shot baseline Bk is the pose at shot k's spawn step.
- PE = Σ_{i∈S} m_i g y_i, accumulated as an integer number of millijoules, rounded per body, so the GPU can match it with fixed-point atomics.

**Measures**
- **Leverage.** ΔPE_k = PE(Bk) − PE(settle_k). KE_k = ½ m v² from the spawn event (drop: m g y_spawn).
  - L_k = max(0, ΔPE_k) / KE_k. L_total = max(0, Σ ΔPE) / Σ KE.
  - Tiers (provisional, re-fit from bot distributions so par lines land in Clean or Elegant): Brute < 5, Clean 5–15, Elegant 15–40, Keystone ≥ 40.
- **Crown down:** y < crownLine, or xz outside the lot. Sticky once true at a settle; also detected live for feedback.
- **Combo** C_k = crowns that went down during shot k.
- **Heritage broken:** |p − p_B0| > 0.3 h, or angle(q, q_B0) > 15°, at any settle. Sticky.
- **Displaced:** |p − p_Bk| > 0.5 h. This drives the ink colouring and the Surgeon tag.
- **Skyline:** a 64-bin histogram of each settled structure body's world-AABB top over [0, H_level]. H is the top of the highest bin holding ≥ 3 bodies.
- **Footprint:** N_out / N_S, where N_out counts structure bodies whose xz is outside the lot grown by 0.5 h.

**Settle.** Shot k is settled at the first step t ≥ spawn + 20 such that, for 30 consecutive steps, max |v| < 0.05 m/s and max |ω| < 0.2 rad/s over awake bodies, or N_awake = 0. Ammo outside the lot grown by 4 h is ignored, because rolling spheres never stop. Hard cap: 600 steps.

**Level score** (shown as a tally; each line slams in with a rising semitone)
```
Strokes   1000 × max(0, p + 3 − s)
Leverage  floor(300 × log2(1 + L_total))
Combo     50 × T(min(C_max, 12)),   T(n) = n(n+1)/2
Ace       +2000 if s = 1 and par ≥ 2
Heritage  −500 × H_broken
Footprint −20 × max(0, N_out − allowance)        (footprint levels only)
```
- Example: L2 cleared in 1 stroke with the marble (p = 1, L = 48, C = 6, no heritage broken) scores 3000 + 1,688 + 1,050 = 5,738.
- A level that is not cleared shows the partial tally greyed out.

**Stars**
- ★1 = objective cleared.
- ★2 = s ≤ p.
- ★3 = s ≤ p, no heritage broken, and L_total ≥ L_gold.
- L_gold is set by the bot (Rubble Garden graft): the 25th percentile of L_total over 50 ±1-quantum perturbations of the best-leverage par solution. A good player earns it reliably; it does not need a knife-edge shot.

**Golf stamp:** s − p of −2 EAGLE, −1 BIRDIE, 0 PAR, +1 BOGEY, +2 DOUBLE.

**Shot tags** (all cheap to detect): Featherweight (only marbles and cues used), Surgeon (cleared with displaced fraction < 10%), Long Fuse (still moving 6 s after the shot), Bank (the ammo's vertical velocity flipped sign before the first structure contact).

## 8. Progression
| World | Theme | Teaches | New ammo / tools |
|---|---|---|---|
| W1 | Plaster | Low vs high hits, columns, lintels | Marble, cannonball |
| W2 | Materials | Ice, stone, rubber | X-ray |
| W3 | Levers | Counterweights, levers | Cue, drop |
| W4 | Charges | Vermilion Charge cubes: speed > 1.5 m/s or displacement > 0.5 h triggers a step-recorded shrapnel spawn of 24 spheres; order is the puzzle | — |
| W5 | Implosions | Skyline and footprint, 5k–10k cubes | Quickdraw (fire while the collapse is still moving) |
| W6 | Mortar | Bonded towers, arches, cantilevers (needs the bond feature) | — |
| Finale | Megastructures | 50k–100k cubes | — |

- Star gates: 60% of a world's stars open the next world.
- Aces unlock cosmetic palettes, including the pastel "Topple" skin from the reference clips.
- Assist ladder (post-prototype): after 3 fails the X-ray pulses the hottest 5% of cubes; after 6 fails a ghost of the bot's par arc appears. Using it caps the level at ★2.

## 9. Juice spec
Juice is render-side or keyed to steps, so it never changes the simulation.
- **Pacing scheduler.** One mechanism chooses steps-per-frame, from 0 to N. Hit-stop, slow-mo, the skip-settle fast-forward and the performance valve all go through it.
- **Hit-stop.** Triggers on the ammo's first contact: |v_t| < 0.7 |v_{t−1}| after gravity correction, read from the watched ammo body. The world holds for 3 frames (marble or cue) or 5 frames (cannonball or drop). One hit-stop per shot.
- **Slow-mo.** Triggers when the first crown's vy < −1.5 m/s. The time scale ramps to 0.3 over 120 ms, holds until that crown crosses the crown line (max 1.5 s), then ramps back over 300 ms. At most twice per shot.
- **Awake-adaptive valve** (Rubble Garden graft). timeScale = min(curve, clamp(budgetMs / stepMsEMA, 0.25, 1)). On Rapier budgetMs is 15 ms per frame. Overload shows up as bullet time instead of stutter.
- **Camera.**
  - Follow mode: a critically damped spring (ω = 4 rad/s) follows the ammo, then frames the awake-body AABB (a reduction every 4 steps) with 20% padding.
  - FOV punches −3° on impact and recovers over 250 ms.
  - Grabbing orbit always takes over. At settle the camera eases back to the pre-shot view over 0.8 s.
- **Shake (trauma).**
  - trauma += 0.006 · sqrt(ΔPE_frame / 613 J), where 613 J is one cube dropping 1 h. Capped at 0.45, decays at 1.5/s.
  - Offset 0.06 m · trauma², roll 0.5° · trauma², 18 Hz Perlin noise.
  - Off during slow-mo. Accessibility slider from 0 to 1.
- **Leverage counter.** A big "x12.4" at bottom centre, updated every 4 steps and eased.
  - Each tier crossing changes its colour (Brute grey, Clean white, Elegant gilt, Keystone white-hot with bloom) and plays a rising chime.
  - The numeral scales 1.15× for 120 ms on each crossing.
- **Crown down.** 40 gold sparks plus a bell. Successive crowns climb C D E G A, then the next octave, so a perfect cascade plays an arpeggio.
- **Heritage crack.** A dull porcelain tick and a 200 ms red rim pulse. Deliberately un-fun.
- **Collapse audio** (no contact events). Each step a reduction counts bodies with a velocity drop over one step of more than 0.8 m/s, binned by material (6) × home-height band (8).
  - Material sets the timbre: plaster is a dry clack, stone a low knock, iron a clank, ice a glassy tick.
  - Band sets the pentatonic pitch, so a falling tower plays a descending scale.
  - 32-voice pool, 0–12 ms onset jitter, ±15 cents detune, gain 0.12 · log2(1 + n). Panned by the x position of each band's awake centroid.
  - Above 400 impacts per frame, crossfades to a granular cloud shaped by the histogram. A short room reverb (RT60 1.6 s) and a master compressor sit on the bus.
- **Wake glow.** A body that goes from asleep to awake flashes warm white at emissive 0.35, decaying with τ = 0.3 s. The activation front becomes visible, which shows off the tier system.
- **Shot ink** (replaces CHAINFALL's chain hue). At each settle, bodies displaced during shot k lerp over 400 ms to ink k at about 35% saturation: umber, slate, olive, plum, teal, rust. The rubble becomes a readable record of which shot did what.
- **Settle bowl.** A singing bowl at the settle step (partials 1, 2.71 and 5.15 of the root, 4 s decay), then the result chip.
- **Regrow** (retry). Displaced cubes fly back to their home poses over 600 ms, staggered by home height, with an ascending click arpeggio. Engine re-init runs underneath. Input is accepted at once, and firing cancels the animation.
- **Result.** The tally slams in at 140 ms per line with a 1.0 → 1.2 → 1.0 punch. The paper stamp rotates −8° and scales 1.4 → 1.0 over 180 ms with a thud, then stars fill at 250 ms each. The auto-replay uses the cinematic camera.
- **Replay heatmap** (LOAD PATH graft). H toggles it: each cube is coloured by |p − p_B0|, deep blue at 0 through cyan at 0.5 h and yellow at 2 h to red at 6 h and beyond. The original silhouette is drawn as a ghost wireframe.

## 10. Visual direction
**"Architect's maquette at dusk."**
- Matte plaster-white cubes with a 1.5% bevel and strong seam AO.
- A low warm key light (3200 K, 25° elevation) throws long shadows that show stacking and overhangs, with a cool sky fill and a thin rim light.
- The setting is a dark walnut table. The lot is a pale board printed with a faint blueprint grid, the lot edge is a dashed cyan line, and the crown line is a hairline glowing ring on a translucent cylinder.
- Colour means something, with at most 4 accent hues on screen: gilt Crowns (slight bloom), celadon Heritage, vermilion Charges (later), polished steel ammo.
- Ink washes are desaturated, so they never compete with the accents.
- The X-ray desaturates everything to graphite, with an amber load ramp and load threads.
- At 10k–100k, structures are colour-blocked into named modules (core, shell, terrace) in off-white tones, so a 100k building reads as about 20 parts.
- The pastel rainbow "Topple" skin from the reference clips is a cosmetic unlock.

## 11. Scale story (500 → 100k)
The rule: **shot count stays constant and consequence scales.**
- **500, chamber puzzles.** Every cube is visible and matters. One column, one lintel, one lever. Cascades last 1–3 s.
- **2,500 (prototype ceiling), composite structures.** 2–4 subsystems; footprint starts to matter because rubble has volume.
- **10k, search and chains.** 1–3 keystones hide among about 300 load-bearing elements, so the X-ray and plan view become essential. Cascades run 4–8 s with real Quickdraw windows. Rubble behaves as a granular medium: heaps act as ramps, props and jams (the "Sluice" levels).
- **100k, megastructures.**
  - One stroke can start a 20–30 s, multi-stage collapse. Leverage reaches x1,000 and above, which is the payoff for keystone thinking.
  - Buildings slump and flow, so footprint control (core first or shell first) becomes an engineering puzzle.
- **Cost model.** Intact lattice is nearly free. A wrong shot on a 100k level wakes only about 5k bodies, and only correct solutions pay for the full spectacle.
- **Constraints for 100k levels.** At least 90% of bodies must be lattice cubes; slabs and rods start as sleeping active bodies. Each level is re-verified by the bot on the shipping engine.
- **Engine asks, in order** (none needed for the prototype):
  1. `reduce()` / `readBodies()`, mirroring `@tb/keystone`'s CPU reductions, with fixed-point integer atomics.
  2. A static body flag (plinths, anchors).
  3. A deterministic GPU mode (fixed-order accumulation) for ghosts and leaderboards.
  4. Optionally, a `blast` event for Charges. Spawned shrapnel works until then.

## 12. Risks and what playtests must answer
| # | Risk | Response |
|---|---|---|
| 1 | **Loose stacks may not produce distinct, repeatable behaviours** (the B1–B6 claims). This is the kill risk. | The mechanics probe runs first. If fewer than 3 of the 6 behaviours have a basin of at least ±0.5° yaw × ±3% power, pivot objectives to tolerance bands cast from real outcomes (Rubble Garden style) and keep the rest of the design. |
| 2 | **Chaos vs puzzle.** | Bot basin gate plus chaos audit: ≥ 80% success over 50 perturbations. Plus a fairness survey. |
| 3 | **First minute too cerebral.** | L1 is pre-aimed and the X-ray is gated to L3. Measure time to first collapse. |
| 4 | **Settle dead time.** | 30-step settle window, Space for 4x, and ignoring ammo that rolls away. |
| 5 | **Content cost.** | Every level is bot-verified, which makes an editor and a generated daily puzzle viable later. |
| 6 | **Rapier to AVBD drift and cross-GPU nondeterminism.** | Levels and replays are pinned to an engine build. Re-verify on switch. |
| 7 | **Tunnelling and mass ratio.** | Validator rules, with tests. |
| 8 | **Leverage gaming** (bodies that start unstable). | The at-rest test makes such levels invalid. |

**Playtest questions** (8–12 testers, telemetry stored as replays):
- **(a) Aha rate:** share of players reaching par within 5 attempts. Target 40–70% per level.
- **(b) Ace discovery:** target 5–20%.
- **(c) Reading time** (orbit or X-ray seconds before each shot): should rise from L1 to L3. If it stays flat near 0, players are gambling.
- **(d) Retry pull:** median time from result to next shot under 4 s; voluntary retries after a clear above 30%.
- **(e) Fairness:** "outcome matched what I intended", rated 1–5. Mean ≥ 3.5, correlated against basin width.
- **(f) Does leverage change behaviour?** Share of retries that switch to lower-energy ammo.
- **(g) Spectacle:** L5 vs L1/L2 rating, and L5 vs L5b ("is bigger better?").
- **(h) Time to first collapse:** under 20 s.

**Go/no-go:** 6 of 8 levels hit (a), (d) and the chaos audit, and the mean fairness is ≥ 3.5.

## Why Keystone

Build KEYSTONE as the game, with the strongest feedback pieces taken from the other concepts. It is the only concept where one ball against one 400-cube structure is already a complete, fun decision: you read the structure, fire one shot with a purpose, see a cascade, get a legible verdict, and retry instantly. It also has the most rigorous answer to the biggest risk in the project, chaotic rigid-body stacks. A solvability bot measures how wide each level's solution basin is, a chaos audit perturbs the par shot, and CI fails a level whose solution is a lottery. Prototyping it needs no change to @tb/engine-api, because every verb is a spawn event and every rule is a pure reduction over Snapshot, which ports to GPU reductions later.

Its two weaknesses are restrained spectacle and a cerebral first minute. I fix both with grafts:
- **From Rubble Garden:** wake glow on activation, slow-mo that adapts to how many bodies are awake, collapse audio pitched by height band, a settle bowl, Regrow as the retry animation, and star thresholds cast from perturbed real outcomes.
- **From CHAINFALL:** each shot's displaced cubes are tinted in that shot's colour ("shot ink"), and crown-down notes climb a pentatonic arpeggio.
- **From BREAKLINE:** the slammed tally on the result card.
- **From LOAD PATH:** a forensic displacement heatmap in replays, and the zero-activation at-rest test.
- **For the first minute:** level 1 is a pre-aimed smash, and the X-ray is held back until level 3.

Scale changes what one shot means, never how many shots you take: par stays at 1 to 4 while 100k-cube structures turn a correct shot into a 25-second, multi-stage collapse, and a wrong shot wakes only a few thousand bodies.

## Alternatives and grafts

**Rubble Garden** had the highest aggregate score (7.8). It loses as the main direction because the fun judge scored it 5.5: no failure, no tension and unlimited balls are a poor match for "really fun and engaging", and its retention depends on features we won't have soon (album, seasons, Prophecy, builder). I took most of its spectacle and determinism craft: wake glow, the awake-adaptive slow-mo valve, height-band pentatonic collapse audio with material timbres and a granular crossfade at high counts, the settle bowl, Regrow as the retry animation, and star thresholds cast from perturbed real outcomes (L_gold = P25 of 50 jittered par solutions). It is also the fallback. If the mechanics probe or the chaos audit shows that loose stacks cannot support par puzzles (fewer than 3 of B1–B6 robust, or fairness below 3), objectives become tolerance bands cast from real outcomes. That moves the game toward a Garden-like "paint or carve" goal while keeping the KEYSTONE shell, tools and bot.

**CHAINFALL:** I took the per-shot ink (its chain-hue repaint, recast as authorship per shot so players can learn from it) and the crown-down pentatonic arpeggio. I rejected the rail camera and the high shot rate: they fight settle times and structure reading, and blow the Rapier awake budget. Its fuse-delay governor is a good idea for W4 Charges at GPU scale.

**BREAKLINE:** I took the slammed tally with a rising semitone per line on the result card. I rejected Chips×Mult and the run economy for now. If playtests show high aha rates but low long-term pull (content starvation), a BREAKLINE-style run mode is the second mode to build: shuffled KEYSTONE levels as floors, the rack as the pouch, leverage as the multiplier source.

**LOAD PATH:** I took the forensic |p − p0| heatmap with a ghost silhouette for replays, load-path threads for the X-ray, the zero-activation at-rest validity test, and rubble persisting between shots. Its Stress Test bot is the same machine as the solvability bot and later powers a level editor. Async raiding is deferred until there is a backend and a deterministic GPU mode.

**SPILLWAY:** not testable at 2,500 cubes. I kept it as a late GPU world, "Sluice", where rubble behaving as a granular medium jams or releases crowns. I also took its follow-the-front camera idea (velocity-weighted centroid) and flow-bucket audio for the 30k–100k levels.

**What would change the recommendation:**
- **(1)** The mechanics probe fails: pivot to the outcome-cast tolerance goals described above.
- **(2)** Fairness is fine but aha rates are above 85% or reading time stays flat: puzzles are too shallow at prototype scale. Lean on multi-shot levels and bring Charges forward.
- **(3)** Testers rate L5/L5b and the baked 10k preview far above the chamber puzzles, and play the chamber levels only to reach the spectacle: shift weight toward a CHAINFALL or Garden spectacle mode on the same rules.
- **(4)** The engine cannot reach same-build determinism on GPU: shared ghosts and leaderboards fall back to keyframed replays, and par levels are verified per engine build. The core puzzle survives either way.