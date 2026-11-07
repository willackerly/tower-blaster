# Wavefront (M6)

Towers falling into towers, and dominoes falling into dominoes. One push, then a long, ticking watch while the wave runs. The roadmap entry is `docs/game/modes-roadmap.md` M6. The probes it rests on are X1 (domino runs and sleep) and X3 (towers as dominoes) in `docs/game/mode-probes.md`.

There are three verbs:

- **Lay:** draw a domino run from the push to the target with the brush (C9), on a budget.
- **Steer:** the skyline is the layout. Pick the street to push, or build a relay so the wave crosses an avenue.
- **Cut:** a wave is already running. Take pieces out live to save what is left.

Status (2026-11-07):

- **Shipped:** the run window and bodies that start asleep (C22), the wave meter (`wavePlay`), Steer's two levels W3 Fall Line and W4 Avenue, Cut (`LevelDef.cut`) and its level W5 Firebreak, and the Wavefront series on the door.
- **Not yet built:** Lay (W1 and W2, on Rube Lab's parts par from #268), a 10k Steer city (held until X9 lands on Metal), and the wave-map overlay.

## C22: the run window, and bodies that start asleep

A domino wave runs about 5 dominoes a second (X1: 0.90 to 0.96 √(gh)). A wave over a 10k field therefore runs for minutes, and every settle rule ends it far too soon:

- v1 ends it at its 10 s cap.
- v2 and v3 count the front as "stragglers" under their allowance and call the world quiet while it is still falling.
- v4 calls a slow, steady creep of D "steady" and settles.

`packages/keystone/test/run-window.test.ts` shows each of these on a synthetic X1-shaped wave. `packages/keystone-lab/test/run-window-ref.test.ts` shows them on a real 76-domino line on the reference engine: v4 settled at 1.1 s and v1 at 10.0 s, both with the crown standing. With a 60 s window the line settled at 33.7 s with the crown down.

**What shipped:**

- **`LevelDef.runWindow`** is a per-level settle cap in seconds, over 30 and at most 600 (`RUN_WINDOW_MAX`).
- **Waiting for the front.** Under a window, every settle rule also waits for the front to die. It allows no stragglers (`quietUnder(..., wave)`), and v4's steady run counts only while nothing is fast.
- **`physics.asleep`** starts every structure body asleep. It needs `physics.sleep`, it is in the level hash, and off hashes as absent.
- **`BodyDesc.asleep`** carries this to the engines:
  - GPU: the body starts with its sleep counters full and wakes only when something reaches it.
  - Reference engine: no sleep, so the hint is ignored.
  - Rapier: runs these bodies awake. A body created asleep has no contacts yet and sank 5 cm into the ground (measured), so the hint is dropped and the tests pin the awake branch.

**Alternatives considered:**

- **A second settle rule for waves (rejected by the brief).** Every rule needs the same two changes, a longer cap and waiting for the front. A window parameter applies them to all four rules, so stars cast under v1 to v4 keep meaning the same thing.
- **Fixed-time settles (rejected).** A wave's length depends on the player's line. The same level runs 3 s on a dead street and 30 s on the live one. A fixed time would either cut the live line short or make every miss wait out the longest line.
- **Raising the global cap (rejected).** That would change the hash of every level that relies on today's cap, and it would make an ordinary rocking tail wait longer on every level.

## What the engines showed for the game's cube towers

A tower here is the game's own: 2 × 2 columns of loose 0.5 m plaster cubes, 8 courses high, on the 1.02 h lattice. X3 found these towers carry a wave every time on Metal. Building levels on them found five things:

1. **Reach.** A falling tower fells the next across a street of up to 6 cells (3 m) and dies at 7. A tower pushed by a ball alone carries only 2 cells, because the ball tips it slowly.
2. **Straight lines.** The wave runs straight along the push. With 2-cell streets, a pushed row falls end to end and the rows beside it stand. The falling row's debris wakes the row beside it (a real contact), but those towers do not fall.
3. **Off-centre hits split the tower.** A cannonball (1 h across, half a tower's face) 0.35 h off the middle of the face fells one of the tower's two columns, and the wave dies a tower or two on. A real player's aim is rarely closer than that.
4. **Crowns and heritage on single cubes are noise at this scale.** A falling row's debris lands in the next row's heritage, and a split tower leaves the crowns on its far column standing. With crowns on a whole row, the clean line gave 14 of 16 crowns, or 16 of 16 with a heritage broken, depending on street width and aim.
5. **The cue is too weak.** Its 1.5 to 5 m/s steel rod knocks single cubes off an 8-course tower and topples nothing.

**The fix: starter slabs, and judging Steer on collapse.**

- **Starter slabs.** Every street ends in a starter slab: one rigid plaster piece as wide and tall as a tower (2.02 × 8 × 0.5 h), standing 1 h off the end tower's face. A ball anywhere on its upper two thirds makes it fall square across both of the tower's columns. Across the full width of the slab, that held in every case on Rapier (24 of 24 in the sweep, and 3 hit points on every street in the tests). A 6 h slab is safe only on its upper third, and the lowest third of any slab shoves its foot instead of tipping it.
- **Collapse D.** Steer is judged on collapse, which reads the whole city's potential energy instead of single cubes. On Rapier, W3's 8-tower street gives D 0.19 to 0.22 from any hit, the 4-tower line 0.12, and the 3-tower line 0.10.

**Relays.** A relay built in a 10-cell avenue has to be rigid too:

- A loose-cube relay tower splits like any tower and carries from some cells and not their neighbours. Pushing north, the 8-course relay carried from 2 and 3 cells off and failed from 4 off (the exact middle). The 6-course relay alternated 7, 4, 7, 7, 4, 7, 4 towers over adjacent cells going south.
- An upright slab 1 h thick carries the wave both ways from a contiguous window 3.5 to 6 h past the near tower, in an avenue 9.7 h wide.
- A 0.5 h slab's window is about half as wide, and an 11-cell avenue does not widen the window.

## Cut: pulls only while the wave runs

The game steps physics only while a shot runs, so nothing moves while the player aims. Without a rule, a Cut level is not a Cut level: the player pulls the firebreak out before pushing, at leisure, and the "live" verb becomes a build step.

**What shipped:** `LevelDef.cut: true` (in the level hash, and a key in the viewer's level files). On such a level a pull goes in only while a shot runs. `Session.canFire('pull')` is false in every other phase, and `pullRefusal` says why ("a Cut level's pulls go in while a wave runs: start it first"). Rapid fire is the way the player gets a second action into a running shot; with rapid fire off, Bullet Time (no freeze limit on these levels) gives the same window.

**Alternatives considered:**

- **Allow the pre-cut (rejected).** It turns the verb into "remove the relay, then push", which is a puzzle about reading the layout, not about timing. Steer already covers that.
- **Charges armed before the shot (rejected for now).** C5's cutter charge, armed in aim and fired by a timeline, would let the player plan the cut. It is a fine later variant, but it hides the live read of the front that Cut is about.
- **Keep physics running while aiming on Cut levels (rejected).** It changes the game loop for one family and breaks the camera and aim feel the rest of the game relies on.

## The levels

| id | name | verb | the design | what the tests pin |
|---|---|---|---|---|
| W3 | Fall Line | Steer | Three north-south streets 10 cells apart: the west one unbroken (8 towers), the middle and east ones each broken by a 9-cell gap. A starter at each end of each street. Par 1, two cannonballs, collapse at least 0.16. | Rapier: each street from each end fells its towers in order to its first gap (8, 3, 2 or 4), the rest standing, from 3 hit points on the starter. Only the west street clears in one stroke, and a push across an avenue fells one tower. GPU: the west street clears. |
| W4 | Avenue | Steer, build | One street broken by a 10-cell avenue (3 towers, then 4), with a budget of one relay slab (cost 16). Par 1, two cannonballs, collapse at least 0.4. | Rapier: bare, the wave dies at the avenue from either end. A relay built (through `BuildSession`) 3.5, 4, 4.5, 5, 5.5 or 6 h into the avenue carries it the length of the street, both ways. GPU: with a relay, the street clears. |
| W5 | Firebreak | Cut | One street of 8 towers in three blocks (3, 3, 2) joined by two built-in relay slabs, a starter at the south end, and a village (heritage on the top course of towers 7 and 8) at the north end. Cut level, par 2 (push, pull), cannonball and pull, collapse at least 0.33, heritage judged standing. | Rapier: with no pull, all 8 fall (village lost, 2 stars). Pulling the second relay 60 or 300 steps after the push fells 6 and saves the village (3 stars); at 600 steps it is too late (8 fall, 2 stars). Pulling the first relay fells 3 and misses the objective. GPU: pull at 120 steps, 6 fall, the village stands. |

Every Wavefront level plays under `WAVE_RULES`: GPU sleep, the structure asleep from the start, and a 60 s run window.

On W4, two strokes clear the bare level too: each half of the street pushed from its own starter gives 0.27 + 0.34. That costs a star, as par scoring means it to.

### GPU evidence (SwiftShader, 2026-11-07; CI runs the same files)

| run | outcome | D | awake max / mean of bodies | settled |
|---|---|---|---|---|
| W4 bare, north | miss, 3 towers | 0.271 | 129 / 64 of 226 | 5.9 s |
| W4 relay, north | clear, 7 towers | 0.569 | 227 / 124 of 227 | 9.1 s |
| W3 west street, north | clear, 8 towers | 0.186 | 258 / 149 of 646 | 8.8 s |
| W5 push, pull relay 2 at 120 steps | clear, 6 towers, village standing | 0.430 | 218 max of 259 (mean not logged) | |

The awake count is probe X1's meter (every 5 steps, from the first shot). With the city asleep from the start, the front stays on the street the wave runs down. Metal casts and timings go through the coordinator's Mac queue (`TB_CHANNEL=chrome` on these files). SwiftShader seconds are never performance numbers.

## Alternatives considered

- **Follow camera on by default (rejected by the camera rule).** Will's rule (2026-11-02, #169) is that the camera moves only on player input. `keystone.follow` stays opt-in, and the wave map (still to come) is a picture, not camera motion.
- **Kapla dominoes (rejected by X3).** Kapla cribs damp the front, which dies after 2 or 3 cribs in all 32 Metal nudges. Wavefront's towers are the game's own loose cube towers, which X3 found carry a wave every time.
- **Fixed-time settles (rejected).** See C22 above: the run window plus waiting for the front replaces them.
- **Crowns on the towers (rejected for Steer, measured).** See point 4 above. Crowns and heritage stay for small Lay levels, where a crown is one domino or block that a run either reaches or does not.
- **Aim assist that snaps a push to the face's middle (rejected).** It would hide the physics, and it is a new rule for one family. The starter slab gives the same robustness in the physics itself, and the player still aims freely.
- **The cue as Steer's push (rejected, measured).** See point 5 above.
- **A relay tower of cubes (rejected, measured).** See the relays above: a coin flip from cell to cell. The relay slab is one rigid piece.
- **Bonded piers as firebreaks.** X3 measured them as an all-or-nothing gate, holding about 60% of the time. They are left for a Cut or Steer level that wants a coin-flip hazard, and are not used as a reliable wall.

## Tests

| file | engine | what |
|---|---|---|
| `packages/keystone/test/run-window.test.ts` | none | The run window on every settle rule against synthetic X1 waves, and `physics.asleep` in the hash. |
| `packages/keystone-lab/test/run-window-ref.test.ts` | reference | A 76-domino line runs to its end inside a 60 s window. Without it, v4 and v1 settle early. |
| `packages/physics-ref/test/asleep.test.ts`, `packages/adapter-rapier/test/asleep.test.ts`, `packages/physics-gpu/test/engine-asleep.test.ts` | each | Bodies that start asleep stay asleep until reached (GPU), or run awake bit-identical to unflagged (reference, Rapier). |
| `packages/keystone-lab/test/wave-levels.test.ts` | Rapier | W3 and W4 as designed (above). |
| `packages/keystone/test/cut.test.ts` | none | A Cut level refuses a pull while aiming, the same level without `cut` accepts it, and `cut` is in the hash. |
| `packages/keystone-lab/test/wave-gpu-W3.test.ts`, `wave-gpu-W4.test.ts`, `wave-gpu-W5.test.ts` | GPU | The clean line of each level on the game's engine, the awake count logged and bounded. |
