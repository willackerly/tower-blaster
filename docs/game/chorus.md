# Chorus: one shot into 64 worlds (M9)

Roadmap node M9 (`docs/game/modes-roadmap.md`, "M9 Chorus"). The player fires one shot, and the game fires
it into 64 copies of a small level at once, each a hair different. The score is how many of the 64 clear.
A shot that clears only when everything goes its way clears a few worlds; a robust shot clears nearly all
of them. So Chorus turns the solver's chaos into the puzzle, and it teaches the player what the casting
bot's robustness gate measures.

Code: `packages/keystone/src/chorus.ts` (the worlds, the engine facade, the judge and the score), the
Driver's two seams in `driver.ts`, the levels in `chorus-levels.ts`, and the game's panel in
`packages/game/src/chorus-view.ts`. It is built on the C10 islands (`docs/design/islands.md`), so read
that note's f32 and threshold findings first.

## How a round plays

1. A level with a `chorus` block (`LevelDef.chorus`: worlds, jitter, seed, star thresholds, crowns needed)
   loads as usual. The game's `makeEngine` wraps the GPU or Rapier engine in a `ChorusEngine`, which sizes
   the inner engine for K worlds and initialises it with the islands scene: K worlds, world 0 at the
   origin and the rest on square rings around it.
2. World 0 is the level exactly as a solo play of it, and it is the only world the game frames and draws.
   The camera, the HUD, the marks, the sound and the effects see one ordinary level. Nothing about the
   camera changes: it moves only on player input.
3. The shot goes into every world. `push` fans each input out to all K islands, in each island's own ids
   and coordinates, and nudges every world k >= 1's spawn by that world's aim jitter.
4. The round waits for every world. The Driver's settle hold becomes `arm(out) || chorusHold()`, where
   the Chorus hold is true while any world is still moving (settle-v1 quiet: at most `settleAllowance`
   moving bodies for `SETTLE_QUIET` steps, across all worlds). It never ends a round sooner than world 0
   alone would; it only waits, and it is bounded by the settle rule's cap.
5. The judge counts every world at once in the observer's arithmetic (below), and the Driver replaces the
   levelEnd score with the Chorus score (`rescore`, also on Bank).
6. The panel (bottom right) shows the other worlds as an 8 x 8 grid of live side-view thumbnails or a heat
   strip, and the count "21 of 64 clear".

## The worlds and the jitter

World k >= 1 differs from world 0 in two ways, each drawn from a seeded mulberry32 stream keyed on
(level seed, k, what), so every play of a level meets the same 64 worlds on every machine:

| jitter | default | what it moves |
|---|---|---|
| `pos` | 0.004 h | each structure body on x and z (uniform). On a 0.5 m cube that is 2 mm: a fifth of the 0.02 h lattice gap, so two neighbours jittered towards each other still leave 0.012 h. Refused above 0.009 h. |
| `yaw` | 0.2 degrees | each structure body about y, capped so no corner moves more than `pos` (slabs and rods turn less) |
| `aim` | 0.6 degrees | the shot's yaw |
| `pitch` | 0.1 degrees | the shot's pitch |
| `power` | 3 % | the shot's speed |

