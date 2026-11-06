# Effects that follow the damage (PT2, PT19)

Rows PT2 and PT19 of the first agent playtest (`docs/game/agent-playtest-1.md`). Three Opus judges saw a
marble that moved nothing set off a full burst of sparks, white "hairballs" over a third of the frame,
white slabs long after a hit, sparks and pale blocks still there after Retry, and rams drawn as bombs
that then lay on the plain like duds.

## What caused it (measured, not guessed)

| Symptom | Cause |
|---|---|
| A dud sparks in full | Two sources at the **ball's own** speed change, which says how hard it hit, not what it moved: the detector (`sparks.ts detect`) treats a ball like any block, and the game added a burst of the same strength at first contact (`play.ts`, `contact` feedback). On Rapier the playtest's L2 dud makes about 560 detector sparks plus about 130 from the burst. |
| Hairballs in big collapses | Nothing bounds the live sparks but the 64k pool: up to `SPAWN_BUDGET` (8192) a frame, every frame of a collapse. |
| White slabs | The heat glow turns the whole face white at heat > 0.8 (`heatGlow`), and **a ball at rest** against a block keeps it at heat 1 for as long as it lies there (`ballContact`). Cracked heritage flashed at emissive 1 (16x its albedo), and an undo or a replayed line restored felled crowns and cracked heritage glowing steadily, unlike play. |
| Leftovers after Retry | Retry, Undo and loads cleared blasts and fuses only: the particle pools, the per-body heat and the flash lights ran on. |
| Rams read as bombs | The game drew every `w-` weapon as a bomb (near-black, lit fuse); `RAM` has no rules and never goes off. |

## What changed

All of it is an option: `keystone.fx=damage|classic` (default damage) and `keystone.spent=0|1` (default
1), in the URL, the viewer's Scene panel (Keystone rules) and saved scene files. `Renderer.setEffectStyle`
holds the renderer's side; `classic` is the rule before PT2 (but for spark bit 12, which only flags the
new rule).

**The spark rule** (`SparkParams`, GPU and CPU twin):
- `ballSparks` (6): a ball's own impact (material ball, every fired shell) throws at most this, as class 0
  (short and dim). The blocks it moves spark from their own speed changes, so the count follows what moved.
  The game no longer adds its contact burst in the damage style.
- `lifeDv` (12 m/s): strength above `dvMin` for full life and brightness; weaker impacts give shorter
  (x0.35 to 1) and dimmer (x0.45 to 1) sparks, in 16 classes kept in the spark's `packed` bits 8 to 12.
- `budget` (2048) and `rate` (4000/s): a token bucket, as debris mode's. At most `budget` sparks a frame;
  a long collapse is held to `rate`, so live sparks stay under about budget + rate x 1.2 s.
- `contactSpeed` (1.5 m/s): a ball heats what it touches only while it moves.
- Lights: a ball's own impact bids for a flash light at `ballFlash` (0.25) of its strength.

**Heat** (`fr.heat` 2): the palette colour glows along the face's edges (30% of the half extent in),
a tenth of it in the middle, and never turns white.

**Roles** (`scene.ts rolePaint`): cracked heritage flashes teal (emissive 0.2) and stays teal; an undo or
a line restores felled crowns and cracked heritage as play leaves them (no steady glow).

**Reset** (`Renderer.resetEffects`): every particle dead, buckets full, queued impacts dropped, every body
cold and unseen (so the restored poses are first sight, not a hit), flash lights out, trails empty, blasts
and fuses gone. The game calls it on every load, retry and undo; the viewer on every scene.
`Renderer.effectStats` reads the counts back (live particles, hot bodies, spawned since the reset, lit
flashes, blasts, fuses), `GameHandle.effects` for tests.

**Rams and spent ammo** (PT19, `scene.ts firedKind`, `ramFx`, `spentFx`): a weapon with no rule that acts
(no blast, split or remove, in it or its children) is a ram, drawn in bronze with a ball's band and no
fuse (the plain ball style keeps the old bomb look). When a shot settles, every painted ball and ram fades
over 0.6 s three quarters of the way to a dull stone grey, matte, band kept; bombs are left alone (a live
one still goes off). Undo checkpoints keep the spent state.

## Alternatives considered

- **What sets a spark's count.** Chosen: the struck bodies' own speed changes, the ball's capped. Rejected:
  scaling a shot's sparks by its collapse (known only at the settle, after the sparks are due); a
  mass-ratio weight on the ball's impact (a heavy ram against a light wall would still spark in full on a
  miss); the solver's contact impulses (the right long-term source, render-interfaces' contact ring; not
  there yet, and the detector's guess is good enough once balls are capped).
- **The cap.** Chosen: a token bucket, shared with debris mode's code. Rejected: a smaller ring (it
  overwrites the youngest sparks of a collapse, which flickers); a per-frame budget alone (does not bound a
  long collapse, which was the hairball).
- **Heat.** Chosen: a rim glow. Rejected: the old glow at lower gain (still a flat slab, and a dim one
  reads as a tint bug); an outline in post (needs edge detection on the ID pass; costly).
- **Spent ammo.** Chosen: a tint fade. Rejected: hiding it (an invisible collider later shots would hit);
  removing it from the world (changes physics, so replays, casts and recorded lines).
- **Ram look.** Chosen: paint and band (the "fired ball, not a bomb" language players already read).
  Rejected: a ram mesh (the shell is a sphere in physics; a different drawn shape would lie about contact).

## Not done here

- **Dust for big collapses in the stylized looks.** The real look's debris mode already raises dust; giving
  the stylized looks both sparks and dust needs a third particle mode (a split pool, the puff draw in the
  candy shading). Left as roadmap row FX14 for after a Metal look at the capped sparks.
- **Particles on sim time.** Sparks age on frame time (FX11 covers the fireball). Bullet Time and slow
  motion keep them flying at wall speed.
- **Cost.** Uniform words only, one extra branch in spawn and flashPick, no new pass: expected within noise.
  Timing numbers from SwiftShader are never results; a Metal capture of B1 and B3 (look and frame cost)
  goes through the bench queue.

## Tests

- `packages/render/test/render-effects.test.ts`: the rule's CPU twins; the bucket on the GPU frame by frame
  against its twin; `Sparks.reset`; `Renderer.resetEffects` with `effectStats`; a ball's flash share; the
  rim glow never white (classic washes 93% of a hit cube's pixels white).
- `packages/render/test/render.test.ts`: the detector, flood and heat tests under both rules.
- `packages/game/test/effects-damage.test.ts`: the emitter fed a real Rapier shot's impacts on L1: a marble
  that moves nothing spawns 6 sparks, the par cannonball 4,369, a grenade 11,723 (classic: 19, 4,450,
  17,574); fired-body kinds, spent paint, role paint, feel keys.
- `packages/game/test/effects-e2e.test.ts`: on the game page, every effect count is 0 after Retry, Undo
  and a level load; a fired ram is a ram, spent once settled (or kept live with `keystone.spent=0`), and
  an undo restores it as it was.

## Look review (SwiftShader frames, 2026-11-06)

An Opus reviewer was given classic vs damage frames of four shots (the playtest's L2 dud, L1's par
cannonball and a Retry, a ram and then a bomb on T-X4; sheets in project files `fx-damage/`) and no
conclusions. Verdict: damage is better on all four; the dud's burst is now about the size of what moved,
the breach and the topple stay readable, and spent ammo reads as spent; Retry leaves nothing behind in
either style. Its points for the damage style, and what became of them:

1. An orange ellipse and a dotted line over T-X4's breach in every frame: most likely the aim preview,
   which rapid fire keeps up while a shot flies. Not an effect; not checked further here.
2. Embers linger over the rubble after the settle. Sparks age on wall time, and SwiftShader frames are
   slow, so these frames overstate it; the Metal capture of B1 and B3 decides (if it holds there: fade
   sparks by time since the settle).
3. White cores in the first frames of a big hit (bomb step 20, dud step 30). Same Metal check; the next
   lever is a warmer, capped spark core.
4. The ram is drawn as a sphere: deliberate (its physics shell is a sphere; see Alternatives).
5. Spark count by energy dissipated rather than speed change: the solver's contact impulses
   (render-interfaces' contact ring) are the long-term source, as above.