Pinned bodies (M10's `pinned` parts) are never jittered: a pinned ramp or backstop is the same in every
world. The stream draws for every body, pinned or not, so one body's jitter never depends on another's
being pinned.

**Why the shot's jitter is the bot's hand noise.** The first version jittered the shot by a hair too
(0.1 degrees, 1 %). That split Rapier's worlds, but not the GPU solver's: on SwiftShader, every one of 16
worlds ended the same way on each of three shots tried (L1 course 4 twice, 0/16 with exactly 2 crowns down
in all 16; L5's marble, 16/16). The GPU AVBD solver is far less chaotic than Rapier, so a hair of
difference stays a hair. The shot's jitter is now the noise the casting bot's robustness gate already
plays (`keystone-lab` `cast.ts` `nudgeLine`: yaw within 0.6 degrees, power within 3 %; the bot nudges no
pitch, so pitch stays a hair). With it the same L1 shot split the GPU's worlds 6 of 16 (crowns down
2, 3 and 4 in 10, 2 and 4 worlds), and Rapier's 42 of 64. It also makes the mode mean what the roadmap
says it means: a shot that clears most worlds here is the shot the gate calls robust there.

The structure keeps a hair of jitter (`pos`, `yaw`): it is what makes the worlds different worlds rather
than one world with a shaky hand, and on Rapier it alone splits a collapse.

## Reading the worlds

Every world's outcome comes from the observer's arithmetic (`reduceRef` with the islands' tags), never
from f64 positions compared against a threshold. The C10 note's finding is that a cube which drops exactly
one layer sits on the "down" threshold, and f32 on the GPU against f64 on the reference splits there.

- Tag word 0 holds each body's island; word 1 says what it is (structure, crown).
- Ref slot 0 holds every body's pose at the shot (what "moved" is measured from); ref slot 1 holds each
  body's island offset, so `{ disp: 1 }` is a body's position in its own world's coordinates.
- A crown is down when it is below the crown line or outside the lot, as `rules.ts` `crownDown` says
  (fixed point s = 16). A structure body has moved when it has moved more than `DISPLACED` h since the
  shot (s = 15).
- Heritage is judged in f64 by `rules.heritageBroken` on each world's local snapshot against its pose at
  the shot. That rule has its own margins and is not a resting-height threshold.
- A world clears when it has at least `need` crowns down (default: every crown) and no heritage broken.

**The fence.** C10 deferred a fence that removes escaped bodies "until a consumer needs one". Chorus
needs one: on Rapier a ball that misses rolls on across the ground plane for ever and eventually reaches a
neighbouring island. `ChorusEngine` removes any body past `half - 4` m from its island's centre (a remove
event, due at the next step), counts it, and the judge reports `leaks` (bodies outside their cell at the
last read). Every test requires 0 leaks. A fenced body is far outside the lot, so it never changes a clear.

## The score (agreed with the scores thread)

Agreed with the thread that owns the score module ("Make scores and leverage add up", PT9/PT16), whose
five changes are all in:

- One line: "Worlds cleared (c of K)", worth `floor(3000 c / K)` (`CHORUS_WEIGHTS`). 0 of 64 scores 0.
- Stars from fixed thresholds on the count: 32, 48 and 60 of 64 (`CHORUS_STAR_FRACTIONS` 1/2, 3/4, 15/16
  of K, rounded up), overridable per level (`chorus.stars`, in the level hash, so retuning starts a new
  progress record). There is no cast: the count is already a distribution.
- Stamp "c/K CLEAR". No gold badge and no leverage tier on the card (a tier is a single world's story);
  the hero world's leverage is kept in the score for the HUD.
- A generic `LevelScore.worlds = { cleared, of, thresholds }`, which a later many-worlds mode (Mason's
  Trial) can share. The card's sub line reads "c of K worlds cleared".
- Heritage is part of the clear test, so it needs no line of its own.

A duel never takes the Chorus path: no duel side has a chorus block, so its engine is never a `ChorusEngine`, and
its refereed score passes through unchanged (tested in `keystone-lab` `chorus.test.ts`).

## What a Chorus level may hold

`chorusIssues` (part of `validateLevel`) refuses:
- a rack of more than one item (one shot);
- weapons (`w-` items), the plunger and charges, because each decides from the observed state (a fuse, a
  proximity trigger, a charge's arm), which would be world 0's state acting in all worlds;
- ice, which the Driver cracks and shatters from world 0's state;
- any objective but crowns, a build phase and a Bullet Time budget;
- bad values: worlds outside 2 to 256 (the observer's bins), negative or unknown jitter, `pos` over
  0.009 h, a bad seed, non-monotone star thresholds, a `need` under 1.

## The view (`keystone.chorusview`)

An option in the O4 registry (`packages/game/src/options/chorusview.ts`): `grid` (default), `strip` or `off`.

- **grid:** one tile per world, 30 px, in a square grid (8 x 8 at 64). Each tile is a side view drawn as
  one rectangle per body, from that world's local state: plain stone grey, crowns gold until they are
  down (then red), heritage blue, the shot dark. A tile's edge says its state: running, cleared (green),
  failed (red, once the round is over). World 0's edge is thicker.
- **strip:** one cell per world, coloured by heat (crowns down over crowns needed), green when cleared.
- **off:** only the count line.

It redraws at most 6 times a second (`VIEW_HZ`); at 64 worlds of 100 bodies that is 6.4k small
rectangles and one `judge()`, well under a millisecond. The panel is hidden on every level without a
chorus block and in a build phase. It reads the engine and draws; it never moves the camera.

## Levels

LEVELS_TBD

## Verify

The node's verify (`nodes.json` M9): the outcome distribution read off one islands run matches the same
worlds played one at a time (`ChorusEngine` with `only: k`, each world alone at the origin with its own
jitter and aim nudge). Two-sample KS on the share of blocks moved and on the crowns down, Fisher's exact
test on the clears, all p > 0.05; plus a power check that the shot splits the worlds (neither none nor all
clear), since two constant samples agree whatever the islands did.

VERIFY_TBD

## Alternatives considered

- **16 or 32 worlds instead of 64.** Cheaper (the step cost is roughly linear in bodies) and noisier: with
  16 worlds a true clear rate of 50 % reads anywhere from 6 to 10 of 16 (the binomial's 90 % interval),
  so a star threshold at 3/4 would be won or lost on luck. 64 narrows that to 26 to 38 of 64. K is a level
  field (2 to 256), so a heavier level can choose fewer.
- **Sequential solo runs** (the same worlds played one at a time). Exact per world and no fence, but 64
  times the wall time: the player would wait a minute for a score instead of a few seconds. Kept as the
  verify's reference arm (`only: k`).
- **Showing only a histogram** (crowns down by world count). Cheapest to draw and easy to read, but it
  hides the worlds themselves: the thumbnails show *why* a world failed (the tower rocked back), which is
  the lesson. The heat strip is the compact middle ground and is an option.
- **A per-world arsenal** for weapons, charges and ice, each deciding from its own world's state.
  Refused for now (see "What a Chorus level may hold"); it needs every weapon's trigger to read per-island
  state, which the islands' per-island observer could give later.
- **A wider gap instead of the fence.** A ball that rolls for ever needs an unbounded gap. The fence keeps
  the C10 default gap (plus room for the launcher, which stands outside the structure).
- **Integrating Chorus into `play.ts` instead of a facade engine.** The facade keeps every other part of
  the game unchanged (the renderer, the camera, undo checkpoints, the cast page): it is a `PhysicsEngine`
  that shows world 0. The Driver needs only the settle hold and the rescore.
- **Heritage in the observer instead of f64.** The heritage rule is a combination of displacement and
  tilt with its own margins; it is not a threshold at a resting height, so the f64 read is safe, and it
  keeps one heritage rule for every mode.
- **A hair of shot jitter.** Tried first; the GPU did not split (see "The jitter").

## Follow-ups

- (e) Larger levels (1k bodies x 64) as play-back-after-compute, behind an option: compute the islands
  run off screen, then replay world 0 with the count. Not built; the 100-body levels run in real time.
- Metal cost and spread on the M5 (queued through the coordinator; SwiftShader numbers are never
  performance results).
